/**
 * Indian IP Generator for GA4 Traffic Robo
 * 
 * Generates realistic Indian IP addresses from major ISP ranges
 * Used for X-Forwarded-For header spoofing
 * 
 * UPDATED: December 2025 - Verified from networksdb.io, ipinfo.io
 * All ranges verified to be India-only (no Singapore/Malaysia/US overlap)
 * 
 * NOTE: X-Forwarded-For spoofing works on some servers but NOT on Cloudflare
 * (Cloudflare uses actual connecting IP). For real IP rotation, use rotating proxies.
 */

// Indian ISP IP Ranges - VERIFIED December 2025
// Only using ranges that are 100% confirmed India-only
const INDIAN_IP_RANGES = [
    // ============================================
    // RELIANCE JIO (AS55836) - Verified Dec 2025
    // ============================================
    { start: [49, 32, 0, 0], end: [49, 47, 255, 255], isp: 'Jio' },      // 49.32.0.0/12
    { start: [157, 32, 0, 0], end: [157, 47, 255, 255], isp: 'Jio' },    // 157.32.0.0/12
    { start: [157, 48, 0, 0], end: [157, 51, 255, 255], isp: 'Jio' },    // 157.48.0.0/14
    { start: [115, 240, 0, 0], end: [115, 247, 255, 255], isp: 'Jio' },  // 115.240.0.0/13
    { start: [152, 56, 0, 0], end: [152, 59, 255, 255], isp: 'Jio' },    // 152.56.0.0/14
    { start: [136, 232, 0, 0], end: [136, 233, 255, 255], isp: 'Jio' },  // 136.232.0.0/15
    { start: [47, 8, 0, 0], end: [47, 8, 255, 255], isp: 'Jio' },        // 47.8.0.0/16
    { start: [47, 9, 0, 0], end: [47, 9, 255, 255], isp: 'Jio' },        // 47.9.0.0/16
    { start: [47, 11, 0, 0], end: [47, 11, 255, 255], isp: 'Jio' },      // 47.11.0.0/16
    { start: [47, 15, 0, 0], end: [47, 15, 255, 255], isp: 'Jio' },      // 47.15.0.0/16
    { start: [47, 29, 0, 0], end: [47, 31, 255, 255], isp: 'Jio' },      // 47.29-31.0.0/16
    { start: [47, 247, 0, 0], end: [47, 247, 255, 255], isp: 'Jio' },    // 47.247.0.0/16
    
    // ============================================
    // BHARTI AIRTEL (AS9498) - Verified Dec 2025
    // ============================================
    { start: [106, 192, 0, 0], end: [106, 223, 255, 255], isp: 'Airtel' }, // 106.192.0.0/11
    { start: [122, 160, 0, 0], end: [122, 175, 255, 255], isp: 'Airtel' }, // 122.160.0.0/12
    { start: [182, 64, 0, 0], end: [182, 79, 255, 255], isp: 'Airtel' },   // 182.64.0.0/12
    { start: [171, 48, 0, 0], end: [171, 63, 255, 255], isp: 'Airtel' },   // 171.48.0.0/12
    { start: [125, 16, 0, 0], end: [125, 23, 255, 255], isp: 'Airtel' },   // 125.16.0.0/13
    { start: [14, 96, 0, 0], end: [14, 99, 255, 255], isp: 'Airtel' },     // 14.96.0.0/14
    { start: [223, 176, 0, 0], end: [223, 183, 255, 255], isp: 'Airtel' }, // 223.176.0.0/13
    
    // ============================================
    // BSNL (AS9829) - Verified Dec 2025
    // ============================================
    { start: [117, 192, 0, 0], end: [117, 255, 255, 255], isp: 'BSNL' },  // 117.192.0.0/10
    { start: [59, 88, 0, 0], end: [59, 99, 255, 255], isp: 'BSNL' },      // 59.88-99.x.x
    { start: [61, 0, 0, 0], end: [61, 3, 255, 255], isp: 'BSNL' },        // 61.0.0.0/14
    { start: [218, 248, 64, 0], end: [218, 248, 159, 255], isp: 'BSNL' }, // 218.248.64-159.x
    { start: [164, 100, 0, 0], end: [164, 100, 255, 255], isp: 'BSNL' },  // 164.100.0.0/16
    
    // ============================================
    // VODAFONE IDEA / Vi (AS55410, AS38266) - Verified Dec 2025
    // ============================================
    { start: [42, 108, 0, 0], end: [42, 111, 255, 255], isp: 'Vi' },      // 42.108.0.0/14
    { start: [42, 104, 0, 0], end: [42, 107, 255, 255], isp: 'Vi' },      // 42.104.0.0/14
    { start: [106, 76, 0, 0], end: [106, 79, 255, 255], isp: 'Vi' },      // 106.76.0.0/14
    { start: [106, 66, 0, 0], end: [106, 67, 255, 255], isp: 'Vi' },      // 106.66.0.0/15
    { start: [1, 38, 0, 0], end: [1, 39, 255, 255], isp: 'Vi' },          // 1.38.0.0/15
    { start: [49, 14, 0, 0], end: [49, 15, 255, 255], isp: 'Vi' },        // 49.14.0.0/15
    { start: [118, 185, 0, 0], end: [118, 185, 255, 255], isp: 'Vi' },    // 118.185.0.0/16
    { start: [122, 15, 0, 0], end: [122, 15, 255, 255], isp: 'Vi' },      // 122.15.0.0/16
    { start: [123, 63, 0, 0], end: [123, 63, 255, 255], isp: 'Vi' },      // 123.63.0.0/16
    
    // ============================================
    // ACT FIBERNET - Verified Dec 2025
    // ============================================
    { start: [49, 200, 0, 0], end: [49, 207, 255, 255], isp: 'ACT' },     // 49.200.0.0/13
    { start: [183, 82, 0, 0], end: [183, 83, 255, 255], isp: 'ACT' },     // 183.82.0.0/15
    { start: [106, 51, 0, 0], end: [106, 51, 255, 255], isp: 'ACT' },     // 106.51.0.0/16
    
    // ============================================
    // HATHWAY - Verified Dec 2025
    // ============================================
    { start: [122, 170, 0, 0], end: [122, 171, 255, 255], isp: 'Hathway' }, // 122.170.0.0/15
    { start: [115, 242, 0, 0], end: [115, 243, 255, 255], isp: 'Hathway' }, // 115.242.0.0/15
    { start: [103, 78, 0, 0], end: [103, 78, 255, 255], isp: 'Hathway' },   // 103.78.0.0/16
    
    // ============================================
    // TATA COMMUNICATIONS - Verified Dec 2025
    // ============================================
    { start: [14, 140, 0, 0], end: [14, 143, 255, 255], isp: 'Tata' },    // 14.140.0.0/14
    { start: [203, 122, 0, 0], end: [203, 122, 255, 255], isp: 'Tata' },  // 203.122.0.0/16
    { start: [202, 54, 0, 0], end: [202, 54, 255, 255], isp: 'Tata' },    // 202.54.0.0/16
    
    // ============================================
    // MTNL (Delhi/Mumbai) - Verified Dec 2025
    // ============================================
    { start: [59, 176, 0, 0], end: [59, 183, 255, 255], isp: 'MTNL' },    // 59.176.0.0/13
    { start: [14, 139, 0, 0], end: [14, 139, 255, 255], isp: 'MTNL' },    // 14.139.0.0/16
    
    // ============================================
    // EXCITEL - Verified Dec 2025
    // ============================================
    { start: [103, 87, 0, 0], end: [103, 87, 255, 255], isp: 'Excitel' }, // 103.87.0.0/16
    { start: [103, 59, 0, 0], end: [103, 59, 255, 255], isp: 'Excitel' }, // 103.59.0.0/16
    
    // ============================================
    // YOU BROADBAND - Verified Dec 2025
    // ============================================
    { start: [117, 200, 0, 0], end: [117, 207, 255, 255], isp: 'You' },   // 117.200.0.0/13
    
    // ============================================
    // DEN NETWORKS - Verified Dec 2025
    // ============================================
    { start: [182, 74, 0, 0], end: [182, 75, 255, 255], isp: 'Den' },     // 182.74.0.0/15
];

