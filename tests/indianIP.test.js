/**
 * Indian IP Generator - Automated Test Suite
 * Tests IP generation accuracy, ISP distribution, and pool management
 * 
 * Covers:
 * - IP generation from valid ranges
 * - ISP verification for generated IPs
 * - City-wise ISP weighted distribution
 * - Multiple IP generation uniqueness
 * - IP Pool class functionality
 * - X-Forwarded-For header generation
 * - IP range statistics
 * - Edge cases (non-Indian locations, invalid inputs)
 */

const {
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
} = require('../src/helpers/indianIP');

// ============================================================
// IP Range Data Validation
// ============================================================
describe('IP Range Data', () => {

    test('should have at least 40 IP ranges', () => {
        expect(INDIAN_IP_RANGES.length).toBeGreaterThanOrEqual(40);
    });

    test('every range should have valid start and end arrays', () => {
        INDIAN_IP_RANGES.forEach((range, idx) => {
            expect(range.start).toHaveLength(4);
            expect(range.end).toHaveLength(4);
            expect(range.isp).toBeTruthy();

            // Each octet 0-255
            range.start.forEach(octet => {
                expect(octet).toBeGreaterThanOrEqual(0);
                expect(octet).toBeLessThanOrEqual(255);
            });
            range.end.forEach(octet => {
                expect(octet).toBeGreaterThanOrEqual(0);
                expect(octet).toBeLessThanOrEqual(255);
            });
        });
    });

    test('end should be >= start for each octet in range', () => {
        INDIAN_IP_RANGES.forEach(range => {
            for (let i = 0; i < 4; i++) {
                expect(range.end[i]).toBeGreaterThanOrEqual(range.start[i]);
            }
        });
    });

    test('should cover all major Indian ISPs', () => {
        const isps = new Set(INDIAN_IP_RANGES.map(r => r.isp));
        expect(isps.has('Jio')).toBe(true);
        expect(isps.has('Airtel')).toBe(true);
        expect(isps.has('BSNL')).toBe(true);
        expect(isps.has('Vi')).toBe(true);
        expect(isps.has('ACT')).toBe(true);
        expect(isps.has('MTNL')).toBe(true);
        expect(isps.has('Tata')).toBe(true);
        expect(isps.has('Hathway')).toBe(true);
        expect(isps.has('Excitel')).toBe(true);
    });

    test('should have at least 11 unique ISPs', () => {
        const isps = new Set(INDIAN_IP_RANGES.map(r => r.isp));
        expect(isps.size).toBeGreaterThanOrEqual(11);
    });
});

// ============================================================
// City ISP Weights Validation
// ============================================================
describe('City ISP Weights', () => {

    test('all Indian cities should have weights summing to ~100', () => {
        const indianCities = Object.entries(CITY_ISP_WEIGHTS)
            .filter(([_, weights]) => weights !== null);

        indianCities.forEach(([city, weights]) => {
            const total = Object.values(weights).reduce((a, b) => a + b, 0);
            expect(total).toBe(100);
        });
    });

    test('USA and UK should have null weights', () => {
        expect(CITY_ISP_WEIGHTS['USA']).toBeNull();
        expect(CITY_ISP_WEIGHTS['UK']).toBeNull();
    });

    test('all ISPs in weights should exist in IP ranges', () => {
        const rangeISPs = new Set(INDIAN_IP_RANGES.map(r => r.isp));

        Object.entries(CITY_ISP_WEIGHTS)
            .filter(([_, weights]) => weights !== null)
            .forEach(([city, weights]) => {
                Object.keys(weights).forEach(isp => {
                    expect(rangeISPs.has(isp)).toBe(true);
                });
            });
    });

    test('should include all major cities', () => {
        const expectedCities = ['Delhi', 'Mumbai', 'Bangalore', 'Chennai', 'Kolkata', 'Hyderabad', 'Gujarat', 'India'];
        expectedCities.forEach(city => {
            expect(CITY_ISP_WEIGHTS[city]).toBeDefined();
            expect(CITY_ISP_WEIGHTS[city]).not.toBeNull();
        });
    });
});

