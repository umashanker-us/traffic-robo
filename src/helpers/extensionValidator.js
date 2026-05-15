const fs = require('fs');
const path = require('path');

const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * Validate that a user-selected directory is a sane unpacked Chrome extension.
 * Checks the resolved real path, parses manifest.json, and enforces required
 * fields and a manifest size cap so a path-traversal symlink or a giant
 * malicious manifest can't slip through.
 *
 * Returns:
 *   { valid: true,  path, name, version, manifestVersion }
 *   { valid: false, error }
 */
function validateExtensionDir(extensionPath) {
    if (typeof extensionPath !== 'string' || extensionPath.length === 0) {
        return { valid: false, error: 'No path provided' };
    }

    let resolved;
    try {
        resolved = fs.realpathSync(path.resolve(extensionPath));
    } catch (e) {
        return { valid: false, error: `Path does not exist or is unreadable: ${e.message}` };
    }

    let stat;
    try {
        stat = fs.statSync(resolved);
    } catch (e) {
        return { valid: false, error: `Cannot stat path: ${e.message}` };
    }
    if (!stat.isDirectory()) {
        return { valid: false, error: 'Selected path is not a directory' };
    }

    const manifestPath = path.join(resolved, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        return { valid: false, error: 'manifest.json not found in selected folder' };
    }

    const manifestStat = fs.statSync(manifestPath);
    if (manifestStat.size > MAX_MANIFEST_BYTES) {
        return { valid: false, error: `manifest.json is too large (${manifestStat.size} bytes)` };
    }

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
        return { valid: false, error: `manifest.json is not valid JSON: ${e.message}` };
    }

    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return { valid: false, error: 'manifest.json must be a JSON object' };
    }

    const mv = manifest.manifest_version;
    if (mv !== 2 && mv !== 3) {
        return { valid: false, error: `Unsupported manifest_version: ${mv}` };
    }

    if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
        return { valid: false, error: 'manifest.json missing required "name" field' };
    }

    if (typeof manifest.version !== 'string' || manifest.version.trim().length === 0) {
        return { valid: false, error: 'manifest.json missing required "version" field' };
    }

    return {
        valid: true,
        path: resolved,
        name: manifest.name,
        version: manifest.version,
        manifestVersion: mv,
    };
}

module.exports = { validateExtensionDir, MAX_MANIFEST_BYTES };
