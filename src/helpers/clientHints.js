/**
 * User-Agent Client Hints builder
 *
 * Playwright's `userAgent` context option only rewrites the User-Agent header.
 * It leaves the client hints (`sec-ch-ua`, `sec-ch-ua-mobile`, ...) and
 * `navigator.userAgentData` at Chromium's own values, so GA4 — which prefers
 * client hints over the UA string — reported every session as
 * Device: Desktop / Browser: Mozilla regardless of the UA we generated.
 *
 * This module derives a matching `userAgentMetadata` payload from the UA string
 * so it can be pushed through CDP `Emulation.setUserAgentOverride`.
 */

// GREASE brands Chromium rotates through to keep parsers honest
const GREASE_BRANDS = ['Not/A)Brand', 'Not:A-Brand', 'Not)A;Brand', 'Not=A?Brand', 'Not_A Brand'];
const GREASE_VERSIONS = ['8', '24', '99'];

function getRandomElement(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * Chromium-based? Firefox and Safari send no client hints at all, so we must
 * suppress them rather than spoof them.
 * @param {string} ua
 * @returns {boolean}
 */
function isChromiumUA(ua) {
    return /Chrome\/[\d.]+/.test(ua) && !/Firefox\//.test(ua);
}

/**
 * Derive platform, platformVersion and model from the UA string.
 */
function parsePlatform(ua) {
    let match = ua.match(/Android (\d+(?:\.\d+)*);\s*([^)]+?)\)/);
    if (match) {
        return {
            platform: 'Android',
            platformVersion: `${match[1]}.0.0`.split('.').slice(0, 3).join('.'),
            model: match[2].trim(),
            desktop: false,
        };
    }

    match = ua.match(/Windows NT ([\d.]+)/);
    if (match) {
        // Win10 and Win11 share "Windows NT 10.0" in the UA string, but the
        // client hint splits them: 10.0.0 for Win10, 13+ for Win11.
        return {
            platform: 'Windows',
            platformVersion: Math.random() > 0.4 ? '15.0.0' : '10.0.0',
            model: '',
            desktop: true,
        };
    }

    match = ua.match(/Mac OS X ([\d_]+)/);
    if (match) {
        return {
            platform: 'macOS',
            platformVersion: match[1].replace(/_/g, '.'),
            model: '',
            desktop: true,
        };
    }

    match = ua.match(/iPhone OS ([\d_]+)/);
    if (match) {
        return {
            platform: 'iOS',
            platformVersion: match[1].replace(/_/g, '.'),
            model: 'iPhone',
            desktop: false,
        };
    }

    return { platform: 'Unknown', platformVersion: '', model: '', desktop: true };
}

/**
 * Build brand lists matching the browser the UA claims to be. Chromium exposes
 * three entries — a GREASE brand, "Chromium", and the branded product — in a
 * randomised order.
 */
function buildBrands(ua) {
    const chromeVersion = (ua.match(/Chrome\/([\d.]+)/) || [])[1];
    if (!chromeVersion) return null;
    const major = chromeVersion.split('.')[0];

    const edgeVersion = (ua.match(/Edg\/([\d.]+)/) || [])[1];
    const product = edgeVersion
        ? { brand: 'Microsoft Edge', major: edgeVersion.split('.')[0], full: edgeVersion }
        : { brand: 'Google Chrome', major, full: chromeVersion };

    const grease = { brand: getRandomElement(GREASE_BRANDS), major: getRandomElement(GREASE_VERSIONS) };

    const entries = [
        { brand: grease.brand, major: grease.major, full: `${grease.major}.0.0.0` },
        { brand: 'Chromium', major, full: chromeVersion },
        product,
    ];

    const order = shuffle(entries);
    return {
        brands: order.map(e => ({ brand: e.brand, version: e.major })),
        fullVersionList: order.map(e => ({ brand: e.brand, version: e.full })),
        fullVersion: product.full,
    };
}

/**
 * Build the CDP `userAgentMetadata` payload for a UA string.
 *
 * For non-Chromium UAs every field is emptied, which blanks `sec-ch-ua` and
 * leaves `navigator.userAgentData.brands` empty — closer to real Firefox/Safari
 * than Chromium's own brands, and it pushes GA4 back to parsing the UA string.
 *
 * @param {string} userAgent
 * @returns {{metadata: Object, isChromium: boolean}}
 */
function buildUserAgentMetadata(userAgent) {
    const mobile = /Mobile|Android|iPhone|iPad/.test(userAgent);
    const platformInfo = parsePlatform(userAgent);
    const brandInfo = isChromiumUA(userAgent) ? buildBrands(userAgent) : null;

    if (!brandInfo) {
        return {
            isChromium: false,
            metadata: {
                brands: [],
                fullVersionList: [],
                fullVersion: '',
                platform: '',
                platformVersion: '',
                architecture: '',
                model: '',
                mobile,
                bitness: '',
                wow64: false,
            },
        };
    }

    return {
        isChromium: true,
        metadata: {
            brands: brandInfo.brands,
            fullVersionList: brandInfo.fullVersionList,
            fullVersion: brandInfo.fullVersion,
            platform: platformInfo.platform,
            platformVersion: platformInfo.platformVersion,
            // Chrome reports architecture/bitness on desktop only
            architecture: platformInfo.desktop ? 'x86' : '',
            model: platformInfo.model,
            mobile,
            bitness: platformInfo.desktop ? '64' : '',
            wow64: false,
        },
    };
}

/**
 * Low-entropy client hint headers matching the metadata.
 *
 * The CDP override alone is not enough here: every request passes through a
 * `context.route()` handler, and `route.continue()` rebuilds headers from
 * Playwright's network layer, which knows nothing about userAgentMetadata.
 * Setting them as `extraHTTPHeaders` survives that round-trip.
 *
 * Only the three hints browsers send unprompted are included — the
 * high-entropy ones (model, platformVersion, full version list) are sent only
 * when a server asks via Accept-CH, and gtag reads those from
 * navigator.userAgentData anyway.
 *
 * @param {Object} metadata - from buildUserAgentMetadata()
 * @returns {Object} header name -> value
 */
function buildClientHintHeaders(metadata) {
    const brandList = metadata.brands
        .map(b => `"${b.brand}";v="${b.version}"`)
        .join(', ');
    return {
        'sec-ch-ua': brandList,
        'sec-ch-ua-mobile': metadata.mobile ? '?1' : '?0',
        'sec-ch-ua-platform': `"${metadata.platform}"`,
    };
}

/**
 * Push the UA + client hints override onto a page via CDP. Must be applied per
 * page, so call this for every page the context opens.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Page} page
 * @param {Object} options
 * @param {string} options.userAgent
 * @param {string} [options.acceptLanguage]
 * @param {Object} options.metadata - from buildUserAgentMetadata()
 */
async function applyUserAgentOverride(context, page, { userAgent, acceptLanguage, metadata }) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setUserAgentOverride', {
        userAgent,
        ...(acceptLanguage ? { acceptLanguage } : {}),
        userAgentMetadata: metadata,
    });
}

module.exports = {
    isChromiumUA,
    buildUserAgentMetadata,
    buildClientHintHeaders,
    applyUserAgentOverride,
};
