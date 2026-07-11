/**
 * Automatic mode CSV dispatch — verifies _runAutomaticMode enqueues exactly
 * the per-URL visit counts from the CSV and uses each URL's own visits array
 * (so each URL gets its own bounce/duration/pages distribution).
 */

jest.mock('../src/core/automaticVisitor', () => {
    return jest.fn().mockImplementation((config) => ({
        campaignUrl: config.campaignUrl,
        threadId: config.threadId,
        visit: config.visit,
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
const AutomaticVisitor = require('../src/core/automaticVisitor');

class FakeQueue {
    constructor() { this.tasks = []; }
    add(fn) { const p = fn(); this.tasks.push(p); return p; }
    async onIdle() { await Promise.all(this.tasks); }
    clear() { this.tasks = []; }
}

function makeUserAgents(n) {
    return Array.from({ length: n }, (_, i) => `UA-${i}`);
}
function makeScreens(n) {
    return Array.from({ length: n }, (_, i) => ({ width: 1000 + i, height: 800 }));
}
function makeVisits(n) {
    return Array.from({ length: n }, (_, i) => ({ pages: (i % 5) + 1, duration: 30 + i }));
}

const COMMON_CONFIG = {
    refererList: [''],
    isReferer: false,
    threads: 5,
    threadDelay: 0,
    memClear: 0,
    restrictToPrimaryDomain: true,
    previousURL: null,
    useBaseUrlForOldUser: false,
    playMode: 'Fastest',
    adsBlock: false,
    proxyEnabled: false,
    proxyUrl: '',
    location: 'India',
    extensionEnabled: false,
    extensionPath: '',
    ipRotation: false,
    fastMode: false,
    blockImages: false, blockMedia: false, blockFonts: false,
    blockStyles: false, blockScripts: false,
    trafficSourceType: '',
    searchEngine: 'Google', searchKeywords: '', referralUrls: '',
    socialPlatforms: [], utmSource: '', utmMedium: '', utmCampaign: '',
    utmTerm: '', utmContent: '',
    mixedDirect: 25, mixedOrganic: 35, mixedReferral: 20, mixedSocial: 20,
};

describe('_runAutomaticMode CSV branch', () => {
    beforeEach(() => {
        AutomaticVisitor.mockClear();
    });

    test('CSV mode: enqueues exactly per-URL visit counts', async () => {
        const vl = new VisitLogic();
        vl.isRunning = true;
        vl.cookieJarPool = [[{ name: '_ga', value: 'GA1.x' }]]; // seed so isOldUser flag isn't forced false
        vl._createQueue = async () => new FakeQueue();

        const resolvedCsvRows = [
            { url: 'https://a.com', visits: 30, bounce: 40, duration: 35, pages: 3 },
            { url: 'https://b.com', visits: 50, bounce: 45, duration: 40, pages: 4 },
            { url: 'https://c.com', visits: 20, bounce: 42, duration: 38, pages: 5 },
        ];
        const csvVisitsByUrl = new Map(resolvedCsvRows.map(r => [r.url, makeVisits(100)]));

        await vl._runAutomaticMode({
            ...COMMON_CONFIG,
            urlList: resolvedCsvRows.map(r => r.url),
            totalBatches: 1,
            userAgentList: makeUserAgents(100),
            visitsList: makeVisits(100),
            csvVisitsByUrl,
            resolvedCsvRows,
            screenSizes: makeScreens(100),
            oldUserFlags: Array(100).fill(false),
        });

        const calls = AutomaticVisitor.mock.calls.map(c => c[0].campaignUrl);
        expect(calls).toHaveLength(100); // 30 + 50 + 20
        expect(calls.filter(u => u === 'https://a.com')).toHaveLength(30);
        expect(calls.filter(u => u === 'https://b.com')).toHaveLength(50);
        expect(calls.filter(u => u === 'https://c.com')).toHaveLength(20);
    });

    test('CSV mode: enqueues URLs round-robin so all run in parallel', async () => {
        const vl = new VisitLogic();
        vl.isRunning = true;
        vl.cookieJarPool = [[{ name: '_ga', value: 'GA1.x' }]];
        vl._createQueue = async () => new FakeQueue();

        const resolvedCsvRows = [
            { url: 'https://a.com', visits: 3, bounce: 40, duration: 35, pages: 3 },
            { url: 'https://b.com', visits: 3, bounce: 45, duration: 40, pages: 4 },
            { url: 'https://c.com', visits: 3, bounce: 42, duration: 38, pages: 5 },
        ];
        const csvVisitsByUrl = new Map(resolvedCsvRows.map(r => [r.url, makeVisits(100)]));

        await vl._runAutomaticMode({
            ...COMMON_CONFIG,
            urlList: resolvedCsvRows.map(r => r.url),
            totalBatches: 1,
            userAgentList: makeUserAgents(100),
            visitsList: makeVisits(100),
            csvVisitsByUrl,
            resolvedCsvRows,
            screenSizes: makeScreens(100),
            oldUserFlags: Array(100).fill(false),
        });

        const calls = AutomaticVisitor.mock.calls.map(c => c[0].campaignUrl);
        expect(new Set(calls.slice(0, 3)).size).toBe(3);
        expect(calls).toEqual([
            'https://a.com', 'https://b.com', 'https://c.com',
            'https://a.com', 'https://b.com', 'https://c.com',
            'https://a.com', 'https://b.com', 'https://c.com',
        ]);
    });

    test('CSV mode: each visit pulls from its OWN URL\'s visit distribution', async () => {
        // Tag each URL's csvVisits with a marker so we can verify the right
        // distribution flows through into ManualVisitor — interleaving must
        // not let URL B's visit metrics leak into URL A's task.
        const vl = new VisitLogic();
        vl.isRunning = true;
        vl.cookieJarPool = [[{ name: '_ga', value: 'GA1.x' }]];
        vl._createQueue = async () => new FakeQueue();

        const resolvedCsvRows = [
            { url: 'https://a.com', visits: 5, bounce: 40, duration: 35, pages: 3 },
            { url: 'https://b.com', visits: 5, bounce: 45, duration: 40, pages: 4 },
        ];
        const aVisits = Array.from({ length: 100 }, (_, i) => ({ tag: 'A', i }));
        const bVisits = Array.from({ length: 100 }, (_, i) => ({ tag: 'B', i }));
        const csvVisitsByUrl = new Map([
            ['https://a.com', aVisits],
            ['https://b.com', bVisits],
        ]);

        await vl._runAutomaticMode({
            ...COMMON_CONFIG,
            urlList: resolvedCsvRows.map(r => r.url),
            totalBatches: 1,
            userAgentList: makeUserAgents(100),
            visitsList: makeVisits(100),
            csvVisitsByUrl,
            resolvedCsvRows,
            screenSizes: makeScreens(100),
            oldUserFlags: Array(100).fill(false),
        });

        const calls = AutomaticVisitor.mock.calls;
        for (const call of calls) {
            const cfg = call[0];
            const expectedTag = cfg.campaignUrl === 'https://a.com' ? 'A' : 'B';
            expect(cfg.visit.tag).toBe(expectedTag);
        }
    });

    test('CSV mode: per-URL visit cursor wraps with reshuffle when visits > 100', async () => {
        // URL with 150 visits should see all 100 distribution slots at least
        // once, then start over after the wrap.
        const vl = new VisitLogic();
        vl.isRunning = true;
        vl.cookieJarPool = [[{ name: '_ga', value: 'GA1.x' }]];
        vl._createQueue = async () => new FakeQueue();

        const resolvedCsvRows = [
            { url: 'https://big.com', visits: 150, bounce: 40, duration: 35, pages: 3 },
        ];
        const bigVisits = Array.from({ length: 100 }, (_, i) => ({ slotId: i }));
        const csvVisitsByUrl = new Map([['https://big.com', bigVisits]]);

        await vl._runAutomaticMode({
            ...COMMON_CONFIG,
            urlList: ['https://big.com'],
            totalBatches: 1,
            userAgentList: makeUserAgents(100),
            visitsList: makeVisits(100),
            csvVisitsByUrl,
            resolvedCsvRows,
            screenSizes: makeScreens(100),
            oldUserFlags: Array(100).fill(false),
        });

        const calls = AutomaticVisitor.mock.calls;
        expect(calls).toHaveLength(150);
        // First 100 visits cover all 100 distribution slots exactly once
        const firstHundredSlots = calls.slice(0, 100).map(c => c[0].visit.slotId).sort((a, b) => a - b);
        expect(firstHundredSlots).toEqual(Array.from({ length: 100 }, (_, i) => i));
    });

    test('Standard mode (no CSV): enqueues totalBatches * 100 * urlList', async () => {
        const vl = new VisitLogic();
        vl.isRunning = true;
        vl.cookieJarPool = [[{ name: '_ga', value: 'GA1.x' }]];
        vl._createQueue = async () => new FakeQueue();

        await vl._runAutomaticMode({
            ...COMMON_CONFIG,
            urlList: ['https://a.com', 'https://b.com'],
            totalBatches: 1,
            userAgentList: makeUserAgents(100),
            visitsList: makeVisits(100),
            csvVisitsByUrl: null,
            resolvedCsvRows: null,
            screenSizes: makeScreens(100),
            oldUserFlags: Array(100).fill(false),
        });

        const calls = AutomaticVisitor.mock.calls.map(c => c[0].campaignUrl);
        expect(calls).toHaveLength(200); // 1 batch * 100 * 2 URLs
        expect(calls.filter(u => u === 'https://a.com')).toHaveLength(100);
        expect(calls.filter(u => u === 'https://b.com')).toHaveLength(100);
    });
});
