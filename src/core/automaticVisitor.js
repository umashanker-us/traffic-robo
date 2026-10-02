/**
 * Automatic Visitor - Handles individual browser session with realistic GA4 behavior
 * 
 * CRITICAL: This file implements the exact timing logic from Java AutomaticLogic.java
 * 
 * Timing Logic (from Java):
 * 1. Visit first page
 * 2. Wait: Thread.sleep(1000 * avgSessionDuration / pagePerSession)
 * 3. For BOUNCE visits (avgSessionDuration=0): NO WAIT - exit immediately
 * 4. For each additional page:
 *    - Navigate to page
 *    - Wait random 3-12 seconds
 *    - Wait: Thread.sleep(1000 * avgSessionDuration / pagePerSession)
 * 
 * FIXES APPLIED:
 * 1. Merged route handler for proxy + ad blocking (no more conflicts)
 * 2. Proper proxy implementation using Playwright's built-in proxy for HTTPS
 * 3. Working location feature with coordinates from config
 * 4. SimilarWeb extension support
 */

const Constants = require('../helpers/constants');
const { isGACollectRequest, matchesCustomProxyPattern, resolveTrackerChain } = require('../helpers/proxyRouter');
const { SessionReplay } = require('../helpers/sessionReplay');
const BrowserSession = require('./browserSession');

// Playwright has no timeout of its own on page.evaluate or page.mouse.*, so a
// page whose JS main thread has wedged hangs them for as long as the browser
// lives. Measured on a live run: one visit sat 494s in its behaviour phase and
// held a worker slot throughout. These are the ceilings for a renderer that is
// merely busy — a healthy page answers any of them in single-digit ms.
const ACTION_TIMEOUT_MS = 5000;
const LINK_TIMEOUT_MS = 10000;

class AutomaticVisitor extends BrowserSession {
    constructor(config) {
        super(config);

        // Automatic mode drives its own page sequence from a Visit object.
        this.campaignUrl = this.targetUrl;
        this.visit = config.visit;

        // Random wait based on play mode.
        // Even the fastest mode needs a minimum wait for GA4 to fire.
        // Original Java: 3000L + new Random().nextInt(9000) = 3-12 seconds
        switch (this.playMode) {
            case Constants.PLAY_MODES.FASTEST:
                this.randomWaitMs = 2000 + Math.floor(Math.random() * 2000);
                break;
            case Constants.PLAY_MODES.FAST:
                this.randomWaitMs = 3000 + Math.floor(Math.random() * 3000);
                break;
            case Constants.PLAY_MODES.SLOW:
                this.randomWaitMs = 4000 + Math.floor(Math.random() * 4000);
                break;
            case Constants.PLAY_MODES.SLOWER:
            default:
                this.randomWaitMs = 5000 + Math.floor(Math.random() * 7000);
                break;
        }

        this.logger.debug(`Play mode: ${this.playMode}, Random wait: ${this.randomWaitMs}ms`);
    }

    /**
     * Automatic mode waits on a real GA4 beacon after the returning-user page
     * rather than guessing, so the cookie is certain to exist.
     */
    async _settleAfterPreviousUrl() {
        await this._waitForGA4();
        await this._sleep(this.randomWaitMs);
    }

