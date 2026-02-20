/**
 * Traffic Source Helper - Simulates all GA4 traffic source types
 *
 * GA4 determines traffic source from:
 *   1) UTM parameters appended to the URL
 *   2) Referrer URL (document.referrer)
 *   3) Google Click ID (gclid)
 *
 * This module resolves a traffic source config into { referer, isReferer, campaignUrl }
 * that the AutomaticVisitor can use directly.
 */

const SEARCH_ENGINES = {
    Google: 'https://www.google.com/search?q=',
    Bing: 'https://www.bing.com/search?q=',
    Yahoo: 'https://search.yahoo.com/search?p=',
    DuckDuckGo: 'https://duckduckgo.com/?q=',
};

const SOCIAL_URLS = {
    Facebook: 'https://l.facebook.com/',
    'Twitter/X': 'https://t.co/',
    LinkedIn: 'https://www.linkedin.com/feed',
    Instagram: 'https://l.instagram.com/',
    YouTube: 'https://www.youtube.com/',
};

/**
 * Build a realistic search engine referrer URL
 * @param {string} engine - Search engine name (Google, Bing, Yahoo, DuckDuckGo)
 * @param {string} keyword - Search keyword
 * @returns {string} Full search URL
 */
function getSearchReferrerUrl(engine, keyword) {
    const base = SEARCH_ENGINES[engine] || SEARCH_ENGINES.Google;
    return base + encodeURIComponent(keyword || '');
}

/**
 * Get the referrer URL for a social media platform
 * @param {string} platform - Platform name (Facebook, Twitter/X, LinkedIn, Instagram, YouTube)
 * @returns {string} Social referrer URL
 */
function getSocialReferrerUrl(platform) {
    return SOCIAL_URLS[platform] || SOCIAL_URLS.Facebook;
}

/**
 * Append UTM parameters to a campaign URL
 * @param {string} baseUrl - Original campaign URL
 * @param {Object} params - UTM parameter values
 * @returns {string} URL with UTM params appended
 */
function buildUTMUrl(baseUrl, params) {
    try {
        const url = new URL(baseUrl);
        if (params.utm_source) url.searchParams.set('utm_source', params.utm_source);
        if (params.utm_medium) url.searchParams.set('utm_medium', params.utm_medium);
        if (params.utm_campaign) url.searchParams.set('utm_campaign', params.utm_campaign);
        if (params.utm_term) url.searchParams.set('utm_term', params.utm_term);
        if (params.utm_content) url.searchParams.set('utm_content', params.utm_content);
        return url.toString();
    } catch (e) {
        // If URL parsing fails, append manually
        const sep = baseUrl.includes('?') ? '&' : '?';
        const parts = [];
        if (params.utm_source) parts.push(`utm_source=${encodeURIComponent(params.utm_source)}`);
        if (params.utm_medium) parts.push(`utm_medium=${encodeURIComponent(params.utm_medium)}`);
        if (params.utm_campaign) parts.push(`utm_campaign=${encodeURIComponent(params.utm_campaign)}`);
        if (params.utm_term) parts.push(`utm_term=${encodeURIComponent(params.utm_term)}`);
        if (params.utm_content) parts.push(`utm_content=${encodeURIComponent(params.utm_content)}`);
        return parts.length > 0 ? baseUrl + sep + parts.join('&') : baseUrl;
    }
}

/**
 * Resolve traffic source config into visitor parameters for a single visit.
 * Called once per visit to determine the referer URL and (possibly modified) campaign URL.
 *
 * @param {Object} config - Traffic source settings from UI
 * @param {string} campaignUrl - Original campaign URL for this visit
 * @returns {{ referer: string, isReferer: boolean, campaignUrl: string }}
 */
function resolveTrafficSource(config, campaignUrl) {
    const type = config.trafficSourceType || 'Direct';

    switch (type) {
        case 'Organic Search': {
            const keywords = (config.searchKeywords || '')
                .split('\n').map(k => k.trim()).filter(k => k);
            const keyword = keywords.length > 0
                ? keywords[Math.floor(Math.random() * keywords.length)]
                : '';
            const engine = config.searchEngine || 'Google';
            return {
                referer: getSearchReferrerUrl(engine, keyword),
                isReferer: true,
                campaignUrl,
            };
        }

        case 'Referral': {
            const urls = (config.referralUrls || '')
                .split('\n').map(u => u.trim()).filter(u => u);
            const url = urls.length > 0
                ? urls[Math.floor(Math.random() * urls.length)]
                : '';
            return {
                referer: url,
                isReferer: !!url,
                campaignUrl,
            };
        }

        case 'Social': {
            const platforms = Array.isArray(config.socialPlatforms) && config.socialPlatforms.length > 0
                ? config.socialPlatforms
                : ['Facebook'];
            const platform = platforms[Math.floor(Math.random() * platforms.length)];
            return {
                referer: getSocialReferrerUrl(platform),
                isReferer: true,
                campaignUrl,
            };
        }

        case 'UTM Campaign': {
            return {
                referer: '',
                isReferer: false,
                campaignUrl: buildUTMUrl(campaignUrl, {
                    utm_source: config.utmSource || '',
                    utm_medium: config.utmMedium || '',
                    utm_campaign: config.utmCampaign || '',
                    utm_term: config.utmTerm || '',
                    utm_content: config.utmContent || '',
                }),
            };
        }

        case 'Mixed': {
            const rand = Math.random() * 100;
            const direct = parseInt(config.mixedDirect) || 0;
            const organic = parseInt(config.mixedOrganic) || 0;
            const referral = parseInt(config.mixedReferral) || 0;
            // social = remainder

            if (rand < direct) {
                return { referer: '', isReferer: false, campaignUrl };
            } else if (rand < direct + organic) {
                return resolveTrafficSource({
                    trafficSourceType: 'Organic Search',
                    searchEngine: config.searchEngine,
                    searchKeywords: config.searchKeywords,
                }, campaignUrl);
            } else if (rand < direct + organic + referral) {
                return resolveTrafficSource({
                    trafficSourceType: 'Referral',
                    referralUrls: config.referralUrls,
                }, campaignUrl);
            } else {
                return resolveTrafficSource({
                    trafficSourceType: 'Social',
                    socialPlatforms: config.socialPlatforms,
                }, campaignUrl);
            }
        }

        case 'Direct':
        default:
            return {
                referer: '',
                isReferer: false,
                campaignUrl,
            };
    }
}

module.exports = {
    resolveTrafficSource,
    getSearchReferrerUrl,
    getSocialReferrerUrl,
    buildUTMUrl,
    SEARCH_ENGINES,
    SOCIAL_URLS,
};
