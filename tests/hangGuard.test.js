/**
 * Hang guards
 *
 * Playwright times out navigations and selector waits, but puts no timeout at
 * all on page.evaluate or page.mouse.*. On a page whose JS main thread has
 * wedged, those calls never answer.
 *
 * Measured on a live 100-visit run: visit #77 logged "Page 3 loaded" and then
 * nothing for 494 seconds, holding one of five worker slots the entire time. It
 * only unblocked when the campaign ended and the context closed, and then
 * reported "Target page, context or browser has been closed".
 *
 * So every un-timed browser call in the behaviour and link-harvest paths now
 * runs under a deadline, and a visit has an absolute ceiling on top.
 */

const AutomaticVisitor = require('../src/core/automaticVisitor');
const ManualVisitor = require('../src/core/manualVisitor');
const BrowserSession = require('../src/core/browserSession');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

function makeVisitor(overrides = {}) {
    const v = new AutomaticVisitor({
        campaignUrl: 'https://example.com/',
        userAgent: UA,
        threadId: 1,
        visit: {
            getPagePerSession: () => 3,
            getAdditionalPages: () => 2,
            getAvgSessionDuration: () => 10,
            getWaitTimePerPageSec: () => 4,
            getWaitTimePerPageMs: () => 4000,
            isBounce: () => false,
        },
        screenSize: { width: 1920, height: 1080 },
        playMode: 'Slow',
        location: 'India',
        ...overrides,
    });
    v.logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
    v.replay = { logError: jest.fn(), logBehavior: jest.fn(), _addEvent: jest.fn() };
    return v;
}

/** A page that has stopped answering the renderer. */
const wedgedPage = () => ({
    url: () => 'https://example.com/',
    evaluate: () => new Promise(() => {}),
    mouse: { move: () => new Promise(() => {}) },
});

afterEach(() => { jest.useRealTimers(); });

describe('_withDeadline', () => {
    test('passes the value through when the call answers', async () => {
        const v = makeVisitor();
        const result = await v._withDeadline('Fast', 1000, async () => 'answered');
        expect(result).toEqual({ ok: true, value: 'answered' });
        expect(v.logger.warn).not.toHaveBeenCalled();
    });

    test('a call that never answers is abandoned, and says so', async () => {
        const v = makeVisitor();
        const result = await v._withDeadline('Scroll', 25, () => new Promise(() => {}));

        expect(result.ok).toBe(false);
        expect(result.value).toBeUndefined();
        expect(v.logger.warn.mock.calls[0][0]).toMatch(/Scroll did not return within 25ms/);
        expect(v.logger.warn.mock.calls[0][0]).toMatch(/stopped responding/);
        // Recorded as an event, never as an error: the page is loaded and GA4
        // already has its beacon, so the visit succeeded with one cosmetic step
        // skipped. Counting it put 12 phantom errors in a clean campaign.
        expect(v.replay._addEvent).toHaveBeenCalledWith('deadline', { label: 'Scroll', ms: 25 });
        expect(v.replay.logError).not.toHaveBeenCalled();
        expect(v._deadlineMisses).toBe(1);
    });

    // A falsy or undefined result is a legitimate answer and must not read as a
    // timeout — the sentinel is compared by identity for exactly this reason.
    test.each([
        ['undefined', undefined],
        ['null', null],
        ['false', false],
        ['0', 0],
        ['an empty string', ''],
    ])('%s is an answer, not a miss', async (_label, value) => {
        const v = makeVisitor();
        const result = await v._withDeadline('Call', 1000, async () => value);
        expect(result).toEqual({ ok: true, value });
        expect(v._deadlineMisses).toBeUndefined();
    });

    test('a rejection is reported, not thrown at the caller', async () => {
        const v = makeVisitor();
        const result = await v._withDeadline('Boom', 1000, async () => {
            throw new Error('Target page, context or browser has been closed');
        });
        expect(result.ok).toBe(false);
        expect(v.logger.debug.mock.calls[0][0]).toMatch(/Boom failed: Target page/);
    });

    // The abandoned call keeps running and may reject long after we moved on.
    test('a rejection arriving after the deadline stays handled', async () => {
        const v = makeVisitor();
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);

        const result = await v._withDeadline('Late', 20,
            () => new Promise((_res, rej) => setTimeout(() => rej(new Error('too late')), 60)));
        expect(result.ok).toBe(false);

        await new Promise(resolve => setTimeout(resolve, 150));
        process.off('unhandledRejection', unhandled);
        expect(unhandled).not.toHaveBeenCalled();
    });

    test('the sentinel is a symbol, so no page value can impersonate a timeout', () => {
        expect(typeof BrowserSession._EXPIRED).toBe('symbol');
    });

    test('both visitors share the same guard', () => {
        expect(ManualVisitor.prototype._withDeadline).toBe(AutomaticVisitor.prototype._withDeadline);
    });
});

