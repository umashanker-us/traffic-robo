/**
 * A file download never goes through the proxy
 *
 * Custom proxy patterns are a plain substring match over the whole URL, which is
 * what makes a CM360 click id matchable. It is also what let the pattern
 * "e4mevents" match storage.googleapis.com/e4mevents/Pitch-bfsi.pdf and push a
 * 2.5 MB file through the proxy on every visit. Attribution is decided by the
 * tracker hop, not by who downloads the asset, so proxying the file buys
 * nothing and costs the whole file.
 */

const {
    matchesCustomProxyPattern,
    isFileDownloadUrl,
    NEVER_PROXY_EXTENSIONS,
} = require('../src/helpers/proxyRouter');

const SMARTLINK = 'https://e4mevents.com/smartlink/s/A5Tdts';
const PDF = 'https://storage.googleapis.com/e4mevents/Saptharushi/Pitch-bfsi.pdf';

describe('isFileDownloadUrl', () => {
    test.each([
        'https://cdn.test/deck.pdf',
        'https://cdn.test/bundle.zip',
        'https://cdn.test/clip.mp4',
        'https://cdn.test/song.mp3',
        'https://cdn.test/report.xlsx',
        'https://cdn.test/font.woff2',
        'https://cdn.test/setup.exe',
    ])('%s is a file', url => expect(isFileDownloadUrl(url)).toBe(true));

    test.each([
        'https://site.test/',
        'https://site.test/landing',
        'https://e4mevents.com/smartlink/s/A5Tdts',
        'https://ad.doubleclick.net/ddm/trackclk/N768950',
    ])('%s is not a file', url => expect(isFileDownloadUrl(url)).toBe(false));

    test('a query string cannot disguise a file', () => {
        expect(isFileDownloadUrl('https://cdn.test/deck.pdf?utm_source=x&gclid=y')).toBe(true);
    });

    test('an extension appearing only in the query does not make it a file', () => {
        expect(isFileDownloadUrl('https://site.test/landing?file=deck.pdf')).toBe(false);
    });

    test('case does not matter', () => {
        expect(isFileDownloadUrl('https://cdn.test/DECK.PDF')).toBe(true);
    });

    test('a malformed URL is not a file', () => {
        expect(isFileDownloadUrl('not a url')).toBe(false);
    });
});

describe('matchesCustomProxyPattern excludes files', () => {
    // The exact case from the field: a pattern without .com matched the PDF's path.
    test.each(['e4mevents', 'e4mevents.com', 'storage.googleapis.com'])(
        'pattern %s proxies the tracker but never the PDF', (pattern) => {
            expect(matchesCustomProxyPattern(PDF, [pattern])).toBe(false);
        });

    test('the smartlink itself is still proxied', () => {
        expect(matchesCustomProxyPattern(SMARTLINK, ['e4mevents'])).toBe(true);
        expect(matchesCustomProxyPattern(SMARTLINK, ['e4mevents.com'])).toBe(true);
    });

    // A 1x1 impression pixel is often a .gif or .png and does need the proxy IP.
    test('impression pixels are still proxied', () => {
        expect(matchesCustomProxyPattern(
            'https://ad.doubleclick.net/ddm/trackimp/N768950/pixel.gif?x=1',
            ['doubleclick.net/ddm'],
        )).toBe(true);
        expect(matchesCustomProxyPattern(
            'https://tracker.test/imp.png?id=1', ['tracker.test'],
        )).toBe(true);
    });

    test('no patterns means nothing is proxied', () => {
        expect(matchesCustomProxyPattern(SMARTLINK, [])).toBe(false);
        expect(matchesCustomProxyPattern(SMARTLINK, null)).toBe(false);
    });

    test('the excluded list covers documents, archives, media and fonts', () => {
        for (const ext of ['.pdf', '.zip', '.mp4', '.mp3', '.xlsx', '.woff2', '.exe']) {
            expect(NEVER_PROXY_EXTENSIONS).toContain(ext);
        }
        // Images and stylesheets stay matchable so pixels keep working.
        for (const ext of ['.gif', '.png', '.jpg', '.css', '.js']) {
            expect(NEVER_PROXY_EXTENSIONS).not.toContain(ext);
        }
    });
});
