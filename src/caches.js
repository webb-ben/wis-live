// The WIS2 global caches the page has seen, and how quickly each answers. Every
// cache republishes each file, so a download can come from any of them: they're
// tried fastest first, and one that turns out to block browser downloads goes to
// the back. The fastest usable cache is published as state.cache.
import { setState } from './state.js';
import { isDataLink } from './messages.js';

const CACHES_MAX = 50;  // Hosts kept (there are a handful of global caches)
const PROBE_MS = 8000;
const cacheHosts = new Map();  // host -> { host, id, name, ms, ok, blocked }

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
        if (!host || cacheHosts.has(host) || cacheHosts.size >= CACHES_MAX) continue;
        var cache = { host, id, name: cacheName(id), ms: Infinity, ok: false, blocked: false };
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

// How long a request to url took to answer (ms), and whether the browser could
// read it (ok). Later timings count for less than the running figure
export function noteLatency(url, ms, ok) {
    var cache = cacheHosts.get(hostOf(url));
    if (!cache) return;
    cache.ms = isFinite(cache.ms) ? cache.ms * 0.7 + ms * 0.3 : ms;
    if (ok) {
        cache.ok = true;
        cache.blocked = false;
    }
    publish();
}

// A download the browser wasn't allowed (or able) to make: a cache that has never
// let one through goes to the back
export function noteBlocked(url) {
    var cache = cacheHosts.get(hostOf(url));
    if (!cache || cache.ok || cache.blocked) return;
    cache.blocked = true;
    publish();
}

// Whether url is on a global cache not known to block browser downloads (one not yet
// tried counts: its first try says). Other hosts, such as a centre's own server,
// aren't tracked here, so go by corsFriendly
export function canDownload(url) {
    var cache = cacheHosts.get(hostOf(url));
    return !!cache && !cache.blocked;
}

// The order to try a file's copies: caches by how fast they answer (one not yet
// tried included, so the fastest gets its chance), then other hosts that allow
// browser downloads, then the rest; caches that block browsers last
export function downloadOrder(urls) {
    var score = (url) => {
        var cache = cacheHosts.get(hostOf(url));
        if (cache && cache.blocked) return 4e9;
        if (cache && isFinite(cache.ms)) return cache.ms;
        return corsFriendly(url) ? 1e9 : 2e9;
    };
    return [...new Set(urls)].sort((a, b) => score(a) - score(b));
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
