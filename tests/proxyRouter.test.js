/**
 * Proxy Router - Automated Test Suite
 * Tests GA request detection, proxy URL parsing, and routing logic
 * 
 * Covers:
 * - isGARequest() detection accuracy
 * - parseProxyString() format handling
 * - buildProxyUrl() URL encoding
 * - createPlaywrightProxy() config generation
 * - ProxyRouter class stats tracking
 * - Edge cases & security
 */

const {
    ProxyRouter,
    isGARequest,
    parseProxyString,
    buildProxyUrl,
    createPlaywrightProxy,
    GA_DOMAINS,
    GA_PATTERNS
} = require('../src/helpers/proxyRouter');

// ============================================================
// isGARequest() Tests
// ============================================================
describe('isGARequest()', () => {

    describe('should detect GA/tracking URLs', () => {
        const gaUrls = [
            'https://www.google-analytics.com/g/collect?v=2&tid=G-XXXXX',
            'https://www.google-analytics.com/analytics.js',
            'https://www.google-analytics.com/collect?v=1&t=pageview',
            'https://www.googletagmanager.com/gtag/js?id=G-XXXXX',
            'https://www.googletagmanager.com/gtm.js?id=GTM-XXXXX',
            'https://analytics.google.com/g/collect',
            'https://region1.google-analytics.com/g/collect',
            'https://region2.google-analytics.com/g/collect',
            'https://region3.google-analytics.com/g/collect',
            'https://stats.g.doubleclick.net/r/collect',
            'https://google-analytics.com/j/collect',
            'https://googletagmanager.com/gtag/js?id=G-TEST',
        ];

        gaUrls.forEach(url => {
            test(`should detect: ${url.substring(0, 65)}...`, () => {
                expect(isGARequest(url)).toBe(true);
            });
        });
    });

    describe('should NOT detect non-GA URLs', () => {
        const nonGaUrls = [
            'https://example.com/page',
            'https://cdn.example.com/script.js',
            'https://google.com/search?q=test',
            'https://fonts.googleapis.com/css',
            'https://www.youtube.com/watch?v=xxx',
            'https://www.facebook.com/tr?id=xxx',
            'https://ajax.googleapis.com/ajax/libs/jquery/3.6.0/jquery.min.js',
            'https://maps.google.com/maps/api/js',
            'https://www.googleadservices.com/pagead/conversion',
            'https://example.com/images/logo.png',
            'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.min.js',
        ];

        nonGaUrls.forEach(url => {
            test(`should NOT detect: ${url.substring(0, 65)}...`, () => {
                expect(isGARequest(url)).toBe(false);
            });
        });
    });

    test('should handle invalid URL gracefully', () => {
        expect(isGARequest('not-a-url')).toBe(false);
        expect(isGARequest('')).toBe(false);
    });

    test('should detect GA path patterns on custom domains', () => {
        // Sites that proxy GA through their own domain
        expect(isGARequest('https://mysite.com/g/collect?v=2')).toBe(true);
        expect(isGARequest('https://mysite.com/gtag/js?id=G-XXX')).toBe(true);
    });
});

// ============================================================
// GA_DOMAINS and GA_PATTERNS data validation
// ============================================================
describe('GA Constants', () => {

    test('GA_DOMAINS should include all critical endpoints', () => {
        expect(GA_DOMAINS).toContain('google-analytics.com');
        expect(GA_DOMAINS).toContain('www.google-analytics.com');
        expect(GA_DOMAINS).toContain('analytics.google.com');
        expect(GA_DOMAINS).toContain('www.googletagmanager.com');
        expect(GA_DOMAINS).toContain('googletagmanager.com');
        expect(GA_DOMAINS).toContain('stats.g.doubleclick.net');
    });

    test('GA_PATTERNS should include all collection endpoints', () => {
        expect(GA_PATTERNS).toContain('/g/collect');
        expect(GA_PATTERNS).toContain('/j/collect');
        expect(GA_PATTERNS).toContain('/collect');
        expect(GA_PATTERNS).toContain('/gtag/js');
        expect(GA_PATTERNS).toContain('/gtm.js');
    });
});

// ============================================================
// parseProxyString() Tests
// ============================================================
describe('parseProxyString()', () => {

    test('should parse host:port format', () => {
        const result = parseProxyString('proxy.example.com:8080');
        expect(result.host).toBe('proxy.example.com');
        expect(result.port).toBe(8080);
        expect(result.protocol).toBe('http');
        expect(result.username).toBeNull();
        expect(result.password).toBeNull();
    });

    test('should parse http://host:port format', () => {
        const result = parseProxyString('http://proxy.example.com:3128');
        expect(result.host).toBe('proxy.example.com');
        expect(result.port).toBe(3128);
        expect(result.protocol).toBe('http');
    });

    test('should parse http://user:pass@host:port format', () => {
        const result = parseProxyString('http://myuser:mypass@proxy.example.com:8080');
        expect(result.host).toBe('proxy.example.com');
        expect(result.port).toBe(8080);
        expect(result.username).toBe('myuser');
        expect(result.password).toBe('mypass');
    });

    test('should parse socks5 protocol', () => {
        const result = parseProxyString('socks5://proxy.example.com:1080');
        expect(result.protocol).toBe('socks5');
        expect(result.host).toBe('proxy.example.com');
        expect(result.port).toBe(1080);
    });

    test('should decode URL-encoded credentials', () => {
        const result = parseProxyString('http://user%40domain:p%40ss%23word@proxy.com:8080');
        expect(result.username).toBe('user@domain');
        expect(result.password).toBe('p@ss#word');
    });

    test('should return null for empty input', () => {
        expect(parseProxyString('')).toBeNull();
        expect(parseProxyString(null)).toBeNull();
        expect(parseProxyString(undefined)).toBeNull();
    });

    test('should return null for whitespace-only input', () => {
        expect(parseProxyString('   ')).toBeNull();
    });

    test('should handle https protocol', () => {
        const result = parseProxyString('https://secure-proxy.com:443');
        expect(result.protocol).toBe('https');
        expect(result.port).toBe(443);
    });
});

