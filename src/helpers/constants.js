/**
 * Constants and Configuration for GA4 Traffic Robo
 * Similar to Java Constants.java but for Node.js
 * 
 * FIXED: Added location coordinates mapping
 */

const path = require('path');

// Base paths - will be set dynamically based on app location
const APP_PATH = process.cwd();
const DATA_PATH = path.join(APP_PATH, 'data');

const Constants = {
    // Paths
    BROWSER_PATH: path.join(DATA_PATH, 'browsers'),
    LOCATION_PATH: path.join(DATA_PATH, 'location'),
    LOGS_PATH: path.join(APP_PATH, 'logs'),
    CONFIG_PATH: path.join(APP_PATH, 'config'),
    EXTENSIONS_PATH: path.join(APP_PATH, 'src', 'extensions'),

    // User Agent Types
    DEVICE_TYPES: {
        DEFAULT: 'Default',
        DESKTOP: 'Desktop',
        DESK_MOBILE: 'Desktop & Mobile',
        MOBILE: 'Mobile',
        CHROME: 'Chrome',
        FIREFOX: 'Firefox',
        ANDROID: 'Android',
        IPHONE: 'iPhone',
        WINDOWS: 'Windows'
    },

    // Location Types with Coordinates - FIXED: Added actual coordinates
    LOCATIONS: {
        INDIA: 'India',
        GUJARAT: 'Gujarat',
        DELHI: 'Delhi',
        MUMBAI: 'Mumbai',
        BANGALORE: 'Bangalore',
        CHENNAI: 'Chennai',
        KOLKATA: 'Kolkata',
        HYDERABAD: 'Hyderabad',
        USA: 'USA',
        UK: 'UK',
        RANDOM: 'Random'
    },

    // Location Coordinates Mapping - NEW
    LOCATION_COORDS: {
        'India': { latitude: 20.5937, longitude: 78.9629, timezone: 'Asia/Kolkata', locale: 'en-IN' },
        'Gujarat': { latitude: 22.2587, longitude: 71.1924, timezone: 'Asia/Kolkata', locale: 'en-IN' },
        'Delhi': { latitude: 28.6139, longitude: 77.2090, timezone: 'Asia/Kolkata', locale: 'en-IN' },
        'Mumbai': { latitude: 19.0760, longitude: 72.8777, timezone: 'Asia/Kolkata', locale: 'en-IN' },
        'Bangalore': { latitude: 12.9716, longitude: 77.5946, timezone: 'Asia/Kolkata', locale: 'en-IN' },
        'Chennai': { latitude: 13.0827, longitude: 80.2707, timezone: 'Asia/Kolkata', locale: 'en-IN' },
        'Kolkata': { latitude: 22.5726, longitude: 88.3639, timezone: 'Asia/Kolkata', locale: 'en-IN' },
        'Hyderabad': { latitude: 17.3850, longitude: 78.4867, timezone: 'Asia/Kolkata', locale: 'en-IN' },
        'USA': { latitude: 37.0902, longitude: -95.7129, timezone: 'America/New_York', locale: 'en-US' },
        'UK': { latitude: 51.5074, longitude: -0.1278, timezone: 'Europe/London', locale: 'en-GB' },
        'Random': null  // Will be randomly selected
    },

    // Play Modes - Execution speed
    PLAY_MODES: {
        FASTEST: 'Fastest',    // Headless, no delays
        FAST: 'Fast',          // Headless with minimal delays
        SLOW: 'Slow',          // Headed with realistic delays
        SLOWER: 'Slower'       // Headed with maximum realistic behavior
    },

    // Command Modes
    COMMAND_MODES: {
        AUTOMATIC: 'Automatic',  // Auto navigation based on links
        MANUAL: 'Manual'         // Custom commands for navigation
    },

    // Selector Types (for Manual mode)
    SELECTOR_TYPES: {
        LINK_TEXT: 'linkText',
        ID: 'id',
        SRC: 'src',
        NAME: 'name',
        TAG_NAME: 'tagName',
        CLASS_NAME: 'className',
        CSS_SELECTOR: 'cssSelector',
        X_PATH: 'xPath',
        FRAME: 'frame',
        RANDOM: 'random'
    },

    // GA4 Event Names for realistic tracking
    GA4_EVENTS: {
        PAGE_VIEW: 'page_view',
        SCROLL: 'scroll',
        CLICK: 'click',
        SESSION_START: 'session_start',
        USER_ENGAGEMENT: 'user_engagement',
        FIRST_VISIT: 'first_visit'
    },

    // Default Screen Resolutions (Desktop)
    DESKTOP_SCREENS: [
        { width: 1920, height: 1080 },  // Full HD - Most common
        { width: 1366, height: 768 },   // HD - Laptops
        { width: 1536, height: 864 },   // HD+
        { width: 1440, height: 900 },   // WXGA+
        { width: 1280, height: 720 },   // HD
        { width: 2560, height: 1440 },  // QHD
        { width: 1600, height: 900 },   // HD+
        { width: 1280, height: 1024 },  // SXGA
    ],

    // Mobile Screen Resolutions
    MOBILE_SCREENS: [
        { width: 390, height: 844 },    // iPhone 14/13/12
        { width: 375, height: 812 },    // iPhone X/XS/11 Pro
        { width: 414, height: 896 },    // iPhone XR/11/XS Max
        { width: 430, height: 932 },    // iPhone 14 Pro Max
        { width: 360, height: 740 },    // Samsung Galaxy S series
        { width: 412, height: 915 },    // Pixel 7
        { width: 393, height: 873 },    // Pixel 6
        { width: 360, height: 800 },    // Samsung A series
        { width: 412, height: 914 },    // Pixel 5
        { width: 320, height: 568 },    // iPhone SE
    ],

    // Tablet Screen Resolutions
    TABLET_SCREENS: [
        { width: 768, height: 1024 },   // iPad
        { width: 820, height: 1180 },   // iPad Air
        { width: 834, height: 1194 },   // iPad Pro 11"
        { width: 1024, height: 1366 },  // iPad Pro 12.9"
        { width: 800, height: 1280 },   // Android tablets
    ],

    // Default Timings (in milliseconds)
    TIMINGS: {
        MIN_PAGE_LOAD_WAIT: 2000,
        MAX_PAGE_LOAD_WAIT: 8000,
        MIN_SCROLL_DELAY: 500,
        MAX_SCROLL_DELAY: 2000,
        MIN_CLICK_DELAY: 100,
        MAX_CLICK_DELAY: 500,
        MIN_TYPE_DELAY: 50,
        MAX_TYPE_DELAY: 200,
        ENGAGEMENT_MIN: 10000,  // 10 seconds
        ENGAGEMENT_MAX: 300000  // 5 minutes
    },

    // Thread/Concurrency settings
    CONCURRENCY: {
        MIN_THREADS: 1,
        MAX_THREADS: 50,
        DEFAULT_THREADS: 5,
        THREAD_DELAY_MS: 1000
    },

    // Bounce Rate Limits
    BOUNCE_RATE: {
        MIN: 1,
        MAX: 90,
        DEFAULT: 30
    },

    // Session Duration Limits (in seconds)
    SESSION_DURATION: {
        MIN: 0,
        MAX: 600,
        DEFAULT: 60
    },

    // Pages Per Session
    PAGES_PER_SESSION: {
        MIN: 1,
        MAX: 20,
        DEFAULT: 3
    }
};

