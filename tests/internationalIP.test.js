/**
 * International IP Generator - Automated Test Suite
 */

const {
    generateInternationalIP,
    generateMultipleInternationalIPs,
    verifyInternationalIP,
    getInternationalIPStats,
    USA_IP_RANGES,
    UK_IP_RANGES,
    EU_IP_RANGES,
    COUNTRY_ISP_WEIGHTS,
} = require('../src/helpers/internationalIP');

// ============================================================
// Data Validation
// ============================================================
describe('IP Range Data', () => {
    test('USA should have at least 15 ranges', () => {
        expect(USA_IP_RANGES.length).toBeGreaterThanOrEqual(15);
    });

    test('UK should have at least 10 ranges', () => {
        expect(UK_IP_RANGES.length).toBeGreaterThanOrEqual(10);
    });

    test('EU should have at least 10 ranges', () => {
        expect(EU_IP_RANGES.length).toBeGreaterThanOrEqual(10);
    });

    test('all ranges should have valid octets', () => {
        [...USA_IP_RANGES, ...UK_IP_RANGES, ...EU_IP_RANGES].forEach(range => {
            expect(range.start).toHaveLength(4);
            expect(range.end).toHaveLength(4);
            range.start.forEach(o => { expect(o).toBeGreaterThanOrEqual(0); expect(o).toBeLessThanOrEqual(255); });
            range.end.forEach(o => { expect(o).toBeGreaterThanOrEqual(0); expect(o).toBeLessThanOrEqual(255); });
        });
    });

    test('USA ISPs should include major providers', () => {
        const isps = new Set(USA_IP_RANGES.map(r => r.isp));
        expect(isps.has('Comcast')).toBe(true);
        expect(isps.has('AT&T')).toBe(true);
        expect(isps.has('Verizon')).toBe(true);
        expect(isps.has('T-Mobile')).toBe(true);
        expect(isps.has('Spectrum')).toBe(true);
    });

    test('UK ISPs should include major providers', () => {
        const isps = new Set(UK_IP_RANGES.map(r => r.isp));
        expect(isps.has('BT')).toBe(true);
        expect(isps.has('Sky')).toBe(true);
        expect(isps.has('Virgin Media')).toBe(true);
    });

    test('EU ranges should have country field', () => {
        EU_IP_RANGES.forEach(r => {
            expect(r.country).toBeTruthy();
        });
    });
});

describe('Country ISP Weights', () => {
    test('each country weights should sum to 100', () => {
        Object.entries(COUNTRY_ISP_WEIGHTS).forEach(([country, weights]) => {
            const total = Object.values(weights).reduce((a, b) => a + b, 0);
            expect(total).toBe(100);
        });
    });
});

// ============================================================
// generateInternationalIP
// ============================================================
describe('generateInternationalIP()', () => {

    test('USA should return valid IP with metadata', () => {
        const result = generateInternationalIP('USA');
        expect(result).not.toBeNull();
        expect(result.ip.split('.')).toHaveLength(4);
        expect(result.isp).toBeTruthy();
        expect(result.country).toBe('USA');
        expect(result.region).toBeTruthy();
        expect(result.timezone).toBeTruthy();
    });

    test('UK should return valid IP', () => {
        const result = generateInternationalIP('UK');
        expect(result).not.toBeNull();
        expect(result.country).toBe('UK');
    });

    test('EU should return valid IP with country', () => {
        const result = generateInternationalIP('EU');
        expect(result).not.toBeNull();
        expect(result.isp).toBeTruthy();
    });

    test('Germany should return Deutsche Telekom or Vodafone DE', () => {
        const result = generateInternationalIP('Germany');
        expect(result).not.toBeNull();
        expect(['Deutsche Telekom', 'Vodafone DE']).toContain(result.isp);
    });

    test('France should return Orange FR or Free FR', () => {
        const result = generateInternationalIP('France');
        expect(result).not.toBeNull();
        expect(['Orange FR', 'Free FR']).toContain(result.isp);
    });

    test('invalid country should return null', () => {
        expect(generateInternationalIP('Mars')).toBeNull();
    });

    test('generated IPs should be valid IPv4', () => {
        for (let i = 0; i < 50; i++) {
            const r = generateInternationalIP('USA');
            r.ip.split('.').forEach(p => {
                const n = parseInt(p);
                expect(n).toBeGreaterThanOrEqual(0);
                expect(n).toBeLessThanOrEqual(255);
            });
        }
    });

    test('USA distribution should favor Comcast/AT&T (statistical)', () => {
        const counts = {};
        for (let i = 0; i < 500; i++) {
            const r = generateInternationalIP('USA');
            counts[r.isp] = (counts[r.isp] || 0) + 1;
        }
        // Comcast should be most common (~30%)
        expect(counts['Comcast']).toBeGreaterThan(80);
    });
});

// ============================================================
// generateMultipleInternationalIPs
// ============================================================
describe('generateMultipleInternationalIPs()', () => {

    test('should generate requested count', () => {
        expect(generateMultipleInternationalIPs(50, 'USA')).toHaveLength(50);
        expect(generateMultipleInternationalIPs(30, 'UK')).toHaveLength(30);
    });

    test('all should be unique', () => {
        const ips = generateMultipleInternationalIPs(100, 'USA');
        expect(new Set(ips).size).toBe(100);
    });
});

// ============================================================
// verifyInternationalIP
// ============================================================
describe('verifyInternationalIP()', () => {

    test('generated USA IP should verify', () => {
        const result = generateInternationalIP('USA');
        const verified = verifyInternationalIP(result.ip);
        expect(verified).not.toBeNull();
    });

    test('Indian IP should not verify', () => {
        expect(verifyInternationalIP('49.35.128.100')).toBeNull();
    });

    test('private IP should not verify', () => {
        expect(verifyInternationalIP('192.168.1.1')).toBeNull();
    });
});

// ============================================================
// getInternationalIPStats
// ============================================================
describe('getInternationalIPStats()', () => {

    test('should return stats for all 3 regions', () => {
        const stats = getInternationalIPStats();
        expect(stats.USA.total).toBeGreaterThan(0);
        expect(stats.UK.total).toBeGreaterThan(0);
        expect(stats.EU.total).toBeGreaterThan(0);
        expect(stats.grandTotal).toBe(stats.USA.total + stats.UK.total + stats.EU.total);
    });

    test('USA should have millions of IPs', () => {
        const stats = getInternationalIPStats();
        expect(stats.USA.total).toBeGreaterThan(1_000_000);
    });
});
