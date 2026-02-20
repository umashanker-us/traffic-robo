/**
 * Proxy Pool Manager - Automated Test Suite
 */

const { ProxyPool, ProxyEntry, createProxyPool } = require('../src/helpers/proxyPool');

// ============================================================
// ProxyEntry Tests
// ============================================================
describe('ProxyEntry', () => {

    test('should parse valid proxy string', () => {
        const entry = new ProxyEntry('http://user:pass@proxy1.com:8080');
        expect(entry.config).not.toBeNull();
        expect(entry.config.host).toBe('proxy1.com');
        expect(entry.config.port).toBe(8080);
        expect(entry.enabled).toBe(true);
    });

    test('recordSuccess should update stats', () => {
        const entry = new ProxyEntry('proxy.com:8080');
        entry.recordSuccess(150);
        entry.recordSuccess(250);
        expect(entry.totalRequests).toBe(2);
        expect(entry.successCount).toBe(2);
        expect(entry.getAvgLatency()).toBe(200);
        expect(entry.getSuccessRate()).toBe(100);
    });

    test('recordFailure should disable after maxFailures', () => {
        const entry = new ProxyEntry('proxy.com:8080');
        entry.recordFailure(3);
        entry.recordFailure(3);
        expect(entry.enabled).toBe(true);
        entry.recordFailure(3);
        expect(entry.enabled).toBe(false);
    });

    test('recordSuccess should re-enable disabled proxy', () => {
        const entry = new ProxyEntry('proxy.com:8080');
        entry.recordFailure(1);
        expect(entry.enabled).toBe(false);
        entry.recordSuccess(100);
        expect(entry.enabled).toBe(true);
    });

    test('getPlaywrightConfig should return correct format', () => {
        const entry = new ProxyEntry('http://user:pass@proxy.com:8080');
        const config = entry.getPlaywrightConfig();
        expect(config.server).toBe('http://proxy.com:8080');
        expect(config.username).toBe('user');
        expect(config.password).toBe('pass');
    });
});

// ============================================================
// ProxyPool - Initialization
// ============================================================
describe('ProxyPool - Initialization', () => {

    test('should parse comma-separated proxies', () => {
        const pool = new ProxyPool({ proxies: 'p1.com:8080, p2.com:3128, p3.com:8888' });
        expect(pool.totalCount).toBe(3);
        expect(pool.activeCount).toBe(3);
    });

    test('should parse newline-separated proxies', () => {
        const pool = new ProxyPool({ proxies: 'p1.com:8080\np2.com:3128\np3.com:8888' });
        expect(pool.totalCount).toBe(3);
    });

    test('should handle inline weight syntax', () => {
        const pool = new ProxyPool({ proxies: 'p1.com:8080[w=5], p2.com:3128[w=1]' });
        expect(pool.entries[0].weight).toBe(5);
        expect(pool.entries[1].weight).toBe(1);
    });

    test('should handle separate weights parameter', () => {
        const pool = new ProxyPool({ proxies: 'p1.com:8080, p2.com:3128', weights: '3,1' });
        expect(pool.entries[0].weight).toBe(3);
        expect(pool.entries[1].weight).toBe(1);
    });

    test('should handle empty proxy list', () => {
        const pool = new ProxyPool({ proxies: '' });
        expect(pool.totalCount).toBe(0);
        expect(pool.hasProxies).toBe(false);
    });

    test('should handle single proxy (backward compatible)', () => {
        const pool = new ProxyPool({ proxies: 'http://user:pass@proxy.com:8080' });
        expect(pool.totalCount).toBe(1);
        expect(pool.hasProxies).toBe(true);
    });

    test('should skip empty entries', () => {
        const pool = new ProxyPool({ proxies: 'p1.com:8080,, ,\n\np2.com:3128' });
        expect(pool.totalCount).toBe(2);
    });
});