// ============================================================
// buildProxyUrl() Tests
// ============================================================
describe('buildProxyUrl()', () => {

    test('should build basic URL without auth', () => {
        const url = buildProxyUrl('proxy.com', 8080);
        expect(url).toBe('http://proxy.com:8080');
    });

    test('should build URL with auth', () => {
        const url = buildProxyUrl('proxy.com', 8080, 'user', 'pass');
        expect(url).toBe('http://user:pass@proxy.com:8080');
    });

    test('should URL-encode special characters in credentials', () => {
        const url = buildProxyUrl('proxy.com', 8080, 'user@domain', 'p@ss#word');
        expect(url).toBe('http://user%40domain:p%40ss%23word@proxy.com:8080');
    });

    test('should URL-encode colons in credentials', () => {
        const url = buildProxyUrl('proxy.com', 8080, 'test:user', 'pass:123');
        expect(url).toBe('http://test%3Auser:pass%3A123@proxy.com:8080');
    });

    test('should return null for missing host', () => {
        expect(buildProxyUrl(null, 8080)).toBeNull();
        expect(buildProxyUrl('', 8080)).toBeNull();
    });

    test('should default to port 8080 when port is null', () => {
        const url = buildProxyUrl('proxy.com', null);
        expect(url).toBe('http://proxy.com:8080');
    });

    test('should support custom protocol', () => {
        const url = buildProxyUrl('proxy.com', 1080, null, null, 'socks5');
        expect(url).toBe('socks5://proxy.com:1080');
    });
});

// ============================================================
// createPlaywrightProxy() Tests
// ============================================================
describe('createPlaywrightProxy()', () => {

    test('should create basic proxy config', () => {
        const config = { protocol: 'http', host: 'proxy.com', port: 8080 };
        const result = createPlaywrightProxy(config);
        expect(result.server).toBe('http://proxy.com:8080');
        expect(result.username).toBeUndefined();
        expect(result.password).toBeUndefined();
    });

    test('should include auth when present', () => {
        const config = { protocol: 'http', host: 'proxy.com', port: 8080, username: 'user', password: 'pass' };
        const result = createPlaywrightProxy(config);
        expect(result.server).toBe('http://proxy.com:8080');
        expect(result.username).toBe('user');
        expect(result.password).toBe('pass');
    });

    test('should return null for null config', () => {
        expect(createPlaywrightProxy(null)).toBeNull();
    });
});

// ============================================================
// ProxyRouter Class Tests
// ============================================================
describe('ProxyRouter', () => {

    test('should initialize with correct defaults', () => {
        const router = new ProxyRouter({
            proxyUrl: 'http://proxy.com:8080',
            enabled: true,
            threadId: 1
        });
        expect(router.enabled).toBe(true);
        expect(router.proxyConfig).not.toBeNull();
        expect(router.stats.totalRequests).toBe(0);
    });

    test('shouldProxy should return true for GA URLs when enabled', () => {
        const router = new ProxyRouter({
            proxyUrl: 'http://proxy.com:8080',
            enabled: true,
            threadId: 1
        });
        expect(router.shouldProxy('https://www.google-analytics.com/g/collect')).toBe(true);
        expect(router.shouldProxy('https://www.googletagmanager.com/gtm.js')).toBe(true);
    });

    test('shouldProxy should return false for non-GA URLs', () => {
        const router = new ProxyRouter({
            proxyUrl: 'http://proxy.com:8080',
            enabled: true,
            threadId: 1
        });
        expect(router.shouldProxy('https://example.com/page')).toBe(false);
        expect(router.shouldProxy('https://cdn.example.com/script.js')).toBe(false);
    });

    test('shouldProxy should return false when disabled', () => {
        const router = new ProxyRouter({
            proxyUrl: 'http://proxy.com:8080',
            enabled: false,
            threadId: 1
        });
        expect(router.shouldProxy('https://www.google-analytics.com/g/collect')).toBe(false);
    });

    test('stats should track correctly', () => {
        const router = new ProxyRouter({
            proxyUrl: 'http://proxy.com:8080',
            enabled: true,
            threadId: 1
        });

        // Simulate: 3 GA requests, 97 direct
        for (let i = 0; i < 3; i++) router.incrementProxied();
        for (let i = 0; i < 97; i++) router.incrementDirect();

        const stats = router.getStats();
        expect(stats.totalRequests).toBe(100);
        expect(stats.proxiedRequests).toBe(3);
        expect(stats.directRequests).toBe(97);
        expect(stats.proxiedPercentage).toBe('3.00');
        expect(stats.directPercentage).toBe('97.00');
        expect(stats.bandwidthSaved).toBe('97.00%');
    });

    test('stats should handle 0 requests', () => {
        const router = new ProxyRouter({ enabled: true, threadId: 1 });
        const stats = router.getStats();
        expect(stats.totalRequests).toBe(0);
        expect(stats.proxiedPercentage).toBe(0);
        expect(stats.directPercentage).toBe(0);
    });

    test('should handle missing proxy URL', () => {
        const router = new ProxyRouter({ enabled: true, threadId: 1 });
        expect(router.proxyConfig).toBeNull();
        expect(router.shouldProxy('https://www.google-analytics.com/g/collect')).toBe(false);
    });
});