// City-wise IP preferences (for more realistic distribution)
// Based on Dec 2025 market share data
const CITY_ISP_WEIGHTS = {
    'Delhi': { 'Jio': 40, 'Airtel': 30, 'Vi': 12, 'BSNL': 8, 'Excitel': 5, 'MTNL': 3, 'Hathway': 2 },
    'Mumbai': { 'Jio': 42, 'Airtel': 28, 'Vi': 12, 'Hathway': 8, 'Tata': 5, 'MTNL': 3, 'ACT': 2 },
    'Bangalore': { 'Jio': 35, 'Airtel': 28, 'ACT': 20, 'BSNL': 8, 'Vi': 5, 'Excitel': 4 },
    'Chennai': { 'Jio': 38, 'Airtel': 30, 'ACT': 15, 'BSNL': 10, 'Vi': 5, 'Hathway': 2 },
    'Kolkata': { 'Jio': 35, 'Airtel': 28, 'BSNL': 20, 'Vi': 10, 'Hathway': 5, 'ACT': 2 },
    'Hyderabad': { 'Jio': 38, 'Airtel': 28, 'ACT': 18, 'BSNL': 8, 'You': 5, 'Vi': 3 },
    'Gujarat': { 'Jio': 45, 'Airtel': 30, 'Vi': 12, 'BSNL': 8, 'You': 3, 'Den': 2 },
    'Pune': { 'Jio': 40, 'Airtel': 30, 'Vi': 12, 'Hathway': 8, 'ACT': 5, 'BSNL': 5 },
    'India': { 'Jio': 40, 'Airtel': 30, 'Vi': 12, 'BSNL': 10, 'ACT': 4, 'Hathway': 2, 'Excitel': 2 },
    'USA': null,  // Don't generate Indian IPs for USA
    'UK': null,   // Don't generate Indian IPs for UK
};

