/**
 * Warming the profile pool before a campaign
 *
 * A profile's first visit used to pay for consent itself: the extension's
 * options page opened inside that visit's browser and stayed visible for about
 * 2.5 seconds while the control was ticked and verified, and the extension
 * answered by opening its own welcome tab. All of that landed on top of a real
 * visit — the one whose page load, GA4 beacon and ad flow actually matter.
 *
 * Doing it up front costs the same total time and none of the visits. Repeating
 * it is free, because a profile that already carries the consent marker is
 * skipped without launching anything.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const profilePool = require('../src/helpers/profilePool');
const { MARKER_FILE } = require('../src/helpers/extensionConsent');

// The warm-up launches real browsers, so the launcher is replaced for these.
jest.mock('playwright', () => ({
    chromium: { launchPersistentContext: jest.fn() },
}));
const { chromium } = require('playwright');

const { warmUpProfiles, PER_PROFILE_TIMEOUT_MS } = require('../src/helpers/profileWarmup');

const EXT = '/some/extension';
let base;

/** A context whose options page behaves like the real one. */
function fakeContext({ consentSticks = true, closeHangs = false } = {}) {
    const state = { closed: false, visited: null, checked: false, pageHandlers: [] };
    const page = {
        goto: async (url) => { state.visited = url; },
        waitForSelector: async () => ({}),
        click: async () => { state.checked = consentSticks; },
        evaluate: async (fn, arg) => fn.call(null, arg),
        waitForTimeout: async () => undefined,
        close: async () => undefined,
        on: () => undefined,
    };
    global.document = {
        querySelector: () => ({ get checked() { return state.checked; }, click() { state.checked = consentSticks; } }),
    };
    return {
        state,
        serviceWorkers: () => [{ url: () => 'chrome-extension://bnkahfchigflcimbhmdcednfpmhkcehc/bg.js' }],
        waitForEvent: async () => { throw new Error('no worker event'); },
        newPage: async () => page,
        on: (event, handler) => { state.pageHandlers.push([event, handler]); },
        close: async () => {
            if (closeHangs) return new Promise(() => {});
            state.closed = true;
        },
    };
}

const quietLogger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };

beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'warmup-test-'));
    profilePool.setBaseDir(base);
    chromium.launchPersistentContext.mockReset();
    Object.values(quietLogger).forEach(fn => fn.mockReset());
});

afterEach(() => {
    profilePool.resetPool();
    delete global.document;
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
});

