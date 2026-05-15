const fs = require('fs');
const path = require('path');
const os = require('os');
const { validateExtensionDir, MAX_MANIFEST_BYTES } = require('../src/helpers/extensionValidator');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ext-validator-'));
}

function writeManifest(dir, content) {
    const p = path.join(dir, 'manifest.json');
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
    return p;
}

describe('validateExtensionDir', () => {
    let tmp;
    beforeEach(() => { tmp = makeTempDir(); });
    afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

    test('accepts a valid MV3 extension', () => {
        writeManifest(tmp, { manifest_version: 3, name: 'My Ext', version: '1.0.0' });
        const result = validateExtensionDir(tmp);
        expect(result.valid).toBe(true);
        expect(result.name).toBe('My Ext');
        expect(result.version).toBe('1.0.0');
        expect(result.manifestVersion).toBe(3);
    });

    test('accepts a valid MV2 extension', () => {
        writeManifest(tmp, { manifest_version: 2, name: 'Legacy', version: '0.1' });
        const result = validateExtensionDir(tmp);
        expect(result.valid).toBe(true);
        expect(result.manifestVersion).toBe(2);
    });

    test('rejects unsupported manifest_version', () => {
        writeManifest(tmp, { manifest_version: 1, name: 'Old', version: '0.1' });
        const result = validateExtensionDir(tmp);
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/manifest_version/);
    });

    test('rejects missing name', () => {
        writeManifest(tmp, { manifest_version: 3, version: '1.0' });
        const result = validateExtensionDir(tmp);
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/name/);
    });

    test('rejects missing version', () => {
        writeManifest(tmp, { manifest_version: 3, name: 'No Ver' });
        const result = validateExtensionDir(tmp);
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/version/);
    });

    test('rejects empty name string', () => {
        writeManifest(tmp, { manifest_version: 3, name: '   ', version: '1.0' });
        const result = validateExtensionDir(tmp);
        expect(result.valid).toBe(false);
    });

    test('rejects malformed JSON manifest', () => {
        writeManifest(tmp, '{not valid json');
        const result = validateExtensionDir(tmp);
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/valid JSON/);
    });

    test('rejects directory without manifest.json', () => {
        const result = validateExtensionDir(tmp);
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/manifest.json not found/);
    });

    test('rejects non-existent path', () => {
        const result = validateExtensionDir(path.join(tmp, 'does-not-exist'));
        expect(result.valid).toBe(false);
    });

    test('rejects file (not directory)', () => {
        const filePath = path.join(tmp, 'a-file.txt');
        fs.writeFileSync(filePath, 'hi');
        const result = validateExtensionDir(filePath);
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/not a directory/);
    });

    test('rejects empty / non-string path', () => {
        expect(validateExtensionDir('').valid).toBe(false);
        expect(validateExtensionDir(null).valid).toBe(false);
        expect(validateExtensionDir(undefined).valid).toBe(false);
    });

    test('rejects oversized manifest', () => {
        const huge = 'a'.repeat(MAX_MANIFEST_BYTES + 1);
        fs.writeFileSync(path.join(tmp, 'manifest.json'), `{"name":"x","version":"1","manifest_version":3,"junk":"${huge}"}`);
        const result = validateExtensionDir(tmp);
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/too large/);
    });

    test('rejects array manifest (must be object)', () => {
        writeManifest(tmp, '[1,2,3]');
        const result = validateExtensionDir(tmp);
        expect(result.valid).toBe(false);
    });

    test('returns resolved realpath', () => {
        writeManifest(tmp, { manifest_version: 3, name: 'X', version: '1' });
        const result = validateExtensionDir(tmp);
        expect(result.valid).toBe(true);
        expect(path.isAbsolute(result.path)).toBe(true);
    });
});
