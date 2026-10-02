/**
 * Browser and device diversity that GA4 can actually resolve
 *
 * Playwright drives Chromium, which always sends sec-ch-ua and will not let it
 * be suppressed — route.continue() cannot strip the header (Chromium re-adds it
 * after interception) and --disable-features=UserAgentClientHint has no effect.
 * Both were measured.
 *
 * So a Firefox or Safari user agent has to ship an empty brand list, and GA4
 * cannot resolve an empty brand list to a browser: the browser dimension
 * collapses to "Mozilla". Chrome, Edge, Opera and Samsung Internet each send
 * their own real brand, which is how the reported mix stays varied AND correct.
 *
 * These tests guard that: the automatic mixes must produce only user agents
 * whose hints name a real browser, and must still vary across devices.
 */

const {
    getUserAgentList,
    getUserAgentProfiles,
    getMatchingScreenSize,
    generateChromeUA,
    generateEdgeUA,
    generateAndroidUA,
    generateOperaUA,
    generateSamsungInternetUA,
    generateAndroidTabletUA,
    generateAndroidTabletProfile,
    generateChromeProfile,
    isInconsistentDeviceType,
    setRuntimeChromeVersion,
    getRuntimeChromeVersion,
} = require('../src/helpers/userAgents');

const {
    buildUserAgentMetadata,
    buildClientHintHeaders,
    isMobileUserAgent,
} = require('../src/helpers/clientHints');

const Constants = require('../src/helpers/constants');

const REAL_BRANDS = ['Google Chrome', 'Microsoft Edge', 'Opera', 'Samsung Internet'];

function productBrand(ua) {
    const { metadata } = buildUserAgentMetadata(ua);
    return metadata.brands.map(b => b.brand).find(b => !/^Not|^Chromium/.test(b));
}

function deviceCategory(ua) {
    const { metadata } = buildUserAgentMetadata(ua);
    if (metadata.mobile) return 'mobile';
    return metadata.platform === 'Android' ? 'tablet' : 'desktop';
}

describe('each Chromium browser advertises itself', () => {
    test('Opera desktop advertises Opera, matching its OPR/ token', () => {
        const ua = generateOperaUA('desktop');
        expect(ua).toMatch(/OPR\/\d+\./);
        expect(productBrand(ua)).toBe('Opera');

        const { metadata } = buildUserAgentMetadata(ua);
        const opr = ua.match(/OPR\/(\d+)\./)[1];
        expect(metadata.brands.find(b => b.brand === 'Opera').version).toBe(opr);
        expect(metadata.mobile).toBe(false);
    });

    test('Opera mobile advertises Opera and stays mobile', () => {
        const ua = generateOperaUA('mobile');
        expect(ua).toContain('Mobile Safari');
        expect(productBrand(ua)).toBe('Opera');
        expect(buildUserAgentMetadata(ua).metadata.mobile).toBe(true);
    });

    test('Samsung Internet advertises Samsung Internet', () => {
        const ua = generateSamsungInternetUA();
        expect(ua).toMatch(/SamsungBrowser\/\d+\.\d+/);
        expect(productBrand(ua)).toBe('Samsung Internet');

        const { metadata } = buildUserAgentMetadata(ua);
        const sb = ua.match(/SamsungBrowser\/(\d+)\./)[1];
        expect(metadata.brands.find(b => b.brand === 'Samsung Internet').version).toBe(sb);
        expect(metadata.mobile).toBe(true);
        expect(metadata.platform).toBe('Android');
    });

    test('plain Chrome still advertises Google Chrome', () => {
        expect(productBrand(generateChromeUA('desktop'))).toBe('Google Chrome');
        expect(productBrand(generateAndroidUA())).toBe('Google Chrome');
    });

    test('Edge still advertises Microsoft Edge, not Chrome', () => {
        expect(productBrand(generateEdgeUA())).toBe('Microsoft Edge');
    });
});

