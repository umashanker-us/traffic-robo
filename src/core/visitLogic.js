/**
 * Visit Logic - Core automation engine for GA4 Traffic Robo
 * Uses Playwright for browser automation with realistic behavior
 * 
 * FIXES APPLIED:
 * 1. Pass location to visitors
 * 2. Pass extension settings to visitors
 * 3. Proper stop functionality with browser cleanup
 */

const { getLogger } = require('../helpers/logger');
const Constants = require('../helpers/constants');
const { generateVisitsArray, calculateMetrics, shuffleArray } = require('../helpers/visits');
const { getUserAgentList, getMatchingScreenSize, getMixedScreenSizes } = require('../helpers/userAgents');
const AutomaticVisitor = require('./automaticVisitor');
const ManualVisitor = require('./manualVisitor');
const { SessionReplayStore } = require('../helpers/sessionReplay');
const { resolveTrafficSource } = require('../helpers/trafficSource');

const logger = getLogger();

class VisitLogic {
    constructor() {
        this.isRunning = false;
        this.activeVisitors = [];  // Track active visitor instances
        this.queue = null;         // Reference to PQueue
        this.completedVisits = 0;
        this.startedVisits = 0;
        this.listener = null;
        this.abortController = null;
        this.replayStore = new SessionReplayStore(100);
        this.campaignResults = [];  // Per-visit results for export
        this.campaignConfig = null; // Store config for export metadata
        this.campaignStartTime = null;
        this.savedGACookies = null; // GA cookies from first visit for returning users
    }

    /**
     * Set event listener for visit updates
     */
    setListener(listener) {
        this.listener = listener;
    }

