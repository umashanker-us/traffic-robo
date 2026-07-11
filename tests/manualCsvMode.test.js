/**
 * Manual mode CSV dispatch — verifies that _runManualMode enqueues exactly
 * the per-URL visit counts from the CSV (not totalBatches * 100 * urlList).
 *
 * Mocks ManualVisitor so no browser is launched, just tracks (url, threadId)
 * for every constructed visitor.
 */

jest.mock('../src/core/manualVisitor', () => {
    return jest.fn().mockImplementation((config) => ({
        url: config.url,
        threadId: config.threadId,
        execute: async () => {},
        forceClose: async () => {},
    }));
});

// Synchronous fake queue — runs each task immediately. Lets us verify
// dispatch counts without dealing with p-queue's dynamic ESM import.
class FakeQueue {
    constructor() { this.tasks = []; }
    add(fn) { const p = fn(); this.tasks.push(p); return p; }
    async onIdle() { await Promise.all(this.tasks); }
    clear() { this.tasks = []; }
}

jest.mock('../src/helpers/logger', () => ({
    getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    initCampaignLogger: () => null,
    closeCampaignLogger: () => {},
    getCampaignLogDir: () => null,
}));

const VisitLogic = require('../src/core/visitLogic');
const ManualVisitor = require('../src/core/manualVisitor');

function makeUserAgents(n) {
    return Array.from({ length: n }, (_, i) => `UA-${i}`);
}
function makeScreens(n) {
    return Array.from({ length: n }, (_, i) => ({ width: 1000 + i, height: 800 }));
}

