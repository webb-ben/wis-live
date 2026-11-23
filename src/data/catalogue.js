import { setState } from '../state.js';
import { pointFor, disciplineOf } from '../messages/messages.js';
import { records } from '../map/points.js';
import { map } from '../map/map.js';
import { timeAgo } from '../lib/format.js';
import { REPLAY_CACHE, REPLAY_API } from '../messages/replay.js';
import { filters, filterModes, matchesDiscipline, topicTerms, matchesTopic, policyOf } from '../lib/filters.js';
import { paintFilterMode, applyFilters, selectQueueTab, queueFilter } from '../lib/ui/queue.js';
import { writeFiltersToUrl } from '../lib/url.js';
import { PHONE } from '../lib/util.js';
import { onMessage } from '../messages/handle.js';
import { registerService, servicePick } from '../lib/services.js';


// WIS2 Global Discovery Catalogue (OGC API - Records): what each dataset
// is, shown in a point's popup (looked up by its notification's metadata_id), and a
// search over every dataset in the sidebar's Datasets tab
// The three Global Discovery Catalogues hold the same records. Searches, lookups and links
// go to the one that answered a small request fastest (see rankGdcs), and on to the next
// if it can't be reached.
export const GDCS = [
    { name: 'ECCC, Canada', api: 'https://wis2-gdc.weather.gc.ca/collections/wis2-discovery-metadata/items' },
    { name: 'CMA, China', api: 'https://gdc.wis.cma.cn/collections/wis2-discovery-metadata/items' },
    { name: 'DWD, Germany', api: 'https://wis2.dwd.de/gdc/collections/wis2-discovery-metadata/items' },
];

export const GDC_PROBE_MS = 8000;

export let gdcRanked = null;

export let gdcRankedYet = false;  // Whether the first ranking is done (see gdcRecord)

// Time one record from each catalogue, all at once, and order GDCS by how long each took
// (those that failed or timed out last). Done as the page opens and again every minute
// (again), so lookups follow whichever is fastest now; requests wait for the first ranking only
export function rankGdcs(again) {
    if (!gdcRanked || again) {
        var ranking = Promise.all(GDCS.map(async (gdc) => {
            var abort = new AbortController();
            var timer = setTimeout(() => abort.abort(), GDC_PROBE_MS);
            var start = performance.now();
            try {
                var response = await fetch(`${gdc.api}?f=json&limit=1`, { signal: abort.signal, cache: 'no-store' });
                await response.arrayBuffer();
                return response.ok ? performance.now() - start : Infinity;
            } catch (err) {
                return Infinity;
            } finally {
                clearTimeout(timer);
            }
        })).then((times) => {
            // Sorted in place in one go, so a request going through GDCS sees whole orders
            GDCS.forEach((gdc, i) => { gdc.ms = times[i]; });
            orderGdcs();
            gdcRankedYet = true;
        });
        if (!gdcRanked) gdcRanked = ranking;
    }
    return gdcRanked;
}

const gdcHost = (gdc) => new URL(gdc.api).host;

// Fastest first, or the one picked under the world map first (see services.js), and
// the one in use shown in the map key
function orderGdcs() {
    var picked = servicePick('catalogue');
    GDCS.sort((a, b) => (gdcHost(b) === picked) - (gdcHost(a) === picked) || (a.ms ?? Infinity) - (b.ms ?? Infinity));
    var gdc = GDCS[0];
    setState({ catalogue: isFinite(gdc.ms) ? { name: gdc.name, host: gdcHost(gdc), ms: gdc.ms }
        : gdc.ms === undefined ? { name: gdc.name, host: gdcHost(gdc), ms: null } : { failed: true } });
}

registerService('catalogue', {
    options: () => GDCS.map((gdc) => ({ value: gdcHost(gdc), label: `${gdcHost(gdc)} (${gdc.name})`, ms: gdc.ms })),
    use: orderGdcs,
});

// The same request of every catalogue at once: the first good answer is used and the
// others are stopped. A 404 only counts once none has the record
export async function gdcFetchFirst(path) {
    var aborts = GDCS.map(() => new AbortController());
    var notFound = null;
    try {
        var { response, i } = await Promise.any(GDCS.map(async (gdc, i) => {
            var response = await fetch(gdc.api + path, { signal: aborts[i].signal });
            if (response.status === 404) notFound = response;
            if (!response.ok) throw new Error(`${gdc.name} answered ${response.status}`);
            return { response, i };
        }));
    } catch (err) {
        if (notFound) return notFound;
        throw err.errors ? err.errors[0] : err;
    }
    aborts.forEach((abort, j) => j !== i && abort.abort());
    return response;
}

