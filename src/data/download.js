// Downloading a notification's file: every cache's copy (rememberLinks, from all the
// notifications seen for it), fastest cache first (caches.js), then the copies
// caches that didn't announce it are likely to have (guessedCopies); and what came
// back: BUFR (bufrPart) or text (isText)
import { isDataLink } from '../messages/messages.js';
import { canDownload, noteTrying, noteLatency, noteFailed, downloadOrder, viaProxy } from './caches.js';

export const DATA_LINKS_MAX = 20000;
const dataLinks = new Map();  // data_id -> hrefs seen from every cache

// The links seen for a file in every notification for it, so far
export function linksSeen(dataId) {
    return [...(dataLinks.get(dataId) || [])];
}

// Each cache republishes the file; take the copy from the fastest cache a browser
// can download from (see caches.js), among this message's links and any already
// seen for it (e.g. the origin's). Hosts that blocked a download, and ones not known
// to allow browsers, are left out, so a background download doesn't waste its one try
export function decodeHref(feature) {
    var seen = [...(feature.links || []).filter(isDataLink).map((l) => l.href), ...(dataLinks.get((feature.properties || {}).data_id) || [])];
    return downloadOrder(seen).find(canDownload);
}

// fetch, telling caches.js how it went: how long the host took to answer, or that it
// blocked the browser (so it isn't asked again). A cache that sends no CORS headers is
// fetched through the proxy (viaProxy), but what's learnt is about the cache
export async function fetchTracked(url, options) {
    noteTrying(url);
    var start = performance.now();
    try {
        var response = await fetch(viaProxy(url), options);
    } catch (err) {
        noteFailed(url, err);
        throw err;
    }
    noteLatency(url, performance.now() - start, true);
    return response;
}

// Keeps a notification's links to its file, so a later download can try every copy
export function rememberLinks(dataId, links) {
    if (!dataId) return;
    var hrefs = dataLinks.get(dataId) || new Set();
    for (var link of links) {
        if (isDataLink(link)) hrefs.add(link.href);
    }
    dataLinks.delete(dataId);  // Re-insert to keep recently used ids
    dataLinks.set(dataId, hrefs);
    if (dataLinks.size > DATA_LINKS_MAX) {
        dataLinks.delete(dataLinks.keys().next().value);
    }
}

// topic: the notification's, for working out where caches that haven't announced
// the file would keep it (see guessedCopies). What fetchData downloads: the inline
// content, the links, and what the guesses need
export function bufrSource(feature, props, topic) {
    var content = props.content && props.content.encoding === 'base64' ? props.content.value : null;
    // Any canonical link may hold BUFR or text; fetchData checks the content
    var urls = (feature.links || [])
        .filter((l) => isDataLink(l) && !(l.length > 5e6))
        .map((l) => l.href);
    if (!content && !urls.length) return null;
    return { content: content, dataId: props.data_id, urls: urls, cap: props.cap_info || null,
        topic: topic || props.topic || null, pubtime: props.pubtime || null };
}

// ---------- Copies no cache announced. Each global cache keeps a file at an address
// of its own, but some follow from the notification: the Met Office / NOAA cache files
// it under its topic, and JMA's under its data_id and publication time (in seconds;
// every cache keeps the origin's pubtime). Only these two, as the other caches (DWD,
// KMA, CMA, NCM) don't let browsers download. The file's name is the origin's, the
// last part of its link and of most caches' (NCM's add a number and DWD's are
// sometimes named after the data_id, so theirs count only when there's nothing
// else), URL-encoded. Once every copy announced has failed, the main cache's (Met
// Office / NOAA, the first here) is tried once for each file without asking; Retry
// tries them all (source.guess, set by showDecodeError)
const MAIN_CACHE_HOST = 'wis2globalcache.s3.amazonaws.com';
const mainCacheTried = new Set();  // Guessed main-cache copies already asked for, so each file is tried there once
const GUESSABLE_CACHES = [
    (s, file) => s.topic && `https://wis2globalcache.s3.amazonaws.com/data/${s.topic.replace(/^(cache|origin)\/a\/wis2\//, '')}/${file}`,
    (s, file) => s.dataId && s.pubtime && `https://global-cache-of-japan.s3.ap-northeast-1.amazonaws.com/wis2/data/${encodeURI(s.dataId)}/${Math.floor(Date.parse(s.pubtime) / 1000)}/${file}`,
];

