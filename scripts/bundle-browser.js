/**
 * Bundle Playwright Chromium for electron-builder packaging
 *
 * Copies the locally installed Playwright Chromium browser into
 * playwright-browsers/chromium/ so electron-builder can bundle it
 * as an extraResource in the final .exe installer.
 *
 * Usage:
 *   node scripts/bundle-browser.js
 *
 * Prerequisites:
 *   npx playwright install chromium
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TARGET_DIR = path.join(PROJECT_ROOT, 'playwright-browsers', 'chromium');

function findChromiumDir(exePath) {
    // Walk up from the exe to find the chromium-XXXX version directory
    // Typical path: .../chromium-XXXX/chrome-win/chrome.exe  (older)
    //           or: .../chromium-XXXX/chrome-win64/chrome.exe (newer)
    let dir = path.dirname(exePath);
    while (dir && dir !== path.dirname(dir)) {
        const base = path.basename(dir);
        if (base.startsWith('chromium-') || base.startsWith('chromium_')) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    return null;
}

function copyRecursive(src, dest) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
            copyRecursive(path.join(src, entry), path.join(dest, entry));
        }
    } else {
        fs.copyFileSync(src, dest);
    }
}

async function main() {
    console.log('=== Bundling Playwright Chromium ===\n');

    // Check if target already looks valid
    const possibleExes = [
        path.join(TARGET_DIR, 'chrome-win64', 'chrome.exe'),
        path.join(TARGET_DIR, 'chrome-win', 'chrome.exe'),
    ];
    const existingExe = possibleExes.find(p => fs.existsSync(p));
    if (existingExe) {
        console.log(`Chromium already bundled at: ${existingExe}`);
        console.log('Skipping copy. Delete playwright-browsers/ to force re-copy.\n');
        return;
    }

    // Find Playwright's installed Chromium executable
    let exePath;
    try {
        const { chromium } = require('playwright');
        exePath = chromium.executablePath();
    } catch (err) {
        console.error('ERROR: Could not find Playwright Chromium.');
        console.error('Run: npx playwright install chromium');
        process.exit(1);
    }

    if (!exePath || !fs.existsSync(exePath)) {
        console.error(`ERROR: Chromium executable not found at: ${exePath}`);
        console.error('Run: npx playwright install chromium');
        process.exit(1);
    }

    console.log(`Found Chromium exe: ${exePath}`);

    // Find the chromium version directory (chromium-XXXX)
    const chromiumVersionDir = findChromiumDir(exePath);
    if (!chromiumVersionDir) {
        // Fallback: copy the directory containing chrome.exe (e.g. chrome-win64/)
        const chromeDir = path.dirname(exePath);
        console.log(`Could not find chromium-XXXX parent; copying: ${chromeDir}`);
        const destDir = path.join(TARGET_DIR, path.basename(chromeDir));
        console.log(`Copying to: ${destDir}`);
        copyRecursive(chromeDir, destDir);
    } else {
        // Copy the contents of the chromium-XXXX dir into TARGET_DIR
        // So we get playwright-browsers/chromium/chrome-win64/chrome.exe
        console.log(`Chromium version dir: ${chromiumVersionDir}`);
        console.log(`Copying to: ${TARGET_DIR}`);
        fs.mkdirSync(TARGET_DIR, { recursive: true });
        for (const entry of fs.readdirSync(chromiumVersionDir)) {
            const srcEntry = path.join(chromiumVersionDir, entry);
            const destEntry = path.join(TARGET_DIR, entry);
            copyRecursive(srcEntry, destEntry);
        }
    }

    // Verify
    const verifyExe = possibleExes.find(p => fs.existsSync(p));
    if (verifyExe) {
        console.log(`\nVerified: ${verifyExe}`);
        // Show size
        const totalSize = getDirSize(TARGET_DIR);
        console.log(`Total size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
        console.log('\nChromium bundled successfully!');
    } else {
        console.error('\nWARNING: chrome.exe not found at expected paths after copy.');
        console.error('Check playwright-browsers/chromium/ manually.');
    }
}

function getDirSize(dir) {
    let total = 0;
    for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        total += stat.isDirectory() ? getDirSize(full) : stat.size;
    }
    return total;
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
