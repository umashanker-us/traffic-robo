/**
 * Visit Configuration Class for GA4 Traffic Robo
 * EXACT MATCH to Java FetchLogics.java getVisitsArray() logic
 * 
 * CRITICAL: This file controls GA4 metrics accuracy
 * - Bounce Rate: % of visits with pagePerSession=1 and avgSessionDuration=0
 * - Avg Session Duration: Total time spent on site per session
 * - Pages Per Session: Number of pages visited per session
 * 
 * FIXED: Replaced console.log with logger
 */

const { getLogger } = require('./logger');
const logger = getLogger();

class Visit {
    /**
     * @param {number} pagePerSession - Number of pages to visit in this session
     * @param {number} avgSessionDuration - Total session duration in SECONDS (not ms)
     */
    constructor(pagePerSession, avgSessionDuration) {
        this.pagePerSession = parseInt(pagePerSession) || 1;
        this.avgSessionDuration = parseInt(avgSessionDuration) || 0; // in SECONDS
    }

    getPagePerSession() {
        return this.pagePerSession;
    }

    setPagePerSession(value) {
        this.pagePerSession = parseInt(value) || 1;
    }

    getAvgSessionDuration() {
        return this.avgSessionDuration;
    }

    setAvgSessionDuration(value) {
        this.avgSessionDuration = parseInt(value) || 0;
    }

    /**
     * Get wait time PER PAGE in MILLISECONDS
     * Formula: (avgSessionDuration * 1000) / pagePerSession
     * This matches Java: Thread.sleep(1000 * avgSessionDuration / pagePerSession)
     * 
     * CRITICAL: For bounce visits (avgSessionDuration=0), returns 0
     */
    getWaitTimePerPageMs() {
        if (this.pagePerSession <= 0) return 0;
        if (this.avgSessionDuration <= 0) return 0; // Bounce visits don't wait
        return Math.floor((this.avgSessionDuration * 1000) / this.pagePerSession);
    }

    /**
     * Get wait time per page in SECONDS (for logging)
     */
    getWaitTimePerPageSec() {
        if (this.pagePerSession <= 0) return 0;
        if (this.avgSessionDuration <= 0) return 0;
        return Math.floor(this.avgSessionDuration / this.pagePerSession);
    }

    /**
     * Check if this is a bounce visit
     * Bounce = 1 page view with 0 session duration
     */
    isBounce() {
        return this.pagePerSession === 1 && this.avgSessionDuration === 0;
    }

    /**
     * Get number of ADDITIONAL pages to visit after the first page
     */
    getAdditionalPages() {
        return Math.max(0, this.pagePerSession - 1);
    }

    toString() {
        return `Visit{pages=${this.pagePerSession}, duration=${this.avgSessionDuration}s, waitPerPage=${this.getWaitTimePerPageSec()}s, bounce=${this.isBounce()}}`;
    }
}

/**
 * Generate visits array based on GA4 metrics
 * EXACT MATCH to Java FetchLogics.java getVisitsArray()
 * 
 * @param {number} avgSessionDuration - Average session duration in SECONDS
 * @param {number} bounceRate - Bounce rate percentage (1-90)
 * @param {number} pagePerSession - Average pages per session (float)
 * @returns {Visit[]} Array of exactly 100 Visit objects
 * 
 * Java Source Reference:
 * int n6 = (int) Math.floor((float) (100 - bounceRate) / (3.0f + pagePerSession));
 * int n7 = (int) Math.floor((float) (100 - bounceRate) / (4.0f + pagePerSession));
 * int n8 = (int) Math.floor((float) (100 - bounceRate) / (5.0f + pagePerSession));
 * int n9 = 100 - bounceRate - n6 - n7 - n8;
 * 
 * Distribution:
 * - bounceRate visits: 1 page, 0 duration (BOUNCE - no wait)
 * - n6 visits: 2 pages, avgSessionDuration/4 duration
 * - n7 visits: 3 pages, avgSessionDuration/2 duration
 * - n8 visits: 4 pages, avgSessionDuration duration
 * - n9 visits: variable pages (5 to 4*pagePerSession-5), extended duration
 */
