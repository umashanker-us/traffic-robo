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
const { execSync } = require('child_process');

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
 * Extract a CRX file to a directory.
 * Strips CRX header → writes temp ZIP → extracts via PowerShell (always
 * available on Windows, no dependency on extract-zip inside asar).
 */
async function extractCrx(crxPath, destDir) {
    const crxBuffer = fs.readFileSync(crxPath);
    const zipOffset = findZipOffset(crxBuffer);
    const zipBuffer = crxBuffer.slice(zipOffset);

    const tmpZip = crxPath + '.zip';
    fs.writeFileSync(tmpZip, zipBuffer);

    fs.mkdirSync(destDir, { recursive: true });

    // PowerShell Expand-Archive — works on all Windows 10/11 without extra deps
    try {
        execSync(
            `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${destDir}' -Force"`,
            { timeout: 60000 }
        );
    } finally {
        try { fs.unlinkSync(tmpZip); } catch {}
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
