/**
 * Visit Distribution Engine - Automated Test Suite
 * Tests the core visit generation algorithm that drives GA4 metrics accuracy
 * 
 * Covers:
 * - Visit class methods
 * - Distribution algorithm (Java FetchLogics.java port accuracy)
 * - Bounce rate accuracy
 * - Session duration calculations
 * - Pages per session distribution
 * - Edge cases & boundary values
 * - Shuffle randomization
 */

const { Visit, generateVisitsArray, calculateMetrics, shuffleArray, debugVisitDistribution } = require('../src/helpers/visits');

// ============================================================
// Visit Class Unit Tests
// ============================================================
describe('Visit Class', () => {
    
    test('should create visit with correct properties', () => {
        const visit = new Visit(3, 60);
        expect(visit.getPagePerSession()).toBe(3);
        expect(visit.getAvgSessionDuration()).toBe(60);
    });

    test('should calculate wait time per page correctly', () => {
        const visit = new Visit(3, 60);
        // 60s / 3 pages = 20s = 20000ms
        expect(visit.getWaitTimePerPageMs()).toBe(20000);
        expect(visit.getWaitTimePerPageSec()).toBe(20);
    });

    test('should handle single page visit wait time', () => {
        const visit = new Visit(1, 30);
        expect(visit.getWaitTimePerPageMs()).toBe(30000);
        expect(visit.getWaitTimePerPageSec()).toBe(30);
    });

    test('should identify bounce visits correctly', () => {
        const bounce = new Visit(1, 0);
        expect(bounce.isBounce()).toBe(true);

        const nonBounce1 = new Visit(2, 30);
        expect(nonBounce1.isBounce()).toBe(false);

        const nonBounce2 = new Visit(1, 10);
        expect(nonBounce2.isBounce()).toBe(false);
    });

    test('bounce visit should have 0 wait time', () => {
        const bounce = new Visit(1, 0);
        expect(bounce.getWaitTimePerPageMs()).toBe(0);
        expect(bounce.getWaitTimePerPageSec()).toBe(0);
    });

    test('should calculate additional pages correctly', () => {
        expect(new Visit(1, 0).getAdditionalPages()).toBe(0);
        expect(new Visit(2, 30).getAdditionalPages()).toBe(1);
        expect(new Visit(5, 120).getAdditionalPages()).toBe(4);
    });

    test('should handle 0 pagePerSession edge case', () => {
        const visit = new Visit(0, 60);
        // 0 pages parsed as NaN -> defaults to 1 via parseInt
        // getWaitTimePerPageMs: pagePerSession=1, so 60000/1 = 60000
        // This is expected behavior since NaN -> 1 fallback
        expect(visit.getPagePerSession()).toBe(1);
        expect(visit.getAdditionalPages()).toBe(0);
    });

    test('should handle string inputs via parseInt', () => {
        const visit = new Visit('3', '60');
        expect(visit.getPagePerSession()).toBe(3);
        expect(visit.getAvgSessionDuration()).toBe(60);
    });

    test('should handle invalid inputs gracefully', () => {
        const visit = new Visit(null, undefined);
        expect(visit.getPagePerSession()).toBe(1);
        expect(visit.getAvgSessionDuration()).toBe(0);
        expect(visit.isBounce()).toBe(true);
    });

    test('toString should return readable format', () => {
        const visit = new Visit(3, 60);
        const str = visit.toString();
        expect(str).toContain('pages=3');
        expect(str).toContain('duration=60');
        expect(str).toContain('bounce=false');
    });

    test('setter methods should work', () => {
        const visit = new Visit(1, 0);
        visit.setPagePerSession(5);
        visit.setAvgSessionDuration(120);
        expect(visit.getPagePerSession()).toBe(5);
        expect(visit.getAvgSessionDuration()).toBe(120);
    });
});

