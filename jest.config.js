/**
 * Jest Configuration for GA4 Traffic Robo v2.4
 * 
 * Run all tests:     npx jest
 * Run specific:      npx jest tests/visits.test.js
 * Run with coverage: npx jest --coverage
 * Watch mode:        npx jest --watch
 */

module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    // tests/acceptance.js is deliberately not matched: it drives real browsers
    // against live sites and is run with `npm run test:e2e`.
    collectCoverageFrom: [
        'src/helpers/**/*.js',
        'src/core/**/*.js',
        '!src/helpers/logger.js',
    ],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'text-summary', 'lcov'],
    verbose: true,
    testTimeout: 10000,
};