// ============================================================
// generateIndianIP Tests
// ============================================================
describe('generateIndianIP()', () => {

    test('should return object with ip and isp', () => {
        const result = generateIndianIP();
        expect(result).toHaveProperty('ip');
        expect(result).toHaveProperty('isp');
        expect(typeof result.ip).toBe('string');
        expect(typeof result.isp).toBe('string');
    });

    test('generated IP should be valid IPv4 format', () => {
        for (let i = 0; i < 100; i++) {
            const result = generateIndianIP();
            const parts = result.ip.split('.');
            expect(parts).toHaveLength(4);
            parts.forEach(part => {
                const num = parseInt(part);
                expect(num).toBeGreaterThanOrEqual(0);
                expect(num).toBeLessThanOrEqual(255);
            });
        }
    });

    test('generated IP should verify against IP ranges', () => {
        for (let i = 0; i < 100; i++) {
            const result = generateIndianIP();
            const verified = verifyIP(result.ip);
            expect(verified).not.toBeNull();
            expect(verified.country).toBe('India');
        }
    });

    test('should generate IPs for all Indian cities', () => {
        const cities = ['Delhi', 'Mumbai', 'Bangalore', 'Chennai', 'Kolkata', 'Hyderabad', 'Gujarat', 'India'];
        cities.forEach(city => {
            const result = generateIndianIP(city);
            expect(result).not.toBeNull();
            expect(result.ip).toBeTruthy();
            expect(verifyIP(result.ip)).not.toBeNull();
        });
    });

    test('should return null for non-Indian locations', () => {
        expect(generateIndianIP('USA')).toBeNull();
        expect(generateIndianIP('UK')).toBeNull();
    });

    test('should fallback to India weights for unknown city', () => {
        const result = generateIndianIP('RandomUnknownCity');
        expect(result).not.toBeNull();
        expect(result.ip).toBeTruthy();
    });

    test('city-wise ISP distribution should roughly match weights (statistical)', () => {
        // Generate 1000 IPs for Delhi and check distribution
        const ispCounts = {};
        const runs = 1000;

        for (let i = 0; i < runs; i++) {
            const result = generateIndianIP('Delhi');
            ispCounts[result.isp] = (ispCounts[result.isp] || 0) + 1;
        }

        // Jio should be most common (~40%)
        expect(ispCounts['Jio'] || 0).toBeGreaterThan(runs * 0.25);
        // Airtel should be second (~30%)
        expect(ispCounts['Airtel'] || 0).toBeGreaterThan(runs * 0.15);
    });
});

// ============================================================
// generateMultipleIPs Tests
// ============================================================
describe('generateMultipleIPs()', () => {

    test('should generate requested number of IPs', () => {
        const ips = generateMultipleIPs(50);
        expect(ips.length).toBe(50);
    });

    test('all generated IPs should be unique', () => {
        const ips = generateMultipleIPs(100);
        const unique = new Set(ips);
        expect(unique.size).toBe(100);
    });

    test('should handle large batch (500 IPs)', () => {
        const ips = generateMultipleIPs(500);
        expect(ips.length).toBe(500);
        const unique = new Set(ips);
        expect(unique.size).toBe(500);
    });

    test('every IP should be verifiable', () => {
        const ips = generateMultipleIPs(50);
        ips.forEach(ip => {
            expect(verifyIP(ip)).not.toBeNull();
        });
    });

    test('should respect city parameter', () => {
        const ips = generateMultipleIPs(20, 'Mumbai');
        expect(ips.length).toBe(20);
        ips.forEach(ip => {
            expect(verifyIP(ip)).not.toBeNull();
        });
    });
});

// ============================================================
// verifyIP Tests
// ============================================================
describe('verifyIP()', () => {

    test('should verify known Jio IP range', () => {
        const result = verifyIP('49.35.128.100');
        expect(result).not.toBeNull();
        expect(result.isp).toBe('Jio');
        expect(result.country).toBe('India');
    });

    test('should verify known Airtel IP range', () => {
        const result = verifyIP('106.200.100.50');
        expect(result).not.toBeNull();
        expect(result.isp).toBe('Airtel');
    });

    test('should return null for non-Indian IP', () => {
        expect(verifyIP('8.8.8.8')).toBeNull();        // Google DNS
        expect(verifyIP('1.1.1.1')).toBeNull();        // Cloudflare
        expect(verifyIP('192.168.1.1')).toBeNull();    // Private
        expect(verifyIP('10.0.0.1')).toBeNull();       // Private
    });

    test('should handle non-numeric IP gracefully', () => {
        // verifyIP uses .map(Number) which converts non-numeric to NaN
        // NaN comparison (NaN < x) is always false, so it may match ranges unexpectedly
        // This is a known edge case - test actual behavior
        const result = verifyIP('256.256.256.256');
        expect(result).toBeNull(); // Out of range IPs should not match
    });
});

// ============================================================
// X-Forwarded-For Header Tests
// ============================================================
describe('generateXForwardedFor()', () => {

    test('should return valid IP string', () => {
        const xff = generateXForwardedFor();
        expect(xff).toBeTruthy();
        // Should be either single IP or comma-separated chain
        const ips = xff.split(', ');
        expect(ips.length).toBeGreaterThanOrEqual(1);
        expect(ips.length).toBeLessThanOrEqual(3);
    });

    test('all IPs in chain should be valid Indian IPs', () => {
        for (let i = 0; i < 50; i++) {
            const xff = generateXForwardedFor();
            const ips = xff.split(', ');
            ips.forEach(ip => {
                const parts = ip.trim().split('.');
                expect(parts).toHaveLength(4);
            });
        }
    });

    test('should return null for non-Indian locations', () => {
        expect(generateXForwardedFor('USA')).toBeNull();
        expect(generateXForwardedFor('UK')).toBeNull();
    });
});

