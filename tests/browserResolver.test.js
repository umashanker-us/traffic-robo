/**
 * Browser resolution
 *
 * Two measured facts drive this module. The bundled Chromium reports
 * navigator.plugins.length 0, navigator.mimeTypes.length 0 and
 * pdfViewerEnabled false — no real browser does. And generated user agents
 * claimed Chrome 140-143 while the engine was Chromium 145, or would claim 143
 * while running the installed Chrome 154; feature detection does not lie, so a
 * page can see APIs the claimed version never shipped.
 *
 * So: drive real Chrome when it is installed, fall back to the bundled Chromium
 * otherwise, and pin every generated UA to whichever one actually runs.
 */

const path = require('path');
const {
    parseVersion,
    findInstalledChrome,
    resolveBrowser,
    getResolvedBrowser,
    resetResolvedBrowser,
} = require('../src/helpers/browserResolver');

const { setRuntimeChromeVersion, getRuntimeChromeVersion, generateChromeUA } = require('../src/helpers/userAgents');

afterEach(() => {
    resetResolvedBrowser();
    setRuntimeChromeVersion(null);
});

describe('parseVersion', () => {
    test('pulls the dotted quad out of a plain version', () => {
        expect(parseVersion('154.0.8037.59')).toBe('154.0.8037.59');
    });

    test('pulls it out of a prefixed version string', () => {
        expect(parseVersion('HeadlessChrome/145.0.7632.6')).toBe('145.0.7632.6');
    });

    test('returns null for anything without one', () => {
        expect(parseVersion('')).toBeNull();
        expect(parseVersion(null)).toBeNull();
        expect(parseVersion('Chrome')).toBeNull();
        expect(parseVersion('154.0')).toBeNull();
    });
});

describe('findInstalledChrome', () => {
    test('returns an absolute chrome.exe path or null, never a guess', () => {
        const found = findInstalledChrome();
        if (found === null) return;
        expect(path.isAbsolute(found)).toBe(true);
        expect(found.toLowerCase().endsWith('chrome.exe')).toBe(true);
    });
});

describe('resolveBrowser', () => {
    // Launches a browser, so give it room.
    jest.setTimeout(90000);

    test('resolves to a launchable browser and reads its real version', async () => {
        const info = await resolveBrowser({});
        expect(info).toBeTruthy();
        expect(['chrome', 'chromium-bundled', 'chromium', 'unknown']).toContain(info.kind);
        if (info.kind !== 'unknown') {
            expect(info.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
        }
    });

    test('the decision is cached — the probe must not relaunch per visit', async () => {
        const first = await resolveBrowser({});
        const second = await resolveBrowser({});
        expect(second).toBe(first);
        expect(getResolvedBrowser()).toBe(first);
    });

    test('resetting clears the cached decision', async () => {
        await resolveBrowser({});
        expect(getResolvedBrowser()).not.toBeNull();
        resetResolvedBrowser();
        expect(getResolvedBrowser()).toBeNull();
    });

    test('exactly one of channel or executablePath is set, never both', async () => {
        const info = await resolveBrowser({});
        if (info.kind === 'chrome') {
            expect(info.channel).toBe('chrome');
            expect(info.executablePath).toBeNull();
        } else if (info.kind === 'chromium-bundled') {
            expect(info.channel).toBeNull();
            expect(info.executablePath).toBeTruthy();
        }
    });

    test('declining Chrome still resolves to a working Chromium', async () => {
        const info = await resolveBrowser({ preferInstalledChrome: false });
        expect(info.kind).not.toBe('chrome');
        if (info.kind !== 'unknown') {
            expect(info.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
        }
    });

    test('a bundled path that cannot launch does not become the choice', async () => {
        const info = await resolveBrowser({
            preferInstalledChrome: false,
            bundledPath: 'C:\\does\\not\\exist\\chrome.exe',
        });
        // It falls through to Playwright's own Chromium, where there is no
        // executablePath at all — the unusable path must not be carried forward.
        expect(info.executablePath || '').not.toContain('does\\not\\exist');
        expect(['chromium', 'unknown']).toContain(info.kind);
    });
});

describe('the resolved version reaches the user agents', () => {
    jest.setTimeout(90000);

    test('every generated UA claims the engine that will run it', async () => {
        const info = await resolveBrowser({});
        if (!info.version) return;                 // no browser available here
        setRuntimeChromeVersion(info.version);

        const [major, , build] = info.version.split('.');
        expect(getRuntimeChromeVersion()).toMatchObject({ major, build });

        for (let i = 0; i < 25; i++) {
            const m = generateChromeUA('desktop').match(/Chrome\/(\d+)\.0\.(\d+)\./);
            expect(m[1]).toBe(major);
            expect(m[2]).toBe(build);
        }
    });
});
