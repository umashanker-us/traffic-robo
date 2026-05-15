const { sanitizeConfigForLog, maskProxyUrl } = require('../src/helpers/sanitizeConfig');

describe('sanitizeConfigForLog', () => {
    test('masks user:pass in proxyUrl', () => {
        const out = sanitizeConfigForLog({
            proxyEnabled: true,
            proxyUrl: 'http://alice:s3cret@proxy.example.com:8080',
        });
        expect(out.proxyUrl).toBe('http://***:***@proxy.example.com:8080');
    });

    test('masks credentials in every line of a multi-line proxyUrl', () => {
        const out = sanitizeConfigForLog({
            proxyUrl: [
                'http://u1:p1@host1:80',
                'http://u2:p2@host2:80',
                'http://no-creds.example.com:80',
            ].join('\n'),
        });
        const lines = out.proxyUrl.split('\n');
        expect(lines[0]).toBe('http://***:***@host1:80');
        expect(lines[1]).toBe('http://***:***@host2:80');
        expect(lines[2]).toBe('http://no-creds.example.com:80');
    });

    test('leaves proxyUrl without credentials untouched', () => {
        const out = sanitizeConfigForLog({ proxyUrl: 'http://proxy.example.com:8080' });
        expect(out.proxyUrl).toBe('http://proxy.example.com:8080');
    });

    test('returns shallow clone — never mutates input', () => {
        const input = { proxyUrl: 'http://u:p@h:1', other: { nested: 1 } };
        const out = sanitizeConfigForLog(input);
        expect(input.proxyUrl).toBe('http://u:p@h:1'); // input untouched
        expect(out).not.toBe(input);
        expect(out.other).toBe(input.other); // shallow, refs preserved
    });

    test('handles null/undefined/non-object input', () => {
        expect(sanitizeConfigForLog(null)).toBeNull();
        expect(sanitizeConfigForLog(undefined)).toBeUndefined();
        expect(sanitizeConfigForLog('string')).toBe('string');
    });

    test('handles missing proxyUrl', () => {
        const out = sanitizeConfigForLog({ threads: 5 });
        expect(out.threads).toBe(5);
        expect(out.proxyUrl).toBeUndefined();
    });

    test('maskProxyUrl is idempotent on already-masked value', () => {
        const masked = 'http://***:***@host:80';
        expect(maskProxyUrl(masked)).toBe(masked);
    });
});
