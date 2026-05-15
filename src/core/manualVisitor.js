/**
 * Manual Visitor - Handles custom command-based navigation
 * Allows users to define specific actions like clicking elements, filling forms, etc.
 * 
 * FIXES APPLIED:
 * 1. Location now uses config values
 * 2. Extension support for SimilarWeb
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { getLogger } = require('../helpers/logger');
const Constants = require('../helpers/constants');

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
        
        // Extension settings - NEW: SimilarWeb support
        this.extensionEnabled = config.extensionEnabled || false;
        this.extensionPath = config.extensionPath || '';

        this.logger = getLogger(this.threadId);
        this.browser = null;
        this.context = null;
        this.page = null;
    }

    /**
     * Execute the manual visit
     */
    async execute() {
        const startTime = Date.now();
        this.logger.info(`Starting manual visit to: ${this.url}`);
        this.logger.info(`Location: ${this.location} (${this.locationData.latitude}, ${this.locationData.longitude})`);

        try {
            await this._launchBrowser();
            await this._createContext();
            await this._visitPage();
            await this._executeCommands();

            const totalTime = (Date.now() - startTime) / 1000;
            this.logger.info(`✅ Manual visit completed in ${totalTime.toFixed(2)}s`);

        } catch (error) {
            this.logger.error(`Manual visit failed: ${error.message}`);
            throw error;
        } finally {
            await this._cleanup();
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
     * FIXED: Location now uses config values
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
            permissions: ['geolocation']
        };

        if (this.isReferer && this.referer) {
            contextOptions.extraHTTPHeaders = {
                'Referer': this.referer
            };
        }

        this.context = await this.browser.newContext(contextOptions);
        
        // Add stealth
        await this._addStealthScripts();
        
        // Setup ad blocking if enabled
        if (this.adsBlock) {
            await this._setupAdBlocking();
        }
        
        this.page = await this.context.newPage();
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
     * Add stealth scripts
     */
    async _addStealthScripts() {
        await this.context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
        });
    }
    
    /**
     * Setup ad blocking
     */
    async _setupAdBlocking() {
        const blockedPatterns = [
            'googlesyndication.com',
            'doubleclick.net',
            'adservice.google',
            'adsense',
            'facebook.com/tr',
            'connect.facebook',
            'amazon-adsystem'
        ];
        
        await this.context.route('**/*', (route) => {
            const url = route.request().url();
            if (blockedPatterns.some(pattern => url.includes(pattern))) {
                route.abort();
            } else {
                route.continue();
            }
        });
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