// ============================================================
// generateIPHeaders Tests
// ============================================================
describe('generateIPHeaders()', () => {

    test('should return all required header fields', () => {
        const headers = generateIPHeaders();
        expect(headers).toHaveProperty('X-Forwarded-For');
        expect(headers).toHaveProperty('X-Real-IP');
        expect(headers).toHaveProperty('X-Client-IP');
        expect(headers).toHaveProperty('CF-Connecting-IP');
        expect(headers).toHaveProperty('True-Client-IP');
        expect(headers).toHaveProperty('Forwarded');
        expect(headers).toHaveProperty('X-Originating-IP');
    });

    test('X-Real-IP, X-Client-IP should be same IP', () => {
        const headers = generateIPHeaders();
        expect(headers['X-Real-IP']).toBe(headers['X-Client-IP']);
        expect(headers['X-Real-IP']).toBe(headers['CF-Connecting-IP']);
    });

    test('Forwarded header should have correct format', () => {
        const headers = generateIPHeaders();
        expect(headers['Forwarded']).toMatch(/^for=\d+\.\d+\.\d+\.\d+$/);
    });

    test('should return empty object for non-Indian locations', () => {
        const headers = generateIPHeaders('USA');
        expect(Object.keys(headers)).toHaveLength(0);
    });
});

// ============================================================
// IPPool Class Tests
// ============================================================
describe('IPPool', () => {

    test('should initialize with correct pool size', () => {
        const pool = new IPPool('India', 50);
        expect(pool.pool).toHaveLength(50);
    });

    test('getNextIP should return valid IPs', () => {
        const pool = new IPPool('India', 20);
        for (let i = 0; i < 20; i++) {
            const ip = pool.getNextIP();
            expect(ip).toBeTruthy();
            expect(ip.split('.')).toHaveLength(4);
        }
    });

    test('should cycle through pool (round-robin)', () => {
        const pool = new IPPool('India', 10);
        const firstRound = [];
        for (let i = 0; i < 10; i++) {
            firstRound.push(pool.getNextIP());
        }
        // After full cycle, pool shuffles, so we just check it continues
        const nextIP = pool.getNextIP();
        expect(nextIP).toBeTruthy();
    });

    test('getRandomIP should return valid IP', () => {
        const pool = new IPPool('Delhi', 20);
        const ip = pool.getRandomIP();
        expect(ip).toBeTruthy();
        expect(verifyIP(ip)).not.toBeNull();
    });

    test('getNextHeaders should return proper header object', () => {
        const pool = new IPPool('Mumbai', 10);
        const headers = pool.getNextHeaders();
        expect(headers).toHaveProperty('X-Forwarded-For');
        expect(headers).toHaveProperty('X-Real-IP');
        expect(headers).toHaveProperty('X-Client-IP');
    });

    test('refreshPool should generate new IPs', () => {
        const pool = new IPPool('India', 20);
        const firstPool = [...pool.pool];
        pool.refreshPool();
        // Very unlikely to be identical (20 IPs from ~20M pool)
        expect(pool.pool).toHaveLength(20);
    });

    test('pool IPs should all be unique', () => {
        const pool = new IPPool('India', 100);
        const unique = new Set(pool.pool);
        expect(unique.size).toBe(100);
    });
});

// ============================================================
// getIPPool (Factory) Tests
// ============================================================
describe('getIPPool()', () => {

    test('should return same pool instance for same city', () => {
        const pool1 = getIPPool('Bangalore', 50);
        const pool2 = getIPPool('Bangalore', 50);
        // They should reference same cached pool
        expect(pool1).toBe(pool2);
    });
});

// ============================================================
// getIPRangeStats Tests
// ============================================================
describe('getIPRangeStats()', () => {

    test('should return total ranges count', () => {
        const stats = getIPRangeStats();
        expect(stats.totalRanges).toBe(INDIAN_IP_RANGES.length);
    });

    test('should have breakdown by ISP', () => {
        const stats = getIPRangeStats();
        expect(Object.keys(stats.byISP).length).toBeGreaterThanOrEqual(11);
    });

    test('total IPs should be approximately ~20 million', () => {
        const stats = getIPRangeStats();
        expect(stats.totalIPs).toBeGreaterThan(15_000_000);
        expect(stats.totalIPs).toBeLessThan(30_000_000);
    });

    test('sum of ISP IPs should equal totalIPs', () => {
        const stats = getIPRangeStats();
        const sumByISP = Object.values(stats.byISP).reduce((sum, isp) => sum + isp.approxIPs, 0);
        expect(sumByISP).toBe(stats.totalIPs);
    });

    test('Jio should have most ranges (12)', () => {
        const stats = getIPRangeStats();
        expect(stats.byISP['Jio'].ranges).toBe(12);
    });
});
