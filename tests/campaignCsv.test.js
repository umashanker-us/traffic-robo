const { parseCampaignCsv, resolveRanges, parseField, CSV_TEMPLATE } = require('../src/helpers/campaignCsv');

describe('parseField', () => {
    test('exact integer parses as value spec', () => {
        expect(parseField('42', 'bounce')).toEqual({ kind: 'value', value: 42 });
    });

    test('range "40-50" parses as range spec', () => {
        expect(parseField('40-50', 'bounce')).toEqual({ kind: 'range', min: 40, max: 50 });
    });

    test('empty string throws', () => {
        expect(() => parseField('', 'bounce')).toThrow(/empty/);
    });

    test('non-numeric throws', () => {
        expect(() => parseField('abc', 'bounce')).toThrow(/not numeric/);
    });

    test('range with min > max throws', () => {
        expect(() => parseField('50-40', 'bounce')).toThrow(/min greater than max/);
    });

    test('value out of bounds throws (bounce > 100)', () => {
        expect(() => parseField('150', 'bounce')).toThrow(/out of allowed/);
    });

    test('range out of bounds throws (pages 0-60)', () => {
        expect(() => parseField('0-60', 'pages')).toThrow(/out of allowed/);
    });
});

describe('parseCampaignCsv', () => {
    test('parses valid CSV with header', () => {
        const csv = `url,visits,bounce,duration,pages
https://example.com/a,100,40-50,35-47,3-5
https://example.com/b,80,42,38,4`;
        const { rows, errors } = parseCampaignCsv(csv);
        expect(errors).toEqual([]);
        expect(rows).toHaveLength(2);
        expect(rows[0].url).toBe('https://example.com/a');
        expect(rows[0].visits).toEqual({ kind: 'value', value: 100 });
        expect(rows[0].bounce).toEqual({ kind: 'range', min: 40, max: 50 });
        expect(rows[1].pages).toEqual({ kind: 'value', value: 4 });
    });

    test('parses CSV without header', () => {
        const csv = `https://example.com/a,100,40,35,4`;
        const { rows, errors } = parseCampaignCsv(csv);
        expect(errors).toEqual([]);
        expect(rows).toHaveLength(1);
    });

    test('strips comment lines starting with #', () => {
        const csv = `# this is a comment
url,visits,bounce,duration,pages
# another comment
https://example.com/a,100,40,35,4`;
        const { rows, errors } = parseCampaignCsv(csv);
        expect(errors).toEqual([]);
        expect(rows).toHaveLength(1);
    });

    test('reports per-line errors with line numbers', () => {
        const csv = `url,visits,bounce,duration,pages
https://example.com/a,100,40,35,4
not-a-url,100,40,35,4
https://example.com/c,abc,40,35,4`;
        const { rows, errors } = parseCampaignCsv(csv);
        expect(rows).toHaveLength(1);
        expect(errors).toHaveLength(2);
        expect(errors[0]).toMatch(/Line 3.*url/);
        expect(errors[1]).toMatch(/Line 4.*visits/);
    });

    test('rejects rows with too few columns', () => {
        const csv = `https://example.com/a,100,40,35`;
        const { rows, errors } = parseCampaignCsv(csv);
        expect(rows).toEqual([]);
        expect(errors[0]).toMatch(/5 columns/);
    });

    test('empty input returns error', () => {
        const { rows, errors } = parseCampaignCsv('');
        expect(rows).toEqual([]);
        expect(errors).toContain('Empty CSV content');
    });

    test('CSV_TEMPLATE itself is valid', () => {
        const { rows, errors } = parseCampaignCsv(CSV_TEMPLATE);
        expect(errors).toEqual([]);
        expect(rows.length).toBeGreaterThan(0);
    });
});

describe('resolveRanges', () => {
    test('resolves exact values unchanged', () => {
        const rows = [{
            url: 'https://x.com',
            visits:   { kind: 'value', value: 100 },
            bounce:   { kind: 'value', value: 42 },
            duration: { kind: 'value', value: 38 },
            pages:    { kind: 'value', value: 4 },
        }];
        const resolved = resolveRanges(rows);
        expect(resolved[0]).toEqual({
            url: 'https://x.com', visits: 100, bounce: 42, duration: 38, pages: 4,
        });
    });

    test('range values fall within bounds', () => {
        const rows = [{
            url: 'https://x.com',
            visits:   { kind: 'range', min: 80, max: 120 },
            bounce:   { kind: 'range', min: 40, max: 50 },
            duration: { kind: 'range', min: 35, max: 47 },
            pages:    { kind: 'range', min: 3,  max: 5  },
        }];
        for (let i = 0; i < 50; i++) {
            const r = resolveRanges(rows)[0];
            expect(r.visits).toBeGreaterThanOrEqual(80);
            expect(r.visits).toBeLessThanOrEqual(120);
            expect(r.bounce).toBeGreaterThanOrEqual(40);
            expect(r.bounce).toBeLessThanOrEqual(50);
            expect(r.duration).toBeGreaterThanOrEqual(35);
            expect(r.duration).toBeLessThanOrEqual(47);
            expect(r.pages).toBeGreaterThanOrEqual(3);
            expect(r.pages).toBeLessThanOrEqual(5);
        }
    });

    test('no two URLs end up with identical (bounce, duration, pages) tuple when space allows', () => {
        // 11*13*3 = 429 possible tuples — way more than 20 URLs
        const rows = Array.from({ length: 20 }, (_, i) => ({
            url: `https://x.com/${i}`,
            visits:   { kind: 'value', value: 100 },
            bounce:   { kind: 'range', min: 40, max: 50 },
            duration: { kind: 'range', min: 35, max: 47 },
            pages:    { kind: 'range', min: 3,  max: 5  },
        }));
        const resolved = resolveRanges(rows);
        const keys = resolved.map(r => `${r.bounce}|${r.duration}|${r.pages}`);
        expect(new Set(keys).size).toBe(20);
    });
});
