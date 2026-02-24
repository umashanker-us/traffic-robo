/**
 * Session Replay Logger for GA4 Traffic Robo v2.4
 * 
 * MEDIUM PRIORITY: Records GA4 events per browser session for debugging
 * 
 * Captures:
 * - GA4 network requests (page_view, session_start, scroll, etc.)
 * - Page navigations with timestamps
 * - GA detection status
 * - Proxy routing decisions
 * - User behavior actions (scroll, mouse, clicks)
 * 
 * Usage:
 *   const replay = new SessionReplay(threadId);
 *   replay.logNavigation(url, loadTime);
 *   replay.logGA4Event('page_view', requestUrl, status);
 *   replay.logBehavior('scroll', { depth: 75 });
 *   const summary = replay.getSummary();
 */

const { getLogger } = require('./logger');

class SessionReplay {
    /**
     * @param {number} threadId - Visit/thread identifier
     * @param {Object} options
     * @param {boolean} options.captureGA - Capture GA4 requests (default: true)
     * @param {boolean} options.captureNavigation - Capture page navigations (default: true)
     * @param {boolean} options.captureBehavior - Capture user behavior events (default: true)
     * @param {number} options.maxEvents - Maximum events to store (default: 500)
     */
    constructor(threadId, options = {}) {
        this.threadId = threadId;
        this.captureGA = options.captureGA !== false;
        this.captureNavigation = options.captureNavigation !== false;
        this.captureBehavior = options.captureBehavior !== false;
        this.maxEvents = options.maxEvents || 500;

        this.startTime = Date.now();
        this.events = [];
        this.logger = getLogger(threadId);

        // Summary counters
        this.stats = {
            pagesVisited: 0,
            ga4EventsFired: 0,
            ga4EventsDetected: false,
            scrollEvents: 0,
            mouseEvents: 0,
            totalLoadTimeMs: 0,
            proxyRequestsRouted: 0,
            directRequests: 0,
            errors: 0,
            isBounce: false,
            isReturningUser: false,
        };
    }

    /**
     * Internal: Add event to timeline
     */
    _addEvent(type, data) {
        if (this.events.length >= this.maxEvents) return;

        this.events.push({
            timestamp: Date.now(),
            elapsed: Date.now() - this.startTime,
            type,
            ...data,
        });
    }

    // ==================== Navigation Events ====================

    /**
     * Log page navigation
     * @param {string} url - Page URL
     * @param {number} loadTimeMs - Page load time in ms
     * @param {string} title - Page title
     */
    logNavigation(url, loadTimeMs = 0, title = '') {
        if (!this.captureNavigation) return;

        this.stats.pagesVisited++;
        this.stats.totalLoadTimeMs += loadTimeMs;

        this._addEvent('navigation', {
            url,
            title,
            loadTimeMs,
            pageNumber: this.stats.pagesVisited,
        });
    }

    /**
     * Log referer visit (for returning users)
     */
    logRefererVisit(refererUrl) {
        this._addEvent('referer', { url: refererUrl });
    }

    /**
     * Log previous URL visit (returning user simulation)
     */
    logPreviousURLVisit(url, source) {
        this.stats.isReturningUser = true;
        this._addEvent('previous_url', { url, source });
    }

    // ==================== GA4 Events ====================

    /**
     * Log GA4 detection status
     * @param {boolean} detected - Whether GA4/GTM was found
     * @param {Object} details - Detection details
     */
    logGA4Detection(detected, details = {}) {
        if (!this.captureGA) return;

        this.stats.ga4EventsDetected = detected;
        this._addEvent('ga4_detection', {
            detected,
            hasGtag: details.hasGtag || false,
            hasDataLayer: details.hasDataLayer || false,
            hasGTM: details.hasGTM || false,
            waitTimeMs: details.waitTimeMs || 0,
        });
    }

    /**
     * Log GA4 network request (intercepted from route handler)
     * @param {string} eventType - GA4 event name (page_view, session_start, scroll, etc.)
     * @param {string} requestUrl - Full request URL
     * @param {number} status - HTTP status code
     * @param {boolean} proxied - Whether request went through proxy
     */
    logGA4Event(eventType, requestUrl, status = 200, proxied = false) {
        if (!this.captureGA) return;

        this.stats.ga4EventsFired++;
        if (proxied) this.stats.proxyRequestsRouted++;

        this._addEvent('ga4_event', {
            eventType,
            url: requestUrl.substring(0, 200), // Truncate long URLs
            status,
            proxied,
        });
    }

