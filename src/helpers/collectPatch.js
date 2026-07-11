/**
 * Patch GA4 /collect URL parameters so a returning-user visit doesn't get
 * recorded as a brand-new session.
 *
 *   _fv   → removed   (first_visit event trigger — only new users fire this)
 *   sct=1 → sct=2     (session_count: 1 = new, 2 = returning)
 *   _nsi=1 → _nsi=0   (new_session_indicator)
 *
 * `seg` (engaged session flag) is intentionally NOT patched — gtag.js sets
 * `seg=0` until the session actually engages (≥10s, conversion, or ≥2 pageviews),
 * then flips to `seg=1` on its own. Forcing `seg=1` on every event made bounce
 * visits of returning users show as engaged in GA4, distorting engagement rate
 * and average session duration. Leave it alone so GA4 reports accurate metrics.
 *
 * Returns the modified URL if any param was changed, or null if nothing
 * needed patching (callers skip the route override fast-path).
 *
 * Uses URLSearchParams so the patch survives GA4 changing param order or
 * encoding — a regex-based version was previously fragile.
 */
function patchCollectUrlForReturning(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }

    const params = parsed.searchParams;
    let changed = false;

    if (params.has('_fv')) {
        params.delete('_fv');
        changed = true;
    }
    if (params.get('sct') === '1') {
        params.set('sct', '2');
        changed = true;
    }
    if (params.get('_nsi') === '1') {
        params.set('_nsi', '0');
        changed = true;
    }

    return changed ? parsed.toString() : null;
}

module.exports = { patchCollectUrlForReturning };
