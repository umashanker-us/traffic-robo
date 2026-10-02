/**
 * Closing the extension's own tabs
 *
 * The SimilarWeb extension opens a welcome tab of its own, and on this network
 * that tab never finishes: the ISP DNS-blocks www.similarweb.com (202.56.230.30,
 * TCP times out) while similarweb.com, rank. and data. resolve to AWS and
 * connect in under 600ms.
 *
 * The first version of this waited for the tab's 'commit' before reading its
 * URL — which is precisely why a blocked tab sat on screen for ~22 seconds,
 * until ERR_CONNECTION_TIMED_OUT finally committed an error page. The close now
 * triggers on the navigation request, which names the target immediately.
 *
 * Measured against the live extension after the change:
 *   www.similarweb.com (blocked)   closed after 82 ms
 *   similarweb.com welcome         closed after 70 ms
 *   chrome-extension:// options    closed after 90 ms
 *   example.com                    left open
 *   campaign page                  left open
 */

const fs = require('fs');
const path = require('path');
const { isExtensionOwnPage } = require('../src/core/browserSession');

describe('isExtensionOwnPage', () => {
    test.each([
        'https://www.similarweb.com/',
        'https://similarweb.com/corp/extension-welcome',
        'https://rank.similarweb.com/api/v1/rank',
        'https://data.similarweb.com/x',
        'https://data.similargroup.com/y',
        'chrome-extension://bnkahfchigflcimbhmdcednfpmhkcehc/options/options.html',
        'chrome-error://chromewebdata/',
    ])('closes %s', (url) => {
        expect(isExtensionOwnPage(url)).toBe(true);
    });

    test.each([
        'https://carnbikecafe.com/',
        'https://e4mevents.com/smartlink/s/A5Tdts',
        'https://www.google-analytics.com/g/collect?v=2',
        'about:blank',
    ])('leaves %s alone', (url) => {
        expect(isExtensionOwnPage(url)).toBe(false);
    });

    // Anchored on a subdomain boundary, so a lookalike host is not swept up.
    test.each([
        'https://notsimilarweb.com/',
        'https://similarweb.com.phish.test/',
        'https://mysimilargroup.com/',
    ])('is not fooled by %s', (url) => {
        expect(isExtensionOwnPage(url)).toBe(false);
    });

    test.each([['empty', ''], ['null', null], ['undefined', undefined], ['a number', 42], ['garbage', 'http://[']])
        ('%s is not a match and does not throw', (_label, url) => {
            expect(() => isExtensionOwnPage(url)).not.toThrow();
            expect(isExtensionOwnPage(url)).toBe(false);
        });
});

describe('what the close is wired to', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'core', 'browserSession.js'), 'utf8');
    const handler = source.slice(
        source.indexOf('const closeIfExtensionOwn'),
        source.indexOf("page.on('framenavigated'"));

    // The regression this guards: a close that waits for the tab to load first
    // cannot fire on a tab that never loads.
    test('it does not wait for the tab to load before deciding', () => {
        expect(handler).not.toMatch(/waitForLoadState/);
        expect(handler).not.toMatch(/waitForNavigation/);
    });

    test('a navigation request is what triggers it', () => {
        expect(handler).toMatch(/isNavigationRequest/);
    });

    test('framenavigated backs it up for navigations with no visible request', () => {
        expect(source).toMatch(/page\.on\('framenavigated'/);
    });

    test('the campaign page and the consent flow are both exempt', () => {
        expect(handler).toMatch(/this\._grantingConsent/);
        expect(handler).toMatch(/page === this\.page/);
    });

    test('only the main frame counts, so an embedded widget is not mistaken for a tab', () => {
        expect(handler).toMatch(/mainFrame\(\)/);
    });
});
