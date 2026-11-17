// The WIS2 global caches the page has seen, and how quickly each answers. Every
// cache republishes each file, so a download can come from any of them: they're
// tried fastest first, and one that turns out to block browser downloads goes to
// the back. The fastest usable cache is published as state.cache.
import { setState } from './state.js';
import { isDataLink } from './messages.js';

const CACHES_MAX = 50;  // Hosts kept (there are a handful of global caches)
const PROBE_MS = 8000;
const REPROBE_MS = 60e3;  // Every cache is timed again this often, so state.cache follows the fastest
const cacheHosts = new Map();  // host -> { host, id, name, ms, ok, blocked, href }

// Hosts known to let a browser download their files: the S3-backed global caches and
// JMA's own server (which JMA's GTS-to-WIS2 bulletins link to). DWD, KMA, CMA and
// NCM send no CORS headers. Measured caches go by what they've done instead
const CORS_HOSTS = ['www.wis-jma.go.jp'];

function hostOf(url) {
    try {
        return new URL(url).hostname;
    } catch (err) {
        return '';
    }
}

export function corsFriendly(url) {
    var host = hostOf(url);
    return host.endsWith('.amazonaws.com') || CORS_HOSTS.includes(host);
}

// "data-metoffice-noaa-global-cache" -> "Met Office / NOAA"
const ORGS = { metoffice: 'Met Office', noaa: 'NOAA', dwd: 'DWD', cma: 'CMA', jma: 'JMA', kma: 'KMA', ecmwf: 'ECMWF',
    meteofrance: 'Météo-France', inmet: 'INMET', bom: 'BoM', eccc: 'ECCC', msc: 'MSC' };
function cacheName(id) {
    var words = id.replace(/^data-/, '').replace(/-?global-?cache$/, '').split('-').filter(Boolean);
    return words.length ? words.map((w) => ORGS[w] || w.toUpperCase()).join(' / ') : id;
}

// A cache notification names its cache (properties['global-cache']), and its data
// links are on that cache's host. A new host is timed with a quick request
export function noteCacheLinks(feature) {
    var id = feature && feature.properties && feature.properties['global-cache'];
    if (!id) return;
    for (var link of feature.links || []) {
        var host = isDataLink(link) && hostOf(link.href);
        if (!host) continue;
        // The latest file on each cache is what it's timed with again
        if (cacheHosts.has(host)) { cacheHosts.get(host).href = link.href; continue; }
        if (cacheHosts.size >= CACHES_MAX) continue;
        var cache = { host, id, name: cacheName(id), ms: Infinity, ok: false, blocked: false, href: link.href };
        cacheHosts.set(host, cache);
        probe(cache, link.href);
    }
}

// A HEAD request that the browser needn't be allowed to read (no-cors): its timing
// is how long the cache takes to answer, whether or not it blocks downloads
async function probe(cache, href) {
    var start = performance.now();
    try {
        await fetch(href, { method: 'HEAD', mode: 'no-cors', signal: AbortSignal.timeout(PROBE_MS) });
        noteLatency(href, performance.now() - start, false);
    } catch (err) {
        // Unreachable for now; real downloads will say more
    }
}

// Every host a download has been tried from, cache or not: blocked once the browser
// refused one (CORS) and none has ever got through, after which it isn't asked again;
// ok once one has; trying while its first request is out, so a host not yet known
// gets one request rather than a burst of them that all fail together
const BLOCKED_MAX = 200;
const blockedHosts = new Set();
const okHosts = new Set();
const tryingHosts = new Set();

function isBlocked(host) {
    return blockedHosts.has(host);
}

// Call as a download starts; a host with nothing known about it is then left alone
// by background downloads (canDownload) until this one answers
export function noteTrying(url) {
    var host = hostOf(url);
    if (host && !okHosts.has(host)) tryingHosts.add(host);
}

// Every minute, each cache that hasn't blocked the browser is timed again with its
// latest file, so a cache that slows down or speeds up moves in the order
setInterval(() => {
    if (document.hidden) return;  // A background tab needn't keep asking
    for (var cache of cacheHosts.values()) {
        if (!cache.blocked && !isBlocked(cache.host)) probe(cache, cache.href);
    }
}, REPROBE_MS);

// How long a request to url took to answer (ms), and whether the browser could
// read it (ok). Later timings count for less than the running figure
export function noteLatency(url, ms, ok) {
    var host = hostOf(url);
    tryingHosts.delete(host);
    if (ok && host) {
        okHosts.add(host);
        if (okHosts.size > BLOCKED_MAX) okHosts.delete(okHosts.values().next().value);
        blockedHosts.delete(host);
    }
    var cache = cacheHosts.get(host);
    if (!cache) return;
    cache.ms = isFinite(cache.ms) ? cache.ms * 0.7 + ms * 0.3 : ms;
    if (ok) {
        cache.ok = true;
        cache.blocked = false;
    }
    publish();
}

// A download that failed before any answer: a TypeError is the browser refusing it
// (CORS) or the host being unreachable, and a host that has never let one through is
// then skipped. Other errors (a timeout) only end its trial
export function noteFailed(url, err) {
    var host = hostOf(url);
    tryingHosts.delete(host);
    if (!host || (err && err.name !== 'TypeError') || okHosts.has(host) || isBlocked(host)) return;
    blockedHosts.add(host);
    if (blockedHosts.size > BLOCKED_MAX) blockedHosts.delete(blockedHosts.values().next().value);
    console.debug(`${host} blocks browser downloads; its copies are skipped from now on`);
    var cache = cacheHosts.get(host);
    if (cache) {
        cache.blocked = true;
        publish();
    }
}

// Whether a background download may use url: not on a blocked host, and on a host
// known to let browsers download (one that has, or corsFriendly), or on a global
// cache that hasn't been tried and has no first request out. Others, such as a
// centre's own server, aren't tried in the background at all
export function canDownload(url) {
    var host = hostOf(url);
    if (!host || isBlocked(host)) return false;
    if (okHosts.has(host) || corsFriendly(url)) return true;
    return cacheHosts.has(host) && !tryingHosts.has(host);
}

// The copies of a file worth trying, in order: caches by how fast they answer (one
// not yet timed included, so the fastest gets its chance), then other hosts that
// allow browser downloads, then the rest. Hosts that blocked a download are left out
export function downloadOrder(urls) {
    var score = (url) => {
        var cache = cacheHosts.get(hostOf(url));
        if (cache && isFinite(cache.ms)) return cache.ms;
        return corsFriendly(url) || okHosts.has(hostOf(url)) ? 1e9 : 2e9;
    };
    return [...new Set(urls)].filter((url) => !isBlocked(hostOf(url))).sort((a, b) => score(a) - score(b));
}

// The fastest cache that isn't known to block browsers, as state.cache. Only a new
// cache, or a time that moved by a fifth, is published, so listeners aren't busy
let published = null;
function publish() {
    var fastest = [...cacheHosts.values()].filter((c) => !c.blocked && isFinite(c.ms)).sort((a, b) => a.ms - b.ms)[0];
    if (!fastest) return;
    if (published && published.host === fastest.host && Math.abs(published.ms - fastest.ms) < published.ms * 0.2) return;
    published = { host: fastest.host, id: fastest.id, name: fastest.name, ms: fastest.ms };
    setState({ cache: published });
}
