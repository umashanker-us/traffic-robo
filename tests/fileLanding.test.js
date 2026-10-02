/**
 * File landings, detected by content type
 *
 * The download event alone is not a reliable signal. Measured against the same
 * PDF: the bundled Chromium starts a download and page.goto rejects with
 * "Download is starting", while real Chrome has a built-in PDF viewer and
 * simply renders it — goto resolves, no download event fires, and the visit
 * then burned its whole 60s navigation timeout on a document that can never run
 * gtag. The report called those visits Error.
 *
 * What both browsers agree on is the navigation response's content type, so
 * that is what decides now.
 */

const AutomaticVisitor = require('../src/core/automaticVisitor');
const ManualVisitor = require('../src/core/manualVisitor');
const BrowserSession = require('../src/core/browserSession');

const PDF_URL = 'https://storage.googleapis.com/e4mevents/Saptharushi/Pitch-bfsi.pdf';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.8037.1 Safari/537.36';

function makeConfig(extra) {
    return Object.assign({
        campaignUrl: 'https://example.com/',
        url: 'https://example.com/',
        userAgent: UA,
        threadId: 1,
        visit: { pagePerSession: 1, avgSessionDuration: 10 },
        screenSize: { width: 1920, height: 1080 },
        playMode: 'Fast',
        location: 'India',
    }, extra || {});
}

/** A page that can emit download and response events, like Playwright's. */
function fakePage(mainFrame) {
    const handlers = {};
    return {
        _mainFrame: mainFrame,
        mainFrame: () => mainFrame,
        on: (evt, fn) => { (handlers[evt] = handlers[evt] || []).push(fn); },
        emit: (evt, arg) => (handlers[evt] || []).forEach(fn => fn(arg)),
        handlers,
    };
}

function fakeResponse({ url, contentType, status = 200, navigation = true, frame }) {
    return {
        url: () => url,
        status: () => status,
        headers: () => (contentType ? { 'content-type': contentType } : {}),
        frame: () => frame,
        request: () => ({ isNavigationRequest: () => navigation }),
    };
}

describe('isRenderableContentType', () => {
    test.each([
        'text/html',
        'text/html; charset=utf-8',
        'application/xhtml+xml',
        'text/plain',
        'image/svg+xml',
    ])('%s is something a visit can browse', (ct) => {
        expect(BrowserSession.isRenderableContentType(ct)).toBe(true);
    });

    test.each([
        'application/pdf',
        'application/octet-stream',
        'application/zip',
        'video/mp4',
        'image/jpeg',
        'application/vnd.ms-excel',
    ])('%s is a file, not a page', (ct) => {
        expect(BrowserSession.isRenderableContentType(ct)).toBe(false);
    });
});

describe('a non-HTML navigation response is a file landing', () => {
    function armed(Visitor) {
        const v = Object.create(Visitor.prototype);
        v.logger = { info: () => {}, warn: () => {}, debug: () => {} };
        // What the constructor would have set — the prototype is used directly
        // here so the real browser lifecycle stays out of a unit test.
        v._downloadLanding = null;
        v._onFileLanding = null;
        const frame = {};
        const page = fakePage(frame);
        v._watchForDownloadLanding(page);
        return { v, page, frame };
    }

    test.each([
        ['AutomaticVisitor', AutomaticVisitor],
        ['ManualVisitor', ManualVisitor],
    ])('%s records a PDF navigation as a file landing', (_name, Visitor) => {
        const { v, page, frame } = armed(Visitor);

        page.emit('response', fakeResponse({ url: PDF_URL, contentType: 'application/pdf', frame }));

        expect(v._downloadLanding).toMatchObject({
            url: PDF_URL,
            filename: 'Pitch-bfsi.pdf',
            contentType: 'application/pdf',
            via: 'content-type',
        });
    });

    test('an HTML page is not a file landing', () => {
        const { v, page, frame } = armed(AutomaticVisitor);
        page.emit('response', fakeResponse({
            url: 'https://example.com/', contentType: 'text/html; charset=utf-8', frame,
        }));
        expect(v._downloadLanding).toBeNull();
    });

    test('a redirect hop is not a file landing', () => {
        const { v, page, frame } = armed(AutomaticVisitor);
        page.emit('response', fakeResponse({
            url: 'https://e4mevents.com/smartlink/s/A5Tdts',
            contentType: 'text/html; charset=utf-8', status: 302, frame,
        }));
        expect(v._downloadLanding).toBeNull();
    });

    test('a subresource is ignored — only the document decides', () => {
        const { v, page, frame } = armed(AutomaticVisitor);
        page.emit('response', fakeResponse({
            url: 'https://example.com/logo.png', contentType: 'image/png',
            navigation: false, frame,
        }));
        expect(v._downloadLanding).toBeNull();
    });

    test('a response in another frame is ignored', () => {
        const { v, page } = armed(AutomaticVisitor);
        page.emit('response', fakeResponse({
            url: PDF_URL, contentType: 'application/pdf', frame: { other: true },
        }));
        expect(v._downloadLanding).toBeNull();
    });

    test('a response with no content type is left alone', () => {
        const { v, page, frame } = armed(AutomaticVisitor);
        page.emit('response', fakeResponse({ url: 'https://example.com/x', contentType: null, frame }));
        expect(v._downloadLanding).toBeNull();
    });

    test('the first landing wins — a later one does not overwrite it', () => {
        const { v, page, frame } = armed(AutomaticVisitor);
        page.emit('response', fakeResponse({ url: PDF_URL, contentType: 'application/pdf', frame }));
        page.emit('response', fakeResponse({ url: 'https://other/x.zip', contentType: 'application/zip', frame }));
        expect(v._downloadLanding.url).toBe(PDF_URL);
    });

    test('a download event still works and is labelled as such', () => {
        const { v, page } = armed(AutomaticVisitor);
        page.emit('download', {
            url: () => PDF_URL,
            suggestedFilename: () => 'Pitch-bfsi.pdf',
            cancel: async () => {},
        });
        expect(v._downloadLanding.via).toBe('download');
    });
});