// ============================================================
// ProxyPool - Round Robin Strategy
// ============================================================
describe('ProxyPool - Round Robin', () => {

    test('should cycle through proxies in order', () => {
        const pool = new ProxyPool({
            proxies: 'p1.com:8080, p2.com:8080, p3.com:8080',
            strategy: 'round-robin'
        });
        expect(pool.getNext().id).toBe('p1.com:8080');
        expect(pool.getNext().id).toBe('p2.com:8080');
        expect(pool.getNext().id).toBe('p3.com:8080');
        expect(pool.getNext().id).toBe('p1.com:8080');
    });

    test('should skip disabled proxies', () => {
        const pool = new ProxyPool({
            proxies: 'p1.com:8080, p2.com:8080, p3.com:8080',
            strategy: 'round-robin', maxFailures: 1
        });
        pool.entries[1].recordFailure(1); // disable p2
        const ids = [];
        for (let i = 0; i < 4; i++) ids.push(pool.getNext().id);
        expect(ids).not.toContain('p2.com:8080');
    });

    test('should return null when all proxies disabled', () => {
        const pool = new ProxyPool({
            proxies: 'p1.com:8080, p2.com:8080', maxFailures: 1
        });
        pool.entries[0].recordFailure(1);
        pool.entries[1].recordFailure(1);
        expect(pool.getNext()).toBeNull();
    });
});

// ============================================================
// ProxyPool - Random Strategy
// ============================================================
describe('ProxyPool - Random', () => {

    test('should eventually use all proxies', () => {
        const pool = new ProxyPool({
            proxies: 'p1.com:8080, p2.com:8080, p3.com:8080',
            strategy: 'random'
        });
        const seen = new Set();
        for (let i = 0; i < 100; i++) {
            seen.add(pool.getNext().id);
        }
        expect(seen.size).toBe(3);
    });

    test('weighted selection should favor higher weights (statistical)', () => {
        const pool = new ProxyPool({
            proxies: 'heavy.com:8080[w=10], light.com:8080[w=1]',
            strategy: 'random'
        });
        let heavyCount = 0;
        for (let i = 0; i < 1000; i++) {
            if (pool.getNext().id === 'heavy.com:8080') heavyCount++;
        }
        // heavy should be ~91% (10/11), allow wide margin
        expect(heavyCount).toBeGreaterThan(700);
    });
});

// ============================================================
// ProxyPool - Least Used Strategy
// ============================================================
describe('ProxyPool - Least Used', () => {

    test('should select proxy with fewest requests', () => {
        const pool = new ProxyPool({
            proxies: 'p1.com:8080, p2.com:8080, p3.com:8080',
            strategy: 'least-used'
        });
        // Use p1 and p2 a lot
        pool.entries[0].totalRequests = 50;
        pool.entries[1].totalRequests = 30;
        pool.entries[2].totalRequests = 5;

        // Should pick p3 (least used)
        expect(pool.getNext().id).toBe('p3.com:8080');
    });
});

// ============================================================
// ProxyPool - Sticky Sessions
// ============================================================
describe('ProxyPool - Sticky Sessions', () => {

    test('same session should always get same proxy', () => {
        const pool = new ProxyPool({
            proxies: 'p1.com:8080, p2.com:8080, p3.com:8080',
            strategy: 'round-robin', stickySession: true
        });

        const proxy1 = pool.getForSession('session-1');
        const proxy2 = pool.getForSession('session-1');
        const proxy3 = pool.getForSession('session-1');

        expect(proxy1.id).toBe(proxy2.id);
        expect(proxy2.id).toBe(proxy3.id);
    });

    test('different sessions should potentially get different proxies', () => {
        const pool = new ProxyPool({
            proxies: 'p1.com:8080, p2.com:8080, p3.com:8080',
            strategy: 'round-robin', stickySession: true
        });

        const s1 = pool.getForSession('session-1');
        const s2 = pool.getForSession('session-2');
        const s3 = pool.getForSession('session-3');

        // Round-robin should give different proxies to different sessions
        expect(s1.id).toBe('p1.com:8080');
        expect(s2.id).toBe('p2.com:8080');
        expect(s3.id).toBe('p3.com:8080');
    });

    test('should reassign if sticky proxy gets disabled', () => {
        const pool = new ProxyPool({
            proxies: 'p1.com:8080, p2.com:8080',
            strategy: 'round-robin', stickySession: true, maxFailures: 1
        });

        const first = pool.getForSession('session-1');
        expect(first.id).toBe('p1.com:8080');

        // Disable p1
        pool.entries[0].recordFailure(1);
        
        const second = pool.getForSession('session-1');
        expect(second.id).toBe('p2.com:8080');
    });

    test('releaseSession should clear sticky assignment', () => {
        const pool = new ProxyPool({
            proxies: 'p1.com:8080, p2.com:8080',
            strategy: 'round-robin', stickySession: true
        });

        pool.getForSession('session-1'); // Assigned p1
        pool.releaseSession('session-1');
        
        // After release, might get a different proxy
        expect(pool.sessionMap.has('session-1')).toBe(false);
    });
});