function generateVisitsArray(avgSessionDuration, bounceRate, pagePerSession) {
    const visits = [];
    
    // Parse and validate inputs
    avgSessionDuration = parseInt(avgSessionDuration) || 60;
    bounceRate = parseInt(bounceRate) || 30;
    pagePerSession = parseFloat(pagePerSession) || 3.0;
    
    // Clamp bounce rate to valid range
    if (bounceRate < 1) bounceRate = 1;
    if (bounceRate > 90) bounceRate = 90;
    
    // Calculate distribution - EXACT match to Java logic
    const nonBounce = 100 - bounceRate;
    const n6 = Math.floor(nonBounce / (3.0 + pagePerSession));  // 2-page visits
    const n7 = Math.floor(nonBounce / (4.0 + pagePerSession));  // 3-page visits
    const n8 = Math.floor(nonBounce / (5.0 + pagePerSession));  // 4-page visits
    const n9 = nonBounce - n6 - n7 - n8;                         // Variable page visits

    logger.debug(`[Visits] Distribution: bounceRate=${bounceRate}, n6(2pg)=${n6}, n7(3pg)=${n7}, n8(4pg)=${n8}, n9(var)=${n9}`);

    // 1. Add BOUNCE visits (pagePerSession=1, avgSessionDuration=0)
    // Java: arrayList.add(new Visits(1, 0));
    // CRITICAL: Bounce visits have 0 duration - user leaves immediately
    for (let i = 0; i < bounceRate; i++) {
        visits.push(new Visit(1, 0));
    }

    // 2. Add 2-page visits (duration = avgSessionDuration/4)
    // Java: arrayList.add(new Visits(2, avgSessionDuration / 4));
    for (let i = 0; i < n6; i++) {
        const duration = Math.floor(avgSessionDuration / 4);
        visits.push(new Visit(2, duration));
    }

    // 3. Add 3-page visits (duration = avgSessionDuration/2)
    // Java: arrayList.add(new Visits(3, avgSessionDuration / 2));
    for (let i = 0; i < n7; i++) {
        const duration = Math.floor(avgSessionDuration / 2);
        visits.push(new Visit(3, duration));
    }

    // 4. Add 4-page visits (duration = avgSessionDuration)
    // Java: arrayList.add(new Visits(4, avgSessionDuration));
    for (let i = 0; i < n8; i++) {
        visits.push(new Visit(4, avgSessionDuration));
    }

    // 5. Add variable page visits
    // Java: 
    // Double d2 = Math.floor(Math.random() * (double) (4.0f * pagePerSession - 10.0f) + 5.0);
    // if (d2 < 2.0) { d2 = 1.0; }  // Note: Java uses 1.0, but we use 2 to avoid false bounces
    // duration = Math.floor(1.5 * avgSessionDuration / (1.0f - bounceRate/100.0f))
    for (let i = 0; i < n9; i++) {
        // Calculate pages: random value from formula
        // Range: 5 to (4*pagePerSession - 5) approximately
        let pages = Math.floor(Math.random() * (4.0 * pagePerSession - 10.0) + 5.0);
        
        // Minimum 2 pages to ensure this is NOT counted as bounce
        if (pages < 2) {
            pages = 2;
        }
        
        // Calculate extended duration for engaged users
        // Java: 1.5 * avgSessionDuration / (1.0f - bounceRate/100.0f)
        const bounceRatio = 1.0 - (bounceRate / 100.0);
        const duration = Math.floor((1.5 * avgSessionDuration) / bounceRatio);
        
        visits.push(new Visit(pages, duration));
    }

    // Ensure we have exactly 100 visits
    while (visits.length < 100) {
        // Add bounce visits to fill (shouldn't happen normally)
        visits.push(new Visit(1, 0));
        logger.warn(`[Visits] Warning: Padding with bounce visit, count=${visits.length}`);
    }

    // Truncate if somehow we have more than 100
    if (visits.length > 100) {
        visits.length = 100;
    }

    return visits;
}

