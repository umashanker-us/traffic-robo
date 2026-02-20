/**
 * User Agents - Comprehensive Test Suite
 * Tests user agent generation, UA↔Screen alignment, and device type configs
 */

const {
    getUserAgentList,
    getMatchingScreenSize,
    getMixedScreenSizes,
    getDesktopScreens,
    getMobileScreens,
    generateChromeUA,
    generateFirefoxUA,
    generateSafariUA,
    generateEdgeUA,
    generateAndroidUA,
    generateiPhoneUA,
    generateWindowsUA,
} = require('../src/helpers/userAgents');

const Constants = require('../src/helpers/constants');

// ============================================================
// Individual Browser UA Generators
// ============================================================
describe('Browser UA Generators', () => {

    test('Chrome desktop UA should have correct format', () => {
        const ua = generateChromeUA('desktop');
        expect(ua).toContain('Mozilla/5.0');
        expect(ua).toContain('Chrome/');
        expect(ua).toContain('AppleWebKit/537.36');
        expect(ua).toContain('Safari/537.36');
        expect(ua).not.toContain('Mobile');
    });

    test('Chrome mobile UA should contain Mobile and Android', () => {
        const ua = generateChromeUA('mobile');
        expect(ua).toContain('Mobile');
        expect(ua).toContain('Android');
        expect(ua).toContain('Chrome/');
    });

    test('Chrome version should be >= 140', () => {
        const ua = generateChromeUA('desktop');
        const match = ua.match(/Chrome\/(\d+)\./);
        expect(match).not.toBeNull();
        expect(parseInt(match[1])).toBeGreaterThanOrEqual(140);
    });

    test('Firefox UA should have correct format', () => {
        const ua = generateFirefoxUA('desktop');
        expect(ua).toContain('Firefox/');
        expect(ua).toContain('Gecko/20100101');
        expect(ua).toMatch(/rv:\d+\.0/);
    });

    test('Firefox version should be >= 133', () => {
        const ua = generateFirefoxUA('desktop');
        const match = ua.match(/Firefox\/(\d+)\./);
        expect(match).not.toBeNull();
        expect(parseInt(match[1])).toBeGreaterThanOrEqual(133);
    });

    test('Safari desktop UA should have correct format', () => {
        const ua = generateSafariUA('desktop');
        expect(ua).toContain('Macintosh');
        expect(ua).toContain('Version/');
        expect(ua).toContain('Safari/605.1.15');
    });

    test('Safari mobile UA should be iPhone', () => {
        const ua = generateSafariUA('mobile');
        expect(ua).toContain('iPhone');
        expect(ua).toContain('Mobile');
    });

    test('Edge UA should contain Edg/', () => {
        const ua = generateEdgeUA();
        expect(ua).toContain('Edg/');
        expect(ua).toContain('Chrome/');
        expect(ua).toContain('Windows');
    });

    test('Android UA should contain device model', () => {
        const ua = generateAndroidUA();
        expect(ua).toContain('Android');
        expect(ua).toContain('Mobile');
    });

    test('iPhone UA should contain iPhone', () => {
        const ua = generateiPhoneUA();
        expect(ua).toContain('iPhone');
        expect(ua).toContain('CPU iPhone OS');
    });

    test('Windows UA should contain Windows NT', () => {
        const ua = generateWindowsUA();
        expect(ua).toContain('Windows NT 10.0');
        expect(ua).toContain('Chrome/');
    });
});

