/**
 * Patch GA4 /collect URL parameters so a returning-user visit doesn't get
 * recorded as a brand-new session.
 *
 *   _fv  → removed   (first_visit event trigger)
 *   sct=1 → sct=2    (session_count: 1 = new, 2 = returning)
 *   _nsi=1 → _nsi=0  (new_session_indicator)
 *   seg=0 → seg=1    (engaged session flag)
 *
 * Returns the modified URL if any param was changed, or null if nothing
 * needed patching (so callers can skip the route override fast-path).
 */
function patchCollectUrlForReturning(url) {
    let modified = url;
    let changed = false;

    const fvMatch = modified.match(/([?&])_fv=[^&]*/);
    if (fvMatch) {
        modified = modified.replace(/([?&])_fv=[^&]*/, (match) => {
            return match.startsWith('?') ? '?' : '';
        });
        modified = modified.replace('?&', '?');
        changed = true;
    }

    if (/[?&]sct=1(&|$)/.test(modified)) {
        modified = modified.replace(/([?&]sct=)1(&|$)/, '$12$2');
        changed = true;
    }

    if (/[?&]_nsi=1(&|$)/.test(modified)) {
        modified = modified.replace(/([?&]_nsi=)1(&|$)/, '$10$2');
        changed = true;
    }

    if (/[?&]seg=0(&|$)/.test(modified)) {
        modified = modified.replace(/([?&]seg=)0(&|$)/, '$11$2');
        changed = true;
    }

    return changed ? modified : null;
}

module.exports = { patchCollectUrlForReturning };
