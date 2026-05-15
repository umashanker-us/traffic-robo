/**
 * ManualVisitor cookie extraction parity — verifies the same filter as
 * AutomaticVisitor: only `_ga` (client ID) is saved, NOT `_ga_<MEAS_ID>`
 * session cookie or `_gid`. Without this, returning-user injection would
 * resurrect the prior session instead of starting a fresh one.
 */

jest.mock('../src/helpers/logger', () => ({
    getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    getCampaignLogDir: () => null,
}));

const ManualVisitor = require('../src/core/manualVisitor');

function makeVisitor(mockCookies) {
    const v = Object.create(ManualVisitor.prototype);
    v.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    v.context = { cookies: async () => mockCookies };
    return v;
}

describe('ManualVisitor cookie extraction parity', () => {
    test('saves only _ga, skips _ga_<MEASUREMENT_ID> session cookie and _gid', async () => {
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
        const v = Object.create(ManualVisitor.prototype);
        v.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
        v.context = null;

        await v._extractCookiesBeforeClose();
        expect(v.getCookies()).toEqual([]);
    });
});
