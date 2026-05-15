/**
 * Manual-mode feature-parity dispatch tests. Confirms _executeManualTask
 * threads through all the fields that used to be auto-mode-only:
 *   - returning-user cookie injection (savedCookies + isOldUser)
 *   - proxy / IP rotation / fast mode resource block flags
 *   - traffic source resolution (UTM-modified URL, search referer)
 *   - restrictToPrimaryDomain, previousURL, useBaseUrlForOldUser
 */

jest.mock('../src/core/manualVisitor', () => {
    return jest.fn().mockImplementation((config) => ({
        url: config.url,
        threadId: config.threadId,
        _config: config,
        execute: async () => {},
        forceClose: async () => {},
        getCookies: () => [],
        replay: null,
    }));
});

jest.mock('../src/helpers/logger', () => ({
    getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    initCampaignLogger: () => null,
    closeCampaignLogger: () => {},
    getCampaignLogDir: () => null,
}));

const VisitLogic = require('../src/core/visitLogic');
const ManualVisitor = require('../src/core/manualVisitor');

class FakeQueue {
    constructor() { this.tasks = []; }
    add(fn) { const p = fn(); this.tasks.push(p); return p; }
    async onIdle() { await Promise.all(this.tasks); }
    clear() { this.tasks = []; }
}

function makeUAs(n) { return Array.from({ length: n }, (_, i) => `UA-${i}`); }
function makeScreens(n) { return Array.from({ length: n }, (_, i) => ({ width: 1000 + i, height: 800 })); }

const BASE = {
    refererList: [''],
    isReferer: false,
    threads: 5,
    threadDelay: 0,
    memClear: 0,
    playMode: 'Fastest',
    adsBlock: false,
    inputCommands: '',
    location: 'India',
    extensionEnabled: false,
    extensionPath: '',
};

describe('Manual mode parity dispatch', () => {
    beforeEach(() => {
        ManualVisitor.mockClear();
    });

    test('proxy + IP rotation + fast mode flags reach ManualVisitor', async () => {
        const vl = new VisitLogic();
        vl.isRunning = true;
        vl._createQueue = async () => new FakeQueue();

        await vl._runManualMode({
            ...BASE,
            urlList: ['https://a.com'],
            totalBatches: 1,
            userAgentList: makeUAs(100),
            screenSizes: makeScreens(100),
            oldUserFlags: Array(100).fill(false),
            proxyEnabled: true,
            proxyUrl: 'http://user:pass@proxy.example.com:8080',
            ipRotation: true,
            fastMode: true,
            blockImages: true,
            blockMedia: false,
            blockFonts: true,
            blockStyles: false,
            blockScripts: true,
        });

        const first = ManualVisitor.mock.calls[0][0];
        expect(first.proxyEnabled).toBe(true);
        expect(first.proxyUrl).toContain('proxy.example.com');
        expect(first.ipRotation).toBe(true);
        expect(first.fastMode).toBe(true);
        expect(first.blockImages).toBe(true);
        expect(first.blockMedia).toBe(false);
        expect(first.blockFonts).toBe(true);
        expect(first.blockScripts).toBe(true);
    });

    test('returning-user flags are forced NEW while cookie pool empty', async () => {
        const vl = new VisitLogic();
        vl.isRunning = true;
        vl.cookieJarPool = []; // pool empty
        vl._createQueue = async () => new FakeQueue();

        await vl._runManualMode({
            ...BASE,
            urlList: ['https://a.com'],
            totalBatches: 1,
            userAgentList: makeUAs(100),
            screenSizes: makeScreens(100),
            oldUserFlags: Array(100).fill(true), // all "old" but pool empty
            previousURL: 'https://a.com/blog',
            useBaseUrlForOldUser: true,
        });

        // Every visitor should have been forced to NEW since pool was empty
        const allNew = ManualVisitor.mock.calls.every(c => c[0].isOldUser === false);
        expect(allNew).toBe(true);
    });

    test('returning-user injection fires when pool is seeded', async () => {
        const vl = new VisitLogic();
        vl.isRunning = true;
        vl.cookieJarPool = [[{ name: '_ga', value: 'GA1.x.seed' }]];
        vl._createQueue = async () => new FakeQueue();

        await vl._runManualMode({
            ...BASE,
            urlList: ['https://a.com'],
            totalBatches: 1,
            userAgentList: makeUAs(100),
            screenSizes: makeScreens(100),
            oldUserFlags: Array(100).fill(true),
            previousURL: 'https://a.com/blog',
        });

        // With seeded pool every visit should be marked old and receive cookies
        const allOld = ManualVisitor.mock.calls.every(c => c[0].isOldUser === true);
        const allHaveCookies = ManualVisitor.mock.calls.every(
            c => Array.isArray(c[0].savedCookies) && c[0].savedCookies.length > 0
        );
        expect(allOld).toBe(true);
        expect(allHaveCookies).toBe(true);
        expect(ManualVisitor.mock.calls[0][0].previousURL).toBe('https://a.com/blog');
    });

    test('traffic source resolution rewrites url + sets referer for Organic', async () => {
        const vl = new VisitLogic();
        vl.isRunning = true;
        vl._createQueue = async () => new FakeQueue();

        await vl._runManualMode({
            ...BASE,
            urlList: ['https://a.com/landing'],
            totalBatches: 1,
            userAgentList: makeUAs(100),
            screenSizes: makeScreens(100),
            oldUserFlags: Array(100).fill(false),
            trafficSourceType: 'Organic Search',
            searchEngine: 'Google',
            searchKeywords: 'best widgets',
        });

        const first = ManualVisitor.mock.calls[0][0];
        expect(first.url).toContain('utm_source=google');
        expect(first.url).toContain('utm_medium=organic');
        expect(first.referer).toContain('google.com/search');
        expect(first.isReferer).toBe(true);
        // Organic = header-only, don't navigate to Google first
        expect(first.visitReferer).toBe(false);
    });

    test('restrictToPrimaryDomain + avgSessionDuration are passed through', async () => {
        const vl = new VisitLogic();
        vl.isRunning = true;
        vl._createQueue = async () => new FakeQueue();

        await vl._runManualMode({
            ...BASE,
            urlList: ['https://a.com'],
            totalBatches: 1,
            userAgentList: makeUAs(100),
            screenSizes: makeScreens(100),
            oldUserFlags: Array(100).fill(false),
            restrictToPrimaryDomain: true,
            avgSessionDuration: 45,
        });

        const first = ManualVisitor.mock.calls[0][0];
        expect(first.restrictToPrimaryDomain).toBe(true);
        expect(first.avgSessionDuration).toBe(45);
    });
});