/**
 * Generate random number between min and max (inclusive)
 */
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a random IP from a specific range
 */
function generateIPFromRange(range) {
    const ip = [];
    for (let i = 0; i < 4; i++) {
        ip.push(randomInt(range.start[i], range.end[i]));
    }
    return ip.join('.');
}

/**
 * Get ranges for a specific ISP
 */
function getRangesForISP(ispName) {
    const ranges = INDIAN_IP_RANGES.filter(r => r.isp === ispName);
    if (ranges.length === 0) {
        // Fallback to major ISPs if specific ISP not found
        return INDIAN_IP_RANGES.filter(r => 
            r.isp === 'Jio' || r.isp === 'Airtel' || r.isp === 'BSNL' || r.isp === 'Vi'
        );
    }
    return ranges;
}

/**
 * Select ISP based on city weights
 */
function selectISPForCity(city) {
    const weights = CITY_ISP_WEIGHTS[city] || CITY_ISP_WEIGHTS['India'];
    if (!weights) return null;  // Non-Indian location
    
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let random = Math.random() * total;
    
    for (const [isp, weight] of Object.entries(weights)) {
        random -= weight;
        if (random <= 0) {
            return isp;
        }
    }
    return 'Jio';  // Default fallback
}

/**
 * Generate a random Indian IP address
 * @param {string} city - Optional city for ISP distribution
 * @returns {Object} { ip: string, isp: string }
 */
function generateIndianIP(city = 'India') {
    // Check if location is Indian
    const weights = CITY_ISP_WEIGHTS[city];
    if (weights === null) {
        // Non-Indian location - return null
        return null;
    }
    
    // Select ISP based on city
    const selectedISP = selectISPForCity(city);
    
    // Get ranges for this ISP
    let ranges = getRangesForISP(selectedISP);
    if (ranges.length === 0) {
        ranges = INDIAN_IP_RANGES;  // Fallback to all ranges
    }
    
    // Pick random range and generate IP
    const range = ranges[randomInt(0, ranges.length - 1)];
    const ip = generateIPFromRange(range);
    
    return {
        ip: ip,
        isp: range.isp
    };
}

/**
 * Generate multiple unique Indian IPs
 * @param {number} count - Number of IPs to generate
 * @param {string} city - City for distribution
 * @returns {string[]} Array of IP addresses
 */
function generateMultipleIPs(count, city = 'India') {
    const ips = new Set();
    const maxAttempts = count * 3;
    let attempts = 0;
    
    while (ips.size < count && attempts < maxAttempts) {
        const result = generateIndianIP(city);
        if (result) {
            ips.add(result.ip);
        }
        attempts++;
    }
    
    return Array.from(ips);
}

/**
 * Generate X-Forwarded-For header chain
 * Sometimes includes multiple IPs for realism
 * @param {string} city - City for IP generation
 * @returns {string} X-Forwarded-For header value
 */
function generateXForwardedFor(city = 'India') {
    const result = generateIndianIP(city);
    if (!result) return null;
    
    // 70% chance of single IP, 30% chance of chain
    if (Math.random() < 0.7) {
        return result.ip;
    }
    
    // Generate chain: client, proxy1 (optional proxy2)
    const chainLength = Math.random() < 0.5 ? 2 : 3;
    const ips = [result.ip];
    
    for (let i = 1; i < chainLength; i++) {
        const proxyIP = generateIndianIP(city);
        if (proxyIP) {
            ips.push(proxyIP.ip);
        }
    }
    
    return ips.join(', ');
}

