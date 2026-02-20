/**
 * Test script for GA4 Traffic Robo
 * Run with: node src/test.js
 */

const AutomaticVisitor = require('./core/automaticVisitor');
const { Visit } = require('./helpers/visits');
const { getUserAgentList, getMatchingScreenSize } = require('./helpers/userAgents');

async function runTest() {
    console.log('='.repeat(60));
    console.log('GA4 Traffic Robo - Test Script');
    console.log('='.repeat(60));

    // Test configuration
    const testUrl = process.argv[2] || 'https://example.com';
    const useProxy = process.argv[3] === '--proxy';
    const useExtension = process.argv[4] || '';

    console.log(`\nTest URL: ${testUrl}`);
    console.log(`Proxy: ${useProxy ? 'Enabled' : 'Disabled'}`);
    console.log(`Extension: ${useExtension || 'None'}`);

    // Generate test data
    const userAgents = getUserAgentList('Default', 1);
    const userAgent = userAgents[0];
    const screenSize = getMatchingScreenSize(userAgent);

    // Create a non-bounce visit (3 pages, 30 seconds)
    const visit = new Visit(3, 30);

    console.log(`\nVisit Config:`);
    console.log(`  Pages: ${visit.getPagePerSession()}`);
    console.log(`  Duration: ${visit.getAvgSessionDuration()}s`);
    console.log(`  Wait/Page: ${visit.getWaitTimePerPageSec()}s`);
    console.log(`  Is Bounce: ${visit.isBounce()}`);
    console.log(`  User Agent: ${userAgent.substring(0, 60)}...`);
    console.log(`  Screen: ${screenSize.width}x${screenSize.height}`);

    const visitor = new AutomaticVisitor({
        campaignUrl: testUrl,
        referer: '',
        isReferer: false,
        userAgent: userAgent,
        threadId: 1,
        visit: visit,
        screenSize: screenSize,
        isOldUser: false,
        restrictToPrimaryDomain: true,
        previousURL: null,
        playMode: 'Slow',  // Use headed mode for visual testing
        adsBlock: true,
        proxyEnabled: useProxy,
        proxyUrl: useProxy ? 'http://proxy.example.com:8080' : '',
        location: 'Mumbai',
        extensionEnabled: !!useExtension,
        extensionPath: useExtension
    });

    console.log('\nStarting visit...\n');

    try {
        await visitor.execute();
        console.log('\n✅ Test completed successfully!');
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        process.exit(1);
    }
}

runTest().catch(console.error);
