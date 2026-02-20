/**
 * Proxy Pool Manager - Real Rotating Proxy Support for GA4 Traffic Robo v2.4
 * 
 * HIGH PRIORITY FEATURE: Replaces single proxy URL with multi-proxy rotation pool
 * 
 * Features:
 * - Multiple proxy support (comma/newline separated input)
 * - 3 rotation strategies: round-robin, random, least-used
 * - Health checking with automatic disable/re-enable of dead proxies
 * - Sticky sessions (same proxy per browser session)
 * - Weighted proxy selection (give priority to faster/premium proxies)
 * - Stats tracking per proxy (success/fail/latency)
 * - Auto-failover on proxy failure
 * - Compatible with existing ProxyRouter (drop-in enhancement)
 * 
 * Usage:
 *   const pool = new ProxyPool({
 *       proxies: 'http://user:pass@proxy1.com:8080, http://proxy2.com:3128',
 *       strategy: 'round-robin',    // 'round-robin' | 'random' | 'least-used'
 *       healthCheckInterval: 60000, // Check every 60s
 *       maxFailures: 3,            // Disable after 3 consecutive failures
 *       stickySession: true,       // Same proxy per browser session
 *   });
 * 
 *   const proxy = pool.getNext();          // Get next proxy config
 *   const proxy = pool.getForSession(id);  // Get sticky proxy for session
 *   pool.reportSuccess(proxy);             // Report success
 *   pool.reportFailure(proxy);             // Report failure
 */

const { getLogger } = require('./logger');
const { parseProxyString, createPlaywrightProxy } = require('./proxyRouter');

const logger = getLogger();

/**
 * Individual proxy entry with health/stats tracking
 */
class ProxyEntry {
    /**
     * @param {string} proxyString - Proxy URL string (e.g., "http://user:pass@host:port")
     * @param {number} weight - Priority weight (higher = more frequent selection). Default 1
     */
    constructor(proxyString, weight = 1) {
        this.raw = proxyString.trim();
        this.config = parseProxyString(this.raw);
        this.weight = weight;
        this.enabled = this.config !== null;

        // Stats
        this.totalRequests = 0;
        this.successCount = 0;
        this.failureCount = 0;
        this.consecutiveFailures = 0;
        this.totalLatencyMs = 0;
        this.lastUsed = 0;
        this.lastSuccess = 0;
        this.lastFailure = 0;
        this.disabledAt = 0;

        // ID for tracking
        this.id = this.config
            ? `${this.config.host}:${this.config.port}`
            : this.raw.substring(0, 30);
    }

    /**
     * Get Playwright-compatible proxy config
     */
    getPlaywrightConfig() {
        return createPlaywrightProxy(this.config);
    }

    /**
     * Get average latency
     */
    getAvgLatency() {
        if (this.successCount === 0) return Infinity;
        return Math.round(this.totalLatencyMs / this.successCount);
    }

    /**
     * Get success rate as percentage
     */
    getSuccessRate() {
        if (this.totalRequests === 0) return 100;
        return Math.round((this.successCount / this.totalRequests) * 100);
    }

    /**
     * Record successful request
     * @param {number} latencyMs - Request latency in milliseconds
     */
    recordSuccess(latencyMs = 0) {
        this.totalRequests++;
        this.successCount++;
        this.consecutiveFailures = 0;
        this.totalLatencyMs += latencyMs;
        this.lastUsed = Date.now();
        this.lastSuccess = Date.now();

        // Re-enable if previously disabled and now working
        if (!this.enabled && this.disabledAt > 0) {
            this.enabled = true;
            this.disabledAt = 0;
            logger.info(`✅ Proxy re-enabled (recovered): ${this.id}`);
        }
    }

    /**
     * Record failed request
     * @param {number} maxFailures - Max consecutive failures before disable
     */
    recordFailure(maxFailures = 3) {
        this.totalRequests++;
        this.failureCount++;
        this.consecutiveFailures++;
        this.lastUsed = Date.now();
        this.lastFailure = Date.now();

        if (this.consecutiveFailures >= maxFailures && this.enabled) {
            this.enabled = false;
            this.disabledAt = Date.now();
            logger.warn(`❌ Proxy disabled (${this.consecutiveFailures} consecutive failures): ${this.id}`);
        }
    }

