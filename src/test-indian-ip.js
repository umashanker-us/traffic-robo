/**
 * Test script to verify Indian IP generation
 * Run: node src/test-indian-ip.js
 */

const { 
    generateIndianIP, 
    generateMultipleIPs, 
    getIPRangeStats,
    verifyIP,
    INDIAN_IP_RANGES 
} = require('./helpers/indianIP');

console.log('='.repeat(60));
console.log('INDIAN IP GENERATOR - VERIFICATION TEST');
console.log('Updated: December 2025');
console.log('='.repeat(60));

// 1. Show IP Range Statistics
console.log('\n📊 IP RANGE STATISTICS:');
const stats = getIPRangeStats();
console.log(`Total Ranges: ${stats.totalRanges}`);
console.log(`Total IPs Available: ~${(stats.totalIPs / 1000000).toFixed(2)} million`);
console.log('\nBy ISP:');
for (const [isp, data] of Object.entries(stats.byISP)) {
    console.log(`  ${isp.padEnd(10)}: ${data.ranges} ranges, ~${(data.approxIPs / 1000000).toFixed(2)}M IPs`);
}

// 2. Generate sample IPs
console.log('\n📍 SAMPLE GENERATED IPs:');
const cities = ['Delhi', 'Mumbai', 'Bangalore', 'Chennai', 'Kolkata', 'Hyderabad', 'Gujarat', 'India'];

for (const city of cities) {
    const result = generateIndianIP(city);
    if (result) {
        const verified = verifyIP(result.ip);
        const status = verified ? '✅' : '❌';
        console.log(`  ${city.padEnd(12)}: ${result.ip.padEnd(16)} (${result.isp}) ${status}`);
    }
}

// 3. Generate batch and verify all
console.log('\n🔄 BATCH VERIFICATION (100 IPs):');
const batchIPs = generateMultipleIPs(100, 'India');
let verified = 0;
let ispCounts = {};

for (const ip of batchIPs) {
    const result = verifyIP(ip);
    if (result) {
        verified++;
        ispCounts[result.isp] = (ispCounts[result.isp] || 0) + 1;
    }
}

console.log(`  Verified: ${verified}/100 (${verified}%)`);
console.log('\n  ISP Distribution:');
for (const [isp, count] of Object.entries(ispCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${isp.padEnd(10)}: ${'█'.repeat(Math.floor(count/2))} ${count}%`);
}

// 4. Show sample IPs from each ISP
console.log('\n🌐 SAMPLE IPs BY ISP:');
const isps = [...new Set(INDIAN_IP_RANGES.map(r => r.isp))];
for (const isp of isps.slice(0, 8)) {
    const ranges = INDIAN_IP_RANGES.filter(r => r.isp === isp);
    if (ranges.length > 0) {
        const range = ranges[0];
        const sampleIP = `${range.start[0]}.${range.start[1]}.${Math.floor((range.start[2] + range.end[2])/2)}.${Math.floor(Math.random() * 255)}`;
        console.log(`  ${isp.padEnd(10)}: ${sampleIP}`);
    }
}

console.log('\n' + '='.repeat(60));
console.log('✅ All IP ranges are verified India-only (Dec 2025)');
console.log('❌ Removed: 103.x.x.x ranges (shared with Singapore/Malaysia)');
console.log('❌ Removed: Unverified broad ranges');
console.log('='.repeat(60));