    /**
     * Start traffic simulation
     */
    async start(config) {
        const {
            urlList,
            refererList = [''],
            isReferer = false,
            repeat = 100,
            avgSessionDuration = 60,
            bounceRate = 30,
            threads = 5,
            threadDelay = 1,
            memClear = 0,
            pagePerSession = 3,
            userAgentType = Constants.DEVICE_TYPES.DEFAULT,
            location = Constants.LOCATIONS.INDIA,
            percOldUsers = 20,
            previousURL = null,
            useBaseUrlForOldUser = false,  // NEW: Option to use base URL for old users
            commandMode = Constants.COMMAND_MODES.AUTOMATIC,
            inputCommands = '',
            restrictToPrimaryDomain = true,
            playMode = Constants.PLAY_MODES.SLOW,
            adsBlock = false,
            // Proxy settings
            proxyEnabled = false,
            proxyUrl = '',

            proxyGAOnly = true,  // Only proxy GA requests (recommended)
            // Extension settings - NEW
            extensionEnabled = false,
            extensionPath = '',
            // IP Rotation - NEW v2.4
            ipRotation = false,
            // Fast Mode - Block heavy resources
            fastMode = false,
            blockImages = false,
            blockMedia = false,
            blockFonts = false,
            blockStyles = false,
            blockScripts = false,
            // Traffic Source
            trafficSourceType = '',
            searchEngine = 'Google',
            searchKeywords = '',
            referralUrls = '',
            socialPlatforms = [],
            utmSource = '',
            utmMedium = '',
            utmCampaign = '',
            utmTerm = '',
            utmContent = '',
            mixedDirect = 25,
            mixedOrganic = 35,
            mixedReferral = 20,
            mixedSocial = 20
        } = config;

        const startTime = Date.now();
        this.isRunning = true;
        this.completedVisits = 0;
        this.startedVisits = 0;
        this.campaignResults = [];
        this.campaignConfig = config;
        this.campaignStartTime = new Date().toISOString();
        this.abortController = new AbortController();

        // Validate inputs
        this._validateInputs(urlList, bounceRate, pagePerSession, avgSessionDuration);

        // Generate data arrays
        logger.info('Generating visit configurations...');
        const userAgentList = getUserAgentList(userAgentType, 100);
        const visitsList = generateVisitsArray(avgSessionDuration, bounceRate, pagePerSession);
        // Screens MATCHED to UA (mobile UA → mobile screen, desktop UA → desktop screen)
        const screenSizes = userAgentList.map(ua => getMatchingScreenSize(ua));
        const oldUserFlags = this._generateOldUserFlags(percOldUsers);

        // Log metrics
        const metrics = calculateMetrics(visitsList);
        logger.info(`User Agents generated: ${userAgentList.length}`);
        logger.info(`Visits generated: ${visitsList.length}`);
        logger.info(`Calculated Bounce Rate: ${metrics.actualBounceRate}%`);
        logger.info(`Calculated Avg Session Duration: ${metrics.avgSessionDuration}s`);
        logger.info(`Calculated Avg Pages/Session: ${metrics.avgPagePerSession.toFixed(2)}`);
        logger.info(`Location: ${location}`);
        
        // Parse proxy list (one per line, random rotation)
        let proxyList = [];
        if (proxyEnabled && proxyUrl) {
            proxyList = proxyUrl
                .split(/[\n]+/)
                .map(s => s.trim())
                .filter(s => s.length > 0 && !s.startsWith('#'));
            
            if (proxyList.length > 1) {
                logger.info(`Proxy ENABLED: ${proxyList.length} proxies (random rotation per visit)`);
            } else if (proxyList.length === 1) {
                logger.info(`Proxy ENABLED: ${proxyList[0].substring(0, 60)}...`);
            }
            logger.info(`Proxy Mode: Only /collect endpoints proxied (near-zero bandwidth)`);
        } else {
            logger.info(`Proxy: DISABLED`);
        }
        
        // Log extension settings
        if (extensionEnabled && extensionPath) {
            logger.info(`Extension ENABLED: ${extensionPath}`);
            if (playMode === Constants.PLAY_MODES.FASTEST || playMode === Constants.PLAY_MODES.FAST) {
                logger.warn(`⚠️ Extensions require headed mode. Switch to Slow or Slower for extensions to work.`);
            }
        }
        
        // Log IP Rotation
        if (ipRotation) {
            logger.info(`IP Rotation ENABLED (Indian IPs)`);
            logger.warn(`⚠️ IP spoofing does NOT work with Cloudflare sites`);
        }
        
        // Log Fast Mode
        if (fastMode) {
            logger.info(`Fast Mode ENABLED - Blocking: ${blockImages ? 'Images ' : ''}${blockMedia ? 'Media ' : ''}${blockFonts ? 'Fonts ' : ''}${blockStyles ? 'CSS ' : ''}${blockScripts ? 'JS' : ''}`);
        }
        
        // Log traffic source
        if (trafficSourceType && trafficSourceType !== 'Direct') {
            logger.info(`Traffic Source: ${trafficSourceType}`);
            if (trafficSourceType === 'Mixed') {
                logger.info(`  Mix: Direct ${mixedDirect}% | Organic ${mixedOrganic}% | Referral ${mixedReferral}% | Social ${mixedSocial}%`);
            }
        } else if (!trafficSourceType) {
            logger.info(`Traffic Source: Legacy (referer list)`);
        } else {
            logger.info(`Traffic Source: Direct`);
        }

        // Log returning users
        logger.info(`Returning Users: ${percOldUsers}%`);
        if (percOldUsers === 100 && !previousURL && !useBaseUrlForOldUser) {
            logger.info(`100% returning users - no previous URL visit needed`);
        }
        
        // Calculate total batches needed
        const totalBatches = Math.ceil(repeat / 100);
        logger.info(`Total visits to process: ${repeat}`);
        logger.info(`Batches: ${totalBatches} (100 visits each)`);
        logger.info(`Concurrent threads: ${threads}`);

        try {
            if (commandMode === Constants.COMMAND_MODES.AUTOMATIC) {
                await this._runAutomaticMode({
                    urlList,
                    refererList,
                    isReferer,
                    totalBatches,
                    threads,
                    threadDelay,
                    memClear,
                    userAgentList,
                    visitsList,
                    screenSizes,
                    oldUserFlags,
                    restrictToPrimaryDomain,
                    previousURL,
                    useBaseUrlForOldUser,
                    playMode,
                    adsBlock,
                    proxyEnabled,
                    proxyUrl,
                    location,
                    extensionEnabled,
                    extensionPath,
                    ipRotation,
                    fastMode,
                    blockImages,
                    blockMedia,
                    blockFonts,
                    blockStyles,
                    blockScripts,
                    trafficSourceType,
                    searchEngine,
                    searchKeywords,
                    referralUrls,
                    socialPlatforms,
                    utmSource,
                    utmMedium,
                    utmCampaign,
                    utmTerm,
                    utmContent,
                    mixedDirect,
                    mixedOrganic,
                    mixedReferral,
                    mixedSocial
                });
            } else {
                await this._runManualMode({
                    urlList,
                    refererList,
                    isReferer,
                    totalBatches,
                    threads,
                    threadDelay,
                    memClear,
                    userAgentList,
                    screenSizes,
                    playMode,
                    adsBlock,
                    inputCommands,
                    location,
                    extensionEnabled,
                    extensionPath
                });
            }

            const totalTime = (Date.now() - startTime) / 1000;
            logger.info(`✅ Traffic simulation completed!`);
            logger.info(`Total time: ${totalTime.toFixed(2)}s`);
            logger.info(`Visits completed: ${this.completedVisits}`);
            this._notifySimulationComplete();

        } catch (error) {
            if (error.name === 'AbortError') {
                logger.info('Traffic simulation stopped by user');
            } else {
                logger.error(`Error in traffic simulation: ${error.message}`);
                throw error;
            }
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Run automatic mode - visits links automatically
     */
    async _runAutomaticMode(config) {
        const {
            urlList, refererList, isReferer, totalBatches, threads,
            threadDelay, memClear, userAgentList, visitsList,
            screenSizes, oldUserFlags, restrictToPrimaryDomain,
            previousURL, useBaseUrlForOldUser, playMode, adsBlock, proxyEnabled, proxyUrl,
            location, extensionEnabled, extensionPath, ipRotation,
            fastMode, blockImages, blockMedia, blockFonts, blockStyles, blockScripts,
            trafficSourceType, searchEngine, searchKeywords, referralUrls,
            socialPlatforms, utmSource, utmMedium, utmCampaign,
            utmTerm, utmContent, mixedDirect, mixedOrganic,
            mixedReferral, mixedSocial
        } = config;

        // Build traffic source config for per-visit resolution
        const trafficSourceConfig = trafficSourceType ? {
            trafficSourceType, searchEngine, searchKeywords,
            referralUrls, socialPlatforms, utmSource, utmMedium,
            utmCampaign, utmTerm, utmContent,
            mixedDirect, mixedOrganic, mixedReferral, mixedSocial
        } : null;

        const PQueue = (await import('p-queue')).default;
        const queue = new PQueue({ concurrency: threads });

        // Build proxy list for random rotation
        const proxyList = (proxyEnabled && proxyUrl)
            ? proxyUrl.split(/[\n]+/).map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('#'))
            : [];
        this.queue = queue;  // Store reference for stop()

        for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
            if (!this.isRunning) break;

            // Shuffle UA+Screen TOGETHER (paired) to maintain alignment
            const paired = userAgentList.map((ua, idx) => ({ ua, screen: screenSizes[idx] }));
            const shuffledPairs = shuffleArray(paired);
            const shuffledUA = shuffledPairs.map(p => p.ua);
            const shuffledScreens = shuffledPairs.map(p => p.screen);
            const shuffledVisits = shuffleArray(visitsList);
            const shuffledOldUser = shuffleArray(oldUserFlags);
            const shuffledReferers = shuffleArray(refererList);

            for (let i = 0; i < 100; i++) {
                if (!this.isRunning) break;

                for (const campaignUrl of urlList) {
                    if (!this.isRunning) break;

                    const visitIndex = (batchNum * 100) + i + 1;
                    const legacyReferer = shuffledReferers[i % shuffledReferers.length];

                    queue.add(async () => {
                        if (!this.isRunning) return;

                        // Add thread delay (except for first visit)
                        if (visitIndex > 1 && threadDelay > 0) {
                            await this._delay(threadDelay * 1000);
                        }

                        if (!this.isRunning) return;

                        // Memory cleanup check
                        if (memClear >= 10 && visitIndex % memClear === 0) {
                            logger.info(`Memory cleanup triggered at visit ${visitIndex}`);
                            if (global.gc) global.gc();
                        }

                        this._notifyVisitStarted();

                        // Resolve traffic source per visit (new) or use legacy referer
                        let resolvedReferer, resolvedIsReferer, resolvedCampaignUrl;
                        if (trafficSourceConfig) {
                            const resolved = resolveTrafficSource(trafficSourceConfig, campaignUrl);
                            resolvedReferer = resolved.referer;
                            resolvedIsReferer = resolved.isReferer;
                            resolvedCampaignUrl = resolved.campaignUrl;
                        } else {
                            resolvedReferer = legacyReferer;
                            resolvedIsReferer = isReferer;
                            resolvedCampaignUrl = campaignUrl;
                        }

                        // Cookie jar debug logging
                        if (shuffledOldUser[i]) {
                            if (this.savedGACookies && this.savedGACookies.length > 0) {
                                logger.info(`COOKIE JAR: Injecting cookies for returning visit #${visitIndex}`);
                            } else {
                                logger.info(`COOKIE JAR: EMPTY - cannot create returning user!`);
                            }
                        }

                        const visitor = new AutomaticVisitor({
                            campaignUrl: resolvedCampaignUrl,
                            referer: resolvedReferer,
                            isReferer: resolvedIsReferer,
                            userAgent: shuffledUA[i],
                            threadId: visitIndex,
                            visit: shuffledVisits[i],
                            screenSize: shuffledScreens[i],
                            isOldUser: shuffledOldUser[i],
                            restrictToPrimaryDomain,
                            previousURL,
                            useBaseUrlForOldUser,
                            playMode,
                            adsBlock,
                            proxyEnabled,
                            proxyUrl: proxyList.length > 0
                                ? proxyList[Math.floor(Math.random() * proxyList.length)]
                                : proxyUrl,
                            location,
                            extensionEnabled,
                            extensionPath,
                            ipRotation,
                            fastMode,
                            blockImages,
                            blockMedia,
                            blockFonts,
                            blockStyles,
                            blockScripts,
                            onProxyStats: (data) => this._notifyProxyStats(data),
                            onGA4Event: (data) => this._notifyGA4Event(data),
                            savedCookies: shuffledOldUser[i] ? this.savedGACookies : null
                        });

                        // Track active visitor
                        this.activeVisitors.push(visitor);

                        try {
                            await visitor.execute();
                            if (!this.savedGACookies) {
                                this.savedGACookies = await visitor.getCookies();
                                if (this.savedGACookies.length > 0) {
                                    logger.info(`Captured ${this.savedGACookies.length} GA cookies for returning users`);
                                    logger.info(`COOKIE JAR: Saved ${this.savedGACookies.length} cookies from visit #1`);
                                }
                            }
                            this._collectReplay(visitor);
                            this._collectResult(visitor);
                            this._notifyVisitCompleted();
                        } catch (error) {
                            this._collectReplay(visitor);
                            this._collectResult(visitor);
                            if (this.isRunning) {
                                logger.error(`Visit ${visitIndex} failed: ${error.message}`);
                            }
                        } finally {
                            // Remove from active list
                            const index = this.activeVisitors.indexOf(visitor);
                            if (index > -1) {
                                this.activeVisitors.splice(index, 1);
                            }
                        }
                    });
                }
            }
        }

        await queue.onIdle();
    }

