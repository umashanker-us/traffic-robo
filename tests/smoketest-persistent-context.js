/**
 * Smoke test: launchPersistentContext with SimilarWeb extension
 *
 * Tests:
 * 1. Normal launch() + newContext() path (no extension) — regression check
 * 2. launchPersistentContext() with extension — extension actually injects
 * 3. Temp dir creation and cleanup
 * 4. Extension markers visible on page
 *
 * Run: node tests/smoketest-persistent-context.js
 */

const { chromium } = require('playwright');
const os = require('os');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extensions', 'similarweb');
const TEST_URL = 'https://example.com';

const LAUNCH_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-client-side-phishing-detection',
    '--disable-features=SafeBrowsing',
    '--no-first-run',
];

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  ✅ ${label}`); }
function fail(label, err) { failed++; console.log(`  ❌ ${label}: ${err}`); }

async function testNormalPath() {
    console.log('\n--- Test 1: Normal launch() + newContext() (no extension) ---');
    let browser, context, page;
    try {
        browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
        context = await browser.newContext({ userAgent: 'SmokeTest/1.0' });
        page = await context.newPage();
        await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

        const title = await page.title();
        if (title) ok(`Page loaded, title: "${title}"`);
        else fail('Page title', 'empty');

        // Extension should NOT be injected in normal path
        const swInjected = await page.evaluate(() => window.__similarweb_injected === true);
        if (!swInjected) ok('Extension NOT injected (expected — normal path)');
        else fail('Extension check', 'extension was injected in normal path!');

    } catch (e) {
        fail('Normal path', e.message);
    } finally {
        if (page) await page.close().catch(() => {});
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
}

async function testPersistentContextWithExtension() {
    console.log('\n--- Test 2: launchPersistentContext() with SimilarWeb extension ---');
    let context, tempDir;

    // Verify extension exists
    if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
        fail('Extension path', `manifest.json not found at ${EXT_PATH}`);
        return;
    }
    ok(`Extension found at: ${EXT_PATH}`);

    try {
        // Create temp user data dir
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trafficrobo-smoke-'));
        if (fs.existsSync(tempDir)) ok(`Temp dir created: ${tempDir}`);
        else fail('Temp dir', 'not created');

        const args = [
            ...LAUNCH_ARGS,
            `--disable-extensions-except=${EXT_PATH}`,
            `--load-extension=${EXT_PATH}`,
        ];

        context = await chromium.launchPersistentContext(tempDir, {
            headless: false,
            args,
            viewport: null,
            userAgent: 'SmokeTest-PersistentContext/1.0',
        });
        ok('launchPersistentContext succeeded');

        const browser = context.browser();
        if (browser) ok('context.browser() returns browser instance');
        else fail('context.browser()', 'returned null');

        const page = await context.newPage();
        await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

        const title = await page.title();
        if (title) ok(`Page loaded, title: "${title}"`);
        else fail('Page title', 'empty');

        // Wait a moment for content script to inject
        await new Promise(r => setTimeout(r, 2000));

        // Content scripts run in an isolated JS world — they share the DOM
        // but NOT `window` with page.evaluate(). Detect via DOM evidence only.
        const extStatus = await page.evaluate(() => ({
            dataAttr: document.documentElement.getAttribute('data-similarweb') === 'true',
            hasPixel: !!document.querySelector('img[src*="similarweb.com"]'),
        }));

        if (extStatus.dataAttr) ok('data-similarweb attribute set on <html> (content script injected)');
        else fail('data-similarweb', 'not set — content script did not inject');

        if (extStatus.hasPixel) ok('SimilarWeb tracking pixel injected in DOM');
        else fail('Tracking pixel', 'not found (may be blocked by network)');

        const detected = extStatus.dataAttr || extStatus.hasPixel;
        if (detected) ok('Extension CONFIRMED WORKING via DOM evidence');
        else fail('Extension detection', 'no DOM markers found');

        console.log('\n  Extension DOM evidence:', JSON.stringify(extStatus, null, 2));

    } catch (e) {
        fail('Persistent context', e.message);
    } finally {
        if (context) {
            await context.close().catch(() => {});
        }
        // Cleanup temp dir
        if (tempDir) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
                if (!fs.existsSync(tempDir)) ok('Temp dir cleaned up');
                else fail('Temp dir cleanup', 'dir still exists');
            } catch (e) {
                fail('Temp dir cleanup', e.message);
            }
        }
    }
}

async function testVisitorCodePath() {
    console.log('\n--- Test 3: AutomaticVisitor code path integration ---');
    try {
        const AutomaticVisitor = require('../src/core/automaticVisitor');
        const Constants = require('../src/helpers/constants');

        // Test: extension enabled + headed mode → _usePersistentContext should be true
        const visitor = new AutomaticVisitor({
            campaignUrl: TEST_URL,
            threadId: 999,
            visit: { isBounce: () => false, getPagePerSession: () => 2, getAvgSessionDuration: () => 30, getWaitTimePerPageMs: () => 15000, getWaitTimePerPageSec: () => 15 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0',
            screenSize: { width: 1920, height: 1080 },
            location: 'India',
            playMode: Constants.PLAY_MODES.SLOW,
            extensionEnabled: true,
            extensionPath: EXT_PATH,
        });

        // Call _launchBrowser — should set flag and return without launching
        await visitor._launchBrowser();

        if (visitor._usePersistentContext === true) ok('_usePersistentContext = true (extension + headed)');
        else fail('_usePersistentContext', `expected true, got ${visitor._usePersistentContext}`);

        if (visitor.extensionLoaded === true) ok('extensionLoaded = true');
        else fail('extensionLoaded', `expected true, got ${visitor.extensionLoaded}`);

        if (!visitor.browser) ok('browser NOT launched yet (deferred to _createContext)');
        else fail('browser', 'was launched prematurely');

        // Test: extension enabled + headless → should NOT use persistent context
        const headlessVisitor = new AutomaticVisitor({
            campaignUrl: TEST_URL,
            threadId: 998,
            visit: { isBounce: () => false, getPagePerSession: () => 2, getAvgSessionDuration: () => 30, getWaitTimePerPageMs: () => 15000, getWaitTimePerPageSec: () => 15 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0',
            screenSize: { width: 1920, height: 1080 },
            location: 'India',
            playMode: Constants.PLAY_MODES.FAST,
            extensionEnabled: true,
            extensionPath: EXT_PATH,
        });

        await headlessVisitor._launchBrowser();

        if (headlessVisitor._usePersistentContext === false) ok('Headless + extension → _usePersistentContext = false (correct)');
        else fail('Headless check', `expected false, got ${headlessVisitor._usePersistentContext}`);

        if (headlessVisitor.browser) ok('Headless: browser launched normally');
        else fail('Headless browser', 'not launched');

        // Cleanup headless browser
        if (headlessVisitor.browser) await headlessVisitor.browser.close().catch(() => {});

        // Test: no extension → normal path
        const normalVisitor = new AutomaticVisitor({
            campaignUrl: TEST_URL,
            threadId: 997,
            visit: { isBounce: () => false, getPagePerSession: () => 2, getAvgSessionDuration: () => 30, getWaitTimePerPageMs: () => 15000, getWaitTimePerPageSec: () => 15 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0',
            screenSize: { width: 1920, height: 1080 },
            location: 'India',
            playMode: Constants.PLAY_MODES.SLOW,
            extensionEnabled: false,
        });

        await normalVisitor._launchBrowser();

        if (normalVisitor._usePersistentContext === false) ok('No extension → _usePersistentContext = false');
        else fail('No extension check', `expected false, got ${normalVisitor._usePersistentContext}`);

        if (normalVisitor.browser) ok('Normal: browser launched');
        else fail('Normal browser', 'not launched');

        if (normalVisitor.browser) await normalVisitor.browser.close().catch(() => {});

    } catch (e) {
        fail('Visitor code path', e.message);
    }
}

(async () => {
    console.log('🧪 Smoke Test: Persistent Context + SimilarWeb Extension\n');

    await testNormalPath();
    await testPersistentContextWithExtension();
    await testVisitorCodePath();

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${'═'.repeat(50)}`);

    process.exit(failed > 0 ? 1 : 0);
})();