    /**
     * Execute the visit
     * MATCHES Java AutomaticLogic.doInBackground()
     */
    async execute() {
        const startTime = Date.now();
        // Nothing may hold a worker slot indefinitely. The per-call deadlines
        // below cover the calls that hang in practice; this covers the rest.
        const stopWatchdog = this._startVisitWatchdog();

        // Initialize session replay
        this.replay = new SessionReplay(this.threadId, { maxEvents: 200 });
        this.replay.setSessionInfo(this._buildSessionInfo({ mode: 'automatic' }));
        this.replay._addEvent('visit_start', {
            url: this.campaignUrl,
            pages: this.visit.getPagePerSession(),
            duration: this.visit.getAvgSessionDuration(),
            isBounce: this.visit.isBounce(),
            proxy: this.proxyEnabled ? `${this.proxyConfig?.host}:${this.proxyConfig?.port}` : null,
        });

        // Log visit details
        this.logger.info(`═══════════════════════════════════════════════════`);
        this.logger.info(`🚀 Starting Visit #${this.threadId}`);
        this.logger.info(`   URL: ${this.campaignUrl}`);
        this.logger.info(`   Pages: ${this.visit.getPagePerSession()}, Duration: ${this.visit.getAvgSessionDuration()}s`);
        this.logger.info(`   Is Bounce: ${this.visit.isBounce()}`);
        this.logger.info(`   Wait per page: ${this.visit.getWaitTimePerPageSec()}s`);
        this.logger.info(`   Random wait: ${(this.randomWaitMs/1000).toFixed(1)}s`);
        this.logger.info(`   Play mode: ${this.playMode}`);
        this.logger.info(`═══════════════════════════════════════════════════`);
        this.logger.info(`Returning User: ${this.isOldUser} ${this.isOldUser ? '(will visit previous URL first)' : '(NEW user - direct to campaign URL)'}`);
        this.logger.info(`Screen: ${this.screenSize.width}x${this.screenSize.height}`);
        this.logger.info(`Location: ${this.location} (${this.locationData.latitude}, ${this.locationData.longitude})`);
        if (this.proxyEnabled) {
            this.logger.info(`Proxy: ${this.proxyConfig?.host}:${this.proxyConfig?.port} (only /collect proxied)`);
        }
        if (this.extensionEnabled) {
            this.logger.info(`Extension: ENABLED - ${this.extensionPath}`);
        }

        try {
            await this._launchBrowser();
            await this._createContext();

            // spoofedIP and the extension's load state are decided while the
            // context is built, i.e. after setSessionInfo ran. Merging them in
            // here is why the report no longer shows spoofedIP: null on every
            // IP-rotated visit.
            this.replay.updateSessionInfo({
                spoofedIP: this.currentIP,
                extensionLoaded: this.extensionLoaded,
                extensionProfileId: this.extensionProfileId,
            });

            // Inject saved GA cookies for returning users BEFORE any navigation
            // Must happen right after context creation, before page.goto()
            if (this.savedCookies && this.savedCookies.length > 0 && this.context) {
                await this.context.addCookies(this.savedCookies);
                this.logger.info(`👤 Injected ${this.savedCookies.length} GA cookies for returning user`);
                // DEBUG: Log exact cookies being injected
                for (const c of this.savedCookies) {
                    const expires = c.expires ? new Date(c.expires * 1000).toISOString() : 'session';
                    this.logger.info(`  INJECT: ${c.name}=${c.value} | domain=${c.domain} path=${c.path} expires=${expires}`);
                }
                // Store injected _ga value for post-load comparison
                const injectedGa = this.savedCookies.find(c => c.name === '_ga');
                this._injectedGaValue = injectedGa ? injectedGa.value : null;
            }

            // Handle returning users (visit previous URL first to create cookie/session)
            // This makes GA4 see them as "returning" users
            // Cookies are already injected above, so previous URL visit will use them
            //
            // Cases:
            // 1. Returning % = 0 → isOldUser = false → Skip (all NEW users)
            // 2. Returning % > 0, previousURL set → Use manual previous URL
            // 3. Returning % > 0, useBaseUrlForOldUser checked → Auto extract base URL from UTM
            // 4. Returning % > 0, both empty → Skip (no previous URL to visit)
            //
            // Note: Bounce visits don't visit previous URL (they exit immediately)
            if (this.isOldUser && !this.visit.isBounce() && (this.previousURL || this.useBaseUrlForOldUser)) {
                await this._visitPreviousUrl();
            } else if (this.isOldUser && !this.visit.isBounce()) {
                this.logger.info(`⚠️ Old user but no previous URL configured - will be treated as NEW user by GA4`);
            }

            // Visit the campaign URL (first page)
            await this._visitFirstPage();

            // DEBUG: After page load + GA4 fire, check if cookies survived
            if (this._injectedGaValue && this.context) {
                try {
                    const postLoadCookies = await this.context.cookies();
                    const gaCookies = postLoadCookies.filter(c => c.name.startsWith('_ga') || c.name.startsWith('_gid'));
                    const currentGa = gaCookies.find(c => c.name === '_ga');
                    const currentGaVal = currentGa ? currentGa.value : '(not found)';
                    const match = currentGaVal === this._injectedGaValue;
                    this.logger.info(`COOKIE CHECK: Injected _ga=${this._injectedGaValue}, After load _ga=${currentGaVal}, Match: ${match ? 'YES' : 'NO'}`);
                    if (!match) {
                        this.logger.warn(`COOKIE OVERWRITE DETECTED! GA4 replaced our injected _ga cookie`);
                    }
                    // Log all GA cookies after page load
                    for (const c of gaCookies) {
                        this.logger.info(`  POST-LOAD: ${c.name}=${c.value} | domain=${c.domain} path=${c.path}`);
                    }
                } catch (e) {
                    this.logger.debug(`Cookie check failed: ${e.message}`);
                }
            }

            // CRITICAL: Check if this is a BOUNCE visit
            if (this._downloadLanding) {
                // No page to sit on and no gtag to fire — waiting out the
                // session or opening more pages would buy nothing. Proxy/tracker
                // hops already happened in _visitFirstPage.
                this.logger.warn(`⬇ Visit ended at a download (${this._downloadLanding.filename || this._downloadLanding.url}) — no GA4 hit is possible for a file URL`);
                this.replay.stats.downloadLanding = true;
                this.logger.warn(`   Use an HTML landing page as the campaign URL if you need GA4 sessions.`);
            } else if (this.visit.isBounce()) {
                // Bounce visit - NO WAIT, exit immediately.
                // Measure from _pageStartTime (the navigation start) so the UI's bounce
                // duration matches what GA4 actually sees as engagement_time_msec.
                // Browser launch + context creation is not part of session time in GA4.
                this.logger.info(`🔴 BOUNCE VISIT - Exiting immediately (no additional pages, no wait)`);
                const bounceTimeOnPage = Date.now() - (this._pageStartTime || startTime);
                this.replay.logBounce(bounceTimeOnPage);
            } else {
                // Non-bounce visit - time-budget aware waiting
                // The configured wait IS the total time per page (including load + GA4 + behavior)
                const configuredWaitMs = this.visit.getWaitTimePerPageMs();
                const elapsedMs = Date.now() - (this._pageStartTime || startTime);
                const remainingMs = configuredWaitMs - elapsedMs;
                const MIN_PAGE_TIME = 3000;

                if (remainingMs > MIN_PAGE_TIME) {
                    this.logger.info(`Page time budget: ${configuredWaitMs}ms, elapsed: ${elapsedMs}ms, remaining: ${remainingMs}ms`);
                    await this._sleep(remainingMs);
                } else if (elapsedMs < MIN_PAGE_TIME) {
                    // Ensure minimum time on page
                    const minRemaining = MIN_PAGE_TIME - elapsedMs;
                    this.logger.info(`Page time budget: ${configuredWaitMs}ms, elapsed: ${elapsedMs}ms (under minimum, waiting ${minRemaining}ms)`);
                    await this._sleep(minRemaining);
                } else {
                    this.logger.info(`Page time budget: ${configuredWaitMs}ms, elapsed: ${elapsedMs}ms (budget spent, moving on)`);
                }

                // Visit additional pages if pagePerSession > 1
                const additionalPages = this.visit.getAdditionalPages();
                if (additionalPages > 0) {
                    await this._visitAdditionalPages(additionalPages);
                }
            }

            const totalTime = (Date.now() - startTime) / 1000;
            this.logger.info(`✅ Visit completed in ${totalTime.toFixed(2)}s`);

            // Log proxy stats if enabled
            if (this.proxyRouter) {
                this.proxyRouter.logStats();
                this.replay._addEvent('proxy_stats', {
                    total: this.proxyRouter.stats.totalRequests,
                    proxied: this.proxyRouter.stats.proxiedRequests,
                    direct: this.proxyRouter.stats.directRequests,
                    scriptsLoadedDirect: this.proxyRouter.stats.scriptsLoadedDirect,
                });
                // Final stats emission at visit end
                this._emitProxyStats('', true);
            }

            // Record visit end
            this.replay._addEvent('visit_end', {
                totalDurationMs: Date.now() - startTime,
                pagesVisited: this.replay.stats.pagesVisited,
                isBounce: this.visit.isBounce(),
                ga4EventsFired: this.replay.stats.ga4EventsFired,
            });

        } catch (error) {
            this.replay.logError('execute', error.message);
            this.logger.error(`Visit failed: ${error.message}`);
            throw error;
        } finally {
            stopWatchdog();
            // CRITICAL: Extract cookies BEFORE closing context — context.cookies()
            // returns empty after close, which was causing "COOKIE JAR: EMPTY" bug
            await this._extractCookiesBeforeClose();
            this._saveReplay();
            await this._cleanup();
        }
    }