    /**
     * Reset stats (useful after health check recovery)
     */
    resetFailures() {
        this.consecutiveFailures = 0;
        if (!this.enabled) {
            this.enabled = true;
            this.disabledAt = 0;
        }
    }

    /**
     * Get human-readable status
     */
    getStatus() {
        return {
            id: this.id,
            enabled: this.enabled,
            weight: this.weight,
            total: this.totalRequests,
            success: this.successCount,
            failures: this.failureCount,
            consecutiveFailures: this.consecutiveFailures,
            successRate: `${this.getSuccessRate()}%`,
            avgLatency: `${this.getAvgLatency()}ms`,
            lastUsed: this.lastUsed ? new Date(this.lastUsed).toISOString() : 'never',
        };
    }
}

/**
 * Proxy Pool Manager
 * Manages multiple proxies with rotation, health checks, and failover
 */
class ProxyPool {
    /**
     * @param {Object} options
     * @param {string} options.proxies - Proxy list (comma or newline separated)
     * @param {string} options.strategy - Rotation strategy: 'round-robin' | 'random' | 'least-used'
     * @param {number} options.maxFailures - Max consecutive failures before disabling (default: 3)
     * @param {boolean} options.stickySession - Use same proxy per session ID (default: false)
     * @param {number} options.healthCheckInterval - Health check interval ms (0 = disabled)
     * @param {string} options.weights - Comma-separated weights matching proxies (e.g., "3,1,2")
     */
    constructor(options = {}) {
        const {
            proxies = '',
            strategy = 'round-robin',
            maxFailures = 3,
            stickySession = false,
            healthCheckInterval = 0,
            weights = '',
        } = options;

        this.strategy = strategy;
        this.maxFailures = maxFailures;
        this.stickySession = stickySession;
        this.healthCheckInterval = healthCheckInterval;

        // Parse proxy list
        this.entries = this._parseProxyList(proxies, weights);
        this.roundRobinIndex = 0;

        // Sticky session map: sessionId -> ProxyEntry
        this.sessionMap = new Map();

        // Health check timer
        this.healthCheckTimer = null;
        if (healthCheckInterval > 0 && this.entries.length > 0) {
            this._startHealthChecks();
        }

        // Log initialization
        if (this.entries.length > 0) {
            logger.info(`🔄 ProxyPool initialized: ${this.entries.length} proxies, strategy=${strategy}`);
            this.entries.forEach((entry, i) => {
                logger.info(`   [${i}] ${entry.id} (weight=${entry.weight}, ${entry.enabled ? 'enabled' : 'DISABLED'})`);
            });
        } else {
            logger.info(`ProxyPool: No proxies configured`);
        }
    }

    /**
     * Parse proxy list from string input
     * Supports:
     * - Comma-separated: "proxy1:8080, proxy2:8080"
     * - Newline-separated: "proxy1:8080\nproxy2:8080"
     * - Mixed: "proxy1:8080, proxy2:8080\nproxy3:8080"
     * - With optional weights: "proxy1:8080[w=3], proxy2:8080[w=1]"
     * 
     * @param {string} proxies - Proxy list string
     * @param {string} weights - Optional comma-separated weights
     * @returns {ProxyEntry[]}
     */
    _parseProxyList(proxies, weights = '') {
        if (!proxies || proxies.trim() === '') return [];

        // Split by comma or newline
        const proxyStrings = proxies
            .split(/[,\n]+/)
            .map(s => s.trim())
            .filter(s => s.length > 0);

        // Parse weights
        const weightList = weights
            ? weights.split(',').map(w => parseInt(w.trim()) || 1)
            : [];

        return proxyStrings.map((proxyStr, idx) => {
            // Check for inline weight syntax: proxy:8080[w=3]
            let weight = weightList[idx] || 1;
            let cleanProxy = proxyStr;

            const weightMatch = proxyStr.match(/\[w=(\d+)\]/);
            if (weightMatch) {
                weight = parseInt(weightMatch[1]) || 1;
                cleanProxy = proxyStr.replace(/\[w=\d+\]/, '').trim();
            }

            return new ProxyEntry(cleanProxy, weight);
        }).filter(entry => entry.config !== null);
    }

