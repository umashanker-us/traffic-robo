/**
 * Download guard
 *
 * A campaign URL can resolve to a file rather than a page — PDF click-trackers
 * do exactly this. Chromium then starts a download instead of navigating, the
 * goto rejects, and before this guard the visit was reported as a failure while
 * the file was pulled in full (2.5 MB a visit, for a URL that can never fire a
 * GA4 hit). The guard refuses the download and ends the visit cleanly.
 */

const AutomaticVisitor = require('../src/core/automaticVisitor');
const ManualVisitor = require('../src/core/manualVisitor');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.7499.1 Safari/537.36';
const PDF_URL = 'https://storage.googleapis.com/e4mevents/Saptharushi/Pitch-bfsi.pdf';

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

function fakeDownload(url, filename) {
    const d = {
        cancelled: false,
        url: () => url,
        suggestedFilename: () => filename,
        cancel: async () => { d.cancelled = true; },
    };
    return d;
}

function fakePage() {
    const handlers = {};
    return {
        handlers,
        on: (evt, fn) => { handlers[evt] = handlers[evt] || []; handlers[evt].push(fn); },
        emit: (evt, arg) => (handlers[evt] || []).forEach(fn => fn(arg)),
    };
}

describe('context refuses downloads', () => {
    test.each([
        ['AutomaticVisitor', AutomaticVisitor],
        ['ManualVisitor', ManualVisitor],
    ])('%s sets acceptDownloads: false', (_name, Visitor) => {
        const v = new Visitor(makeConfig());
        const opts = v._buildContextOptions();
        expect(opts.acceptDownloads).toBe(false);
    });
});

describe('_watchForDownloadLanding', () => {
    test.each([
        ['AutomaticVisitor', AutomaticVisitor],
        ['ManualVisitor', ManualVisitor],
    ])('%s records the download and cancels it', async (_name, Visitor) => {
        const v = Object.create(Visitor.prototype);
        const page = fakePage();
        v._watchForDownloadLanding(page);

        expect(v._downloadLanding).toBeUndefined();

        const d = fakeDownload(PDF_URL, 'Pitch-bfsi.pdf');
        page.emit('download', d);

        expect(v._downloadLanding).toEqual({
            url: PDF_URL, filename: 'Pitch-bfsi.pdf', via: 'download',
        });
        await Promise.resolve();
        expect(d.cancelled).toBe(true);
    });

    test('a cancel that rejects does not escape as an unhandled rejection', async () => {
        const v = Object.create(AutomaticVisitor.prototype);
        const page = fakePage();
        v._watchForDownloadLanding(page);

        const d = fakeDownload(PDF_URL, 'x.pdf');
        d.cancel = async () => { throw new Error('download already finished'); };

        expect(() => page.emit('download', d)).not.toThrow();
        await new Promise(r => setImmediate(r));
        expect(v._downloadLanding.filename).toBe('x.pdf');
    });
});

describe('_awaitDownloadSignal', () => {
    test('returns the landing already recorded without waiting', async () => {
        const v = Object.create(AutomaticVisitor.prototype);
        v._downloadLanding = { url: PDF_URL, filename: 'Pitch-bfsi.pdf' };
        v.page = { waitForEvent: async () => { throw new Error('should not be called'); } };

        await expect(v._awaitDownloadSignal()).resolves.toEqual(v._downloadLanding);
    });

    test('picks up a download that only arrives after the failed navigation', async () => {
        const v = Object.create(AutomaticVisitor.prototype);
        v.page = { waitForEvent: async () => fakeDownload(PDF_URL, 'late.pdf') };

        const landing = await v._awaitDownloadSignal(50);
        expect(landing).toEqual({ url: PDF_URL, filename: 'late.pdf' });
    });

    test('returns undefined for a genuine navigation failure', async () => {
        const v = Object.create(AutomaticVisitor.prototype);
        v.page = { waitForEvent: async () => { throw new Error('Timeout 750ms exceeded'); } };

        await expect(v._awaitDownloadSignal(10)).resolves.toBeUndefined();
    });
});

describe('_visitFirstPage error handling', () => {
    function makeVisitor(landing) {
        const v = Object.create(AutomaticVisitor.prototype);
        v.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
        v.events = [];
        v.errors = [];
        v.replay = {
            _addEvent: (name, data) => v.events.push({ name, data }),
            logError: (scope, msg) => v.errors.push({ scope, msg }),
        };
        v._awaitDownloadSignal = async () => landing;
        return v;
    }

    // Mirrors the catch block: a download landing returns, anything else throws.
    async function runCatch(v, error) {
        const landing = await v._awaitDownloadSignal();
        if (landing) {
            v.logger.warn('download');
            v.replay._addEvent('download_landing', landing);
            return 'handled';
        }
        v.replay.logError('first_page', error.message);
        throw error;
    }

    test('a download landing is recorded as an event, not an error', async () => {
        const v = makeVisitor({ url: PDF_URL, filename: 'Pitch-bfsi.pdf' });

        await expect(runCatch(v, new Error('Download is starting'))).resolves.toBe('handled');
        expect(v.errors).toEqual([]);
        expect(v.events).toEqual([{ name: 'download_landing', data: { url: PDF_URL, filename: 'Pitch-bfsi.pdf' } }]);
    });

    test('a real navigation failure still propagates', async () => {
        const v = makeVisitor(undefined);

        await expect(runCatch(v, new Error('net::ERR_NAME_NOT_RESOLVED'))).rejects.toThrow('ERR_NAME_NOT_RESOLVED');
        expect(v.errors).toEqual([{ scope: 'first_page', msg: 'net::ERR_NAME_NOT_RESOLVED' }]);
        expect(v.events).toEqual([]);
    });
});
