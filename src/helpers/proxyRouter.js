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
 * Parse the multi-line user-supplied custom proxy pattern textarea into a
 * normalized array of lowercase substring matchers. Drops blanks and `#`
 * comment lines so users can annotate their list.
 */
function parseCustomProxyPatterns(raw) {
    if (!raw || typeof raw !== 'string') return [];
    return raw
        .split(/\r?\n/)
        .map(s => s.trim().toLowerCase())
        .filter(s => s.length > 0 && !s.startsWith('#'));
}

/**
 * Check if URL matches any user-supplied custom proxy pattern (substring).
 * Used to route additional endpoints (CM360 click trackers, custom redirect
 * chains, third-party pixels) through the proxy alongside GA4 /collect.
 *
 * Substring match was chosen deliberately — users paste real URLs from their
 * ad platforms and shouldn't need to write regex. Each redirect hop in a
 * chain is checked independently, so a multi-step redirect with all hops
 * matching the patterns gets every hop proxied.
 */
// If a caller ever forgets to pass an identity, a hop must still look like a
// browser. A bare "Mozilla/5.0" has no device token and no browser token, so a
// server-side log reads it as Device: Desktop, Browser: Mozilla — the exact
// row that made a whole click report look wrong. Using a complete UA means the
// worst case is one slightly stale Chrome, not an unidentifiable agent, and the
// warning below makes it visible instead of silent.
const FALLBACK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.8037.59 Safari/537.36';

// Extensions that are never a tracker hop and can be large. Images, .js and
// .css stay matchable: a 1x1 impression pixel is often a .gif or .png and does
// need the proxy IP for attribution, and those are all small.
const NEVER_PROXY_EXTENSIONS = [
    '.pdf', '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.iso',
    '.exe', '.msi', '.dmg', '.pkg', '.apk', '.deb', '.rpm',
    '.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v', '.flv',
    '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a',
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
];

/**
 * Is this URL a file download rather than a tracker hop?
 *
 * Judged on the path's extension only, so a query string carrying a click id
 * cannot make a .pdf look like a tracker.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isFileDownloadUrl(url) {
    let pathname;
    try {
        pathname = new URL(url).pathname.toLowerCase();
    } catch {
        return false;
    }
    return NEVER_PROXY_EXTENSIONS.some(ext => pathname.endsWith(ext));
}

/**
 * Does this URL match one of the user's custom proxy patterns?
 *
 * File downloads are excluded whatever the patterns say. A pattern is a plain
 * substring over the whole URL — that is what makes CM360 click ids matchable,
 * and it is also what let "e4mevents" match
 * storage.googleapis.com/e4mevents/Pitch-bfsi.pdf and send a 2.5 MB file
 * through the proxy on every visit. Proxying a file buys nothing: attribution
 * is decided by the tracker hop, not by who downloads the asset.
 *
 * @param {string} url
 * @param {string[]} patterns
 * @returns {boolean}
 */
