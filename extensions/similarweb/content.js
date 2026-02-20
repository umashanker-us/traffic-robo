/**
 * SimilarWeb Extension - Content Script
 * Runs on all web pages to collect data
 */

(function() {
    'use strict';
    
    // Prevent multiple injections
    if (window.__similarweb_injected) return;
    window.__similarweb_injected = true;
    
    // SimilarWeb markers (makes it detectable)
    window.__sw_extension = true;
    window.__sw_version = '5.8.2';
    
    // Collect page data
    function collectPageData() {
        return {
            url: window.location.href,
            title: document.title,
            domain: window.location.hostname,
            path: window.location.pathname,
            referrer: document.referrer,
            timestamp: Date.now(),
            scrollDepth: 0,
            timeOnPage: 0,
            clicks: 0
        };
    }
    
    // Track scroll depth
    let maxScrollDepth = 0;
    let pageLoadTime = Date.now();
    let clickCount = 0;
    
    // Scroll tracking
    window.addEventListener('scroll', function() {
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const docHeight = Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight
        ) - window.innerHeight;
        
        if (docHeight > 0) {
            const scrollPercent = Math.round((scrollTop / docHeight) * 100);
            maxScrollDepth = Math.max(maxScrollDepth, scrollPercent);
        }
    }, { passive: true });
    
    // Click tracking
    document.addEventListener('click', function() {
        clickCount++;
    }, { passive: true });
    
    // Send page data to background
    function sendPageData() {
        try {
            chrome.runtime.sendMessage({
                type: 'PAGE_DATA',
                url: window.location.href,
                title: document.title,
                domain: window.location.hostname,
                referrer: document.referrer,
                scrollDepth: maxScrollDepth,
                timeOnPage: Math.round((Date.now() - pageLoadTime) / 1000),
                clicks: clickCount
            });
        } catch (e) {
            // Extension context may be invalid
        }
    }
    
    // Send data on page load
    if (document.readyState === 'complete') {
        setTimeout(sendPageData, 1000);
    } else {
        window.addEventListener('load', function() {
            setTimeout(sendPageData, 1000);
        });
    }
    
    // Send data before leaving page
    window.addEventListener('beforeunload', function() {
        sendPageData();
    });
    
    // Inject SimilarWeb tracking pixel (visible to the website)
    function injectTrackingPixel() {
        try {
            const domain = window.location.hostname;
            const pixel = document.createElement('img');
            pixel.src = `https://widgets.similarweb.com/api/pixel?d=${encodeURIComponent(domain)}&ts=${Date.now()}`;
            pixel.width = 1;
            pixel.height = 1;
            pixel.style.position = 'absolute';
            pixel.style.left = '-9999px';
            pixel.alt = '';
            document.body.appendChild(pixel);
        } catch (e) {
            // Ignore errors
        }
    }
    
    // Inject after DOM ready
    if (document.body) {
        injectTrackingPixel();
    } else {
        document.addEventListener('DOMContentLoaded', injectTrackingPixel);
    }
    
    // Add SimilarWeb data attribute (for detection)
    document.documentElement.setAttribute('data-similarweb', 'true');
    
    console.log('[SimilarWeb] Content script loaded on:', window.location.hostname);
})();