// ============================================================
// getUserAgentList Tests
// ============================================================
describe('getUserAgentList()', () => {

    test('should return requested number of UAs', () => {
        const uas = getUserAgentList('Default', 50);
        expect(uas).toHaveLength(50);
    });

    test('should return 100 UAs by default', () => {
        const uas = getUserAgentList('Default');
        expect(uas).toHaveLength(100);
    });

    test('all UAs should be non-empty strings with Mozilla/5.0', () => {
        const uas = getUserAgentList('Default', 100);
        uas.forEach(ua => {
            expect(typeof ua).toBe('string');
            expect(ua.length).toBeGreaterThan(50);
            expect(ua).toContain('Mozilla/5.0');
        });
    });

    test('Default/DeskMobile should have mix of desktop and mobile', () => {
        const uas = getUserAgentList('Default', 200);
        const mobile = uas.filter(ua => ua.includes('Mobile') || ua.includes('iPhone'));
        const desktop = uas.filter(ua => !ua.includes('Mobile') && !ua.includes('iPhone'));

        expect(mobile.length).toBeGreaterThan(40);
        expect(desktop.length).toBeGreaterThan(80);
    });

    test('Desktop type should only return desktop UAs', () => {
        const uas = getUserAgentList('Desktop', 100);
        uas.forEach(ua => {
            expect(ua).not.toContain('Android');
            expect(ua).not.toContain('iPhone');
            const isDesktop = ua.includes('Windows') || ua.includes('Macintosh');
            expect(isDesktop).toBe(true);
        });
    });

    test('Mobile type should only return mobile UAs', () => {
        const uas = getUserAgentList('Mobile', 100);
        uas.forEach(ua => {
            const isMobile = ua.includes('Mobile') || ua.includes('iPhone') || ua.includes('Android');
            expect(isMobile).toBe(true);
        });
    });

    test('Chrome type should only return Chrome UAs', () => {
        const uas = getUserAgentList('Chrome', 50);
        uas.forEach(ua => {
            expect(ua).toContain('Chrome/');
            expect(ua).not.toContain('Firefox');
            expect(ua).not.toContain('Edg/');
        });
    });

    test('Firefox type should only return Firefox UAs', () => {
        const uas = getUserAgentList('Firefox', 50);
        uas.forEach(ua => {
            expect(ua).toContain('Firefox/');
        });
    });

    test('Android type should only return Android UAs', () => {
        const uas = getUserAgentList('Android', 50);
        uas.forEach(ua => {
            expect(ua).toContain('Android');
        });
    });

    test('iPhone type should only return iPhone UAs', () => {
        const uas = getUserAgentList('iPhone', 50);
        uas.forEach(ua => {
            expect(ua).toContain('iPhone');
        });
    });

    test('Windows type should only return Windows UAs', () => {
        const uas = getUserAgentList('Windows', 50);
        uas.forEach(ua => {
            expect(ua).toContain('Windows');
        });
    });

    test('should generate unique UAs (not all identical)', () => {
        const uas = getUserAgentList('Default', 50);
        const unique = new Set(uas);
        expect(unique.size).toBeGreaterThan(20);
    });
});

// ============================================================
// getMatchingScreenSize() — UA ↔ Screen Alignment
// ============================================================
describe('getMatchingScreenSize()', () => {

    describe('mobile UA gets mobile screen (width < 500)', () => {
        test('Android UA → mobile screen', () => {
            const ua = generateAndroidUA();
            const screen = getMatchingScreenSize(ua);
            expect(screen.width).toBeLessThanOrEqual(500);
            expect(screen.height).toBeGreaterThanOrEqual(500);
        });

        test('iPhone UA → mobile screen', () => {
            const ua = generateiPhoneUA();
            const screen = getMatchingScreenSize(ua);
            expect(screen.width).toBeLessThanOrEqual(500);
            expect(screen.height).toBeGreaterThanOrEqual(500);
        });

        test('Chrome mobile UA → mobile screen', () => {
            const ua = generateChromeUA('mobile');
            const screen = getMatchingScreenSize(ua);
            expect(screen.width).toBeLessThanOrEqual(500);
        });

        test('Firefox mobile UA → mobile screen', () => {
            const ua = generateFirefoxUA('mobile');
            const screen = getMatchingScreenSize(ua);
            expect(screen.width).toBeLessThanOrEqual(500);
        });

        test('Safari mobile UA → mobile screen', () => {
            const ua = generateSafariUA('mobile');
            const screen = getMatchingScreenSize(ua);
            expect(screen.width).toBeLessThanOrEqual(500);
        });
    });

    describe('desktop UA gets desktop screen (width >= 1024)', () => {
        test('Chrome desktop UA → desktop screen', () => {
            const ua = generateChromeUA('desktop');
            const screen = getMatchingScreenSize(ua);
            expect(screen.width).toBeGreaterThanOrEqual(1024);
            expect(screen.height).toBeGreaterThanOrEqual(720);
        });

        test('Firefox desktop UA → desktop screen', () => {
            const ua = generateFirefoxUA('desktop');
            const screen = getMatchingScreenSize(ua);
            expect(screen.width).toBeGreaterThanOrEqual(1024);
        });

        test('Safari desktop UA → desktop screen', () => {
            const ua = generateSafariUA('desktop');
            const screen = getMatchingScreenSize(ua);
            expect(screen.width).toBeGreaterThanOrEqual(1024);
        });

        test('Edge desktop UA → desktop screen', () => {
            const ua = generateEdgeUA();
            const screen = getMatchingScreenSize(ua);
            expect(screen.width).toBeGreaterThanOrEqual(1024);
        });

        test('Windows UA → desktop screen', () => {
            const ua = generateWindowsUA();
            const screen = getMatchingScreenSize(ua);
            expect(screen.width).toBeGreaterThanOrEqual(1024);
        });
    });

    describe('tablet UA gets tablet screen', () => {
        test('iPad UA without Mobile → tablet screen (width 768-1024)', () => {
            // Note: Real iPad UAs often contain "Mobile", which triggers the mobile check first.
            // A pure iPad UA (without "Mobile") correctly gets tablet screen.
            const ua = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1';
            const screen = getMatchingScreenSize(ua);
            expect(screen.width).toBeGreaterThanOrEqual(768);
            expect(screen.width).toBeLessThanOrEqual(1024);
        });

        test('Tablet-only UA → tablet screen', () => {
            // UA that contains "Tablet" but not "Mobile" or "Android"
            const ua = 'Mozilla/5.0 (Linux; Tablet; rv:109.0) Gecko/109.0 Firefox/109.0';
            const screen = getMatchingScreenSize(ua);
            expect(screen.width).toBeGreaterThanOrEqual(768);
            expect(screen.width).toBeLessThanOrEqual(1024);
        });
    });

    describe('alignment consistency over many iterations', () => {
        test('100 mobile UAs should all get mobile screens', () => {
            for (let i = 0; i < 100; i++) {
                const ua = generateAndroidUA();
                const screen = getMatchingScreenSize(ua);
                expect(screen.width).toBeLessThanOrEqual(500);
            }
        });

        test('100 desktop UAs should all get desktop screens', () => {
            for (let i = 0; i < 100; i++) {
                const ua = generateChromeUA('desktop');
                const screen = getMatchingScreenSize(ua);
                expect(screen.width).toBeGreaterThanOrEqual(1024);
            }
        });
    });
});

