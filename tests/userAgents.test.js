/**
 * User Agents - Automated Test Suite
 * Tests user agent generation, screen sizes, and device type configurations
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

    test('Chrome mobile UA should contain Mobile', () => {
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
        // Should be either Chrome or Edge
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

    test('all UAs should be non-empty strings', () => {
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
        
        // Should have both, roughly 60% desktop, 35% mobile
        expect(mobile.length).toBeGreaterThan(40);
        expect(desktop.length).toBeGreaterThan(80);
    });

    test('Desktop type should only return desktop UAs', () => {
        const uas = getUserAgentList('Desktop', 100);
        uas.forEach(ua => {
            expect(ua).not.toContain('Android');
            expect(ua).not.toContain('iPhone');
            // Should contain desktop indicators
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
        // Most should be unique due to random version patches
        expect(unique.size).toBeGreaterThan(20);
    });
});

// ============================================================
// Screen Size Tests
// ============================================================
describe('getMatchingScreenSize()', () => {

    test('should return desktop size for desktop UA', () => {
        const ua = generateChromeUA('desktop');
        const screen = getMatchingScreenSize(ua);
        expect(screen.width).toBeGreaterThanOrEqual(1024);
        expect(screen.height).toBeGreaterThanOrEqual(720);
    });

    test('should return mobile size for mobile UA', () => {
        const ua = generateAndroidUA();
        const screen = getMatchingScreenSize(ua);
        expect(screen.width).toBeLessThanOrEqual(500);
        expect(screen.height).toBeGreaterThanOrEqual(500);
    });

    test('should return mobile size for iPhone UA', () => {
        const ua = generateiPhoneUA();
        const screen = getMatchingScreenSize(ua);
        expect(screen.width).toBeLessThanOrEqual(500);
    });
});

describe('getMixedScreenSizes()', () => {

    test('should return requested count', () => {
        expect(getMixedScreenSizes(50)).toHaveLength(50);
        expect(getMixedScreenSizes(200)).toHaveLength(200);
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
});

describe('getDesktopScreens()', () => {
    test('all should be desktop resolution', () => {
        const screens = getDesktopScreens(50);
        screens.forEach(s => {
            expect(s.width).toBeGreaterThanOrEqual(1024);
        });
    });
});

describe('getMobileScreens()', () => {
    test('all should be mobile resolution', () => {
        const screens = getMobileScreens(50);
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
});
