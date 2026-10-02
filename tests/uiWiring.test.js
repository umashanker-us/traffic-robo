/**
 * UI wiring
 *
 * src/ui/index.html is one 2,967-line document — markup, styles and renderer
 * script together — and until now nothing checked it at all. The failure mode
 * that matters is silent: a button whose handler was renamed, an api.* call the
 * preload bridge no longer exposes, or a getElementById for an element that was
 * removed. None of those break the build, break any other test, or show up
 * until a user clicks the control.
 *
 * These are static checks on the file. They cannot tell whether the UI looks
 * right, but they do guarantee every control still reaches something real.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');

const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
const markup = html.slice(html.indexOf('<body>'), html.indexOf('<script>'));

const uniq = (a) => [...new Set(a)];
const matches = (re, s) => [...s.matchAll(re)].map(m => m[1]);

/** Functions reachable from an inline handler. */
const definedFunctions = new Set([
    ...matches(/function\s+([A-Za-z_$][\w$]*)\s*\(/g, script),
    ...matches(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g, script),
    ...matches(/window\.([A-Za-z_$][\w$]*)\s*=/g, script),
]);

// Provided by the browser, not by our script.
const BUILT_IN = new Set(['alert', 'confirm', 'prompt', 'console']);

describe('every control reaches something that exists', () => {
    const handlers = matches(/on(?:click|change|input|submit)="([^"]+)"/g, html).map(h => h.trim());

    test('the file still has its controls (so a broken read cannot pass silently)', () => {
        expect(handlers.length).toBeGreaterThan(20);
        expect(definedFunctions.size).toBeGreaterThan(20);
    });

    test('no inline handler calls a function that is not defined', () => {
        const called = uniq(handlers
            .map(h => (h.match(/^([A-Za-z_$][\w$]*)\s*\(/) || [])[1])
            .filter(Boolean));
        const missing = called.filter(n => !definedFunctions.has(n) && !BUILT_IN.has(n));
        expect(missing).toEqual([]);
    });
});

describe('the preload bridge', () => {
    const apiCalls = uniq(matches(/\bapi\.([A-Za-z_$][\w$]*)/g, html));
    const exposed = new Set(matches(/^\s{4}([A-Za-z_$][\w$]*)\s*:/gm, preload));

    test('the UI does use the bridge', () => {
        expect(apiCalls.length).toBeGreaterThan(10);
        expect(exposed.size).toBeGreaterThan(10);
    });

    // The renderer has no node integration, so an unexposed channel is not a
    // fallback — the call is simply undefined and the click throws.
    test('every api.* call the UI makes is exposed by the preload', () => {
        expect(apiCalls.filter(n => !exposed.has(n))).toEqual([]);
    });

    test('the bridge is the only way in — no node integration in the renderer', () => {
        const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
        expect(main).toMatch(/nodeIntegration:\s*false/);
        expect(main).toMatch(/contextIsolation:\s*true/);
    });
});

describe('the DOM the script talks to', () => {
    const ids = new Set(matches(/\bid="([^"]+)"/g, markup));
    const looked = uniq(matches(/getElementById\(\s*'([^']+)'\s*\)/g, script));

    test('the script does reach into the DOM', () => {
        expect(looked.length).toBeGreaterThan(50);
    });

    test('every getElementById target is present in the markup', () => {
        expect(looked.filter(id => !ids.has(id))).toEqual([]);
    });

    // A duplicate id is a silent bug: getElementById keeps the first and the
    // second control stops responding.
    test('no id is declared twice', () => {
        const counts = {};
        for (const m of markup.matchAll(/\bid="([^"]+)"/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
        expect(Object.entries(counts).filter(([, n]) => n > 1)).toEqual([]);
    });
});

describe('the extension profile pool', () => {
    // A pool of 0 gives every visit a throwaway profile: the extension is
    // reinstalled each time, keeps no consent and no history, and opens its
    // welcome tab on every single visit. 0 was the markup default *and* the
    // fallback in the config gather, so ticking "extension" and changing
    // nothing produced an extension that reported nothing at all.
    test('the markup default is a usable pool, not 0', () => {
        const field = html.match(/<input[^>]*id="extensionProfilePool"[^>]*>/)[0];
        const value = Number(field.match(/value="(\d+)"/)[1]);
        expect(value).toBeGreaterThan(0);
    });

    test('the config gather goes through the guard, not a bare || 0', () => {
        expect(script).toMatch(/extensionProfilePool:\s*profilePoolForRun\(\)/);
        expect(script).not.toMatch(/extensionProfilePool:\s*parseInt\([^)]*\)\s*\|\|\s*0/);
    });

    test('the guard only raises the pool when the extension is on', () => {
        const fn = script.slice(
            script.indexOf('function profilePoolForRun'),
            script.indexOf('function ensureProfilePoolSane'));
        expect(fn).toMatch(/extensionEnabled'\)\.checked/);
        expect(fn).toMatch(/if \(asked > 0\) return asked;/);   // an explicit 0 is still honoured when off
        expect(fn).toMatch(/threads/);
    });

    test('a saved config of 0 is corrected when it is applied', () => {
        const loader = script.slice(
            script.indexOf("config.extensionProfilePool !== undefined"),
            script.indexOf("config.extensionProfilePool !== undefined") + 600);
        expect(loader).toMatch(/ensureProfilePoolSane\(\)/);
    });

    test('the pool state on disk is shown, so Reset visibly does something', () => {
        expect(script).toMatch(/api\.getExtensionProfileStats\(\)/);
    });

    test('the channel behind that is actually handled in main', () => {
        const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
        expect(main).toMatch(/ipcMain\.handle\('get-extension-profile-stats'/);
    });
});

describe('the settings the UI collects', () => {
    // Settings that exist in the engine but have no control cannot be reached
    // by a user, however well they work.
    test.each([
        ['extensionEnabled', /extensionEnabled/],
        ['extensionPath', /extensionPath/],
        ['extensionProfilePool', /extensionProfilePool/],
        ['percOldUsers', /percOldUsers/],
        ['restrictToPrimaryDomain', /restrictToPrimaryDomain/],
        ['ipRotation', /ipRotation/],
        ['playMode', /playMode/],
        ['userAgentType', /userAgentType/],
    ])('%s is wired up in the UI', (_name, re) => {
        expect(html).toMatch(re);
    });
});