// ============================================================
// ProxyPool - Failover & Health
// ============================================================
describe('ProxyPool - Failover', () => {

    test('reportSuccess should update entry', () => {
        const pool = new ProxyPool({ proxies: 'p1.com:8080' });
        const entry = pool.getNext();
        pool.reportSuccess(entry, 200);
        expect(entry.successCount).toBe(1);
        expect(entry.totalLatencyMs).toBe(200);
    });

    test('reportFailure should disable after maxFailures', () => {
        const pool = new ProxyPool({ proxies: 'p1.com:8080, p2.com:8080', maxFailures: 2 });
        const entry = pool.entries[0];
        pool.reportFailure(entry);
        pool.reportFailure(entry);
        expect(entry.enabled).toBe(false);
        expect(pool.activeCount).toBe(1);
    });

    test('resetAll should re-enable all proxies', () => {
        const pool = new ProxyPool({ proxies: 'p1.com:8080, p2.com:8080', maxFailures: 1 });
        pool.entries.forEach(e => e.recordFailure(1));
        expect(pool.activeCount).toBe(0);

        pool.resetAll();
        expect(pool.activeCount).toBe(2);
    });
});

// ============================================================
// ProxyPool - Stats
// ============================================================
describe('ProxyPool - Stats', () => {

    test('getStats should return complete stats object', () => {
        const pool = new ProxyPool({
            proxies: 'p1.com:8080, p2.com:8080',
            strategy: 'round-robin', stickySession: true
        });
        pool.getForSession('s1');

        const stats = pool.getStats();
        expect(stats.totalProxies).toBe(2);
        expect(stats.activeProxies).toBe(2);
        expect(stats.disabledProxies).toBe(0);
        expect(stats.strategy).toBe('round-robin');
        expect(stats.stickySession).toBe(true);
        expect(stats.activeSessions).toBe(1);
        expect(stats.proxies).toHaveLength(2);
    });
});

// ============================================================
// ProxyPool - Playwright Config
// ============================================================
describe('ProxyPool - Playwright Config', () => {

    test('getNextPlaywrightConfig should return valid config', () => {
        const pool = new ProxyPool({ proxies: 'http://u:p@proxy.com:8080' });
        const config = pool.getNextPlaywrightConfig();
        expect(config.server).toBe('http://proxy.com:8080');
        expect(config.username).toBe('u');
        expect(config.password).toBe('p');
    });

    test('getNextPlaywrightConfig should return null when no proxies', () => {
        const pool = new ProxyPool({ proxies: '' });
        expect(pool.getNextPlaywrightConfig()).toBeNull();
    });

    test('getPlaywrightConfigForSession should work with sticky', () => {
        const pool = new ProxyPool({
            proxies: 'http://u:p@proxy.com:8080', stickySession: true
        });
        const config = pool.getPlaywrightConfigForSession('session-1');
        expect(config).not.toBeNull();
        expect(config.server).toContain('proxy.com');
    });
});

// ============================================================
// createProxyPool Helper
// ============================================================
describe('createProxyPool()', () => {

    test('should create pool from config object', () => {
        const pool = createProxyPool({
            proxyUrl: 'p1.com:8080, p2.com:3128',
            proxyStrategy: 'random',
            proxyMaxFailures: 5,
            proxyStickySession: true,
        });
        expect(pool.totalCount).toBe(2);
        expect(pool.strategy).toBe('random');
        expect(pool.maxFailures).toBe(5);
        expect(pool.stickySession).toBe(true);
    });

    test('should handle empty config', () => {
        const pool = createProxyPool({});
        expect(pool.totalCount).toBe(0);
    });

    test('should use defaults for missing fields', () => {
        const pool = createProxyPool({ proxyUrl: 'p.com:8080' });
        expect(pool.strategy).toBe('round-robin');
        expect(pool.maxFailures).toBe(3);
        expect(pool.stickySession).toBe(false);
    });
});

// ============================================================
// Cleanup
// ============================================================
describe('ProxyPool - Cleanup', () => {

    test('destroy should clear timers and sessions', () => {
        const pool = new ProxyPool({
            proxies: 'p1.com:8080',
            stickySession: true
        });
        pool.getForSession('s1');
        pool.destroy();
        expect(pool.sessionMap.size).toBe(0);
    });
});
