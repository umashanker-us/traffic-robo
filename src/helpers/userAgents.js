/**
 * User Agent Generator for GA4 Traffic Robo
 * Provides realistic user agents based on current browser market share
 * 
 * FIXED: Added Windows device type handler
 */

const Constants = require('./constants');

// Latest Chrome versions (December 2025 - Current stable: 143)
// Format: { major, build } - Real build numbers from Chrome releases
const CHROME_VERSIONS = [
    { major: '143', build: '7499' },  // Dec 2025 - Current stable
    { major: '143', build: '7499' },  // Dec 2025 - Weight for current
    { major: '142', build: '7392' },  // Nov 2025
    { major: '141', build: '7277' },  // Oct 2025
    { major: '140', build: '7167' },  // Sep 2025
];

// Firefox versions - December 2025 (v135 is latest)
const FIREFOX_VERSIONS = ['135.0', '134.0.2', '134.0', '133.0.3', '133.0'];

// Safari versions - December 2025 (Safari 19 for iOS 26, Safari 18 for older)
const SAFARI_VERSIONS = ['19.2', '19.1', '19.0', '18.2', '18.1'];

// Opera versions - Chromium-based, ships its own OPR/ token and its own
// "Opera" client-hint brand, so GA4 reports it as Opera and everything agrees.
const OPERA_VERSIONS = ['129', '128', '127', '126'];

// Samsung Internet - the default browser on Samsung Android devices, Chromium
// based with its own SamsungBrowser/ token and "Samsung Internet" brand.
const SAMSUNG_BROWSER_VERSIONS = ['28.0', '27.0', '26.0', '25.0'];

// Android tablets. A tablet UA carries no "Mobile" token, which is exactly how
// Chrome on an Android tablet presents itself, and it is what makes GA4 report
// the device category as tablet rather than mobile.
const ANDROID_TABLETS = [
    { device: 'SM-X810', version: '15' },       // Galaxy Tab S10+
    { device: 'SM-X710', version: '15' },       // Galaxy Tab S9
    { device: 'SM-X216B', version: '15' },      // Galaxy Tab A9+
    { device: 'Pixel Tablet', version: '16' },
    { device: 'Lenovo TB375FC', version: '14' },// Tab P12
    { device: 'Redmi Pad SE', version: '14' },
];

// Edge versions (same build as Chrome since Chromium-based) - December 2025
const EDGE_VERSIONS = [
    { major: '143', build: '7499' },  // Dec 2025
    { major: '143', build: '7499' },  // Weight for current
    { major: '142', build: '7392' },  // Nov 2025
    { major: '141', build: '7277' },  // Oct 2025
];

// Windows versions (Windows 10 still dominant in user agents)
const WINDOWS_VERSIONS = [
    'Windows NT 10.0; Win64; x64',    // Windows 10/11 (same in UA)
    'Windows NT 10.0; Win64; x64',
    'Windows NT 10.0; Win64; x64',
    'Windows NT 10.0; Win64; x64',
    'Windows NT 10.0; Win64; x64',
];

// Mac versions - December 2025 (macOS 15 Sequoia is current)
const MAC_VERSIONS = [
    'Macintosh; Intel Mac OS X 10_15_7',   // Legacy (still common in UAs)
    'Macintosh; Intel Mac OS X 14_7_2',    // Sonoma latest
    'Macintosh; Intel Mac OS X 15_1',      // Sequoia
    'Macintosh; Intel Mac OS X 15_2',      // Sequoia latest (Dec 2025)
    'Macintosh; Intel Mac OS X 15_2',      // Sequoia
];

