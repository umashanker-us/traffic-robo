/**
 * Disk retention
 *
 * Replays were written per visit and never removed — the directory had reached
 * 483 files with nothing capping it. Loose log files from the old flat layout
 * sat at the root of logs/ where cleanOldLogs, which only matches YYYY-MM
 * directories, could never see them.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { pruneReplays, pruneLooseLogs, DEFAULT_MAX_REPLAY_FILES } = require('../src/helpers/retention');

let dir;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
});

afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

function writeFileAged(dirPath, name, ageDays, content = '{}') {
    const full = path.join(dirPath, name);
    fs.writeFileSync(full, content);
    const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    fs.utimesSync(full, when, when);
    return full;
}

describe('pruneReplays', () => {
    test('keeps everything when under the cap', () => {
        for (let i = 0; i < 5; i++) writeFileAged(dir, `replay_${i}.json`, i);
        const result = pruneReplays({ maxFiles: 10, replaysDir: dir });
        expect(result).toMatchObject({ scanned: 5, removed: 0 });
        expect(fs.readdirSync(dir)).toHaveLength(5);
    });

    test('removes the oldest first and keeps the newest', () => {
        // age 0 is newest, age 9 is oldest
        for (let i = 0; i < 10; i++) writeFileAged(dir, `replay_${i}.json`, i);

        const result = pruneReplays({ maxFiles: 4, replaysDir: dir });
        expect(result.scanned).toBe(10);
        expect(result.removed).toBe(6);

        const left = fs.readdirSync(dir).sort();
        expect(left).toEqual(['replay_0.json', 'replay_1.json', 'replay_2.json', 'replay_3.json']);
    });

    test('ignores files that are not replay JSON', () => {
        writeFileAged(dir, 'notes.txt', 100);
        writeFileAged(dir, 'replay_a.json', 1);
        const result = pruneReplays({ maxFiles: 0, replaysDir: dir });
        expect(result.scanned).toBe(1);
        expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    });

    test('reports the size of what it kept', () => {
        writeFileAged(dir, 'replay_1.json', 1, '0123456789');
        const result = pruneReplays({ maxFiles: 10, replaysDir: dir });
        expect(result.keptBytes).toBe(10);
    });

    test('a missing directory is not an error', () => {
        const gone = path.join(dir, 'does-not-exist');
        expect(pruneReplays({ replaysDir: gone })).toMatchObject({ scanned: 0, removed: 0 });
    });

    test('the default cap is high enough not to surprise anyone', () => {
        expect(DEFAULT_MAX_REPLAY_FILES).toBeGreaterThanOrEqual(1000);
    });
});

describe('pruneLooseLogs', () => {
    test('removes loose .log files past the age limit', () => {
        writeFileAged(dir, 'traffic-robo-2026-02-20.log', 60, 'old');
        writeFileAged(dir, 'traffic-robo-today.log', 1, 'new');

        const result = pruneLooseLogs({ maxAgeDays: 30, logsDir: dir });
        expect(result.removed).toBe(1);
        expect(fs.readdirSync(dir)).toEqual(['traffic-robo-today.log']);
    });

    test('leaves campaign subdirectories alone', () => {
        fs.mkdirSync(path.join(dir, '2026-02'), { recursive: true });
        writeFileAged(path.join(dir, '2026-02'), 'campaign.log', 90, 'x');

        const result = pruneLooseLogs({ maxAgeDays: 30, logsDir: dir });
        expect(result.removed).toBe(0);
        expect(fs.existsSync(path.join(dir, '2026-02', 'campaign.log'))).toBe(true);
    });

    test('ignores non-log files however old', () => {
        writeFileAged(dir, 'config.json', 365);
        const result = pruneLooseLogs({ maxAgeDays: 30, logsDir: dir });
        expect(result.removed).toBe(0);
        expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
    });

    test('a missing directory is not an error', () => {
        expect(pruneLooseLogs({ logsDir: path.join(dir, 'nope') })).toEqual({ removed: 0 });
    });
});
