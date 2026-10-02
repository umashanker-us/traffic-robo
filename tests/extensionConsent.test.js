/**
 * Extension consent
 *
 * Measured against SimilarWeb v6.12.24 on a fresh profile: the extension loads,
 * its service worker runs, its content scripts match <all_urls> — and it reports
 * nothing. Its options page carries the consent control:
 *
 *   autoIcon = false   "Display site rank in extension icon. I agree to allow
 *                       access to information about the sites I visit..."
 *
 * With it off, browsing produced 0 bytes of SimilarWeb traffic. Ticking it
 * produced 6.0 KB up / 7.9 KB down to rank.similarweb.com on the next pages, and
 * the setting persisted in the profile — which is why this pairs with the
 * profile pool rather than replacing it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    grantExtensionConsent,
    hasConsent,
    findExtensionId,
    MARKER_FILE,
    CONSENT_SELECTORS,
} = require('../src/helpers/extensionConsent');

const AutomaticVisitor = require('../src/core/automaticVisitor');
const ManualVisitor = require('../src/core/manualVisitor');

const EXT_ID = 'bnkahfchigflcimbhmdcednfpmhkcehc';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-test-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

/**
 * A context whose options page behaves like the real one.
 *
 * `revertClicks` reproduces the race that made this retry: the page's own async
 * render from extension storage undoes a click that lands too early.
 */
function fakeContext({
    hasWorker = true,
    control = '#autoIcon',
    startsChecked = false,
    navThrows = null,
    revertClicks = 0,
} = {}) {
    const state = { checked: startsChecked, closed: false, visited: null, clicks: 0, reverted: 0 };

    const page = {
        goto: async (url) => { state.visited = url; if (navThrows) throw new Error(navThrows); },
        waitForSelector: async (sel) => {
            if (sel !== control) throw new Error(`no element matching ${sel}`);
            return {};
        },
        click: async (sel) => {
            if (sel !== control) throw new Error(`no element matching ${sel}`);
            state.clicks += 1;
            state.checked = true;
            if (state.reverted < revertClicks) {
                state.reverted += 1;
                state.checked = false;          // the render overwrote it
            }
        },
        evaluate: async (fn, arg) => fn.call(null, arg),
        waitForTimeout: async () => undefined,
        close: async () => { state.closed = true; },
    };

    // The page's evaluate runs against this stand-in DOM.
    global.document = {
        querySelector: (sel) => (sel === control
            ? { get checked() { return state.checked; }, click() { state.checked = true; } }
            : null),
    };

    return {
        state,
        serviceWorkers: () => (hasWorker ? [{ url: () => `chrome-extension://${EXT_ID}/background/background.js` }] : []),
        waitForEvent: async () => { throw new Error('no service worker appeared'); },
        newPage: async () => page,
    };
}

afterEach(() => { delete global.document; });

describe('findExtensionId', () => {
    test('reads the id off the running service worker', () => {
        expect(findExtensionId(fakeContext())).toBe(EXT_ID);
    });

    test('returns null when the extension has not started', () => {
        expect(findExtensionId(fakeContext({ hasWorker: false }))).toBeNull();
    });

    test('ignores a worker that is not an extension', () => {
        const ctx = { serviceWorkers: () => [{ url: () => 'https://site.test/sw.js' }] };
        expect(findExtensionId(ctx)).toBeNull();
    });
});

describe('hasConsent', () => {
    test('false for a fresh profile', () => {
        expect(hasConsent(dir)).toBe(false);
    });

    test('true once the marker is written', () => {
        fs.writeFileSync(path.join(dir, MARKER_FILE), '{}');
        expect(hasConsent(dir)).toBe(true);
    });

    test('false, not a throw, for a missing or empty path', () => {
        expect(hasConsent(path.join(dir, 'nope'))).toBe(false);
        expect(hasConsent(null)).toBe(false);
        expect(hasConsent('')).toBe(false);
    });
});

