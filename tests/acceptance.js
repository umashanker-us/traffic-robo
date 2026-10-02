#!/usr/bin/env node
/**
 * End-to-end acceptance run.
 *
 * Why this exists as a committed script rather than a Jest test: the worst bugs
 * in this project were invisible to unit tests. Release Chrome silently ignoring
 * --load-extension, a PDF landing hanging every visit for 60 seconds, request
 * interception stamping a forced-reload signature on every page — the suite was
 * green through all of them. Each needed a real browser against a real URL.
 *
 * It is not part of `npm test` because it drives real browsers against live
 * sites and takes minutes. Run it before shipping a build:
 *
 *   npm run test:e2e                       # default target
 *   npm run test:e2e -- https://your.site  # your own landing page
 *
 * Exits non-zero if any check fails, so CI can gate on it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const AutomaticVisitor = require('../src/core/automaticVisitor');
const VisitLogic = require('../src/core/visitLogic');
const profilePool = require('../src/helpers/profilePool');
const { generateCSV, generateJSON } = require('../src/helpers/campaignExport');
const { getResolvedBrowser } = require('../src/helpers/browserResolver');
const { resolveTrackerChain, parseProxyString } = require('../src/helpers/proxyRouter');

// example.com carries no analytics at all, so defaulting to it made three
// checks — beacons sent, UA version vs engine, GA4 event names — impossible
// to pass and the suite reported 18/21 on a healthy build. The default has to
// be a site that actually runs GA4. Pass another as argv[2] to override.
const SITE = process.argv[2] || 'https://carnbikecafe.com';
const FILE_URL = process.argv[3] || 'https://e4mevents.com/smartlink/s/A5Tdts';
const EXT = path.join(__dirname, '..', 'extensions', 'similarweb');
const VISITS = 6;

// ---------------------------------------------------------------- collectors
const beacons = [];
const replays = [];
const profilesSeen = new Set();
let visitsStarted = 0;

const origCreate = AutomaticVisitor.prototype._createContext;
AutomaticVisitor.prototype._createContext = async function patched() {
    await origCreate.call(this);
    visitsStarted += 1;
    if (this.extensionProfileId) profilesSeen.add(this.extensionProfileId);
    const threadId = this.threadId;
    this.context.on('request', (req) => {
        const url = req.url();
        if (!/google-analytics\.com|analytics\.google\.com/.test(url) || !/collect/.test(url)) return;
        let headers = {};
        try { headers = req.headers(); } catch { /* page closing */ }
        beacons.push({ threadId, url, headers });
    });
};

const origSave = AutomaticVisitor.prototype._saveReplay;
AutomaticVisitor.prototype._saveReplay = function patchedSave() {
    if (this.replay) replays.push(this.replay.getSummary());
    return origSave.call(this);
};

