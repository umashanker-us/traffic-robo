/**
 * Cookie extraction filter — only `_ga` (client ID) should be saved,
 * NOT `_ga_<MEASUREMENT_ID>` session cookie or `_gid`. Injecting the old
 * session cookie causes gtag.js to continue the prior session instead of
 * starting a fresh one — so GA4 never registers a returning-user session.
 */

const AutomaticVisitor = require('../src/core/automaticVisitor');

function makeVisitor(mockCookies) {
    const v = Object.create(AutomaticVisitor.prototype);
    v.logger = { info: () => {}, warn: () => {}, debug: () => {} };
    v.context = { cookies: async () => mockCookies };
    return v;
}

describe('_extractCookiesBeforeClose cookie filter', () => {

    test('saves only _ga, skips _ga_<MEASUREMENT_ID> session cookie', async () => {
        const v = makeVisitor([
            { name: '_ga', value: 'GA1.2.1234567890.1700000000', domain: '.example.com', path: '/' },
            { name: '_ga_ABC123XYZ', value: 'GS1.1.1700000000.1.0.1700000100.0.0.0', domain: '.example.com', path: '/' },
            { name: '_gid', value: 'GA1.2.9876.1700000000', domain: '.example.com', path: '/' },
            { name: '_gat_gtag_UA_123', value: '1', domain: '.example.com', path: '/' },
            { name: 'JSESSIONID', value: 'abc', domain: '.example.com', path: '/' },
        ]);

        await v._extractCookiesBeforeClose();
        const saved = v.getCookies();

        expect(saved).toHaveLength(1);
        expect(saved[0].name).toBe('_ga');
        expect(saved.find(c => c.name.startsWith('_ga_'))).toBeUndefined();
        expect(saved.find(c => c.name === '_gid')).toBeUndefined();
        expect(saved.find(c => c.name.startsWith('_gat'))).toBeUndefined();
    });

    test('returns empty when no _ga cookie present', async () => {
        const v = makeVisitor([
            { name: '_gid', value: 'GA1.2.9876.1700000000', domain: '.example.com', path: '/' },
            { name: '_ga_ABC123XYZ', value: 'GS1.1.1700000000.1.0.0.0.0.0', domain: '.example.com', path: '/' },
        ]);

        await v._extractCookiesBeforeClose();
        expect(v.getCookies()).toEqual([]);
    });

    test('handles missing context gracefully', async () => {
        const v = Object.create(AutomaticVisitor.prototype);
        v.logger = { info: () => {}, warn: () => {}, debug: () => {} };
        v.context = null;

        await v._extractCookiesBeforeClose();
        expect(v.getCookies()).toEqual([]);
    });
});
