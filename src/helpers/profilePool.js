/**
 * Browser profile pool
 *
 * Why this exists: every visit used to build a throwaway profile with
 * fs.mkdtempSync and delete it in cleanup. For the campaign itself that is
 * correct — a fresh profile is a fresh visitor. For a loaded extension it is
 * fatal: the extension is reinstalled from zero on every visit, and everything
 * it stores (install id, device id, cookies, localStorage, IndexedDB) dies with
 * the visit. A panel extension like SimilarWeb counts devices, so thousands of
 * one-page installs accumulate into nothing.
 *
 * With a pool of N reusable profiles the extension sees N stable devices that
 * browse repeatedly, which is both what the panel expects and far closer to
 * real traffic. GA4's new/returning split stays under the app's control because
 * the visitor clears GA cookies on a pooled profile (see _resetGACookies).
 *
 * Leases are exclusive: a profile directory can only be driven by one Chromium
 * at a time, so a caller waits when every profile is busy. All visitors run in
 * one process, so an in-process lock is sufficient.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_POOL_SIZE = 64;

// id -> { dir, busy }
const profiles = new Map();
// FIFO of resolvers waiting for any profile to free up
const waiting = [];

let configuredBaseDir = null;

/**
 * Where pooled profiles live. Electron passes its userData dir; tests and CLI
 * runs fall back to the OS temp dir.
 * @param {string|null} dir
 */
function setBaseDir(dir) {
    configuredBaseDir = dir || null;
}

function getBaseDir() {
    return path.join(configuredBaseDir || os.tmpdir(), 'trafficrobo-profiles');
}

function profileId(index) {
    return `p${index}`;
}

/**
 * An ephemeral lease: a fresh throwaway profile, removed on release. This is
 * the behaviour the app had everywhere before the pool existed, and it stays
 * the default whenever pooling is off.
 * @returns {{id: string, dir: string, pooled: boolean, release: function}}
 */
function createEphemeralLease() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trafficrobo-'));
    let released = false;
    return {
        id: null,
        dir,
        pooled: false,
        release() {
            if (released) return;
            released = true;
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                // Chromium can still hold a handle briefly; the OS temp sweep
                // will take it. Never fail a visit over cleanup.
            }
        },
    };
}

function takeFreeProfile(poolSize) {
    for (let i = 0; i < poolSize; i++) {
        const id = profileId(i);
        let entry = profiles.get(id);
        if (!entry) {
            const dir = path.join(getBaseDir(), id);
            fs.mkdirSync(dir, { recursive: true });
            entry = { dir, busy: false };
            profiles.set(id, entry);
        }
        if (!entry.busy) {
            entry.busy = true;
            return { id, dir: entry.dir };
        }
    }
    return null;
}

function releasePooled(id) {
    const entry = profiles.get(id);
    if (!entry || !entry.busy) return;
    entry.busy = false;
    const next = waiting.shift();
    if (next) next();
}

/**
 * Acquire a profile directory for one browser session.
 *
 * @param {Object} options
 * @param {number} [options.poolSize=0] - 0 (or less) means no pooling: a fresh
 *   throwaway profile, deleted on release. Clamped to MAX_POOL_SIZE.
 * @returns {Promise<{id: string|null, dir: string, pooled: boolean, release: function}>}
 *   release() must be called exactly once; calling it twice is a no-op.
 */
async function acquireProfile({ poolSize = 0 } = {}) {
    const size = Math.min(Math.max(Math.floor(poolSize) || 0, 0), MAX_POOL_SIZE);
    if (size === 0) return createEphemeralLease();

    let taken = takeFreeProfile(size);
    while (!taken) {
        // Every profile is in use — wait for the next release, then retry.
        await new Promise(resolve => waiting.push(resolve));
        taken = takeFreeProfile(size);
    }

    let released = false;
    return {
        id: taken.id,
        dir: taken.dir,
        pooled: true,
        release() {
            if (released) return;
            released = true;
            releasePooled(taken.id);
        },
    };
}

/**
 * Delete every pooled profile from disk. Exposed so the UI can offer a reset —
 * a pooled profile accumulates extension state deliberately, so the only way
 * to start the panel's view over is to wipe it.
 * @returns {{removed: number, dir: string}}
 */
function resetPool() {
    const dir = getBaseDir();
    let removed = 0;
    for (const [, entry] of profiles) {
        if (entry.busy) continue;
        removed += 1;
    }
    profiles.clear();
    try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // Leave it for the next run rather than failing the reset.
    }
    return { removed, dir };
}

/**
 * Current pool state, for logs and tests.
 */
function getPoolStats() {
    let busy = 0;
    for (const [, entry] of profiles) if (entry.busy) busy += 1;
    return { total: profiles.size, busy, waiting: waiting.length, dir: getBaseDir() };
}

/**
 * Bytes the pooled profiles occupy on disk.
 *
 * A pooled profile is roughly 14 MB and grows as the extension accumulates
 * state — which is the point, but it means a large pool is not free. Nothing
 * caps a profile's size, so the figure is reported rather than enforced.
 *
 * @returns {{bytes: number, profiles: number, dir: string}}
 */
function getPoolDiskUsage() {
    const dir = getBaseDir();
    const result = { bytes: 0, profiles: 0, dir };
    if (!fs.existsSync(dir)) return result;

    const walk = (d) => {
        let entries;
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else {
                try { result.bytes += fs.statSync(full).size; } catch { /* vanished */ }
            }
        }
    };

    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            result.profiles += 1;
            walk(path.join(dir, entry.name));
        }
    } catch {
        // Unreadable pool directory — report what we have.
    }
    return result;
}

module.exports = {
    acquireProfile,
    resetPool,
    getPoolStats,
    getPoolDiskUsage,
    setBaseDir,
    getBaseDir,
    MAX_POOL_SIZE,
};
