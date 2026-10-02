/**
 * Download and extract Chrome extensions from Chrome Web Store.
 *
 * CRX format: "Cr24" magic + version(4B) + header_length(4B) + header + ZIP
 * We skip the CRX header and extract the embedded ZIP.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');

const SIMILARWEB_EXTENSION_ID = 'hoklmmgfnpapgjgcpechhaamimifchmp';

const CHROME_VERSION = '130.0.6723.70';

function getCrxDownloadUrl(extensionId) {
    const x = encodeURIComponent(`id=${extensionId}&installsource=ondemand&uc`);
    return `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=${CHROME_VERSION}&x=${x}`;
}

function httpsGet(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        https.get(url, { headers: { 'User-Agent': `Mozilla/5.0 Chrome/${CHROME_VERSION}` } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(httpsGet(res.headers.location, maxRedirects - 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            resolve(res);
        }).on('error', reject);
    });
}

async function downloadCrx(extensionId, destPath) {
    const dir = path.dirname(destPath);
    fs.mkdirSync(dir, { recursive: true });
    const url = getCrxDownloadUrl(extensionId);
    const res = await httpsGet(url);
    const file = fs.createWriteStream(destPath);
    await pipeline(res, file);
}

/**
 * Strip the CRX header and return the offset where the ZIP starts.
 */
function findZipOffset(buffer) {
    const magic = buffer.toString('ascii', 0, 4);
    if (magic !== 'Cr24') throw new Error('Not a CRX file');
    const version = buffer.readUInt32LE(4);
    if (version === 3) {
        const headerLen = buffer.readUInt32LE(8);
        return 12 + headerLen;
    }
    if (version === 2) {
        const pubkeyLen = buffer.readUInt32LE(8);
        const sigLen = buffer.readUInt32LE(12);
        return 16 + pubkeyLen + sigLen;
    }
    throw new Error(`Unknown CRX version: ${version}`);
}

/**
 * Read a ZIP's central directory and return its entries.
 *
 * Only what a Web Store CRX contains: stored and deflated entries, no
 * encryption, no zip64. Anything else throws rather than writing a corrupt file.
 */
function readZipEntries(buf) {
    // End of central directory, signature 0x06054b50. Scanned from the back
    // because the trailing comment field has no fixed length.
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP end-of-central-directory not found');

    const count = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);
    if (offset === 0xffffffff) throw new Error('zip64 archives are not supported');

    const entries = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory entry');
        entries.push({
            method: buf.readUInt16LE(offset + 10),
            compressedSize: buf.readUInt32LE(offset + 20),
            localOffset: buf.readUInt32LE(offset + 42),
            name: buf.toString('utf8', offset + 46, offset + 46 + buf.readUInt16LE(offset + 28)),
        });
        offset += 46 + buf.readUInt16LE(offset + 28)
                     + buf.readUInt16LE(offset + 30)
                     + buf.readUInt16LE(offset + 32);
    }
    return entries;
}

/**
 * Extract one entry, taking the data offset from its local header so a trailing
 * data descriptor cannot mislead us.
 */
function readZipEntry(buf, entry) {
    const h = entry.localOffset;
    if (buf.readUInt32LE(h) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
    const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
    const data = buf.slice(start, start + entry.compressedSize);

    if (entry.method === 0) return data;                      // stored
    if (entry.method === 8) return zlib.inflateRawSync(data);  // deflate
    throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}

/**
 * Extract a CRX to a directory, in Node rather than by shelling out.
 *
 * The previous version called PowerShell's Expand-Archive and passed the paths
 * as `$args[0]`/`$args[1]`, which `powershell -Command` never populates — only
 * `-File` does — so extraction failed outright with "argument is null or empty"
 * and the in-app Download button did nothing. Interpolating the paths into the
 * command string instead is what that change was avoiding, because a profile
 * like C:\Users\O'Brien breaks the quoting. Inflating here removes both
 * problems, and the shell dependency with them.
 */
async function extractCrx(crxPath, destDir) {
    const crxBuffer = fs.readFileSync(crxPath);
    const zipBuffer = crxBuffer.slice(findZipOffset(crxBuffer));

    fs.mkdirSync(destDir, { recursive: true });
    const root = path.resolve(destDir);

    for (const entry of readZipEntries(zipBuffer)) {
        const relative = entry.name.replace(/\\/g, '/');
        if (relative.endsWith('/')) continue;                 // directory marker

        // Refuse anything that would land outside the extension directory.
        const target = path.resolve(root, relative);
        if (target !== root && !target.startsWith(root + path.sep)) {
            throw new Error(`refusing to write outside the extension directory: ${entry.name}`);
        }

        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, readZipEntry(zipBuffer, entry));
    }
}

/**
 * Resolve __MSG_key__ placeholders from _locales/en/messages.json.
 */
function resolveI18nName(manifest, destDir) {
    let name = manifest.name || 'Unknown';
    const match = name.match(/^__MSG_(\w+)__$/);
    if (!match) return name;
    try {
        const locale = manifest.default_locale || 'en';
        const msgsPath = path.join(destDir, '_locales', locale, 'messages.json');
        const msgs = JSON.parse(fs.readFileSync(msgsPath, 'utf8'));
        return (msgs[match[1]] && msgs[match[1]].message) || name;
    } catch {
        return name;
    }
}

/**
 * Download and extract a Chrome extension from Chrome Web Store.
 */
async function downloadAndExtractExtension(extensionId, destDir, logger = null) {
    const log = (level, msg) => logger ? logger[level](msg) : console.log(`[${level}] ${msg}`);

    try {
        log('info', `Downloading extension ${extensionId} from Chrome Web Store...`);
        const crxPath = destDir + '.crx';
        await downloadCrx(extensionId, crxPath);
        log('info', `CRX downloaded (${(fs.statSync(crxPath).size / 1024).toFixed(0)} KB)`);

        if (fs.existsSync(destDir)) {
            fs.rmSync(destDir, { recursive: true, force: true });
        }

        await extractCrx(crxPath, destDir);
        try { fs.unlinkSync(crxPath); } catch {}

        const manifestPath = path.join(destDir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            return { success: false, error: 'Extracted extension has no manifest.json' };
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const name = resolveI18nName(manifest, destDir);
        log('info', `Extension extracted: ${name} v${manifest.version}`);

        return {
            success: true,
            name,
            version: manifest.version || '0.0.0',
            path: destDir,
        };
    } catch (e) {
        log('warn', `Extension download failed: ${e.message}`);
        return { success: false, error: e.message };
    }
}

function getExtensionDir(userDataPath) {
    return path.join(userDataPath, 'extensions', 'similarweb');
}

module.exports = {
    downloadAndExtractExtension,
    getExtensionDir,
    SIMILARWEB_EXTENSION_ID,
};
