/**
 * Give the SimilarWeb extension the consent it needs, once per profile.
 *
 * Measured against v6.12.24 on a fresh profile: the extension loads, its service
 * worker runs, its content scripts match <all_urls> — and it reports nothing at
 * all. Its options page holds three checkboxes, one of which is the consent:
 *
 *   autoIcon = false   "Display site rank in extension icon. I agree to allow
 *                       access to information about the sites I visit solely for
 *                       use as described in our Privacy Policy"
 *
 * It defaults to off. With it off, browsing produced 0 bytes of SimilarWeb
 * traffic. Ticking it produced 6.0 KB up / 7.9 KB down to rank.similarweb.com on
 * the next pages, and the setting persisted in the profile.
 *
 * That is why the profile pool is the prerequisite rather than the fix: consent
 * has to survive, and on a throwaway profile it never could.
 *
 * The app also closes chrome-extension:// pages on sight, so the options page
 * has to be opened deliberately and exempted from that.
 */

const fs = require('fs');
const path = require('path');

// Written into the profile once consent is granted, so later visits skip the
// whole dance instead of reopening the options page every time.
const MARKER_FILE = '.trafficrobo-extension-consent';

// The consent control, and the analytics opt-in beside it. Ids read off
// v6.12.24's options page; older builds simply will not have them.
const CONSENT_SELECTORS = ['#autoIcon'];

/**
 * Has this profile already been given consent?
 * @param {string} profileDir
 * @returns {boolean}
 */
function hasConsent(profileDir) {
    if (!profileDir) return false;
    try {
        return fs.existsSync(path.join(profileDir, MARKER_FILE));
    } catch {
        return false;
    }
}

function markConsent(profileDir, detail) {
    if (!profileDir) return;
    try {
        fs.writeFileSync(
            path.join(profileDir, MARKER_FILE),
            JSON.stringify({ at: new Date().toISOString(), ...detail }, null, 2),
        );
    } catch {
        // A profile we cannot write to will simply be re-consented next time.
    }
}

/**
 * The extension's id, taken from its running service worker.
 * An unpacked extension's id is derived from its path, so it cannot be hardcoded.
 *
 * @param {import('playwright').BrowserContext} context
 * @returns {string|null}
 */
function findExtensionId(context) {
    for (const worker of context.serviceWorkers()) {
        const match = worker.url().match(/^chrome-extension:\/\/([a-p]{32})\//);
        if (match) return match[1];
    }
    return null;
}

/**
 * Open the extension's options page and grant consent.
 *
 * The click has to be retried. The options page renders its controls from
 * extension storage asynchronously, so a click that lands before that render
 * completes is overwritten by it — measured as 8 failures in 25 concurrent
 * visits, all reporting "the consent control did not stay checked". Waiting for
 * the control, then verifying and retrying, is what makes it stick.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {Object} options
 * @param {string} options.profileDir - where the marker is written
 * @param {Object} [options.logger]
 * @param {number} [options.attempts=3]
 * @param {number} [options.settleMs=1200] - per-attempt wait for the page to persist it
 * @param {number} [options.workerTimeoutMs=30000] - total budget for the extension to start
 * @returns {Promise<{granted: boolean, alreadyGranted: boolean, reason: string|null, extensionId: string|null, attempts: number}>}
 */
async function grantExtensionConsent(context, {
    profileDir,
    logger = null,
    attempts = 3,
    settleMs = 1200,
    workerTimeoutMs = 30000,
} = {}) {
    const log = (level, msg) => { if (logger && logger[level]) logger[level](msg); };

    if (hasConsent(profileDir)) {
        return { granted: true, alreadyGranted: true, reason: null, extensionId: findExtensionId(context), attempts: 0 };
    }

    // The extension's service worker starts a moment after the browser does,
    // and its id can only be read from there.
    //
    // A single 10s waitForEvent was not enough. Measured on a 33-visit run with
    // five concurrent browsers: four granted consent 3s after launch, while the
    // first — which also pays the cost of creating its profile — had not
    // started its worker 10s in and gave up. That visit loaded the extension
    // and reported nothing.
    //
    // So the budget is larger, and it is spent in short waits that re-check the
    // worker list in between: waitForEvent only sees workers that register
    // after it subscribes, and under this much concurrency one can appear in
    // the gap.
    let extensionId = findExtensionId(context);
    const workerDeadline = Date.now() + workerTimeoutMs;
    while (!extensionId && Date.now() < workerDeadline) {
        const slice = Math.min(2000, workerDeadline - Date.now());
        try {
            await context.waitForEvent('serviceworker', { timeout: slice });
        } catch {
            // No worker in this slice; re-check the list and keep waiting.
        }
        extensionId = findExtensionId(context);
    }
    if (!extensionId) {
        return {
            granted: false,
            alreadyGranted: false,
            reason: `the extension service worker never started within ${workerTimeoutMs}ms`,
            extensionId: null,
            attempts: 0,
        };
    }

    let page = null;
    let used = 0;
    try {
        page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/options/options.html`, {
            waitUntil: 'load',
            timeout: 20000,
        });

        // Wait for the control to exist at all before touching it.
        const selector = await Promise.race(
            CONSENT_SELECTORS.map(sel =>
                page.waitForSelector(sel, { timeout: 8000, state: 'attached' }).then(() => sel)),
        ).catch(() => null);

        if (!selector) {
            return {
                granted: false,
                alreadyGranted: false,
                reason: 'no consent control on the options page (an older extension build?)',
                extensionId,
                attempts: 0,
            };
        }

        const read = () => page.evaluate(
            (sel) => !!(document.querySelector(sel) || {}).checked, selector);

        // Let the page finish applying stored settings, or the render undoes us.
        await page.waitForTimeout(settleMs);
        const wasChecked = await read();

        if (wasChecked) {
            markConsent(profileDir, { extensionId, control: selector, wasChecked: true });
            log('info', `Extension consent was already set in this profile (${selector})`);
            return { granted: true, alreadyGranted: true, reason: null, extensionId, attempts: 0 };
        }

        for (used = 1; used <= attempts; used++) {
            await page.click(selector, { timeout: 5000 }).catch(async () => {
                await page.evaluate((sel) => document.querySelector(sel).click(), selector);
            });
            await page.waitForTimeout(settleMs);
            if (await read()) {
                markConsent(profileDir, { extensionId, control: selector, attempts: used });
                log('info', `Extension consent granted in this profile (${selector}, attempt ${used}) — it reports nothing without this`);
                return { granted: true, alreadyGranted: false, reason: null, extensionId, attempts: used };
            }
        }

        return {
            granted: false,
            alreadyGranted: false,
            reason: `the consent control did not stay checked after ${attempts} attempts`,
            extensionId,
            attempts,
        };
    } catch (error) {
        return {
            granted: false,
            alreadyGranted: false,
            reason: error.message.split('\n')[0],
            extensionId,
            attempts: used,
        };
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

module.exports = {
    grantExtensionConsent,
    hasConsent,
    findExtensionId,
    MARKER_FILE,
    CONSENT_SELECTORS,
};
