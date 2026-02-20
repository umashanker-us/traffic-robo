/**
 * Session Replay Logger - Automated Test Suite
 */

const { SessionReplay, SessionReplayStore } = require('../src/helpers/sessionReplay');

// ============================================================
// SessionReplay
// ============================================================
describe('SessionReplay', () => {

    test('should initialize with correct defaults', () => {
        const replay = new SessionReplay(1);
        expect(replay.threadId).toBe(1);
        expect(replay.events).toHaveLength(0);
        expect(replay.stats.pagesVisited).toBe(0);
        expect(replay.stats.ga4EventsFired).toBe(0);
    });

    test('logNavigation should track page visits', () => {
        const replay = new SessionReplay(1);
        replay.logNavigation('https://example.com', 500, 'Home');
        replay.logNavigation('https://example.com/about', 300, 'About');

        expect(replay.stats.pagesVisited).toBe(2);
        expect(replay.stats.totalLoadTimeMs).toBe(800);
        expect(replay.events).toHaveLength(2);
        expect(replay.events[0].type).toBe('navigation');
        expect(replay.events[0].pageNumber).toBe(1);
    });

    test('logGA4Detection should record GA status', () => {
        const replay = new SessionReplay(1);
        replay.logGA4Detection(true, { hasGtag: true, hasDataLayer: true, hasGTM: false });

        expect(replay.stats.ga4EventsDetected).toBe(true);
        expect(replay.events[0].detected).toBe(true);
        expect(replay.events[0].hasGtag).toBe(true);
    });

    test('logGA4Event should count GA events', () => {
        const replay = new SessionReplay(1);
        replay.logGA4Event('page_view', 'https://google-analytics.com/g/collect', 200, false);
        replay.logGA4Event('session_start', 'https://google-analytics.com/g/collect', 200, true);

        expect(replay.stats.ga4EventsFired).toBe(2);
        expect(replay.stats.proxyRequestsRouted).toBe(1);
    });

    test('logBehavior should track scroll and mouse events', () => {
        const replay = new SessionReplay(1);
        replay.logBehavior('scroll', { depth: 50 });
        replay.logBehavior('scroll', { depth: 75 });
        replay.logBehavior('mouse_move', { x: 100, y: 200 });

        expect(replay.stats.scrollEvents).toBe(2);
        expect(replay.stats.mouseEvents).toBe(1);
    });

    test('logBounce should mark as bounce', () => {
        const replay = new SessionReplay(1);
        replay.logBounce(2500);

        expect(replay.stats.isBounce).toBe(true);
        expect(replay.events[0].type).toBe('bounce');
    });

    test('logError should count errors', () => {
        const replay = new SessionReplay(1);
        replay.logError('navigation', 'Timeout loading page');
        replay.logError('ga4', 'Script blocked');

        expect(replay.stats.errors).toBe(2);
    });

    test('logPreviousURLVisit should mark as returning', () => {
        const replay = new SessionReplay(1);
        replay.logPreviousURLVisit('https://example.com', 'auto-extracted');

        expect(replay.stats.isReturningUser).toBe(true);
    });

    test('setSessionInfo should store metadata', () => {
        const replay = new SessionReplay(1);
        replay.setSessionInfo({
            userAgent: 'Mozilla/5.0 Chrome/143',
            screenSize: { width: 1920, height: 1080 },
            location: 'Mumbai',
            playMode: 'Slow',
            proxyMode: 'smart',
        });

        expect(replay.sessionInfo.location).toBe('Mumbai');
        expect(replay.sessionInfo.playMode).toBe('Slow');
    });

    test('getSummary should return complete data', () => {
        const replay = new SessionReplay(42);
        replay.logNavigation('https://test.com', 400);
        replay.logGA4Event('page_view', 'https://ga.com/collect', 200, false);
        replay.logBehavior('scroll', { depth: 50 });

        const summary = replay.getSummary();
        expect(summary.threadId).toBe(42);
        expect(summary.stats.pagesVisited).toBe(1);
        expect(summary.stats.ga4EventsFired).toBe(1);
        expect(summary.stats.scrollEvents).toBe(1);
        expect(summary.stats.avgLoadTimeMs).toBe(400);
        expect(summary.timeline).toHaveLength(3);
        expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('getCompactSummary should return short version', () => {
        const replay = new SessionReplay(1);
        replay.logNavigation('https://test.com', 200);
        const compact = replay.getCompactSummary();

        expect(compact.threadId).toBe(1);
        expect(compact.pages).toBe(1);
        expect(compact).not.toHaveProperty('timeline');
    });

    test('should respect maxEvents limit', () => {
        const replay = new SessionReplay(1, { maxEvents: 5 });
        for (let i = 0; i < 20; i++) {
            replay.logBehavior('scroll', { depth: i * 5 });
        }
        expect(replay.events).toHaveLength(5);
    });

    test('should respect capture flags', () => {
        const replay = new SessionReplay(1, {
            captureGA: false,
            captureBehavior: false,
            captureNavigation: false,
        });
        replay.logNavigation('https://test.com', 200);
        replay.logGA4Event('page_view', 'https://ga.com', 200);
        replay.logBehavior('scroll', { depth: 50 });

        expect(replay.events).toHaveLength(0);
        // Stats should still NOT update for disabled captures
        expect(replay.stats.pagesVisited).toBe(0);
        expect(replay.stats.ga4EventsFired).toBe(0);
    });

    test('events should have elapsed time', () => {
        const replay = new SessionReplay(1);
        replay.logNavigation('https://test.com', 200);

        expect(replay.events[0].elapsed).toBeGreaterThanOrEqual(0);
        expect(replay.events[0].timestamp).toBeGreaterThan(0);
    });
});

// ============================================================
// SessionReplayStore
// ============================================================
describe('SessionReplayStore', () => {

    test('should store and retrieve replays', () => {
        const store = new SessionReplayStore();
        const replay = new SessionReplay(1);
        replay.logNavigation('https://test.com', 200);
        store.addReplay(replay);

        const retrieved = store.getReplay(1);
        expect(retrieved).not.toBeNull();
        expect(retrieved.threadId).toBe(1);
    });

    test('should return null for unknown ID', () => {
        const store = new SessionReplayStore();
        expect(store.getReplay(999)).toBeNull();
    });

    test('should evict oldest when over limit', () => {
        const store = new SessionReplayStore(3);
        for (let i = 1; i <= 5; i++) {
            const r = new SessionReplay(i);
            r.logNavigation('https://test.com', 200);
            store.addReplay(r);
        }

        expect(store.size).toBe(3);
        expect(store.getReplay(1)).toBeNull(); // Evicted
        expect(store.getReplay(2)).toBeNull(); // Evicted
        expect(store.getReplay(3)).not.toBeNull();
        expect(store.getReplay(5)).not.toBeNull();
    });

    test('getReplayList should return newest first', () => {
        const store = new SessionReplayStore();
        for (let i = 1; i <= 3; i++) {
            const r = new SessionReplay(i);
            r.logNavigation('https://test.com', 200);
            store.addReplay(r);
        }

        const list = store.getReplayList();
        expect(list).toHaveLength(3);
        expect(list[0].threadId).toBe(3); // Newest first
    });

    test('clear should remove all replays', () => {
        const store = new SessionReplayStore();
        const r = new SessionReplay(1);
        store.addReplay(r);
        store.clear();
        expect(store.size).toBe(0);
    });

    test('should ignore non-SessionReplay objects', () => {
        const store = new SessionReplayStore();
        store.addReplay({ fake: true });
        store.addReplay(null);
        expect(store.size).toBe(0);
    });
});