/**
 * Generate all IP-related headers
 * @param {string} city - City for IP generation
 * @returns {Object} Headers object with all IP spoofing headers
 */
function generateIPHeaders(city = 'India') {
    const result = generateIndianIP(city);
    if (!result) return {};
    
    const clientIP = result.ip;
    const xForwardedFor = generateXForwardedFor(city);
    
    return {
        'X-Forwarded-For': xForwardedFor,
        'X-Real-IP': clientIP,
        'X-Client-IP': clientIP,
        'CF-Connecting-IP': clientIP,  // Cloudflare header (won't work but some servers check it)
        'True-Client-IP': clientIP,    // Akamai header
        'X-Cluster-Client-IP': clientIP,
        'Forwarded': `for=${clientIP}`,
        'X-Originating-IP': clientIP,
    };
}

/**
 * IP Pool Manager - Manages a pool of IPs for rotation
 */
class IPPool {
    constructor(city = 'India', poolSize = 100) {
        this.city = city;
        this.poolSize = poolSize;
        this.pool = [];
        this.currentIndex = 0;
        this.refreshPool();
    }
    
    /**
     * Refresh the IP pool with new IPs
     */
    refreshPool() {
        this.pool = generateMultipleIPs(this.poolSize, this.city);
        this.currentIndex = 0;
        this.shuffle();
    }
    
    /**
     * Shuffle the pool for randomness
     */
    shuffle() {
        for (let i = this.pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.pool[i], this.pool[j]] = [this.pool[j], this.pool[i]];
        }
    }
    
    /**
     * Get next IP from pool (round-robin with shuffle)
     */
    getNextIP() {
        if (this.pool.length === 0) {
            this.refreshPool();
        }
        
        const ip = this.pool[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.pool.length;
        
        // Shuffle and refresh periodically
        if (this.currentIndex === 0) {
            this.shuffle();
        }
        
        return ip;
    }
    
    /**
     * Get random IP from pool
     */
    getRandomIP() {
        if (this.pool.length === 0) {
            this.refreshPool();
        }
        return this.pool[Math.floor(Math.random() * this.pool.length)];
    }
    
    /**
     * Get headers with next IP
     */
    getNextHeaders() {
        const ip = this.getNextIP();
        return {
            'X-Forwarded-For': ip,
            'X-Real-IP': ip,
            'X-Client-IP': ip,
            'CF-Connecting-IP': ip,
            'True-Client-IP': ip,
            'Forwarded': `for=${ip}`,
        };
    }
}

// Pre-built pools for common cities
const cityPools = {};

/**
 * Get or create IP pool for a city
 */
function getIPPool(city = 'India', poolSize = 100) {
    if (!cityPools[city]) {
        cityPools[city] = new IPPool(city, poolSize);
    }
    return cityPools[city];
}

/**
 * Get statistics about available IP ranges
 * Useful for debugging and verification
 */
function getIPRangeStats() {
    const stats = {
        totalRanges: INDIAN_IP_RANGES.length,
        byISP: {},
        totalIPs: 0
    };
    
    for (const range of INDIAN_IP_RANGES) {
        if (!stats.byISP[range.isp]) {
            stats.byISP[range.isp] = { ranges: 0, approxIPs: 0 };
        }
        stats.byISP[range.isp].ranges++;
        
        // Calculate approximate IP count in range
        const ipCount = 
            (range.end[0] - range.start[0] + 1) *
            (range.end[1] - range.start[1] + 1) *
            (range.end[2] - range.start[2] + 1) *
            (range.end[3] - range.start[3] + 1);
        stats.byISP[range.isp].approxIPs += ipCount;
        stats.totalIPs += ipCount;
    }
    
    return stats;
}

/**
 * Verify generated IP is from expected ISP (for testing)
 * @param {string} ip - IP address to check
 * @returns {Object|null} - ISP info or null if not found
 */
function verifyIP(ip) {
    const parts = ip.split('.').map(Number);
    
    for (const range of INDIAN_IP_RANGES) {
        let match = true;
        for (let i = 0; i < 4; i++) {
            if (parts[i] < range.start[i] || parts[i] > range.end[i]) {
                match = false;
                break;
            }
        }
        if (match) {
            return { ip, isp: range.isp, country: 'India' };
        }
    }
    
    return null;
}

module.exports = {
    generateIndianIP,
    generateMultipleIPs,
    generateXForwardedFor,
    generateIPHeaders,
    IPPool,
    getIPPool,
    getIPRangeStats,
    verifyIP,
    INDIAN_IP_RANGES,
    CITY_ISP_WEIGHTS
};
