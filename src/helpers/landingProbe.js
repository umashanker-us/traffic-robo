/**
 * What does a campaign URL actually land on — a page or a file?
 *
 * Why this cannot be left to the browser: when a navigation redirects to a
 * download while Playwright interception is active, Playwright reports nothing
 * at all. Measured against a smartlink that 302s to a PDF, with the app's own
 * route handler installed: the handler is called for the smartlink and never
 * for the redirect target, no response event fires for the PDF, no download
 * event fires, the page stays about:blank, and page.goto simply hangs until it
 * times out. Every visit then costs a full navigation timeout and lands in the
 * report as an Error.
 *
 * So the chain is followed here instead, once per campaign URL, with a
 * range-limited request that never pulls the body. One tiny request total tells
 * every visit whether there is a page to browse.
 */

const http = require('http');
const https = require('https');

const MAX_HOPS = 6;
const REQUEST_TIMEOUT_MS = 15000;

// Content types a visit can actually browse; anything else is a file.
const RENDERABLE = ['text/html', 'application/xhtml', 'text/plain', 'image/svg'];

function isRenderable(contentType) {
    const ct = (contentType || '').toLowerCase();
    return RENDERABLE.some(prefix => ct.startsWith(prefix));
}

function requestHead(url, headers) {
    return new Promise((resolve) => {
        let target;
        try {
            target = new URL(url);
        } catch {
            resolve({ error: 'invalid url' });
            return;
        }
        const mod = target.protocol === 'https:' ? https : http;
        const req = mod.request({
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + target.search,
            method: 'GET',
            // Ask for a single byte: enough for status and headers, and a server
            // that ignores Range still only streams until we destroy the socket.
            headers: Object.assign({ Range: 'bytes=0-0', Accept: '*/*' }, headers || {}),
            timeout: REQUEST_TIMEOUT_MS,
        }, (res) => {
            const result = {
                status: res.statusCode,
                location: res.headers && res.headers.location,
                contentType: (res.headers && res.headers['content-type']) || '',
            };
            res.destroy();
            resolve(result);
        });
        req.on('error', e => resolve({ error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
        req.end();
    });
}

/**
 * Follow a URL's redirect chain and report what it ends on.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {string} [options.userAgent] - sent so a server that varies on UA
 *   resolves the same way it will for the visits themselves.
 * @returns {Promise<{finalUrl: string, contentType: string, status: number|null,
 *   isFile: boolean, hops: number, error: string|null}>}
 *   isFile false with an error set means "could not tell" — the caller should
 *   carry on and let the browser try, which is the old behaviour.
 */
async function probeLanding(url, { userAgent } = {}) {
    let current = url;
    let hops = 0;

    for (let i = 0; i < MAX_HOPS; i++) {
        const headers = userAgent ? { 'User-Agent': userAgent } : {};
        const res = await requestHead(current, headers);

        if (res.error) {
            return { finalUrl: current, contentType: '', status: null, isFile: false, hops, error: res.error };
        }

        if (res.status >= 300 && res.status < 400 && res.location) {
            let next;
            try {
                next = new URL(res.location, current).href;
            } catch {
                break;
            }
            current = next;
            hops += 1;
            continue;
        }

        return {
            finalUrl: current,
            contentType: (res.contentType || '').split(';')[0].trim(),
            status: res.status,
            isFile: !!res.contentType && !isRenderable(res.contentType),
            hops,
            error: null,
        };
    }

    return {
        finalUrl: current,
        contentType: '',
        status: null,
        isFile: false,
        hops,
        error: `redirect chain longer than ${MAX_HOPS} hops`,
    };
}

module.exports = {
    probeLanding,
    isRenderable,
    MAX_HOPS,
};
