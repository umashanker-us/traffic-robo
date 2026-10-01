/**
 * Browser profile pool
 *
 * Pooling is the fix for an extension that accumulated nothing: every visit
 * used to build a throwaway profile, so a panel extension saw thousands of
 * one-page installs. These tests pin the two properties the pool must hold —
 * a profile is handed to one session at a time, and the same profiles come
 * back — because breaking either silently returns the old behaviour.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const pool = require('../src/helpers/profilePool');

let baseDir;

beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pooltest-'));
    pool.setBaseDir(baseDir);
    pool.resetPool();
});

afterEach(() => {
    pool.resetPool();
    pool.setBaseDir(null);
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch {}
});

describe('pooling off (poolSize 0)', () => {
    test('hands out a throwaway directory and deletes it on release', async () => {
        const lease = await pool.acquireProfile({ poolSize: 0 });

        expect(lease.pooled).toBe(false);
        expect(lease.id).toBeNull();
        expect(fs.existsSync(lease.dir)).toBe(true);

        lease.release();
        expect(fs.existsSync(lease.dir)).toBe(false);
    });

    test('two sessions never share a throwaway directory', async () => {
        const a = await pool.acquireProfile({ poolSize: 0 });
        const b = await pool.acquireProfile({ poolSize: 0 });

        expect(a.dir).not.toBe(b.dir);
        a.release();
        b.release();
    });

    test('release is idempotent', async () => {
        const lease = await pool.acquireProfile({ poolSize: 0 });
        lease.release();
        expect(() => lease.release()).not.toThrow();
    });

    test('an absent poolSize behaves as off', async () => {
        const lease = await pool.acquireProfile();
        expect(lease.pooled).toBe(false);
        lease.release();
    });
});

describe('pooling on', () => {
    test('a released profile comes back on the next acquire', async () => {
        const first = await pool.acquireProfile({ poolSize: 2 });
        const dir = first.dir;
        const id = first.id;
        expect(first.pooled).toBe(true);
        first.release();

        const second = await pool.acquireProfile({ poolSize: 2 });
        expect(second.dir).toBe(dir);
        expect(second.id).toBe(id);
        second.release();
    });

    test('the directory survives release — that is the whole point', async () => {
        const lease = await pool.acquireProfile({ poolSize: 1 });
        fs.writeFileSync(path.join(lease.dir, 'extension-state.txt'), 'device-id-123');
        lease.release();

        const again = await pool.acquireProfile({ poolSize: 1 });
        expect(fs.readFileSync(path.join(again.dir, 'extension-state.txt'), 'utf8')).toBe('device-id-123');
        again.release();
    });

    test('concurrent sessions get different profiles', async () => {
        const a = await pool.acquireProfile({ poolSize: 3 });
        const b = await pool.acquireProfile({ poolSize: 3 });
        const c = await pool.acquireProfile({ poolSize: 3 });

        const dirs = new Set([a.dir, b.dir, c.dir]);
        expect(dirs.size).toBe(3);

        a.release(); b.release(); c.release();
    });

    test('a profile is never handed to two sessions at once', async () => {
        const a = await pool.acquireProfile({ poolSize: 1 });

        let bResolved = false;
        const bPromise = pool.acquireProfile({ poolSize: 1 }).then(lease => {
            bResolved = true;
            return lease;
        });

        // b must still be waiting while a holds the only profile
        await new Promise(r => setImmediate(r));
        expect(bResolved).toBe(false);
        expect(pool.getPoolStats().waiting).toBe(1);

        a.release();
        const b = await bPromise;
        expect(b.dir).toBe(a.dir);
        b.release();
    });

    test('poolSize is clamped to MAX_POOL_SIZE', async () => {
        const lease = await pool.acquireProfile({ poolSize: 9999 });
        lease.release();
        expect(pool.getPoolStats().total).toBeLessThanOrEqual(pool.MAX_POOL_SIZE);
    });

    test('stats report what is busy', async () => {
        const a = await pool.acquireProfile({ poolSize: 2 });
        expect(pool.getPoolStats()).toMatchObject({ total: 1, busy: 1, waiting: 0 });
        a.release();
        expect(pool.getPoolStats()).toMatchObject({ busy: 0 });
    });
});

describe('resetPool', () => {
    test('removes the profiles from disk so the panel view starts over', async () => {
        const lease = await pool.acquireProfile({ poolSize: 1 });
        const dir = lease.dir;
        fs.writeFileSync(path.join(dir, 'state.txt'), 'x');
        lease.release();

        pool.resetPool();
        expect(fs.existsSync(dir)).toBe(false);
        expect(pool.getPoolStats().total).toBe(0);
    });
});

describe('base directory', () => {
    test('pooled profiles live under the configured base, not the OS temp root', async () => {
        const lease = await pool.acquireProfile({ poolSize: 1 });
        expect(lease.dir.startsWith(baseDir)).toBe(true);
        lease.release();
    });
});
