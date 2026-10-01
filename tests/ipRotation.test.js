/**
 * IP rotation dispatcher
 *
 * The location dropdown has always offered USA and UK, but both visitors called
 * generateIndianIP(), which returns null outside India — so IP rotation was a
 * silent no-op for those locations while a fully tested internationalIP module
 * sat unused. These tests pin the routing so that cannot regress.
 */

const {
    generateIPForLocation,
    getSupportedLocations,
    isIndianLocation,
    isInternationalLocation,
} = require('../src/helpers/ipRotation');

const Constants = require('../src/helpers/constants');

describe('location classification', () => {
    test('Indian cities route to the Indian generator', () => {
        for (const loc of ['India', 'Delhi', 'Mumbai', 'Bangalore', 'Chennai', 'Kolkata', 'Hyderabad', 'Gujarat']) {
            expect(isIndianLocation(loc)).toBe(true);
            expect(isInternationalLocation(loc)).toBe(false);
        }
    });

    test('USA and UK route to the international generator', () => {
        for (const loc of ['USA', 'UK']) {
            expect(isInternationalLocation(loc)).toBe(true);
            expect(isIndianLocation(loc)).toBe(false);
        }
    });

    test('an unknown location belongs to neither', () => {
        expect(isIndianLocation('Atlantis')).toBe(false);
        expect(isInternationalLocation('Atlantis')).toBe(false);
    });
});

describe('generateIPForLocation', () => {
    const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

    function expectValidIp(result) {
        expect(result).not.toBeNull();
        expect(result.ip).toMatch(IPV4);
        for (const octet of result.ip.split('.')) {
            const n = parseInt(octet, 10);
            expect(n).toBeGreaterThanOrEqual(0);
            expect(n).toBeLessThanOrEqual(255);
        }
        expect(typeof result.isp).toBe('string');
        expect(result.isp.length).toBeGreaterThan(0);
    }

    test('Indian locations produce an Indian IP', () => {
        for (const loc of ['India', 'Mumbai', 'Delhi']) {
            const r = generateIPForLocation(loc);
            expectValidIp(r);
            expect(r.country).toBe('India');
        }
    });

    // This is the regression: it used to return null and skip the header.
    test('USA produces a USA IP instead of nothing', () => {
        const r = generateIPForLocation('USA');
        expectValidIp(r);
        expect(r.country).toBe('USA');
    });

    test('UK produces a UK IP instead of nothing', () => {
        const r = generateIPForLocation('UK');
        expectValidIp(r);
        expect(r.country).toBe('UK');
    });

    test('Random resolves to some supported location', () => {
        const supported = getSupportedLocations();
        for (let i = 0; i < 25; i++) {
            const r = generateIPForLocation('Random');
            expectValidIp(r);
            expect(typeof r.location).toBe('string');
        }
        expect(supported.length).toBeGreaterThan(5);
    });

    test('an empty location falls back to India rather than failing', () => {
        const r = generateIPForLocation('');
        expectValidIp(r);
        expect(r.country).toBe('India');
    });

    test('an unsupported location returns null so the caller skips the header', () => {
        expect(generateIPForLocation('Atlantis')).toBeNull();
    });

    test('successive calls vary — rotation has to actually rotate', () => {
        const seen = new Set();
        for (let i = 0; i < 40; i++) seen.add(generateIPForLocation('India').ip);
        expect(seen.size).toBeGreaterThan(1);
    });
});

describe('coverage of the UI location list', () => {
    // Every location the dropdown offers must either produce an IP or be a
    // deliberate no-op; a silent no-op is what this fix was about.
    const uiLocations = Object.values(Constants.LOCATIONS);

    test.each(uiLocations)('%s is classified, not silently dropped', (loc) => {
        const supported = isIndianLocation(loc) || isInternationalLocation(loc) || loc === 'Random';
        const result = generateIPForLocation(loc);
        if (supported) {
            expect(result).not.toBeNull();
        } else {
            expect(result).toBeNull();
        }
    });
});