    /**
     * Get number of active (enabled) proxies
     */
    get activeCount() {
        return this.entries.filter(e => e.enabled).length;
    }

    /**
     * Get total number of proxies (including disabled)
     */
    get totalCount() {
        return this.entries.length;
    }

    /**
     * Check if pool has any usable proxies
     */
    get hasProxies() {
        return this.activeCount > 0;
    }

    /**
     * Get next proxy based on strategy
     * @returns {ProxyEntry|null} Next proxy to use
     */
    getNext() {
        const active = this.entries.filter(e => e.enabled);
        if (active.length === 0) {
            logger.warn('⚠️ No active proxies available!');
            return null;
        }

        switch (this.strategy) {
            case 'random':
                return this._getRandomWeighted(active);
            case 'least-used':
                return this._getLeastUsed(active);
            case 'round-robin':
            default:
                return this._getRoundRobin(active);
        }
    }

    /**
     * Get proxy for a specific session (sticky session)
     * If stickySession is enabled, same session ID always gets same proxy
     * 
     * @param {string|number} sessionId - Unique session identifier
     * @returns {ProxyEntry|null}
     */
    getForSession(sessionId) {
        if (!this.stickySession) {
            return this.getNext();
        }

        // Check if session already has a proxy assigned
        if (this.sessionMap.has(sessionId)) {
            const entry = this.sessionMap.get(sessionId);
            if (entry.enabled) {
                return entry;
            }
            // Assigned proxy is disabled, reassign
            this.sessionMap.delete(sessionId);
        }

        // Assign new proxy to session
        const proxy = this.getNext();
        if (proxy) {
            this.sessionMap.set(sessionId, proxy);
        }
        return proxy;
    }

    /**
     * Get Playwright proxy config for next proxy
     * @returns {Object|null} Playwright proxy config
     */
    getNextPlaywrightConfig() {
        const entry = this.getNext();
        return entry ? entry.getPlaywrightConfig() : null;
    }

    /**
     * Get Playwright proxy config for session
     * @param {string|number} sessionId
     * @returns {Object|null} Playwright proxy config
     */
    getPlaywrightConfigForSession(sessionId) {
        const entry = this.getForSession(sessionId);
        return entry ? entry.getPlaywrightConfig() : null;
    }

    /**
     * Report successful proxy usage
     * @param {ProxyEntry} entry - The proxy entry
     * @param {number} latencyMs - Request latency in ms
     */
    reportSuccess(entry, latencyMs = 0) {
        if (entry && entry instanceof ProxyEntry) {
            entry.recordSuccess(latencyMs);
        }
    }

    /**
     * Report failed proxy usage
     * @param {ProxyEntry} entry - The proxy entry
     */
    reportFailure(entry) {
        if (entry && entry instanceof ProxyEntry) {
            entry.recordFailure(this.maxFailures);
        }
    }

    /**
     * Release a session's sticky proxy assignment
     * @param {string|number} sessionId
     */
    releaseSession(sessionId) {
        this.sessionMap.delete(sessionId);
    }

    /**
     * Get pool statistics
     * @returns {Object}
     */
    getStats() {
        return {
            totalProxies: this.totalCount,
            activeProxies: this.activeCount,
            disabledProxies: this.totalCount - this.activeCount,
            strategy: this.strategy,
            stickySession: this.stickySession,
            activeSessions: this.sessionMap.size,
            proxies: this.entries.map(e => e.getStatus()),
        };
    }