function guessedCopies(source, known) {
    var host = (url) => { try { return new URL(url).hostname; } catch (err) { return ''; } };
    var nameOf = (url) => {
        var last = url.split(/[?#]/)[0].split('/').pop();
        try { return decodeURIComponent(last); } catch (err) { return last; }
    };
    var usable = known.filter((url) => host(url) !== 'wis2.ncm.gov.sa');
    var names = usable.filter((url) => host(url) !== 'wis2.dwd.de').map(nameOf).filter(Boolean);
    if (!names.length) names = usable.map(nameOf).filter(Boolean);
    // The name most copies agree on
    var name = names.sort((a, b) => names.filter((n) => n === b).length - names.filter((n) => n === a).length)[0];
    if (!name) return [];
    var file = encodeURIComponent(name);
    var seen = new Set(known.map(host));
    return GUESSABLE_CACHES.map((build) => build(source, file)).filter((url) => url && !seen.has(host(url)));
}

// Returns { bytes, bufr, url }: the first BUFR copy found, otherwise the first
// copy that is plain text
export async function fetchData(source) {
    var text = null;
    if (source.content) {
        var bytes = Uint8Array.from(atob(source.content), (c) => c.charCodeAt(0));
        if (bufrPart(bytes)) return { bytes: bufrPart(bytes), bufr: true };
        if (isText(bytes)) text = { bytes: bytes, bufr: false };
    }
    // Every cache's copy, fastest cache first; hosts that blocked a browser download are
    // skipped (see caches.js, which learns from how each attempt goes)
    var known = [...source.urls, ...(dataLinks.get(source.dataId) || [])];
    var urls = downloadOrder(known);
    // Then the caches that haven't announced it (see guessedCopies): the main cache once
    // for each file, the rest on Retry
    var guessed = guessedCopies(source, known)
        .filter((url) => source.guess || (url.startsWith(`https://${MAIN_CACHE_HOST}/`) && !mainCacheTried.has(url)));
    guessed = downloadOrder(guessed);
    urls = [...urls, ...guessed.filter((url) => !urls.includes(url))];
    var answered = 0;
    for (var url of urls) {
        if (guessed.includes(url) && url.startsWith(`https://${MAIN_CACHE_HOST}/`)) {
            mainCacheTried.add(url);
            if (mainCacheTried.size > DATA_LINKS_MAX) mainCacheTried.delete(mainCacheTried.values().next().value);
        }
        try {
            var response = await fetchTracked(url);
            if (!response.ok) continue;
            answered++;
            var bytes = new Uint8Array(await response.arrayBuffer());
            if (bufrPart(bytes)) return { bytes: bufrPart(bytes), bufr: true, url: url };
            if (!text && isText(bytes)) text = { bytes: bytes, bufr: false, url: url };
        } catch (err) {
            // Thrown before any answer could be read: blocked by CORS, or unreachable
            console.debug(`Could not fetch ${url}`);
        }
    }
    if (text) return text;
    // Retry looks again: other caches' copies arrive in their own notifications
    if (answered) throw new Error(`the ${answered === 1 ? 'copy' : `${answered} copies`} downloaded ${answered === 1 ? 'is' : 'are'} neither BUFR nor text`);
    var next = source.guess ? 'Retry tries any other caches\' copies seen since'
        : 'Retry also asks the caches that haven\'t announced it';
    throw new Error(urls.length
        ? `none of the ${urls.length} ${urls.length === 1 ? 'copy' : 'copies'} ${guessed.length ? 'known or likely' : 'known'} could be downloaded; ${next}`
        : `every copy known is on a server that blocks browser downloads; ${next}`);
}

// Text in any language: control characters other than tabs and line breaks are rare,
// and bytes above 127 count when they're valid UTF-8 (e.g. a CAP warning in Greek)
export function isText(bytes) {
    var sample = bytes.subarray(0, 2000);
    if (!sample.length) return false;
    var utf8 = isUtf8(sample.length < bytes.length ? sample.subarray(0, utf8Boundary(sample)) : sample);
    var printable = sample.filter((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || (utf8 && b >= 128)).length;
    return printable / sample.length > 0.95;
}

// Where a cut-off sample ends on a whole UTF-8 character (continuation bytes are 10xxxxxx)
function utf8Boundary(bytes) {
    var end = bytes.length;
    for (var back = 0; back < 4 && end > 0 && (bytes[end - 1] & 0xc0) === 0x80; back++) end--;
    if (end > 0 && bytes[end - 1] >= 0xc0) end--;  // A lead byte whose character was cut off
    return end;
}

// GTS bulletins put an abbreviated heading (e.g. "IUAG04 VHHH 141200") before
// the BUFR message, so look a little way in; returns the BUFR bytes or null
export function bufrPart(bytes) {
    var head = String.fromCharCode(...bytes.subarray(0, 256));
    var start = head.indexOf('BUFR');
    return start < 0 ? null : bytes.subarray(start);
}

export function isUtf8(bytes) {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return true;
    } catch (err) {
        return false;
    }
}
