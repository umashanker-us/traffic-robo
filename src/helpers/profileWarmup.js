/**
 * Give every pooled profile its extension consent before the campaign starts.
 *
 * Without this, the first visit to use a given profile pays for consent itself:
 * the extension's options page opens in that visit's browser, stays visible for
 * about 2.5 seconds while the control is ticked and verified, and the extension
 * reacts by opening its own welcome tab. All of that lands inside a real visit —
 * the one whose page load, GA4 beacon and ad flow we actually care about.
 *
 * Doing it up front costs the same total time but moves it out of the visits.
 * Afterwards every visit finds its profile already consented, so nothing opens
 * on top of the campaign page at all.
 *
 * It is also cheap to repeat: a profile that already carries the consent marker
 * is skipped without launching anything, so only a fresh or reset pool pays.
 */

const { chromium } = require('playwright');

const { acquireProfile } = require('./profilePool');
const { grantExtensionConsent, hasConsent } = require('./extensionConsent');

// One profile's whole warm-up: launch, consent, close. Generous — a cold start
// with several browsers coming up at once was measured taking over 10s just to
// start the extension's service worker — but bounded, because a campaign must
// never be blocked by a warm-up that will not finish.
const PER_PROFILE_TIMEOUT_MS = 60000;

/**
 * Run `work`, giving up after `ms`.
 *
 * Playwright puts no timeout on a context close or an extension's startup, so
 * without this a single stuck profile would hold the campaign before it began.
 */
async function withTimeout(ms, label, work) {
    let timer = null;
    const expired = Symbol('expired');
    try {
        const pending = work();
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
        const result = await Promise.race([
            pending,
            new Promise((resolve) => { timer = setTimeout(() => resolve(expired), ms); }),
        ]);
        if (result === expired) return { ok: false, reason: `${label} did not finish within ${ms}ms` };
        return { ok: true, value: result };
    } catch (error) {
        return { ok: false, reason: error.message.split('\n')[0] };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Launch one profile with the extension loaded and grant its consent.
 *
 * @param {{dir: string, id: string}} lease
 * @param {Object} options
 * @returns {Promise<{id: string, granted: boolean, skipped: boolean, reason: string|null}>}
 */
async function warmOneProfile(lease, { extensionPath, binaryOptions, logger }) {
    let context = null;
    try {
        context = await chromium.launchPersistentContext(lease.dir, {
            headless: false,                 // an extension does not load headless
            viewport: { width: 1280, height: 800 },
            args: [
                `--disable-extensions-except=${extensionPath}`,
                `--load-extension=${extensionPath}`,
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-blink-features=AutomationControlled',
                // Nothing here browses, so keep it out of the way.
                '--window-position=-2400,-2400',
            ],
            ...binaryOptions,
        });

        // The extension opens its welcome tab the moment consent is granted.
        // Here that tab is harmless — this browser closes straight afterwards —
        // but closing it keeps the warm-up from flashing anything on screen.
        context.on('page', (page) => {
            page.on('request', (request) => {
                try {
                    if (!request.isNavigationRequest()) return;
                    if (request.frame() !== page.mainFrame()) return;
                    const url = request.url();
                    if (url.startsWith('chrome-extension://')) return;   // the options page
                    page.close().catch(() => {});
                } catch {
                    // already closing
                }
            });
        });

        const result = await grantExtensionConsent(context, {
            profileDir: lease.dir,
            logger: null,                    // reported in one line by the caller
        });

        return {
            id: lease.id,
            granted: result.granted,
            skipped: false,
            reason: result.granted ? null : result.reason,
        };
    } finally {
        if (context) {
            // A context that will not close must not hold the campaign either.
            await withTimeout(10000, 'closing the warm-up browser', () => context.close());
        }
    }
}

/**
 * Warm every profile in the pool.
 *
 * Sequential on purpose. Running them together is what produced the consent
 * failure this is meant to avoid: five browsers starting at once left the first
 * one's extension service worker unstarted past its deadline. One at a time is
 * slower in theory and more reliable in practice, and it happens once per run.
 *
 * Never throws: a campaign is still worth running with a profile that did not
 * take its consent, it just reports nothing for that profile.
 *
 * @param {Object} options
 * @param {number} options.poolSize
 * @param {string} options.extensionPath
 * @param {Object} [options.binaryOptions] - channel or executablePath for the browser
 * @param {Object} [options.logger]
 * @param {function} [options.shouldStop] - called between profiles; stop if it returns true
 * @returns {Promise<{warmed: number, skipped: number, failed: number, total: number, details: Array}>}
 */
async function warmUpProfiles({
    poolSize,
    extensionPath,
    binaryOptions = {},
    logger = null,
    shouldStop = null,
} = {}) {
    const log = (level, msg) => { if (logger && logger[level]) logger[level](msg); };
    const summary = { warmed: 0, skipped: 0, failed: 0, total: 0, details: [] };

    const size = Math.floor(poolSize) || 0;
    if (size <= 0 || !extensionPath) return summary;

    // Hold every lease at once, so each iteration gets a different profile
    // rather than the same one handed back after each release.
    const leases = [];
    try {
        for (let i = 0; i < size; i += 1) {
            leases.push(await acquireProfile({ poolSize: size }));
        }
        summary.total = leases.length;

        const needed = leases.filter(l => !hasConsent(l.dir));
        summary.skipped = leases.length - needed.length;

        if (needed.length === 0) {
            log('info', `Extension profiles already consented (${leases.length}) — nothing to warm up`);
            return summary;
        }

        log('info', `Warming up ${needed.length} extension profile${needed.length === 1 ? '' : 's'}`
            + ` before the campaign — consent is granted once here instead of inside a visit`);

        for (const lease of needed) {
            if (shouldStop && shouldStop()) {
                log('warn', 'Warm-up stopped before finishing');
                break;
            }

            const started = Date.now();
            const attempt = await withTimeout(PER_PROFILE_TIMEOUT_MS, `warming ${lease.id}`,
                () => warmOneProfile(lease, { extensionPath, binaryOptions, logger }));

            const secs = ((Date.now() - started) / 1000).toFixed(1);
            if (attempt.ok && attempt.value.granted) {
                summary.warmed += 1;
                summary.details.push({ id: lease.id, granted: true, reason: null });
                log('info', `  ${lease.id}: consent granted in ${secs}s`);
            } else {
                const reason = attempt.ok ? attempt.value.reason : attempt.reason;
                summary.failed += 1;
                summary.details.push({ id: lease.id, granted: false, reason });
                log('warn', `  ${lease.id}: consent not granted after ${secs}s — ${reason}`
                    + ' (the visit using it will try again)');
            }
        }

        log('info', `Warm-up done: ${summary.warmed} granted, ${summary.skipped} already had it,`
            + ` ${summary.failed} failed`);
    } catch (error) {
        log('warn', `Warm-up could not run: ${error.message.split('\n')[0]} — visits will grant consent themselves`);
    } finally {
        for (const lease of leases) {
            try { lease.release(); } catch { /* a lease released twice is fine */ }
        }
    }

    return summary;
}

module.exports = {
    warmUpProfiles,
    PER_PROFILE_TIMEOUT_MS,
};