    /**
     * Log GA4 request from route handler
     * @param {string} url - Request URL
     * @param {boolean} isGA - Whether it was identified as GA request
     * @param {boolean} proxied - Whether it went through proxy
     */
    logRequest(url, isGA, proxied) {
        if (isGA) {
            this.stats.proxyRequestsRouted += proxied ? 1 : 0;
            this.stats.ga4EventsFired++;
        } else {
            this.stats.directRequests++;
        }

        this._addEvent('request', {
            url: url.substring(0, 150),
            isGA,
            proxied,
            type: isGA ? 'ga4' : 'tracking',
        });
    }

    // ==================== User Behavior Events ====================

    /**
     * Log user behavior action
     * @param {string} action - Action type: 'scroll', 'mouse_move', 'click', 'wait'
     * @param {Object} details - Action-specific details
     */
    logBehavior(action, details = {}) {
        if (!this.captureBehavior) return;

        switch (action) {
            case 'scroll':
                this.stats.scrollEvents++;
                break;
            case 'mouse_move':
                this.stats.mouseEvents++;
                break;
        }

        this._addEvent('behavior', { action, ...details });
    }

    /**
     * Log bounce event
     * @param {number} timeOnPageMs - Time spent on page before leaving
     */
    logBounce(timeOnPageMs) {
        this.stats.isBounce = true;
        this._addEvent('bounce', { timeOnPageMs });
    }

    // ==================== Error Events ====================

    /**
     * Log error during visit
     * @param {string} context - Where the error occurred
     * @param {string} message - Error message
     */
    logError(context, message) {
        this.stats.errors++;
        this._addEvent('error', { context, message });
    }

    // ==================== Proxy Events ====================

    /**
     * Log proxy routing decision
     * @param {string} url - Request URL
     * @param {string} mode - Proxy mode (smart/full/all)
     * @param {boolean} proxied - Whether it was proxied
     */
    logProxyDecision(url, mode, proxied) {
        this._addEvent('proxy', {
            url: url.substring(0, 100),
            mode,
            proxied,
        });
    }

    // ==================== Session Info ====================

    /**
     * Set session metadata
     */
    setSessionInfo(info) {
        this.sessionInfo = {
            userAgent: info.userAgent ? info.userAgent.substring(0, 100) : '',
            screenSize: info.screenSize || {},
            location: info.location || '',
            playMode: info.playMode || '',
            proxyMode: info.proxyMode || 'none',
            ipRotation: info.ipRotation || false,
            spoofedIP: info.spoofedIP || null,
            isOldUser: info.isOldUser || false,
        };
    }

    // ==================== Output ====================

    /**
     * Get complete session replay summary
     * @returns {Object} Full replay data
     */
    getSummary() {
        const endTime = Date.now();
        return {
            threadId: this.threadId,
            startTime: new Date(this.startTime).toISOString(),
            endTime: new Date(endTime).toISOString(),
            durationMs: endTime - this.startTime,
            durationSec: Math.round((endTime - this.startTime) / 1000),
            sessionInfo: this.sessionInfo || {},
            stats: {
                ...this.stats,
                avgLoadTimeMs: this.stats.pagesVisited > 0
                    ? Math.round(this.stats.totalLoadTimeMs / this.stats.pagesVisited) : 0,
            },
            timeline: this.events,
            eventCount: this.events.length,
        };
    }

    /**
     * Get compact summary (without full timeline) for UI display
     */
    getCompactSummary() {
        const full = this.getSummary();
        return {
            threadId: full.threadId,
            duration: `${full.durationSec}s`,
            pages: full.stats.pagesVisited,
            ga4Events: full.stats.ga4EventsFired,
            ga4Detected: full.stats.ga4EventsDetected,
            isBounce: full.stats.isBounce,
            isReturning: full.stats.isReturningUser,
            errors: full.stats.errors,
            proxied: full.stats.proxyRequestsRouted,
            eventCount: full.eventCount,
        };
    }

