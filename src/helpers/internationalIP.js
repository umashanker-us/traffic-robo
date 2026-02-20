/**
 * International IP Generator for GA4 Traffic Robo v2.4
 * 
 * MEDIUM PRIORITY: Adds USA, UK, and EU IP ranges for international traffic simulation
 * Works alongside indianIP.js for non-Indian location support
 * 
 * IP ranges sourced from major ISPs per country (verified Feb 2025)
 * Uses X-Forwarded-For header spoofing (same limitation: won't work on Cloudflare)
 * 
 * Usage:
 *   const { generateInternationalIP } = require('./internationalIP');
 *   const result = generateInternationalIP('USA');
 *   // { ip: '72.134.56.78', isp: 'Comcast', country: 'USA' }
 */

const { getLogger } = require('./logger');
const logger = getLogger();

// ============================================================
// USA IP Ranges - Major ISPs (verified from ARIN, ipinfo.io)
// ============================================================
const USA_IP_RANGES = [
    // --- Comcast (AS7922) - Largest cable ISP ---
    { start: [24, 0, 0, 0], end: [24, 31, 255, 255], isp: 'Comcast' },
    { start: [50, 128, 0, 0], end: [50, 191, 255, 255], isp: 'Comcast' },
    { start: [69, 136, 0, 0], end: [69, 143, 255, 255], isp: 'Comcast' },
    { start: [73, 0, 0, 0], end: [73, 63, 255, 255], isp: 'Comcast' },
    { start: [98, 192, 0, 0], end: [98, 255, 255, 255], isp: 'Comcast' },

    // --- AT&T (AS7018) ---
    { start: [12, 0, 0, 0], end: [12, 31, 255, 255], isp: 'AT&T' },
    { start: [32, 128, 0, 0], end: [32, 191, 255, 255], isp: 'AT&T' },
    { start: [107, 64, 0, 0], end: [107, 95, 255, 255], isp: 'AT&T' },
    { start: [166, 128, 0, 0], end: [166, 191, 255, 255], isp: 'AT&T' },

    // --- Verizon (AS701, AS22394) ---
    { start: [71, 96, 0, 0], end: [71, 127, 255, 255], isp: 'Verizon' },
    { start: [72, 64, 0, 0], end: [72, 95, 255, 255], isp: 'Verizon' },
    { start: [174, 192, 0, 0], end: [174, 255, 255, 255], isp: 'Verizon' },

    // --- T-Mobile (AS21928) ---
    { start: [172, 56, 0, 0], end: [172, 63, 255, 255], isp: 'T-Mobile' },
    { start: [76, 64, 0, 0], end: [76, 95, 255, 255], isp: 'T-Mobile' },

    // --- Spectrum / Charter (AS20115) ---
    { start: [24, 160, 0, 0], end: [24, 191, 255, 255], isp: 'Spectrum' },
    { start: [66, 56, 0, 0], end: [66, 63, 255, 255], isp: 'Spectrum' },
    { start: [97, 64, 0, 0], end: [97, 95, 255, 255], isp: 'Spectrum' },

    // --- Cox (AS22773) ---
    { start: [68, 96, 0, 0], end: [68, 111, 255, 255], isp: 'Cox' },
    { start: [70, 176, 0, 0], end: [70, 191, 255, 255], isp: 'Cox' },
];