    async _visitFirstPage() {
        // If campaign URL is a click tracker (matches custom-proxy patterns),
        // walk the redirect chain through the proxy in Node first. Each hop
        // registers with the proxy IP (ad attribution correct). Browser then
        // loads only the FINAL landing URL — direct, fast, no CONNECT-tunnel
        // dependency. Tracking params (dclid, UTMs) survive because they're
        // appended by the 302 Location headers and end up in the final URL.
        let urlToNavigate = this.campaignUrl;
        if (this.customProxyEnabled && this.proxyConfig && this.customProxyPatterns.length > 0
            && matchesCustomProxyPattern(this.campaignUrl, this.customProxyPatterns)) {
            try {
                const chainResult = await resolveTrackerChain(
                    this.campaignUrl,
                    this.proxyConfig,
                    this.customProxyPatterns,
                    this.logger,
                    10,
                    this._buildRequestIdentity()
                );
                urlToNavigate = chainResult.finalUrl;
                this.logger.info(`Tracker chain resolved via proxy: ${chainResult.hops.length} hop(s) → ${urlToNavigate.substring(0, 120)}`);
                for (const h of chainResult.hops) {
                    this.logger.debug(`  Hop ${h.status}: ${h.url.substring(0, 100)}`);
                }
            } catch (e) {
                this.logger.warn(`Tracker chain resolution failed: ${e.message} — falling back to direct navigation`);
            }
        }

        this.logger.info(`Navigating to campaign URL: ${urlToNavigate}`);
        // Track page start time — used by execute() for time-budget calculation
        this._pageStartTime = Date.now();
        const isBounce = this.visit.isBounce();

        try {
            // Bounce visits: use 'domcontentloaded' — proceed as soon as HTML is parsed.
            // 8s nav timeout is a hard ceiling; the overall bounce budget (9.5s total
            // from _pageStartTime) still keeps the visit under GA4's 10s engagement
            // threshold even on slow proxies.
            const waitStrategy = isBounce ? 'domcontentloaded' : 'load';
            const navTimeout = isBounce ? 8000 : 60000;

            // For bounce visits we MUST wait for at least one /collect response to
            // actually round-trip GA4's server before closing the browser, otherwise
            // the in-flight request is canceled and the visit never registers. Arm
            // the listener BEFORE navigation so we don't miss an early page_view.
            // 7s waitForResponse timeout fits within the 9.5s total bounce budget.
            this._collectResponsePromise = null;
            if (isBounce && this.page) {
                this._collectResponsePromise = this.page.waitForResponse(
                    r => isGACollectRequest(r.url()),
                    { timeout: 7000 }
                ).catch(() => null);
            }

            // Handle referer navigation — only visit referer page if visitReferer is true
            if (this.visitReferer && this.referer) {
                await this.page.goto(this.referer, {
                    waitUntil: isBounce ? 'domcontentloaded' : 'load',
                    timeout: navTimeout
                });
                if (!isBounce) await this._sleep(1000); // Brief pause on referer page (skip for bounce)
                await this.page.evaluate((url) => {
                    window.location.href = url;
                }, urlToNavigate);
                await this.page.waitForLoadState(waitStrategy, { timeout: navTimeout });
            } else {
                const { fileLanding, error } = await this._navigateToLanding(urlToNavigate, {
                    waitUntil: waitStrategy,
                    timeout: navTimeout,
                });
                if (fileLanding) {
                    this.logger.warn(`⬇ Landing URL is a file (${fileLanding.contentType || 'download'}): ${fileLanding.filename || fileLanding.url}`);
                    this.replay._addEvent('download_landing', fileLanding);
                    return;
                }
                if (error) throw error;
            }

            // Resolve true primary domain from the landed URL — if campaignUrl
            // was a CM360 / ad-tracker click URL, page.url() now points at the
            // real destination after the 302 redirect chain. Everything that
            // depends on primary domain (internal-link traversal, replay logs)
            // must use the landed domain, not the click tracker's domain.
            this._resolveLandedDomain();

            // CRITICAL: Wait for GA4/GTM scripts to initialize and fire events
            // For bounce visits, use fast poll to stay UNDER 10 seconds total
            if (isBounce) {
                await this._waitForGA4Bounce();
            } else {
                await this._waitForGA4();
            }

            // Verify the extension on every visit, bounces included. Skipping
            // bounces meant ~30% of visits never reported extension status at
            // the default bounce rate, which read as "the extension stopped
            // working" in the report.
            if (this.extensionEnabled && this.extensionLoaded) {
                await this._verifyExtension({ settleMs: isBounce ? 0 : 1500 });
            }

            const loadTimeMs = Date.now() - this._pageStartTime;
            const loadTime = loadTimeMs / 1000;
            const pageTitle = this.page ? await this.page.title().catch(() => 'Unknown') : 'Unknown';
            const currentUrl = this.page ? this.page.url() : this.campaignUrl;

            this.replay.logNavigation(currentUrl, loadTimeMs, pageTitle);

            if (isBounce) {
                this.logger.info(`🔴 BOUNCE: GA4 handled, exiting after ${loadTime.toFixed(1)}s total (under 10s ✅)`);
            } else {
                this.logger.info(`✅ Page fully loaded: ${loadTime.toFixed(2)}s`);
                this.logger.info(`URL to be visited: ${this.campaignUrl}`);
                this.logger.info(`Page title: ${pageTitle}`);
                this.logger.info(`Current URL: ${currentUrl}`);

                // Pass remaining per-page budget so behavior scales down on
                // tight budgets instead of always burning ~5s.
                const behaviorBudgetMs = this.visit.getWaitTimePerPageMs() - (Date.now() - this._pageStartTime);
                await this._simulateUserBehavior(behaviorBudgetMs);
            }

        } catch (error) {
            // Landing URL answered with a file instead of a page (PDF click
            // trackers, asset links). The tracker hops already registered
            // through the proxy, so the visit did its job — the navigation
            // error is expected, not a failure.
            const landing = await this._awaitDownloadSignal();
            if (landing) {
                this.logger.warn(`⬇ Landing URL is a download: ${landing.filename || landing.url}`);
                this.replay._addEvent('download_landing', landing);
                return;
            }
            this.replay.logError('first_page', error.message);
            this.logger.error(`Failed to load first page: ${error.message}`);
            throw error;
        }
    }

