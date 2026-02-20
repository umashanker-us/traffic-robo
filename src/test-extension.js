/**
 * Test Extension Loading
 * Run: node src/test-extension.js
 * 
 * This script opens a browser with the SimilarWeb extension
 * and verifies it's working properly.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function testExtension() {
    console.log('='.repeat(60));
    console.log('🧩 EXTENSION TEST - SimilarWeb');
    console.log('='.repeat(60));
    
    // Find extension path
    const extensionPath = path.join(__dirname, '..', 'extensions', 'similarweb');
    
    console.log(`\n📁 Extension path: ${extensionPath}`);
    
    if (!fs.existsSync(extensionPath)) {
        console.error('❌ Extension folder not found!');
        console.log('   Make sure extensions/similarweb folder exists');
        process.exit(1);
    }
    
    // Check manifest
    const manifestPath = path.join(extensionPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        console.error('❌ manifest.json not found in extension folder!');
        process.exit(1);
    }
    
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    console.log(`✅ Extension found: ${manifest.name} v${manifest.version}`);
    
    console.log('\n🚀 Launching browser with extension...');
    
    const browser = await chromium.launch({
        headless: false,  // Must be headed for extensions
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`
        ]
    });
    
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 }
    });
    
    const page = await context.newPage();
    
    // Test on a real website
    const testUrl = 'https://example.com';
    console.log(`\n🌐 Navigating to: ${testUrl}`);
    
    await page.goto(testUrl, { waitUntil: 'networkidle' });
    
    // Wait for extension to inject
    await page.waitForTimeout(2000);
    
    console.log('\n🔍 Checking extension markers...\n');
    
    // Check extension markers
    const status = await page.evaluate(() => {
        return {
            injected: window.__similarweb_injected === true,
            swExtension: window.__sw_extension === true,
            swVersion: window.__sw_version || null,
            dataAttribute: document.documentElement.getAttribute('data-similarweb'),
            hasPixel: !!document.querySelector('img[src*="similarweb"]')
        };
    });
    
    console.log('Extension Status:');
    console.log('─'.repeat(40));
    console.log(`  __similarweb_injected: ${status.injected ? '✅ YES' : '❌ NO'}`);
    console.log(`  __sw_extension:        ${status.swExtension ? '✅ YES' : '❌ NO'}`);
    console.log(`  __sw_version:          ${status.swVersion || '❌ NOT SET'}`);
    console.log(`  data-similarweb attr:  ${status.dataAttribute ? '✅ YES' : '❌ NO'}`);
    console.log(`  Tracking pixel:        ${status.hasPixel ? '✅ YES' : '❌ NO'}`);
    console.log('─'.repeat(40));
    
    const isWorking = status.injected || status.swExtension || status.dataAttribute;
    
    if (isWorking) {
        console.log('\n🎉 EXTENSION IS WORKING!\n');
    } else {
        console.log('\n⚠️ EXTENSION NOT DETECTED\n');
        console.log('Possible reasons:');
        console.log('  1. Extension failed to load');
        console.log('  2. Content Security Policy blocking');
        console.log('  3. Browser compatibility issue');
    }
    
    // Show console logs from page
    console.log('📋 Browser Console Logs:');
    console.log('─'.repeat(40));
    
    page.on('console', msg => {
        if (msg.text().includes('SimilarWeb')) {
            console.log(`  [${msg.type()}] ${msg.text()}`);
        }
    });
    
    // Keep browser open for manual inspection
    console.log('\n👀 Browser is open for manual inspection.');
    console.log('   Check DevTools > Console for "[SimilarWeb]" logs');
    console.log('   Check DevTools > Application > Storage for extension data');
    console.log('\n   Press Ctrl+C to close...\n');
    
    // Keep alive
    await new Promise(() => {});
}

testExtension().catch(console.error);
