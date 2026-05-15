/**
 * Manual Visitor - Handles custom command-based navigation
 * Now at feature parity with AutomaticVisitor for:
 *   - Session replay collection
 *   - Returning users (cookie injection + previous URL visit + /collect patching)
 *   - Fast mode resource blocking
 *   - IP rotation (X-Forwarded-For)
 *   - Proxy routing (/collect only, page loads direct)
 *   - avgSessionDuration fallback wait
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { getLogger, getCampaignLogDir } = require('../helpers/logger');
const Constants = require('../helpers/constants');
const { ProxyRouter, isGACollectRequest, isGAScript, parseProxyString } = require('../helpers/proxyRouter');
const { generateIndianIP } = require('../helpers/indianIP');
const { SessionReplay } = require('../helpers/sessionReplay');
const { patchCollectUrlForReturning } = require('../helpers/collectPatch');

class ManualVisitor {
    constructor(config) {
        this.url = config.url;
        this.referer = config.referer;
        this.isReferer = config.isReferer;
        // visitReferer: navigate to referer page first, then redirect to campaign URL.
        // Defaults to isReferer for backward compat when caller didn't set it.
        this.visitReferer = config.visitReferer !== undefined ? config.visitReferer : config.isReferer;
        this.userAgent = config.userAgent;
        this.threadId = config.threadId;
        this.screenSize = config.screenSize;
        this.playMode = config.playMode;
        this.adsBlock = config.adsBlock;
        this.commands = config.commands;

        // Location setting - FIXED: Now functional
        this.location = config.location || 'India';
        this.locationData = Constants.getLocationCoords(this.location);

        // Extension settings
        this.extensionEnabled = config.extensionEnabled || false;
        this.extensionPath = config.extensionPath || '';

        // Returning-user features
        this.isOldUser = !!config.isOldUser;
        this.savedCookies = config.savedCookies || null;
        this.previousURL = config.previousURL || '';
        this.useBaseUrlForOldUser = !!config.useBaseUrlForOldUser;

        // Proxy settings — only /collect endpoints proxied (matches AutomaticVisitor)
        this.proxyEnabled = !!config.proxyEnabled;
        this.proxyUrl = config.proxyUrl || '';
        this.proxyConfig = this.proxyEnabled ? parseProxyString(this.proxyUrl) : null;
        this.proxyRouter = null;

        // IP rotation
        this.ipRotation = !!config.ipRotation;
        this.currentIP = null;

        // Fast Mode resource blocking
        this.fastMode = !!config.fastMode;
        this.blockImages = !!config.blockImages;
        this.blockMedia = !!config.blockMedia;
        this.blockFonts = !!config.blockFonts;
        this.blockStyles = !!config.blockStyles;
        this.blockScripts = !!config.blockScripts;

        // Misc
        this.restrictToPrimaryDomain = !!config.restrictToPrimaryDomain;
        this.avgSessionDuration = config.avgSessionDuration || 0;
        this.primaryDomain = this._extractDomain(this.url);

        this.logger = getLogger(this.threadId);
        this.browser = null;
        this.context = null;
        this.page = null;
        this.replay = null;
        this._extractedCookies = null;
    }

    /**
     * Execute the manual visit
     */
    async execute() {
        const startTime = Date.now();

        // Initialize session replay (parity with AutomaticVisitor)
        this.replay = new SessionReplay(this.threadId, { maxEvents: 200 });
        this.replay.setSessionInfo({
            userAgent: this.userAgent,
            screenSize: this.screenSize,
            location: this.location,
            playMode: this.playMode,
            mode: 'manual',
            proxyMode: this.proxyEnabled ? 'collect-only' : 'none',
            ipRotation: this.ipRotation,
            spoofedIP: this.currentIP,
            isOldUser: this.isOldUser,
        });
        this.replay._addEvent('visit_start', {
            url: this.url,
            mode: 'manual',
            isOldUser: this.isOldUser,
        });

        this.logger.info(`Starting manual visit to: ${this.url}`);
        this.logger.info(`Location: ${this.location} (${this.locationData.latitude}, ${this.locationData.longitude})`);
        if (this.isOldUser) {
            this.logger.info(`Returning User: true${(this.previousURL || this.useBaseUrlForOldUser) ? ' (will visit previous URL first)' : ' (no previous URL configured)'}`);
        }
        if (this.proxyEnabled) {
            this.logger.info(`Proxy: ${this.proxyConfig?.host}:${this.proxyConfig?.port} (only /collect proxied)`);
        }
        if (this.ipRotation) {
            this.logger.info(`IP Rotation: enabled`);
        }
        if (this.fastMode) {
            const blocks = [
                this.blockImages && 'images', this.blockMedia && 'media',
                this.blockFonts && 'fonts', this.blockStyles && 'styles',
                this.blockScripts && 'scripts',
            ].filter(Boolean).join(', ');
            this.logger.info(`Fast Mode: blocking ${blocks || 'nothing'}`);
        }

        try {
            await this._launchBrowser();
            await this._createContext();

            // Inject saved GA cookies for returning users BEFORE any navigation
            if (this.savedCookies && this.savedCookies.length > 0 && this.context) {
                await this.context.addCookies(this.savedCookies);
                this.logger.info(`👤 Injected ${this.savedCookies.length} GA cookies for returning user`);
            }

            // Returning users: visit previous URL first so GA4 sees a prior session
            if (this.isOldUser && (this.previousURL || this.useBaseUrlForOldUser)) {
                await this._visitPreviousUrl();
            }

            await this._visitPage();
            await this._executeCommands();

            // avgSessionDuration fallback wait — if commands finished fast, hold the
            // page open so GA4 records a session of roughly the configured duration.
            if (this.avgSessionDuration > 0) {
                const targetMs = this.avgSessionDuration * 1000;
                const elapsedMs = Date.now() - startTime;
                const remainingMs = targetMs - elapsedMs;
                if (remainingMs > 1000) {
                    this.logger.info(`Holding session open ${(remainingMs / 1000).toFixed(1)}s to reach avgSessionDuration ${this.avgSessionDuration}s`);
                    await new Promise(resolve => setTimeout(resolve, remainingMs));
                }
            }

            const totalTime = (Date.now() - startTime) / 1000;
            this.logger.info(`✅ Manual visit completed in ${totalTime.toFixed(2)}s`);
            this.replay._addEvent('visit_end', {
                totalDurationMs: Date.now() - startTime,
                ga4EventsFired: this.replay.stats.ga4EventsFired,
            });

        } catch (error) {
            this.replay.logError('execute', error.message);
            this.logger.error(`Manual visit failed: ${error.message}`);
            throw error;
        } finally {
            // Extract cookies BEFORE closing context (cookies() returns empty after close)
            await this._extractCookiesBeforeClose();
            this._saveReplay();
            await this._cleanup();
        }
    }

    /**
     * Visit previous URL for returning users — creates a GA4 session cookie
     * before the campaign URL so the campaign visit counts as "returning".
     * Ported from AutomaticVisitor._visitPreviousUrl with manual-mode tweaks.
     */
    async _visitPreviousUrl() {
        let prevUrl = this.previousURL;
        let urlSource = 'manual';

        if (!prevUrl && this.useBaseUrlForOldUser) {
            try {
                const u = new URL(this.url);
                prevUrl = `${u.protocol}//${u.host}${u.pathname}`;
                urlSource = 'auto-extracted';
            } catch {
                this.logger.warn(`Cannot extract base URL from: ${this.url}`);
                return;
            }
        }

        if (!prevUrl) return;

        this.logger.info(`👤 RETURNING USER - Visiting previous URL first (${urlSource}): ${prevUrl}`);
        this.replay.logPreviousURLVisit?.(prevUrl, urlSource);

        try {
            await this.page.goto(prevUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            // Brief pause so GA4 has time to set cookies
            await this._randomDelay(2000, 3500);
            this.logger.info(`✅ Previous URL visited`);
        } catch (error) {
            this.replay.logError?.('previous_url', error.message);
            this.logger.warn(`Failed to visit previous URL: ${error.message}`);
        }
    }

    /**
     * Launch browser
     * FIXED: Added extension support
     */
    async _launchBrowser() {
        const isHeadless = this.playMode === Constants.PLAY_MODES.FASTEST || 
                          this.playMode === Constants.PLAY_MODES.FAST;

        const launchOptions = {
            headless: isHeadless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-client-side-phishing-detection',
                '--disable-features=SafeBrowsing',
                '--no-first-run'
            ]
        };
        
        // Add extension if enabled and path exists
        if (this.extensionEnabled && this.extensionPath && !isHeadless) {
            if (fs.existsSync(this.extensionPath)) {
                launchOptions.args.push(`--disable-extensions-except=${this.extensionPath}`);
                launchOptions.args.push(`--load-extension=${this.extensionPath}`);
                this.logger.info(`Loading extension from: ${this.extensionPath}`);
            } else {
                this.logger.warn(`Extension path not found: ${this.extensionPath}`);
            }
        }

        this.browser = await chromium.launch(launchOptions);
    }

    /**
     * Create browser context
     */
    async _createContext() {
        const contextOptions = {
            viewport: {
                width: this.screenSize.width,
                height: this.screenSize.height
            },
            userAgent: this.userAgent,
            locale: this.locationData.locale,
            timezoneId: this.locationData.timezone,
            geolocation: {
                latitude: this.locationData.latitude,
                longitude: this.locationData.longitude
            },
            permissions: ['geolocation']
        };

        if (this.isReferer && this.referer) {
            contextOptions.extraHTTPHeaders = {
                'Referer': this.referer
            };
        }

        // IP Rotation - generate Indian IP and add X-Forwarded-For
        // (Same caveat as automatic: does NOT work on Cloudflare-fronted sites)
        if (this.ipRotation) {
            const ipResult = generateIndianIP(this.location);
            if (ipResult) {
                this.currentIP = ipResult.ip;
                this.logger.info(`🌐 IP Rotation: ${this.currentIP} (${ipResult.isp})`);
                contextOptions.extraHTTPHeaders = {
                    ...(contextOptions.extraHTTPHeaders || {}),
                    'X-Forwarded-For': this.currentIP,
                };
            }
        }

        // Proxy: page loads go DIRECT, only /collect routed via proxy (route handler)
        this.context = await this.browser.newContext(contextOptions);

        // Unified route handler: ad-block + fast-mode + /collect proxy + returning-user patch
        await this._setupMergedRouteHandler();

        // Stealth
        await this._addStealthScripts();

        this.page = await this.context.newPage();
    }

    /**
     * Merged route handler — ports the automatic-mode logic so manual mode
     * has parity for ad blocking, fast-mode resource blocking, /collect-only
     * proxy routing, and returning-user /collect parameter patching.
     */
    async _setupMergedRouteHandler() {
        if (this.proxyEnabled && this.proxyConfig) {
            this.proxyRouter = new ProxyRouter({
                proxyUrl: this.proxyUrl,
                enabled: true,
                threadId: this.threadId
            });
        }

        const self = this;
        const blockedAdPatterns = [
            'googlesyndication.com', 'adservice.google', 'adsense',
            'facebook.com/tr', 'connect.facebook', 'amazon-adsystem',
            'adnxs.com', 'criteo.com', 'outbrain.com', 'taboola.com',
            'doubleclick.net',
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

            // 2. Fast Mode resource blocking (never block GA collect/scripts)
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

            // 3. Proxy: only /collect beacons through proxy, everything else direct
            if (self.proxyEnabled && self.proxyRouter) {
                if (isGACollectRequest(url)) {
                    let collectUrl = url;
                    if (self.isOldUser) {
                        const patched = patchCollectUrlForReturning(url);
                        if (patched) collectUrl = patched;
                    }
                    self.proxyRouter.stats.totalRequests++;
                    self.proxyRouter.stats.proxiedRequests++;
                    try {
                        const response = await self.proxyRouter.makeProxiedRequest(request, collectUrl);
                        await route.fulfill({
                            status: response.status,
                            headers: response.headers,
                            body: response.body,
                        });
                        self.replay?.logRequest?.(collectUrl, true, true);
                    } catch (e) {
                        self.replay?.logError?.('proxy_collect', e.message);
                        await route.continue();
                    }
                    return;
                }
                self.proxyRouter.stats.totalRequests++;
                self.proxyRouter.stats.directRequests++;
                if (isGAScript(url)) {
                    self.proxyRouter.stats.scriptsLoadedDirect++;
                    self.replay?.logRequest?.(url, true, false);
                }
                await route.continue();
                return;
            }

            // 4. No proxy — still track /collect for replay + apply returning-user patch
            if (isGACollectRequest(url)) {
                if (self.isOldUser) {
                    const patched = patchCollectUrlForReturning(url);
                    if (patched) {
                        self.replay?.logRequest?.(patched, true, false);
                        await route.continue({ url: patched });
                        return;
                    }
                }
                self.replay?.logRequest?.(url, true, false);
            }

            await route.continue();
        });
    }

    /**
     * Visit the initial page.
     * If visitReferer is true (e.g. Referral mode), navigate to the referer
     * page first, then redirect to the campaign URL so document.referrer is set.
     */
    async _visitPage() {
        if (this.visitReferer && this.referer) {
            try {
                await this.page.goto(this.referer, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });
                await this._randomDelay(800, 1500);
                await this.page.evaluate((url) => {
                    window.location.href = url;
                }, this.url);
                await this.page.waitForLoadState('domcontentloaded', { timeout: 60000 });
            } catch (e) {
                this.logger.warn(`Referer navigation failed (${e.message}) — falling back to direct visit`);
                await this.page.goto(this.url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000
                });
            }
        } else {
            await this.page.goto(this.url, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
        }
        await this._randomDelay(1000, 2000);
    }

    /**
     * Parse and execute user commands
     * Command format: TYPE:SELECTOR:VALUE (one command per line)
     * Examples:
     *   click:cssSelector:#submit-btn
     *   click:xPath://button[@id='submit']
     *   wait:5000
     *   scroll:500
     *   type:id:email:test@example.com
     *   navigate:https://example.com
     *   frame:0
     *   random:5
     */
    async _executeCommands() {
        if (!this.commands || this.commands.trim() === '') {
            this.logger.info('No commands to execute');
            return;
        }

        const commandLines = this.commands.split('\n').filter(line => line.trim());
        
        for (const line of commandLines) {
            const parts = line.trim().split(':');
            const commandType = parts[0]?.toLowerCase();

            this.logger.info(`Executing command: ${line}`);

            try {
                switch (commandType) {
                    case 'click':
                        await this._handleClick(parts);
                        break;

                    case 'type':
                        await this._handleType(parts);
                        break;

                    case 'wait':
                        await this._handleWait(parts);
                        break;

                    case 'scroll':
                        await this._handleScroll(parts);
                        break;

                    case 'navigate':
                        await this._handleNavigate(parts);
                        break;

                    case 'frame':
                        await this._handleFrame(parts);
                        break;

                    case 'random':
                        await this._handleRandomClick(parts);
                        break;

                    case 'hover':
                        await this._handleHover(parts);
                        break;

                    default:
                        this.logger.warn(`Unknown command: ${commandType}`);
                }

                // Small delay between commands
                await this._randomDelay(300, 800);

            } catch (error) {
                this.logger.error(`Command failed: ${line} - ${error.message}`);
            }
        }
    }

    /**
     * Handle click command
     * Format: click:selectorType:selector
     */
    async _handleClick(parts) {
        const selectorType = parts[1];
        const selector = parts.slice(2).join(':'); // Handle colons in selector

        const element = await this._findElement(selectorType, selector);
        if (element) {
            await element.click();
            await this._randomDelay(500, 1000);
        }
    }

    /**
     * Handle type command
     * Format: type:selectorType:selector:text
     */
    async _handleType(parts) {
        const selectorType = parts[1];
        const selector = parts[2];
        const text = parts.slice(3).join(':');

        const element = await this._findElement(selectorType, selector);
        if (element) {
            await element.fill(''); // Clear first
            await element.type(text, { delay: 50 + Math.random() * 100 });
        }
    }

    /**
     * Handle wait command
     * Format: wait:milliseconds
     */
    async _handleWait(parts) {
        const ms = parseInt(parts[1]) || 1000;
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Handle scroll command
     * Format: scroll:pixels
     */
    async _handleScroll(parts) {
        const pixels = parseInt(parts[1]) || 300;
        await this.page.evaluate((amount) => {
            window.scrollBy({ top: amount, behavior: 'smooth' });
        }, pixels);
        await this._randomDelay(300, 600);
    }

    /**
     * Handle navigate command
     * Format: navigate:url
     */
    async _handleNavigate(parts) {
        const url = parts.slice(1).join(':');
        if (this.restrictToPrimaryDomain && this.primaryDomain) {
            const navDomain = this._extractDomain(url);
            if (navDomain && navDomain !== this.primaryDomain) {
                this.logger.warn(`navigate blocked by restrictToPrimaryDomain: ${navDomain} ≠ ${this.primaryDomain}`);
                return;
            }
        }
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this._randomDelay(1000, 2000);
    }

    /**
     * Handle frame command
     * Format: frame:indexOrName
     */
    async _handleFrame(parts) {
        const frameIdentifier = parts[1];
        
        if (!isNaN(frameIdentifier)) {
            // Frame by index
            const frames = this.page.frames();
            const frameIndex = parseInt(frameIdentifier);
            if (frames[frameIndex]) {
                this.page = frames[frameIndex];
            }
        } else {
            // Frame by name
            const frame = this.page.frame({ name: frameIdentifier });
            if (frame) {
                this.page = frame;
            }
        }
    }

    /**
     * Handle random click on internal links
     * Format: random:count
     */
    async _handleRandomClick(parts) {
        const count = parseInt(parts[1]) || 1;

        for (let i = 0; i < count; i++) {
            const links = await this.page.$$('a[href]');
            if (links.length > 0) {
                const randomLink = links[Math.floor(Math.random() * links.length)];
                try {
                    await randomLink.click();
                    await this._randomDelay(2000, 4000);
                } catch {
                    // Link might have navigated away
                }
            }
        }
    }

    /**
     * Handle hover command
     * Format: hover:selectorType:selector
     */
    async _handleHover(parts) {
        const selectorType = parts[1];
        const selector = parts.slice(2).join(':');

        const element = await this._findElement(selectorType, selector);
        if (element) {
            await element.hover();
            await this._randomDelay(500, 1000);
        }
    }

    /**
     * Find element based on selector type
     */
    async _findElement(selectorType, selector) {
        try {
            switch (selectorType?.toLowerCase()) {
                case 'id':
                    return await this.page.$(`#${selector}`);

                case 'classname':
                    return await this.page.$(`.${selector}`);

                case 'name':
                    return await this.page.$(`[name="${selector}"]`);

                case 'tagname':
                    return await this.page.$(selector);

                case 'cssselector':
                    return await this.page.$(selector);

                case 'xpath':
                    return await this.page.$(`xpath=${selector}`);

                case 'linktext':
                    return await this.page.$(`text="${selector}"`);

                case 'src':
                    return await this.page.$(`[src="${selector}"]`);

                default:
                    // Try as CSS selector
                    return await this.page.$(selector);
            }
        } catch (error) {
            this.logger.warn(`Could not find element: ${selectorType}:${selector}`);
            return null;
        }
    }

    /**
     * Add stealth scripts (parity with AutomaticVisitor — adds language injection)
     */
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
     * Extract GA cookies BEFORE context close — context.cookies() returns
     * empty after close, so this must run inside the execute() finally before _cleanup().
     */
    async _extractCookiesBeforeClose() {
        if (!this.context) {
            this._extractedCookies = [];
            return;
        }
        try {
            const all = await this.context.cookies();
            // Same filter as automatic: only _ga (client ID). Skip _ga_<MEAS_ID>
            // session cookie or _gid — re-injecting them would continue the old
            // session instead of starting a fresh returning-user session.
            this._extractedCookies = all.filter(c => c.name === '_ga');
        } catch (e) {
            this.logger.debug(`Cookie extract failed: ${e.message}`);
            this._extractedCookies = [];
        }
    }

    /**
     * Get GA cookies extracted from the visit (called by visitLogic to seed pool).
     */
    getCookies() {
        return this._extractedCookies || [];
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
            const filepath = path.join(replaysDir, `replay_${this.threadId}_${Date.now()}.json`);
            fs.writeFileSync(filepath, JSON.stringify(this.replay.getSummary(), null, 2));
        } catch (e) {
            this.logger.debug(`Failed to save replay: ${e.message}`);
        }
    }

    /**
     * Extract domain from URL (used for restrictToPrimaryDomain checks)
     */
    _extractDomain(url) {
        try {
            return new URL(url).hostname.replace(/^www\./, '');
        } catch {
            return '';
        }
    }

    /**
     * Random delay helper
     */
    async _randomDelay(min, max) {
        const delay = Math.floor(Math.random() * (max - min)) + min;
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    /**
     * Cleanup
     */
    async _cleanup() {
        try {
            if (this.page) await this.page.close().catch(() => {});
            if (this.context) await this.context.close().catch(() => {});
            if (this.browser) await this.browser.close().catch(() => {});
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

module.exports = ManualVisitor;