describe('the timeouts themselves', () => {
    const source = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'src', 'core', 'automaticVisitor.js'), 'utf8');
    const constant = (name) => Number(source.match(new RegExp(`${name}\\s*=\\s*(\\d+)`))[1]);

    // A busy renderer is not a wedged one. At 5s a live 33-visit run against an
    // ad-heavy site produced 12 misses — 10 mouse moves, 2 scrolls — on pages
    // that were only slow. The hang these exist for was 494 seconds, so sitting
    // anywhere near normal slowness buys nothing.
    test('an action gets enough room that a merely busy page is not cut off', () => {
        expect(constant('ACTION_TIMEOUT_MS')).toBeGreaterThanOrEqual(15000);
    });

    test('link harvesting gets more room than a single action', () => {
        expect(constant('LINK_TIMEOUT_MS')).toBeGreaterThan(constant('ACTION_TIMEOUT_MS'));
    });

    // And still far below the ceiling, so a wedge is caught by the deadline
    // rather than by killing the browser.
    test('both stay well under the visit ceiling', () => {
        expect(constant('LINK_TIMEOUT_MS')).toBeLessThan(makeVisitor()._visitCeilingMs() / 2);
    });
});

describe('_visitCeilingMs', () => {
    test('never fires inside a normal visit, and never waits forever', () => {
        const ceiling = makeVisitor()._visitCeilingMs();
        expect(ceiling).toBeGreaterThanOrEqual(3 * 60 * 1000);
        expect(ceiling).toBeLessThanOrEqual(15 * 60 * 1000);
    });

    test('a long configured session raises it', () => {
        const long = makeVisitor({
            visit: {
                getPagePerSession: () => 20,
                getAdditionalPages: () => 19,
                getAvgSessionDuration: () => 600,
                getWaitTimePerPageSec: () => 30,
                getWaitTimePerPageMs: () => 30000,
                isBounce: () => false,
            },
        })._visitCeilingMs();
        expect(long).toBeGreaterThan(3 * 60 * 1000);
        expect(long).toBeLessThanOrEqual(15 * 60 * 1000);
    });

    // The 494s visit was configured for 7s over 3 pages.
    test('the visit that hung would have been cut off', () => {
        const v = makeVisitor({
            visit: {
                getPagePerSession: () => 3,
                getAdditionalPages: () => 2,
                getAvgSessionDuration: () => 7,
                getWaitTimePerPageSec: () => 2,
                getWaitTimePerPageMs: () => 2333,
                isBounce: () => false,
            },
        });
        expect(v._visitCeilingMs()).toBeLessThan(494_000);
    });

    test('a visit object that cannot answer still gets a ceiling', () => {
        const v = makeVisitor();
        v.visit = { getPagePerSession: () => { throw new Error('nope'); } };
        v.randomWaitMs = NaN;
        expect(v._visitCeilingMs()).toBe(3 * 60 * 1000);
    });
});