// ============================================================
// UK IP Ranges - Major ISPs (verified from RIPE, ipinfo.io)
// ============================================================
const UK_IP_RANGES = [
    // --- BT (AS2856) ---
    { start: [2, 24, 0, 0], end: [2, 31, 255, 255], isp: 'BT' },
    { start: [81, 128, 0, 0], end: [81, 191, 255, 255], isp: 'BT' },
    { start: [86, 0, 0, 0], end: [86, 31, 255, 255], isp: 'BT' },
    { start: [109, 144, 0, 0], end: [109, 159, 255, 255], isp: 'BT' },

    // --- Sky Broadband (AS5607) ---
    { start: [90, 192, 0, 0], end: [90, 223, 255, 255], isp: 'Sky' },
    { start: [151, 224, 0, 0], end: [151, 255, 255, 255], isp: 'Sky' },

    // --- Virgin Media (AS5089) ---
    { start: [82, 0, 0, 0], end: [82, 31, 255, 255], isp: 'Virgin Media' },
    { start: [86, 128, 0, 0], end: [86, 159, 255, 255], isp: 'Virgin Media' },
    { start: [92, 224, 0, 0], end: [92, 255, 255, 255], isp: 'Virgin Media' },

    // --- Vodafone UK (AS1273) ---
    { start: [176, 24, 0, 0], end: [176, 31, 255, 255], isp: 'Vodafone UK' },
    { start: [92, 0, 0, 0], end: [92, 31, 255, 255], isp: 'Vodafone UK' },

    // --- TalkTalk (AS13285) ---
    { start: [62, 24, 0, 0], end: [62, 31, 255, 255], isp: 'TalkTalk' },
    { start: [92, 32, 0, 0], end: [92, 47, 255, 255], isp: 'TalkTalk' },

    // --- EE (AS12576) ---
    { start: [2, 96, 0, 0], end: [2, 103, 255, 255], isp: 'EE' },
];

// ============================================================
// EU IP Ranges - Major ISPs per country
// ============================================================
const EU_IP_RANGES = [
    // --- Germany: Deutsche Telekom (AS3320) ---
    { start: [80, 128, 0, 0], end: [80, 191, 255, 255], isp: 'Deutsche Telekom', country: 'Germany' },
    { start: [91, 0, 0, 0], end: [91, 31, 255, 255], isp: 'Deutsche Telekom', country: 'Germany' },
    { start: [2, 160, 0, 0], end: [2, 175, 255, 255], isp: 'Deutsche Telekom', country: 'Germany' },

    // --- Germany: Vodafone DE (AS3209) ---
    { start: [77, 0, 0, 0], end: [77, 15, 255, 255], isp: 'Vodafone DE', country: 'Germany' },
    { start: [178, 24, 0, 0], end: [178, 31, 255, 255], isp: 'Vodafone DE', country: 'Germany' },

    // --- France: Orange (AS3215) ---
    { start: [80, 0, 0, 0], end: [80, 15, 255, 255], isp: 'Orange FR', country: 'France' },
    { start: [90, 0, 0, 0], end: [90, 31, 255, 255], isp: 'Orange FR', country: 'France' },
    { start: [176, 128, 0, 0], end: [176, 159, 255, 255], isp: 'Orange FR', country: 'France' },

    // --- France: Free / Iliad (AS12322) ---
    { start: [78, 192, 0, 0], end: [78, 255, 255, 255], isp: 'Free FR', country: 'France' },
    { start: [82, 64, 0, 0], end: [82, 95, 255, 255], isp: 'Free FR', country: 'France' },

    // --- Spain: Movistar / Telefonica (AS3352) ---
    { start: [83, 32, 0, 0], end: [83, 63, 255, 255], isp: 'Movistar', country: 'Spain' },
    { start: [176, 80, 0, 0], end: [176, 95, 255, 255], isp: 'Movistar', country: 'Spain' },

    // --- Italy: TIM (AS3269) ---
    { start: [79, 0, 0, 0], end: [79, 63, 255, 255], isp: 'TIM IT', country: 'Italy' },
    { start: [151, 0, 0, 0], end: [151, 31, 255, 255], isp: 'TIM IT', country: 'Italy' },

    // --- Netherlands: KPN (AS1136) ---
    { start: [83, 64, 0, 0], end: [83, 95, 255, 255], isp: 'KPN', country: 'Netherlands' },
    { start: [145, 48, 0, 0], end: [145, 63, 255, 255], isp: 'KPN', country: 'Netherlands' },
];

