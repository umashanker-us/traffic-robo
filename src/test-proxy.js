/**
 * Test script for proxy routing functionality
 * Verifies GA request detection and proxy URL parsing
 * 
 * Run with: node src/test-proxy.js
 */

const { ProxyRouter, isGARequest, parseProxyString, buildProxyUrl } = require('./helpers/proxyRouter');

console.log('='.repeat(60));
console.log('GA4 Traffic Robo - Proxy Routing Test');
console.log('='.repeat(60));

// Test GA Request Detection
console.log('\n📌 Testing GA Request Detection:\n');

const testUrls = [
    // Should be detected as GA
    { url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-XXXXX', expected: true },
    { url: 'https://www.google-analytics.com/analytics.js', expected: true },
    { url: 'https://www.googletagmanager.com/gtag/js?id=G-XXXXX', expected: true },
    { url: 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXXX', expected: true },
    { url: 'https://analytics.google.com/g/collect', expected: true },
    { url: 'https://region1.google-analytics.com/g/collect', expected: true },
    { url: 'https://stats.g.doubleclick.net/r/collect', expected: true },
    
    // Should NOT be detected as GA
    { url: 'https://example.com/page', expected: false },
    { url: 'https://cdn.example.com/script.js', expected: false },
    { url: 'https://google.com/search?q=test', expected: false },
    { url: 'https://fonts.googleapis.com/css', expected: false },
    { url: 'https://www.youtube.com/watch?v=xxx', expected: false },
];

let passed = 0;
let failed = 0;

testUrls.forEach(test => {
    const result = isGARequest(test.url);
    const status = result === test.expected;
    
    if (status) {
        passed++;
        console.log(`✅ ${result ? 'GA' : 'DIRECT'}: ${test.url.substring(0, 60)}...`);
    } else {
        failed++;
        console.log(`❌ Expected ${test.expected ? 'GA' : 'DIRECT'}, got ${result ? 'GA' : 'DIRECT'}: ${test.url}`);
    }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);

// Test Proxy URL Parsing
console.log('\n📌 Testing Proxy URL Parsing:\n');

const proxyTests = [
    { input: 'proxy.example.com:8080', expected: { host: 'proxy.example.com', port: 8080 } },
    { input: 'http://proxy.example.com:3128', expected: { host: 'proxy.example.com', port: 3128 } },
    { input: 'http://user:pass@proxy.example.com:8080', expected: { host: 'proxy.example.com', port: 8080, username: 'user', password: 'pass' } },
    { input: 'socks5://proxy.example.com:1080', expected: { host: 'proxy.example.com', port: 1080, protocol: 'socks5' } },
];

proxyTests.forEach(test => {
    const result = parseProxyString(test.input);
    
    if (result && result.host === test.expected.host && result.port === test.expected.port) {
        console.log(`✅ Parsed: ${test.input}`);
        console.log(`   Host: ${result.host}, Port: ${result.port}, User: ${result.username || 'none'}`);
    } else {
        console.log(`❌ Failed: ${test.input}`);
        console.log(`   Got: ${JSON.stringify(result)}`);
    }
});

// Test URL Encoding for special characters
console.log('\n📌 Testing URL Encoding for Special Characters:\n');

const encodingTests = [
    { host: 'proxy.com', port: 8080, user: 'user', pass: 'pass', expected: 'http://user:pass@proxy.com:8080' },
    { host: 'proxy.com', port: 8080, user: 'user@domain', pass: 'p@ss#word', expected: 'http://user%40domain:p%40ss%23word@proxy.com:8080' },
    { host: 'proxy.com', port: 8080, user: 'test:user', pass: 'pass:123', expected: 'http://test%3Auser:pass%3A123@proxy.com:8080' },
];

encodingTests.forEach(test => {
    const result = buildProxyUrl(test.host, test.port, test.user, test.pass);
    
    if (result === test.expected) {
        console.log(`✅ Encoded correctly: ${result}`);
    } else {
        console.log(`❌ Encoding failed:`);
        console.log(`   Expected: ${test.expected}`);
        console.log(`   Got:      ${result}`);
    }
});

// Test ProxyRouter Stats
console.log('\n📌 Testing ProxyRouter Stats:\n');

const router = new ProxyRouter({
    proxyUrl: 'http://test:pass@proxy.example.com:8080',
    enabled: true,
    threadId: 1
});

// Simulate some requests
for (let i = 0; i < 100; i++) {
    if (i < 3) {
        // 3 GA requests
        router.incrementProxied();
    } else {
        // 97 direct requests
        router.incrementDirect();
    }
}

const stats = router.getStats();
console.log(`Total requests: ${stats.totalRequests}`);
console.log(`Proxied (GA): ${stats.proxiedRequests} (${stats.proxiedPercentage}%)`);
console.log(`Direct: ${stats.directRequests} (${stats.directPercentage}%)`);
console.log(`Bandwidth saved: ~${stats.bandwidthSaved}`);

if (stats.proxiedPercentage === '3.00' && stats.directPercentage === '97.00') {
    console.log('\n✅ Stats calculation: PASS');
} else {
    console.log('\n❌ Stats calculation: FAIL');
}

console.log(`\n${'='.repeat(60)}`);
console.log('Proxy routing tests completed!');
console.log('='.repeat(60));
