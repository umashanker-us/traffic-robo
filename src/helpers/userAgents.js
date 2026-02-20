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

/**
 * Get random element from array
 */
function getRandomElement(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate realistic Chrome version string
 * Format: Major.0.Build.Patch (e.g., 143.0.7499.42)
 */
function getChromeVersionString() {
    const version = getRandomElement(CHROME_VERSIONS);
    // Patch numbers typically range from 0-200
    const patch = Math.floor(Math.random() * 150) + 1;
    return `${version.major}.0.${version.build}.${patch}`;
}

/**
 * Generate realistic Edge version string
 */
function getEdgeVersionString() {
    const version = getRandomElement(EDGE_VERSIONS);
    const patch = Math.floor(Math.random() * 150) + 1;
    return `${version.major}.0.${version.build}.${patch}`;
}

/**
 * Generate Chrome user agent
 */
function generateChromeUA(platform = 'desktop') {
    const chromeVersion = getChromeVersionString();
    
    if (platform === 'desktop') {
        const os = Math.random() > 0.3 ? getRandomElement(WINDOWS_VERSIONS) : getRandomElement(MAC_VERSIONS);
        return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    } else if (platform === 'mobile') {
        const device = getRandomElement(ANDROID_DEVICES);
        return `Mozilla/5.0 (Linux; Android ${device.version}; ${device.device}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Mobile Safari/537.36`;
    }
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
    const edgeVersion = getEdgeVersionString();
    const chromeVersion = getChromeVersionString();
    const os = getRandomElement(WINDOWS_VERSIONS);
    return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36 Edg/${edgeVersion}`;
}

/**
 * Generate Android mobile user agent
 */
function generateAndroidUA() {
    const device = getRandomElement(ANDROID_DEVICES);
    const chromeVersion = getChromeVersionString();
    return `Mozilla/5.0 (Linux; Android ${device.version}; ${device.device}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Mobile Safari/537.36`;
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
 * Get user agent list based on type
 * @param {string} userAgentType - Type from Constants.DEVICE_TYPES
 * @param {number} count - Number of user agents to generate
 * @returns {string[]} Array of user agents
 * 
 * FIXED: Added Windows case handler
 */
function getUserAgentList(userAgentType, count = 100) {
    const userAgents = [];
    
    for (let i = 0; i < count; i++) {
        let ua;
        
        switch (userAgentType) {
            case Constants.DEVICE_TYPES.DEFAULT:
            case Constants.DEVICE_TYPES.DESK_MOBILE:
                // Mixed distribution: 60% desktop, 35% mobile, 5% tablet-like
                const rand = Math.random();
                if (rand < 0.60) {
                    ua = Math.random() > 0.2 ? generateChromeUA('desktop') : 
                         (Math.random() > 0.5 ? generateFirefoxUA('desktop') : generateSafariUA('desktop'));
                } else if (rand < 0.95) {
                    ua = Math.random() > 0.4 ? generateAndroidUA() : generateiPhoneUA();
                } else {
                    ua = generateChromeUA('desktop'); // Tablet uses desktop-like UA
                }
                break;
                
            case Constants.DEVICE_TYPES.DESKTOP:
                // Desktop only distribution
                const desktopRand = Math.random();
                if (desktopRand < 0.65) {
                    ua = generateChromeUA('desktop');
                } else if (desktopRand < 0.80) {
                    ua = generateEdgeUA();
                } else if (desktopRand < 0.90) {
                    ua = generateSafariUA('desktop');
                } else {
                    ua = generateFirefoxUA('desktop');
                }
                break;
                
            case Constants.DEVICE_TYPES.MOBILE:
                // Mobile only distribution
                ua = Math.random() > 0.45 ? generateAndroidUA() : generateiPhoneUA();
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
    const isMobile = userAgent.includes('Mobile') || userAgent.includes('Android') || userAgent.includes('iPhone');
    const isTablet = userAgent.includes('iPad') || userAgent.includes('Tablet');
    
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
