/**
 * Report pipeline
 *
 * Four CSV columns and two stats used to be permanently empty or wrong, in every
 * case because the data existed but never reached the replay the report is built
 * from. These tests drive the real path — a visitor writing to a real
 * SessionReplay, then campaignExport reading its summary — so an empty column
 * fails here instead of in an export someone opens a week later.
 */

const AutomaticVisitor = require('../src/core/automaticVisitor');
const { SessionReplay } = require('../src/helpers/sessionReplay');
const { generateCSV, generateJSON } = require('../src/helpers/campaignExport');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.7499.1 Safari/537.36';
const COLLECT = 'https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&en=page_view&dl=https%3A%2F%2Fexample.com%2F';
const COLLECT_2 = 'https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&en=session_start&dl=https%3A%2F%2Fexample.com%2F';

function makeVisitor(extra) {
    const v = new AutomaticVisitor(Object.assign({
        campaignUrl: 'https://example.com/',
        userAgent: UA,
        threadId: 7,
        visit: { pagePerSession: 2, avgSessionDuration: 30, isBounce: () => false },
        screenSize: { width: 1920, height: 1080 },
        playMode: 'Fast',
        location: 'India',
    }, extra || {}));
    v.replay = new SessionReplay(v.threadId, { maxEvents: 200 });
    v.replay.setSessionInfo(v._buildSessionInfo({ mode: 'automatic' }));
    return v;
}

function csvRows(csv) {
    const lines = csv.split('\n');
    return { headers: lines[0].split(','), row: lines[1] };
}

describe('GA4 event names reach the report', () => {
    test('a beacon records its event name on the replay', () => {
        const v = makeVisitor();
        v._emitGA4Event(COLLECT, false);

        const summary = v.replay.getSummary();
        const events = summary.timeline.filter(e => e.type === 'ga4_event');
        expect(events).toHaveLength(1);
        expect(events[0].eventType).toBe('page_view');
        expect(summary.stats.ga4EventsFired).toBe(1);
    });

    // The defect: the column was always empty because no ga4_event was ever written.
    test('GA4EventTypes column lists the real event names', () => {
        const v = makeVisitor();
        v._emitGA4Event(COLLECT, false);
        v._emitGA4Event(COLLECT_2, true);

        const { headers, row } = csvRows(generateCSV([v.replay.getSummary()]));
        const idx = headers.indexOf('GA4EventTypes');
        expect(idx).toBeGreaterThan(-1);
        expect(row).toContain('page_view');
        expect(row).toContain('session_start');
    });

    test('a beacon with no event parameter still counts, as "collect"', () => {
        const v = makeVisitor();
        v._emitGA4Event('https://www.google-analytics.com/g/collect?v=2&tid=G-X', false);
        const events = v.replay.getSummary().timeline.filter(e => e.type === 'ga4_event');
        expect(events).toHaveLength(1);
        expect(events[0].eventType).toBe('collect');
    });

    test('counters are not doubled when the route handler also logs the request', () => {
        const v = makeVisitor();
        // This is the real pairing inside _handleDirectCollect.
        v.replay.logRequest(COLLECT, true, false);
        v._emitGA4Event(COLLECT, false);
        expect(v.replay.getSummary().stats.ga4EventsFired).toBe(1);
    });

    test('a proxied beacon is counted as proxied exactly once', () => {
        const v = makeVisitor();
        v.replay.logRequest(COLLECT, true, true);
        v._emitGA4Event(COLLECT, true);
        expect(v.replay.getSummary().stats.proxyRequestsRouted).toBe(1);
    });

    test('the live monitor still receives the event', () => {
        const seen = [];
        const v = makeVisitor({ onGA4Event: (e) => seen.push(e) });
        v._emitGA4Event(COLLECT, false);
        expect(seen).toHaveLength(1);
        expect(seen[0].eventType).toBe('page_view');
        expect(seen[0].tid).toBe('G-ABC123');
    });
});

describe('proxy and IP fields reach the report', () => {
    test('the proxy URL is stored masked and surfaces as a city', () => {
        const v = makeVisitor({
            proxyEnabled: true,
            proxyUrl: 'http://user-country-in-city-delhi:secret@gate.example.com:7000',
        });
        v.replay.setSessionInfo(v._buildSessionInfo());

        const summary = v.replay.getSummary();
        expect(summary.sessionInfo.proxyUrl).not.toContain('secret');
        expect(summary.sessionInfo.proxyUrl).toContain('***');

        const { headers, row } = csvRows(generateCSV([summary]));
        expect(headers).toContain('ProxyUsed');
        expect(row).not.toContain('secret');
    });

    // The defect: spoofedIP was read before the context assigned it.
    test('spoofedIP is filled in after the context is built', () => {
        const v = makeVisitor({ ipRotation: true });
        expect(v.replay.getSummary().sessionInfo.spoofedIP).toBeNull();

        v.currentIP = '49.202.16.14';
        v.replay.updateSessionInfo({ spoofedIP: v.currentIP });

        const summary = v.replay.getSummary();
        expect(summary.sessionInfo.spoofedIP).toBe('49.202.16.14');

        const { headers, row } = csvRows(generateCSV([summary]));
        expect(headers).toContain('SpoofedIP');
        expect(row).toContain('49.202.16.14');
    });
});

