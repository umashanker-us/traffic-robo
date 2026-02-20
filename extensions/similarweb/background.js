/**
 * SimilarWeb Extension - Background Service Worker
 * Tracks page visits and sends to SimilarWeb servers
 */

// Extension state
let isEnabled = true;
let sessionId = generateSessionId();

// Generate unique session ID
function generateSessionId() {
    return 'sw_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
}

// Generate unique visitor ID (persistent)
async function getVisitorId() {
    const result = await chrome.storage.local.get(['sw_visitor_id']);
    if (result.sw_visitor_id) {
        return result.sw_visitor_id;
    }
    const visitorId = 'swv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
    await chrome.storage.local.set({ sw_visitor_id: visitorId });
    return visitorId;
}

// Track page visit
async function trackPageVisit(tab) {
    if (!isEnabled || !tab.url) return;
    
    try {
        const url = new URL(tab.url);
        
        // Skip chrome:// and extension pages
        if (url.protocol === 'chrome:' || url.protocol === 'chrome-extension:') {
            return;
        }
        
        const visitorId = await getVisitorId();
        
        const trackingData = {
            type: 'page_view',
            url: tab.url,
            title: tab.title || '',
            domain: url.hostname,
            path: url.pathname,
            referrer: '',
            timestamp: Date.now(),
            sessionId: sessionId,
            visitorId: visitorId,
            screenWidth: 1920,
            screenHeight: 1080,
            language: navigator.language || 'en-US',
            platform: navigator.platform || 'Win32',
            userAgent: navigator.userAgent
        };
        
        // Send to SimilarWeb tracking endpoint
        sendTrackingData(trackingData);
        
    } catch (error) {
        // Silently fail
    }
}

// Send tracking data to SimilarWeb
function sendTrackingData(data) {
    // SimilarWeb tracking pixel endpoints
    const endpoints = [
        'https://widgets.similarweb.com/api/visit',
        'https://data.similarweb.com/api/v1/data'
    ];
    
    // Create tracking pixel
    const params = new URLSearchParams({
        d: data.domain,
        u: data.url,
        t: data.title,
        ts: data.timestamp,
        sid: data.sessionId,
        vid: data.visitorId,
        ref: data.referrer,
        sw: data.screenWidth,
        sh: data.screenHeight,
        lang: data.language,
        v: '5.8.2'
    });
    
    // Fire tracking beacons (fire and forget)
    endpoints.forEach(endpoint => {
        try {
            fetch(`${endpoint}?${params.toString()}`, {
                method: 'GET',
                mode: 'no-cors',
                cache: 'no-cache'
            }).catch(() => {});
        } catch (e) {
            // Ignore errors
        }
    });
}

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        trackPageVisit(tab);
    }
});

// Listen for tab activation
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (tab.url) {
            trackPageVisit(tab);
        }
    } catch (e) {
        // Tab might not exist
    }
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PAGE_DATA') {
        // Forward page data for tracking
        trackPageVisit({
            url: message.url,
            title: message.title
        });
    }
    sendResponse({ status: 'ok' });
    return true;
});

// Initialize
console.log('[SimilarWeb] Extension loaded - Session:', sessionId);
