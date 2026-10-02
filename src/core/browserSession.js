/**
 * BrowserSession — the browser lifecycle both visitors share.
 *
 * AutomaticVisitor and ManualVisitor had 21 of their ~35 methods copy-pasted,
 * and the copies had drifted: manual mode never resolved the bundled Chromium
 * (so a packaged build could not launch it), stripped "www." with an unanchored
 * replace, and was missing the live GA4 and proxy monitors entirely. Everything
 * that is not "how do I decide where to navigate next" lives here now, so a fix
 * lands once instead of twice.
 *
 * Subclasses own the navigation strategy — a page sequence for automatic mode,
 * user commands for manual mode — and anything reading `this.visit`, which only
 * automatic mode has.
 *
 * Hook a subclass may override:
 *   _settleAfterPreviousUrl()  — how to wait after the returning-user page
 */

const { chromium } = require('playwright');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { getLogger, getCampaignLogDir } = require('../helpers/logger');
const Constants = require('../helpers/constants');
const {
    ProxyRouter, isGACollectRequest, isGAScript, parseProxyString,
    parseCustomProxyPatterns, matchesCustomProxyPattern,
} = require('../helpers/proxyRouter');
const { generateIPForLocation } = require('../helpers/ipRotation');
const {
    buildUserAgentMetadata, buildClientHintHeaders, applyUserAgentOverride, isChromiumUA,
} = require('../helpers/clientHints');
const { patchCollectUrlForReturning } = require('../helpers/collectPatch');
const { acquireProfile } = require('../helpers/profilePool');
const { grantExtensionConsent, hasConsent } = require('../helpers/extensionConsent');
const { getResolvedBrowser } = require('../helpers/browserResolver');

// ===== Debug All Tracking Pixels Toggle =====
// Module-level so the IPC handler can flip it for every in-flight visitor.
let debugAllTracking = false;

