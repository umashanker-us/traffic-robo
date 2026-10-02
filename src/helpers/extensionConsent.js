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
 * @param {import('playwright').BrowserContext} context
 * @param {Object} options
 * @param {string} options.profileDir - where the marker is written
 * @param {Object} [options.logger]
 * @param {number} [options.settleMs=2500] - time for the extension to persist it
 * @returns {Promise<{granted: boolean, alreadyGranted: boolean, reason: string|null, extensionId: string|null}>}
 */
async function grantExtensionConsent(context, { profileDir, logger = null, settleMs = 2500 } = {}) {
    const log = (level, msg) => { if (logger && logger[level]) logger[level](msg); };

    if (hasConsent(profileDir)) {
        return { granted: true, alreadyGranted: true, reason: null, extensionId: findExtensionId(context) };
    }

    const extensionId = findExtensionId(context);
    if (!extensionId) {
        return { granted: false, alreadyGranted: false, reason: 'no extension service worker found', extensionId: null };
    }

    let page = null;
    try {
        page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/options/options.html`, {
            waitUntil: 'domcontentloaded',
            timeout: 20000,
        });

        const result = await page.evaluate((selectors) => {
            const out = { found: null, wasChecked: null, nowChecked: null };
            for (const selector of selectors) {
                const box = document.querySelector(selector);
                if (!box) continue;
                out.found = selector;
                out.wasChecked = box.checked;
                if (!box.checked) box.click();          // the control's own handler persists it
                out.nowChecked = box.checked;
                break;
            }
            return out;
        }, CONSENT_SELECTORS);

        if (!result.found) {
            return {
                granted: false,
                alreadyGranted: false,
                reason: 'no consent control on the options page (an older extension build?)',
                extensionId,
            };
        }

        // The extension writes the setting asynchronously; give it a moment
        // before the page closes under it.
        await page.waitForTimeout(settleMs);

        const confirmed = await page.evaluate(
            (selector) => !!(document.querySelector(selector) || {}).checked,
            result.found,
        );

        if (!confirmed) {
            return { granted: false, alreadyGranted: false, reason: 'the consent control did not stay checked', extensionId };
        }

        markConsent(profileDir, { extensionId, control: result.found, wasChecked: result.wasChecked });
        log('info', result.wasChecked
            ? `Extension consent was already set in this profile (${result.found})`
            : `Extension consent granted in this profile (${result.found}) — it reports nothing without this`);

        return { granted: true, alreadyGranted: !!result.wasChecked, reason: null, extensionId };
    } catch (error) {
        return {
            granted: false,
            alreadyGranted: false,
            reason: error.message.split('\n')[0],
            extensionId,
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