describe('Android tablets report as tablets', () => {
    test('a tablet UA carries Android but no Mobile token', () => {
        const ua = generateAndroidTabletUA();
        expect(ua).toContain('Android');
        expect(ua).not.toContain('Mobile');
    });

    // mobile:false + platform Android is the pairing GA4 reads as "tablet".
    test('a tablet reports mobile: false on Android', () => {
        const { metadata } = buildUserAgentMetadata(generateAndroidTabletUA());
        expect(metadata.mobile).toBe(false);
        expect(metadata.platform).toBe('Android');
    });

    // Chrome's UA reduction took the model out of the UA entirely, so it has to
    // come from the profile — the UA alone cannot supply it any more.
    test('the model comes from the profile, not the UA', () => {
        const profile = generateAndroidTabletProfile();
        expect(profile.model).not.toBe('');
        expect(profile.ua).not.toContain(profile.model);

        const { metadata } = buildUserAgentMetadata(profile.ua, profile);
        expect(metadata.model).toBe(profile.model);
        expect(metadata.mobile).toBe(false);
        expect(metadata.platformVersion).toBe(profile.platformVersion);
    });

    // "K" is Chrome's frozen placeholder in a reduced Android UA, never a device.
    test('the UA placeholder is never reported as a model', () => {
        const { metadata } = buildUserAgentMetadata(generateAndroidTabletUA());
        expect(metadata.model).toBe('');
    });

    test('a tablet sends sec-ch-ua-mobile: ?0', () => {
        const { metadata } = buildUserAgentMetadata(generateAndroidTabletUA());
        expect(buildClientHintHeaders(metadata)['sec-ch-ua-mobile']).toBe('?0');
    });

    test('isMobileUserAgent separates phone, tablet and desktop', () => {
        expect(isMobileUserAgent(generateAndroidUA())).toBe(true);
        expect(isMobileUserAgent(generateAndroidTabletUA())).toBe(false);
        expect(isMobileUserAgent(generateChromeUA('desktop'))).toBe(false);
    });

    test('a tablet gets a tablet-sized screen, not a phone one', () => {
        for (let i = 0; i < 30; i++) {
            const screen = getMatchingScreenSize(generateAndroidTabletUA());
            const isTabletScreen = Constants.TABLET_SCREENS
                .some(s => s.width === screen.width && s.height === screen.height);
            expect(isTabletScreen).toBe(true);
        }
    });
});

