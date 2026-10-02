/**
 * Which browser binary runs the visits, and what version is it really?
 *
 * Two problems this solves.
 *
 * Fingerprint: the bundled Chromium reports navigator.plugins.length 0 and
 * pdfViewerEnabled false. No real browser does — a real Chrome reports 5 and
 * true. Those are plain automation tells, and the stealth script's crude
 * `plugins: [1,2,3,4,5]` fake does not fix mimeTypes or the PDF viewer. When
 * Google Chrome is installed we drive it instead and get the genuine values.
 *
 * Extensions: release-channel Chrome silently ignores --load-extension —
 * chrome://extensions lists nothing and no service worker starts — while the
 * bundled Chromium still honours it. An extension campaign therefore has to run
 * on Chromium, and the plugin stand-in in the stealth script covers the
 * fingerprint gap that choice leaves.
 *
 * Version honesty: generated user agents claimed Chrome 140-143 while the
 * engine was Chromium 145 — and would claim 143 while running Chrome 154.
 * Feature detection does not lie: a page can see APIs the claimed version never
 * shipped. Reading the real version once per campaign and pinning every
 * generated UA to it removes the mismatch entirely.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { getLogger } = require('./logger');

const logger = getLogger();

// Where Chrome installs itself on Windows, stable channel only — a Beta or Dev
// build would drift further from what the UA claims.
const CHROME_LOCATIONS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

let resolved = null;

/**
 * Find installed Google Chrome, if there is one.
 * @returns {string|null} executable path
 */
function findInstalledChrome() {
    const local = process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
        : null;
    for (const candidate of [...CHROME_LOCATIONS, local].filter(Boolean)) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch {
            // unreadable path — keep looking
        }
    }
    return null;
}

/**
 * Parse the Chrome major/build out of what browser.version() returns.
 * Playwright reports e.g. '154.0.8037.59' for Chrome, 'HeadlessChrome/145...'
 * shapes for some builds, so pull the first dotted quad we find.
 */
function parseVersion(raw) {
    const match = String(raw || '').match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
    return match ? match[0] : null;
}

/**
 * Decide once per process which binary to drive and what version it is.
 *
 * Launches the candidate browser briefly to read its real version, because the
 * file version on disk and what the engine reports can differ, and a binary
 * that cannot launch must not be chosen at all.
 *
 * @param {Object} [options]
 * @param {boolean} [options.preferInstalledChrome=true]
 * @param {boolean} [options.needsExtension=false] - the campaign loads an
 *   unpacked extension, which rules out release-channel Chrome entirely.
 * @param {string|null} [options.bundledPath] - packaged Chromium, when present
 * @returns {Promise<{channel: string|null, executablePath: string|null, version: string|null, kind: string}>}
 */
async function resolveBrowser({ preferInstalledChrome = true, needsExtension = false, bundledPath = null } = {}) {
    if (resolved) return resolved;

    const attempts = [];
    if (needsExtension) {
        // Measured: release Chrome 154 silently ignores --load-extension —
        // chrome://extensions lists nothing, no service worker starts, and the
        // content script never runs, so the extension contributes nothing and
        // reports as "not detected". The bundled Chromium still honours it.
        // Chromium's weaker fingerprint is covered by the stealth script's
        // plugin stand-in, so this trade is worth making.
        logger.info('Extension enabled — using Chromium: release Chrome ignores --load-extension');
    } else if (preferInstalledChrome && findInstalledChrome()) {
        attempts.push({ kind: 'chrome', launch: { channel: 'chrome' }, label: 'installed Google Chrome' });
    }
    if (bundledPath) {
        attempts.push({ kind: 'chromium-bundled', launch: { executablePath: bundledPath }, label: 'bundled Chromium' });
    }
    attempts.push({ kind: 'chromium', launch: {}, label: "Playwright's Chromium" });

    for (const attempt of attempts) {
        let browser = null;
        try {
            browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...attempt.launch });
            const version = parseVersion(browser.version());
            await browser.close();
            if (!version) continue;

            resolved = {
                kind: attempt.kind,
                channel: attempt.launch.channel || null,
                executablePath: attempt.launch.executablePath || null,
                version,
            };
            logger.info(`Browser: ${attempt.label} ${version} — user agents pinned to this version`);
            return resolved;
        } catch (e) {
            if (browser) { try { await browser.close(); } catch {} }
            logger.debug(`Browser candidate unavailable (${attempt.label}): ${e.message.split('\n')[0]}`);
        }
    }

    // Nothing launched. Let the caller proceed with Playwright's default and
    // fall back to the hardcoded UA version table.
    logger.warn('Could not resolve a browser to read its version — user agents will use the bundled version table');
    resolved = { kind: 'unknown', channel: null, executablePath: null, version: null };
    return resolved;
}

/**
 * What resolveBrowser decided, without launching anything.
 */
function getResolvedBrowser() {
    return resolved;
}

/**
 * Forget the decision. Used by tests, and by a campaign that should re-probe.
 */
function resetResolvedBrowser() {
    resolved = null;
}

module.exports = {
    resolveBrowser,
    getResolvedBrowser,
    resetResolvedBrowser,
    findInstalledChrome,
    parseVersion,
};