describe('the visit ceiling', () => {
    test('closes the browser so the worker slot is released', async () => {
        jest.useFakeTimers();
        const v = makeVisitor();
        v.forceClose = jest.fn().mockResolvedValue(undefined);

        const stop = v._startVisitWatchdog();
        await jest.advanceTimersByTimeAsync(v._visitCeilingMs() + 50);

        expect(v.forceClose).toHaveBeenCalled();
        expect(v.logger.warn.mock.calls[0][0]).toMatch(/ceiling/);
        expect(v.replay.logError).toHaveBeenCalledWith('watchdog', expect.stringMatching(/ceiling/));
        stop();
    });

    test('a visit that finishes normally never triggers it', async () => {
        jest.useFakeTimers();
        const v = makeVisitor();
        v.forceClose = jest.fn().mockResolvedValue(undefined);

        const stop = v._startVisitWatchdog();
        stop();
        await jest.advanceTimersByTimeAsync(20 * 60 * 1000);

        expect(v.forceClose).not.toHaveBeenCalled();
        expect(v.logger.warn).not.toHaveBeenCalled();
    });
});

describe('behaviour on a page that stopped responding', () => {
    test('scrolling gives up instead of hanging on every scroll in turn', async () => {
        jest.useFakeTimers();
        const v = makeVisitor();
        v.page = wedgedPage();

        const done = v._simulateScrolling(1.0, async () => {});
        await jest.advanceTimersByTimeAsync(90000);
        await done;

        // One miss, not one per scroll in the sequence.
        expect(v._deadlineMisses).toBe(1);
        expect(v.replay.logBehavior).not.toHaveBeenCalled();
    });

    test('mouse movement gives up the same way', async () => {
        jest.useFakeTimers();
        const v = makeVisitor();
        v.page = wedgedPage();

        const done = v._simulateMouseMovement(async () => {});
        await jest.advanceTimersByTimeAsync(90000);
        await done;

        expect(v._deadlineMisses).toBe(1);
        expect(v.replay.logBehavior).not.toHaveBeenCalled();
    });

    test('link harvesting returns nothing rather than stalling the session', async () => {
        jest.useFakeTimers();
        const v = makeVisitor();
        v.page = wedgedPage();

        const pending = v._getPageLinks();
        await jest.advanceTimersByTimeAsync(90000);

        await expect(pending).resolves.toEqual([]);
        expect(v._deadlineMisses).toBe(1);
    });

    test('a bounce glance gives up too', async () => {
        jest.useFakeTimers();
        const v = makeVisitor();
        v.page = wedgedPage();

        const done = v._simulateQuickGlance();
        await jest.advanceTimersByTimeAsync(90000);
        await done;

        expect(v._deadlineMisses).toBeGreaterThanOrEqual(1);
    });
});

describe('a healthy page is untouched', () => {
    test('scrolls and mouse moves are still performed and still recorded', async () => {
        const v = makeVisitor();
        const scrolled = [];
        v.page = {
            url: () => 'https://example.com/',
            evaluate: async (fn, arg) => { scrolled.push(arg); },
            mouse: { move: async () => undefined },
        };

        await v._simulateMouseMovement(async () => {});
        await v._simulateScrolling(1.0, async () => {});

        expect(scrolled.length).toBeGreaterThanOrEqual(2);
        const kinds = v.replay.logBehavior.mock.calls.map(c => c[0]);
        expect(kinds).toContain('scroll');
        expect(kinds).toContain('mouse_move');
        expect(v._deadlineMisses).toBeUndefined();
        expect(v.logger.warn).not.toHaveBeenCalled();
    });

    test('harvested links come back unchanged', async () => {
        const v = makeVisitor();
        v.page = {
            url: () => 'https://example.com/',
            evaluate: async () => ['/a', '/b'],
        };
        await expect(v._getPageLinks()).resolves.toEqual(['/a', '/b']);
    });
});
