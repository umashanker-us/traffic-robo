/**
 * Campaign CSV — per-URL config with range support.
 *
 * CSV format:
 *   url,visits,bounce,duration,pages
 *   https://example.com/a,100,40-50,35-47,3-5
 *   https://example.com/b,80-120,42,38-45,4
 *
 * Each numeric field may be:
 *   - "42"     → exact value
 *   - "40-50"  → random int in [40, 50] inclusive (resolved at run-time)
 *
 * resolveRanges() converts the parsed rows into concrete per-URL configs
 * and guarantees no two URLs end up with the same (bounce, duration, pages)
 * tuple — re-picks up to MAX_TUPLE_ATTEMPTS times when a collision occurs.
 */

const FIELDS = ['visits', 'bounce', 'duration', 'pages'];
const FIELD_LIMITS = {
    visits:   { min: 1,  max: 100000 },
    bounce:   { min: 0,  max: 100    },
    duration: { min: 0,  max: 3600   },
    pages:    { min: 1,  max: 50     },
};
const MAX_TUPLE_ATTEMPTS = 20;

function parseField(raw, fieldName) {
    const s = String(raw || '').trim();
    if (!s) throw new Error(`${fieldName} is empty`);
    const limits = FIELD_LIMITS[fieldName];

    if (s.includes('-')) {
        const parts = s.split('-').map(p => p.trim());
        if (parts.length !== 2) {
            throw new Error(`${fieldName} range "${s}" must be "min-max"`);
        }
        const min = Number(parts[0]);
        const max = Number(parts[1]);
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
            throw new Error(`${fieldName} range "${s}" has non-numeric bounds`);
        }
        if (min > max) {
            throw new Error(`${fieldName} range "${s}" — min greater than max`);
        }
        if (min < limits.min || max > limits.max) {
            throw new Error(`${fieldName} range "${s}" out of allowed [${limits.min}, ${limits.max}]`);
        }
        return { kind: 'range', min, max };
    }

    const n = Number(s);
    if (!Number.isFinite(n)) {
        throw new Error(`${fieldName} "${s}" is not numeric`);
    }
    if (n < limits.min || n > limits.max) {
        throw new Error(`${fieldName} ${n} out of allowed [${limits.min}, ${limits.max}]`);
    }
    return { kind: 'value', value: n };
}

function splitCsvLine(line) {
    return line.split(',').map(c => c.trim());
}

function parseCampaignCsv(text) {
    const errors = [];
    const rows = [];

    if (!text || typeof text !== 'string') {
        return { rows, errors: ['Empty CSV content'] };
    }

    const rawLines = text
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#'));

    if (rawLines.length === 0) {
        return { rows, errors: ['CSV has no data rows'] };
    }

    // Detect and skip header row
    const headerCells = splitCsvLine(rawLines[0]).map(c => c.toLowerCase());
    const looksLikeHeader = headerCells.includes('url') && headerCells.includes('visits');
    const dataLines = looksLikeHeader ? rawLines.slice(1) : rawLines;

    if (dataLines.length === 0) {
        return { rows, errors: ['CSV header found but no data rows'] };
    }

    dataLines.forEach((line, idx) => {
        const lineNum = idx + (looksLikeHeader ? 2 : 1);
        const cells = splitCsvLine(line);
        if (cells.length < 5) {
            errors.push(`Line ${lineNum}: expected 5 columns (url,visits,bounce,duration,pages), got ${cells.length}`);
            return;
        }
        const [url, visits, bounce, duration, pages] = cells;
        if (!url || !/^https?:\/\//i.test(url)) {
            errors.push(`Line ${lineNum}: url "${url}" must start with http:// or https://`);
            return;
        }
        try {
            const row = {
                url,
                visits:   parseField(visits,   'visits'),
                bounce:   parseField(bounce,   'bounce'),
                duration: parseField(duration, 'duration'),
                pages:    parseField(pages,    'pages'),
            };
            rows.push(row);
        } catch (e) {
            errors.push(`Line ${lineNum}: ${e.message}`);
        }
    });

    return { rows, errors };
}

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function resolveField(spec) {
    return spec.kind === 'value' ? spec.value : randInt(spec.min, spec.max);
}

/**
 * Resolve range specs into concrete per-URL configs.
 * Guarantees no two URLs share the same (bounce, duration, pages) triple
 * when ranges allow — falls back to whatever is generated when the search
 * space is too small.
 */
function resolveRanges(rows) {
    const seen = new Set();
    const resolved = [];

    for (const row of rows) {
        let pick = null;
        for (let attempt = 0; attempt < MAX_TUPLE_ATTEMPTS; attempt++) {
            const candidate = {
                bounce:   resolveField(row.bounce),
                duration: resolveField(row.duration),
                pages:    resolveField(row.pages),
            };
            const key = `${candidate.bounce}|${candidate.duration}|${candidate.pages}`;
            if (!seen.has(key)) {
                seen.add(key);
                pick = candidate;
                break;
            }
            pick = candidate; // keep latest in case all attempts collide
        }
        resolved.push({
            url:      row.url,
            visits:   resolveField(row.visits),
            bounce:   pick.bounce,
            duration: pick.duration,
            pages:    Math.max(1, Math.round(pick.pages)),
        });
    }
    return resolved;
}

const CSV_TEMPLATE = `# Campaign CSV — one URL per line.
# Each numeric field can be an exact value (e.g. 42) or a range (e.g. 40-50)
# that is randomly resolved at the start of every run. Same file = new mix daily.
url,visits,bounce,duration,pages
https://example.com/page1,80-120,40-50,35-47,3-5
https://example.com/page2,80-120,40-50,35-47,3-5
`;

module.exports = {
    parseCampaignCsv,
    resolveRanges,
    parseField,
    CSV_TEMPLATE,
    FIELD_LIMITS,
};
