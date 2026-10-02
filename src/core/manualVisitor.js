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

const Constants = require('../helpers/constants');
const { matchesCustomProxyPattern, resolveTrackerChain } = require('../helpers/proxyRouter');
const { SessionReplay } = require('../helpers/sessionReplay');
const BrowserSession = require('./browserSession');

class ManualVisitor extends BrowserSession {
    constructor(config) {
        super(config);

        // Manual mode drives the page from user commands instead of a Visit.
        this.url = this.targetUrl;
        this.commands = config.commands;
        this.avgSessionDuration = config.avgSessionDuration || 0;
    }

    /**
     * Execute the manual visit
     */
    async execute() {
        const startTime = Date.now();

        // Initialize session replay (parity with AutomaticVisitor)
        this.replay = new SessionReplay(this.threadId, { maxEvents: 200 });
        this.replay.setSessionInfo(this._buildSessionInfo({ mode: 'manual' }));
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

            // See AutomaticVisitor: these are only known after the context is
            // built, which is after setSessionInfo ran.
            this.replay.updateSessionInfo({
                spoofedIP: this.currentIP,
                extensionLoaded: this.extensionLoaded,
                extensionProfileId: this.extensionProfileId,
            });

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

            if (this._downloadLanding) {
                // No page to drive and no gtag to fire — commands and the
                // session hold would buy nothing.
                this.logger.warn(`⬇ Visit ended at a download (${this._downloadLanding.filename || this._downloadLanding.url}) — commands skipped, no GA4 hit is possible for a file URL`);
                this.replay.stats.downloadLanding = true;
                this.logger.warn(`   Use an HTML landing page as the campaign URL if you need GA4 sessions.`);
            } else {
                await this._executeCommands();
            }

            // avgSessionDuration fallback wait — if commands finished fast, hold the
            // page open so GA4 records a session of roughly the configured duration.
            if (this.avgSessionDuration > 0 && !this._downloadLanding) {
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

    async _visitPage() {
        // Pre-resolve click-tracker redirect chain through proxy (see automaticVisitor
        // for rationale). Browser then loads only the final landing page.
        let urlToNavigate = this.url;
        if (this.customProxyEnabled && this.proxyConfig && this.customProxyPatterns.length > 0
            && matchesCustomProxyPattern(this.url, this.customProxyPatterns)) {
            try {
                const chainResult = await resolveTrackerChain(
                    this.url,
                    this.proxyConfig,
                    this.customProxyPatterns,
                    this.logger
                );
                urlToNavigate = chainResult.finalUrl;
                this.logger.info(`Tracker chain resolved via proxy: ${chainResult.hops.length} hop(s) → ${urlToNavigate.substring(0, 120)}`);
            } catch (e) {
                this.logger.warn(`Tracker chain resolution failed: ${e.message} — falling back to direct navigation`);
            }
        }

        if (this.visitReferer && this.referer) {
            try {
                await this.page.goto(this.referer, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });
                await this._randomDelay(800, 1500);
                await this.page.evaluate((url) => {
                    window.location.href = url;
                }, urlToNavigate);
                await this.page.waitForLoadState('domcontentloaded', { timeout: 60000 });
            } catch (e) {
                this.logger.warn(`Referer navigation failed (${e.message}) — falling back to direct visit`);
                await this.page.goto(urlToNavigate, {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000
                });
            }
        } else {
            const { fileLanding, error } = await this._navigateToLanding(urlToNavigate, {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            });
            if (fileLanding) {
                // The landing URL answered with a file, not a page. Tracker hops
                // already registered through the proxy, so this is an outcome,
                // not a failure.
                this.logger.warn(`⬇ Landing URL is a file (${fileLanding.contentType || 'download'}): ${fileLanding.filename || fileLanding.url}`);
                if (this.replay) this.replay._addEvent('download_landing', fileLanding);
                return;
            }
            if (error) throw error;
        }

        // Resolve true primary domain from the landed URL — if the URL was a
        // CM360 / ad-tracker click URL, page.url() now points at the real
        // destination after the 302 chain.
        this._resolveLandedDomain();

        // Manual mode never checked the extension at all — enabling it here was
        // silently unverifiable.
        if (this.extensionEnabled && this.extensionLoaded) {
            await this._verifyExtension();
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

}

module.exports = ManualVisitor;