// Android devices - December 2025 (Samsung S25, Pixel 10, etc.)
const ANDROID_DEVICES = [
    // Samsung Galaxy S25 Series (Feb 2025) - Android 15
    { device: 'SM-S938B', version: '15' },      // Samsung S25 Ultra
    { device: 'SM-S936B', version: '15' },      // Samsung S25+
    { device: 'SM-S931B', version: '15' },      // Samsung S25
    { device: 'SM-S928B', version: '15' },      // Samsung S24 Ultra (updated)
    { device: 'SM-S926B', version: '15' },      // Samsung S24+
    { device: 'SM-A566B', version: '15' },      // Samsung A56 (2025)
    { device: 'SM-A556B', version: '15' },      // Samsung A55
    // Google Pixel 10 Series (Aug 2025) - Android 16
    { device: 'Pixel 10 Pro XL', version: '16' },
    { device: 'Pixel 10 Pro', version: '16' },
    { device: 'Pixel 10', version: '16' },
    // Pixel 9 Series (updated to Android 16)
    { device: 'Pixel 9 Pro XL', version: '16' },
    { device: 'Pixel 9 Pro', version: '16' },
    { device: 'Pixel 9', version: '16' },
    // OnePlus (2025)
    { device: 'CPH2653', version: '15' },       // OnePlus 13 (Dec 2024/Jan 2025)
    { device: 'CPH2609', version: '15' },       // OnePlus 12
    { device: 'CPH2589', version: '15' },       // OnePlus Nord 4
    // Xiaomi/Redmi/POCO (2025)
    { device: 'Redmi Note 14 Pro', version: '15' },
    { device: 'POCO X7 Pro', version: '15' },
    { device: '24129PN74G', version: '15' },    // Xiaomi 15 Pro
    // Other flagships
    { device: 'V2402', version: '15' },         // vivo X200 Pro
    { device: 'RMX5000', version: '15' },       // Realme GT 7 Pro
];

// iPhone models - December 2025 (iPhone 17 series with iOS 26)
const IPHONE_MODELS = [
    // iPhone 17 Series (Sep 2025) - iOS 26
    { model: 'iPhone18,2', version: '26_2' },   // iPhone 17 Pro Max
    { model: 'iPhone18,1', version: '26_2' },   // iPhone 17 Pro
    { model: 'iPhone18,4', version: '26_1' },   // iPhone 17
    { model: 'iPhone18,3', version: '26_1' },   // iPhone Air
    // iPhone 16 Series (updated to iOS 26)
    { model: 'iPhone17,2', version: '26_1' },   // iPhone 16 Pro Max
    { model: 'iPhone17,1', version: '26_0' },   // iPhone 16 Pro
    { model: 'iPhone17,4', version: '26_0' },   // iPhone 16 Plus
    { model: 'iPhone17,3', version: '26_0' },   // iPhone 16
    // iPhone 15 Series
    { model: 'iPhone16,2', version: '18_2' },   // iPhone 15 Pro Max
    { model: 'iPhone16,1', version: '18_1' },   // iPhone 15 Pro
];

// ===== Chrome's User-Agent Reduction =====
//
// Since Chrome 110 the UA string is frozen. Measured against the installed
// Chrome 154: it sends `Chrome/154.0.0.0`, not its real build. The platform and
// device detail were removed from the UA entirely — Windows is pinned to
// "Windows NT 10.0; Win64; x64", macOS to "10_15_7" whatever the real version,
// and Android to "Android 10; K" whatever the real device. The real values moved
// to the client hints, which a server receives only if it asks.
//
// Generating a full build number and a real device model in the UA is therefore
// a tell in itself: it says "not a current Chrome". The real detail still
// reaches GA4, through the hints.
const REDUCED_WINDOWS = 'Windows NT 10.0; Win64; x64';
const REDUCED_MAC = 'Macintosh; Intel Mac OS X 10_15_7';
const REDUCED_ANDROID = 'Linux; Android 10; K';

const WINDOWS_PLATFORM_VERSIONS = ['15.0.0', '10.0.0'];
const MAC_PLATFORM_VERSIONS = ['15.2.0', '15.1.0', '14.7.2'];

/**
 * The frozen version Chrome puts in the UA: major, then 0.0.0.
 */
function reducedVersion(fullVersion) {
    return `${String(fullVersion).split('.')[0]}.0.0.0`;
}

/**
 * Get random element from array
 */