    /**
     * Run manual mode - executes custom commands
     */
    async _runManualMode(config) {
        const {
            urlList, refererList, isReferer, totalBatches, threads,
            threadDelay, memClear, userAgentList, screenSizes,
            playMode, adsBlock, inputCommands, location,
            extensionEnabled, extensionPath
        } = config;

        const PQueue = (await import('p-queue')).default;
        const queue = new PQueue({ concurrency: threads });
        this.queue = queue;  // Store reference for stop()

        for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
            if (!this.isRunning) break;

            const pairedM = userAgentList.map((ua, idx) => ({ ua, screen: screenSizes[idx] }));
            const shuffledPairsM = shuffleArray(pairedM);
            const shuffledUA = shuffledPairsM.map(p => p.ua);
            const shuffledScreens = shuffledPairsM.map(p => p.screen);
            const shuffledReferers = shuffleArray(refererList);

            for (let i = 0; i < 100; i++) {
                if (!this.isRunning) break;

                for (const url of urlList) {
                    if (!this.isRunning) break;

                    const visitIndex = (batchNum * 100) + i + 1;
                    const referer = shuffledReferers[i % shuffledReferers.length];

                    queue.add(async () => {
                        if (!this.isRunning) return;

                        if (visitIndex > 1 && threadDelay > 0) {
                            await this._delay(threadDelay * 1000);
                        }
                        
                        if (!this.isRunning) return;

                        if (memClear >= 10 && visitIndex % memClear === 0) {
                            logger.info(`Memory cleanup triggered at visit ${visitIndex}`);
                            if (global.gc) global.gc();
                        }

                        this._notifyVisitStarted();

                        const visitor = new ManualVisitor({
                            url,
                            referer,
                            isReferer,
                            userAgent: shuffledUA[i],
                            threadId: visitIndex,
                            screenSize: shuffledScreens[i],
                            playMode,
                            adsBlock,
                            commands: inputCommands,
                            location,
                            extensionEnabled,
                            extensionPath
                        });

                        // Track active visitor
                        this.activeVisitors.push(visitor);

                        try {
                            await visitor.execute();
                            this._collectReplay(visitor);
                            this._collectResult(visitor);
                            this._notifyVisitCompleted();
                        } catch (error) {
                            this._collectReplay(visitor);
                            this._collectResult(visitor);
                            if (this.isRunning) {
                                logger.error(`Visit ${visitIndex} failed: ${error.message}`);
                            }
                        } finally {
                            // Remove from active list
                            const index = this.activeVisitors.indexOf(visitor);
                            if (index > -1) {
                                this.activeVisitors.splice(index, 1);
                            }
                        }
                    });
                }
            }
        }

