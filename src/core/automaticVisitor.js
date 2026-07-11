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

const { chromium } = require('playwright');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { getLogger, getCampaignLogDir } = require('../helpers/logger');
const Constants = require('../helpers/constants');
const { ProxyRouter, isGACollectRequest, isGAScript, createPlaywrightProxy, parseProxyString, parseCustomProxyPatterns, matchesCustomProxyPattern, resolveTrackerChain } = require('../helpers/proxyRouter');
const { generateIndianIP } = require('../helpers/indianIP');
const { SessionReplay } = require('../helpers/sessionReplay');
const { patchCollectUrlForReturning } = require('../helpers/collectPatch');

// ===== Debug All Tracking Pixels Toggle =====
let debugAllTracking = false;

const TRACKING_PATTERNS = [
    'doubleclick.net', 'googleadservices.com', 'googlesyndication.com',
    'facebook.com/tr', 'connect.facebook.net',
    'omtrdc.net', '2o7.net', 'demdex.net',           // Adobe
    'scorecardresearch.com', 'comscore.com',           // ComScore
    'adsafeprotected.com', 'iasds01.com',              // IAS
    'hotjar.com', 'clarity.ms', 'mouseflow.com',
    'linkedin.com/px', 'snap.licdn.com',
    'ads.twitter.com', 't.co/i/',
    'pinterest.com/ct', 'tiktok.com/i18n',
    'criteo.com', 'taboola.com', 'outbrain.com',
    'amazon-adsystem.com', 'adnxs.com',
];

function isTrackingRequest(urlLower) {
    return TRACKING_PATTERNS.some(p => urlLower.includes(p));
}

function setDebugAllTracking(val) {
    debugAllTracking = !!val;
}

function getDebugAllTracking() {
    return debugAllTracking;
}

// patchCollectUrlForReturning moved to ../helpers/collectPatch (shared with ManualVisitor).

class AutomaticVisitor {
    constructor(config) {
        this.campaignUrl = config.campaignUrl;
        this.referer = config.referer;
        this.isReferer = config.isReferer;
        this.visitReferer = config.visitReferer !== undefined ? config.visitReferer : config.isReferer;
        this.userAgent = config.userAgent;
        this.threadId = config.threadId;
        this.visit = config.visit;  // Visit object with pagePerSession and avgSessionDuration
        this.screenSize = config.screenSize;
        this.isOldUser = config.isOldUser;
        this.savedCookies = config.savedCookies || null;
        this.restrictToPrimaryDomain = config.restrictToPrimaryDomain;
        this.previousURL = config.previousURL;
        this.useBaseUrlForOldUser = config.useBaseUrlForOldUser || false;  // NEW: Option to use base URL
        this.playMode = config.playMode;
        this.adsBlock = config.adsBlock;
        
        // Location setting - FIXED: Now functional
        this.location = config.location || 'India';
        this.locationData = Constants.getLocationCoords(this.location);
        
        // Proxy settings — only /collect endpoints proxied
        this.proxyEnabled = config.proxyEnabled || false;
        this.proxyUrl = config.proxyUrl || '';
        this.proxyConfig = this.proxyEnabled ? parseProxyString(this.proxyUrl) : null;
        this.proxyRouter = null;

        // Custom proxy URL patterns (CM360 / ad trackers) — extra hosts routed through proxy
        this.customProxyEnabled = config.customProxyEnabled || false;
        this.customProxyPatterns = this.customProxyEnabled
            ? parseCustomProxyPatterns(config.customProxyPatterns || '')
            : [];
        
        // Extension settings - NEW: SimilarWeb support
        this.extensionEnabled = config.extensionEnabled || false;
        this.extensionPath = config.extensionPath || '';
        this.extensionLoaded = false;  // Will be set to true if extension loads successfully
        
        // IP Rotation settings - NEW v2.4
        this.ipRotation = config.ipRotation || false;
        this.currentIP = null;
        
        // Fast Mode - Block heavy resources
        this.fastMode = config.fastMode || false;
        this.blockImages = config.blockImages || false;
        this.blockMedia = config.blockMedia || false;
        this.blockFonts = config.blockFonts || false;
        this.blockStyles = config.blockStyles || false;
        this.blockScripts = config.blockScripts || false;

        // Proxy stats callback — called after each proxied /collect and at visit end
        this.onProxyStats = config.onProxyStats || null;
        // GA4 event callback — called when /collect requests are detected
        this.onGA4Event = config.onGA4Event || null;

        this.logger = getLogger(this.threadId);
        this.browser = null;
        this.context = null;
        this.page = null;
        this.primaryDomain = this._extractDomain(this.campaignUrl);
        
        // Random wait based on play mode
        // IMPORTANT: Even fastest mode needs minimum wait for GA4 tracking
        // Original Java: 3000L + new Random().nextInt(9000) = 3-12 seconds
        switch (this.playMode) {
            case Constants.PLAY_MODES.FASTEST:
                // Headless, fast but still human-like (2-4s)
                this.randomWaitMs = 2000 + Math.floor(Math.random() * 2000);
                break;
            case Constants.PLAY_MODES.FAST:
                // Headless, moderate speed (3-6s)
                this.randomWaitMs = 3000 + Math.floor(Math.random() * 3000);
                break;
            case Constants.PLAY_MODES.SLOW:
                // Visible browser, slower (4-8s)
                this.randomWaitMs = 4000 + Math.floor(Math.random() * 4000);
                break;
            case Constants.PLAY_MODES.SLOWER:
            default:
                // Most human-like (5-12s, original Java timing)
                this.randomWaitMs = 5000 + Math.floor(Math.random() * 7000);
                break;
        }
        
        this.logger.debug(`Play mode: ${this.playMode}, Random wait: ${this.randomWaitMs}ms`);
    }