    /**
     * Quick glance behavior for bounce visits
     */
    async _simulateQuickGlance() {
        try {
            // Quick mouse movement
            await this._withDeadline('Glance mouse move', ACTION_TIMEOUT_MS, () => this.page.mouse.move(
                100 + Math.random() * 200,
                100 + Math.random() * 150
            ));
            await this._sleep(300);
            
            // Maybe a small scroll
            if (Math.random() > 0.5) {
                await this._withDeadline('Glance scroll', ACTION_TIMEOUT_MS, () => this.page.evaluate(() => {
                    window.scrollBy({ top: 200 + Math.random() * 300, behavior: 'auto' });
                }));
            }
        } catch (e) {
            // Ignore errors
        }
    }

    /**
     * Visit additional pages based on visit configuration
     * MATCHES Java logic exactly
     * 
     * Java Reference:
     * for (int i2 = 0; i2 < this.mVisit.getPagePerSession() - 1; ++i2) {
     *     // navigate to link
     *     Thread.sleep(this.mRandomWait);
     *     Thread.sleep(1000 * this.mVisit.getAvgSessionDuration() / this.mVisit.getPagePerSession());
     * }
     */
    async _visitAdditionalPages(pagesToVisit) {
        this.logger.info(`Visiting ${pagesToVisit} additional pages...`);

        // Get current page source for link extraction
        let links = await this._getPageLinks();
        
        if (links.length === 0) {
            this.logger.warn(`No links found on page. Bounce rate may increase.`);
            return;
        }

        this.logger.info(`Found ${links.length} valid links on page`);

        for (let i = 0; i < pagesToVisit; i++) {
            if (links.length === 0) {
                this.logger.warn(`No more links available at page ${i + 2}`);
                break;
            }

            try {
                // Pick a random link (Java: int index = (int)(Math.random() * elementList.size()))
                const randomIndex = Math.floor(Math.random() * links.length);
                let linkUrl = links[randomIndex];

                // Handle relative URLs
                linkUrl = this._resolveUrl(linkUrl);

                this.logger.info(`Navigating to page ${i + 2}: ${linkUrl}`);
                const pageStartTime = Date.now();

                // Navigate to the link — domcontentloaded is enough; networkidle stalls
                // on real sites with ads/polling and eats the per-page time budget.
                await this.page.goto(linkUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 20000
                });

                // CRITICAL: Wait for GA4 to fire page_view event
                await this._waitForGA4();

                const loadTimeMs = Date.now() - pageStartTime;
                const loadTime = loadTimeMs / 1000;
                const pageTitle = this.page ? await this.page.title().catch(() => '') : '';
                this.replay.logNavigation(linkUrl, loadTimeMs, pageTitle);
                this.logger.info(`✅ Page ${i + 2} loaded: ${loadTime.toFixed(2)}s - ${linkUrl}`);

                // Pass remaining per-page budget so behavior scales down on
                // tight budgets instead of always burning ~5s.
                const configuredWaitMs = this.visit.getWaitTimePerPageMs();
                const behaviorBudgetMs = configuredWaitMs - (Date.now() - pageStartTime);
                await this._simulateUserBehavior(behaviorBudgetMs);

                // Time-budget: configured wait IS total time per page (load + GA4 + behavior included)
                const elapsedMs = Date.now() - pageStartTime;
                const remainingMs = configuredWaitMs - elapsedMs;
                const MIN_PAGE_TIME = 3000;

                if (remainingMs > MIN_PAGE_TIME) {
                    this.logger.info(`Page ${i + 2} budget: ${configuredWaitMs}ms, elapsed: ${elapsedMs}ms, remaining: ${remainingMs}ms`);
                    await this._sleep(remainingMs);
                } else if (elapsedMs < MIN_PAGE_TIME) {
                    const minRemaining = MIN_PAGE_TIME - elapsedMs;
                    this.logger.info(`Page ${i + 2} budget: ${configuredWaitMs}ms, elapsed: ${elapsedMs}ms (under minimum, waiting ${minRemaining}ms)`);
                    await this._sleep(minRemaining);
                } else {
                    this.logger.info(`Page ${i + 2} budget: ${configuredWaitMs}ms, elapsed: ${elapsedMs}ms (budget spent, moving on)`);
                }

                // Get new links for next iteration
                links = await this._getPageLinks();

                // Remove visited link to avoid revisiting
                links = links.filter(l => l !== linkUrl);

            } catch (error) {
                this.replay.logError(`page_${i + 2}`, error.message);
                this.logger.error(`Exception on URL ${i + 2}: ${error.message}`);
                // Continue with remaining pages
            }
        }
    }

    /**
     * Get all internal links from the page
     * MATCHES Java link extraction logic
     */
    async _getPageLinks() {
        if (!this.page) return [];
        try {
            const currentUrl = this.page.url();
            const currentHost = new URL(currentUrl).host;

            const harvest = await this._withDeadline('Link harvest', LINK_TIMEOUT_MS, () => this.page.evaluate(({ currentHost, restrictToPrimary, primaryDomain }) => {
                const anchors = document.querySelectorAll('a[href]');
                const validLinks = [];

                anchors.forEach(anchor => {
                    const href = anchor.getAttribute('href');
                    
                    // Skip invalid links (matches Java validation)
                    if (!href || 
                        href === '/' ||
                        href.startsWith('#') || 
                        href.startsWith('javascript') || 
                        href.startsWith('mailto') ||
                        href.startsWith('tel') ||
                        href.includes('no protocol') ||
                        href.includes('unknown protocol')) {
                        return;
                    }

                    // Handle relative URLs
                    if (href.startsWith('/')) {
                        validLinks.push(href);
                        return;
                    }

                    // Handle absolute URLs
                    try {
                        const linkUrl = new URL(href);
                        
                        if (restrictToPrimary) {
                            // Only include links from same domain
                            if (linkUrl.host === currentHost || 
                                linkUrl.hostname.includes(primaryDomain) ||
                                primaryDomain.includes(linkUrl.hostname)) {
                                validLinks.push(href);
                            }
                        } else {
                            validLinks.push(href);
                        }
                    } catch {
                        // Invalid URL, skip
                    }
                });

                return [...new Set(validLinks)]; // Remove duplicates
            }, { 
                currentHost, 
                restrictToPrimary: this.restrictToPrimaryDomain,
                primaryDomain: this.primaryDomain 
            }));

            // No links is already a handled outcome upstream — the visit ends
            // after this page rather than waiting on a page that never answers.
            return harvest.ok ? (harvest.value || []) : [];

        } catch (error) {
            this.logger.warn(`Failed to get links: ${error.message}`);
            return [];
        }
    }

    /**
     * Resolve relative URL to absolute
     */
    _resolveUrl(href) {
        if (href.startsWith('http://') || href.startsWith('https://')) {
            return href;
        }
        
        try {
            const currentUrl = new URL(this.page ? this.page.url() : this.campaignUrl);
            if (href.startsWith('/')) {
                return `${currentUrl.protocol}//${currentUrl.host}${href}`;
            } else {
                return `${currentUrl.protocol}//${currentUrl.host}/${href}`;
            }
        } catch {
            return href;
        }
    }

    /**
     * Wait for GA4/GTM scripts to load and fire events
     * CRITICAL for proper tracking - don't skip this!
     * 
     * GA4 Event Timeline:
     * 1. Page load starts
     * 2. DOM content loaded (~0.5-2s)
     * 3. gtag.js/gtm.js loads (~0.5-1s after DOM)
     * 4. GA4 initializes and fires:
     *    - session_start (first page only)
     *    - first_visit (new users only)
     *    - page_view (every page)
     * 5. Network requests to google-analytics.com complete
     */
    /**
     * CRITICAL: Wait for GA4/GTM to fully load and fire events
     * This is the most important function for tracking to work
     * 
     * GA4 Lifecycle:
     * 1. Page DOM loads
     * 2. gtag.js/gtm.js script loads (network request)
     * 3. GA4 initializes
     * 4. page_view event fires
     * 5. session_start fires (if new session)
     * 6. Beacon request sent to analytics server
     * 
     * We must wait for ALL of this before navigating away!
     */
    async _waitForGA4() {
        if (!this.page) return;
        const startTime = Date.now();
        this.logger.info(`⏳ Waiting for page + GA4 to fully load...`);

        // STEP 1: Wait for DOM to be complete
        try {
            await this.page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
            this.logger.debug(`DOM complete: ${Date.now() - startTime}ms`);
        } catch (e) {
            this.logger.debug(`DOM readyState timeout`);
        }
        // STEP 2 removed — networkidle on real sites (ads, widgets, polling fetches) often
        // never reaches idle and times out at 15s, adding huge per-page overhead. DOM-ready
        // plus the GA4 beacon sleep below is sufficient for the page_view event to fire.
        
        // STEP 3: Check for GA4/GTM and wait for events to fire
        let gaDetected = false;
        let gaDetails = {};
        try {
            const probe = await this._withDeadline('GA4 probe', ACTION_TIMEOUT_MS, () => this.page.evaluate(() => {
                return {
                    hasGtag: !!window.gtag,
                    hasDataLayer: !!window.dataLayer,
                    hasGTM: !!window.google_tag_manager,
                    hasGA: !!window.ga,
                    hasScript: !!(
                        document.querySelector('script[src*="googletagmanager"]') ||
                        document.querySelector('script[src*="google-analytics"]') ||
                        document.querySelector('script[src*="gtag/js"]')
                    ),
                };
            }));
            gaDetails = probe.value || {};
            gaDetected = gaDetails.hasGtag || gaDetails.hasDataLayer || gaDetails.hasGA ||
                         gaDetails.hasGTM || gaDetails.hasScript;
        } catch (e) {
            // Ignore
        }

        // STEP 4: Wait for GA4 events to fire. Budget-aware: long fixed 3-5s sleep was
        // blowing past the per-page time budget on short-configured visits (e.g. 36s avg
        // / 6 pages = 6s/page budget, but 5s sleep + 5s load → 10s/page actual).
        // Floor 1.5s guarantees gtag.js has time to flush the beacon.
        const MIN_BEACON_WAIT = 1500;
        const MAX_BEACON_WAIT = 5000;
        const budgetMs = (this.visit && this.visit.getWaitTimePerPageMs) ? this.visit.getWaitTimePerPageMs() : MAX_BEACON_WAIT;
        const targetWait = Math.max(MIN_BEACON_WAIT, Math.min(MAX_BEACON_WAIT, Math.floor(budgetMs * 0.5)));

        if (gaDetected) {
            const gaWait = targetWait + Math.random() * 500;
            this.logger.info(`✅ GA4/GTM detected - waiting ${(gaWait/1000).toFixed(1)}s for tracking events...`);
            await this._sleep(gaWait);
        } else {
            const minWait = Math.max(1000, Math.min(2500, Math.floor(budgetMs * 0.3)));
            this.logger.info(`⚠️ No GA4/GTM detected - waiting ${(minWait/1000).toFixed(1)}s anyway...`);
            await this._sleep(minWait);
        }

        // STEP 5 removed — same networkidle reasoning as STEP 2 above. The GA4 beacon
        // sleep is enough for the /collect request to be initiated; final teardown does
        // not need to wait for unrelated ad/widget network activity.
        
        const totalWait = Date.now() - startTime;
        this.replay.logGA4Detection(gaDetected, { ...gaDetails, waitTimeMs: totalWait });
        this.logger.info(`✅ Page ready after ${(totalWait/1000).toFixed(1)}s`);
    }

    /**
     * Fast GA4 wait for bounce visits — poll for script, then wait for the
     * actual /collect response round-trip before exiting.
     *
     * Previously we only waited 1-1.5s after detecting gtag.js, assuming the
     * beacon had fired. In practice gtag.js batches events (default flush ~5s)
     * and the network round-trip to GA4 servers adds 200-500ms — so the request
     * was getting canceled by browser teardown and bounce visits never reached
     * GA4. That's what produced the 100→71 visit gap.
     *
     * New strategy: arm a waitForResponse(/collect) listener in _visitFirstPage
     * BEFORE navigation, poll for the GA4 script here, then wait for that
     * response to actually complete (max 9s budget to stay under the 10s
     * engagement threshold that would flip the session to "engaged").
     */
    async _waitForGA4Bounce() {
        if (!this.page) return;
        const startTime = Date.now();
        // Anchor everything to page navigation start so the TOTAL bounce time
        // (goto + this function + cleanup) stays under GA4's 10s engagement threshold.
        // 9.5s hard cap from _pageStartTime — gives proxy /collect round-trip enough
        // headroom to land before close (was 8s, beacons were dropping under load),
        // while staying below GA4's 10s engaged-session threshold.
        const TOTAL_BOUNCE_CAP_MS = 9500;
        const pageStart = this._pageStartTime || startTime;
        const remainingTotalBudget = () => Math.max(0, TOTAL_BOUNCE_CAP_MS - (Date.now() - pageStart));
        this.logger.info(`⏳ Bounce: polling for GA4 (budget ${(remainingTotalBudget()/1000).toFixed(1)}s)...`);

        // Poll every 400ms for GA4 script presence — capped at half remaining budget
        // so /collect round-trip still has room to complete.
        let gaDetected = false;
        let gaDetails = {};
        const pollInterval = 400;
        const maxPollTime = Math.max(800, Math.floor(remainingTotalBudget() * 0.4));

        while (Date.now() - startTime < maxPollTime && remainingTotalBudget() > 1000) {
            try {
                const probe = await this._withDeadline('GA4 probe', ACTION_TIMEOUT_MS, () => this.page.evaluate(() => {
                    return {
                        hasGtag: !!window.gtag,
                        hasDataLayer: !!window.dataLayer,
                        hasGTM: !!window.google_tag_manager,
                        hasGA: !!window.ga,
                        hasScript: !!(
                            document.querySelector('script[src*="googletagmanager"]') ||
                            document.querySelector('script[src*="google-analytics"]') ||
                            document.querySelector('script[src*="gtag/js"]')
                        ),
                    };
                }));
                gaDetails = probe.value || {};
                gaDetected = gaDetails.hasGtag || gaDetails.hasDataLayer || gaDetails.hasGA ||
                             gaDetails.hasGTM || gaDetails.hasScript;
                if (gaDetected) break;
            } catch (e) {
                // Page may not be ready yet, continue polling
            }
            await this._sleep(pollInterval);
        }

        const detectTime = ((Date.now() - startTime) / 1000).toFixed(1);

        // Wait for /collect round-trip, but never exceed the total bounce cap.
        const remainingMs = remainingTotalBudget();
        let collectConfirmed = false;

        if (this._collectResponsePromise && remainingMs > 0) {
            this.logger.info(`✅ GA4 detected in ${detectTime}s — waiting up to ${(remainingMs/1000).toFixed(1)}s for /collect round-trip`);
            const cutoff = new Promise(resolve => setTimeout(() => resolve(null), remainingMs));
            const response = await Promise.race([this._collectResponsePromise, cutoff]);
            if (response) {
                collectConfirmed = true;
                this.logger.info(`✅ /collect delivered (status ${response.status?.() ?? 'unknown'}) — safe to close`);
            } else {
                this.logger.warn(`⚠️ /collect did not complete within budget — beacon may not have reached GA4`);
            }
        } else if (!gaDetected) {
            // Nothing to wait for — give a brief settle period so any late script can fire
            await this._sleep(500);
        }

        const totalWait = Date.now() - startTime;
        this.replay.logGA4Detection(gaDetected, { ...gaDetails, waitTimeMs: totalWait, bounce: true, collectConfirmed });
        this.logger.info(`BOUNCE: exiting after ${(totalWait/1000).toFixed(1)}s total (collectConfirmed=${collectConfirmed})`);
    }

    /**
     * Simulate realistic user behavior on page.
     *
     * Takes the remaining per-page budget (ms) — the time left after page load
     * and GA4 beacon wait. Fixed 3-7s of sleeps here was the dominant source of
     * Actual avg session duration overshooting the configured target: even when
     * load + GA4 finished within budget, behavior alone consumed the rest of
     * the budget and then some.
     *
     *   budget < 1500ms → minimal (one quick scroll for GA4 scroll tracking)
     *   1500–5000ms     → scaled sleeps proportional to budget
     *   ≥ 5000ms        → full behavior
     *
     * The final budget-fill sleep in the caller picks up any slack, so it's
     * safe to undershoot here.
     */
    async _simulateUserBehavior(budgetMs = 6000) {
        // A tight budget used to skip straight to one bare scrollBy and return
        // without recording it, so on a real site — where page load eats the
        // budget — the report showed 0 scrolls and 0 mouse moves on almost
        // every visit, and GA4 saw a session with no engagement at all.
        //
        // The actions themselves cost no time; only the pauses between them do.
        // So every visit now performs the full sequence and only the pauses are
        // rationed against the deadline.
        const deadline = Date.now() + Math.max(budgetMs, 0);
        const pause = async (ms) => {
            const remaining = deadline - Date.now();
            if (remaining <= 50) return;
            await this._sleep(Math.min(ms, remaining));
        };
        const scale = Math.min(1.0, Math.max(budgetMs, 0) / 5000);

        try {
            await pause(Math.floor((1000 + Math.random() * 1000) * scale));
            await this._simulateMouseMovement(pause);
            await pause(Math.floor((500 + Math.random() * 1000) * scale));
            await this._simulateScrolling(scale, pause);
            await pause(Math.floor((500 + Math.random() * 500) * scale));
        } catch (error) {
            this.logger.debug(`User behavior simulation error: ${error.message}`);
        }
    }

    /**
     * Simulate scrolling - GA4 tracks scroll depth.
     * `scale` (0..1) shrinks the sleeps when the per-page budget is tight.
     * Scrolls themselves still fire (GA4 needs the events); only inter-scroll
     * pauses scale. The third scroll is skipped when budget is very tight.
     */
    async _simulateScrolling(scale = 1.0, pause = null) {
        const wait = pause || ((ms) => this._sleep(ms));
        try {
            // page.evaluate has no timeout of its own, and a wedged renderer
            // never answers it. Returns false when the page stopped responding,
            // so the rest of the sequence is abandoned rather than hanging on
            // each remaining scroll in turn.
            const scrollBy = async (amount) => {
                const done = await this._withDeadline('Scroll', ACTION_TIMEOUT_MS,
                    () => this.page.evaluate((px) => {
                        window.scrollBy({ top: px, behavior: 'smooth' });
                    }, amount));
                if (!done.ok) return false;
                // scrollEvents in the report used to be permanently 0 because
                // nothing recorded the scrolls this method performs.
                if (this.replay) this.replay.logBehavior('scroll', { px: amount });
                return true;
            };

            if (!await scrollBy(300 + Math.floor(Math.random() * 400))) return;
            await wait(Math.floor((800 + Math.random() * 600) * scale));

            if (!await scrollBy(500 + Math.floor(Math.random() * 700))) return;
            await wait(Math.floor((600 + Math.random() * 500) * scale));

            if (scale > 0.5 && Math.random() > 0.3) {
                const scroll3 = Math.random() > 0.5
                    ? (400 + Math.floor(Math.random() * 600))
                    : -(200 + Math.floor(Math.random() * 300));
                if (!await scrollBy(scroll3)) return;
                await wait(Math.floor((400 + Math.random() * 400) * scale));
            }

        } catch (error) {
            this.logger.debug(`Scroll error: ${error.message}`);
        }
    }

    /**
     * Simulate mouse movement - More human-like
     */
    async _simulateMouseMovement(pause = null) {
        const wait = pause || ((ms) => this._sleep(ms));
        try {
            // Start position
            const startX = 100 + Math.floor(Math.random() * 200);
            const startY = 100 + Math.floor(Math.random() * 150);
            // Dispatched through the renderer, so on a wedged page it hangs
            // exactly the way page.evaluate does.
            const moveTo = async (x, y, opts) => {
                const done = await this._withDeadline('Mouse move', ACTION_TIMEOUT_MS,
                    () => this.page.mouse.move(x, y, opts));
                if (!done.ok) return false;
                if (this.replay) this.replay.logBehavior('mouse_move', { x, y });
                return true;
            };

            if (!await moveTo(startX, startY)) return;
            await wait(200 + Math.random() * 200);
            
            // Move around (2-3 movements)
            const moves = 2 + Math.floor(Math.random() * 2);
            for (let i = 0; i < moves; i++) {
                const x = 100 + Math.floor(Math.random() * 500);
                const y = 100 + Math.floor(Math.random() * 400);
                if (!await moveTo(x, y, { steps: 5 + Math.floor(Math.random() * 5) })) return;
                await wait(150 + Math.random() * 200);
            }
            
        } catch (error) {
            this.logger.debug(`Mouse movement error: ${error.message}`);
        }
    }

}

module.exports = AutomaticVisitor;
// Re-exported for the IPC handler, which has always reached for them here.
module.exports.setDebugAllTracking = BrowserSession.setDebugAllTracking;
module.exports.getDebugAllTracking = BrowserSession.getDebugAllTracking;