// ============================================================
// Country ISP Weights (market share %)
// ============================================================
const COUNTRY_ISP_WEIGHTS = {
    'USA': { 'Comcast': 30, 'AT&T': 22, 'Verizon': 15, 'T-Mobile': 12, 'Spectrum': 13, 'Cox': 8 },
    'UK': { 'BT': 28, 'Sky': 24, 'Virgin Media': 18, 'Vodafone UK': 12, 'TalkTalk': 10, 'EE': 8 },
    'Germany': { 'Deutsche Telekom': 55, 'Vodafone DE': 45 },
    'France': { 'Orange FR': 55, 'Free FR': 45 },
    'Spain': { 'Movistar': 100 },
    'Italy': { 'TIM IT': 100 },
    'Netherlands': { 'KPN': 100 },
    'EU': { 'Deutsche Telekom': 20, 'Vodafone DE': 10, 'Orange FR': 18, 'Free FR': 12, 'Movistar': 15, 'TIM IT': 15, 'KPN': 10 },
};

// ============================================================
// Location -> City/State mapping for timezone realism
// ============================================================
const US_REGIONS = [
    { name: 'New York', timezone: 'America/New_York', lat: 40.7128, lng: -74.0060 },
    { name: 'Los Angeles', timezone: 'America/Los_Angeles', lat: 34.0522, lng: -118.2437 },
    { name: 'Chicago', timezone: 'America/Chicago', lat: 41.8781, lng: -87.6298 },
    { name: 'Houston', timezone: 'America/Chicago', lat: 29.7604, lng: -95.3698 },
    { name: 'Phoenix', timezone: 'America/Phoenix', lat: 33.4484, lng: -112.0740 },
    { name: 'Philadelphia', timezone: 'America/New_York', lat: 39.9526, lng: -75.1652 },
    { name: 'San Francisco', timezone: 'America/Los_Angeles', lat: 37.7749, lng: -122.4194 },
    { name: 'Dallas', timezone: 'America/Chicago', lat: 32.7767, lng: -96.7970 },
    { name: 'Miami', timezone: 'America/New_York', lat: 25.7617, lng: -80.1918 },
    { name: 'Seattle', timezone: 'America/Los_Angeles', lat: 47.6062, lng: -122.3321 },
];

const UK_REGIONS = [
    { name: 'London', timezone: 'Europe/London', lat: 51.5074, lng: -0.1278 },
    { name: 'Manchester', timezone: 'Europe/London', lat: 53.4808, lng: -2.2426 },
    { name: 'Birmingham', timezone: 'Europe/London', lat: 52.4862, lng: -1.8904 },
    { name: 'Edinburgh', timezone: 'Europe/London', lat: 55.9533, lng: -3.1883 },
];

const EU_REGIONS = [
    { name: 'Berlin', timezone: 'Europe/Berlin', lat: 52.5200, lng: 13.4050 },
    { name: 'Paris', timezone: 'Europe/Paris', lat: 48.8566, lng: 2.3522 },
    { name: 'Madrid', timezone: 'Europe/Madrid', lat: 40.4168, lng: -3.7038 },
    { name: 'Rome', timezone: 'Europe/Rome', lat: 41.9028, lng: 12.4964 },
    { name: 'Amsterdam', timezone: 'Europe/Amsterdam', lat: 52.3676, lng: 4.9041 },
    { name: 'Munich', timezone: 'Europe/Berlin', lat: 48.1351, lng: 11.5820 },
];

