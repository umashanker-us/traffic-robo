/**
 * Proxied tracker hops carry the visit's own identity
 *
 * These hops are what an ad platform's click log actually records — source IP
 * from the proxy, and User-Agent from whatever the app sent. They used to go
 * out as a bare "Mozilla/5.0" with a wildcard Accept, which parses server-side
 * as Device: Desktop, Browser: Mozilla for every single click regardless of the
 * visit's real user agent. A click report showed nothing but
 * "Desktop / Mozilla" rows while the browser visits themselves were a correct
 * mix of desktop, mobile and tablet.
 */

const http = require('http');
const { resolveTrackerChain, parseProxyString } = require('../src/helpers/proxyRouter');
const AutomaticVisitor = require('../src/core/automaticVisitor');
const ManualVisitor = require('../src/core/manualVisitor');

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.8037.1 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.8037.1 Safari/537.36';

let proxy;
let proxyUrl;
let seen;

beforeAll(async () => {
    seen = [];
    // Stands in for the real proxy: records what crosses it, answers with a
    // redirect to a URL the patterns no longer match so the chain terminates.
    proxy = http.createServer((req, res) => {
        seen.push(req.headers);
        res.writeHead(302, { Location: 'https://landing.example/page' });
        res.end();
    });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    proxyUrl = `127.0.0.1:${proxy.address().port}`;
});

afterAll(async () => {
    await new Promise(r => proxy.close(r));
});

beforeEach(() => { seen.length = 0; });

function identityFor(userAgent) {
    const v = new AutomaticVisitor({
        campaignUrl: 'https://tracker.example/click/abc',
        userAgent,
        threadId: 1,
        visit: { pagePerSession: 1, avgSessionDuration: 10 },
        screenSize: { width: 412, height: 915 },
        playMode: 'Fast',
        location: 'India',
    });
    return v._buildRequestIdentity();
}

describe('_buildRequestIdentity', () => {
    test('reports the visit user agent, a language list and matching hints', () => {
        const id = identityFor(ANDROID_UA);
        expect(id.userAgent).toBe(ANDROID_UA);
        expect(id.acceptLanguage).toMatch(/^[a-z]{2}(-[A-Z]{2})?/);
        expect(id.acceptLanguage).toContain('q=');
        expect(id.clientHints['sec-ch-ua-mobile']).toBe('?1');
        expect(id.clientHints['sec-ch-ua-platform']).toBe('"Android"');
        expect(id.clientHints['sec-ch-ua']).toContain('Google Chrome');
    });

    test('a desktop visit reports itself as desktop', () => {
        const id = identityFor(DESKTOP_UA);
        expect(id.clientHints['sec-ch-ua-mobile']).toBe('?0');
        expect(id.clientHints['sec-ch-ua-platform']).toBe('"Windows"');
    });

    test('both visitors build it the same way', () => {
        expect(ManualVisitor.prototype._buildRequestIdentity)
            .toBe(AutomaticVisitor.prototype._buildRequestIdentity);
    });
});

describe('resolveTrackerChain sends the identity it is given', () => {
    const PATTERNS = ['tracker.example'];

    async function walk(identity) {
        return resolveTrackerChain(
            'https://tracker.example/click/abc',
            parseProxyString(proxyUrl),
            PATTERNS,
            null,
            10,
            identity,
        );
    }

    test('the hop carries the visit user agent, not a placeholder', async () => {
        await walk(identityFor(ANDROID_UA));
        expect(seen).toHaveLength(1);
        expect(seen[0]['user-agent']).toBe(ANDROID_UA);
        // The exact string that made every click read as Desktop / Mozilla.
        expect(seen[0]['user-agent']).not.toBe('Mozilla/5.0');
    });

    test('a mobile visit produces a hop a click log reads as mobile', async () => {
        await walk(identityFor(ANDROID_UA));
        const ua = seen[0]['user-agent'];
        expect(/Mobile/.test(ua)).toBe(true);
        expect(seen[0]['sec-ch-ua-mobile']).toBe('?1');
    });

    test('a desktop visit produces a hop a click log reads as desktop', async () => {
        await walk(identityFor(DESKTOP_UA));
        const ua = seen[0]['user-agent'];
        expect(/Mobile/.test(ua)).toBe(false);
        expect(seen[0]['sec-ch-ua-mobile']).toBe('?0');
    });

    test('the hop sends a document Accept, not */*', async () => {
        await walk(identityFor(DESKTOP_UA));
        expect(seen[0].accept).toContain('text/html');
        expect(seen[0].accept).not.toBe('*' + '/' + '*');
    });

    test('the hop sends Accept-Language and Upgrade-Insecure-Requests', async () => {
        await walk(identityFor(DESKTOP_UA));
        expect(seen[0]['accept-language']).toBeTruthy();
        expect(seen[0]['upgrade-insecure-requests']).toBe('1');
    });

    test('the brand in the hints names a browser a log can resolve', async () => {
        await walk(identityFor(DESKTOP_UA));
        const brands = seen[0]['sec-ch-ua'] || '';
        expect(/Google Chrome|Microsoft Edge|Opera|Samsung Internet/.test(brands)).toBe(true);
    });

    test('no identity still works, falling back to the old placeholder', async () => {
        await walk(undefined);
        expect(seen).toHaveLength(1);
        expect(seen[0]['user-agent']).toBe('Mozilla/5.0');
    });

    test('the Host header still names the hop target, not the proxy', async () => {
        await walk(identityFor(DESKTOP_UA));
        expect(seen[0].host).toBe('tracker.example');
    });
});
