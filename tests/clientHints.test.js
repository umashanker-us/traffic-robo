/**
 * Client Hints - Test Suite
 *
 * Guards the GA4 device/browser reporting fix: GA4 reads UA client hints, not
 * the UA string, so the hints we derive must agree with the UA we generate.
 */

const {
    isChromiumUA,
    buildUserAgentMetadata,
    buildClientHintHeaders,
} = require('../src/helpers/clientHints');

const { getUserAgentList } = require('../src/helpers/userAgents');
const Constants = require('../src/helpers/constants');

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.7499.42 Mobile Safari/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7392.11 Safari/537.36';
const EDGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.7499.9 Safari/537.36 Edg/143.0.7499.20';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7167.3 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.2 Mobile/15E148 Safari/604.1';
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0';

describe('isChromiumUA', () => {
    test('recognises Chrome and Edge', () => {
        expect(isChromiumUA(ANDROID_UA)).toBe(true);
        expect(isChromiumUA(WINDOWS_UA)).toBe(true);
        expect(isChromiumUA(EDGE_UA)).toBe(true);
    });

    test('rejects Firefox and Safari', () => {
        expect(isChromiumUA(FIREFOX_UA)).toBe(false);
        expect(isChromiumUA(IPHONE_UA)).toBe(false);
    });
});

describe('buildUserAgentMetadata - mobile flag', () => {
    // This is the field GA4 uses for device category (uamb)
    test('mobile UA produces mobile: true', () => {
        expect(buildUserAgentMetadata(ANDROID_UA).metadata.mobile).toBe(true);
        expect(buildUserAgentMetadata(IPHONE_UA).metadata.mobile).toBe(true);
    });

    test('desktop UA produces mobile: false', () => {
        expect(buildUserAgentMetadata(WINDOWS_UA).metadata.mobile).toBe(false);
        expect(buildUserAgentMetadata(MAC_UA).metadata.mobile).toBe(false);
        expect(buildUserAgentMetadata(FIREFOX_UA).metadata.mobile).toBe(false);
    });
});

describe('buildUserAgentMetadata - platform', () => {
    test('Android UA yields platform, version and device model', () => {
        const m = buildUserAgentMetadata(ANDROID_UA).metadata;
        expect(m.platform).toBe('Android');
        expect(m.platformVersion).toBe('15.0.0');
        expect(m.model).toBe('SM-S928B');
        // Chrome on Android reports no architecture/bitness
        expect(m.architecture).toBe('');
        expect(m.bitness).toBe('');
    });

    test('Windows UA yields Windows platform with desktop architecture', () => {
        const m = buildUserAgentMetadata(WINDOWS_UA).metadata;
        expect(m.platform).toBe('Windows');
        expect(m.architecture).toBe('x86');
        expect(m.bitness).toBe('64');
        expect(m.model).toBe('');
    });

    test('Mac UA yields macOS platform with dotted version', () => {
        const m = buildUserAgentMetadata(MAC_UA).metadata;
        expect(m.platform).toBe('macOS');
        expect(m.platformVersion).toBe('10.15.7');
    });
});

describe('buildUserAgentMetadata - brands', () => {
    test('Chrome UA advertises Google Chrome at the UA version', () => {
        const m = buildUserAgentMetadata(WINDOWS_UA).metadata;
        const chrome = m.brands.find(b => b.brand === 'Google Chrome');
        expect(chrome).toBeDefined();
        expect(chrome.version).toBe('142');
        expect(m.brands.find(b => b.brand === 'Chromium').version).toBe('142');
        expect(m.fullVersion).toBe('142.0.7392.11');
    });

    test('Edge UA advertises Microsoft Edge, not Google Chrome', () => {
        const m = buildUserAgentMetadata(EDGE_UA).metadata;
        expect(m.brands.find(b => b.brand === 'Microsoft Edge').version).toBe('143');
        expect(m.brands.find(b => b.brand === 'Google Chrome')).toBeUndefined();
    });

    test('brands include a GREASE entry alongside Chromium and the product', () => {
        const m = buildUserAgentMetadata(ANDROID_UA).metadata;
        expect(m.brands).toHaveLength(3);
        expect(m.fullVersionList).toHaveLength(3);
        const greased = m.brands.filter(b => /Not/.test(b.brand));
        expect(greased).toHaveLength(1);
    });

    test('non-Chromium UA suppresses brands entirely', () => {
        for (const ua of [FIREFOX_UA, IPHONE_UA]) {
            const { metadata, isChromium } = buildUserAgentMetadata(ua);
            expect(isChromium).toBe(false);
            expect(metadata.brands).toEqual([]);
            expect(metadata.fullVersionList).toEqual([]);
            expect(metadata.platform).toBe('');
        }
    });
});

describe('buildClientHintHeaders', () => {
    test('serialises brands in sec-ch-ua format', () => {
        const { metadata } = buildUserAgentMetadata(WINDOWS_UA);
        const h = buildClientHintHeaders(metadata);
        expect(h['sec-ch-ua']).toContain('"Google Chrome";v="142"');
        expect(h['sec-ch-ua']).toContain('"Chromium";v="142"');
        expect(h['sec-ch-ua-mobile']).toBe('?0');
        expect(h['sec-ch-ua-platform']).toBe('"Windows"');
    });

    test('mobile UA sets sec-ch-ua-mobile to ?1', () => {
        const { metadata } = buildUserAgentMetadata(ANDROID_UA);
        expect(buildClientHintHeaders(metadata)['sec-ch-ua-mobile']).toBe('?1');
        expect(buildClientHintHeaders(metadata)['sec-ch-ua-platform']).toBe('"Android"');
    });

    test('non-Chromium UA sends blank brand and platform hints', () => {
        const { metadata } = buildUserAgentMetadata(FIREFOX_UA);
        const h = buildClientHintHeaders(metadata);
        expect(h['sec-ch-ua']).toBe('');
        expect(h['sec-ch-ua-platform']).toBe('""');
    });
});

describe('Agreement with every generated user agent', () => {
    const deviceTypes = Object.values(Constants.DEVICE_TYPES);

    test.each(deviceTypes)('%s: hints agree with the UA string', (deviceType) => {
        for (const ua of getUserAgentList(deviceType, 50)) {
            const { metadata, isChromium } = buildUserAgentMetadata(ua);
            const uaSaysMobile = /Mobile|Android|iPhone/.test(ua);

            // The whole point of the fix: no UA may claim mobile while the
            // hints say desktop (that is what GA4 reported as Desktop).
            expect(metadata.mobile).toBe(uaSaysMobile);

            if (isChromium) {
                expect(metadata.platform).not.toBe('');
                expect(metadata.brands).toHaveLength(3);
                const uaMajor = ua.match(/Chrome\/(\d+)/)[1];
                expect(metadata.brands.find(b => b.brand === 'Chromium').version).toBe(uaMajor);
            } else {
                expect(metadata.brands).toEqual([]);
            }
        }
    });
});