    /**
     * Print replay to logger
     */
    printReplay() {
        const summary = this.getSummary();
        this.logger.info(`\n${'='.repeat(60)}`);
        this.logger.info(`SESSION REPLAY - Visit #${this.threadId}`);
        this.logger.info(`${'='.repeat(60)}`);
        this.logger.info(`Duration: ${summary.durationSec}s | Pages: ${summary.stats.pagesVisited} | GA4 Events: ${summary.stats.ga4EventsFired}`);
        this.logger.info(`GA4 Detected: ${summary.stats.ga4EventsDetected} | Bounce: ${summary.stats.isBounce} | Returning: ${summary.stats.isReturningUser}`);
        this.logger.info(`Proxy Requests: ${summary.stats.proxyRequestsRouted} | Direct: ${summary.stats.directRequests} | Errors: ${summary.stats.errors}`);

        if (summary.sessionInfo && summary.sessionInfo.location) {
            this.logger.info(`Location: ${summary.sessionInfo.location} | Mode: ${summary.sessionInfo.playMode} | Proxy: ${summary.sessionInfo.proxyMode}`);
        }

        this.logger.info(`\nTimeline (${summary.eventCount} events):`);
        summary.timeline.forEach((event, idx) => {
            const time = `+${(event.elapsed / 1000).toFixed(1)}s`;
            switch (event.type) {
                case 'navigation':
                    this.logger.info(`  [${time}] 📄 Page ${event.pageNumber}: ${event.url} (${event.loadTimeMs}ms)`);
                    break;
                case 'ga4_detection':
                    this.logger.info(`  [${time}] ${event.detected ? '✅' : '❌'} GA4 Detection: gtag=${event.hasGtag} dataLayer=${event.hasDataLayer} GTM=${event.hasGTM}`);
                    break;
                case 'ga4_event':
                    this.logger.info(`  [${time}] 📊 GA4: ${event.eventType} ${event.proxied ? '(proxied)' : '(direct)'} [${event.status}]`);
                    break;
                case 'behavior':
                    this.logger.info(`  [${time}] 🖱️ ${event.action}: ${JSON.stringify(event).substring(0, 80)}`);
                    break;
                case 'bounce':
                    this.logger.info(`  [${time}] 🔴 BOUNCE after ${event.timeOnPageMs}ms`);
                    break;
                case 'error':
                    this.logger.info(`  [${time}] ❌ ERROR [${event.context}]: ${event.message}`);
                    break;
                case 'proxy':
                    this.logger.info(`  [${time}] 🔄 Proxy [${event.mode}]: ${event.proxied ? 'proxied' : 'direct'}`);
                    break;
                case 'previous_url':
                    this.logger.info(`  [${time}] 👤 Previous URL (${event.source}): ${event.url}`);
                    break;
                default:
                    break;
            }
        });
        this.logger.info(`${'='.repeat(60)}\n`);
    }
}

/**
 * Session Replay Store - Manages replays across all visits
 * Used by visitLogic.js to collect and serve replays to UI
 */
class SessionReplayStore {
    /**
     * @param {number} maxReplays - Maximum replays to keep (default: 100)
     */
    constructor(maxReplays = 100) {
        this.maxReplays = maxReplays;
        this.replays = new Map(); // threadId -> summary
    }

    /**
     * Store a completed session replay
     */
    addReplay(replay) {
        if (!(replay instanceof SessionReplay)) return;

        const summary = replay.getSummary();
        this.replays.set(summary.threadId, summary);

        // Evict oldest if over limit
        if (this.replays.size > this.maxReplays) {
            const firstKey = this.replays.keys().next().value;
            this.replays.delete(firstKey);
        }
    }

    /**
     * Get replay by thread/visit ID
     */
    getReplay(threadId) {
        return this.replays.get(threadId) || null;
    }

    /**
     * Get list of all replays (compact)
     */
    getReplayList() {
        const list = [];
        for (const [id, replay] of this.replays) {
            list.push({
                threadId: id,
                duration: `${replay.durationSec}s`,
                pages: replay.stats.pagesVisited,
                ga4Events: replay.stats.ga4EventsFired,
                ga4Detected: replay.stats.ga4EventsDetected,
                isBounce: replay.stats.isBounce,
                errors: replay.stats.errors,
                timestamp: replay.startTime,
            });
        }
        return list.reverse(); // Newest first
    }

    /**
     * Clear all replays
     */
    clear() {
        this.replays.clear();
    }

    get size() {
        return this.replays.size;
    }
}

module.exports = {
    SessionReplay,
    SessionReplayStore,
};