describe('_navigateToLanding gives up early on a file', () => {
    function visitor(gotoImpl) {
        const v = Object.create(AutomaticVisitor.prototype);
        v.logger = { info: () => {}, warn: () => {}, debug: () => {} };
        v._downloadLanding = null;
        v._onFileLanding = null;
        v.page = {
            goto: gotoImpl,
            evaluate: async () => undefined,
        };
        return v;
    }

    // Real Chrome renders the PDF, so goto never settles in time. Without the
    // race this cost the full navigation timeout, per visit.
    test('returns as soon as a file landing is signalled, without awaiting goto', async () => {
        let gotoSettled = false;
        const v = visitor(() => new Promise(resolve => setTimeout(() => {
            gotoSettled = true;
            resolve();
        }, 5000)));

        setTimeout(() => v._recordFileLanding({
            url: PDF_URL, filename: 'Pitch-bfsi.pdf', contentType: 'application/pdf', via: 'content-type',
        }), 20);

        const started = Date.now();
        const result = await v._navigateToLanding('https://e4mevents.com/smartlink/s/A5Tdts', { timeout: 5000 });

        expect(result.fileLanding).toMatchObject({ contentType: 'application/pdf' });
        expect(result.error).toBeNull();
        expect(Date.now() - started).toBeLessThan(2000);
        expect(gotoSettled).toBe(false);
    });

    test('a landing already recorded short-circuits immediately', async () => {
        const v = visitor(() => new Promise(() => {}));   // never settles
        v._downloadLanding = { url: PDF_URL, via: 'download' };

        const result = await v._navigateToLanding('https://example.com/', { timeout: 5000 });
        expect(result.fileLanding.url).toBe(PDF_URL);
    });

    test('a normal page navigation returns no landing and no error', async () => {
        const v = visitor(async () => undefined);
        const result = await v._navigateToLanding('https://example.com/', { timeout: 5000 });
        expect(result).toEqual({ fileLanding: null, error: null });
    });

    test('a real navigation failure is handed back, not swallowed', async () => {
        const boom = new Error('net::ERR_NAME_NOT_RESOLVED');
        const v = visitor(async () => { throw boom; });

        const result = await v._navigateToLanding('https://nope.invalid/', { timeout: 5000 });
        expect(result.fileLanding).toBeNull();
        expect(result.error).toBe(boom);
    });

    test('the landing listener is cleared so it cannot fire into a finished navigation', async () => {
        const v = visitor(async () => undefined);
        await v._navigateToLanding('https://example.com/', { timeout: 5000 });
        expect(v._onFileLanding).toBeNull();
    });
});

describe('context still refuses downloads', () => {
    test.each([
        ['AutomaticVisitor', AutomaticVisitor],
        ['ManualVisitor', ManualVisitor],
    ])('%s sets acceptDownloads: false', (_name, Visitor) => {
        expect(new Visitor(makeConfig())._buildContextOptions().acceptDownloads).toBe(false);
    });
});