/**
 * Calculate actual metrics from visits array for verification
 * Use this to verify the distribution matches expected GA4 values
 * 
 * @param {Visit[]} visits - Array of visits
 * @returns {Object} Calculated metrics
 */
function calculateMetrics(visits) {
    if (!visits || visits.length === 0) {
        return {
            totalVisits: 0,
            totalPages: 0,
            totalDuration: 0,
            bounceCount: 0,
            actualBounceRate: 0,
            avgSessionDuration: 0,
            avgPagePerSession: 0
        };
    }

    let totalPages = 0;
    let totalDuration = 0;
    let bounceCount = 0;
    let nonBounceDuration = 0;
    let nonBounceCount = 0;

    visits.forEach(visit => {
        totalPages += visit.getPagePerSession();
        totalDuration += visit.getAvgSessionDuration();
        
        if (visit.isBounce()) {
            bounceCount++;
        } else {
            nonBounceDuration += visit.getAvgSessionDuration();
            nonBounceCount++;
        }
    });

    const totalVisits = visits.length;
    
    return {
        totalVisits,
        totalPages,
        totalDuration,
        bounceCount,
        nonBounceCount,
        actualBounceRate: Math.round((bounceCount / totalVisits) * 100),
        // Avg session duration is calculated only for non-bounce visits in GA4
        avgSessionDuration: nonBounceCount > 0 ? Math.round(nonBounceDuration / nonBounceCount) : 0,
        avgPagePerSession: parseFloat((totalPages / totalVisits).toFixed(2))
    };
}

/**
 * Shuffle array using Fisher-Yates algorithm
 * @param {Array} array - Array to shuffle
 * @returns {Array} New shuffled array (does not modify original)
 */
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

/**
 * Debug function to print visit distribution
 * Call this to verify the distribution is correct
 */
function debugVisitDistribution(visits) {
    const distribution = {
        'bounce (1pg/0s)': 0,
        '2-page': 0,
        '3-page': 0,
        '4-page': 0,
        '5+ page': 0
    };
    
    let sampleVisits = [];
    
    visits.forEach((visit, idx) => {
        if (visit.isBounce()) {
            distribution['bounce (1pg/0s)']++;
        } else if (visit.getPagePerSession() === 2) {
            distribution['2-page']++;
        } else if (visit.getPagePerSession() === 3) {
            distribution['3-page']++;
        } else if (visit.getPagePerSession() === 4) {
            distribution['4-page']++;
        } else {
            distribution['5+ page']++;
        }
        
        // Collect sample visits
        if (idx < 3 || (idx >= 30 && idx < 33) || idx >= 97) {
            sampleVisits.push(`  [${idx}] ${visit.toString()}`);
        }
    });
    
    logger.info('========== VISIT DISTRIBUTION ==========');
    logger.info(`Total visits: ${visits.length}`);
    logger.info('Distribution:');
    Object.entries(distribution).forEach(([key, count]) => {
        const pct = ((count / visits.length) * 100).toFixed(1);
        logger.info(`  ${key}: ${count} (${pct}%)`);
    });
    
    const metrics = calculateMetrics(visits);
    logger.info('Calculated Metrics (what GA4 will see):');
    logger.info(`  Bounce Rate: ${metrics.actualBounceRate}%`);
    logger.info(`  Avg Session Duration: ${metrics.avgSessionDuration}s (non-bounce only)`);
    logger.info(`  Avg Pages/Session: ${metrics.avgPagePerSession}`);
    
    logger.info('Sample Visits:');
    sampleVisits.forEach(s => logger.info(s));
    logger.info('==========================================');
    
    return metrics;
}

module.exports = {
    Visit,
    generateVisitsArray,
    calculateMetrics,
    shuffleArray,
    debugVisitDistribution
};