// ============================================================
// Core Functions
// ============================================================

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomElement(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function generateIPFromRange(range) {
    const ip = [];
    for (let i = 0; i < 4; i++) {
        ip.push(randomInt(range.start[i], range.end[i]));
    }
    return ip.join('.');
}

/**
 * Select ISP based on country weights
 */
function selectISP(country) {
    const weights = COUNTRY_ISP_WEIGHTS[country];
    if (!weights) return null;

    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let random = Math.random() * total;

    for (const [isp, weight] of Object.entries(weights)) {
        random -= weight;
        if (random <= 0) return isp;
    }
    return Object.keys(weights)[0];
}

/**
 * Get IP ranges for a country
 */
function getRangesForCountry(country) {
    switch (country) {
        case 'USA': return USA_IP_RANGES;
        case 'UK': return UK_IP_RANGES;
        case 'Germany':
        case 'France':
        case 'Spain':
        case 'Italy':
        case 'Netherlands':
            return EU_IP_RANGES.filter(r => r.country === country);
        case 'EU':
            return EU_IP_RANGES;
        default:
            return [];
    }
}

/**
 * Generate random international IP
 * @param {string} country - 'USA', 'UK', 'Germany', 'France', 'Spain', 'Italy', 'Netherlands', 'EU'
 * @returns {Object|null} { ip, isp, country, region }
 */
function generateInternationalIP(country = 'USA') {
    const ranges = getRangesForCountry(country);
    if (ranges.length === 0) return null;

    const selectedISP = selectISP(country);
    let filteredRanges = ranges.filter(r => r.isp === selectedISP);
    if (filteredRanges.length === 0) filteredRanges = ranges;

    const range = getRandomElement(filteredRanges);
    const ip = generateIPFromRange(range);

    // Get random region for metadata
    let region;
    switch (country) {
        case 'USA': region = getRandomElement(US_REGIONS); break;
        case 'UK': region = getRandomElement(UK_REGIONS); break;
        default: region = getRandomElement(EU_REGIONS); break;
    }

    return {
        ip,
        isp: range.isp,
        country: range.country || country,
        region: region.name,
        timezone: region.timezone,
        latitude: region.lat,
        longitude: region.lng,
    };
}

/**
 * Generate multiple unique international IPs
 */
function generateMultipleInternationalIPs(count, country = 'USA') {
    const ips = new Set();
    const maxAttempts = count * 3;
    let attempts = 0;

    while (ips.size < count && attempts < maxAttempts) {
        const result = generateInternationalIP(country);
        if (result) ips.add(result.ip);
        attempts++;
    }
    return Array.from(ips);
}

/**
 * Verify IP belongs to a known international range
 */
function verifyInternationalIP(ip) {
    const parts = ip.split('.').map(Number);
    const allRanges = [...USA_IP_RANGES, ...UK_IP_RANGES, ...EU_IP_RANGES];

    for (const range of allRanges) {
        let match = true;
        for (let i = 0; i < 4; i++) {
            if (parts[i] < range.start[i] || parts[i] > range.end[i]) {
                match = false;
                break;
            }
        }
        if (match) {
            return { ip, isp: range.isp, country: range.country || 'USA' };
        }
    }
    return null;
}

/**
 * Get stats for international IP ranges
 */
function getInternationalIPStats() {
    const stats = { USA: {}, UK: {}, EU: {} };

    const calcIPs = (ranges) => {
        let total = 0;
        const byISP = {};
        for (const range of ranges) {
            const count = (range.end[0] - range.start[0] + 1) *
                (range.end[1] - range.start[1] + 1) *
                (range.end[2] - range.start[2] + 1) *
                (range.end[3] - range.start[3] + 1);
            total += count;
            const key = range.isp;
            byISP[key] = (byISP[key] || 0) + count;
        }
        return { total, byISP, ranges: ranges.length };
    };

    stats.USA = calcIPs(USA_IP_RANGES);
    stats.UK = calcIPs(UK_IP_RANGES);
    stats.EU = calcIPs(EU_IP_RANGES);
    stats.grandTotal = stats.USA.total + stats.UK.total + stats.EU.total;

    return stats;
}

module.exports = {
    generateInternationalIP,
    generateMultipleInternationalIPs,
    verifyInternationalIP,
    getInternationalIPStats,
    USA_IP_RANGES,
    UK_IP_RANGES,
    EU_IP_RANGES,
    COUNTRY_ISP_WEIGHTS,
    US_REGIONS,
    UK_REGIONS,
    EU_REGIONS,
};