// A catalogue request (a path under the records), from the fastest catalogue that answers
export async function gdcFetch(path, options) {
    await rankGdcs();
    var lastError = null;
    for (var gdc of GDCS) {
        try {
            var response = await fetch(gdc.api + path, options);
            if (response.ok || response.status === 404) return response;
            lastError = new Error(`${gdc.name} answered ${response.status}`);
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            lastError = err;
        }
    }
    throw lastError;
}

// What a dataset's "Show on map" fetches from the Global Replay
export const DATASET_HOURS = 6;

export const DATASET_MAX = 500;

export const GDC_CACHE_MAX = 500;  // Records kept, so a popup doesn't ask again

// The whole catalogue (about 600 datasets) fits in one page, so the ones seen arriving can be
// listed first; a search with no text or view filter is about 5 MB
export const GDC_PAGE = 1000;

export const DATASETS_SEEN_MAX = 5000;

export const gdcRecords = new Map();  // metadata_id -> Promise of its record, or null when the catalogue has none

export const datasetSeen = new Map();  // metadata_id -> when a notification for it was last published

export let gdcSearched = false;

export let gdcNext = null;

export let gdcAbort = null;

export let gdcEls = null;

// WIS2 datasets are urn:wmo:md:...; GTS relays still carry urn:x-wmo:md:..., which the catalogue doesn't hold
export function datasetId(record) {
    var id = record.props.metadata_id || ((record.notification || {}).properties || {}).metadata_id;
    return /^urn:wmo:md:/.test(id || '') ? id : null;
}

export function noteDataset(feature) {
    var props = feature.properties || {}, id = props.metadata_id;
    if (!/^urn:wmo:md:/.test(id || '')) return;
    var when = Date.parse(props.pubtime || '') || Date.now();
    if ((datasetSeen.get(id) || 0) >= when) return;
    datasetSeen.delete(id);  // Re-insert to keep recent ones
    datasetSeen.set(id, when);
    if (datasetSeen.size > DATASETS_SEEN_MAX) datasetSeen.delete(datasetSeen.keys().next().value);
}

export function gdcRecord(id) {
    if (!gdcRecords.has(id)) {
        // Before the catalogues are first ranked (which waits for the slowest, up to
        // GDC_PROBE_MS), all of them are asked and the first answer taken, so a link's
        // dataset or an early popup isn't held up
        var path = `/${encodeURIComponent(id)}?f=json`;
        gdcRecords.set(id, (gdcRankedYet ? gdcFetch(path) : gdcFetchFirst(path))
            .then((response) => (response.ok ? response.json() : null))
            .catch(() => null));
        if (gdcRecords.size > GDC_CACHE_MAX) gdcRecords.delete(gdcRecords.keys().next().value);
    }
    return gdcRecords.get(id);
}

export function gdcPage(id) {
    return `${GDCS[0].api}/${encodeURIComponent(id)}?f=html`;
}

// Links from the catalogue are the publishers' own, so only web links are followed
export function webLink(href) {
    return /^https?:\/\//i.test(href || '') ? href : null;
}

// What a catalogue record says about its dataset
export function describeDataset(rec) {
    var p = rec.properties || {}, links = rec.links || [];
    var contacts = p.contacts || [];
    var host = contacts.find((c) => (c.roles || []).includes('host')) || contacts[0] || {};
    var licence = links.find((l) => l.rel === 'license' && webLink(l.href));
    return {
        id: rec.id,
        title: (p.title || rec.id || '').trim(),
        description: (p.description || '').trim(),
        policy: p['wmo:dataPolicy'] || '',
        centre: p['centre-id'] || '',
        publisher: host.organization || host.name || '',
        licence: licence ? { href: licence.href, title: licence.title || 'Licence' } : null,
        channel: (links.find((l) => l.channel) || {}).channel || '',
        geometry: rec.geometry,
    };
}

