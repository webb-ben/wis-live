// Downloading a notification's file: every cache's copy (rememberLinks, from all the
// notifications seen for it), fastest cache first (caches.js), then the copies
// caches that didn't announce it are likely to have (guessedCopies); and what came
// back: BUFR (bufrPart) or text (isText)
import { isDataLink, FORMATS, noteSniffedFormat, formatOf } from '../messages/messages.js';
import { canDownload, noteTrying, noteLatency, noteFailed, downloadOrder, viaProxy, viaWorker, backgroundAllowed } from './caches.js';

export const DATA_LINKS_MAX = 20000;
const dataLinks = new Map();  // data_id (or a GTS bulletin, copyKey) -> hrefs seen from every cache

// A GTS bulletin's identity, TTAAii CCCC YYGGgg and any correction (RRx, CCx, AAx, PAx), from
// a gateway's data_id: DWD and JMA both relay the GTS, each under a data_id of its own
// (…/HVMY03RJTD241800/20261124213322_191, …/A_HVMY03RJTD241800_C_EDZW_…), but it's one
// bulletin, downloaded once. Null for anything that isn't a gateway's
const BULLETIN = /([A-Z]{4}\d{2}[A-Z]{4}\d{6})(?:_?((?:RR|CC|AA|PA)[A-Z]))?(?=[_/.]|$)/;
export function gtsBulletin(dataId) {
    if (!/-(gts-to-wis2|wis2-to-gts)\//.test(dataId || '')) return null;
    var m = BULLETIN.exec(dataId);
    return m ? m[1] + (m[2] || '') : null;
}

// What a file's links are kept under: its data_id, or for a GTS bulletin the bulletin, so
// every gateway's copies are tried together (the S3 cache's before DWD's through the Worker)
function copyKey(dataId) {
    var bulletin = gtsBulletin(dataId);
    return bulletin ? `gts:${bulletin}` : dataId;
}

// The links seen for a file in every notification for it, so far
export function linksSeen(dataId) {
    return [...(dataLinks.get(copyKey(dataId)) || [])];
}

// Each cache republishes the file; take the copy from the fastest cache a browser
// can download from (see caches.js), among this message's links and any already
// seen for it (e.g. the origin's). Hosts that blocked a download, and ones not known
// to allow browsers, are left out, so a background download doesn't waste its one try
// noWorker: never a copy only the Worker can fetch (an origin copy, which the cache's soon replaces)
export function decodeHref(feature, noWorker = false) {
    var seen = [...(feature.links || []).filter(isDataLink).map((l) => l.href), ...linksSeen((feature.properties || {}).data_id)];
    return downloadOrder(seen).find((url) => canDownload(url) && !(noWorker && viaWorker(url)));
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
    var key = copyKey(dataId);
    var hrefs = dataLinks.get(key) || new Set();
    for (var link of links) {
        if (isDataLink(link)) hrefs.add(link.href);
    }
    dataLinks.delete(key);  // Re-insert to keep recently used ids
    dataLinks.set(key, hrefs);
    if (dataLinks.size > DATA_LINKS_MAX) {
        dataLinks.delete(dataLinks.keys().next().value);
    }
}

// topic: the notification's, for working out where caches that haven't announced
// the file would keep it (see guessedCopies). What fetchData downloads: the inline
// content, the links, and what the guesses need
export function bufrSource(feature, props, topic) {
    var content = props.content && props.content.encoding === 'base64' ? props.content.value : null;
    var format = formatOf(feature, topic || props.topic);
    // Any canonical link may hold BUFR or text; fetchData checks the content. Files over 5 MB
    // are left out, as they'd be downloaded whole, but for GRIB (only its headers are read,
    // by range) and HDF/NetCDF (only its notification is shown)
    var whole = format !== 'grib' && format !== 'hdf';
    var urls = (feature.links || [])
        .filter((l) => isDataLink(l) && !(whole && l.length > 5e6))
        .map((l) => l.href);
    if (!content && !urls.length) return null;
    return { content: content, dataId: props.data_id, urls: urls, cap: props.cap_info || null,
        topic: topic || props.topic || null, pubtime: props.pubtime || null, format, feature };
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
// copy that is plain text. signal, if given, cancels it (an AbortError)
export async function fetchData(source, signal = null) {
    var text = null;
    if (source.content) {
        var bytes = Uint8Array.from(atob(source.content), (c) => c.charCodeAt(0));
        if (bufrPart(bytes)) return { bytes: bufrPart(bytes), bufr: true };
        if (isText(bytes)) text = { bytes: bytes, bufr: false };
    }
    // Every cache's copy, fastest cache first; hosts that blocked a browser download are
    // skipped (see caches.js, which learns from how each attempt goes)
    var known = [...source.urls, ...linksSeen(source.dataId)];
    var urls = downloadOrder(known);
    // Then the caches that haven't announced it (see guessedCopies): the main cache once
    // for each file, the rest on Retry
    var guessed = guessedCopies(source, known)
        .filter((url) => source.guess || (url.startsWith(`https://${MAIN_CACHE_HOST}/`) && !mainCacheTried.has(url)));
    guessed = downloadOrder(guessed);
    urls = [...urls, ...guessed.filter((url) => !urls.includes(url))];
    var answered = 0;
    var found = null;  // What the copies were instead, when not BUFR or text
    for (var url of urls) {
        if (guessed.includes(url) && url.startsWith(`https://${MAIN_CACHE_HOST}/`)) {
            mainCacheTried.add(url);
            if (mainCacheTried.size > DATA_LINKS_MAX) mainCacheTried.delete(mainCacheTried.values().next().value);
        }
        if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (source.background && !backgroundAllowed(url)) continue;  // As fetchHead
        try {
            var response = await fetchTracked(url, signal ? { signal } : undefined);
            if (!response.ok) continue;
            answered++;
            var bytes = new Uint8Array(await response.arrayBuffer());
            if (bufrPart(bytes)) return { bytes: bufrPart(bytes), bufr: true, url: url };
            if (!text && isText(bytes)) text = { bytes: bytes, bufr: false, url: url };
            else if (!isText(bytes)) {
                found = sniffFormat(bytes);
                noteSniffedFormat({ properties: { data_id: source.dataId } }, found);
            }
        } catch (err) {
            if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
            // Thrown before any answer could be read: blocked by CORS, or unreachable
            console.debug(`Could not fetch ${url}`);
        }
    }
    if (text) return text;
    // Retry looks again: other caches' copies arrive in their own notifications
    if (answered && found && found !== 'other') {
        throw new Error(`the file is ${FORMATS[found]}, which isn't decoded here (only BUFR and text are)`);
    }
    if (answered) throw new Error(`the ${answered === 1 ? 'copy' : `${answered} copies`} downloaded ${answered === 1 ? 'is' : 'are'} neither BUFR nor text`);
    var next = source.guess ? 'Retry tries any other caches\' copies seen since'
        : 'Retry also asks the caches that haven\'t announced it';
    throw new Error(urls.length
        ? `none of the ${urls.length} ${urls.length === 1 ? 'copy' : 'copies'} ${guessed.length ? 'known or likely' : 'known'} could be downloaded; ${next}`
        : `every copy known is on a server that blocks browser downloads; ${next}`);
}

// The first `length` bytes of a file, from the first copy that answers (the copies
// fetchData would try, the main cache's likely one included): { bytes, url }. Asks for
// just that much (Range), and stops reading once it has it from a server that sends the
// whole file anyway. For GRIB, whose headers say what the file holds (see grib.js).
// From `start` if given (a later field of a GRIB file): then only a server that sends
// just the range asked for (206) will do
// whole: all `length` bytes are needed (a field to draw): a copy that sends fewer (a server
// that caps a range, a download cut off) doesn't count, and the next is tried
// signal: an AbortSignal that cancels it (the forecasts page's Cancel), rejecting with an AbortError
export async function fetchHead(source, length = 16384, start = 0, whole = false, signal = null) {
    var known = [...source.urls, ...linksSeen(source.dataId)];
    var guessed = guessedCopies(source, known).filter((url) => url.startsWith(`https://${MAIN_CACHE_HOST}/`));
    var urls = downloadOrder(known);
    urls = [...urls, ...downloadOrder(guessed).filter((url) => !urls.includes(url))];
    // A file read as it's announced (source.background) goes through the Worker only while
    // the page's allowance for that lasts (caches.js)
    var short = null;  // The most a copy sent, when none sent it all
    for (var url of urls) {
        if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        // Read unasked (source.background): through the Worker only while the allowance lasts
        if (source.background && !backgroundAllowed(url)) continue;
        try {
            // Not through the browser's cache: Chrome pieces later ranges of a URL together from
            // ranges it has kept, and for ECMWF's 16 GB files behind a CDN that failed outright
            // ("Failed to fetch") or handed back another field's bytes. From the server every time
            var response = await fetchTracked(url, { cache: 'no-store', signal: signal || undefined,
                headers: { Range: `bytes=${start}-${start + length - 1}` } });
            if (!response.ok || (start > 0 && response.status !== 206)) continue;
            var reader = response.body.getReader();
            var parts = [], got = 0;
            while (got < length) {
                var { done, value } = await reader.read();
                if (done) break;
                parts.push(value);
                got += value.length;
            }
            reader.cancel().catch(() => {});
            if (whole && got < length) {
                short = Math.max(short || 0, got);
                console.debug(`${url} sent ${got} of the ${length} bytes asked for`);
                continue;
            }
            var bytes = new Uint8Array(Math.min(got, length));
            var at = 0;
            for (var part of parts) {
                bytes.set(part.subarray(0, bytes.length - at), at);
                at += Math.min(part.length, bytes.length - at);
                if (at >= bytes.length) break;
            }
            return { bytes, url };
        } catch (err) {
            if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');  // Not another copy: cancelled
            console.debug(`Could not fetch the start of ${url}`);
        }
    }
    if (short != null) throw new Error(`the download stopped short: ${short.toLocaleString()} of ${length.toLocaleString()} bytes`);
    throw new Error(urls.length ? 'no copy could be downloaded' : 'every copy known is on a server that blocks browser downloads');
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
// What a file is, from its first bytes: a FORMATS key. BUFR and GRIB may follow a GTS
// heading, so whichever starts first in the first 256 bytes counts
export function sniffFormat(bytes) {
    var head = String.fromCharCode(...bytes.subarray(0, 256));
    var bufr = head.indexOf('BUFR'), grib = head.indexOf('GRIB');
    if (bufr >= 0 && (grib < 0 || bufr < grib)) return 'bufr';
    if (grib >= 0) return 'grib';
    if (head.startsWith('\x89HDF') || /^CDF[\x01\x02\x05]/.test(head)) return 'hdf';
    if (head.startsWith('\x89PNG') || head.startsWith('GIF8') || (bytes[0] === 0xff && bytes[1] === 0xd8)) return 'image';
    if (/^(﻿|\xef\xbb\xbf)?\s*</.test(head)) return 'xml';
    if (/^(﻿|\xef\xbb\xbf)?\s*[{[]/.test(head)) return 'json';
    return isText(bytes) ? 'text' : 'other';
}

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