// ============================================================
// Visit Distribution Algorithm Tests
// ============================================================
describe('generateVisitsArray()', () => {

    test('should always return exactly 100 visits', () => {
        const configs = [
            { dur: 60, bounce: 30, pps: 3 },
            { dur: 120, bounce: 50, pps: 5 },
            { dur: 30, bounce: 10, pps: 2 },
            { dur: 90, bounce: 80, pps: 4 },
            { dur: 45, bounce: 1, pps: 6 },
        ];

        configs.forEach(({ dur, bounce, pps }) => {
            const visits = generateVisitsArray(dur, bounce, pps);
            expect(visits).toHaveLength(100);
        });
    });

    test('bounce rate should match input exactly', () => {
        const testCases = [10, 20, 30, 40, 50, 60, 70, 80, 90];

        testCases.forEach(targetBounce => {
            const visits = generateVisitsArray(60, targetBounce, 3);
            const metrics = calculateMetrics(visits);
            expect(metrics.actualBounceRate).toBe(targetBounce);
        });
    });

    test('bounce visits must have pagePerSession=1 and duration=0', () => {
        const visits = generateVisitsArray(60, 30, 3);
        const bounceVisits = visits.filter(v => v.isBounce());

        bounceVisits.forEach(visit => {
            expect(visit.getPagePerSession()).toBe(1);
            expect(visit.getAvgSessionDuration()).toBe(0);
            expect(visit.getWaitTimePerPageMs()).toBe(0);
        });
    });

    test('non-bounce visits should never have 0 duration', () => {
        const visits = generateVisitsArray(60, 30, 3);
        const nonBounce = visits.filter(v => !v.isBounce());

        nonBounce.forEach(visit => {
            expect(visit.getAvgSessionDuration()).toBeGreaterThan(0);
            expect(visit.getPagePerSession()).toBeGreaterThanOrEqual(2);
        });
    });

    test('non-bounce visits should have pages >= 2 (no false bounces)', () => {
        // Run multiple times due to randomness in n9 visits
        for (let run = 0; run < 10; run++) {
            const visits = generateVisitsArray(60, 30, 3);
            const nonBounce = visits.filter(v => !v.isBounce());

            nonBounce.forEach(visit => {
                expect(visit.getPagePerSession()).toBeGreaterThanOrEqual(2);
            });
        }
    });

    test('distribution should match Java formula for n6/n7/n8/n9', () => {
        const avgSessionDuration = 60;
        const bounceRate = 30;
        const pagePerSession = 3;

        const nonBounce = 100 - bounceRate; // 70
        const expectedN6 = Math.floor(nonBounce / (3.0 + pagePerSession)); // floor(70/6) = 11
        const expectedN7 = Math.floor(nonBounce / (4.0 + pagePerSession)); // floor(70/7) = 10
        const expectedN8 = Math.floor(nonBounce / (5.0 + pagePerSession)); // floor(70/8) = 8
        const expectedN9 = nonBounce - expectedN6 - expectedN7 - expectedN8; // 70-11-10-8 = 41

        const visits = generateVisitsArray(avgSessionDuration, bounceRate, pagePerSession);

        let bounceCount = 0, n6 = 0, n7 = 0, n8 = 0, n9 = 0;
        visits.forEach(v => {
            if (v.isBounce()) bounceCount++;
            else if (v.getPagePerSession() === 2) n6++;
            else if (v.getPagePerSession() === 3) n7++;
            else if (v.getPagePerSession() === 4) n8++;
            else n9++;
        });

        expect(bounceCount).toBe(bounceRate);
        expect(n6).toBe(expectedN6);
        expect(n7).toBe(expectedN7);
        expect(n8).toBe(expectedN8);
        expect(n9).toBe(expectedN9);
    });

    test('session duration for 2-page visits should be avgDuration/4', () => {
        const visits = generateVisitsArray(60, 30, 3);
        const twoPageVisits = visits.filter(v => v.getPagePerSession() === 2 && !v.isBounce());
        
        twoPageVisits.forEach(visit => {
            expect(visit.getAvgSessionDuration()).toBe(Math.floor(60 / 4));
        });
    });

    test('session duration for 3-page visits should be avgDuration/2', () => {
        const visits = generateVisitsArray(60, 30, 3);
        const threePageVisits = visits.filter(v => v.getPagePerSession() === 3);
        
        threePageVisits.forEach(visit => {
            expect(visit.getAvgSessionDuration()).toBe(Math.floor(60 / 2));
        });
    });

    test('session duration for 4-page visits should be full avgDuration', () => {
        const visits = generateVisitsArray(60, 30, 3);
        const fourPageVisits = visits.filter(v => v.getPagePerSession() === 4);
        
        fourPageVisits.forEach(visit => {
            expect(visit.getAvgSessionDuration()).toBe(60);
        });
    });

    // Edge cases
    test('should handle minimum bounce rate (1%)', () => {
        const visits = generateVisitsArray(60, 1, 3);
        expect(visits).toHaveLength(100);
        const metrics = calculateMetrics(visits);
        expect(metrics.actualBounceRate).toBe(1);
    });

    test('should handle maximum bounce rate (90%)', () => {
        const visits = generateVisitsArray(60, 90, 3);
        expect(visits).toHaveLength(100);
        const metrics = calculateMetrics(visits);
        expect(metrics.actualBounceRate).toBe(90);
    });

    test('should handle 0 bounce rate input (defaults to 30 via parseInt fallback)', () => {
        const visits = generateVisitsArray(60, 0, 3);
        expect(visits).toHaveLength(100);
        // 0 is falsy so parseInt(0) || 30 -> 30 (default behavior)
        const metrics = calculateMetrics(visits);
        expect(metrics.actualBounceRate).toBe(30);
    });

    test('should clamp bounce rate above 90 to 90', () => {
        const visits = generateVisitsArray(60, 95, 3);
        expect(visits).toHaveLength(100);
        const metrics = calculateMetrics(visits);
        expect(metrics.actualBounceRate).toBe(90);
    });

    test('should handle minimum session duration (0)', () => {
        const visits = generateVisitsArray(0, 30, 3);
        expect(visits).toHaveLength(100);
    });

    test('should handle high pages per session', () => {
        const visits = generateVisitsArray(120, 20, 10);
        expect(visits).toHaveLength(100);
        const metrics = calculateMetrics(visits);
        expect(metrics.actualBounceRate).toBe(20);
    });

    test('should handle float pagePerSession', () => {
        const visits = generateVisitsArray(60, 30, 3.5);
        expect(visits).toHaveLength(100);
    });
});

