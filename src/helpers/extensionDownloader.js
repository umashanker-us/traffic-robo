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

/**
 * Download CRX and save to a temp file.
 */
async function downloadCrx(extensionId, destPath) {
    const url = getCrxDownloadUrl(extensionId);
    const res = await httpsGet(url);
    const file = fs.createWriteStream(destPath);
    await pipeline(res, file);
}

/**
 * Strip the CRX header and return the offset where the ZIP starts.
 * CRX3: Cr24 + version(4) + header_length(4) + header(N) + ZIP
 * CRX2: Cr24 + version(4) + pubkey_len(4) + sig_len(4) + pubkey + sig + ZIP
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
 * Strips CRX header → writes temp ZIP → extracts with yauzl/extract-zip.
 */
async function extractCrx(crxPath, destDir) {
    const crxBuffer = fs.readFileSync(crxPath);
    const zipOffset = findZipOffset(crxBuffer);
    const zipBuffer = crxBuffer.slice(zipOffset);

    const tmpZip = crxPath + '.zip';
    fs.writeFileSync(tmpZip, zipBuffer);

    // extract-zip is bundled with Electron
    let extractZip;
    try {
        extractZip = require('extract-zip');
    } catch {
        // Fallback: use PowerShell Expand-Archive on Windows
        const { execSync } = require('child_process');
        fs.mkdirSync(destDir, { recursive: true });
        execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${destDir}' -Force"`, { timeout: 30000 });
        fs.unlinkSync(tmpZip);
        return;
    }

    fs.mkdirSync(destDir, { recursive: true });
    await extractZip(tmpZip, { dir: destDir });
    fs.unlinkSync(tmpZip);
}

/**
 * Download and extract a Chrome extension from Chrome Web Store.
 *
 * @param {string} extensionId - Chrome Web Store extension ID
 * @param {string} destDir     - Where to extract (e.g. userData/extensions/similarweb)
 * @param {Function} logger    - Optional logger (info, warn)
 * @returns {{ success, name, version, error }}
 */
async function downloadAndExtractExtension(extensionId, destDir, logger = null) {
    const log = (level, msg) => logger ? logger[level](msg) : console.log(`[${level}] ${msg}`);

    try {
        log('info', `Downloading extension ${extensionId} from Chrome Web Store...`);
        const crxPath = destDir + '.crx';
        await downloadCrx(extensionId, crxPath);
        log('info', `CRX downloaded (${(fs.statSync(crxPath).size / 1024).toFixed(0)} KB)`);

        // Clean destination before extracting
        if (fs.existsSync(destDir)) {
            fs.rmSync(destDir, { recursive: true, force: true });
        }

        await extractCrx(crxPath, destDir);
        fs.unlinkSync(crxPath);

        // Validate extracted extension
        const manifestPath = path.join(destDir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            return { success: false, error: 'Extracted extension has no manifest.json' };
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        log('info', `Extension extracted: ${manifest.name} v${manifest.version}`);

        return {
            success: true,
            name: manifest.name || 'Unknown',
            version: manifest.version || '0.0.0',
            path: destDir,
        };
    } catch (e) {
        log('warn', `Extension download failed: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/**
 * Get the persistent extension directory in userData.
 */
function getExtensionDir(userDataPath) {
    return path.join(userDataPath, 'extensions', 'similarweb');
}

module.exports = {
    downloadAndExtractExtension,
    getExtensionDir,
    SIMILARWEB_EXTENSION_ID,
};
