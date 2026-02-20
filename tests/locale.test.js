/**
 * Language Locale - Test Suite
 * Tests that browser language arrays are correctly generated per location
 *
 * GA4 uses navigator.languages to determine user language.
 * This must match the location setting for realistic traffic.
 */

const Constants = require('../src/helpers/constants');

// ============================================================
// getLanguagesForLocation() Tests
// ============================================================
describe('getLanguagesForLocation()', () => {

    describe('India locations should produce [en-IN, en, hi]', () => {
        const indianLocations = [
            'India',
            'Gujarat',
            'Delhi',
            'Mumbai',
            'Bangalore',
            'Chennai',
            'Kolkata',
            'Hyderabad',
        ];

        indianLocations.forEach(location => {
            test(`${location} → ['en-IN', 'en', 'hi']`, () => {
                const languages = Constants.getLanguagesForLocation(location);
                expect(languages).toEqual(['en-IN', 'en', 'hi']);
            });
        });
    });

    describe('USA location should produce [en-US, en]', () => {
        test("USA → ['en-US', 'en']", () => {
            const languages = Constants.getLanguagesForLocation('USA');
            expect(languages).toEqual(['en-US', 'en']);
        });
    });

    describe('UK location should produce [en-GB, en]', () => {
        test("UK → ['en-GB', 'en']", () => {
            const languages = Constants.getLanguagesForLocation('UK');
            expect(languages).toEqual(['en-GB', 'en']);
        });
    });

    describe('edge cases', () => {
        test('Random location should produce a valid language array', () => {
            const languages = Constants.getLanguagesForLocation('Random');
            expect(languages.length).toBeGreaterThanOrEqual(2);
            // First element should be a locale like 'en-XX'
            expect(languages[0]).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
            // Second element should be the base language
            expect(languages[1]).toMatch(/^[a-z]{2}$/);
        });

        test('unknown location should default to India (en-IN)', () => {
            const languages = Constants.getLanguagesForLocation('Mars');
            expect(languages).toEqual(['en-IN', 'en', 'hi']);
        });
    });
});

// ============================================================
// LOCATION_COORDS locale data validation
// ============================================================
describe('LOCATION_COORDS locale data', () => {

    test('all Indian locations should have en-IN locale', () => {
        const indianKeys = ['India', 'Gujarat', 'Delhi', 'Mumbai', 'Bangalore', 'Chennai', 'Kolkata', 'Hyderabad'];
        indianKeys.forEach(key => {
            expect(Constants.LOCATION_COORDS[key].locale).toBe('en-IN');
        });
    });

    test('USA should have en-US locale', () => {
        expect(Constants.LOCATION_COORDS['USA'].locale).toBe('en-US');
    });

    test('UK should have en-GB locale', () => {
        expect(Constants.LOCATION_COORDS['UK'].locale).toBe('en-GB');
    });

    test('all non-Random locations should have timezone', () => {
        Object.entries(Constants.LOCATION_COORDS).forEach(([key, data]) => {
            if (key !== 'Random') {
                expect(data.timezone).toBeDefined();
                expect(typeof data.timezone).toBe('string');
            }
        });
    });

    test('all Indian locations should use Asia/Kolkata timezone', () => {
        const indianKeys = ['India', 'Gujarat', 'Delhi', 'Mumbai', 'Bangalore', 'Chennai', 'Kolkata', 'Hyderabad'];
        indianKeys.forEach(key => {
            expect(Constants.LOCATION_COORDS[key].timezone).toBe('Asia/Kolkata');
        });
    });

    test('USA should use America/New_York timezone', () => {
        expect(Constants.LOCATION_COORDS['USA'].timezone).toBe('America/New_York');
    });

    test('UK should use Europe/London timezone', () => {
        expect(Constants.LOCATION_COORDS['UK'].timezone).toBe('Europe/London');
    });
});
