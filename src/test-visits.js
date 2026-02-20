/**
 * Test script for visit distribution algorithm
 * Verifies that the distribution matches expected GA4 metrics
 * 
 * Run with: node src/test-visits.js
 */

const { generateVisitsArray, calculateMetrics, debugVisitDistribution } = require('./helpers/visits');

console.log('='.repeat(60));
console.log('GA4 Traffic Robo - Visit Distribution Test');
console.log('='.repeat(60));

// Test cases with different configurations
const testCases = [
    { avgSessionDuration: 60, bounceRate: 30, pagePerSession: 3 },
    { avgSessionDuration: 120, bounceRate: 50, pagePerSession: 5 },
    { avgSessionDuration: 30, bounceRate: 20, pagePerSession: 2 },
    { avgSessionDuration: 90, bounceRate: 70, pagePerSession: 4 },
    { avgSessionDuration: 45, bounceRate: 10, pagePerSession: 6 },
];

testCases.forEach((testCase, index) => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST CASE ${index + 1}`);
    console.log(`Input: avgSessionDuration=${testCase.avgSessionDuration}s, bounceRate=${testCase.bounceRate}%, pagePerSession=${testCase.pagePerSession}`);
    console.log('='.repeat(60));

    const visits = generateVisitsArray(
        testCase.avgSessionDuration,
        testCase.bounceRate,
        testCase.pagePerSession
    );

    const metrics = debugVisitDistribution(visits);

    // Verify bounce rate matches
    const bounceDiff = Math.abs(metrics.actualBounceRate - testCase.bounceRate);
    if (bounceDiff <= 1) {
        console.log(`✅ Bounce Rate: PASS (expected ${testCase.bounceRate}%, got ${metrics.actualBounceRate}%)`);
    } else {
        console.log(`❌ Bounce Rate: FAIL (expected ${testCase.bounceRate}%, got ${metrics.actualBounceRate}%)`);
    }

    // Verify total visits
    if (visits.length === 100) {
        console.log(`✅ Total Visits: PASS (${visits.length})`);
    } else {
        console.log(`❌ Total Visits: FAIL (expected 100, got ${visits.length})`);
    }

    // Verify bounce visits have 0 duration
    const invalidBounces = visits.filter(v => v.isBounce() && v.getAvgSessionDuration() !== 0);
    if (invalidBounces.length === 0) {
        console.log(`✅ Bounce Duration: PASS (all bounce visits have 0 duration)`);
    } else {
        console.log(`❌ Bounce Duration: FAIL (${invalidBounces.length} bounce visits have non-zero duration)`);
    }
});

console.log(`\n${'='.repeat(60)}`);
console.log('All tests completed!');
console.log('='.repeat(60));
