/**
 * "Proxy GA4 /collect beacons" toggle
 *
 * GA4 /collect beacons are the bulk of proxy bandwidth (thousands of hits per
 * campaign). With the toggle off the proxy is reserved for Custom Proxy URLs,
 * and beacons go direct — but they must still get the returning-user patch and
 * still reach the replay log and the live event monitor.
 */

const AutomaticVisitor = require('../src/core/automaticVisitor');
const ManualVisitor = require('../src/core/manualVisitor');

const COLLECT_URL = 'https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&_fv=1&sct=1&sid=1700000000';

describe('proxyCollectEnabled flag', () => {
    const base = {
        campaignUrl: 'https://example.com/',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.7499.1 Safari/537.36',
        threadId: 1,
        visit: { pagePerSession: 1, avgSessionDuration: 10 },
        screenSize: { width: 1920, height: 1080 },
        playMode: 'Fast',
        proxyEnabled: true,
        proxyUrl: 'http://u:p@proxy.example.com:8080',
    };

    test('defaults to on when the key is absent (back-compat)', () => {
        expect(new AutomaticVisitor({ ...base }).proxyCollectEnabled).toBe(true);
        expect(new ManualVisitor({ ...base, url: base.campaignUrl }).proxyCollectEnabled).toBe(true);
    });

    test('explicit true keeps collect proxying on', () => {
        expect(new AutomaticVisitor({ ...base, proxyCollectEnabled: true }).proxyCollectEnabled).toBe(true);
        expect(new ManualVisitor({ ...base, url: base.campaignUrl, proxyCollectEnabled: true }).proxyCollectEnabled).toBe(true);
    });

    test('explicit false turns collect proxying off', () => {
        expect(new AutomaticVisitor({ ...base, proxyCollectEnabled: false }).proxyCollectEnabled).toBe(false);
        expect(new ManualVisitor({ ...base, url: base.campaignUrl, proxyCollectEnabled: false }).proxyCollectEnabled).toBe(false);
    });
});

describe('_handleDirectCollect', () => {
    function makeRoute() {
        const calls = [];
        return {
            calls,
            continue: async (opts) => { calls.push(opts || {}); },
        };
    }

    function makeVisitor(Visitor, isOldUser) {
        const v = Object.create(Visitor.prototype);
        v.logger = { info: () => {}, warn: () => {}, debug: () => {} };
        v.isOldUser = isOldUser;
        v.loggedRequests = [];
        v.emittedEvents = [];
        v.replay = { logRequest: (url, isGA, viaProxy) => v.loggedRequests.push({ url, isGA, viaProxy }) };
        v._emitGA4Event = (url, viaProxy) => v.emittedEvents.push({ url, viaProxy });
        return v;
    }

    test('new user: beacon continues unchanged and is reported as direct', async () => {
        const v = makeVisitor(AutomaticVisitor, false);
        const route = makeRoute();

        await v._handleDirectCollect(route, COLLECT_URL);

        expect(route.calls).toHaveLength(1);
        expect(route.calls[0].url).toBeUndefined();
        expect(v.loggedRequests).toEqual([{ url: COLLECT_URL, isGA: true, viaProxy: false }]);
        expect(v.emittedEvents).toEqual([{ url: COLLECT_URL, viaProxy: false }]);
    });

    test('returning user: beacon is patched before continuing', async () => {
        const v = makeVisitor(AutomaticVisitor, true);
        const route = makeRoute();

        await v._handleDirectCollect(route, COLLECT_URL);

        expect(route.calls).toHaveLength(1);
        const patched = route.calls[0].url;
        expect(patched).toBeDefined();
        expect(patched).not.toContain('_fv=');
        expect(patched).toContain('sct=2');
        // replay and monitor must see the patched URL, not the original
        expect(v.loggedRequests[0].url).toBe(patched);
        expect(v.emittedEvents[0].url).toBe(patched);
    });

    test('ManualVisitor behaves the same, without the event monitor', async () => {
        const v = makeVisitor(ManualVisitor, true);
        const route = makeRoute();

        await v._handleDirectCollect(route, COLLECT_URL);

        const patched = route.calls[0].url;
        expect(patched).toContain('sct=2');
        expect(patched).not.toContain('_fv=');
        expect(v.loggedRequests[0].url).toBe(patched);
    });

    test('survives a visitor with no replay attached', async () => {
        const v = makeVisitor(ManualVisitor, false);
        v.replay = null;
        const route = makeRoute();

        await expect(v._handleDirectCollect(route, COLLECT_URL)).resolves.toBeUndefined();
        expect(route.calls).toHaveLength(1);
    });
});