// ============================================================
// calculateMetrics Tests
// ============================================================
describe('calculateMetrics()', () => {

    test('should calculate correct metrics', () => {
        const visits = generateVisitsArray(60, 30, 3);
        const metrics = calculateMetrics(visits);

        expect(metrics.totalVisits).toBe(100);
        expect(metrics.bounceCount).toBe(30);
        expect(metrics.nonBounceCount).toBe(70);
        expect(metrics.actualBounceRate).toBe(30);
        expect(metrics.totalPages).toBeGreaterThan(100); // At least 1 page per visit
        expect(metrics.avgPagePerSession).toBeGreaterThan(1);
        expect(metrics.avgSessionDuration).toBeGreaterThan(0);
    });

    test('should handle empty visits array', () => {
        const metrics = calculateMetrics([]);
        expect(metrics.totalVisits).toBe(0);
        expect(metrics.totalPages).toBe(0);
        expect(metrics.actualBounceRate).toBe(0);
        expect(metrics.avgSessionDuration).toBe(0);
    });

    test('should handle null input', () => {
        const metrics = calculateMetrics(null);
        expect(metrics.totalVisits).toBe(0);
    });

    test('avg session duration should exclude bounce visits', () => {
        const visits = [
            new Visit(1, 0),  // bounce
            new Visit(1, 0),  // bounce
            new Visit(3, 60), // non-bounce: 60s
            new Visit(2, 30), // non-bounce: 30s
        ];
        const metrics = calculateMetrics(visits);
        expect(metrics.avgSessionDuration).toBe(45); // (60+30)/2
    });
});

// ============================================================
// shuffleArray Tests
// ============================================================
describe('shuffleArray()', () => {

    test('should not modify original array', () => {
        const original = [1, 2, 3, 4, 5];
        const copy = [...original];
        shuffleArray(original);
        expect(original).toEqual(copy);
    });

    test('should return array of same length', () => {
        const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const shuffled = shuffleArray(arr);
        expect(shuffled).toHaveLength(arr.length);
    });

    test('should contain all original elements', () => {
        const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const shuffled = shuffleArray(arr);
        expect(shuffled.sort()).toEqual(arr.sort());
    });

    test('should produce different orderings (probabilistic)', () => {
        const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const results = new Set();
        
        for (let i = 0; i < 20; i++) {
            results.add(shuffleArray(arr).join(','));
        }
        
        // With 10 elements, we should get many different orderings
        expect(results.size).toBeGreaterThan(5);
    });

    test('should handle empty array', () => {
        expect(shuffleArray([])).toEqual([]);
    });

    test('should handle single element', () => {
        expect(shuffleArray([42])).toEqual([42]);
    });
});