export function policyBadge(policy) {
    return /^(core|recommended)$/.test(policy) ? `<span class="pp-badge pp-policy-${policy}" title="WIS2 data policy">${policy}</span>` : '';
}

// The Dataset section of a popup, filled once the record has come back
export function showDatasetInPopup(el, id) {
    gdcRecord(id).then((rec) => {
        if (!rec || !el.isConnected) return;
        var d = describeDataset(rec);
        el.innerHTML = `
            <div class="pp-section">Dataset</div>
            <div class="pp-dataset-head"><a target="_blank" rel="noopener" title="Open the dataset's record in the WIS2 Global Discovery Catalogue"></a>${policyBadge(d.policy)}</div>
            <div class="pp-dataset-by"></div>
            <p class="pp-dataset-text"></p>
            <div class="pp-dataset-actions">
                ${d.channel ? '<button type="button" class="btn btn-sm btn-outline-secondary pp-dataset-show" title="Fetch what this dataset published recently and show it on the map">Show on map</button>' : ''}
                ${d.licence ? '<a class="pp-dataset-licence" target="_blank" rel="noopener"></a>' : ''}
            </div>
            <div class="legend-note pp-dataset-note" hidden></div>`;
        var title = el.querySelector('.pp-dataset-head a');
        title.href = gdcPage(d.id);
        title.textContent = d.title;
        el.querySelector('.pp-dataset-by').textContent = d.publisher;
        el.querySelector('.pp-dataset-text').textContent = d.description;
        if (d.licence) {
            var licence = el.querySelector('.pp-dataset-licence');
            licence.href = d.licence.href;
            licence.textContent = d.licence.title;
        }
        var show = el.querySelector('.pp-dataset-show'), note = el.querySelector('.pp-dataset-note');
        if (show) show.addEventListener('click', () => showDatasetOnMap(d, (text) => {
            note.hidden = false;
            note.textContent = text;
        }));
        el.hidden = false;
    });
}

// Puts a dataset on the map, filtered to its topic: many datasets publish rarely or
// without a location, so what it published in the past DATASET_HOURS is fetched from
// the Global Replay (switched on for it) and plotted, `report` says what was found, and
// the map goes to the dataset's points, if there are any, rather than to its declared
// area. The URL carries dataset= (not the topic), and the banner a chip to take it off.
export let datasetAbort = null;