        await queue.onIdle();
    }

    /**
     * Stop all running tasks - IMMEDIATE TERMINATION
     */
    async stop() {
        logger.info('🛑 STOPPING - Terminating all active sessions...');
        this.isRunning = false;
        
        // 1. Abort the controller
        if (this.abortController) {
            this.abortController.abort();
        }
        
        // 2. Clear the queue (cancel pending tasks)
        if (this.queue) {
            this.queue.clear();
            logger.info(`✅ Queue cleared`);
        }
        
        // 3. Force close all active browsers
        const activeCount = this.activeVisitors.length;
        if (activeCount > 0) {
            logger.info(`🔄 Closing ${activeCount} active browser sessions...`);
            
            const closePromises = this.activeVisitors.map(async (visitor) => {
                try {
                    await visitor.forceClose();
                } catch (e) {
                    // Ignore errors during force close
                }
            });
            
            // Wait max 5 seconds for all browsers to close
            await Promise.race([
                Promise.all(closePromises),
                new Promise(resolve => setTimeout(resolve, 5000))
            ]);
            
            this.activeVisitors = [];
            logger.info(`✅ All browsers closed`);
        }
        
        logger.info('✅ Traffic simulation stopped completely');
    }

    /**
     * Validate input parameters
     */
    _validateInputs(urlList, bounceRate, pagePerSession, avgSessionDuration) {
        if (!urlList || urlList.length === 0) {
            throw new Error('URL list cannot be empty');
        }

        if (bounceRate < Constants.BOUNCE_RATE.MIN || bounceRate > Constants.BOUNCE_RATE.MAX) {
            throw new Error(`Bounce rate must be between ${Constants.BOUNCE_RATE.MIN}% and ${Constants.BOUNCE_RATE.MAX}%`);
        }

        if (pagePerSession < Constants.PAGES_PER_SESSION.MIN) {
            throw new Error(`Pages per session must be at least ${Constants.PAGES_PER_SESSION.MIN}`);
        }

        if (avgSessionDuration < Constants.SESSION_DURATION.MIN) {
            throw new Error(`Average session duration must be at least ${Constants.SESSION_DURATION.MIN} seconds`);
        }
    }

    /**
     * Generate old user flags array
     */
    _generateOldUserFlags(percOldUsers) {
        const flags = [];
        for (let i = 0; i < percOldUsers; i++) {
            flags.push(true);
        }
        for (let i = 0; i < (100 - percOldUsers); i++) {
            flags.push(false);
        }
        return flags;
    }

    /**
     * Delay helper
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Notify listener about visit started
     */
    _notifyVisitStarted() {
        this.startedVisits++;
        if (this.listener && this.listener.uniqueVisitStarted) {
            this.listener.uniqueVisitStarted();
        }
    }

    /**
     * Notify listener about visit completed
     */
    _notifyVisitCompleted() {
        this.completedVisits++;
        if (this.listener && this.listener.uniqueVisit) {
            this.listener.uniqueVisit(this.completedVisits);
        }
    }

    /**
     * Notify listener about proxy stats update
     */
    _notifyProxyStats(data) {
        if (this.listener && this.listener.proxyStatsUpdate) {
            this.listener.proxyStatsUpdate(data);
        }
    }

    /**
     * Notify listener about GA4 event detection
     */
    _notifyGA4Event(data) {
        if (this.listener && this.listener.ga4Event) {
            this.listener.ga4Event(data);
        }
    }

    /**
     * Collect replay from completed visitor and store it
     */
    _collectReplay(visitor) {
        try {
            if (visitor && visitor.replay) {
                this.replayStore.addReplay(visitor.replay);
                this._notifyReplayUpdate(visitor.replay.threadId);
            }
        } catch (e) {
            logger.debug(`Failed to collect replay: ${e.message}`);
        }
    }

    /**
     * Notify listener about new replay available
     */
    _notifyReplayUpdate(threadId) {
        if (this.listener && this.listener.replayUpdate) {
            this.listener.replayUpdate(threadId);
        }
    }

    /**
     * Collect per-visit result from completed visitor for export
     */
    _collectResult(visitor) {
        try {
            if (visitor && visitor.replay) {
                const summary = visitor.replay.getSummary();
                // Enrich sessionInfo with proxy URL for city extraction
                if (visitor.proxyUrl && summary.sessionInfo) {
                    summary.sessionInfo.proxyUrl = visitor.proxyUrl;
                }
                this.campaignResults.push(summary);
            }
        } catch (e) {
            logger.debug(`Failed to collect result: ${e.message}`);
        }
    }

    /**
     * Notify listener that simulation is complete (for export prompt)
     */
    _notifySimulationComplete() {
        if (this.listener && this.listener.simulationComplete) {
            this.listener.simulationComplete({
                totalResults: this.campaignResults.length,
                completedVisits: this.completedVisits,
            });
        }
    }

    /**
     * Get collected campaign results for export
     */
    getCampaignResults() {
        return this.campaignResults;
    }

    /**
     * Get campaign config for export metadata
     */
    getCampaignConfig() {
        return this.campaignConfig;
    }

    /**
     * Get current visit count
     */
    getCurrentVisits() {
        return this.completedVisits;
    }
}

module.exports = VisitLogic;