    /**
     * Execute the visit
     * MATCHES Java AutomaticLogic.doInBackground()
     */
    async execute() {
        const startTime = Date.now();

        // Initialize session replay
        this.replay = new SessionReplay(this.threadId, { maxEvents: 200 });
        this.replay.setSessionInfo({
            userAgent: this.userAgent,
            screenSize: this.screenSize,
            location: this.location,
            playMode: this.playMode,
            proxyMode: this.proxyEnabled ? 'collect-only' : 'none',
            ipRotation: this.ipRotation,
            spoofedIP: this.currentIP,
            isOldUser: this.isOldUser,
        });
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
            if (this.visit.isBounce()) {
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
            // CRITICAL: Extract cookies BEFORE closing context — context.cookies()
            // returns empty after close, which was causing "COOKIE JAR: EMPTY" bug
            await this._extractCookiesBeforeClose();
            this._saveReplay();
            await this._cleanup();
        }
    }

    /**
     * Visit previous URL for returning users
     * 
     * Purpose: Create cookie/session BEFORE visiting UTM URL
     *          This makes GA4 see the visitor as "returning" user
     * 
     * Case 1: Manual Previous URL set → Use that URL
     * Case 2: Use Base URL checked + UTM link → Extract base URL (before '?')
     * Case 3: Use Base URL checked + Tracking URL → Won't work (need manual URL)
     */
    async _visitPreviousUrl() {
        let prevUrl = this.previousURL;
        let urlSource = 'manual';
        
        // If no manual URL, try to extract base URL from campaign URL
        if (!prevUrl && this.useBaseUrlForOldUser) {
            try {
                const url = new URL(this.campaignUrl);
                prevUrl = `${url.protocol}//${url.host}${url.pathname}`;
                urlSource = 'auto-extracted';
                this.logger.info(`🔗 Base URL extracted: ${prevUrl}`);
            } catch {
                this.logger.warn(`⚠️ Cannot extract base URL from: ${this.campaignUrl}`);
                return;
            }
        }
        
        // If still no URL, skip
        if (!prevUrl) {
            this.logger.info(`⚠️ Old user - No previous URL configured, skipping`);
            return;
        }
        
        this.logger.info(`👤 RETURNING USER - Visiting previous URL first (${urlSource})`);
        this.logger.info(`   Step 1: ${prevUrl} (creates cookie/session)`);
        this.logger.info(`   Step 2: ${this.campaignUrl} (GA4 sees as returning)`);
        this.replay.logPreviousURLVisit(prevUrl, urlSource);

        try {
            await this.page.goto(prevUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            });

            // CRITICAL: Wait for GA4 cookies to be set
            await this._waitForGA4();

            // Additional wait to ensure cookies are written
            await this._sleep(this.randomWaitMs);
            this.logger.info(`✅ Previous URL visited, cookie created, waited ${this.randomWaitMs}ms`);

        } catch (error) {
            this.replay.logError('previous_url', error.message);
            this.logger.warn(`❌ Failed to visit previous URL: ${error.message}`);
        }
    }

    /**
     * Visit the first/main campaign page
     * CRITICAL: Must wait for GA4 scripts to load and fire events
     */
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
                    this.logger
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
                await this.page.goto(urlToNavigate, {
                    waitUntil: waitStrategy,
                    timeout: navTimeout
                });
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

            // Verify extension is working (if enabled) — skip for bounce
            if (!isBounce && this.extensionEnabled && this.extensionLoaded) {
                await this._verifyExtension();
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
            await this.page.mouse.move(
                100 + Math.random() * 200,
                100 + Math.random() * 150
            );
            await this._sleep(300);
            
            // Maybe a small scroll
            if (Math.random() > 0.5) {
                await this.page.evaluate(() => {
                    window.scrollBy({ top: 200 + Math.random() * 300, behavior: 'auto' });
                });
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

            const links = await this.page.evaluate(({ currentHost, restrictToPrimary, primaryDomain }) => {
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
            });

            return links;

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
            gaDetails = await this.page.evaluate(() => {
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
            });
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
                gaDetails = await this.page.evaluate(() => {
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
                });
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
     * Verify that SimilarWeb extension is working
     * Checks for extension markers in the page
     */
    async _verifyExtension() {
        try {
            await this._sleep(1500);

            // Content scripts run in an isolated JS world — they share the DOM
            // but NOT `window` with page.evaluate(). So window.__sw_* flags are
            // invisible here. Detect via DOM evidence that the content script
            // actually injected (data attribute + tracking pixel).
            const extensionStatus = await this.page.evaluate(() => {
                return {
                    dataAttribute: document.documentElement.getAttribute('data-similarweb') === 'true',
                    hasPixel: !!document.querySelector('img[src*="similarweb.com"]'),
                };
            });

            const detected = extensionStatus.dataAttribute || extensionStatus.hasPixel;
            if (detected) {
                this.logger.info(`🧩 ✅ Extension WORKING!`);
                this.logger.info(`   ├─ data-similarweb attr: ${extensionStatus.dataAttribute}`);
                this.logger.info(`   └─ Tracking Pixel: ${extensionStatus.hasPixel}`);
            } else {
                this.logger.warn(`🧩 ⚠️ Extension NOT DETECTED on page`);
                this.logger.warn(`   This could mean:`);
                this.logger.warn(`   1. Extension failed to load`);
                this.logger.warn(`   2. Content script blocked by page CSP`);
                this.logger.warn(`   3. Wrong extension path`);
            }

        } catch (error) {
            this.logger.debug(`Extension verification error: ${error.message}`);
        }
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
        const startedAt = Date.now();
        try {
            if (budgetMs < 1500) {
                try {
                    await this.page.evaluate(() => {
                        window.scrollBy({ top: 400, behavior: 'auto' });
                    });
                } catch (e) { /* ignore */ }
                return;
            }

            const TARGET_FULL_BUDGET = 5000;
            const scale = Math.min(1.0, budgetMs / TARGET_FULL_BUDGET);

            const sleepIfBudget = async (ms) => {
                if (Date.now() - startedAt + ms > budgetMs) return;
                await this._sleep(ms);
            };

            await sleepIfBudget(Math.floor((1000 + Math.random() * 1000) * scale));
            await this._simulateMouseMovement();
            await sleepIfBudget(Math.floor((500 + Math.random() * 1000) * scale));
            await this._simulateScrolling(scale);
            await sleepIfBudget(Math.floor((500 + Math.random() * 500) * scale));

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
    async _simulateScrolling(scale = 1.0) {
        try {
            const scroll1 = 300 + Math.floor(Math.random() * 400);
            await this.page.evaluate((amount) => {
                window.scrollBy({ top: amount, behavior: 'smooth' });
            }, scroll1);
            await this._sleep(Math.floor((800 + Math.random() * 600) * scale));

            const scroll2 = 500 + Math.floor(Math.random() * 700);
            await this.page.evaluate((amount) => {
                window.scrollBy({ top: amount, behavior: 'smooth' });
            }, scroll2);
            await this._sleep(Math.floor((600 + Math.random() * 500) * scale));

            if (scale > 0.5 && Math.random() > 0.3) {
                const scroll3 = Math.random() > 0.5
                    ? (400 + Math.floor(Math.random() * 600))
                    : -(200 + Math.floor(Math.random() * 300));
                await this.page.evaluate((amount) => {
                    window.scrollBy({ top: amount, behavior: 'smooth' });
                }, scroll3);
                await this._sleep(Math.floor((400 + Math.random() * 400) * scale));
            }

        } catch (error) {
            this.logger.debug(`Scroll error: ${error.message}`);
        }
    }

    /**
     * Simulate mouse movement - More human-like
     */
    async _simulateMouseMovement() {
        try {
            // Start position
            const startX = 100 + Math.floor(Math.random() * 200);
            const startY = 100 + Math.floor(Math.random() * 150);
            await this.page.mouse.move(startX, startY);
            await this._sleep(200 + Math.random() * 200);
            
            // Move around (2-3 movements)
            const moves = 2 + Math.floor(Math.random() * 2);
            for (let i = 0; i < moves; i++) {
                const x = 100 + Math.floor(Math.random() * 500);
                const y = 100 + Math.floor(Math.random() * 400);
                await this.page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 5) });
                await this._sleep(150 + Math.random() * 200);
            }
            
        } catch (error) {
            this.logger.debug(`Mouse movement error: ${error.message}`);
        }
    }

    /**
     * Get bundled Chromium path when running as a packaged Electron app.
     * Returns undefined in dev mode so Playwright uses its own installed browser.
     */
    _getChromiumPath() {
        // In packaged Electron apps, process.resourcesPath points to the resources dir
        const isPackaged = process.resourcesPath && !process.resourcesPath.includes('node_modules');
        if (!isPackaged) return undefined;

        const candidates = [
            path.join(process.resourcesPath, 'playwright-browsers', 'chromium', 'chrome-win64', 'chrome.exe'),
            path.join(process.resourcesPath, 'playwright-browsers', 'chromium', 'chrome-win', 'chrome.exe'),
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                this.logger.info(`Using bundled Chromium: ${candidate}`);
                return candidate;
            }
        }

        this.logger.warn('Bundled Chromium not found, falling back to Playwright default');
        return undefined;
    }

    /**
     * Launch browser based on play mode
     * FIXED: Added extension support for SimilarWeb
     * Uses bundled Chromium in packaged mode
     */
    _buildLaunchArgs() {
        return [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--disable-client-side-phishing-detection',
            '--disable-features=SafeBrowsing',
            '--no-first-run',
            `--window-size=${this.screenSize.width},${this.screenSize.height}`
        ];
    }

    async _launchBrowser() {
        const isHeadless = this.playMode === Constants.PLAY_MODES.FASTEST ||
                          this.playMode === Constants.PLAY_MODES.FAST;

        // Extension + headed → defer to _createContext which uses
        // launchPersistentContext (extensions only work there, not in
        // a separate browser.newContext).
        this._usePersistentContext = false;
        if (this.extensionEnabled && this.extensionPath && !isHeadless) {
            if (fs.existsSync(this.extensionPath)) {
                this._usePersistentContext = true;
                this.extensionLoaded = true;
                this.logger.info(`Extension enabled — will use persistent context: ${this.extensionPath}`);
                return;
            } else {
                this.logger.warn(`Extension path not found: ${this.extensionPath}`);
                this.extensionLoaded = false;
            }
        } else if (this.extensionEnabled && isHeadless) {
            this.logger.warn(`Extensions require headed mode (Slow or Slower). Current mode: ${this.playMode}`);
            this.extensionLoaded = false;
        }

        const launchOptions = {
            headless: isHeadless,
            args: this._buildLaunchArgs()
        };

        const chromiumPath = this._getChromiumPath();
        if (chromiumPath) {
            launchOptions.executablePath = chromiumPath;
        }

        this.browser = await chromium.launch(launchOptions);
        this.logger.debug('Browser launched');
    }

    /**
     * Create browser context with all settings
     * FIXED: 
     * 1. Location now uses config values
     * 2. Merged route handler for proxy + ad blocking
     * 3. Proper proxy implementation using Playwright's built-in proxy
     */
    _buildContextOptions() {
        const isHeadless = this.playMode === Constants.PLAY_MODES.FASTEST ||
                          this.playMode === Constants.PLAY_MODES.FAST;
        const isMobileUA = this.userAgent.includes('Mobile');
        const contextOptions = {
            userAgent: this.userAgent,
            locale: this.locationData.locale,
            timezoneId: this.locationData.timezone,
            geolocation: {
                latitude: this.locationData.latitude,
                longitude: this.locationData.longitude
            },
            permissions: ['geolocation'],
            javaScriptEnabled: true,
        };
        if (isHeadless) {
            contextOptions.viewport = {
                width: this.screenSize.width,
                height: this.screenSize.height
            };
            contextOptions.hasTouch = isMobileUA;
            contextOptions.isMobile = isMobileUA;
            contextOptions.deviceScaleFactor = isMobileUA ? 2 : 1;
        } else {
            contextOptions.viewport = null;
        }

        if (this.isReferer && this.referer) {
            contextOptions.extraHTTPHeaders = {
                'Referer': this.referer
            };
        }

        if (this.ipRotation) {
            const ipResult = generateIndianIP(this.location);
            if (ipResult) {
                this.currentIP = ipResult.ip;
                this.logger.info(`🌐 IP Rotation: ${this.currentIP} (${ipResult.isp})`);
                this.logger.warn(`⚠️ IP spoofing only works on non-Cloudflare sites`);
                contextOptions.extraHTTPHeaders = {
                    ...(contextOptions.extraHTTPHeaders || {}),
                    'X-Forwarded-For': this.currentIP,
                };
            }
        }
        return contextOptions;
    }

    async _createContext() {
        const contextOptions = this._buildContextOptions();
        this.logger.info(`Viewport: ${this.screenSize.width}x${this.screenSize.height} | UA: ${this.userAgent.substring(0, 50)}... | Mobile: ${this.userAgent.includes('Mobile')}`);

        if (this._usePersistentContext) {
            // Extensions only work inside launchPersistentContext — Playwright
            // loads them into the default profile, not into browser.newContext().
            this._tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trafficrobo-'));
            const args = this._buildLaunchArgs();
            args.push(`--disable-extensions-except=${this.extensionPath}`);
            args.push(`--load-extension=${this.extensionPath}`);

            const persistentOptions = {
                ...contextOptions,
                headless: false,
                args,
            };
            const chromiumPath = this._getChromiumPath();
            if (chromiumPath) {
                persistentOptions.executablePath = chromiumPath;
            }

            this.context = await chromium.launchPersistentContext(this._tempUserDataDir, persistentOptions);
            this.browser = this.context.browser();
            this.logger.info(`Persistent context launched with extension (userDataDir: ${this._tempUserDataDir})`);

            // Extensions open welcome/onboarding tabs on first install via
            // chrome.runtime.onInstalled. Since each visit gets a fresh temp
            // dir, the extension always thinks it's a fresh install. Close
            // all pages it opened before creating our own.
            await this._sleep(1500);
            for (const p of this.context.pages()) {
                await p.close().catch(() => {});
            }
        } else {
            this.context = await this.browser.newContext(contextOptions);
        }

        await this._setupMergedRouteHandler();
        await this._addStealthScripts();
        this.page = await this.context.newPage();
        this.logger.debug('Context and page created');
    }
    
    /**
     * FIXED: Merged route handler for proxy routing + ad blocking
     * This combines both functionalities in a single handler to prevent conflicts
     */
    async _setupMergedRouteHandler() {
        // Initialize proxy router
        if (this.proxyEnabled && this.proxyConfig) {
            this.proxyRouter = new ProxyRouter({
                proxyUrl: this.proxyUrl,
                enabled: true,
                threadId: this.threadId
            });
        }
        
        // Always install route handler — needed for GA4 event monitoring
        // even when proxy/adsBlock/fastMode are all disabled
        
        const self = this;
        
        // Ad patterns to block
        const blockedAdPatterns = [
            'googlesyndication.com', 'adservice.google', 'adsense',
            'facebook.com/tr', 'connect.facebook', 'amazon-adsystem',
            'adnxs.com', 'criteo.com', 'outbrain.com', 'taboola.com'
        ];
        
        await this.context.route('**/*', async (route, request) => {
          try {
            const url = request.url();
            const urlLower = url.toLowerCase();
            const resourceType = request.resourceType();

            // 1. Ad blocking
            if (self.adsBlock && blockedAdPatterns.some(p => urlLower.includes(p))) {
                await route.abort();
                return;
            }
            
            // 2. Fast Mode — block heavy resources (but never block GA)
            if (self.fastMode) {
                const isCollect = isGACollectRequest(url);
                const isScript = isGAScript(url);
                if (!isCollect && !isScript) {
                    if (self.blockImages && resourceType === 'image') { await route.abort(); return; }
                    if (self.blockMedia && resourceType === 'media') { await route.abort(); return; }
                    if (self.blockFonts && resourceType === 'font') { await route.abort(); return; }
                    if (self.blockStyles && resourceType === 'stylesheet') { await route.abort(); return; }
                    if (self.blockScripts && resourceType === 'script') { await route.abort(); return; }
                }
            }
            
            // 3. Proxy — only /collect endpoints via proxy, everything else DIRECT
            if (self.proxyEnabled && self.proxyRouter) {
                if (isGACollectRequest(url)) {
                    // Returning user fix: patch /collect params
                    let collectUrl = url;
                    if (self.isOldUser) {
                        const patched = patchCollectUrlForReturning(url);
                        if (patched) {
                            collectUrl = patched;
                            self.logger.info('RETURNING USER FIX: Removed _fv, set sct=2 for /collect request');
                        }
                    }
                    // /collect → proxy via Node.js http (no CONNECT tunnel)
                    self.proxyRouter.stats.totalRequests++;
                    self.proxyRouter.stats.proxiedRequests++;
                    try {
                        const response = await self.proxyRouter.makeProxiedRequest(request, collectUrl);
                        await route.fulfill({
                            status: response.status,
                            headers: response.headers,
                            body: response.body,
                        });
                        self.replay.logRequest(collectUrl, true, true);
                        self._emitProxyStats(collectUrl, true);
                        self._emitGA4Event(collectUrl, true);
                    } catch (e) {
                        self.replay.logError('proxy_collect', e.message);
                        self.logger.debug(`/collect proxy failed, fallback direct: ${e.message}`);
                        self._emitProxyStats(url, false);
                        self._emitGA4Event(url, false);
                        await route.continue();
                    }
                    return;
                }
                // Custom proxy URL patterns (CM360 / ad trackers) for SUBRESOURCE
                // requests fired during page load (pixels, tracking beacons).
                // The initial click-tracker NAVIGATION is pre-resolved in Node
                // before page.goto (see _visitFirstPage), so this branch only
                // runs for in-page tracker requests — never for top-frame nav.
                if (self.customProxyEnabled && self.customProxyPatterns.length > 0 &&
                    matchesCustomProxyPattern(url, self.customProxyPatterns)) {
                    self.proxyRouter.stats.totalRequests++;
                    self.proxyRouter.stats.proxiedRequests++;
                    try {
                        const response = await self.proxyRouter.makeProxiedRequest(request);
                        await route.fulfill({
                            status: response.status,
                            headers: response.headers,
                            body: response.body,
                        });
                        self.logger.debug(`Custom-proxy hop: ${url.substring(0, 100)} → ${response.status}`);
                    } catch (e) {
                        self.logger.debug(`Custom-proxy hop failed, fallback direct: ${e.message}`);
                        try { await route.continue(); } catch {}
                    }
                    return;
                }

                // Non-collect (including GA scripts) → DIRECT
                self.proxyRouter.stats.totalRequests++;
                self.proxyRouter.stats.directRequests++;
                if (isGAScript(url)) self.proxyRouter.stats.scriptsLoadedDirect++;
                if (isGAScript(url)) self.replay.logRequest(url, true, false);
                if (debugAllTracking && isTrackingRequest(urlLower)) {
                    self.replay.logRequest(url, false, false);
                }
                await route.continue();
                return;
            }

            // 3b. No proxy but still track GA /collect requests for replay + monitor
            if (isGACollectRequest(url)) {
                self.logger.info(`ROUTE HANDLER: isOldUser=${self.isOldUser} | /collect detected`);
                // Returning user fix: patch /collect params
                if (self.isOldUser) {
                    const patched = patchCollectUrlForReturning(url);
                    self.logger.info(`RETURNING USER PATCH: patched=${patched ? 'YES' : 'NO'} | had _fv=${url.includes('_fv=')} sct=1=${url.includes('sct=1')}`);
                    if (patched) {
                        self.logger.info('RETURNING USER FIX: Removed _fv, set sct=2 for /collect request');
                        self.replay.logRequest(patched, true, false);
                        self._emitGA4Event(patched, false);
                        await route.continue({ url: patched });
                        return;
                    }
                }
                self.replay.logRequest(url, true, false);
                self._emitGA4Event(url, false);
            } else if (debugAllTracking && isTrackingRequest(urlLower)) {
                self.replay.logRequest(url, false, false);
            }

            // 4. No proxy — just continue
            await route.continue();
          } catch (err) {
            // Page closed mid-request or route already handled — common, swallow.
            try { await route.continue(); } catch {}
            self.logger.debug(`Route handler error (ignored): ${err.message}`);
          }
        });

        const features = [];
        if (this.proxyEnabled) features.push('proxy-collect-only');
        if (this.adsBlock) features.push('ad-block');
        if (this.fastMode) features.push('fast-mode');
        this.logger.info(`Route handler: ${features.join(' + ')}`);
    }

    async _addStealthScripts() {
        const languages = Constants.getLanguagesForLocation(this.location);

        await this.context.addInitScript((langs) => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => langs });
            window.chrome = { runtime: {} };
        }, languages);
    }

    /**
     * Save session replay JSON to campaign log dir replays/
     */
    _saveReplay() {
        try {
            if (!this.replay) return;
            const campaignDir = getCampaignLogDir();
            if (!campaignDir) return;
            const replaysDir = path.join(campaignDir, 'replays');
            fs.mkdirSync(replaysDir, { recursive: true });
            const ts = Date.now();
            const filename = `replay_${this.threadId}_${ts}.json`;
            const filepath = path.join(replaysDir, filename);
            const summary = this.replay.getSummary();
            fs.writeFileSync(filepath, JSON.stringify(summary, null, 2));
            this.logger.debug(`Replay saved: ${filename}`);
        } catch (error) {
            this.logger.debug(`Failed to save replay: ${error.message}`);
        }
    }

    /**
     * Emit proxy stats to UI via callback
     * @param {string} lastCollectUrl - Last /collect URL proxied
     * @param {boolean} success - Whether the proxy call succeeded
     */
    _emitProxyStats(lastCollectUrl, success) {
        if (!this.onProxyStats || !this.proxyRouter) return;
        try {
            this.onProxyStats({
                threadId: this.threadId,
                proxyHost: this.proxyConfig ? `${this.proxyConfig.host}:${this.proxyConfig.port}` : null,
                collectProxied: this.proxyRouter.stats.proxiedRequests,
                directCount: this.proxyRouter.stats.directRequests,
                totalRequests: this.proxyRouter.stats.totalRequests,
                scriptsLoadedDirect: this.proxyRouter.stats.scriptsLoadedDirect,
                bandwidthSaved: this.proxyRouter.stats.directRequests * 150000, // ~150KB avg per direct page load avoided
                lastCollectUrl: lastCollectUrl || '',
                success: success
            });
        } catch (e) {
            this.logger.debug(`Proxy stats emit error: ${e.message}`);
        }
    }

    /**
     * Parse GA4 /collect URL to extract event info
     * GA4 /collect params: en=event_name, tid=G-XXXXX, dl=document_location, dt=document_title
     * @param {string} url - The /collect request URL
     * @returns {Object} Parsed event info
     */
    _parseGA4CollectUrl(url) {
        try {
            const u = new URL(url);
            const params = u.searchParams;
            // POST body events use 'en', legacy uses 't' (pageview/event)
            const eventName = params.get('en') || params.get('t') || 'collect';
            const tid = params.get('tid') || '';
            const dl = params.get('dl') || '';
            // Extract hostname from document location for display
            let hostname = '';
            if (dl) {
                try { hostname = new URL(dl).hostname; } catch {}
            }
            return { eventName, tid, dl, hostname };
        } catch {
            return { eventName: 'collect', tid: '', dl: '', hostname: '' };
        }
    }

    /**
     * Emit GA4 event to UI via callback
     * @param {string} url - The /collect request URL
     * @param {boolean} proxied - Whether the request was proxied
     */
    _emitGA4Event(url, proxied) {
        if (!this.onGA4Event) return;
        try {
            const parsed = this._parseGA4CollectUrl(url);
            this.onGA4Event({
                type: 'ga4_event',
                eventType: parsed.eventName,
                url: parsed.hostname || url,
                tid: parsed.tid,
                dl: parsed.dl,
                proxied: proxied,
                threadId: this.threadId
            });
        } catch (e) {
            this.logger.debug(`GA4 event emit error: ${e.message}`);
        }
    }

    /**
     * Extract GA cookies from context BEFORE it's closed.
     * Called in execute() finally block, before _cleanup().
     * Stores result in this._extractedCookies for getCookies() to return.
     */
    async _extractCookiesBeforeClose() {
        if (!this.context) {
            this.logger.warn(`COOKIE EXTRACT: context already null — cannot extract cookies`);
            this._extractedCookies = [];
            return;
        }
        // Bounce visits live ~1-3s and may close before GA4 server-side records the cdid.
        // Reusing such a cdid as a "returning" cookie makes GA4 see it for the first time
        // and classify it as a new user, which is what was dropping the returning-detection rate.
        if (this.visit && this.visit.isBounce()) {
            this.logger.info(`COOKIE EXTRACT: Skipping — bounce visit, cdid likely not registered by GA4`);
            this._extractedCookies = [];
            return;
        }
        try {
            this.logger.info(`COOKIE EXTRACT: Extracting cookies before context close...`);
            const all = await this.context.cookies();
            // Only save _ga (client ID). Skip _ga_<MEASUREMENT_ID> session cookie and _gid —
            // injecting an old session cookie makes gtag.js continue the old session instead
            // of starting a fresh one, so GA4 never registers a new returning-user session.
            const gaCookies = all.filter(c => c.name === '_ga');
            this._extractedCookies = gaCookies;
            this.logger.info(`COOKIE EXTRACT: Found ${all.length} total cookies, ${gaCookies.length} _ga cookies (client ID only)`);
            for (const c of gaCookies) {
                const expires = c.expires ? new Date(c.expires * 1000).toISOString() : 'session';
                this.logger.info(`  SEED: ${c.name}=${c.value} | domain=${c.domain} path=${c.path} expires=${expires} secure=${c.secure} sameSite=${c.sameSite}`);
            }
        } catch (e) {
            this.logger.warn(`COOKIE EXTRACT: Failed: ${e.message}`);
            this._extractedCookies = [];
        }
    }

    /**
     * Get GA cookies extracted from the visit.
     * Returns cookies stored by _extractCookiesBeforeClose() (safe to call after context close).
     */
    getCookies() {
        return this._extractedCookies || [];
    }

    /**
     * Extract domain from URL
     */
    _extractDomain(url) {
        try {
            return new URL(url).hostname.replace('www.', '');
        } catch {
            return '';
        }
    }

    /**
     * After the initial navigation settles, re-derive primaryDomain from the
     * real landed URL. When campaignUrl is a CM360 / ad-tracker URL, the 302
     * redirect chain lands somewhere else — internal-link traversal and the
     * replay log must reflect the real destination, not the click tracker.
     */
    _resolveLandedDomain() {
        if (!this.page) return;
        const landedUrl = this.page.url();
        const landedDomain = this._extractDomain(landedUrl);
        if (!landedDomain || landedDomain === this.primaryDomain) return;
        this.logger.info(`Domain resolved after redirect: ${this.primaryDomain} → ${landedDomain}`);
        this.primaryDomain = landedDomain;
        this.landedUrl = landedUrl;
    }

    /**
     * Sleep helper - exact milliseconds
     */
    async _sleep(ms) {
        if (ms <= 0) return;
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Cleanup resources
     */
    async _cleanup() {
        try {
            if (this.page) await this.page.close().catch(() => {});
            if (this._usePersistentContext) {
                // context.close() shuts down the browser too
                if (this.context) await this.context.close().catch(() => {});
            } else {
                if (this.context) await this.context.close().catch(() => {});
                if (this.browser) await this.browser.close().catch(() => {});
            }
            this.logger.debug('Cleanup completed');
        } catch (error) {
            this.logger.debug(`Cleanup error: ${error.message}`);
        }
        this._cleanupTempDir();
    }

    /**
     * Force close browser immediately - called by stop()
     */
    async forceClose() {
        this.logger.info(`🛑 Force closing browser...`);
        try {
            if (this._usePersistentContext) {
                if (this.context) {
                    await this.context.close().catch(() => {});
                    this.context = null;
                    this.browser = null;
                }
            } else if (this.browser) {
                await this.browser.close().catch(() => {});
                this.browser = null;
            }
            if (this.context) this.context = null;
            if (this.page) this.page = null;
        } catch (error) {
            // Ignore errors during force close
        }
        this._cleanupTempDir();
    }

    _cleanupTempDir() {
        if (this._tempUserDataDir) {
            try {
                fs.rmSync(this._tempUserDataDir, { recursive: true, force: true });
                this.logger.debug(`Cleaned up temp dir: ${this._tempUserDataDir}`);
            } catch (e) {
                this.logger.debug(`Temp dir cleanup failed: ${e.message}`);
            }
            this._tempUserDataDir = null;
        }
    }
}

module.exports = AutomaticVisitor;
module.exports.setDebugAllTracking = setDebugAllTracking;
module.exports.getDebugAllTracking = getDebugAllTracking;
