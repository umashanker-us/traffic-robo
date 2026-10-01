/**
 * Shared browser lifecycle
 *
 * The two visitors used to carry 21 copy-pasted methods, and the copies drifted:
 * manual mode never resolved the bundled Chromium (a packaged build could not
 * launch it), stripped "www." with an unanchored replace, and had no live GA4 or
 * proxy monitor. Both now extend BrowserSession.
 *
 * These tests assert the lifecycle methods are literally the SAME function on
 * both classes. An override re-introducing a copy fails here, which is the only
 * way to stop the drift coming back.
 */

const AutomaticVisitor = require('../src/core/automaticVisitor');
const ManualVisitor = require('../src/core/manualVisitor');
const BrowserSession = require('../src/core/browserSession');

const SHARED_LIFECYCLE = [
    '_getChromiumPath',
    '_buildLaunchArgs',
    '_launchBrowser',
    '_buildContextOptions',
    '_createContext',
    '_setupMergedRouteHandler',
    '_handleDirectCollect',
    '_addStealthScripts',
    '_applyClientHints',
    '_watchForDownloadLanding',
    '_awaitDownloadSignal',
    '_emitProxyStats',
    '_emitGA4Event',
    '_parseGA4CollectUrl',
    '_extractCookiesBeforeClose',
    '_extractDomain',
    '_resolveLandedDomain',
    '_resetGACookies',
    '_verifyExtension',
    '_buildSessionInfo',
    '_saveReplay',
    '_sleep',
    '_randomDelay',
    '_cleanup',
    '_cleanupTempDir',
    'forceClose',
    'getCookies',
    '_visitPreviousUrl',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.7499.1 Safari/537.36';

function makeConfig(extra) {
    return Object.assign({
        campaignUrl: 'https://www.example.com/landing',
        url: 'https://www.example.com/landing',
        userAgent: UA,
        threadId: 1,
        visit: { pagePerSession: 1, avgSessionDuration: 10 },
        screenSize: { width: 1920, height: 1080 },
        playMode: 'Fast',
        location: 'India',
    }, extra || {});
}

describe('both visitors extend the shared session', () => {
    test('AutomaticVisitor is a BrowserSession', () => {
        expect(new AutomaticVisitor(makeConfig())).toBeInstanceOf(BrowserSession);
    });

    test('ManualVisitor is a BrowserSession', () => {
        expect(new ManualVisitor(makeConfig())).toBeInstanceOf(BrowserSession);
    });
});

describe('lifecycle methods exist once, not twice', () => {
    test.each(SHARED_LIFECYCLE)('%s is the same function on both classes', (name) => {
        const fromBase = BrowserSession.prototype[name];
        expect(typeof fromBase).toBe('function');
        expect(AutomaticVisitor.prototype[name]).toBe(fromBase);
        expect(ManualVisitor.prototype[name]).toBe(fromBase);
    });

    test.each(SHARED_LIFECYCLE)('%s is not redeclared on either subclass', (name) => {
        expect(Object.getOwnPropertyNames(AutomaticVisitor.prototype)).not.toContain(name);
        expect(Object.getOwnPropertyNames(ManualVisitor.prototype)).not.toContain(name);
    });
});

describe('deliberate overrides', () => {
    // The settle after the returning-user page is the one place the two modes
    // legitimately differ, so it must be an override and nothing else should be.
    test('_settleAfterPreviousUrl is overridden by automatic mode only', () => {
        expect(Object.getOwnPropertyNames(AutomaticVisitor.prototype)).toContain('_settleAfterPreviousUrl');
        expect(Object.getOwnPropertyNames(ManualVisitor.prototype)).not.toContain('_settleAfterPreviousUrl');
        expect(ManualVisitor.prototype._settleAfterPreviousUrl).toBe(BrowserSession.prototype._settleAfterPreviousUrl);
    });

    test('each subclass owns only its navigation strategy', () => {
        const autoOwn = Object.getOwnPropertyNames(AutomaticVisitor.prototype)
            .filter(n => n !== 'constructor');
        const manualOwn = Object.getOwnPropertyNames(ManualVisitor.prototype)
            .filter(n => n !== 'constructor');

        // Nothing from the shared list may appear in either.
        expect(autoOwn.filter(n => SHARED_LIFECYCLE.includes(n))).toEqual([]);
        expect(manualOwn.filter(n => SHARED_LIFECYCLE.includes(n))).toEqual([]);

        // And the two strategies must not share method names either — that
        // would be a new copy-paste pair forming.
        const overlap = autoOwn.filter(n => manualOwn.includes(n) && n !== 'execute');
        expect(overlap).toEqual([]);
    });
});

describe('the drift the copies had caused', () => {
    test('manual mode now resolves the bundled Chromium', () => {
        // Before the base existed, manualVisitor had no _getChromiumPath at all,
        // so a packaged build pointed Playwright at a browser that is not there.
        const v = new ManualVisitor(makeConfig());
        expect(typeof v._getChromiumPath).toBe('function');
    });

    test('www. is stripped only from the start of a hostname', () => {
        const v = new AutomaticVisitor(makeConfig());
        expect(v._extractDomain('https://www.example.com/x')).toBe('example.com');
        // An unanchored replace turned this into "my-example.com".
        expect(v._extractDomain('https://my-www.example.com/x')).toBe('my-www.example.com');
        expect(v._extractDomain('not a url')).toBe('');
    });

    test('manual mode gets the live GA4 and proxy monitors', () => {
        const v = new ManualVisitor(makeConfig());
        expect(typeof v._emitGA4Event).toBe('function');
        expect(typeof v._emitProxyStats).toBe('function');
    });

    test('both modes normalise their target URL to targetUrl', () => {
        const auto = new AutomaticVisitor(makeConfig());
        const manual = new ManualVisitor(makeConfig());
        expect(auto.targetUrl).toBe('https://www.example.com/landing');
        expect(manual.targetUrl).toBe('https://www.example.com/landing');
        expect(auto.campaignUrl).toBe(auto.targetUrl);
        expect(manual.url).toBe(manual.targetUrl);
        expect(auto.primaryDomain).toBe('example.com');
        expect(manual.primaryDomain).toBe('example.com');
    });
});

describe('_buildSessionInfo', () => {
    test('reports the fields the report reads, with the proxy mode spelled out', () => {
        const v = new AutomaticVisitor(makeConfig({
            proxyEnabled: true,
            proxyUrl: 'http://u:p@proxy.example.com:8080',
            proxyCollectEnabled: false,
            extensionEnabled: true,
            ipRotation: true,
        }));
        const info = v._buildSessionInfo({ mode: 'automatic' });

        expect(info.proxyMode).toBe('custom-only');
        expect(info.proxyUrl).toBe('http://u:p@proxy.example.com:8080'); // masked by the replay, not here
        expect(info.extensionEnabled).toBe(true);
        expect(info.extensionLoaded).toBe(false);
        expect(info.ipRotation).toBe(true);
        expect(info.mode).toBe('automatic');
    });

    test('proxy mode names collect proxying when it is on', () => {
        const v = new AutomaticVisitor(makeConfig({ proxyEnabled: true, proxyUrl: 'host:1' }));
        expect(v._buildSessionInfo().proxyMode).toBe('collect+custom');
    });

    test('proxy mode is none when the proxy is off', () => {
        const v = new AutomaticVisitor(makeConfig());
        expect(v._buildSessionInfo().proxyMode).toBe('none');
    });
});