const TRACKING_PATTERNS = [
    'doubleclick.net', 'googleadservices.com', 'googlesyndication.com',
    'facebook.com/tr', 'connect.facebook.net',
    'omtrdc.net', '2o7.net', 'demdex.net',             // Adobe
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

class BrowserSession {
    constructor(config) {
        // Automatic mode calls the target campaignUrl, manual mode calls it
        // url; the base works off targetUrl so shared code needs no branch.
        this.targetUrl = config.campaignUrl || config.url || '';
        this.threadId = config.threadId;
        this.logger = getLogger(this.threadId);

        this.userAgent = config.userAgent;
        // The device detail the UA no longer carries (Chrome's UA reduction):
        // real platform version and model, for the client hints.
        this.userAgentProfile = config.userAgentProfile || null;
        this.screenSize = config.screenSize;
        this.playMode = config.playMode;
        this.adsBlock = config.adsBlock || false;

        this.referer = config.referer;
        this.isReferer = config.isReferer;
        this.visitReferer = config.visitReferer !== undefined ? config.visitReferer : config.isReferer;

        this.isOldUser = config.isOldUser || false;
        this.savedCookies = config.savedCookies || null;
        this.previousURL = config.previousURL;
        this.useBaseUrlForOldUser = config.useBaseUrlForOldUser || false;
        this.restrictToPrimaryDomain = config.restrictToPrimaryDomain !== false;

        this.location = config.location || 'India';
        this.locationData = Constants.getLocationCoords(this.location);

        // Proxy
        this.proxyEnabled = config.proxyEnabled || false;
        // Proxying /collect is what spoofs GA4's reported location, but it is
        // also the bulk of proxy bandwidth. Off → beacons go direct (the real
        // IP decides GA4 location) and only custom patterns use the proxy.
        this.proxyCollectEnabled = config.proxyCollectEnabled !== false;
        this.proxyUrl = config.proxyUrl || '';
        this.proxyConfig = this.proxyEnabled ? parseProxyString(this.proxyUrl) : null;
        this.proxyRouter = null;

        this.customProxyEnabled = config.customProxyEnabled || false;
        this.customProxyPatterns = this.customProxyEnabled
            ? parseCustomProxyPatterns(config.customProxyPatterns || '')
            : [];

        // Extension
        this.extensionEnabled = config.extensionEnabled || false;
        this.extensionPath = config.extensionPath || '';
        this.extensionLoaded = false;
        this.extensionVerified = null;        // null = never checked
        // 'granted' | 'already-granted' | 'failed' | null — the extension reports
        // nothing without it, so the report needs to show it.
        this.extensionConsent = null;
        this._grantingConsent = false;
        this.extensionProfilePool = config.extensionProfilePool || 0;
        this.extensionProfileId = null;

        // IP rotation
        this.ipRotation = config.ipRotation || false;
        this.currentIP = null;
        this.currentIPInfo = null;

        // Fast mode resource blocking
        this.fastMode = config.fastMode || false;
        this.blockImages = config.blockImages || false;
        this.blockMedia = config.blockMedia || false;
        this.blockFonts = config.blockFonts || false;
        this.blockStyles = config.blockStyles || false;
        this.blockScripts = config.blockScripts || false;

        // Live monitor callbacks
        this.onProxyStats = config.onProxyStats || null;
        this.onGA4Event = config.onGA4Event || null;

        // Browser handles
        this.browser = null;
        this.context = null;
        this.page = null;
        this.replay = null;
        this._tempUserDataDir = null;
        this._profileLease = null;
        this._usePersistentContext = false;
        this._downloadLanding = null;
        this._onFileLanding = null;
        // Resolved once per campaign, before any browser is involved: when the
        // landing URL is a file, interception hides it completely and goto just
        // hangs, so the visit must not attempt the navigation at all.
        this.landingProbe = config.landingProbe || null;
        this._extractedCookies = [];

        this.primaryDomain = this._extractDomain(this.targetUrl);
        this.landedUrl = null;
    }

    /**
     * Visit the returning-user page first so GA4 has a prior session to match.
     * Shared by both modes; only the settle differs, hence the hook.
     */
    async _visitPreviousUrl() {
        let prevUrl = this.previousURL;
        let urlSource = 'manual';

        if (!prevUrl && this.useBaseUrlForOldUser) {
            try {
                const u = new URL(this.targetUrl);
                prevUrl = `${u.protocol}//${u.host}${u.pathname}`;
                urlSource = 'auto-extracted';
                this.logger.info(`🔗 Base URL extracted: ${prevUrl}`);
            } catch {
                this.logger.warn(`⚠️ Cannot extract base URL from: ${this.targetUrl}`);
                return;
            }
        }

        if (!prevUrl) {
            this.logger.info(`⚠️ Old user - No previous URL configured, skipping`);
            return;
        }

        this.logger.info(`👤 RETURNING USER - Visiting previous URL first (${urlSource}): ${prevUrl}`);
        if (this.replay) this.replay.logPreviousURLVisit(prevUrl, urlSource);

        try {
            await this.page.goto(prevUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await this._settleAfterPreviousUrl();
            this.logger.info(`✅ Previous URL visited, cookie created`);
        } catch (error) {
            if (this.replay) this.replay.logError('previous_url', error.message);
            this.logger.warn(`❌ Failed to visit previous URL: ${error.message}`);
        }
    }

    /**
     * Default settle after the returning-user page. AutomaticVisitor overrides
     * this to wait on a real GA4 beacon instead of a fixed pause.
     */
    async _settleAfterPreviousUrl() {
        await this._randomDelay(2000, 3500);
    }

    async _randomDelay(min, max) {
        const ms = Math.floor(Math.random() * (max - min + 1)) + min;
        await this._sleep(ms);
    }

    /**
     * How this visit should identify itself on requests the app makes outside
     * the browser — the proxied tracker hops and the landing probe.
     *
     * Those requests are what an ad platform's click log records. Sending a
     * placeholder there made every click read as Desktop / Mozilla no matter
     * what the visit's real user agent was.
     *
     * @returns {{userAgent: string, acceptLanguage: string, clientHints: Object}}
     */
    _buildRequestIdentity() {
        const metadata = this._uaMetadata || buildUserAgentMetadata(this.userAgent, this.userAgentProfile).metadata;
        return {
            userAgent: this.userAgent,
            acceptLanguage: this._buildAcceptLanguage(),
            clientHints: buildClientHintHeaders(metadata),
        };
    }

    /**
     * A weighted Accept-Language list for the campaign location, the way a real
     * browser sends it. Used for both the browser context and the Node-side
     * requests so the two cannot disagree.
     */
    _buildAcceptLanguage() {
        // Exactly what the browser context sends, so a tracker correlating the
        // click hop with the landing visit sees one value, not two. Playwright
        // derives this header from `locale` alone.
        return (this.locationData && this.locationData.locale) || 'en-US';
    }

    /**
     * Everything the report needs to know about this session, in one place so
     * the two modes cannot describe themselves differently.
     */
    _buildSessionInfo(extra = {}) {
        return {
            userAgent: this.userAgent,
            screenSize: this.screenSize,
            location: this.location,
            playMode: this.playMode,
            proxyMode: this.proxyEnabled
                ? (this.proxyCollectEnabled ? 'collect+custom' : 'custom-only')
                : 'none',
            proxyUrl: this.proxyUrl,
            ipRotation: this.ipRotation,
            spoofedIP: this.currentIP,
            isOldUser: this.isOldUser,
            extensionEnabled: this.extensionEnabled,
            extensionLoaded: this.extensionLoaded,
            extensionProfileId: this.extensionProfileId,
            extensionConsent: this.extensionConsent,
            ...extra,
        };
    }

    /**
     * Get bundled Chromium path when running as a packaged Electron app.
     * Returns undefined in dev mode so Playwright uses its own installed browser.
     */
    /**
     * Launch options for the browser binary the campaign resolved to.
     * Real Chrome when it is installed (genuine navigator.plugins, mimeTypes
     * and PDF viewer, which the bundled Chromium reports as 0/0/false), else
     * the bundled Chromium so a machine without Chrome still works.
     */
    _getBrowserBinaryOptions() {
        const resolved = getResolvedBrowser();
        if (resolved && resolved.channel) return { channel: resolved.channel };
        if (resolved && resolved.executablePath) return { executablePath: resolved.executablePath };
        const bundled = this._getChromiumPath();
        return bundled ? { executablePath: bundled } : {};
    }

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

        Object.assign(launchOptions, this._getBrowserBinaryOptions());

        this.browser = await chromium.launch(launchOptions);
        this.logger.debug('Browser launched');
    }
    /**
     * Create browser context with all settings
     * 1. Location now uses config values
     * 2. Merged route handler for proxy + ad blocking
     * 3. Proper proxy implementation using Playwright's built-in proxy
     */
    _buildContextOptions() {
        const isHeadless = this.playMode === Constants.PLAY_MODES.FASTEST ||
                          this.playMode === Constants.PLAY_MODES.FAST;
        const isMobileUA = this.userAgent.includes('Mobile');
        const { metadata: uaMetadata } = buildUserAgentMetadata(this.userAgent, this.userAgentProfile);
        this._uaMetadata = uaMetadata;
        const contextOptions = {
            userAgent: this.userAgent,
            // A landing URL that resolves to a file (PDF click-trackers do this)
            // would otherwise be downloaded in full — megabytes per visit, for a
            // page that can never fire a GA4 hit. Refusing the download makes
            // Chromium discard the body instead.
            acceptDownloads: false,
            locale: this.locationData.locale,
            timezoneId: this.locationData.timezone,
            geolocation: {
                latitude: this.locationData.latitude,
                longitude: this.locationData.longitude
            },
            permissions: ['geolocation'],
            javaScriptEnabled: true,
        };
        // Mobile emulation must be on in headed mode too: `isMobile` is what
        // flips sec-ch-ua-mobile to ?1, and GA4 reads that hint (uamb) rather
        // than the "Mobile" token in the UA string to pick a device category.
        // Without it every headed mobile session landed in GA4 as Desktop.
        if (isHeadless || isMobileUA) {
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

        // Client hints must ride along as real headers: route.continue() in the
        // merged route handler rebuilds request headers from Playwright's
        // network layer, which would otherwise re-expose Chromium's own brands.
        contextOptions.extraHTTPHeaders = buildClientHintHeaders(uaMetadata);
        // Playwright derives Accept-Language from `locale` as a bare tag
        // ("en-IN"). A real Chrome sends a weighted list, and the proxied
        // tracker hops send one too — a tracker comparing the click to the
        // landing visit would otherwise see two different values.
        // Accept-Language is deliberately NOT set here: Playwright's `locale`
        // option wins over extraHTTPHeaders for that header, and forcing a
        // weighted list through CDP corrupts navigator.languages (it ends up
        // containing the q-values, which a real browser never does). The
        // context's locale is the single source of truth, and the Node-side
        // requests mirror it — see _buildAcceptLanguage.


        if (this.isReferer && this.referer) {
            contextOptions.extraHTTPHeaders['Referer'] = this.referer;
        }

        if (this.ipRotation) {
            const ipResult = generateIPForLocation(this.location);
            if (!ipResult) {
                this.logger.warn(`IP Rotation: no IP ranges for location "${this.location}" — header skipped`);
            } else {
                this.currentIP = ipResult.ip;
                this.currentIPInfo = ipResult;
                this.logger.info(`🌐 IP Rotation: ${this.currentIP} (${ipResult.isp}, ${ipResult.location})`);
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
            //
            // The profile comes from the pool. With pooling off that is a fresh
            // throwaway directory (the old behaviour); with pooling on it is one
            // of N reusable profiles, so the extension's own storage survives
            // between visits and a panel can actually accumulate a device.
            this._profileLease = await acquireProfile({ poolSize: this.extensionProfilePool });
            this._tempUserDataDir = this._profileLease.dir;
            this.extensionProfileId = this._profileLease.id;
            const args = this._buildLaunchArgs();
            args.push(`--disable-extensions-except=${this.extensionPath}`);
            args.push(`--load-extension=${this.extensionPath}`);

            const persistentOptions = {
                ...contextOptions,
                headless: false,
                args,
            };
            Object.assign(persistentOptions, this._getBrowserBinaryOptions());

            this.context = await chromium.launchPersistentContext(this._tempUserDataDir, persistentOptions);
            this.browser = this.context.browser();
            this.logger.info(this._profileLease.pooled
                ? `Persistent context launched with extension (pooled profile ${this.extensionProfileId})`
                : `Persistent context launched with extension (throwaway profile)`);

            // A reused profile still holds the last visit's GA cookies, which
            // would make this visit read as returning. Returning visits get
            // their cookies injected from the jar instead, so clear either way.
            if (this._profileLease.pooled) {
                await this._resetGACookies();
            }

            // Auto-close the extension's own tabs (welcome/onboarding) as they
            // appear — except while consent is being granted, which happens on
            // the extension's options page. Closing that was part of why the
            // extension never reported anything.
            const isExtPage = (url) =>
                url.startsWith('chrome-extension://') ||
                url.includes('similarweb.com/corp/extension-welcome');
            this.context.on('page', async (page) => {
                try {
                    await page.waitForLoadState('commit').catch(() => {});
                    if (this._grantingConsent) return;
                    if (isExtPage(page.url())) {
                        await page.close().catch(() => {});
                    }
                } catch {}
            });

            // The extension reports nothing until consent is granted, and the
            // setting lives in the profile — so this runs once per pooled
            // profile and is skipped thereafter. Measured on v6.12.24: without
            // it, browsing produces zero SimilarWeb traffic.
            await this._grantExtensionConsent();
        } else {
            this.context = await this.browser.newContext(contextOptions);
        }

        await this._setupMergedRouteHandler();
        await this._addStealthScripts();
        await this._applyClientHints();
        this.page = await this.context.newPage();
        // The context 'page' listener also fires for this page, but the CDP
        // override has to land before the first navigation — so await it here.
        await this._applyHintsToPage(this.page);
        this._watchForDownloadLanding(this.page);

        // Close any extension pages that opened before the listener was set up
        for (const p of this.context.pages()) {
            if (p !== this.page) {
                const url = p.url();
                if (url.startsWith('chrome-extension://') || url.includes('similarweb.com/corp/extension-welcome')) {
                    await p.close().catch(() => {});
                }
            }
        }
        this.logger.debug('Context and page created');
    }
    /**
     * Visit the first/main campaign page
     * CRITICAL: Must wait for GA4 scripts to load and fire events
     */
    /**
     * A navigation that Chromium answers with a download never becomes a page:
     * goto rejects, nothing renders, and no gtag can fire. Record it so the
     * visit can end cleanly instead of being reported as a failure.
     */
    _watchForDownloadLanding(page) {
        page.on('download', (download) => {
            this._recordFileLanding({
                url: download.url(),
                filename: download.suggestedFilename(),
                via: 'download',
            });
            // acceptDownloads:false already discards the body; cancelling makes
            // it explicit and releases the download slot immediately.
            Promise.resolve(download.cancel()).catch(() => {});
        });

        // The download event alone is not a reliable signal. The two browsers
        // disagree about the same PDF: the bundled Chromium starts a download
        // (goto rejects with "Download is starting"), while real Chrome has a
        // built-in PDF viewer and simply renders it — goto resolves, no
        // download event fires, and the visit then waits out its whole
        // navigation timeout on a document that can never run gtag.
        //
        // What both agree on is the navigation response's content type, so
        // that is what decides.
        page.on('response', (response) => {
            try {
                const request = response.request();
                if (!request.isNavigationRequest()) return;
                if (response.frame() !== page.mainFrame()) return;
                const status = response.status();
                if (status >= 300 && status < 400) return;        // a redirect hop

                const contentType = (response.headers()['content-type'] || '').toLowerCase();
                if (!contentType || BrowserSession.isRenderableContentType(contentType)) return;

                const url = response.url();
                this._recordFileLanding({
                    url,
                    filename: url.split('/').pop().split('?')[0],
                    contentType: contentType.split(';')[0],
                    via: 'content-type',
                });
            } catch {
                // A closing page can throw here; a missed signal only costs the
                // old behaviour, never correctness.
            }
        });
    }

    /**
     * Content types a visit can actually browse. Anything else is a file, and a
     * file cannot fire a GA4 hit however long we sit on it.
     * @param {string} contentType
     * @returns {boolean}
     */
    static isRenderableContentType(contentType) {
        return contentType.startsWith('text/html')
            || contentType.startsWith('application/xhtml')
            || contentType.startsWith('text/plain')
            || contentType.startsWith('image/svg');
    }

    /**
     * Record the first file landing seen and release anything waiting on it.
     */
    _recordFileLanding(landing) {
        if (this._downloadLanding) return;
        this._downloadLanding = landing;
        if (this._onFileLanding) {
            const notify = this._onFileLanding;
            this._onFileLanding = null;
            notify(landing);
        }
    }

    /**
     * Navigate to the landing URL, giving up early when the response turns out
     * to be a file rather than a page.
     *
     * Without the race, a file landing costs the full navigation timeout — 60s
     * per visit on real Chrome, which rendered the PDF instead of refusing it.
     *
     * @returns {Promise<{fileLanding: Object|null, error: Error|null}>}
     */
    async _navigateToLanding(url, { waitUntil = 'load', timeout = 60000 } = {}) {
        // Already known to be a file: skip the navigation entirely. With a route
        // handler installed, a navigation that redirects to a download gives
        // Playwright nothing to report — no route for the redirect target, no
        // response, no download event — and page.goto hangs until it times out.
        if (this.landingProbe && this.landingProbe.isFile) {
            this._recordFileLanding({
                url: this.landingProbe.finalUrl || url,
                filename: String(this.landingProbe.finalUrl || url).split('/').pop().split('?')[0],
                contentType: this.landingProbe.contentType,
                via: 'probe',
            });
            return { fileLanding: this._downloadLanding, error: null };
        }

        const landingSignal = new Promise((resolve) => {
            if (this._downloadLanding) { resolve(this._downloadLanding); return; }
            this._onFileLanding = resolve;
        });

        let error = null;
        const navigation = this.page.goto(url, { waitUntil, timeout })
            .then(() => null)
            .catch((e) => { error = e; return null; });

        await Promise.race([navigation, landingSignal]);
        this._onFileLanding = null;

        if (this._downloadLanding) {
            // Stop whatever the renderer is still doing with the file.
            try { await this.page.evaluate(() => window.stop()); } catch {}
            return { fileLanding: this._downloadLanding, error: null };
        }

        await navigation;
        return { fileLanding: null, error };
    }
    /**
     * Chromium decides "this is a download" slightly after the navigation
     * fails, so a failed goto gets a short grace period for the event.
     */
    async _awaitDownloadSignal(timeout = 750) {
        if (this._downloadLanding) return this._downloadLanding;
        try {
            const download = await this.page.waitForEvent('download', { timeout });
            this._downloadLanding = this._downloadLanding || {
                url: download.url(),
                filename: download.suggestedFilename(),
            };
        } catch {
            // no download — a real navigation failure
        }
        return this._downloadLanding;
    }
    /**
     * Does this visit need request interception at all?
     *
     * Measured: with context.route() active, Chrome adds `pragma: no-cache` and
     * `cache-control: no-cache` to every navigation — 14 headers become 16. A
     * normal navigation sends neither; they are what a hard reload looks like,
     * so every visit carried a forced-reload signature on every page. Neither
     * route.continue({headers}) nor CDP Network.setCacheDisabled(false) can
     * remove them, so the only fix is not to intercept when nothing needs it.
     *
     * GA4 monitoring does not need it — passive request listeners see the same
     * beacons. These four do:
     *
     * @returns {string[]} the reasons, empty when interception can be skipped
     */
    _interceptionReasons() {
        const reasons = [];
        if (this.proxyEnabled && this.proxyCollectEnabled) reasons.push('proxying /collect');
        if (this.proxyEnabled && this.customProxyEnabled && this.customProxyPatterns.length > 0) {
            reasons.push('proxying custom URL patterns');
        }
        if (this.adsBlock) reasons.push('ad blocking');
        if (this.fastMode && (this.blockImages || this.blockMedia || this.blockFonts
            || this.blockStyles || this.blockScripts)) {
            reasons.push('fast-mode resource blocking');
        }
        // The returning-user fix rewrites the /collect URL, which can only be
        // done by intercepting it.
        if (this.isOldUser) reasons.push('returning-user /collect patch');
        return reasons;
    }

    /**
     * Watch GA4 beacons without intercepting anything.
     *
     * Same replay entries and same live-monitor events as the route handler
     * produces, minus the forced-reload headers interception adds.
     */
    async _setupPassiveMonitor() {
        const self = this;
        this.context.on('request', (request) => {
            try {
                const url = request.url();
                const urlLower = url.toLowerCase();
                if (isGACollectRequest(url)) {
                    if (self.replay) self.replay.logRequest(url, true, false);
                    self._emitGA4Event(url, false);
                    return;
                }
                if (isGAScript(url)) {
                    if (self.replay) self.replay.logRequest(url, true, false);
                    return;
                }
                if (debugAllTracking && isTrackingRequest(urlLower) && self.replay) {
                    self.replay.logRequest(url, false, false);
                }
            } catch (err) {
                self.logger.debug(`Passive monitor error (ignored): ${err.message}`);
            }
        });
        this.logger.info('Request monitoring: passive (no interception — navigations stay cache-normal)');
    }

    async _setupMergedRouteHandler() {
        const reasons = this._interceptionReasons();
        if (reasons.length === 0) {
            await this._setupPassiveMonitor();
            return;
        }

        // Initialize proxy router
        if (this.proxyEnabled && this.proxyConfig) {
            this.proxyRouter = new ProxyRouter({
                proxyUrl: this.proxyUrl,
                enabled: true,
                collectEnabled: this.proxyCollectEnabled,
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
                if (isGACollectRequest(url) && !self.proxyCollectEnabled) {
                    // Collect proxying off — beacon goes direct, but still gets
                    // the returning-user patch and shows up in replay/monitor.
                    self.proxyRouter.stats.totalRequests++;
                    self.proxyRouter.stats.directRequests++;
                    self._emitProxyStats(url, false);
                    await self._handleDirectCollect(route, url);
                    return;
                }
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
                        if (self.replay) self.replay.logRequest(collectUrl, true, true);
                        self._emitProxyStats(collectUrl, true);
                        self._emitGA4Event(collectUrl, true);
                    } catch (e) {
                        if (self.replay) self.replay.logError('proxy_collect', e.message);
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
                if (isGAScript(url) && self.replay) self.replay.logRequest(url, true, false);
                if (debugAllTracking && isTrackingRequest(urlLower) && self.replay) {
                    self.replay.logRequest(url, false, false);
                }
                await route.continue();
                return;
            }

            // 3b. No proxy but still track GA /collect requests for replay + monitor
            if (isGACollectRequest(url)) {
                self.logger.info(`ROUTE HANDLER: isOldUser=${self.isOldUser} | /collect detected`);
                await self._handleDirectCollect(route, url);
                return;
            } else if (debugAllTracking && isTrackingRequest(urlLower) && self.replay) {
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

        this.logger.info(`Request interception: ${reasons.join(' + ')}`);
    }
    /**
     * This combines both functionalities in a single handler to prevent conflicts
     */
    /**
     * Let a /collect beacon go direct, still applying the returning-user patch
     * and reporting it to the replay log + live event monitor. Used both when
     * no proxy is configured and when collect proxying is switched off.
     */
    async _handleDirectCollect(route, url) {
        if (this.isOldUser) {
            const patched = patchCollectUrlForReturning(url);
            this.logger.info(`RETURNING USER PATCH: patched=${patched ? 'YES' : 'NO'} | had _fv=${url.includes('_fv=')} sct=1=${url.includes('sct=1')}`);
            if (patched) {
                this.logger.info('RETURNING USER FIX: Removed _fv, set sct=2 for /collect request');
                if (this.replay) this.replay.logRequest(patched, true, false);
                this._emitGA4Event(patched, false);
                await route.continue({ url: patched });
                return;
            }
        }
        if (this.replay) this.replay.logRequest(url, true, false);
        this._emitGA4Event(url, false);
        await route.continue();
    }
    async _addStealthScripts() {
        const languages = Constants.getLanguagesForLocation(this.location);
        // Firefox and Safari expose no navigator.userAgentData at all, so for a
        // non-Chromium UA the object itself has to go — otherwise the UA string
        // and the hints contradict each other.
        const hideUserAgentData = !isChromiumUA(this.userAgent);

        await this.context.addInitScript(({ langs, hideUAData }) => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'languages', { get: () => langs });
            if (!window.chrome) window.chrome = { runtime: {} };

            // navigator.plugins used to be replaced with [1,2,3,4,5]. The length
            // looked right and the contents did not: a real entry is a Plugin
            // with a name, filename and description, so an array of integers is
            // its own tell — and on real Chrome that fake overwrote five genuine
            // entries with junk. Stand in only when the browser really has none
            // (the bundled Chromium reports 0 plugins, 0 mimeTypes and
            // pdfViewerEnabled false, which no real browser does), and then
            // mirror exactly what Chrome ships: its PDF viewer set.
            if (navigator.plugins.length === 0) {
                try {
                    const PDF = 'Portable Document Format';
                    const FILE = 'internal-pdf-viewer';
                    const PLUGIN_NAMES = [
                        'PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer',
                        'Microsoft Edge PDF Viewer', 'WebKit built-in PDF',
                    ];
                    const MIME_SPECS = [
                        { type: 'application/pdf', suffixes: 'pdf' },
                        { type: 'text/pdf', suffixes: 'pdf' },
                    ];

                    // Own value properties, defined rather than assigned: the
                    // real prototypes expose name/type/suffixes as getter-only
                    // accessors, so Object.assign over them throws.
                    const define = (obj, props) => {
                        for (const key of Object.keys(props)) {
                            Object.defineProperty(obj, key, {
                                value: props[key], enumerable: true, configurable: true,
                            });
                        }
                        return obj;
                    };

                    const mimeList = MIME_SPECS.map(spec => define(
                        Object.create(MimeType.prototype),
                        { type: spec.type, suffixes: spec.suffixes, description: PDF },
                    ));

                    const pluginList = PLUGIN_NAMES.map(name => {
                        const plugin = define(Object.create(Plugin.prototype), {
                            name, filename: FILE, description: PDF, length: mimeList.length,
                        });
                        mimeList.forEach((mime, i) => {
                            Object.defineProperty(plugin, i, { value: mime, enumerable: true, configurable: true });
                        });
                        define(plugin, {
                            item: (i) => mimeList[i] || null,
                            namedItem: (t) => mimeList.find(m => m.type === t) || null,
                        });
                        return plugin;
                    });

                    for (const mime of mimeList) {
                        Object.defineProperty(mime, 'enabledPlugin', {
                            value: pluginList[0], enumerable: true, configurable: true,
                        });
                    }

                    const makeCollection = (proto, list, keyOf) => {
                        const collection = Object.create(proto);
                        list.forEach((item, i) => {
                            Object.defineProperty(collection, i, { value: item, enumerable: true, configurable: true });
                        });
                        for (const item of list) {
                            Object.defineProperty(collection, keyOf(item), {
                                value: item, enumerable: false, configurable: true,
                            });
                        }
                        define(collection, {
                            length: list.length,
                            item: (i) => list[i] || null,
                            namedItem: (n) => list.find(x => keyOf(x) === n) || null,
                            refresh: () => undefined,
                        });
                        return collection;
                    };

                    const plugins = makeCollection(PluginArray.prototype, pluginList, x => x.name);
                    const mimeTypes = makeCollection(MimeTypeArray.prototype, mimeList, x => x.type);

                    Object.defineProperty(navigator, 'plugins', { get: () => plugins, configurable: true });
                    Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeTypes, configurable: true });
                    Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true, configurable: true });
                } catch (e) {
                    // Leave the real (empty) values rather than a half-built fake:
                    // a broken PluginArray is a louder signal than an empty one.
                }
            }

            if (hideUAData) {
                try { delete Object.getPrototypeOf(navigator).userAgentData; } catch {}
                try { Object.defineProperty(navigator, 'userAgentData', { get: () => undefined }); } catch {}
            }
        }, { langs: languages, hideUAData: hideUserAgentData });
    }
    /**
     * Push UA client hints that match this.userAgent.
     *
     * Playwright's `userAgent` option only rewrites the UA header — `sec-ch-ua*`
     * and `navigator.userAgentData` keep Chromium's own values, and those are
     * what GA4 actually reads (uamb / uap / uafvl). Left alone, every session
     * reported as Device: Desktop, Browser: Mozilla. Has to be applied per page
     * over CDP, so new pages are hooked as they open.
     */
    async _applyClientHints() {
        const metadata = this._uaMetadata || buildUserAgentMetadata(this.userAgent, this.userAgentProfile).metadata;
        this._hintedPages = new WeakSet();

        const apply = async (page) => {
            if (!page || this._hintedPages.has(page)) return;
            this._hintedPages.add(page);
            try {
                await applyUserAgentOverride(this.context, page, {
                    userAgent: this.userAgent,
                    metadata,
                });
            } catch (err) {
                // Page may already be closing (extension tabs do this)
                this.logger.debug(`Client hints override failed: ${err.message}`);
            }
        };
        this._applyHintsToPage = apply;

        this.context.on('page', (page) => { apply(page).catch(() => {}); });
        await Promise.all(this.context.pages().map(apply));

        const brands = metadata.brands.map(b => `${b.brand}/${b.version}`).join(', ');
        this.logger.info(`Client hints: mobile=${metadata.mobile} | platform=${metadata.platform || 'suppressed'} | brands=[${brands || 'suppressed'}]`);
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
    /**
     * Record a GA4 beacon: on the replay (so it survives into the report) and,
     * when a live monitor is attached, on the UI too.
     *
     * The replay write is the fix for an always-empty GA4EventTypes column: the
     * event name was parsed here and handed only to the UI callback, so a saved
     * report never knew which GA4 events had fired.
     */
    _emitGA4Event(url, proxied) {
        let parsed = null;
        try {
            parsed = this._parseGA4CollectUrl(url);
            if (this.replay && parsed.eventName) {
                this.replay.logGA4Event(parsed.eventName, url, 200, !!proxied);
            }
        } catch (e) {
            this.logger.debug(`GA4 parse error: ${e.message}`);
        }

        if (!this.onGA4Event || !parsed) return;
        try {
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
        if (this.visit && typeof this.visit.isBounce === 'function' && this.visit.isBounce()) {
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
            return new URL(url).hostname.replace(/^www\./, '');
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
    /**
     * Hand the profile back. An ephemeral lease deletes its directory; a pooled
     * one stays on disk and is freed for the next visit. Safe to call twice.
     */
    _cleanupTempDir() {
        if (this._profileLease) {
            try {
                this._profileLease.release();
                this.logger.debug(this._profileLease.pooled
                    ? `Released pooled profile ${this._profileLease.id}`
                    : `Removed throwaway profile ${this._profileLease.dir}`);
            } catch (e) {
                this.logger.debug(`Profile release failed: ${e.message}`);
            }
            this._profileLease = null;
        }
        this._tempUserDataDir = null;
    }

    /**
     * Drop GA cookies so a reused browser profile still presents as a new user.
     *
     * Only needed with the extension profile pool: a pooled profile keeps the
     * extension's own storage between visits (that is the point), but it also
     * keeps _ga, which would make every visit after the first look like a
     * returning user to GA4. Returning visits get their cookies injected from
     * the cookie jar instead, so clearing here is safe for them too.
     */
    async _resetGACookies() {
        if (!this.context) return 0;
        try {
            const all = await this.context.cookies();
            const ga = all.filter(c => c.name === '_ga' || c.name.startsWith('_ga_') || c.name === '_gid');
            if (ga.length === 0) return 0;
            await this.context.clearCookies();
            const keep = all.filter(c => !(c.name === '_ga' || c.name.startsWith('_ga_') || c.name === '_gid'));
            if (keep.length > 0) await this.context.addCookies(keep);
            this.logger.info(`Pooled profile: cleared ${ga.length} GA cookie(s) so this visit reads as a new user`);
            return ga.length;
        } catch (e) {
            this.logger.debug(`GA cookie reset failed: ${e.message}`);
            return 0;
        }
    }

    /**
     * Grant the extension the consent it needs, once per profile.
     *
     * Its options page carries the control ("I agree to allow access to
     * information about the sites I visit"), it defaults to off, and with it off
     * the extension reports nothing at all. The setting persists in the profile,
     * which is why this pairs with the profile pool: on a throwaway profile
     * consent could never survive to the next visit.
     */
    async _grantExtensionConsent() {
        if (!this.extensionEnabled || !this.context) return;

        const profileDir = this._tempUserDataDir;
        if (hasConsent(profileDir)) {
            this.extensionConsent = 'already-granted';
            return;
        }

        this._grantingConsent = true;
        try {
            const result = await grantExtensionConsent(this.context, {
                profileDir,
                logger: this.logger,
            });
            this.extensionConsent = result.granted
                ? (result.alreadyGranted ? 'already-granted' : 'granted')
                : 'failed';
            if (!result.granted) {
                this.logger.warn(`Extension consent not granted (${result.reason}) — the extension will load but report nothing`);
            }
        } finally {
            this._grantingConsent = false;
        }
    }

    /**
     * Check whether the extension's content script actually reached the page,
     * and record the answer on the replay so it survives into the report.
     *
     * Content scripts run in an isolated JS world — they share the DOM but not
     * `window` — so window.__sw_* flags are invisible to page.evaluate(). DOM
     * evidence is what can be seen from here.
     */
    async _verifyExtension({ settleMs = 1500 } = {}) {
        if (!this.extensionEnabled || !this.extensionLoaded || !this.page) return null;
        try {
            if (settleMs > 0) await this._sleep(settleMs);
            const status = await this.page.evaluate(() => ({
                dataAttribute: document.documentElement.getAttribute('data-similarweb') === 'true',
                hasPixel: !!document.querySelector('img[src*="similarweb.com"]'),
            }));

            // v5 announced itself in the DOM (a data attribute and a pixel);
            // v6 does neither, so those markers alone would report a perfectly
            // working extension as missing. Consent plus a running service
            // worker is what actually says it can report.
            const consented = this.extensionConsent === 'granted' || this.extensionConsent === 'already-granted';
            const detected = status.dataAttribute || status.hasPixel || consented;
            this.extensionVerified = detected;

            if (this.replay) {
                this.replay.logExtension(detected, {
                    profileId: this.extensionProfileId,
                    consent: this.extensionConsent,
                    dataAttribute: status.dataAttribute,
                    pixel: status.hasPixel,
                });
            }

            if (detected) {
                this.logger.info(`🧩 ✅ Extension WORKING (consent=${this.extensionConsent}, attr=${status.dataAttribute}, pixel=${status.hasPixel})`);
            } else {
                this.logger.warn(`🧩 ⚠️ Extension NOT DETECTED on page — failed to load, blocked by page CSP, or wrong path`);
            }
            return detected;
        } catch (error) {
            this.logger.debug(`Extension verification error: ${error.message}`);
            return null;
        }
    }
}

module.exports = BrowserSession;
module.exports.setDebugAllTracking = setDebugAllTracking;
module.exports.getDebugAllTracking = getDebugAllTracking;
module.exports.isTrackingRequest = isTrackingRequest;
module.exports.TRACKING_PATTERNS = TRACKING_PATTERNS;