function getRandomElement(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// When the real browser version is known, every generated UA claims it instead
// of a hardcoded guess. Chromium 145 claiming to be 143 is a small lie; real
// Chrome 154 claiming 143 is a large one, and feature detection does not lie —
// a page can see APIs that the claimed version never shipped.
let runtimeChromeVersion = null;

/**
 * Pin generated user agents to the browser that will actually run them.
 * @param {string|null} version - full version, e.g. '154.0.8037.59'
 */
function setRuntimeChromeVersion(version) {
    if (!version) { runtimeChromeVersion = null; return; }
    const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    runtimeChromeVersion = match ? { major: match[1], build: match[3], full: String(version) } : null;
}

function getRuntimeChromeVersion() {
    return runtimeChromeVersion;
}

/**
 * Generate realistic Chrome version string
 * Format: Major.0.Build.Patch (e.g., 143.0.7499.42)
 */
function getChromeVersionString() {
    if (runtimeChromeVersion) {
        // Vary only the patch: the major and build must match the real engine.
        const patch = Math.floor(Math.random() * 150) + 1;
        return `${runtimeChromeVersion.major}.0.${runtimeChromeVersion.build}.${patch}`;
    }
    const version = getRandomElement(CHROME_VERSIONS);
    // Patch numbers typically range from 0-200
    const patch = Math.floor(Math.random() * 150) + 1;
    return `${version.major}.0.${version.build}.${patch}`;
}

/**
 * Generate realistic Edge version string
 */
function getEdgeVersionString() {
    if (runtimeChromeVersion) {
        const patch = Math.floor(Math.random() * 150) + 1;
        return `${runtimeChromeVersion.major}.0.${runtimeChromeVersion.build}.${patch}`;
    }
    const version = getRandomElement(EDGE_VERSIONS);
    const patch = Math.floor(Math.random() * 150) + 1;
    return `${version.major}.0.${version.build}.${patch}`;
}

/**
 * Generate Chrome user agent
 */
function generateChromeUA(platform = 'desktop') {
    return generateChromeProfile(platform).ua;
}

/**
 * A Chrome profile: the reduced UA string plus the real platform and device,
 * which belong in the client hints rather than the UA.
 *
 * @param {string} platform - 'desktop' | 'mobile'
 * @returns {{ua: string, platform: string, platformVersion: string, model: string, mobile: boolean, fullVersion: string}}
 */
function generateChromeProfile(platform = 'desktop') {
    const chromeVersion = getChromeVersionString();
    const uaVersion = reducedVersion(chromeVersion);

    if (platform === 'mobile') {
        const device = getRandomElement(ANDROID_DEVICES);
        return {
            ua: `Mozilla/5.0 (${REDUCED_ANDROID}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${uaVersion} Mobile Safari/537.36`,
            platform: 'Android',
            platformVersion: `${device.version}.0.0`,
            model: device.device,
            mobile: true,
            fullVersion: chromeVersion,
        };
    }

    const onWindows = Math.random() > 0.3;
    return {
        ua: `Mozilla/5.0 (${onWindows ? REDUCED_WINDOWS : REDUCED_MAC}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${uaVersion} Safari/537.36`,
        platform: onWindows ? 'Windows' : 'macOS',
        platformVersion: getRandomElement(onWindows ? WINDOWS_PLATFORM_VERSIONS : MAC_PLATFORM_VERSIONS),
        model: '',
        mobile: false,
        fullVersion: chromeVersion,
    };
}

/**
 * Generate Firefox user agent
 */
function generateFirefoxUA(platform = 'desktop') {
    const version = getRandomElement(FIREFOX_VERSIONS);
    // Extract major version for rv: field
    const majorVersion = version.split('.')[0];
    
    if (platform === 'desktop') {
        const os = Math.random() > 0.3 ? getRandomElement(WINDOWS_VERSIONS) : getRandomElement(MAC_VERSIONS);
        return `Mozilla/5.0 (${os}; rv:${majorVersion}.0) Gecko/20100101 Firefox/${version}`;
    } else {
        const device = getRandomElement(ANDROID_DEVICES);
        return `Mozilla/5.0 (Android ${device.version}; Mobile; rv:${majorVersion}.0) Gecko/${majorVersion}.0 Firefox/${version}`;
    }
}

/**
 * Generate Safari user agent (only desktop Mac and iOS)
 */
function generateSafariUA(platform = 'desktop') {
    const version = getRandomElement(SAFARI_VERSIONS);
    
    if (platform === 'desktop') {
        const mac = getRandomElement(MAC_VERSIONS);
        return `Mozilla/5.0 (${mac}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`;
    } else {
        const iphone = getRandomElement(IPHONE_MODELS);
        return `Mozilla/5.0 (iPhone; CPU iPhone OS ${iphone.version.replace('_', '_')} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Mobile/15E148 Safari/604.1`;
    }
}

/**
 * Generate Edge user agent
 */
function generateEdgeUA() {
    return generateEdgeProfile().ua;
}

function generateEdgeProfile() {
    const edgeVersion = getEdgeVersionString();
    const chromeVersion = getChromeVersionString();
    return {
        ua: `Mozilla/5.0 (${REDUCED_WINDOWS}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reducedVersion(chromeVersion)} Safari/537.36 Edg/${reducedVersion(edgeVersion)}`,
        platform: 'Windows',
        platformVersion: getRandomElement(WINDOWS_PLATFORM_VERSIONS),
        model: '',
        mobile: false,
        fullVersion: edgeVersion,
    };
}

/**
 * Generate an Opera user agent (desktop or Android).
 * Opera is Chromium with its own OPR/ token and its own client-hint brand, so
 * the UA string and the hints agree and GA4 reports a distinct browser.
 */
function generateOperaUA(platform = 'desktop') {
    return generateOperaProfile(platform).ua;
}

/**
 * Opera is Chromium with its own OPR/ token and its own client-hint brand, so
 * the UA and the hints agree and GA4 reports a distinct browser.
 */
function generateOperaProfile(platform = 'desktop') {
    const chromeVersion = getChromeVersionString();
    const opera = getRandomElement(OPERA_VERSIONS);
    const operaVersion = `${opera}.0.${5900 + Math.floor(Math.random() * 400)}.${Math.floor(Math.random() * 90) + 10}`;

    if (platform === 'mobile') {
        const device = getRandomElement(ANDROID_DEVICES);
        return {
            ua: `Mozilla/5.0 (${REDUCED_ANDROID}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reducedVersion(chromeVersion)} Mobile Safari/537.36 OPR/${reducedVersion(operaVersion)}`,
            platform: 'Android',
            platformVersion: `${device.version}.0.0`,
            model: device.device,
            mobile: true,
            fullVersion: operaVersion,
        };
    }

    const onWindows = Math.random() > 0.3;
    return {
        ua: `Mozilla/5.0 (${onWindows ? REDUCED_WINDOWS : REDUCED_MAC}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reducedVersion(chromeVersion)} Safari/537.36 OPR/${reducedVersion(operaVersion)}`,
        platform: onWindows ? 'Windows' : 'macOS',
        platformVersion: getRandomElement(onWindows ? WINDOWS_PLATFORM_VERSIONS : MAC_PLATFORM_VERSIONS),
        model: '',
        mobile: false,
        fullVersion: operaVersion,
    };
}

/**
 * Generate a Samsung Internet user agent (Android only, as it ships).
 */
function generateSamsungInternetUA() {
    return generateSamsungInternetProfile().ua;
}

function generateSamsungInternetProfile() {
    const device = getRandomElement(ANDROID_DEVICES);
    const chromeVersion = getChromeVersionString();
    const sb = getRandomElement(SAMSUNG_BROWSER_VERSIONS);
    return {
        ua: `Mozilla/5.0 (${REDUCED_ANDROID}) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/${sb} Chrome/${reducedVersion(chromeVersion)} Mobile Safari/537.36`,
        platform: 'Android',
        platformVersion: `${device.version}.0.0`,
        model: device.device,
        mobile: true,
        fullVersion: sb,
    };
}

/**
 * Generate an Android tablet user agent.
 * No "Mobile" token — that is how Chrome presents on an Android tablet, and it
 * is what makes GA4 classify the device as tablet instead of mobile.
 */
function generateAndroidTabletUA() {
    return generateAndroidTabletProfile().ua;
}

function generateAndroidTabletProfile() {
    const tablet = getRandomElement(ANDROID_TABLETS);
    const chromeVersion = getChromeVersionString();
    return {
        // No "Mobile" token: that is how Chrome presents on an Android tablet,
        // and with mobile:false in the hints it is what GA4 reads as tablet.
        ua: `Mozilla/5.0 (${REDUCED_ANDROID}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reducedVersion(chromeVersion)} Safari/537.36`,
        platform: 'Android',
        platformVersion: `${tablet.version}.0.0`,
        model: tablet.device,
        mobile: false,
        fullVersion: chromeVersion,
    };
}

/**
 * Generate Android mobile user agent
 */
function generateAndroidUA() {
    return generateChromeProfile('mobile').ua;
}

/**
 * Generate iPhone user agent
 */
function generateiPhoneUA() {
    return generateSafariUA('mobile');
}

/**
 * Generate Windows-only user agent (Chrome or Edge on Windows)
 * FIXED: Added this function for Windows device type
 */
function generateWindowsUA() {
    const os = getRandomElement(WINDOWS_VERSIONS);
    const chromeVersion = getChromeVersionString();
    
    // 70% Chrome, 30% Edge on Windows
    if (Math.random() > 0.3) {
        return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    } else {
        const edgeVersion = getEdgeVersionString();
        return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36 Edg/${edgeVersion}`;
    }
}

/**
 * Windows only, Chromium family. generateChromeProfile('desktop') picks macOS
 * 30% of the time, which is wrong for a device type that names an OS.
 */
function generateWindowsProfile() {
    if (Math.random() > 0.3) {
        const chromeVersion = getChromeVersionString();
        return {
            ua: `Mozilla/5.0 (${REDUCED_WINDOWS}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reducedVersion(chromeVersion)} Safari/537.36`,
            platform: 'Windows',
            platformVersion: getRandomElement(WINDOWS_PLATFORM_VERSIONS),
            model: '',
            mobile: false,
            fullVersion: chromeVersion,
        };
    }
    return generateEdgeProfile();
}

/**
 * Desktop, Chromium family only. Shares lean to the Indian desktop market:
 * Chrome dominant, Edge second (it ships with Windows), Opera a long tail.
 */
function pickDesktopChromiumUA() {
    return pickDesktopChromiumProfile().ua;
}

function pickDesktopChromiumProfile() {
    const r = Math.random();
    if (r < 0.80) return generateChromeProfile('desktop');
    if (r < 0.95) return generateEdgeProfile();
    return generateOperaProfile('desktop');
}

/**
 * Android, Chromium family only. Chrome dominant, Samsung Internet second
 * (the default browser on every Samsung handset), Opera a long tail.
 */
function pickMobileChromiumUA() {
    return pickMobileChromiumProfile().ua;
}

function pickMobileChromiumProfile() {
    const r = Math.random();
    if (r < 0.82) return generateChromeProfile('mobile');
    if (r < 0.94) return generateSamsungInternetProfile();
    return generateOperaProfile('mobile');
}

/**
 * The mixed default: desktop, mobile and a slice of tablet.
 */
function pickMixedChromiumUA() {
    return pickMixedChromiumProfile().ua;
}

function pickMixedChromiumProfile() {
    const r = Math.random();
    if (r < 0.58) return pickDesktopChromiumProfile();
    if (r < 0.94) return pickMobileChromiumProfile();
    return generateAndroidTabletProfile();
}

/**
 * Device types whose user agents cannot carry matching client hints, because
 * Chromium always sends sec-ch-ua and a non-Chromium browser never does. They
 * stay available as an explicit choice, with this flag so callers can warn.
 * @param {string} userAgentType
 * @returns {boolean}
 */
function isInconsistentDeviceType(userAgentType) {
    return userAgentType === Constants.DEVICE_TYPES.FIREFOX
        || userAgentType === Constants.DEVICE_TYPES.IPHONE;
}

/**
 * Get user agent list based on type
 * @param {string} userAgentType - Type from Constants.DEVICE_TYPES
 * @param {number} count - Number of user agents to generate
 * @returns {string[]} Array of user agents
 * 
 * FIXED: Added Windows case handler
 */
function getUserAgentList(userAgentType, count = 100) {
    return getUserAgentProfiles(userAgentType, count).map(p => p.ua);
}

/**
 * Generate user agents together with the device detail that no longer fits in
 * the UA string. Chrome's UA reduction froze the platform and removed the
 * model, so the real values have to travel separately and end up in the client
 * hints — that is where GA4 reads them from.
 *
 * @param {string} userAgentType - Type from Constants.DEVICE_TYPES
 * @param {number} count
 * @returns {Array<{ua: string, platform: string, platformVersion: string, model: string, mobile: boolean}>}
 */
function getUserAgentProfiles(userAgentType, count = 100) {
    const profiles = [];
    for (let i = 0; i < count; i++) {
        profiles.push(generateUserAgentProfile(userAgentType));
    }
    return profiles;
}

/**
 * One profile for a device type. Non-Chromium types have no matching hints at
 * all, so they carry no device detail — see isInconsistentDeviceType.
 */
function generateUserAgentProfile(userAgentType) {
    switch (userAgentType) {
        case Constants.DEVICE_TYPES.DEFAULT:
        case Constants.DEVICE_TYPES.DESK_MOBILE:
            return pickMixedChromiumProfile();
        case Constants.DEVICE_TYPES.DESKTOP:
            return pickDesktopChromiumProfile();
        case Constants.DEVICE_TYPES.MOBILE:
            return pickMobileChromiumProfile();
        case Constants.DEVICE_TYPES.TABLET:
            return generateAndroidTabletProfile();
        case Constants.DEVICE_TYPES.CHROME:
            return generateChromeProfile(Math.random() > 0.3 ? 'desktop' : 'mobile');
        case Constants.DEVICE_TYPES.ANDROID:
            return generateChromeProfile('mobile');
        case Constants.DEVICE_TYPES.WINDOWS:
            return generateWindowsProfile();
        default:
            // Firefox and iPhone: no hints can match these, so no detail either.
            return { ua: legacyUserAgentFor(userAgentType), platform: '', platformVersion: '', model: '', mobile: false };
    }
}

/**
 * The non-Chromium types, kept because they remain selectable.
 */
function legacyUserAgentFor(userAgentType) {
    const legacy = [];
    legacyUserAgentList(userAgentType, 1, legacy);
    return legacy[0];
}

function legacyUserAgentList(userAgentType, count, out) {
    const userAgents = out;
    
    for (let i = 0; i < count; i++) {
        let ua;
        
        switch (userAgentType) {
            case Constants.DEVICE_TYPES.DEFAULT:
            case Constants.DEVICE_TYPES.DESK_MOBILE:
                // 58% desktop, 36% mobile, 6% tablet — and every entry is a
                // Chromium browser, which is the whole point. Playwright drives
                // Chromium, and Chromium always sends sec-ch-ua headers that
                // cannot be suppressed. A Firefox or Safari UA therefore has to
                // ship an empty brand list, which GA4 cannot resolve to a
                // browser, so the browser dimension collapses to "Mozilla".
                // Chrome, Edge, Opera and Samsung Internet each send their own
                // real brand, so GA4 reports four distinct browsers and the UA
                // string, the hints and the engine all agree.
                ua = pickMixedChromiumUA();
                break;

            case Constants.DEVICE_TYPES.DESKTOP:
                ua = pickDesktopChromiumUA();
                break;

            case Constants.DEVICE_TYPES.MOBILE:
                ua = pickMobileChromiumUA();
                break;

            case Constants.DEVICE_TYPES.TABLET:
                ua = generateAndroidTabletUA();
                break;

            case Constants.DEVICE_TYPES.CHROME:
                ua = Math.random() > 0.3 ? generateChromeUA('desktop') : generateChromeUA('mobile');
                break;
                
            case Constants.DEVICE_TYPES.FIREFOX:
                ua = Math.random() > 0.3 ? generateFirefoxUA('desktop') : generateFirefoxUA('mobile');
                break;
                
            case Constants.DEVICE_TYPES.ANDROID:
                ua = generateAndroidUA();
                break;
                
            case Constants.DEVICE_TYPES.IPHONE:
                ua = generateiPhoneUA();
                break;
            
            // FIXED: Added Windows case
            case Constants.DEVICE_TYPES.WINDOWS:
                ua = generateWindowsUA();
                break;
                
            default:
                ua = generateChromeUA('desktop');
        }
        
        userAgents.push(ua);
    }
    
    return userAgents;
}

/**
 * Get screen dimensions matching user agent
 * @param {string} userAgent - User agent string
 * @returns {Object} Screen dimensions {width, height}
 */
function getMatchingScreenSize(userAgent) {
    // Order matters: an Android tablet UA contains "Android" but no "Mobile"
    // token, which is how Chrome presents on a tablet. Checking mobile first
    // would hand it a phone-sized screen and GA4 would call it a phone.
    const isTablet = userAgent.includes('iPad')
        || userAgent.includes('Tablet')
        || (userAgent.includes('Android') && !userAgent.includes('Mobile'));
    const isMobile = !isTablet
        && (userAgent.includes('Mobile') || userAgent.includes('Android') || userAgent.includes('iPhone'));
    
    if (isMobile) {
        return getRandomElement(Constants.MOBILE_SCREENS);
    } else if (isTablet) {
        return getRandomElement(Constants.TABLET_SCREENS);
    } else {
        return getRandomElement(Constants.DESKTOP_SCREENS);
    }
}

/**
 * Get mixed screen sizes for various device types
 * @param {number} count - Number of screen sizes to generate
 * @returns {Object[]} Array of screen dimension objects
 */
function getMixedScreenSizes(count = 100) {
    const screens = [];
    
    for (let i = 0; i < count; i++) {
        const rand = Math.random();
        if (rand < 0.55) {
            screens.push(getRandomElement(Constants.DESKTOP_SCREENS));
        } else if (rand < 0.95) {
            screens.push(getRandomElement(Constants.MOBILE_SCREENS));
        } else {
            screens.push(getRandomElement(Constants.TABLET_SCREENS));
        }
    }
    
    return screens;
}

/**
 * Get desktop-only screen sizes
 */
function getDesktopScreens(count = 100) {
    return Array(count).fill(null).map(() => getRandomElement(Constants.DESKTOP_SCREENS));
}

/**
 * Get mobile-only screen sizes
 */
function getMobileScreens(count = 100) {
    return Array(count).fill(null).map(() => getRandomElement(Constants.MOBILE_SCREENS));
}

module.exports = {
    getUserAgentList,
    getUserAgentProfiles,
    generateUserAgentProfile,
    generateChromeProfile,
    generateEdgeProfile,
    generateOperaProfile,
    generateSamsungInternetProfile,
    generateAndroidTabletProfile,
    generateWindowsProfile,
    pickDesktopChromiumProfile,
    pickMobileChromiumProfile,
    pickMixedChromiumProfile,
    reducedVersion,
    generateOperaUA,
    generateSamsungInternetUA,
    generateAndroidTabletUA,
    pickDesktopChromiumUA,
    pickMobileChromiumUA,
    pickMixedChromiumUA,
    isInconsistentDeviceType,
    setRuntimeChromeVersion,
    getRuntimeChromeVersion,
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
    generateWindowsUA
};