    /**
     * Log pool statistics
     */
    logStats() {
        const stats = this.getStats();
        logger.info(`\n=== Proxy Pool Stats ===`);
        logger.info(`Active: ${stats.activeProxies}/${stats.totalProxies} | Strategy: ${stats.strategy} | Sessions: ${stats.activeSessions}`);

        stats.proxies.forEach(p => {
            const status = p.enabled ? '✅' : '❌';
            logger.info(`  ${status} ${p.id} | Requests: ${p.total} | Success: ${p.successRate} | Avg Latency: ${p.avgLatency} | Failures: ${p.consecutiveFailures}`);
        });
    }

    /**
     * Force enable all proxies (reset failures)
     */
    resetAll() {
        this.entries.forEach(entry => entry.resetFailures());
        logger.info('🔄 All proxies reset and enabled');
    }

    /**
     * Destroy pool - clean up timers and sessions
     */
    destroy() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
        this.sessionMap.clear();
    }

    // ============ Internal Strategy Methods ============

    /**
     * Round-robin selection among active proxies
     */
    _getRoundRobin(active) {
        // Wrap index to active list length
        this.roundRobinIndex = this.roundRobinIndex % active.length;
        const entry = active[this.roundRobinIndex];
        this.roundRobinIndex++;
        return entry;
    }

    /**
     * Random selection with weight support
     * Proxies with higher weight have proportionally higher selection chance
     */
    _getRandomWeighted(active) {
        const totalWeight = active.reduce((sum, e) => sum + e.weight, 0);
        let random = Math.random() * totalWeight;

        for (const entry of active) {
            random -= entry.weight;
            if (random <= 0) return entry;
        }
        return active[active.length - 1]; // Fallback
    }

    /**
     * Select least-used proxy (fewest total requests)
     */
    _getLeastUsed(active) {
        return active.reduce((min, entry) => {
            return entry.totalRequests < min.totalRequests ? entry : min;
        }, active[0]);
    }

    // ============ Health Check ============

    /**
     * Start periodic health checks
     * Tries to re-enable disabled proxies after cooldown
     */
    _startHealthChecks() {
        this.healthCheckTimer = setInterval(() => {
            const disabled = this.entries.filter(e => !e.enabled);

            if (disabled.length === 0) return;

            logger.info(`🔍 Health check: ${disabled.length} disabled proxies`);

            disabled.forEach(entry => {
                const cooldownMs = Math.min(
                    entry.consecutiveFailures * 30000,  // 30s per failure
                    300000  // Max 5 min cooldown
                );
                const elapsed = Date.now() - entry.disabledAt;

                if (elapsed >= cooldownMs) {
                    entry.resetFailures();
                    logger.info(`   🔄 Re-enabled ${entry.id} (cooldown expired: ${Math.round(elapsed / 1000)}s)`);
                } else {
                    const remaining = Math.round((cooldownMs - elapsed) / 1000);
                    logger.info(`   ⏳ ${entry.id} still cooling down (${remaining}s remaining)`);
                }
            });
        }, this.healthCheckInterval);
    }
}

// ============================================================
// Helper: Parse proxy pool from config UI
// ============================================================

/**
 * Create ProxyPool from UI configuration
 * This is the main entry point called from visitLogic.js
 * 
 * @param {Object} config - Configuration from UI
 * @param {string} config.proxyUrl - Single or multiple proxy URLs
 * @param {string} config.proxyStrategy - 'round-robin' | 'random' | 'least-used'
 * @param {number} config.proxyMaxFailures - Max failures before disable
 * @param {boolean} config.proxyStickySession - Use sticky sessions
 * @param {string} config.proxyWeights - Comma-separated weights
 * @returns {ProxyPool}
 */
function createProxyPool(config = {}) {
    return new ProxyPool({
        proxies: config.proxyUrl || '',
        strategy: config.proxyStrategy || 'round-robin',
        maxFailures: parseInt(config.proxyMaxFailures) || 3,
        stickySession: config.proxyStickySession || false,
        healthCheckInterval: 60000, // 1 minute
        weights: config.proxyWeights || '',
    });
}

module.exports = {
    ProxyPool,
    ProxyEntry,
    createProxyPool,
};