/**
 * Get location coordinates by name
 * @param {string} locationName - Location name from LOCATIONS
 * @returns {Object} Location data with latitude, longitude, timezone, locale
 */
Constants.getLocationCoords = function(locationName) {
    if (locationName === 'Random') {
        // Pick random location (excluding Random itself)
        const locations = Object.keys(this.LOCATION_COORDS).filter(k => k !== 'Random');
        const randomKey = locations[Math.floor(Math.random() * locations.length)];
        return this.LOCATION_COORDS[randomKey];
    }
    
    return this.LOCATION_COORDS[locationName] || this.LOCATION_COORDS['India'];
};

/**
 * Get browser languages array for a location
 * Mirrors the logic in AutomaticVisitor._addStealthScripts()
 * @param {string} locationName - Location name from LOCATIONS
 * @returns {string[]} Array of language tags, e.g. ['en-IN', 'en', 'hi']
 */
Constants.getLanguagesForLocation = function(locationName) {
    const locationData = this.getLocationCoords(locationName);
    const locale = (locationData && locationData.locale) || 'en-IN';
    const baseLang = locale.split('-')[0];

    const languages = [locale];
    if (!languages.includes(baseLang)) languages.push(baseLang);
    if (locale.endsWith('-IN') && !languages.includes('hi')) languages.push('hi');

    return languages;
};

module.exports = Constants;
