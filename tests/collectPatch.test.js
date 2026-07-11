const { patchCollectUrlForReturning } = require('../src/helpers/collectPatch');

const BASE = 'https://www.google-analytics.com/g/collect';

describe('patchCollectUrlForReturning', () => {
    test('removes _fv when present', () => {
        const url = `${BASE}?_fv=1&tid=G-X&en=page_view`;
        const out = patchCollectUrlForReturning(url);
        expect(out).not.toBeNull();
        expect(new URL(out).searchParams.has('_fv')).toBe(false);
    });

    test('flips sct=1 to sct=2', () => {
        const out = patchCollectUrlForReturning(`${BASE}?tid=G-X&sct=1&en=x`);
        expect(new URL(out).searchParams.get('sct')).toBe('2');
    });

    test('flips _nsi=1 to _nsi=0', () => {
        const out = patchCollectUrlForReturning(`${BASE}?_nsi=1&tid=G-X`);
        expect(new URL(out).searchParams.get('_nsi')).toBe('0');
    });

    test('leaves seg untouched — gtag.js owns engagement', () => {
        // Forcing seg=1 incorrectly marked bouncing returning users as engaged,
        // distorting GA4 engagement rate and average session duration.
        const out = patchCollectUrlForReturning(`${BASE}?seg=0&_fv=1&tid=G-X`);
        expect(out).not.toBeNull();
        expect(new URL(out).searchParams.get('seg')).toBe('0');
    });

    test('handles the three session-identity flags together', () => {
        const url = `${BASE}?_fv=1&sct=1&_nsi=1&seg=0&tid=G-X`;
        const out = patchCollectUrlForReturning(url);
        const p = new URL(out).searchParams;
        expect(p.has('_fv')).toBe(false);
        expect(p.get('sct')).toBe('2');
        expect(p.get('_nsi')).toBe('0');
        expect(p.get('seg')).toBe('0'); // preserved
        expect(p.get('tid')).toBe('G-X');
    });

    test('returns null when nothing needs patching', () => {
        expect(patchCollectUrlForReturning(`${BASE}?tid=G-X&en=x`)).toBeNull();
        expect(patchCollectUrlForReturning(`${BASE}?sct=2`)).toBeNull();
        // seg alone never triggers a patch anymore
        expect(patchCollectUrlForReturning(`${BASE}?seg=0`)).toBeNull();
    });

    test('leaves sct=10 alone (not a 1)', () => {
        expect(patchCollectUrlForReturning(`${BASE}?sct=10`)).toBeNull();
    });

    test('leaves _nsi=0 alone (not a 1)', () => {
        expect(patchCollectUrlForReturning(`${BASE}?_nsi=0`)).toBeNull();
    });

    test('returns null on malformed URL', () => {
        expect(patchCollectUrlForReturning('not a url')).toBeNull();
    });

    test('preserves other params and order is acceptable', () => {
        const url = `${BASE}?tid=G-XYZ&_fv=1&dl=https%3A%2F%2Fexample.com&en=page_view`;
        const out = patchCollectUrlForReturning(url);
        const p = new URL(out).searchParams;
        expect(p.get('tid')).toBe('G-XYZ');
        expect(p.get('dl')).toBe('https://example.com');
        expect(p.get('en')).toBe('page_view');
        expect(p.has('_fv')).toBe(false);
    });

    test('does not mistake _fv as a substring of another key', () => {
        // GA4 has no `_fvz` key today, but be defensive — URLSearchParams matches whole keys.
        const out = patchCollectUrlForReturning(`${BASE}?_fvz=keepme&tid=G-X`);
        expect(out).toBeNull();
    });
});