// ============================================================
// getMixedScreenSizes() Tests
// ============================================================
describe('getMixedScreenSizes()', () => {

    test('should return requested count', () => {
        expect(getMixedScreenSizes(50)).toHaveLength(50);
        expect(getMixedScreenSizes(200)).toHaveLength(200);
    });

    test('should return 100 by default', () => {
        expect(getMixedScreenSizes()).toHaveLength(100);
    });

    test('should have variety of sizes', () => {
        const screens = getMixedScreenSizes(100);
        const widths = new Set(screens.map(s => s.width));
        expect(widths.size).toBeGreaterThan(5);
    });

    test('all screens should have valid dimensions', () => {
        const screens = getMixedScreenSizes(100);
        screens.forEach(screen => {
            expect(screen.width).toBeGreaterThan(0);
            expect(screen.height).toBeGreaterThan(0);
        });
    });

    test('should contain both desktop and mobile sizes', () => {
        const screens = getMixedScreenSizes(200);
        const desktop = screens.filter(s => s.width >= 1024);
        const mobile = screens.filter(s => s.width <= 500);
        expect(desktop.length).toBeGreaterThan(0);
        expect(mobile.length).toBeGreaterThan(0);
    });
});

// ============================================================
// getDesktopScreens() and getMobileScreens()
// ============================================================
describe('getDesktopScreens()', () => {
    test('all should be desktop resolution (>= 1024 width)', () => {
        const screens = getDesktopScreens(50);
        expect(screens).toHaveLength(50);
        screens.forEach(s => {
            expect(s.width).toBeGreaterThanOrEqual(1024);
        });
    });
});

describe('getMobileScreens()', () => {
    test('all should be mobile resolution (<= 500 width)', () => {
        const screens = getMobileScreens(50);
        expect(screens).toHaveLength(50);
        screens.forEach(s => {
            expect(s.width).toBeLessThanOrEqual(500);
        });
    });
});

// ============================================================
// Constants Screen Data Validation
// ============================================================
describe('Screen Resolution Data', () => {
    test('desktop screens should have valid resolutions', () => {
        Constants.DESKTOP_SCREENS.forEach(s => {
            expect(s.width).toBeGreaterThanOrEqual(1280);
            expect(s.height).toBeGreaterThanOrEqual(720);
        });
    });

    test('mobile screens should have valid resolutions', () => {
        Constants.MOBILE_SCREENS.forEach(s => {
            expect(s.width).toBeLessThanOrEqual(500);
            expect(s.height).toBeGreaterThanOrEqual(500);
        });
    });

    test('should have at least 8 desktop resolutions', () => {
        expect(Constants.DESKTOP_SCREENS.length).toBeGreaterThanOrEqual(8);
    });

    test('should have at least 10 mobile resolutions', () => {
        expect(Constants.MOBILE_SCREENS.length).toBeGreaterThanOrEqual(10);
    });

    test('tablet screens should be in between', () => {
        Constants.TABLET_SCREENS.forEach(s => {
            expect(s.width).toBeGreaterThanOrEqual(768);
            expect(s.width).toBeLessThanOrEqual(1024);
        });
    });
});