function matchesCustomProxyPattern(url, patterns) {
    if (!patterns || patterns.length === 0) return false;
    if (isFileDownloadUrl(url)) return false;
    const lower = url.toLowerCase();
    return patterns.some(p => lower.includes(p));
}

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
        
        // Only affects the log line below — routing decisions live in the
        // visitors' route handlers.
        this.collectEnabled = options.collectEnabled !== false;

        this.stats = { totalRequests: 0, proxiedRequests: 0, directRequests: 0, scriptsLoadedDirect: 0 };
        
        if (this.enabled && this.proxyConfig) {
            this.logger.info(`Proxy: ${this.proxyConfig.host}:${this.proxyConfig.port}`);
            this.logger.info(this.collectEnabled
                ? `Only /collect endpoints proxied (scripts + page DIRECT)`
                : `/collect proxying OFF — custom URL patterns only (scripts, page and beacons DIRECT)`);
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
                res.on('end', () => {
                    // Strip hop-by-hop / framing headers so route.fulfill can pass
                    // the body cleanly. Node's http already dechunked the body, so
                    // leaving transfer-encoding=chunked makes Chromium think the
                    // body is still chunked and aborts top-frame navigations with
                    // ERR_ABORTED on redirect chains (CM360 / ad-tracker clicks).
                    const cleanHeaders = { ...(res.headers || {}) };
                    delete cleanHeaders['transfer-encoding'];
                    delete cleanHeaders['content-length'];
                    delete cleanHeaders['connection'];
                    delete cleanHeaders['keep-alive'];
                    delete cleanHeaders['proxy-connection'];
                    resolve({
                        status: res.statusCode || 200,
                        headers: cleanHeaders,
                        body: Buffer.concat(chunks),
                    });
                });
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

/**
 * Pre-resolve a redirect chain through the Decodo proxy in Node.js.
 *
 * Why this exists: Decodo's gateway accepts plain-HTTP forward proxy mode
 * (the same path /collect uses), but Chromium's native CONNECT tunnel
 * fails intermittently against the same gateway (ERR_TUNNEL_CONNECTION_FAILED).
 * route.fulfill of 3xx responses also doesn't survive top-frame navigation
 * for 3-hop click-tracker chains (ERR_ABORTED). So instead, we walk the
 * redirect chain ourselves, hop by hop, via Decodo — every hop hits an
 * upstream tracker with the proxy IP — then return the FINAL landing URL.
 * The browser then loads that URL DIRECT (cheap), with all tracking params
 * (dclid, UTMs) intact because they were appended by the upstream redirects.
 *
 * Parameters:
 *   startUrl       — the click-tracker URL pasted as campaign URL
 *   proxyConfig    — parsed proxy config from parseProxyString
 *   identity       — { userAgent, acceptLanguage, clientHints } of the visit
 *                    this chain belongs to, so a click log records the same
 *                    device and browser as the visit itself
 *   patterns       — parsed custom-proxy patterns (only URLs that match
 *                    these will be walked through the proxy; once the chain
 *                    leaves the patterns we stop and return the URL)
 *   logger         — optional logger
 *   maxHops        — safety cap on chain length (default 10)
 *
 * Returns: { finalUrl, hops: [{ url, status, viaProxy }] }
 */
async function resolveTrackerChain(startUrl, proxyConfig, patterns, logger = null, maxHops = 10, identity = {}) {
    if (logger && !identity.userAgent) {
        logger.warn('Tracker chain has no visit identity — hops will use a fallback user agent, so a click log will not match the visit');
    }
    const hops = [];
    let currentUrl = startUrl;
    const proxyAuth = (proxyConfig && proxyConfig.username && proxyConfig.password)
        ? Buffer.from(`${proxyConfig.username}:${proxyConfig.password}`).toString('base64')
        : null;

    for (let i = 0; i < maxHops; i++) {
        // matchesCustomProxyPattern already refuses file URLs, so a chain that
        // ends at a PDF stops here and the browser fetches it directly — the
        // tracker hops that precede it still went through the proxy, which is
        // what attribution actually depends on.
        const matchesPattern = matchesCustomProxyPattern(currentUrl, patterns);
        if (!matchesPattern) {
            if (logger && isFileDownloadUrl(currentUrl)) {
                logger.info(`Tracker chain ended at a file — not proxied: ${currentUrl.substring(0, 120)}`);
            }
            return { finalUrl: currentUrl, hops };
        }

        const hopResult = await new Promise((hopResolve) => {
            try {
                const targetUrl = new URL(currentUrl);
                // These hops are what an ad platform's click log actually
                // records, and they used to go out as a bare "Mozilla/5.0"
                // with Accept: */*. Parsed server-side that reads as
                // Device: Desktop, Browser: Mozilla for every click, whatever
                // the visit's real user agent was. Each hop now carries the
                // identity of the visit it belongs to.
                // A browser document navigation also carries the Sec-Fetch
                // metadata set and Accept-Encoding. Their absence on a document
                // request is one of the cheapest bot checks there is, so a hop
                // without them stands out however good its user agent is.
                // The first hop is user-initiated; the ones after it are
                // redirects, which a browser reports as cross-site without the
                // user flag.
                const firstHop = i === 0;
                const headers = Object.assign({
                    'Host': targetUrl.host,
                    'User-Agent': identity.userAgent || FALLBACK_USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': identity.acceptLanguage || 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': firstHop ? 'none' : 'cross-site',
                }, firstHop ? { 'Sec-Fetch-User': '?1' } : {}, identity.clientHints || {});
                if (proxyAuth) headers['Proxy-Authorization'] = `Basic ${proxyAuth}`;

                const req = http.request({
                    hostname: proxyConfig.host,
                    port: proxyConfig.port,
                    method: 'GET',
                    path: currentUrl,
                    headers,
                    timeout: 10000,
                }, (res) => {
                    res.on('data', () => {});
                    res.on('end', () => hopResolve({
                        status: res.statusCode,
                        location: res.headers && res.headers.location,
                    }));
                });
                req.on('error', (e) => hopResolve({ error: e.message }));
                req.on('timeout', () => { req.destroy(); hopResolve({ error: 'proxy timeout' }); });
                req.end();
            } catch (e) {
                hopResolve({ error: e.message });
            }
        });

        if (hopResult.error) {
            if (logger) logger.warn(`Tracker chain hop failed at ${currentUrl}: ${hopResult.error}`);
            return { finalUrl: currentUrl, hops, error: hopResult.error };
        }

        hops.push({ url: currentUrl, status: hopResult.status, viaProxy: true });

        if (hopResult.status >= 300 && hopResult.status < 400 && hopResult.location) {
            try {
                currentUrl = new URL(hopResult.location, currentUrl).toString();
            } catch {
                return { finalUrl: currentUrl, hops };
            }
            continue;
        }

        return { finalUrl: currentUrl, hops };
    }

    if (logger) logger.warn(`Tracker chain hit maxHops=${maxHops}, stopping at ${currentUrl}`);
    return { finalUrl: currentUrl, hops };
}

module.exports = {
    ProxyRouter,
    isGARequest,
    isGACollectRequest,
    isGAScript,
    parseProxyString,
    createPlaywrightProxy,
    parseCustomProxyPatterns,
    matchesCustomProxyPattern,
    isFileDownloadUrl,
    FALLBACK_USER_AGENT,
    NEVER_PROXY_EXTENSIONS,
    resolveTrackerChain,
    GA_COLLECT_DOMAINS,
    GA_COLLECT_PATHS,
    GA_SCRIPTS_DIRECT,
};
