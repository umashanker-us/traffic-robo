/**
 * Proxy Router - Selective proxy routing for GA4 /collect requests ONLY
 * 
 * How GA4 Location Works:
 * - Location is determined by IP of /collect request (the data beacon)
 * - Script loading IP doesn't matter for location
 * - So we only need to proxy /collect = near-zero bandwidth
 * 
 * PROXIED (affects location):
 * - /g/collect, /j/collect, /collect, /r/collect, /__utm.gif
 * 
 * DIRECT (doesn't affect location):
 * - gtag.js, gtm.js, analytics.js + everything else
 */

const { getLogger } = require('./logger');
const http = require('http');
const { URL } = require('url');

const logger = getLogger();

// GA4 domains where /collect endpoints live
const GA_COLLECT_DOMAINS = [
    'google-analytics.com',
    'www.google-analytics.com',
    'analytics.google.com',
    'region1.google-analytics.com',
    'region2.google-analytics.com',
    'region3.google-analytics.com',
    'stats.g.doubleclick.net',
];

// ONLY /collect endpoints — these determine GA4 location
const GA_COLLECT_PATHS = [
    '/g/collect',
    '/j/collect',
    '/collect',
    '/r/collect',
    '/__utm.gif',
];

// Scripts that go DIRECT (not proxied)
const GA_SCRIPTS_DIRECT = [
    '/gtag/js',
    '/gtm.js',
    '/analytics.js',
    '/ga.js',
];

/**
 * Check if URL is a GA4 /collect request that needs proxying
 */
function isGACollectRequest(url) {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();
        const pathname = urlObj.pathname.toLowerCase();
        
        const isGADomain = GA_COLLECT_DOMAINS.some(domain => 
            hostname === domain || hostname.endsWith('.' + domain)
        );
        if (!isGADomain) return false;
        
        return GA_COLLECT_PATHS.some(path => 
            pathname.startsWith(path) || pathname.includes(path)
        );
    } catch {
        return false;
    }
}

const isGARequest = isGACollectRequest;

/**
 * Check if URL is a GA script (for logging)
 */
function isGAScript(url) {
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        return GA_SCRIPTS_DIRECT.some(script => pathname.includes(script));
    } catch {
        return false;
    }
}

/**
 * Parse proxy URL string
 * Supports:
 * - http://user:pass@host:port
 * - host:port:user:pass (Decodo/common format)
 * - host:port
 */
function parseProxyString(proxyString) {
    if (!proxyString || proxyString.trim() === '') return null;
    
    let url = proxyString.trim();
    
    // Detect host:port:user:pass format (no ://, no @, 4+ parts)
    if (!url.includes('://') && !url.includes('@')) {
        const parts = url.split(':');
        if (parts.length >= 4) {
            const host = parts[0];
            const port = parts[1];
            const user = parts[2];
            const pass = parts.slice(3).join(':');
            url = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
        }
    }
    
    if (!url.includes('://')) url = 'http://' + url;
    
    try {
        const parsed = new URL(url);
        return {
            protocol: parsed.protocol.replace(':', ''),
            host: parsed.hostname,
            port: parseInt(parsed.port) || 8080,
            username: parsed.username ? decodeURIComponent(parsed.username) : null,
            password: parsed.password ? decodeURIComponent(parsed.password) : null,
            full: `${parsed.protocol}//${parsed.host}`
        };
    } catch (error) {
        logger.warn(`Invalid proxy format: ${proxyString.substring(0, 80)}${proxyString.length > 80 ? '...' : ''}`);
        return null;
    }
}

function createPlaywrightProxy(proxyConfig) {
    if (!proxyConfig) return null;
    const proxy = { server: `${proxyConfig.protocol}://${proxyConfig.host}:${proxyConfig.port}` };
    if (proxyConfig.username) proxy.username = proxyConfig.username;
    if (proxyConfig.password) proxy.password = proxyConfig.password;
    return proxy;
}

/**
 * ProxyRouter — /collect-only proxy routing with stats
 */
class ProxyRouter {
    constructor(options = {}) {
        this.enabled = options.enabled || false;
        this.proxyUrl = options.proxyUrl || '';
        this.proxyConfig = parseProxyString(this.proxyUrl);
        this.threadId = options.threadId || 0;
        this.logger = getLogger(this.threadId);
        
        this.proxyHost = null;
        this.proxyPort = null;
        this.proxyAuth = null;
        
        if (this.proxyConfig) {
            this.proxyHost = this.proxyConfig.host;
            this.proxyPort = this.proxyConfig.port;
            if (this.proxyConfig.username && this.proxyConfig.password) {
                this.proxyAuth = Buffer.from(
                    `${this.proxyConfig.username}:${this.proxyConfig.password}`
                ).toString('base64');
            }
        }
        
        this.stats = { totalRequests: 0, proxiedRequests: 0, directRequests: 0, scriptsLoadedDirect: 0 };
        
        if (this.enabled && this.proxyConfig) {
            this.logger.info(`Proxy: ${this.proxyConfig.host}:${this.proxyConfig.port}`);
            this.logger.info(`Only /collect endpoints proxied (scripts + page DIRECT)`);
        }
    }
    
    /**
     * Proxy a /collect request via plain HTTP to proxy server
     * NO CONNECT tunnel — proxy handles HTTPS internally
     * Works with Decodo and all providers
     */
    async makeProxiedRequest(request, urlOverride) {
        return new Promise((resolve, reject) => {
            const finalUrl = urlOverride || request.url();
            const targetUrl = new URL(finalUrl);

            const headers = { ...request.headers(), 'Host': targetUrl.host };
            // Remove Playwright pseudo-headers
            delete headers[':authority'];
            delete headers[':method'];
            delete headers[':path'];
            delete headers[':scheme'];

            if (this.proxyAuth) {
                headers['Proxy-Authorization'] = `Basic ${this.proxyAuth}`;
            }

            const req = http.request({
                hostname: this.proxyHost,
                port: this.proxyPort,
                method: request.method(),
                path: finalUrl,
                headers,
                timeout: 30000,
            }, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve({
                    status: res.statusCode || 200,
                    headers: res.headers || {},
                    body: Buffer.concat(chunks),
                }));
            });
            
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Proxy timeout')); });
            const postData = request.postData();
            if (postData) req.write(postData);
            req.end();
        });
    }
    
    logStats() {
        const t = this.stats.totalRequests || 1;
        const pPct = ((this.stats.proxiedRequests / t) * 100).toFixed(1);
        const dPct = ((this.stats.directRequests / t) * 100).toFixed(1);
        this.logger.info(`=== Proxy Stats: Proxied ${this.stats.proxiedRequests} (${pPct}%) | Direct ${this.stats.directRequests} (${dPct}%) | Scripts direct: ${this.stats.scriptsLoadedDirect} ===`);
    }
}

module.exports = {
    ProxyRouter,
    isGARequest,
    isGACollectRequest,
    isGAScript,
    parseProxyString,
    createPlaywrightProxy,
    GA_COLLECT_DOMAINS,
    GA_COLLECT_PATHS,
    GA_SCRIPTS_DIRECT,
};
