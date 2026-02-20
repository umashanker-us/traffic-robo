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
const path = require('path');
const fs = require('fs');
const { getLogger } = require('../helpers/logger');
const Constants = require('../helpers/constants');
const { ProxyRouter, isGACollectRequest, isGAScript, createPlaywrightProxy, parseProxyString } = require('../helpers/proxyRouter');
const { generateIndianIP } = require('../helpers/indianIP');
const { SessionReplay } = require('../helpers/sessionReplay');

const REPLAYS_DIR = path.join(Constants.DATA_PATH, 'replays');

class AutomaticVisitor {
    constructor(config) {
        this.campaignUrl = config.campaignUrl;
        this.referer = config.referer;
        this.isReferer = config.isReferer;
        this.userAgent = config.userAgent;
        this.threadId = config.threadId;
        this.visit = config.visit;  // Visit object with pagePerSession and avgSessionDuration
        this.screenSize = config.screenSize;
        this.isOldUser = config.isOldUser;
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
        this.proxyConfig = parseProxyString(this.proxyUrl);
        this.proxyRouter = null;
        
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

            // Handle returning users (visit previous URL first to create cookie/session)
            // This makes GA4 see them as "returning" users
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

            // CRITICAL: Check if this is a BOUNCE visit
            if (this.visit.isBounce()) {
                // Bounce visit - NO WAIT, exit immediately
                this.logger.info(`🔴 BOUNCE VISIT - Exiting immediately (no additional pages, no wait)`);
                this.replay.logBounce(Date.now() - startTime);
            } else {
                // Non-bounce visit - wait and visit additional pages

                // Wait for first page (Java: Thread.sleep(1000 * avgSessionDuration / pagePerSession))
                const waitTimeMs = this.visit.getWaitTimePerPageMs();
                this.logger.info(`Waiting ${waitTimeMs}ms on first page...`);
                await this._sleep(waitTimeMs);

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
                waitUntil: 'networkidle',  // Wait for all network requests
                timeout: 45000
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
        this.logger.info(`Navigating to campaign URL: ${this.campaignUrl}`);
        const loadStartTime = Date.now();

        try {
            // Handle referer navigation
            if (this.isReferer && this.referer) {
                await this.page.goto(this.referer, {
                    waitUntil: 'load',
                    timeout: 60000
                });
                await this._sleep(1000); // Brief pause on referer page
                await this.page.evaluate((url) => {
                    window.location.href = url;
                }, this.campaignUrl);
                await this.page.waitForLoadState('load', { timeout: 60000 });
            } else {
                await this.page.goto(this.campaignUrl, {
                    waitUntil: 'load',
                    timeout: 60000
                });
            }

            // CRITICAL: Wait for GA4/GTM scripts to initialize and fire events
            await this._waitForGA4();
            
            // Verify extension is working (if enabled)
            if (this.extensionEnabled && this.extensionLoaded) {
                await this._verifyExtension();
            }

            const loadTimeMs = Date.now() - loadStartTime;
            const loadTime = loadTimeMs / 1000;
            const pageTitle = await this.page.title().catch(() => 'Unknown');
            const currentUrl = this.page.url();

            this.replay.logNavigation(currentUrl, loadTimeMs, pageTitle);

            this.logger.info(`✅ Page fully loaded: ${loadTime.toFixed(2)}s`);
            this.logger.info(`URL to be visited: ${this.campaignUrl}`);
            this.logger.info(`Page title: ${pageTitle}`);
            this.logger.info(`Current URL: ${currentUrl}`);

            // Simulate realistic user behavior
            if (this.visit.isBounce()) {
                // Bounce visit - user glances at page briefly (2-5 seconds)
                const bounceWait = 2000 + Math.random() * 3000;
                this.logger.info(`🔴 Bounce visit - staying ${(bounceWait/1000).toFixed(1)}s`);
                await this._sleep(bounceWait);
                await this._simulateQuickGlance();
            } else {
                // Non-bounce - real user behavior simulation
                await this._simulateUserBehavior();
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
                const loadStartTime = Date.now();

                // Navigate to the link - FIXED: Wait for full page load + network
                await this.page.goto(linkUrl, {
                    waitUntil: 'networkidle',
                    timeout: 45000
                });

                // CRITICAL: Wait for GA4 to fire page_view event
                await this._waitForGA4();

                const loadTimeMs = Date.now() - loadStartTime;
                const loadTime = loadTimeMs / 1000;
                const pageTitle = await this.page.title().catch(() => '');
                this.replay.logNavigation(linkUrl, loadTimeMs, pageTitle);
                this.logger.info(`✅ Page ${i + 2} loaded: ${loadTime.toFixed(2)}s - ${linkUrl}`);

                // Simulate user behavior on the new page
                await this._simulateUserBehavior();

                // Wait 1: Random wait (Java: Thread.sleep(this.mRandomWait))
                await this._sleep(this.randomWaitMs);

                // Wait 2: Session duration wait (Java: Thread.sleep(1000 * avgSessionDuration / pagePerSession))
                const waitTimeMs = this.visit.getWaitTimePerPageMs();
                await this._sleep(waitTimeMs);
                this.logger.info(`Page ${i + 2} wait time: ${this.visit.getWaitTimePerPageSec()}s`);

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
            const currentUrl = new URL(this.page.url());
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
        const startTime = Date.now();
        this.logger.info(`⏳ Waiting for page + GA4 to fully load...`);
        
        // STEP 1: Wait for DOM to be complete
        try {
            await this.page.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 });
            this.logger.debug(`DOM complete: ${Date.now() - startTime}ms`);
        } catch (e) {
            this.logger.debug(`DOM readyState timeout`);
        }
        
        // STEP 2: Wait for network to become idle (all scripts loaded)
        try {
            await this.page.waitForLoadState('networkidle', { timeout: 15000 });
            this.logger.debug(`Network idle: ${Date.now() - startTime}ms`);
        } catch (e) {
            this.logger.debug(`Network idle timeout, continuing...`);
        }
        
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

        // STEP 4: MANDATORY wait for GA4 events to fire
        // This is CRITICAL - GA4 needs time after script load to:
        // - Initialize tracking
        // - Fire page_view event
        // - Send beacon request
        if (gaDetected) {
            const gaWait = 3000 + Math.random() * 2000; // 3-5 seconds
            this.logger.info(`✅ GA4/GTM detected - waiting ${(gaWait/1000).toFixed(1)}s for tracking events...`);
            await this._sleep(gaWait);
        } else {
            // No GA detected - still wait minimum time (page might load GA dynamically)
            const minWait = 2000 + Math.random() * 1000; // 2-3 seconds
            this.logger.info(`⚠️ No GA4/GTM detected - waiting ${(minWait/1000).toFixed(1)}s anyway...`);
            await this._sleep(minWait);
        }
        
        // STEP 5: Final network check - ensure beacon requests completed
        try {
            await this.page.waitForLoadState('networkidle', { timeout: 5000 });
        } catch (e) {
            // OK if this times out
        }
        
        const totalWait = Date.now() - startTime;
        this.replay.logGA4Detection(gaDetected, { ...gaDetails, waitTimeMs: totalWait });
        this.logger.info(`✅ Page ready after ${(totalWait/1000).toFixed(1)}s`);
    }

    /**
     * Verify that SimilarWeb extension is working
     * Checks for extension markers in the page
     */
    async _verifyExtension() {
        try {
            // Wait a bit for extension to inject content script
            await this._sleep(500);
            
            // Check for SimilarWeb extension markers
            const extensionStatus = await this.page.evaluate(() => {
                return {
                    // Content script markers
                    injected: window.__similarweb_injected === true,
                    swExtension: window.__sw_extension === true,
                    swVersion: window.__sw_version || null,
                    dataAttribute: document.documentElement.getAttribute('data-similarweb') === 'true',
                    
                    // Check for any extension-injected elements
                    hasPixel: !!document.querySelector('img[src*="similarweb.com"]'),
                    
                    // Check console for extension logs
                    hasMarkers: !!(window.__similarweb_injected || window.__sw_extension)
                };
            });
            
            if (extensionStatus.hasMarkers) {
                this.logger.info(`🧩 ✅ Extension WORKING!`);
                this.logger.info(`   ├─ Injected: ${extensionStatus.injected}`);
                this.logger.info(`   ├─ SW Extension: ${extensionStatus.swExtension}`);
                this.logger.info(`   ├─ Version: ${extensionStatus.swVersion || 'N/A'}`);
                this.logger.info(`   ├─ Data Attribute: ${extensionStatus.dataAttribute}`);
                this.logger.info(`   └─ Tracking Pixel: ${extensionStatus.hasPixel}`);
            } else {
                this.logger.warn(`🧩 ⚠️ Extension NOT DETECTED on page`);
                this.logger.warn(`   This could mean:`);
                this.logger.warn(`   1. Extension failed to load`);
                this.logger.warn(`   2. Content script blocked by page`);
                this.logger.warn(`   3. Wrong extension path`);
            }
            
        } catch (error) {
            this.logger.debug(`Extension verification error: ${error.message}`);
        }
    }

    /**
     * Simulate realistic user behavior on page
     * More human-like with proper timing
     */
    async _simulateUserBehavior() {
        try {
            // Initial pause - user looks at page (1-2 seconds)
            await this._sleep(1000 + Math.random() * 1000);
            
            // Mouse movement - user moves cursor
            await this._simulateMouseMovement();
            
            // Reading pause (0.5-1.5 seconds)
            await this._sleep(500 + Math.random() * 1000);
            
            // Scroll down - triggers GA4 scroll tracking
            await this._simulateScrolling();
            
            // Final pause - user finishes reading (0.5-1 second)
            await this._sleep(500 + Math.random() * 500);
            
        } catch (error) {
            this.logger.debug(`User behavior simulation error: ${error.message}`);
        }
    }

    /**
     * Simulate scrolling - GA4 tracks scroll depth
     * More realistic scrolling pattern
     */
    async _simulateScrolling() {
        try {
            // Scroll 1: Initial scroll (like reading below fold)
            const scroll1 = 300 + Math.floor(Math.random() * 400);
            await this.page.evaluate((amount) => {
                window.scrollBy({ top: amount, behavior: 'smooth' });
            }, scroll1);
            await this._sleep(800 + Math.random() * 600);
            
            // Scroll 2: Continue scrolling
            const scroll2 = 500 + Math.floor(Math.random() * 700);
            await this.page.evaluate((amount) => {
                window.scrollBy({ top: amount, behavior: 'smooth' });
            }, scroll2);
            await this._sleep(600 + Math.random() * 500);
            
            // Scroll 3: Maybe scroll more or back up
            if (Math.random() > 0.3) {
                const scroll3 = Math.random() > 0.5 
                    ? (400 + Math.floor(Math.random() * 600))  // More down
                    : -(200 + Math.floor(Math.random() * 300)); // Back up
                await this.page.evaluate((amount) => {
                    window.scrollBy({ top: amount, behavior: 'smooth' });
                }, scroll3);
                await this._sleep(400 + Math.random() * 400);
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
    async _launchBrowser() {
        const isHeadless = this.playMode === Constants.PLAY_MODES.FASTEST ||
                          this.playMode === Constants.PLAY_MODES.FAST;

        const launchOptions = {
            headless: isHeadless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                `--window-size=${this.screenSize.width},${this.screenSize.height}`
            ]
        };

        // Use bundled Chromium in packaged mode
        const chromiumPath = this._getChromiumPath();
        if (chromiumPath) {
            launchOptions.executablePath = chromiumPath;
        }

        // FIXED: Add extension if enabled and path exists
        // Note: Extensions only work in headed mode (non-headless)
        if (this.extensionEnabled && this.extensionPath && !isHeadless) {
            if (fs.existsSync(this.extensionPath)) {
                launchOptions.args.push(`--disable-extensions-except=${this.extensionPath}`);
                launchOptions.args.push(`--load-extension=${this.extensionPath}`);
                this.logger.info(`Loading extension from: ${this.extensionPath}`);
                this.extensionLoaded = true;
            } else {
                this.logger.warn(`Extension path not found: ${this.extensionPath}`);
                this.extensionLoaded = false;
            }
        } else if (this.extensionEnabled && isHeadless) {
            this.logger.warn(`Extensions require headed mode (Slow or Slower). Current mode: ${this.playMode}`);
            this.extensionLoaded = false;
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
    async _createContext() {
        const contextOptions = {
            viewport: {
                width: this.screenSize.width,
                height: this.screenSize.height
            },
            userAgent: this.userAgent,
            // FIXED: Use location from config
            locale: this.locationData.locale,
            timezoneId: this.locationData.timezone,
            geolocation: { 
                latitude: this.locationData.latitude, 
                longitude: this.locationData.longitude 
            },
            permissions: ['geolocation'],
            javaScriptEnabled: true,
            hasTouch: this.userAgent.includes('Mobile'),
            isMobile: this.userAgent.includes('Mobile'),
            deviceScaleFactor: this.userAgent.includes('Mobile') ? 2 : 1
        };

        if (this.isReferer && this.referer) {
            contextOptions.extraHTTPHeaders = {
                'Referer': this.referer
            };
        }
        
        // IP Rotation - Generate Indian IP and add X-Forwarded-For header
        // ⚠️ WARNING: Does NOT work with Cloudflare - they use real connecting IP
        if (this.ipRotation) {
            const ipResult = generateIndianIP(this.location);
            if (ipResult) {
                this.currentIP = ipResult.ip;
                this.logger.info(`🌐 IP Rotation: ${this.currentIP} (${ipResult.isp})`);
                this.logger.warn(`⚠️ IP spoofing only works on non-Cloudflare sites`);
                
                // Only X-Forwarded-For - some servers trust this header
                contextOptions.extraHTTPHeaders = {
                    ...(contextOptions.extraHTTPHeaders || {}),
                    'X-Forwarded-For': this.currentIP,
                };
            }
        }
        
        // Proxy: NO context-level proxy — /collect requests handled in route handler
        // This means page loads DIRECT, only tiny /collect beacons go through proxy

        this.context = await this.browser.newContext(contextOptions);

        // Setup route handler for ad blocking, fast mode, and smart proxy
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
                    // /collect → proxy via Node.js http (no CONNECT tunnel)
                    self.proxyRouter.stats.totalRequests++;
                    self.proxyRouter.stats.proxiedRequests++;
                    try {
                        const response = await self.proxyRouter.makeProxiedRequest(request);
                        await route.fulfill({
                            status: response.status,
                            headers: response.headers,
                            body: response.body,
                        });
                        self.replay.logRequest(url, true, true);
                        self._emitProxyStats(url, true);
                        self._emitGA4Event(url, true);
                    } catch (e) {
                        self.replay.logError('proxy_collect', e.message);
                        self.logger.debug(`/collect proxy failed, fallback direct: ${e.message}`);
                        self._emitProxyStats(url, false);
                        self._emitGA4Event(url, false);
                        await route.continue();
                    }
                    return;
                }
                // Non-collect (including GA scripts) → DIRECT
                self.proxyRouter.stats.totalRequests++;
                self.proxyRouter.stats.directRequests++;
                if (isGAScript(url)) self.proxyRouter.stats.scriptsLoadedDirect++;
                if (isGAScript(url)) self.replay.logRequest(url, true, false);
                await route.continue();
                return;
            }

            // 3b. No proxy but still track GA /collect requests for replay + monitor
            if (isGACollectRequest(url)) {
                self.replay.logRequest(url, true, false);
                self._emitGA4Event(url, false);
            }
            
            // 4. No proxy — just continue
            await route.continue();
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
     * Save session replay JSON to data/replays/
     */
    _saveReplay() {
        try {
            if (!this.replay) return;
            fs.mkdirSync(REPLAYS_DIR, { recursive: true });
            const ts = Date.now();
            const filename = `replay_${this.threadId}_${ts}.json`;
            const filepath = path.join(REPLAYS_DIR, filename);
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
            if (this.context) await this.context.close().catch(() => {});
            if (this.browser) await this.browser.close().catch(() => {});
            this.logger.debug('Cleanup completed');
        } catch (error) {
            this.logger.debug(`Cleanup error: ${error.message}`);
        }
    }

    /**
     * Force close browser immediately - called by stop()
     */
    async forceClose() {
        this.logger.info(`🛑 Force closing browser...`);
        try {
            // Kill browser process immediately
            if (this.browser) {
                await this.browser.close().catch(() => {});
                this.browser = null;
            }
            if (this.context) {
                this.context = null;
            }
            if (this.page) {
                this.page = null;
            }
        } catch (error) {
            // Ignore errors during force close
        }
    }
}

module.exports = AutomaticVisitor;