describe('the automatic mixes never produce an unresolvable browser', () => {
    test.each(['Default', 'Desktop & Mobile', 'Desktop', 'Mobile', 'Tablet'])(
        '%s yields only UAs whose brands name a real browser', (type) => {
            for (const ua of getUserAgentList(type, 200)) {
                const { metadata, isChromium } = buildUserAgentMetadata(ua);
                expect(isChromium).toBe(true);
                expect(metadata.brands).toHaveLength(3);
                expect(REAL_BRANDS).toContain(productBrand(ua));
            }
        });

    test('the mix varies across browsers and all three device categories', () => {
        const brands = new Set();
        const devices = new Set();
        for (const ua of getUserAgentList('Desktop & Mobile', 1500)) {
            brands.add(productBrand(ua));
            devices.add(deviceCategory(ua));
        }
        expect(brands.size).toBeGreaterThanOrEqual(4);
        expect(devices).toEqual(new Set(['desktop', 'mobile', 'tablet']));
    });

    test('Desktop stays desktop and Mobile stays mobile', () => {
        for (const ua of getUserAgentList('Desktop', 150)) {
            expect(deviceCategory(ua)).toBe('desktop');
        }
        for (const ua of getUserAgentList('Mobile', 150)) {
            expect(deviceCategory(ua)).toBe('mobile');
        }
    });

    test('Firefox and iPhone stay available but are flagged as inconsistent', () => {
        expect(isInconsistentDeviceType(Constants.DEVICE_TYPES.FIREFOX)).toBe(true);
        expect(isInconsistentDeviceType(Constants.DEVICE_TYPES.IPHONE)).toBe(true);
        expect(isInconsistentDeviceType(Constants.DEVICE_TYPES.DESK_MOBILE)).toBe(false);
        expect(isInconsistentDeviceType(Constants.DEVICE_TYPES.MOBILE)).toBe(false);

        // Still generated when asked for explicitly — the option is not removed.
        expect(getUserAgentList('Firefox', 10).every(u => /Firefox\//.test(u))).toBe(true);
        expect(getUserAgentList('iPhone', 10).every(u => /iPhone/.test(u))).toBe(true);
    });
});

describe('user agents can be pinned to the real browser version', () => {
    afterEach(() => setRuntimeChromeVersion(null));

    // Chromium 145 claiming to be 143 is a small lie; real Chrome 154 claiming
    // 143 is a large one, and feature detection does not lie — a page can see
    // APIs that the claimed version never shipped.
    // The UA carries only the major — Chrome froze the rest at 0.0.0 — so the
    // real build has to reach the hints through the profile instead.
    test('a runtime version drives the major of every UA', () => {
        setRuntimeChromeVersion('154.0.8037.59');
        expect(getRuntimeChromeVersion()).toMatchObject({ major: '154', build: '8037' });

        for (const ua of getUserAgentList('Desktop', 50)) {
            expect(ua).toContain('Chrome/154.0.0.0');
        }
    });

    // Chrome and Edge track the engine's build; Opera and Samsung Internet carry
    // their own product versions, so the claim is made against Chrome itself.
    test('the real build still reaches the profile, for the hints', () => {
        setRuntimeChromeVersion('154.0.8037.59');
        for (let i = 0; i < 25; i++) {
            const profile = generateChromeProfile('desktop');
            expect(profile.fullVersion.startsWith('154.0.8037.')).toBe(true);
            // and it is deliberately absent from the UA
            expect(profile.ua).not.toContain('8037');
            expect(profile.ua).toContain('Chrome/154.0.0.0');
        }
    });

    test('the brands follow the pinned version too', () => {
        setRuntimeChromeVersion('154.0.8037.59');
        const { metadata } = buildUserAgentMetadata(generateChromeUA('desktop'));
        expect(metadata.brands.find(b => b.brand === 'Google Chrome').version).toBe('154');
        expect(metadata.brands.find(b => b.brand === 'Chromium').version).toBe('154');
    });

    test('clearing it falls back to the bundled version table', () => {
        setRuntimeChromeVersion('154.0.8037.59');
        setRuntimeChromeVersion(null);
        expect(getRuntimeChromeVersion()).toBeNull();
        const majors = new Set(getUserAgentList('Desktop', 100).map(u => u.match(/Chrome\/(\d+)\./)[1]));
        expect(majors.has('154')).toBe(false);
    });

    test('a malformed version is ignored rather than producing a broken UA', () => {
        setRuntimeChromeVersion('not-a-version');
        expect(getRuntimeChromeVersion()).toBeNull();
        expect(generateChromeUA('desktop')).toMatch(/Chrome\/\d+\.0\.\d+\.\d+ Safari/);
    });

    // Every current Chrome sends the same frozen version, so varying the UA's
    // patch would make the traffic stand out rather than blend in. The variety
    // belongs in the full version the hints report.
    test('the UA version is identical across visits, as Chrome makes it', () => {
        setRuntimeChromeVersion('154.0.8037.59');
        const versions = new Set(getUserAgentList('Desktop', 100)
            .map(u => u.match(/Chrome\/([\d.]+)/)[1]));
        expect(versions).toEqual(new Set(['154.0.0.0']));
    });

    test('the full versions behind the hints do vary', () => {
        setRuntimeChromeVersion('154.0.8037.59');
        const fulls = new Set(getUserAgentProfiles('Desktop', 100).map(p => p.fullVersion));
        expect(fulls.size).toBeGreaterThan(5);
    });
});