// ---------------------------------------------------------------- reporting
const checks = [];
function check(name, pass, detail) {
    checks.push({ name, pass, detail });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** What GA4 reads: the client-hint parameters, not the UA string. */
function ga4Verdict(entry) {
    const p = new URL(entry.url).searchParams;
    const uamb = p.get('uamb');
    const uap = p.get('uap');
    const brands = decodeURIComponent(p.get('uafvl') || '')
        .split('|').map(b => b.split(';')[0]).filter(Boolean);
    const brand = brands.find(b => !/^Not|^Chromium/.test(b));
    const device = uamb === '1' ? 'mobile' : (uap === 'Android' ? 'tablet' : 'desktop');
    return {
        device: uamb === null ? 'unknown' : device,
        browser: brand || 'Mozilla',
        platform: uap,
        model: p.get('uam'),
        ua: entry.headers['user-agent'] || '',
    };
}

async function runCampaign(label, config) {
    beacons.length = 0;
    replays.length = 0;
    profilesSeen.clear();
    visitsStarted = 0;
    console.log(`\n\n================ ${label} ================`);
    await new VisitLogic().start(config);
}

const BASE = {
    avgSessionDuration: 12,
    bounceRate: 20,
    threads: 3,
    threadDelay: 0,
    memClear: 0,
    pagePerSession: 2,
    location: 'India',
    percOldUsers: 0,
    commandMode: 'Automatic',
    restrictToPrimaryDomain: true,
};

(async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-'));
    profilePool.setBaseDir(base);

    // ======================= A. the main campaign =======================
    await runCampaign('A. live site, extension on, profile pool 3', Object.assign({}, BASE, {
        urlList: [SITE],
        repeat: VISITS,
        userAgentType: 'Desktop & Mobile',
        playMode: 'Slow',                 // extensions require headed mode
        extensionEnabled: true,
        extensionPath: EXT,
        extensionProfilePool: 3,
        ipRotation: true,
        campaignName: 'acceptance',
    }));

    const browserInfo = getResolvedBrowser();
    console.log('\n--- checks ---');

    check('repeat honoured exactly', visitsStarted === VISITS,
        `${visitsStarted} visits for repeat=${VISITS}`);

    const verdicts = beacons.map(ga4Verdict);
    check('GA4 beacons were sent', verdicts.length > 0, `${verdicts.length} beacons`);

    const mozilla = verdicts.filter(v => v.browser === 'Mozilla').length;
    check('no beacon reports as Mozilla', mozilla === 0, `${mozilla} of ${verdicts.length}`);

    const devices = new Set(verdicts.map(v => v.device));
    check('device category always comes from the hints',
        !devices.has('unknown'), [...devices].join(', ') || 'none');

    // Chrome's UA reduction: the UA carries MAJOR.0.0.0 and no device at all.
    const unreduced = verdicts.filter(v => /Chrome\/\d+\.0\.(?!0\.0)/.test(v.ua));
    check('every UA is reduced the way Chrome reduces it', unreduced.length === 0,
        `${unreduced.length} of ${verdicts.length} carried a full build`);

    const leaked = verdicts.filter(v => /Android \d+; (?!K\))/.test(v.ua));
    check('no UA leaks a device model', leaked.length === 0,
        `${leaked.length} of ${verdicts.length}`);

    const withModel = verdicts.filter(v => v.platform === 'Android' && v.model);
    const androidBeacons = verdicts.filter(v => v.platform === 'Android');
    check('the real device still reaches GA4 through the hints',
        androidBeacons.length === 0 || withModel.length > 0,
        `${withModel.length} of ${androidBeacons.length} Android beacons carried a model`);

    const realMajor = browserInfo && browserInfo.version ? browserInfo.version.split('.')[0] : null;
    const uaMajors = new Set(verdicts.map(v => (v.ua.match(/Chrome\/(\d+)\./) || [])[1]).filter(Boolean));
    check('UA version matches the engine running it',
        realMajor !== null && uaMajors.size === 1 && uaMajors.has(realMajor),
        `engine ${browserInfo && browserInfo.kind} ${browserInfo && browserInfo.version}, UAs claim ${[...uaMajors].join('/') || 'nothing'}`);

    check('extension profiles were pooled and reused',
        profilesSeen.size > 0 && profilesSeen.size <= 3,
        `${profilesSeen.size} profile(s) for ${visitsStarted} visits`);

    const poolDir = path.join(base, 'trafficrobo-profiles');
    const kept = fs.existsSync(poolDir) ? fs.readdirSync(poolDir) : [];
    check('pooled profiles survive on disk', kept.length > 0, kept.join(', ') || 'none');

    const extActive = replays.filter(r => (r.sessionInfo || {}).extensionVerified === true).length;
    check('extension verified on every visit', extActive === replays.length,
        `${extActive} of ${replays.length}`);

    const withIp = replays.filter(r => (r.sessionInfo || {}).spoofedIP).length;
    check('spoofedIP recorded', withIp === replays.length, `${withIp} of ${replays.length}`);

    const withEvents = replays.filter(r => (r.timeline || []).some(e => e.type === 'ga4_event')).length;
    check('GA4 event names on the replay', withEvents > 0, `${withEvents} of ${replays.length}`);

    const nonBounce = replays.filter(r => !r.stats.isBounce);
    const withBehaviour = nonBounce.filter(r => r.stats.scrollEvents > 0 || r.stats.mouseEvents > 0).length;
    check('behaviour recorded on non-bounce visits',
        nonBounce.length === 0 || withBehaviour === nonBounce.length,
        `${withBehaviour} of ${nonBounce.length} non-bounce`);

    const mix = {};
    for (const v of verdicts) {
        const k = `${v.device} / ${v.browser}`;
        mix[k] = (mix[k] || 0) + 1;
    }
    console.log('\n--- what GA4 would report ---');
    for (const [k, n] of Object.entries(mix).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(3)} x  ${k}`);
    }

    console.log('\n--- the campaign report ---');
    generateCSV(replays).split('\n').forEach((l, i) => console.log(`  ${i === 0 ? 'HDR' : 'row'} ${l}`));
    const json = generateJSON(replays, { campaignName: 'acceptance' });
    console.log('\n  extensionStats : ' + JSON.stringify(json.summary.extensionStats));
    console.log('  ga4 eventTypes : ' + JSON.stringify(json.summary.ga4Stats.eventTypes));

    // ======================= B. a file landing =======================
    await runCampaign('B. a URL that lands on a file', Object.assign({}, BASE, {
        urlList: [FILE_URL],
        repeat: 2,
        pagePerSession: 1,
        userAgentType: 'Desktop',
        playMode: 'Fastest',
        campaignName: 'acceptance-file',
    }));

    console.log('\n--- checks ---');
    check('both visits ran', visitsStarted === 2, `${visitsStarted} visits`);
    if (replays.length > 0) {
        const landings = replays.filter(r => r.stats.downloadLanding).length;
        const errors = replays.reduce((a, r) => a + r.stats.errors, 0);
        check('a file landing is an outcome, not an error',
            landings === replays.length && errors === 0,
            `${landings} of ${replays.length} flagged, ${errors} errors`);
        const statuses = generateCSV(replays).split('\n').slice(1)
            .filter(Boolean).map(l => l.trim().split(',').pop());
        check('the report status says Download',
            statuses.every(s => s === 'Download'), statuses.join(', '));
    }

    // ======================= C. a proxied tracker hop =======================
    console.log('\n\n================ C. a proxied tracker hop ================');
    const http = require('http');
    let hopHeaders = null;
    const fakeProxy = http.createServer((req, res) => {
        hopHeaders = req.headers;
        res.writeHead(302, { Location: 'https://unmatched.example/done' });
        res.end();
    });
    await new Promise(r => fakeProxy.listen(0, '127.0.0.1', r));

    const visitor = new AutomaticVisitor({
        campaignUrl: 'https://tracker.example/click/abc',
        userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
        userAgentProfile: { platform: 'Android', platformVersion: '15.0.0', model: 'SM-S938B', mobile: true },
        threadId: 1,
        visit: { pagePerSession: 1, avgSessionDuration: 10 },
        screenSize: { width: 412, height: 915 },
        playMode: 'Fastest',
        location: 'India',
    });
    await resolveTrackerChain(
        'https://tracker.example/click/abc',
        parseProxyString(`127.0.0.1:${fakeProxy.address().port}`),
        ['tracker.example'], null, 10, visitor._buildRequestIdentity(),
    );
    await new Promise(r => fakeProxy.close(r));

    console.log('\n--- checks ---');
    if (hopHeaders) {
        check('the hop carries the visit user agent, not a placeholder',
            hopHeaders['user-agent'] !== 'Mozilla/5.0' && /Chrome\//.test(hopHeaders['user-agent'] || ''),
            (hopHeaders['user-agent'] || '').substring(0, 60));
        const secFetch = Object.keys(hopHeaders).filter(k => k.startsWith('sec-fetch'));
        check('the hop sends the Sec-Fetch set a browser sends', secFetch.length === 4,
            `${secFetch.length} of 4`);
        check('the hop sends a document Accept',
            (hopHeaders.accept || '').includes('text/html'), hopHeaders.accept);
        check('the hop sends client hints matching its device',
            hopHeaders['sec-ch-ua-mobile'] === '?1'
            && /Google Chrome|Microsoft Edge|Opera|Samsung Internet/.test(hopHeaders['sec-ch-ua'] || ''),
            `mobile=${hopHeaders['sec-ch-ua-mobile']} brands=${hopHeaders['sec-ch-ua']}`);
    } else {
        check('the tracker hop reached the proxy', false, 'no request recorded');
    }

    // ======================= result =======================
    profilePool.resetPool();
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }

    const failed = checks.filter(c => !c.pass);
    console.log(`\n\n################ ${checks.length - failed.length}/${checks.length} checks passed ################`);
    failed.forEach(f => console.log(`  FAILED: ${f.name} — ${f.detail}`));
    process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
    console.error('\nACCEPTANCE RUN FAILED\n', e);
    process.exit(1);
});
