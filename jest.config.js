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
    collectCoverageFrom: [
        'src/helpers/**/*.js',
        '!src/helpers/logger.js',
        '!src/helpers/extension-helper.js',
        '!src/helpers/index.js',
    ],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'text-summary', 'lcov'],
    verbose: true,
    testTimeout: 10000,
};
