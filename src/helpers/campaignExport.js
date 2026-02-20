/**
 * Campaign Export - CSV and JSON export for campaign results
 *
 * Generates per-visit data export from SessionReplayStore data.
 * Used by main.js IPC handlers to produce downloadable files.
 */

const fs = require('fs');
const path = require('path');

/**
 * Extract city from proxy URL string
 * e.g., "http://user-spubdfwqd5-country-in-city-mumbai:pass@gate.decodo.com:7000" → "mumbai"
 */
function extractProxyCity(proxyUrl) {
    if (!proxyUrl) return '';
    const cityMatch = proxyUrl.match(/city[_-]([a-zA-Z_]+)/i);
    if (cityMatch) return cityMatch[1].replace(/_/g, ' ');
    // Fallback: try to extract host
    try {
        const url = new URL(proxyUrl);
        return url.hostname || '';
    } catch {
        return proxyUrl.substring(0, 30);
    }
}

/**
 * Shorten user agent to browser + device
 * e.g., "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ... Chrome/120.0" → "Chrome/Desktop"
 */
function shortenUA(ua) {
    if (!ua) return 'Unknown';
    const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
    const device = isMobile ? 'Mobile' : 'Desktop';

    if (/Edg\//i.test(ua)) return `Edge/${device}`;
    if (/Firefox\//i.test(ua)) return `Firefox/${device}`;
    if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return `Safari/${device}`;
    if (/Chrome\//i.test(ua)) return `Chrome/${device}`;
    return `Other/${device}`;
}

/**
 * Extract GA4 event types from timeline events
 */
function extractGA4EventTypes(timeline) {
    const types = new Set();
    if (!timeline) return [];
    for (const evt of timeline) {
        if (evt.type === 'ga4_event' && evt.eventType) {
            types.add(evt.eventType);
        }
    }
    return Array.from(types);
}

/**
 * Count GA4 events from timeline
 */
function countGA4Events(timeline) {
    if (!timeline) return 0;
    return timeline.filter(e => e.type === 'ga4_event').length;
}

/**
 * Determine visit status
 */
function getVisitStatus(replay) {
    if (replay.stats.errors > 0) return 'Error';
    if (replay.stats.isBounce) return 'Bounce';
    return 'OK';
}

/**
 * Build per-visit row from a replay summary
 */
function buildVisitRow(replay) {
    const sessionInfo = replay.sessionInfo || {};
    const timeline = replay.timeline || [];
    const ga4Types = extractGA4EventTypes(timeline);
    const proxyCity = extractProxyCity(sessionInfo.proxyUrl || '');

    return {
        visit: replay.threadId,
        url: replay.timeline && replay.timeline.length > 0
            ? (replay.timeline.find(e => e.type === 'visit_start') || {}).url || ''
            : '',
        proxyCity: proxyCity,
        proxyStatus: sessionInfo.proxyMode && sessionInfo.proxyMode !== 'none' ? 'Active' : 'None',
        duration: replay.durationSec,
        pages: replay.stats.pagesVisited,
        bounce: replay.stats.isBounce ? 'Yes' : 'No',
        userAgent: shortenUA(sessionInfo.userAgent),
        screenSize: sessionInfo.screenSize
            ? `${sessionInfo.screenSize.width}x${sessionInfo.screenSize.height}`
            : '',
        location: sessionInfo.location || '',
        ga4EventsCount: replay.stats.ga4EventsFired,
        ga4EventTypes: ga4Types.join('; '),
        startTime: replay.startTime || '',
        endTime: replay.endTime || '',
        status: getVisitStatus(replay),
    };
}

/**
 * Generate CSV string from replay data
 */
function generateCSV(replays) {
    const headers = [
        'Visit#', 'URL', 'ProxyUsed', 'ProxyStatus', 'Duration(s)', 'Pages',
        'BounceOrNot', 'UserAgent', 'ScreenSize', 'Location',
        'GA4EventsCount', 'GA4EventTypes', 'StartTime', 'EndTime', 'Status'
    ];

    const rows = replays.map(replay => {
        const row = buildVisitRow(replay);
        return [
            row.visit,
            csvEscape(row.url),
            csvEscape(row.proxyCity),
            row.proxyStatus,
            row.duration,
            row.pages,
            row.bounce,
            row.userAgent,
            row.screenSize,
            row.location,
            row.ga4EventsCount,
            csvEscape(row.ga4EventTypes),
            row.startTime,
            row.endTime,
            row.status,
        ].join(',');
    });

    return [headers.join(','), ...rows].join('\n');
}

/**
 * Escape a value for CSV (wrap in quotes if needed)
 */
function csvEscape(val) {
    if (val == null) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

/**
 * Generate JSON report from replay data and campaign config
 */
function generateJSON(replays, campaignConfig) {
    const visitRows = replays.map(buildVisitRow);

    // Calculate summary stats
    const completed = replays.length;
    const failed = replays.filter(r => r.stats.errors > 0).length;
    const bounces = replays.filter(r => r.stats.isBounce).length;
    const durations = replays.map(r => r.durationSec);
    const pages = replays.map(r => r.stats.pagesVisited);

    const avgDuration = completed > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / completed)
        : 0;
    const avgPages = completed > 0
        ? parseFloat((pages.reduce((a, b) => a + b, 0) / completed).toFixed(2))
        : 0;
    const bounceRate = completed > 0
        ? parseFloat(((bounces / completed) * 100).toFixed(1))
        : 0;

    // Proxy stats aggregate
    let totalProxied = 0, totalDirect = 0;
    replays.forEach(r => {
        totalProxied += r.stats.proxyRequestsRouted || 0;
        totalDirect += r.stats.directRequests || 0;
    });

    // GA4 stats aggregate
    let totalGA4 = 0;
    const allEventTypes = new Set();
    replays.forEach(r => {
        totalGA4 += r.stats.ga4EventsFired || 0;
        extractGA4EventTypes(r.timeline).forEach(t => allEventTypes.add(t));
    });

    // Duration
    const startTimes = replays.map(r => new Date(r.startTime).getTime()).filter(t => !isNaN(t));
    const endTimes = replays.map(r => new Date(r.endTime).getTime()).filter(t => !isNaN(t));
    const campaignStart = startTimes.length > 0 ? new Date(Math.min(...startTimes)).toISOString() : '';
    const campaignEnd = endTimes.length > 0 ? new Date(Math.max(...endTimes)).toISOString() : '';
    const totalMinutes = startTimes.length > 0 && endTimes.length > 0
        ? parseFloat(((Math.max(...endTimes) - Math.min(...startTimes)) / 60000).toFixed(1))
        : 0;

    return {
        summary: {
            campaignName: (campaignConfig && campaignConfig.campaignName) || '',
            totalVisits: completed + failed,
            completedVisits: completed - failed,
            failedVisits: failed,
            avgDuration,
            avgPages,
            bounceRate,
            proxyStats: {
                totalProxied,
                totalDirect,
                bandwidthSaved: `${totalDirect} direct requests (page loads not proxied)`,
            },
            ga4Stats: {
                totalEvents: totalGA4,
                eventTypes: Array.from(allEventTypes),
            },
            duration: {
                start: campaignStart,
                end: campaignEnd,
                totalMinutes,
            },
        },
        visits: visitRows,
    };
}

/**
 * Get default filename with date/time
 */
function getExportFilename(type) {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const time = now.toTimeString().slice(0, 8).replace(/:/g, '');
    if (type === 'csv') return `campaign_results_${date}_${time}.csv`;
    return `campaign_report_${date}_${time}.json`;
}

module.exports = {
    generateCSV,
    generateJSON,
    getExportFilename,
    extractProxyCity,
    shortenUA,
    buildVisitRow,
};