describe('_runManualMode CSV branch', () => {
    beforeEach(() => {
        ManualVisitor.mockClear();
    });

    test('CSV mode: enqueues exactly per-URL visit counts', async () => {
        const vl = new VisitLogic();
        vl.isRunning = true;
        vl._createQueue = async () => new FakeQueue();

        const resolvedCsvRows = [
            { url: 'https://a.com', visits: 30, bounce: 40, duration: 35, pages: 3 },
            { url: 'https://b.com', visits: 50, bounce: 45, duration: 40, pages: 4 },
            { url: 'https://c.com', visits: 20, bounce: 42, duration: 38, pages: 5 },
        ];

        await vl._runManualMode({
            urlList: resolvedCsvRows.map(r => r.url),
            refererList: [''],
            isReferer: false,
            totalBatches: 1,
            threads: 5,
            threadDelay: 0,
            memClear: 0,
            userAgentList: makeUserAgents(100),
            screenSizes: makeScreens(100),
            playMode: 'Fastest',
            adsBlock: false,
            inputCommands: '',
            location: 'India',
            extensionEnabled: false,
            extensionPath: '',
            resolvedCsvRows,
        });

        const calls = ManualVisitor.mock.calls.map(c => c[0].url);
        expect(calls).toHaveLength(100); // 30 + 50 + 20
        expect(calls.filter(u => u === 'https://a.com')).toHaveLength(30);
        expect(calls.filter(u => u === 'https://b.com')).toHaveLength(50);
        expect(calls.filter(u => u === 'https://c.com')).toHaveLength(20);
    });

    test('Standard mode (no CSV): enqueues totalBatches * 100 * urlList', async () => {
        const vl = new VisitLogic();
        vl.isRunning = true;
        vl._createQueue = async () => new FakeQueue();

        await vl._runManualMode({
            urlList: ['https://a.com', 'https://b.com'],
            refererList: [''],
            isReferer: false,
            totalBatches: 1,
            threads: 5,
            threadDelay: 0,
            memClear: 0,
            userAgentList: makeUserAgents(100),
            screenSizes: makeScreens(100),
            playMode: 'Fastest',
            adsBlock: false,
            inputCommands: '',
            location: 'India',
            extensionEnabled: false,
            extensionPath: '',
            // resolvedCsvRows omitted → standard branch
        });

        const calls = ManualVisitor.mock.calls.map(c => c[0].url);
        expect(calls).toHaveLength(200); // 1 batch * 100 * 2 URLs
        expect(calls.filter(u => u === 'https://a.com')).toHaveLength(100);
        expect(calls.filter(u => u === 'https://b.com')).toHaveLength(100);
    });

    test('CSV mode: URL with visits > 100 spans multiple batches', async () => {
        const vl = new VisitLogic();
        vl.isRunning = true;
        vl._createQueue = async () => new FakeQueue();

        const resolvedCsvRows = [
            { url: 'https://big.com', visits: 250, bounce: 40, duration: 35, pages: 3 },
        ];

        await vl._runManualMode({
            urlList: ['https://big.com'],
            refererList: [''],
            isReferer: false,
            totalBatches: 1,
            threads: 5,
            threadDelay: 0,
            memClear: 0,
            userAgentList: makeUserAgents(100),
            screenSizes: makeScreens(100),
            playMode: 'Fastest',
            adsBlock: false,
            inputCommands: '',
            location: 'India',
            extensionEnabled: false,
            extensionPath: '',
            resolvedCsvRows,
        });

        expect(ManualVisitor.mock.calls).toHaveLength(250);
    });

    test('CSV mode: enqueues URLs round-robin so all run in parallel', async () => {
        const vl = new VisitLogic();
        vl.isRunning = true;
        vl._createQueue = async () => new FakeQueue();

        const resolvedCsvRows = [
            { url: 'https://a.com', visits: 3, bounce: 40, duration: 35, pages: 3 },
            { url: 'https://b.com', visits: 3, bounce: 45, duration: 40, pages: 4 },
            { url: 'https://c.com', visits: 3, bounce: 42, duration: 38, pages: 5 },
        ];

        await vl._runManualMode({
            urlList: resolvedCsvRows.map(r => r.url),
            refererList: [''],
            isReferer: false,
            totalBatches: 1,
            threads: 3,
            threadDelay: 0,
            memClear: 0,
            userAgentList: makeUserAgents(100),
            screenSizes: makeScreens(100),
            playMode: 'Fastest',
            adsBlock: false,
            inputCommands: '',
            location: 'India',
            extensionEnabled: false,
            extensionPath: '',
            resolvedCsvRows,
        });

        const calls = ManualVisitor.mock.calls.map(c => c[0].url);
        // First 3 picks must hit 3 distinct URLs (true parallel coverage)
        expect(new Set(calls.slice(0, 3)).size).toBe(3);
        // Order is round-robin: a,b,c,a,b,c,a,b,c
        expect(calls).toEqual([
            'https://a.com', 'https://b.com', 'https://c.com',
            'https://a.com', 'https://b.com', 'https://c.com',
            'https://a.com', 'https://b.com', 'https://c.com',
        ]);
    });

    test('CSV mode: uneven visit counts — exhausted URL drops out of rotation', async () => {
        const vl = new VisitLogic();
        vl.isRunning = true;
        vl._createQueue = async () => new FakeQueue();

        const resolvedCsvRows = [
            { url: 'https://a.com', visits: 1, bounce: 40, duration: 35, pages: 3 },
            { url: 'https://b.com', visits: 3, bounce: 45, duration: 40, pages: 4 },
            { url: 'https://c.com', visits: 2, bounce: 42, duration: 38, pages: 5 },
        ];

        await vl._runManualMode({
            urlList: resolvedCsvRows.map(r => r.url),
            refererList: [''],
            isReferer: false,
            totalBatches: 1,
            threads: 3,
            threadDelay: 0,
            memClear: 0,
            userAgentList: makeUserAgents(100),
            screenSizes: makeScreens(100),
            playMode: 'Fastest',
            adsBlock: false,
            inputCommands: '',
            location: 'India',
            extensionEnabled: false,
            extensionPath: '',
            resolvedCsvRows,
        });

        const calls = ManualVisitor.mock.calls.map(c => c[0].url);
        // Per-URL totals preserved
        expect(calls).toHaveLength(6);
        expect(calls.filter(u => u === 'https://a.com')).toHaveLength(1);
        expect(calls.filter(u => u === 'https://b.com')).toHaveLength(3);
        expect(calls.filter(u => u === 'https://c.com')).toHaveLength(2);
        // Round 1: a,b,c. Round 2: b,c (a exhausted). Round 3: b (c exhausted).
        expect(calls).toEqual([
            'https://a.com', 'https://b.com', 'https://c.com',
            'https://b.com', 'https://c.com',
            'https://b.com',
        ]);
    });

    test('CSV mode: respects isRunning=false (no further enqueues)', async () => {
        const vl = new VisitLogic();
        vl.isRunning = false; // already stopped
        vl._createQueue = async () => new FakeQueue();

        const resolvedCsvRows = [
            { url: 'https://a.com', visits: 50, bounce: 40, duration: 35, pages: 3 },
        ];

        await vl._runManualMode({
            urlList: ['https://a.com'],
            refererList: [''],
            isReferer: false,
            totalBatches: 1,
            threads: 5,
            threadDelay: 0,
            memClear: 0,
            userAgentList: makeUserAgents(100),
            screenSizes: makeScreens(100),
            playMode: 'Fastest',
            adsBlock: false,
            inputCommands: '',
            location: 'India',
            extensionEnabled: false,
            extensionPath: '',
            resolvedCsvRows,
        });

        expect(ManualVisitor.mock.calls).toHaveLength(0);
    });
});
