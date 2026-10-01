/**
 * IP rotation dispatcher
 *
 * The location dropdown offers Indian cities plus USA, UK and Random, but the
 * visitors only ever called generateIndianIP(), which returns null for any
 * non-Indian location — so IP rotation silently did nothing for USA and UK.
 * internationalIP.js already covered those countries and was wired to nothing.
 *
 * This module is the single entry point: hand it the configured location, get
 * back an IP for it or null when the location has no ranges at all.
 */

const Constants = require('./constants');
const { generateIndianIP, CITY_ISP_WEIGHTS } = require('./indianIP');
const { generateInternationalIP, COUNTRY_ISP_WEIGHTS } = require('./internationalIP');

/**
 * Locations that resolve to Indian IP ranges, taken from the generator's own
 * weight table so the two can never disagree.
 */
function isIndianLocation(location) {
    return Object.prototype.hasOwnProperty.call(CITY_ISP_WEIGHTS, location)
        && CITY_ISP_WEIGHTS[location] !== null;
}

/**
 * Locations that resolve to international ranges.
 */
function isInternationalLocation(location) {
    return Object.prototype.hasOwnProperty.call(COUNTRY_ISP_WEIGHTS, location);
}

/**
 * Every location IP rotation can actually serve.
 * @returns {string[]}
 */
function getSupportedLocations() {
    const indian = Object.keys(CITY_ISP_WEIGHTS).filter(k => CITY_ISP_WEIGHTS[k] !== null);
    const international = Object.keys(COUNTRY_ISP_WEIGHTS);
    return [...new Set([...indian, ...international])];
}

/**
 * Generate a spoofable IP for a configured location.
 *
 * @param {string} location - as chosen in the UI (e.g. 'Mumbai', 'USA', 'Random')
 * @returns {{ip: string, isp: string, country: string, location: string}|null}
 *   null when the location has no ranges, which is the caller's signal to skip
 *   the X-Forwarded-For header entirely rather than send a wrong one.
 */
function generateIPForLocation(location) {
    let target = location || Constants.LOCATIONS.INDIA;

    if (target === 'Random') {
        const supported = getSupportedLocations();
        if (supported.length === 0) return null;
        target = supported[Math.floor(Math.random() * supported.length)];
    }

    if (isIndianLocation(target)) {
        const result = generateIndianIP(target);
        if (!result) return null;
        return { ip: result.ip, isp: result.isp, country: 'India', location: target };
    }

    if (isInternationalLocation(target)) {
        const result = generateInternationalIP(target);
        if (!result) return null;
        return {
            ip: result.ip,
            isp: result.isp,
            country: result.country || target,
            location: result.region ? `${result.region}, ${target}` : target,
        };
    }

    return null;
}

module.exports = {
    generateIPForLocation,
    getSupportedLocations,
    isIndianLocation,
    isInternationalLocation,
};