describe('warmUpProfiles', () => {
    test('consents every profile in the pool, once each', async () => {
        chromium.launchPersistentContext.mockImplementation(async () => fakeContext());

        const result = await warmUpProfiles({ poolSize: 3, extensionPath: EXT, logger: quietLogger });

        expect(result).toMatchObject({ warmed: 3, skipped: 0, failed: 0, total: 3 });
        expect(chromium.launchPersistentContext).toHaveBeenCalledTimes(3);
    });

    // Each iteration must get a different profile, not the same one handed back
    // after every release — which is what happens if the leases are not all
    // held at once.
    test('each launch gets its own profile directory', async () => {
        chromium.launchPersistentContext.mockImplementation(async () => fakeContext());

        await warmUpProfiles({ poolSize: 4, extensionPath: EXT, logger: quietLogger });

        const dirs = chromium.launchPersistentContext.mock.calls.map(c => c[0]);
        expect(new Set(dirs).size).toBe(4);
    });

    test('the extension is actually loaded into the warm-up browser', async () => {
        chromium.launchPersistentContext.mockImplementation(async () => fakeContext());

        await warmUpProfiles({ poolSize: 1, extensionPath: EXT, logger: quietLogger });

        const args = chromium.launchPersistentContext.mock.calls[0][1].args;
        expect(args).toContain(`--load-extension=${EXT}`);
        expect(args).toContain(`--disable-extensions-except=${EXT}`);
        // Headless loads no extension at all, which is the whole reason the
        // visits run headful too.
        expect(chromium.launchPersistentContext.mock.calls[0][1].headless).toBe(false);
    });

    test('the browser binary choice is passed through', async () => {
        chromium.launchPersistentContext.mockImplementation(async () => fakeContext());

        await warmUpProfiles({
            poolSize: 1,
            extensionPath: EXT,
            binaryOptions: { executablePath: '/path/to/chromium' },
            logger: quietLogger,
        });

        expect(chromium.launchPersistentContext.mock.calls[0][1].executablePath).toBe('/path/to/chromium');
    });

    test('every warm-up browser is closed again', async () => {
        const contexts = [];
        chromium.launchPersistentContext.mockImplementation(async () => {
            const ctx = fakeContext();
            contexts.push(ctx);
            return ctx;
        });

        await warmUpProfiles({ poolSize: 2, extensionPath: EXT, logger: quietLogger });

        expect(contexts).toHaveLength(2);
        contexts.forEach(ctx => expect(ctx.state.closed).toBe(true));
    });

    // The point of pairing this with the pool: run it again and it does nothing.
    test('a profile that already consented is skipped without launching', async () => {
        chromium.launchPersistentContext.mockImplementation(async () => fakeContext());
        await warmUpProfiles({ poolSize: 2, extensionPath: EXT, logger: quietLogger });
        chromium.launchPersistentContext.mockClear();

        const second = await warmUpProfiles({ poolSize: 2, extensionPath: EXT, logger: quietLogger });

        expect(second).toMatchObject({ warmed: 0, skipped: 2, failed: 0 });
        expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
    });

    test('the marker it writes is the one the visitors read', async () => {
        chromium.launchPersistentContext.mockImplementation(async () => fakeContext());
        await warmUpProfiles({ poolSize: 1, extensionPath: EXT, logger: quietLogger });

        const markers = fs.readdirSync(path.join(base, 'trafficrobo-profiles', 'p0'));
        expect(markers).toContain(MARKER_FILE);
    });

    describe('it never blocks the campaign', () => {
        test('a profile whose consent will not stick is reported, not thrown', async () => {
            chromium.launchPersistentContext.mockImplementation(async () => fakeContext({ consentSticks: false }));

            const result = await warmUpProfiles({ poolSize: 2, extensionPath: EXT, logger: quietLogger });

            expect(result).toMatchObject({ warmed: 0, failed: 2 });
            expect(quietLogger.warn.mock.calls.some(c => /try again/.test(c[0]))).toBe(true);
        });

        test('a launch that throws is reported, not thrown', async () => {
            chromium.launchPersistentContext.mockRejectedValue(new Error('Failed to launch'));

            const result = await warmUpProfiles({ poolSize: 1, extensionPath: EXT, logger: quietLogger });

            expect(result.failed).toBe(1);
            expect(result.details[0].reason).toMatch(/Failed to launch/);
        });

        test('a browser that will not close does not hold the campaign', async () => {
            chromium.launchPersistentContext.mockImplementation(async () => fakeContext({ closeHangs: true }));

            const started = Date.now();
            const result = await warmUpProfiles({ poolSize: 1, extensionPath: EXT, logger: quietLogger });

            // The close has its own 10s bound, well inside the per-profile one.
            expect(Date.now() - started).toBeLessThan(PER_PROFILE_TIMEOUT_MS);
            expect(result.total).toBe(1);
        }, 30000);

        test('a stop request ends it between profiles', async () => {
            chromium.launchPersistentContext.mockImplementation(async () => fakeContext());
            let calls = 0;

            const result = await warmUpProfiles({
                poolSize: 5,
                extensionPath: EXT,
                logger: quietLogger,
                shouldStop: () => { calls += 1; return calls > 2; },
            });

            expect(result.warmed).toBeLessThan(5);
            expect(chromium.launchPersistentContext.mock.calls.length).toBeLessThan(5);
        });
    });

    describe('when there is nothing to do', () => {
        test.each([
            ['the pool is 0 (throwaway profiles)', { poolSize: 0, extensionPath: EXT }],
            ['no extension path is set', { poolSize: 3, extensionPath: '' }],
            ['the pool is negative', { poolSize: -1, extensionPath: EXT }],
        ])('%s: nothing is launched', async (_label, options) => {
            const result = await warmUpProfiles({ ...options, logger: quietLogger });
            expect(result).toMatchObject({ warmed: 0, skipped: 0, failed: 0, total: 0 });
            expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
        });
    });

    test('the leases are given back, so the campaign can use the profiles', async () => {
        chromium.launchPersistentContext.mockImplementation(async () => fakeContext());

        await warmUpProfiles({ poolSize: 3, extensionPath: EXT, logger: quietLogger });

        // A held lease would leave the campaign's first visits waiting forever.
        expect(profilePool.getPoolStats().busy).toBe(0);
    });

    test('a failed warm-up still gives the leases back', async () => {
        chromium.launchPersistentContext.mockRejectedValue(new Error('nope'));

        await warmUpProfiles({ poolSize: 2, extensionPath: EXT, logger: quietLogger });

        expect(profilePool.getPoolStats().busy).toBe(0);
    });
});

describe('the campaign runs it before any visit', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'core', 'visitLogic.js'), 'utf8');

    test('start() calls the warm-up', () => {
        expect(source).toMatch(/await warmUpProfiles\(\{/);
    });

    test('it runs only when profiles are actually pooled', () => {
        const call = source.slice(source.indexOf('if (pool > 0) {'), source.indexOf('await warmUpProfiles({'));
        expect(call).toMatch(/pool > 0/);
    });

    // Warming after the first visits had already started would defeat it.
    test('it happens before the visits are built', () => {
        expect(source.indexOf('await warmUpProfiles({'))
            .toBeLessThan(source.indexOf('getUserAgentProfiles(userAgentType'));
    });

    test('a stop request reaches it', () => {
        const call = source.slice(source.indexOf('await warmUpProfiles({'),
            source.indexOf('await warmUpProfiles({') + 400);
        expect(call).toMatch(/shouldStop:/);
    });
});