describe('extension status reaches the report', () => {
    test('a verified extension shows as Active with its profile', () => {
        const v = makeVisitor({ extensionEnabled: true });
        v.extensionLoaded = true;
        v.extensionProfileId = 'p2';
        v.replay.updateSessionInfo({ extensionLoaded: true, extensionProfileId: 'p2' });
        v.replay.logExtension(true, { profileId: 'p2' });

        const { headers, row } = csvRows(generateCSV([v.replay.getSummary()]));
        expect(headers).toContain('Extension');
        expect(headers).toContain('ExtensionProfile');
        expect(row).toContain('Active');
        expect(row).toContain('p2');
    });

    test('an extension that loaded but was not seen on the page says so', () => {
        const v = makeVisitor({ extensionEnabled: true });
        v.replay.updateSessionInfo({ extensionLoaded: true });
        v.replay.logExtension(false, {});
        expect(csvRows(generateCSV([v.replay.getSummary()])).row).toContain('Not detected');
    });

    test('an extension that never loaded is distinguished from one that is off', () => {
        const off = makeVisitor();
        expect(csvRows(generateCSV([off.replay.getSummary()])).row).toContain('Off');

        const notLoaded = makeVisitor({ extensionEnabled: true });
        expect(csvRows(generateCSV([notLoaded.replay.getSummary()])).row).toContain('Not loaded');
    });

    test('the JSON summary counts extension visits', () => {
        const a = makeVisitor({ extensionEnabled: true });
        a.replay.updateSessionInfo({ extensionLoaded: true });
        a.replay.logExtension(true, {});
        const b = makeVisitor({ extensionEnabled: true });
        b.replay.updateSessionInfo({ extensionLoaded: true });
        b.replay.logExtension(false, {});

        const json = generateJSON([a.replay.getSummary(), b.replay.getSummary()], {});
        expect(json.summary.extensionStats).toEqual({ visitsWithExtension: 2, visitsVerifiedActive: 1 });
    });
});

describe('behaviour counts reach the report', () => {
    test('scroll and mouse events are counted and exported', () => {
        const v = makeVisitor();
        v.replay.logBehavior('scroll', { px: 400 });
        v.replay.logBehavior('scroll', { px: 600 });
        v.replay.logBehavior('mouse_move', { x: 10, y: 20 });

        const summary = v.replay.getSummary();
        expect(summary.stats.scrollEvents).toBe(2);
        expect(summary.stats.mouseEvents).toBe(1);

        const { headers, row } = csvRows(generateCSV([summary]));
        expect(headers).toContain('ScrollEvents');
        expect(headers).toContain('MouseEvents');
        const cells = row.split(',');
        expect(cells[headers.indexOf('ScrollEvents')]).toBe('2');
        expect(cells[headers.indexOf('MouseEvents')]).toBe('1');
    });
});

describe('visit status', () => {
    test('a download landing is its own status, not OK', () => {
        const v = makeVisitor();
        v.replay.stats.downloadLanding = true;
        expect(csvRows(generateCSV([v.replay.getSummary()])).row.trim().endsWith('Download')).toBe(true);
    });

    test('an error still outranks everything else', () => {
        const v = makeVisitor();
        v.replay.stats.downloadLanding = true;
        v.replay.logError('first_page', 'boom');
        expect(csvRows(generateCSV([v.replay.getSummary()])).row.trim().endsWith('Error')).toBe(true);
    });

    test('a healthy visit is still OK', () => {
        const v = makeVisitor();
        expect(csvRows(generateCSV([v.replay.getSummary()])).row.trim().endsWith('OK')).toBe(true);
    });
});

describe('CSV shape', () => {
    test('every row has exactly as many cells as there are headers', () => {
        const v = makeVisitor({ extensionEnabled: true, ipRotation: true, proxyEnabled: true, proxyUrl: 'h:1' });
        v.replay.updateSessionInfo({ extensionLoaded: true, spoofedIP: '1.2.3.4' });
        v.replay.logExtension(true, { profileId: 'p0' });
        v._emitGA4Event(COLLECT, true);

        const csv = generateCSV([v.replay.getSummary()]);
        const lines = csv.split('\n');
        const headerCount = lines[0].split(',').length;
        for (const line of lines.slice(1)) {
            // naive split is fine here: no test value contains a comma
            expect(line.split(',').length).toBe(headerCount);
        }
    });
});