export async function showDatasetOnMap(d, report) {
    // Filtered to the dataset's topic (the catalogue gives the cache channel; origin copies
    // match too). The link carries dataset= rather than the topic, which it implies.
    var topic = d.channel.replace(/^(cache|origin)\//, '').replace(/\/#$/, '').toLowerCase();
    shownDataset = { id: d.id, title: d.title, topic };
    filters.text = topic;
    filterModes.text = 'only';
    queueFilter.value = topic;
    document.querySelectorAll('.filter-mode[data-filter="text"]').forEach(paintFilterMode);
    applyFilters();
    var replayBox = document.querySelector('.legend-toggle[data-layer="replay"] input');
    if (replayBox && !replayBox.checked) {
        replayBox.checked = true;
        replayBox.dispatchEvent(new Event('change'));
    }
    if (datasetAbort) datasetAbort.abort();
    var abort = datasetAbort = new AbortController();
    report(`Fetching what it published in the past ${DATASET_HOURS} hours…`);
    var since = new Date(Date.now() - DATASET_HOURS * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    // The replay keeps a copy per global cache, so cached (core) data is asked of one;
    // recommended data isn't cached, so its origin notifications are asked for
    var params = new URLSearchParams({ f: 'json', sortby: '-pubtime', limit: DATASET_MAX, datetime: `${since}/..`, topic: d.channel.replace(/\/#$/, '') });
    if (d.channel.startsWith('cache/')) params.set('global-cache', REPLAY_CACHE);
    try {
        var response = await fetch(`${REPLAY_API}?${params}`, { signal: abort.signal });
        if (!response.ok) throw new Error(`the Global Replay answered ${response.status}`);
        var answer = await response.json();
        var features = (answer.features || []).filter((f) => f.properties && f.properties.topic);
        features.forEach((f) => onMessage(f.properties.topic, f, true));
        var located = features.filter((f) => f.geometry && f.geometry.type && pointFor(f.geometry)).length;
        var total = answer.numberMatched !== undefined ? answer.numberMatched : features.length;
        var hours = `in the past ${DATASET_HOURS} hours`;
        report(!total ? `Nothing published ${hours}.`
            : !located ? `${total.toLocaleString()} notifications ${hours}, none with a location to put on the map.`
            : `${total.toLocaleString()} notifications ${hours}${total > features.length ? ` (the latest ${features.length.toLocaleString()} fetched)` : ''}, ${located.toLocaleString()} with a location.`);
        // To the dataset's points, live and replayed, if any
        var points = [...records.values()].filter((r) => r.topic.toLowerCase().includes(topic) && r.coords);
        if (points.length) {
            var lons = points.map((r) => r.coords[0]), lats = points.map((r) => r.coords[1]);
            map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 60, maxZoom: 7 });
        }
    } catch (err) {
        if (err.name !== 'AbortError') report(`Could not fetch its recent messages: ${err.message}`);
    }
}

// A link's ?dataset=: the same as clicking that dataset's Show on map in the Datasets tab,
// which is opened (except on phones, where it would cover the map) at the dataset's row
export async function showDatasetFromUrl(id) {
    var rec = await gdcRecord(id);
    var d = rec && describeDataset(rec);
    startDataset = null;
    if (!d || !d.channel) {
        writeFiltersToUrl();  // Nothing to show; the parameter goes
        return;
    }
    // Shown on the map straight away; the Datasets tab lists the catalogue alongside,
    // and the progress goes on the dataset's row once the list has it
    var note = null, said = null;
    var report = (text) => {
        said = text;
        if (!note) return;
        note.hidden = false;
        note.textContent = text;
    };
    showDatasetOnMap(d, report);
    if (gdcEls && !PHONE.matches) {
        document.body.classList.add('queue-open');
        gdcSearched = true;  // Searched here, so the tab doesn't start its own
        selectQueueTab('datasets');
        await searchCatalogue();
        var row = [...gdcEls.list.children].find((r) => r.gdc && r.gdc.id === id && !r.hidden);
        if (row) row.scrollIntoView({ block: 'center' });
        note = row ? row.querySelector('.gdc-note') : gdcEls.status;
        if (said) report(said);
    }
}

// The Datasets tab: a search box over the whole catalogue, narrowed by the sidebar's filters
export function initCatalogue(sidebar) {
    var pane = sidebar.querySelector('.queue-pane-datasets');
    gdcEls = {
        pane,
        query: pane.querySelector('.gdc-query'),
        status: pane.querySelector('.gdc-status'),
        list: pane.querySelector('.gdc-list'),
        more: pane.querySelector('.gdc-more'),
    };
    var typing = null;
    gdcEls.query.addEventListener('input', () => {
        clearTimeout(typing);
        typing = setTimeout(() => searchCatalogue(), 400);
    });
    gdcEls.more.addEventListener('click', () => searchCatalogue(gdcNext));
    setInterval(() => sortDatasetRows(), 5000);
}

export async function searchCatalogue(next) {
    if (!gdcEls) return;
    gdcSearched = true;
    if (gdcAbort) gdcAbort.abort();
    var abort = gdcAbort = new AbortController();
    var url = next;
    if (!url) {
        var params = new URLSearchParams({ f: 'json', limit: GDC_PAGE });
        var q = gdcEls.query.value.trim();
        if (q) params.set('q', q);
        gdcEls.list.replaceChildren();
    }
    gdcEls.status.textContent = 'Searching the catalogue…';
    gdcEls.more.hidden = true;
    try {
        // A next page is a full link from the catalogue that answered; a new search goes to the nearest
        var response = url ? await fetch(url, { signal: abort.signal }) : await gdcFetch(`?${params}`, { signal: abort.signal });
        if (!response.ok) throw new Error(`it answered ${response.status}`);
        var page = await response.json();
        (page.features || []).map(describeDataset).forEach((d) => gdcEls.list.appendChild(datasetRow(d)));
        sortDatasetRows(true);
        var shown = gdcEls.list.children.length, total = page.numberMatched;
        gdcEls.baseStatus = (!shown ? 'No datasets match'
            : `${shown.toLocaleString()}${total !== undefined ? ` of ${total.toLocaleString()}` : ''} datasets`)
            + ` · catalogue: ${new URL(response.url).host}`;
        filterDatasetRows();
        gdcNext = ((page.links || []).find((l) => l.rel === 'next') || {}).href || null;
        gdcEls.more.hidden = !gdcNext || (total !== undefined && shown >= total);
    } catch (err) {
        if (err.name !== 'AbortError') gdcEls.status.textContent = `Could not search the catalogue: ${err.message}`;
    }
}

// The sidebar's filters, applied to a dataset: centres by its centre-id, the topic text and
// the discipline chips by its topic (Space also takes satellite topics). File type isn't
// applied: catalogue records don't say what format their files come in.
export function datasetMatchesFilters(d) {
    var test = (key, active, matches) => !active || (filterModes[key] === 'hide' ? !matches : matches);
    var topic = d.channel.toLowerCase();
    var item = { topic, discipline: disciplineOf(d.channel.split('/a/wis2/')[1] || '') };
    return test('centres', filters.centres.size, filters.centres.has(d.centre))
        && test('disciplines', filters.disciplines.size, matchesDiscipline(item))
        && test('policy', filters.policy.size, filters.policy.has(policyOf(topic)))
        && test('text', topicTerms().length, matchesTopic(topic));
}

// Hides the rows the filters leave out (rather than rebuilding the list, so notes stay)
export function filterDatasetRows() {
    if (!gdcEls || !gdcEls.baseStatus) return;
    var rows = [...gdcEls.list.children];
    rows.forEach((row) => { row.hidden = !datasetMatchesFilters(row.gdc); });
    var hidden = rows.filter((row) => row.hidden).length;
    gdcEls.status.textContent = gdcEls.baseStatus + (hidden ? ` · ${hidden.toLocaleString()} hidden by the filters` : '');
}

// Datasets seen arriving first, most recently seen at the top; the rest in the catalogue's
// order. Kept up as notifications arrive, but not while the pointer or focus is in the list,
// so a row doesn't move out from under a click.
export function sortDatasetRows(force) {
    if (!gdcEls || !gdcEls.list.children.length) return;
    if (!force && (gdcEls.pane.hidden || gdcEls.list.matches(':hover, :focus-within'))) return;
    var rows = [...gdcEls.list.children];
    rows.forEach(showDatasetSeen);
    var seen = (row) => datasetSeen.get(row.gdc.id) || 0;
    var sorted = rows.slice().sort((a, b) => seen(b) - seen(a) || a.order - b.order);
    if (sorted.some((row, i) => row !== rows[i])) gdcEls.list.append(...sorted);
}

export function showDatasetSeen(row) {
    var seen = datasetSeen.get(row.gdc.id);
    row.querySelector('.gdc-seen').textContent = seen ? `seen ${timeAgo(new Date(seen).toISOString())}` : 'not seen yet';
}

export function datasetRow(d) {
    var row = document.createElement('li');
    row.className = 'gdc-row';
    row.gdc = d;
    row.order = gdcEls.list.children.length;  // Its place in the catalogue's answer (pages are appended)
    row.innerHTML = `
        <a class="gdc-title" target="_blank" rel="noopener" title="Open the dataset's record in the catalogue"></a>
        <div class="gdc-meta"><strong></strong>${policyBadge(d.policy)}<span class="gdc-seen"></span>${d.channel
            ? '<button type="button" class="btn btn-sm btn-link gdc-show" title="Filter the map and messages to this dataset, with what it published recently">Show on map</button>' : ''}</div>
        <div class="legend-note gdc-note" hidden></div>`;
    var title = row.querySelector('.gdc-title');
    title.href = gdcPage(d.id);
    title.textContent = d.title;
    row.querySelector('.gdc-meta strong').textContent = d.centre;
    showDatasetSeen(row);
    var show = row.querySelector('.gdc-show'), note = row.querySelector('.gdc-note');
    if (show) show.addEventListener('click', () => showDatasetOnMap(d, (text) => {
        note.hidden = false;
        note.textContent = text;
    }));
    return row;
}

// ?dataset=<metadata_id> opens the page as if that dataset's Show on map had been clicked;
// Show on map writes it, and taking its chip off the banner removes it
export let startDataset = null;
export let shownDataset = null;  // { id, title, topic } of the dataset last shown on the map

export function setStartDataset(id) {
    startDataset = id;
}

export function setShownDataset(d) {
    shownDataset = d;
}
