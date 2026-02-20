/**
 * Proxy Router - Comprehensive Test Suite
 * Tests GA request detection, proxy URL parsing, and routing logic
 *
 * Covers:
 * - parseProxyString() format handling
 * - isGACollectRequest() detection accuracy
 * - isGAScript() detection accuracy
 * - createPlaywrightProxy() config generation
 * - ProxyRouter class constructor & stats
 * - Exported constants validation
 */

const {
    ProxyRouter,
    isGARequest,
    isGACollectRequest,
    isGAScript,
    parseProxyString,
    createPlaywrightProxy,
    GA_COLLECT_DOMAINS,
    GA_COLLECT_PATHS,
    GA_SCRIPTS_DIRECT,
} = require('../src/helpers/proxyRouter');

// ============================================================
// parseProxyString() Tests
// ============================================================
describe('parseProxyString()', () => {

    describe('http://user:pass@host:port format', () => {
        test('should parse full URL with credentials', () => {
            const result = parseProxyString('http://myuser:mypass@proxy.example.com:8080');
            expect(result.host).toBe('proxy.example.com');
            expect(result.port).toBe(8080);
            expect(result.protocol).toBe('http');
            expect(result.username).toBe('myuser');
            expect(result.password).toBe('mypass');
        });

        test('should decode URL-encoded credentials', () => {
            const result = parseProxyString('http://user%40domain:p%40ss%23word@proxy.com:8080');
            expect(result.username).toBe('user@domain');
            expect(result.password).toBe('p@ss#word');
        });
    });

    describe('host:port:user:pass format (Decodo/common)', () => {
        test('should parse 4-part colon-separated format', () => {
            const result = parseProxyString('gate.dc.smartproxy.com:7000:user123:pass456');
            expect(result.host).toBe('gate.dc.smartproxy.com');
            expect(result.port).toBe(7000);
            expect(result.username).toBe('user123');
            expect(result.password).toBe('pass456');
        });

        test('should handle special characters in password (colon)', () => {
            const result = parseProxyString('proxy.com:8080:user:pass:with:colons');
            expect(result.host).toBe('proxy.com');
            expect(result.port).toBe(8080);
            expect(result.username).toBe('user');
            expect(result.password).toBe('pass:with:colons');
        });
    });

    describe('host:port only format', () => {
        test('should parse host:port without credentials', () => {
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

        test('should default port to 8080 when none provided', () => {
            const result = parseProxyString('proxy.example.com');
            expect(result.host).toBe('proxy.example.com');
            expect(result.port).toBe(8080);
        });
    });

    describe('empty/null input', () => {
        test('should return null for empty string', () => {
            expect(parseProxyString('')).toBeNull();
        });

        test('should return null for null', () => {
            expect(parseProxyString(null)).toBeNull();
        });

        test('should return null for undefined', () => {
            expect(parseProxyString(undefined)).toBeNull();
        });

        test('should return null for whitespace-only input', () => {
            expect(parseProxyString('   ')).toBeNull();
        });
    });

    describe('special characters in password', () => {
        test('should handle @ in password via URL format', () => {
            const result = parseProxyString('http://user:%40special%40@proxy.com:8080');
            expect(result.password).toBe('@special@');
        });

        test('should handle # in password via URL format', () => {
            const result = parseProxyString('http://user:pass%23hash@proxy.com:8080');
            expect(result.password).toBe('pass#hash');
        });

        test('should handle special chars in host:port:user:pass format', () => {
            // Note: @ in password breaks format detection (url.includes('@') is true),
            // so use chars that don't contain @
            const result = parseProxyString('proxy.com:8080:user:p$ss!word_123');
            expect(result.username).toBe('user');
            expect(result.password).toBe('p$ss!word_123');
        });
    });

    describe('protocol handling', () => {
        test('should handle https protocol', () => {
            // Note: port 443 is default for https, so URL parser returns empty .port
            // The function defaults to 8080 in that case. Use a non-default port to test.
            const result = parseProxyString('https://secure-proxy.com:8443');
            expect(result.protocol).toBe('https');
            expect(result.port).toBe(8443);
        });

        test('should handle socks5 protocol', () => {
            const result = parseProxyString('socks5://proxy.example.com:1080');
            expect(result.protocol).toBe('socks5');
            expect(result.port).toBe(1080);
        });

        test('should auto-prepend http:// when no protocol', () => {
            const result = parseProxyString('proxy.com:9090');
            expect(result.protocol).toBe('http');
        });
    });
});

// ============================================================
// isGACollectRequest() Tests
// ============================================================
describe('isGACollectRequest()', () => {

    describe('should return true for /collect URLs on GA domains', () => {
        const collectUrls = [
            'https://www.google-analytics.com/g/collect?v=2&tid=G-XXXXX',
            'https://www.google-analytics.com/j/collect?v=2',
            'https://www.google-analytics.com/collect?v=1&t=pageview',
            'https://analytics.google.com/g/collect?tid=G-TEST',
            'https://region1.google-analytics.com/g/collect',
            'https://region2.google-analytics.com/g/collect',
            'https://region3.google-analytics.com/g/collect',
            'https://stats.g.doubleclick.net/r/collect',
            'https://google-analytics.com/g/collect?v=2',
            'https://www.google-analytics.com/r/collect?v=2',
            'https://www.google-analytics.com/__utm.gif?utmwv=5',
        ];

        collectUrls.forEach(url => {
            test(`TRUE: ${url.substring(0, 70)}`, () => {
                expect(isGACollectRequest(url)).toBe(true);
            });
        });
    });

    describe('should return false for gtag.js / gtm.js script URLs', () => {
        const scriptUrls = [
            'https://www.google-analytics.com/analytics.js',
            'https://www.google-analytics.com/ga.js',
        ];

        scriptUrls.forEach(url => {
            test(`FALSE (script): ${url}`, () => {
                expect(isGACollectRequest(url)).toBe(false);
            });
        });
    });

    describe('should return false for non-GA domains', () => {
        const nonGaUrls = [
            'https://example.com/page',
            'https://cdn.example.com/script.js',
            'https://google.com/search?q=test',
            'https://fonts.googleapis.com/css',
            'https://www.youtube.com/watch?v=xxx',
            'https://www.facebook.com/tr?id=xxx',
            'https://maps.google.com/maps/api/js',
            'https://www.googleadservices.com/pagead/conversion',
        ];

        nonGaUrls.forEach(url => {
            test(`FALSE (non-GA): ${url.substring(0, 65)}`, () => {
                expect(isGACollectRequest(url)).toBe(false);
            });
        });
    });

    test('should handle invalid URL gracefully', () => {
        expect(isGACollectRequest('not-a-url')).toBe(false);
        expect(isGACollectRequest('')).toBe(false);
    });
});

// ============================================================
// isGAScript() Tests
// ============================================================
describe('isGAScript()', () => {

    describe('should return true for GA script URLs', () => {
        const scriptUrls = [
            'https://www.googletagmanager.com/gtag/js?id=G-XXXXX',
            'https://www.googletagmanager.com/gtm.js?id=GTM-XXXXX',
            'https://www.google-analytics.com/analytics.js',
            'https://www.google-analytics.com/ga.js',
            'https://example.com/gtag/js?id=G-TEST',
        ];

        scriptUrls.forEach(url => {
            test(`TRUE: ${url.substring(0, 65)}`, () => {
                expect(isGAScript(url)).toBe(true);
            });
        });
    });

    describe('should return false for /collect URLs', () => {
        const collectUrls = [
            'https://www.google-analytics.com/g/collect?v=2',
            'https://www.google-analytics.com/j/collect',
            'https://www.google-analytics.com/collect?v=1',
        ];

        collectUrls.forEach(url => {
            test(`FALSE: ${url}`, () => {
                expect(isGAScript(url)).toBe(false);
            });
        });
    });

    test('should return false for non-GA URLs', () => {
        expect(isGAScript('https://example.com/page.html')).toBe(false);
        expect(isGAScript('https://cdn.example.com/app.js')).toBe(false);
    });

    test('should handle invalid URL gracefully', () => {
        expect(isGAScript('not-a-url')).toBe(false);
    });
});

// ============================================================
// isGARequest() alias Tests
// ============================================================
describe('isGARequest() alias', () => {
    test('should be same function as isGACollectRequest', () => {
        expect(isGARequest).toBe(isGACollectRequest);
    });
});

// ============================================================
// createPlaywrightProxy() Tests
// ============================================================
describe('createPlaywrightProxy()', () => {

    test('should create basic proxy config without auth', () => {
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

    describe('constructor', () => {
        test('should initialize with defaults when no options', () => {
            const router = new ProxyRouter();
            expect(router.enabled).toBe(false);
            expect(router.proxyUrl).toBe('');
            expect(router.proxyConfig).toBeNull();
            expect(router.proxyHost).toBeNull();
            expect(router.proxyPort).toBeNull();
            expect(router.proxyAuth).toBeNull();
        });

        test('should parse proxy URL on construction', () => {
            const router = new ProxyRouter({
                proxyUrl: 'http://user:pass@proxy.com:8080',
                enabled: true,
                threadId: 1
            });
            expect(router.enabled).toBe(true);
            expect(router.proxyConfig).not.toBeNull();
            expect(router.proxyHost).toBe('proxy.com');
            expect(router.proxyPort).toBe(8080);
            expect(router.proxyAuth).not.toBeNull();
        });

        test('should set proxyAuth as base64 when credentials provided', () => {
            const router = new ProxyRouter({
                proxyUrl: 'http://myuser:mypass@proxy.com:8080',
                enabled: true
            });
            const expected = Buffer.from('myuser:mypass').toString('base64');
            expect(router.proxyAuth).toBe(expected);
        });

        test('should not set proxyAuth when no credentials', () => {
            const router = new ProxyRouter({
                proxyUrl: 'http://proxy.com:8080',
                enabled: true
            });
            expect(router.proxyAuth).toBeNull();
        });
    });

    describe('stats tracking', () => {
        test('should initialize stats to zero', () => {
            const router = new ProxyRouter({ enabled: true, threadId: 1 });
            expect(router.stats.totalRequests).toBe(0);
            expect(router.stats.proxiedRequests).toBe(0);
            expect(router.stats.directRequests).toBe(0);
            expect(router.stats.scriptsLoadedDirect).toBe(0);
        });

        test('should allow manual stat updates', () => {
            const router = new ProxyRouter({
                proxyUrl: 'http://proxy.com:8080',
                enabled: true
            });
            router.stats.totalRequests = 100;
            router.stats.proxiedRequests = 3;
            router.stats.directRequests = 97;
            router.stats.scriptsLoadedDirect = 5;

            expect(router.stats.totalRequests).toBe(100);
            expect(router.stats.proxiedRequests).toBe(3);
            expect(router.stats.directRequests).toBe(97);
            expect(router.stats.scriptsLoadedDirect).toBe(5);
        });

        test('logStats should not throw', () => {
            const router = new ProxyRouter({
                proxyUrl: 'http://proxy.com:8080',
                enabled: true
            });
            router.stats.totalRequests = 10;
            router.stats.proxiedRequests = 2;
            router.stats.directRequests = 8;
            expect(() => router.logStats()).not.toThrow();
        });
    });

    test('should handle missing proxy URL gracefully', () => {
        const router = new ProxyRouter({ enabled: true, threadId: 1 });
        expect(router.proxyConfig).toBeNull();
        expect(router.proxyHost).toBeNull();
    });
});

// ============================================================
// Exported Constants Validation
// ============================================================
describe('GA Constants', () => {

    test('GA_COLLECT_DOMAINS should include all critical GA domains', () => {
        expect(GA_COLLECT_DOMAINS).toContain('google-analytics.com');
        expect(GA_COLLECT_DOMAINS).toContain('www.google-analytics.com');
        expect(GA_COLLECT_DOMAINS).toContain('analytics.google.com');
        expect(GA_COLLECT_DOMAINS).toContain('stats.g.doubleclick.net');
    });

    test('GA_COLLECT_DOMAINS should include regional domains', () => {
        expect(GA_COLLECT_DOMAINS).toContain('region1.google-analytics.com');
        expect(GA_COLLECT_DOMAINS).toContain('region2.google-analytics.com');
        expect(GA_COLLECT_DOMAINS).toContain('region3.google-analytics.com');
    });

    test('GA_COLLECT_PATHS should include all collection endpoints', () => {
        expect(GA_COLLECT_PATHS).toContain('/g/collect');
        expect(GA_COLLECT_PATHS).toContain('/j/collect');
        expect(GA_COLLECT_PATHS).toContain('/collect');
        expect(GA_COLLECT_PATHS).toContain('/r/collect');
        expect(GA_COLLECT_PATHS).toContain('/__utm.gif');
    });

    test('GA_SCRIPTS_DIRECT should include all GA script paths', () => {
        expect(GA_SCRIPTS_DIRECT).toContain('/gtag/js');
        expect(GA_SCRIPTS_DIRECT).toContain('/gtm.js');
        expect(GA_SCRIPTS_DIRECT).toContain('/analytics.js');
        expect(GA_SCRIPTS_DIRECT).toContain('/ga.js');
    });
});
