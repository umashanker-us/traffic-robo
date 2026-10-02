/**
 * Landing probe
 *
 * Why the browser cannot answer this. Measured against a smartlink that 302s to
 * a PDF, with the app's own route handler installed: the handler is called for
 * the smartlink and never for the redirect target, no response event fires for
 * the PDF, no download event fires, the page stays about:blank, and page.goto
 * hangs until it times out. Every visit cost a full navigation timeout and the
 * report called it an Error.
 *
 * So the chain is followed in Node instead, once per campaign URL, with a
 * range-limited request that never pulls the body.
 */

const http = require('http');
const { probeLanding, isRenderable, MAX_HOPS } = require('../src/helpers/landingProbe');
const BrowserSession = require('../src/core/browserSession');
const AutomaticVisitor = require('../src/core/automaticVisitor');

let server;
let base;
let seen;

beforeAll(async () => {
    seen = [];
    server = http.createServer((req, res) => {
        seen.push({ url: req.url, method: req.method, range: req.headers.range });

        if (req.url === '/page') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body>page</body></html>');
            return;
        }
        if (req.url === '/file.pdf') {
            res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': '2659196' });
            // A body the probe must not pull.
            res.end(Buffer.alloc(1024));
            return;
        }
        if (req.url === '/to-pdf') {
            res.writeHead(302, { Location: '/file.pdf' });
            res.end();
            return;
        }
        if (req.url === '/to-page') {
            res.writeHead(302, { Location: '/page' });
            res.end();
            return;
        }
        if (req.url === '/chain') {
            res.writeHead(302, { Location: '/to-pdf' });
            res.end();
            return;
        }
        if (req.url === '/loop') {
            res.writeHead(302, { Location: '/loop' });
            res.end();
            return;
        }
        if (req.url === '/no-type') {
            res.writeHead(200, {});
            res.end('x');
            return;
        }
        if (req.url === '/zip') {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            res.end('x');
            return;
        }
        res.writeHead(404); res.end();
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(r => server.close(r));
});

beforeEach(() => { seen.length = 0; });

describe('isRenderable', () => {
    test.each(['text/html', 'text/html; charset=utf-8', 'application/xhtml+xml', 'text/plain', 'image/svg+xml'])(
        '%s is browsable', ct => expect(isRenderable(ct)).toBe(true));

    test.each(['application/pdf', 'application/octet-stream', 'application/zip', 'video/mp4', 'image/png', ''])(
        '%s is not browsable', ct => expect(isRenderable(ct)).toBe(false));
});

describe('probeLanding', () => {
    test('an HTML page is not a file', async () => {
        const r = await probeLanding(`${base}/page`);
        expect(r).toMatchObject({ isFile: false, contentType: 'text/html', status: 200, hops: 0, error: null });
    });

    test('a PDF is a file', async () => {
        const r = await probeLanding(`${base}/file.pdf`);
        expect(r).toMatchObject({ isFile: true, contentType: 'application/pdf' });
    });

    test('a redirect to a PDF is followed and reported as a file', async () => {
        const r = await probeLanding(`${base}/to-pdf`);
        expect(r.isFile).toBe(true);
        expect(r.contentType).toBe('application/pdf');
        expect(r.hops).toBe(1);
        expect(r.finalUrl).toBe(`${base}/file.pdf`);
    });

    test('a multi-hop chain to a PDF is followed', async () => {
        const r = await probeLanding(`${base}/chain`);
        expect(r.isFile).toBe(true);
        expect(r.hops).toBe(2);
    });

    test('a redirect to a page is not a file', async () => {
        const r = await probeLanding(`${base}/to-page`);
        expect(r.isFile).toBe(false);
        expect(r.finalUrl).toBe(`${base}/page`);
    });

    test('an octet-stream is a file', async () => {
        expect((await probeLanding(`${base}/zip`)).isFile).toBe(true);
    });

    // The whole point is to learn this without paying for the file.
    test('the body is never pulled — a range of one byte is requested', async () => {
        await probeLanding(`${base}/file.pdf`);
        expect(seen).toHaveLength(1);
        expect(seen[0].range).toBe('bytes=0-0');
    });

    test('the probing user agent is passed through', async () => {
        let ua = null;
        const srv = http.createServer((req, res) => {
            ua = req.headers['user-agent'];
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('x');
        });
        await new Promise(r => srv.listen(0, '127.0.0.1', r));
        await probeLanding(`http://127.0.0.1:${srv.address().port}/`, { userAgent: 'TestUA/1.0' });
        await new Promise(r => srv.close(r));
        expect(ua).toBe('TestUA/1.0');
    });

    // "Could not tell" must not be reported as a file, or a healthy campaign
    // would stop navigating because of one flaky request.
    test('an unreachable host reports an error and not a file', async () => {
        const r = await probeLanding('http://127.0.0.1:1/');
        expect(r.isFile).toBe(false);
        expect(r.error).toBeTruthy();
    });

    test('an invalid URL reports an error and not a file', async () => {
        const r = await probeLanding('not a url');
        expect(r.isFile).toBe(false);
        expect(r.error).toBeTruthy();
    });

    test('a redirect loop gives up instead of hanging', async () => {
        const r = await probeLanding(`${base}/loop`);
        expect(r.isFile).toBe(false);
        expect(r.error).toContain(String(MAX_HOPS));
    });

    test('a response with no content type is not called a file', async () => {
        const r = await probeLanding(`${base}/no-type`);
        expect(r.isFile).toBe(false);
    });
});

describe('a probed file landing skips the navigation entirely', () => {
    function visitor(landingProbe) {
        const v = Object.create(AutomaticVisitor.prototype);
        v.logger = { info: () => {}, warn: () => {}, debug: () => {} };
        v._downloadLanding = null;
        v._onFileLanding = null;
        v.landingProbe = landingProbe;
        v.gotoCalls = 0;
        v.page = {
            goto: async () => { v.gotoCalls += 1; },
            evaluate: async () => undefined,
        };
        return v;
    }

    test('goto is never called when the probe says file', async () => {
        const v = visitor({ isFile: true, finalUrl: 'https://cdn.test/deck.pdf', contentType: 'application/pdf' });

        const result = await v._navigateToLanding('https://short.test/x', { timeout: 60000 });

        expect(v.gotoCalls).toBe(0);
        expect(result.error).toBeNull();
        expect(result.fileLanding).toMatchObject({
            url: 'https://cdn.test/deck.pdf',
            filename: 'deck.pdf',
            contentType: 'application/pdf',
            via: 'probe',
        });
    });

    test('a probe that says page still navigates', async () => {
        const v = visitor({ isFile: false, finalUrl: 'https://site.test/', contentType: 'text/html' });
        const result = await v._navigateToLanding('https://site.test/', { timeout: 60000 });
        expect(v.gotoCalls).toBe(1);
        expect(result.fileLanding).toBeNull();
    });

    test('no probe at all still navigates — the probe is an optimisation', async () => {
        const v = visitor(null);
        const result = await v._navigateToLanding('https://site.test/', { timeout: 60000 });
        expect(v.gotoCalls).toBe(1);
        expect(result.fileLanding).toBeNull();
    });

    test('the base still classifies content types the same way the probe does', () => {
        expect(BrowserSession.isRenderableContentType('text/html')).toBe(isRenderable('text/html'));
        expect(BrowserSession.isRenderableContentType('application/pdf')).toBe(isRenderable('application/pdf'));
    });
});