describe('grantExtensionConsent', () => {
    test('ticks the control and records it in the profile', async () => {
        const ctx = fakeContext({ startsChecked: false });
        const result = await grantExtensionConsent(ctx, { profileDir: dir });

        expect(result).toMatchObject({ granted: true, alreadyGranted: false, extensionId: EXT_ID });
        expect(ctx.state.checked).toBe(true);
        expect(ctx.state.visited).toBe(`chrome-extension://${EXT_ID}/options/options.html`);
        expect(hasConsent(dir)).toBe(true);
    });

    test('the options page is always closed again', async () => {
        const ctx = fakeContext();
        await grantExtensionConsent(ctx, { profileDir: dir });
        expect(ctx.state.closed).toBe(true);
    });

    // The whole point of pairing this with the profile pool.
    test('a profile that already consented is not touched again', async () => {
        fs.writeFileSync(path.join(dir, MARKER_FILE), '{}');
        const ctx = fakeContext();
        const result = await grantExtensionConsent(ctx, { profileDir: dir });

        expect(result).toMatchObject({ granted: true, alreadyGranted: true });
        expect(ctx.state.visited).toBeNull();      // never opened the page
    });

    test('a control that was already checked counts as already granted', async () => {
        const ctx = fakeContext({ startsChecked: true });
        const result = await grantExtensionConsent(ctx, { profileDir: dir });

        expect(result).toMatchObject({ granted: true, alreadyGranted: true });
        expect(ctx.state.checked).toBe(true);      // left alone, not toggled off
    });

    test('no service worker means no consent, and it says why', async () => {
        const result = await grantExtensionConsent(fakeContext({ hasWorker: false }), { profileDir: dir });
        expect(result.granted).toBe(false);
        expect(result.reason).toMatch(/service worker never started/i);
        expect(hasConsent(dir)).toBe(false);
    });

    test('an options page without the control is reported, not assumed', async () => {
        const ctx = fakeContext({ control: '#somethingElse' });
        const result = await grantExtensionConsent(ctx, { profileDir: dir });
        expect(result.granted).toBe(false);
        expect(result.reason).toMatch(/consent control/i);
        expect(hasConsent(dir)).toBe(false);
    });

    // The failure that showed up under concurrency: the options page renders its
    // controls from storage asynchronously and overwrote an early click. 8 of 25
    // visits reported "the consent control did not stay checked".
    test('a click the page reverts is retried until it sticks', async () => {
        const ctx = fakeContext({ revertClicks: 2 });
        const result = await grantExtensionConsent(ctx, { profileDir: dir, attempts: 3 });

        expect(result.granted).toBe(true);
        expect(result.attempts).toBe(3);
        expect(ctx.state.checked).toBe(true);
        expect(hasConsent(dir)).toBe(true);
    });

    test('a page that always reverts is reported, not silently assumed granted', async () => {
        const ctx = fakeContext({ revertClicks: 99 });
        const result = await grantExtensionConsent(ctx, { profileDir: dir, attempts: 2 });

        expect(result.granted).toBe(false);
        expect(result.reason).toMatch(/did not stay checked after 2 attempts/);
        expect(hasConsent(dir)).toBe(false);
    });

    // Under concurrency the worker is routinely not up when the first visit asks.
    test('it waits for the extension to start before giving up', async () => {
        let asked = false;
        const ctx = fakeContext({ hasWorker: false });
        ctx.waitForEvent = async () => { asked = true; throw new Error('timeout'); };

        const result = await grantExtensionConsent(ctx, { profileDir: dir, workerTimeoutMs: 10 });
        expect(asked).toBe(true);
        expect(result.granted).toBe(false);
        expect(result.reason).toMatch(/service worker never started/);
    });

    test('a navigation failure is reported, not thrown', async () => {
        const ctx = fakeContext({ navThrows: 'net::ERR_BLOCKED_BY_CLIENT' });
        const result = await grantExtensionConsent(ctx, { profileDir: dir });
        expect(result.granted).toBe(false);
        expect(result.reason).toContain('ERR_BLOCKED_BY_CLIENT');
        expect(hasConsent(dir)).toBe(false);
    });

    test('the control it looks for is the consent one', () => {
        expect(CONSENT_SELECTORS).toContain('#autoIcon');
    });
});

describe('the visitors wire it in', () => {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
    const config = {
        campaignUrl: 'https://example.com/',
        url: 'https://example.com/',
        userAgent: UA,
        threadId: 1,
        visit: { pagePerSession: 1, avgSessionDuration: 10 },
        screenSize: { width: 1920, height: 1080 },
        playMode: 'Slow',
        location: 'India',
    };

    test('both visitors share the same consent step', () => {
        expect(ManualVisitor.prototype._grantExtensionConsent)
            .toBe(AutomaticVisitor.prototype._grantExtensionConsent);
    });

    test('consent state starts unknown and reaches the session info', () => {
        const v = new AutomaticVisitor(Object.assign({}, config, { extensionEnabled: true }));
        expect(v.extensionConsent).toBeNull();
        expect(v._buildSessionInfo()).toHaveProperty('extensionConsent', null);

        v.extensionConsent = 'granted';
        expect(v._buildSessionInfo().extensionConsent).toBe('granted');
    });

    test('it does nothing when the extension is off', async () => {
        const v = new AutomaticVisitor(config);
        v.context = fakeContext();
        await v._grantExtensionConsent();
        expect(v.extensionConsent).toBeNull();
    });
});

describe('the report shows a consent failure', () => {
    const { generateCSV } = require('../src/helpers/campaignExport');

    function rowFor(sessionInfo) {
        const replay = {
            threadId: 1, startTime: '', endTime: '', durationSec: 1,
            sessionInfo, stats: { pagesVisited: 1, ga4EventsFired: 0, errors: 0, isBounce: false },
            timeline: [],
        };
        return generateCSV([replay]).split('\n')[1];
    }

    // "Loaded" on its own was misleading: a loaded extension with no consent
    // injects nothing and sends nothing.
    test('a failed consent reads "No consent", not "Not detected"', () => {
        expect(rowFor({
            extensionEnabled: true, extensionLoaded: true,
            extensionConsent: 'failed', extensionVerified: false,
        })).toContain('No consent');
    });

    test('a granted consent still reads Active', () => {
        expect(rowFor({
            extensionEnabled: true, extensionLoaded: true,
            extensionConsent: 'granted', extensionVerified: true,
        })).toContain('Active');
    });
});
