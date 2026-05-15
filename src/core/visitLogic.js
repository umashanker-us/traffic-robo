/**
 * Visit Logic - Core automation engine for GA4 Traffic Robo
 * Uses Playwright for browser automation with realistic behavior
 * 
 * FIXES APPLIED:
 * 1. Pass location to visitors
 * 2. Pass extension settings to visitors
 * 3. Proper stop functionality with browser cleanup
 */

const { getLogger, initCampaignLogger, closeCampaignLogger, getCampaignLogDir } = require('../helpers/logger');
const Constants = require('../helpers/constants');
const { generateVisitsArray, calculateMetrics, shuffleArray } = require('../helpers/visits');
const { getUserAgentList, getMatchingScreenSize, getMixedScreenSizes } = require('../helpers/userAgents');
const AutomaticVisitor = require('./automaticVisitor');
const ManualVisitor = require('./manualVisitor');
const { SessionReplayStore } = require('../helpers/sessionReplay');
const { resolveTrafficSource } = require('../helpers/trafficSource');
const { generateCSV } = require('../helpers/campaignExport');
const { resolveRanges } = require('../helpers/campaignCsv');
const fs = require('fs');
const path = require('path');

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
        this.campaignLogDir = null; // Campaign-specific log directory
        this.savedGACookies = null; // GA cookies from first visit for returning users (legacy)
        this.cookieJarPool = []; // Pool of distinct _ga cookies from new visits — returning visits pick randomly so GA4 sees N returning users, not 1
        this.cookieJarTarget = 20; // Stop collecting once pool reaches this size
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
        let {
            urlList,
            repeat = 100,
        } = config;
        const {
            refererList = [''],
            isReferer = false,
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
            // Proxy settings (proxy is always /collect-only — page loads go direct)
            proxyEnabled = false,
            proxyUrl = '',
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
            mixedSocial = 20,
            campaignName = '',
            csvCampaignRows = null,
        } = config;

        // Initialize campaign-specific logging before any log output
        this.campaignLogDir = initCampaignLogger(campaignName);

        const startTime = Date.now();
        this.isRunning = true;
        this.completedVisits = 0;
        this.startedVisits = 0;
        this.campaignResults = [];
        this.campaignConfig = config;
        this.campaignStartTime = new Date().toISOString();
        this.abortController = new AbortController();

        // CSV campaign mode — resolve per-URL ranges and override urlList/repeat
        // with the sum of per-URL visit counts. Global bounce/duration/pages
        // become ignored in this mode (each URL has its own).
        let resolvedCsvRows = null;
        if (Array.isArray(csvCampaignRows) && csvCampaignRows.length > 0) {
            resolvedCsvRows = resolveRanges(csvCampaignRows);
            urlList = resolvedCsvRows.map(r => r.url);
            repeat = resolvedCsvRows.reduce((sum, r) => sum + r.visits, 0);
            logger.info(`CSV mode: ${resolvedCsvRows.length} URLs, total visits ${repeat}`);
            resolvedCsvRows.forEach((r, i) => {
                logger.info(`  [${i + 1}] ${r.url} → visits=${r.visits} bounce=${r.bounce}% duration=${r.duration}s pages=${r.pages}`);
            });
        }

        // Validate inputs
        this._validateInputs(urlList, bounceRate, pagePerSession, avgSessionDuration);

        // Generate data arrays
        logger.info('Generating visit configurations...');
        const userAgentList = getUserAgentList(userAgentType, 100);
        // In CSV mode each URL gets its own 100-visit distribution from its own
        // (bounce, duration, pages); in normal mode there is one shared distribution.
        const visitsList = generateVisitsArray(avgSessionDuration, bounceRate, pagePerSession);
        const csvVisitsByUrl = resolvedCsvRows
            ? new Map(resolvedCsvRows.map(r => [r.url, generateVisitsArray(r.duration, r.bounce, r.pages)]))
            : null;
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
                    csvVisitsByUrl,
                    resolvedCsvRows,
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
                    visitsList,
                    csvVisitsByUrl,
                    resolvedCsvRows,
                    screenSizes,
                    oldUserFlags,
                    restrictToPrimaryDomain,
                    previousURL,
                    useBaseUrlForOldUser,
                    avgSessionDuration,
                    playMode,
                    adsBlock,
                    inputCommands,
                    location,
                    extensionEnabled,
                    extensionPath,
                    proxyEnabled,
                    proxyUrl,
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
                    mixedSocial,
                });
            }

            const totalTime = (Date.now() - startTime) / 1000;
            logger.info(`✅ Traffic simulation completed!`);
            logger.info(`Total time: ${totalTime.toFixed(2)}s`);
            logger.info(`Visits completed: ${this.completedVisits}`);

            // Auto-save CSV to campaign log directory
            this._autoSaveCSV();

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
            closeCampaignLogger();
        }
    }

    /**
     * Create the PQueue. Extracted so tests can stub it via a sync fake.
     */
    async _createQueue(concurrency) {
        const PQueue = (await import('p-queue')).default;
        return new PQueue({ concurrency });
    }

    /**
     * Run automatic mode - visits links automatically
     */
    async _runAutomaticMode(config) {
        const {
            urlList, refererList, isReferer, totalBatches, threads,
            threadDelay, memClear, userAgentList, visitsList,
            csvVisitsByUrl, resolvedCsvRows,
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

        const queue = await this._createQueue(threads);

        // Build proxy list for random rotation
        const proxyList = (proxyEnabled && proxyUrl)
            ? proxyUrl.split(/[\n]+/).map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('#'))
            : [];
        this.queue = queue;  // Store reference for stop()

        const baseTaskParams = {
            trafficSourceConfig, isReferer, threadDelay, memClear,
            restrictToPrimaryDomain, previousURL, useBaseUrlForOldUser,
            playMode, adsBlock, proxyEnabled, proxyList, proxyUrl,
            location, extensionEnabled, extensionPath, ipRotation,
            fastMode, blockImages, blockMedia, blockFonts, blockStyles, blockScripts,
        };

        if (csvVisitsByUrl && resolvedCsvRows) {
            // CSV mode: iterate per URL, each with its own visit count and visits array
            let globalVisitIndex = 0;
            for (const csvRow of resolvedCsvRows) {
                if (!this.isRunning) break;

                const csvVisits = csvVisitsByUrl.get(csvRow.url);
                const totalForUrl = csvRow.visits;
                const batchesForUrl = Math.ceil(totalForUrl / 100);
                let enqueuedForUrl = 0;

                for (let batchNum = 0; batchNum < batchesForUrl; batchNum++) {
                    if (!this.isRunning) break;

                    const paired = userAgentList.map((ua, idx) => ({ ua, screen: screenSizes[idx] }));
                    const shuffledPairs = shuffleArray(paired);
                    const shuffledUA = shuffledPairs.map(p => p.ua);
                    const shuffledScreens = shuffledPairs.map(p => p.screen);
                    const shuffledVisits = shuffleArray(csvVisits);
                    const shuffledOldUser = shuffleArray(oldUserFlags);
                    const shuffledReferers = shuffleArray(refererList);

                    const batchLimit = Math.min(100, totalForUrl - enqueuedForUrl);
                    for (let i = 0; i < batchLimit; i++) {
                        if (!this.isRunning) break;
                        enqueuedForUrl++;
                        globalVisitIndex++;
                        const visitIndex = globalVisitIndex;
                        const legacyReferer = shuffledReferers[i % shuffledReferers.length];
                        const params = {
                            ...baseTaskParams,
                            visitIndex,
                            campaignUrl: csvRow.url,
                            legacyReferer,
                            userAgent: shuffledUA[i],
                            visit: shuffledVisits[i],
                            screenSize: shuffledScreens[i],
                            isOldUserFlag: shuffledOldUser[i],
                        };
                        queue.add(() => this._executeVisitTask(params));
                    }
                }
            }
        } else {
            // Standard mode: shared visits array across all URLs (cross-product)
            for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
                if (!this.isRunning) break;

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
                        const params = {
                            ...baseTaskParams,
                            visitIndex,
                            campaignUrl,
                            legacyReferer,
                            userAgent: shuffledUA[i],
                            visit: shuffledVisits[i],
                            screenSize: shuffledScreens[i],
                            isOldUserFlag: shuffledOldUser[i],
                        };
                        queue.add(() => this._executeVisitTask(params));
                    }
                }
            }
        }

        await queue.onIdle();
    }

    /**
     * Execute a single visit task (queue body). Shared between standard and CSV modes.
     */
    async _executeVisitTask(params) {
        const {
            visitIndex, campaignUrl, legacyReferer,
            userAgent, visit, screenSize, isOldUserFlag,
            trafficSourceConfig, isReferer, threadDelay, memClear,
            restrictToPrimaryDomain, previousURL, useBaseUrlForOldUser,
            playMode, adsBlock, proxyEnabled, proxyList, proxyUrl,
            location, extensionEnabled, extensionPath, ipRotation,
            fastMode, blockImages, blockMedia, blockFonts, blockStyles, blockScripts,
        } = params;

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

        let resolvedReferer, resolvedIsReferer, resolvedVisitReferer, resolvedCampaignUrl;
        if (trafficSourceConfig) {
            const resolved = resolveTrafficSource(trafficSourceConfig, campaignUrl);
            resolvedReferer = resolved.referer;
            resolvedIsReferer = resolved.isReferer;
            resolvedVisitReferer = resolved.visitReferer;
            resolvedCampaignUrl = resolved.campaignUrl;
        } else {
            resolvedReferer = legacyReferer;
            resolvedIsReferer = isReferer;
            resolvedVisitReferer = isReferer;
            resolvedCampaignUrl = campaignUrl;
        }

        // Force returning flag to NEW while the pool is empty — at least one
        // completed new-user visit must seed the pool first.
        const poolEmpty = this.cookieJarPool.length === 0;
        const effectiveOldUser = poolEmpty ? false : isOldUserFlag;

        if (poolEmpty && isOldUserFlag) {
            logger.info(`COOKIE FIX: Visit #${visitIndex} forced to NEW user (cookie pool still empty)`);
        }

        let pickedCookies = null;
        if (effectiveOldUser) {
            if (this.cookieJarPool.length > 0) {
                pickedCookies = this.cookieJarPool[Math.floor(Math.random() * this.cookieJarPool.length)];
                logger.info(`COOKIE JAR: Injecting cookies for returning visit #${visitIndex} (pool size ${this.cookieJarPool.length})`);
            } else {
                logger.info(`COOKIE JAR: EMPTY - cannot create returning user!`);
            }
        }

        const visitor = new AutomaticVisitor({
            campaignUrl: resolvedCampaignUrl,
            referer: resolvedReferer,
            isReferer: resolvedIsReferer,
            visitReferer: resolvedVisitReferer,
            userAgent,
            threadId: visitIndex,
            visit,
            screenSize,
            isOldUser: effectiveOldUser,
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
            savedCookies: pickedCookies,
        });

        this.activeVisitors.push(visitor);

        try {
            await visitor.execute();
            if (!effectiveOldUser && this.cookieJarPool.length < this.cookieJarTarget) {
                const cookies = visitor.getCookies();
                const gaCookie = cookies.find(c => c.name === '_ga');
                if (gaCookie) {
                    const alreadyPooled = this.cookieJarPool.some(set => {
                        const existing = set.find(c => c.name === '_ga');
                        return existing && existing.value === gaCookie.value;
                    });
                    if (!alreadyPooled) {
                        this.cookieJarPool.push(cookies);
                        if (!this.savedGACookies) this.savedGACookies = cookies;
                        logger.info(`COOKIE JAR: Added _ga=${gaCookie.value} from visit #${visitIndex} to pool (size now ${this.cookieJarPool.length}/${this.cookieJarTarget})`);
                    }
                } else {
                    logger.warn(`COOKIE JAR: No _ga cookie found in visit #${visitIndex}`);
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
            const index = this.activeVisitors.indexOf(visitor);
            if (index > -1) {
                this.activeVisitors.splice(index, 1);
            }
        }
    }

    /**
     * Run manual mode - executes custom commands
     */
    async _runManualMode(config) {
        const {
            urlList, refererList, isReferer, totalBatches, threads,
            threadDelay, memClear, userAgentList, screenSizes,
            visitsList, csvVisitsByUrl, resolvedCsvRows,
            oldUserFlags, restrictToPrimaryDomain, previousURL, useBaseUrlForOldUser,
            avgSessionDuration,
            playMode, adsBlock, inputCommands, location,
            extensionEnabled, extensionPath,
            proxyEnabled, proxyUrl, ipRotation,
            fastMode, blockImages, blockMedia, blockFonts, blockStyles, blockScripts,
            trafficSourceType, searchEngine, searchKeywords, referralUrls,
            socialPlatforms, utmSource, utmMedium, utmCampaign, utmTerm, utmContent,
            mixedDirect, mixedOrganic, mixedReferral, mixedSocial,
        } = config;

        const queue = await this._createQueue(threads);
        this.queue = queue;  // Store reference for stop()

        // Defaults for backward-compat / tests that omit these
        const safeOldUserFlags = Array.isArray(oldUserFlags) ? oldUserFlags : Array(100).fill(false);

        // Parse proxy list (one per line, random rotation per visit)
        let proxyList = [];
        if (proxyEnabled && proxyUrl) {
            proxyList = proxyUrl
                .split(/[\n]+/)
                .map(s => s.trim())
                .filter(s => s.length > 0 && !s.startsWith('#'));
        }

        const trafficSourceConfig = trafficSourceType ? {
            trafficSourceType, searchEngine, searchKeywords,
            referralUrls, socialPlatforms,
            utmSource, utmMedium, utmCampaign, utmTerm, utmContent,
            mixedDirect, mixedOrganic, mixedReferral, mixedSocial,
        } : null;

        const baseTaskParams = {
            isReferer, threadDelay, memClear,
            playMode, adsBlock, inputCommands, location,
            extensionEnabled, extensionPath,
            trafficSourceConfig,
            proxyEnabled: !!proxyEnabled,
            proxyList,
            ipRotation: !!ipRotation,
            fastMode: !!fastMode,
            blockImages: !!blockImages,
            blockMedia: !!blockMedia,
            blockFonts: !!blockFonts,
            blockStyles: !!blockStyles,
            blockScripts: !!blockScripts,
            restrictToPrimaryDomain: !!restrictToPrimaryDomain,
            previousURL,
            useBaseUrlForOldUser: !!useBaseUrlForOldUser,
            avgSessionDuration,
        };

        if (Array.isArray(resolvedCsvRows) && resolvedCsvRows.length > 0) {
            // CSV mode: per-URL visit counts. bounce/duration/pages are not
            // meaningful in manual mode (commands run instead) — only `visits` is used.
            let globalVisitIndex = 0;
            for (const csvRow of resolvedCsvRows) {
                if (!this.isRunning) break;
                const totalForUrl = csvRow.visits;
                const batchesForUrl = Math.ceil(totalForUrl / 100);
                let enqueuedForUrl = 0;

                for (let batchNum = 0; batchNum < batchesForUrl; batchNum++) {
                    if (!this.isRunning) break;

                    const paired = userAgentList.map((ua, idx) => ({ ua, screen: screenSizes[idx] }));
                    const shuffledPairs = shuffleArray(paired);
                    const shuffledUA = shuffledPairs.map(p => p.ua);
                    const shuffledScreens = shuffledPairs.map(p => p.screen);
                    const shuffledReferers = shuffleArray(refererList);
                    const shuffledOldUser = shuffleArray(safeOldUserFlags);

                    const batchLimit = Math.min(100, totalForUrl - enqueuedForUrl);
                    for (let i = 0; i < batchLimit; i++) {
                        if (!this.isRunning) break;
                        enqueuedForUrl++;
                        globalVisitIndex++;
                        const params = {
                            ...baseTaskParams,
                            visitIndex: globalVisitIndex,
                            url: csvRow.url,
                            referer: shuffledReferers[i % shuffledReferers.length],
                            userAgent: shuffledUA[i],
                            screenSize: shuffledScreens[i],
                            isOldUserFlag: shuffledOldUser[i],
                        };
                        queue.add(() => this._executeManualTask(params));
                    }
                }
            }
        } else {
            for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
                if (!this.isRunning) break;

                const pairedM = userAgentList.map((ua, idx) => ({ ua, screen: screenSizes[idx] }));
                const shuffledPairsM = shuffleArray(pairedM);
                const shuffledUA = shuffledPairsM.map(p => p.ua);
                const shuffledScreens = shuffledPairsM.map(p => p.screen);
                const shuffledReferers = shuffleArray(refererList);
                const shuffledOldUser = shuffleArray(safeOldUserFlags);

                for (let i = 0; i < 100; i++) {
                    if (!this.isRunning) break;

                    for (const url of urlList) {
                        if (!this.isRunning) break;
                        const visitIndex = (batchNum * 100) + i + 1;
                        const params = {
                            ...baseTaskParams,
                            visitIndex,
                            url,
                            referer: shuffledReferers[i % shuffledReferers.length],
                            userAgent: shuffledUA[i],
                            screenSize: shuffledScreens[i],
                            isOldUserFlag: shuffledOldUser[i],
                        };
                        queue.add(() => this._executeManualTask(params));
                    }
                }
            }
        }

        await queue.onIdle();
    }

    /**
     * Execute a single manual visit task (queue body). Shared between standard and CSV modes.
     */
    async _executeManualTask(params) {
        const {
            visitIndex, url, referer, userAgent, screenSize,
            isReferer, threadDelay, memClear,
            playMode, adsBlock, inputCommands, location,
            extensionEnabled, extensionPath,
            trafficSourceConfig,
            proxyEnabled, proxyList, ipRotation,
            fastMode, blockImages, blockMedia, blockFonts, blockStyles, blockScripts,
            restrictToPrimaryDomain, previousURL, useBaseUrlForOldUser, avgSessionDuration,
            isOldUserFlag,
        } = params;

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

        // Per-visit traffic source resolution: overrides legacy referer/url with
        // resolved values (UTM-appended URL, search/social referer header, etc.)
        let resolvedUrl = url;
        let resolvedReferer = referer;
        let resolvedIsReferer = isReferer;
        let resolvedVisitReferer = isReferer && !!referer;
        if (trafficSourceConfig) {
            const r = resolveTrafficSource(trafficSourceConfig, url);
            resolvedUrl = r.campaignUrl;
            resolvedReferer = r.referer;
            resolvedIsReferer = r.isReferer;
            resolvedVisitReferer = r.visitReferer;
        }

        // Returning-user cookie injection — force NEW until pool seeded
        const poolEmpty = this.cookieJarPool.length === 0;
        const effectiveOldUser = poolEmpty ? false : !!isOldUserFlag;
        let pickedCookies = null;
        if (effectiveOldUser && this.cookieJarPool.length > 0) {
            pickedCookies = this.cookieJarPool[Math.floor(Math.random() * this.cookieJarPool.length)];
            logger.info(`COOKIE JAR (manual): Injecting cookies for returning visit #${visitIndex} (pool size ${this.cookieJarPool.length})`);
        }

        const pickedProxyUrl = (Array.isArray(proxyList) && proxyList.length > 0)
            ? proxyList[Math.floor(Math.random() * proxyList.length)]
            : '';

        const visitor = new ManualVisitor({
            url: resolvedUrl,
            referer: resolvedReferer,
            isReferer: resolvedIsReferer,
            visitReferer: resolvedVisitReferer,
            userAgent,
            threadId: visitIndex,
            screenSize,
            playMode,
            adsBlock,
            commands: inputCommands,
            location,
            extensionEnabled,
            extensionPath,
            // Browser-level features ported from automatic mode
            proxyEnabled: !!proxyEnabled,
            proxyUrl: pickedProxyUrl,
            ipRotation: !!ipRotation,
            fastMode: !!fastMode,
            blockImages, blockMedia, blockFonts, blockStyles, blockScripts,
            // Returning-user features
            isOldUser: effectiveOldUser,
            savedCookies: pickedCookies,
            previousURL,
            useBaseUrlForOldUser: !!useBaseUrlForOldUser,
            // Misc
            restrictToPrimaryDomain: !!restrictToPrimaryDomain,
            avgSessionDuration,
        });

        this.activeVisitors.push(visitor);

        try {
            await visitor.execute();
            // Seed cookie pool from new-user visits (same gate as automatic mode)
            if (!effectiveOldUser && this.cookieJarPool.length < this.cookieJarTarget && typeof visitor.getCookies === 'function') {
                const cookies = visitor.getCookies();
                const gaCookie = cookies.find(c => c.name === '_ga');
                if (gaCookie) {
                    const alreadyPooled = this.cookieJarPool.some(set => {
                        const existing = set.find(c => c.name === '_ga');
                        return existing && existing.value === gaCookie.value;
                    });
                    if (!alreadyPooled) {
                        this.cookieJarPool.push(cookies);
                        logger.info(`COOKIE JAR (manual): Added _ga=${gaCookie.value} from visit #${visitIndex} (size ${this.cookieJarPool.length}/${this.cookieJarTarget})`);
                    }
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
            const index = this.activeVisitors.indexOf(visitor);
            if (index > -1) {
                this.activeVisitors.splice(index, 1);
            }
        }
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
        
        // Auto-save CSV before closing campaign logger
        this._autoSaveCSV();

        logger.info('✅ Traffic simulation stopped completely');
        closeCampaignLogger();
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
     * Auto-save campaign results CSV to the campaign log directory
     */
    _autoSaveCSV() {
        try {
            const logDir = getCampaignLogDir();
            if (logDir && this.campaignResults.length > 0) {
                const csv = generateCSV(this.campaignResults);
                const csvPath = path.join(logDir, 'campaign_results.csv');
                fs.writeFileSync(csvPath, csv, 'utf8');
                logger.info(`Campaign results auto-saved to ${csvPath}`);
            }
        } catch (e) {
            logger.warn(`Failed to auto-save CSV: ${e.message}`);
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
