/**
 * Disk retention
 *
 * Session replays were written per visit and never removed: the directory had
 * grown to 483 files with nothing to cap it. ReplayStore caps what is held in
 * memory at 100, which says nothing about disk. Loose log files from an older
 * logging layout also sat at the root of logs/ where cleanOldLogs — which only
 * matches YYYY-MM directories — could never see them.
 *
 * Both sweeps run at startup, are best-effort, and never throw into the caller:
 * failing to tidy up must not stop a campaign.
 */

const fs = require('fs');
const path = require('path');
const Constants = require('./constants');

const DEFAULT_MAX_REPLAY_FILES = 2000;
const DEFAULT_MAX_LOOSE_LOG_AGE_DAYS = 30;

/**
 * Keep only the newest `maxFiles` replay JSON files, across every campaign
 * subdirectory, deleting the oldest first.
 *
 * @param {Object} [options]
 * @param {number} [options.maxFiles=2000]
 * @param {string} [options.replaysDir] - defaults to <DATA_PATH>/replays
 * @returns {{scanned: number, removed: number, keptBytes: number}}
 */
function pruneReplays({ maxFiles = DEFAULT_MAX_REPLAY_FILES, replaysDir } = {}) {
    const dir = replaysDir || path.join(Constants.DATA_PATH || 'data', 'replays');
    const result = { scanned: 0, removed: 0, keptBytes: 0 };
    if (!fs.existsSync(dir)) return result;

    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return result;
    }

    const files = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const full = path.join(dir, entry.name);
        try {
            const stat = fs.statSync(full);
            files.push({ full, mtime: stat.mtimeMs, size: stat.size });
        } catch {
            // Vanished between readdir and stat — nothing to do.
        }
    }

    result.scanned = files.length;
    if (files.length <= maxFiles) {
        result.keptBytes = files.reduce((a, f) => a + f.size, 0);
        return result;
    }

    // Newest first, then drop everything past the cap.
    files.sort((a, b) => b.mtime - a.mtime);
    const keep = files.slice(0, maxFiles);
    const drop = files.slice(maxFiles);

    for (const f of drop) {
        try {
            fs.unlinkSync(f.full);
            result.removed += 1;
        } catch {
            // Locked or already gone; the next run will catch it.
        }
    }
    result.keptBytes = keep.reduce((a, f) => a + f.size, 0);
    return result;
}

/**
 * Remove loose *.log files sitting at the root of the logs directory once they
 * are older than maxAgeDays. The per-campaign directories are handled by
 * cleanOldLogs; these are leftovers from the flat layout that predates it.
 *
 * @param {Object} [options]
 * @param {number} [options.maxAgeDays=30]
 * @param {string} [options.logsDir]
 * @returns {{removed: number}}
 */
function pruneLooseLogs({ maxAgeDays = DEFAULT_MAX_LOOSE_LOG_AGE_DAYS, logsDir } = {}) {
    const dir = logsDir || Constants.LOGS_PATH;
    const result = { removed: 0 };
    if (!dir || !fs.existsSync(dir)) return result;

    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return result;
    }

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
        const full = path.join(dir, entry.name);
        try {
            if (fs.statSync(full).mtimeMs >= cutoff) continue;
            fs.unlinkSync(full);
            result.removed += 1;
        } catch {
            // Held open by a transport, or already gone.
        }
    }
    return result;
}

module.exports = {
    pruneReplays,
    pruneLooseLogs,
    DEFAULT_MAX_REPLAY_FILES,
    DEFAULT_MAX_LOOSE_LOG_AGE_DAYS,
};
