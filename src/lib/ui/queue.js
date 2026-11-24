import maplibregl from 'maplibre-gl';
import { gdcSearched, searchCatalogue, sortDatasetRows, shownDataset, setShownDataset, filterDatasetRows, initCatalogue } from '../../data/catalogue.js';
import { filterModes, filters, filtersActive, matchesFilters, topicTerms, POLICY_LABELS } from '../filters.js';
import { FORMATS, DISCIPLINES, disciplineOf, topicClass, formatOf, wis2boxVersion, isSpaceBased, stationId, GATEWAY_TOPIC, isUpdate, parseMessage, pointFor } from '../../messages/messages.js';
import { notify } from '../../state.js';
import { applyMapFilter } from '../../map/filter.js';
import { writeFiltersToUrl } from '../url.js';
import { scheduleReplay } from '../../messages/replay.js';
import { records, isGateway, byDataId } from '../../map/points.js';
import { map } from '../../map/map.js';
import { onMap } from '../../data/satellite/coverage.js';
import { bufrSource } from '../../data/download.js';
import { viaProxy, LOCAL } from '../../data/caches.js';
import { COLORS, OBS_CLASSES } from '../../config.js';
import { darken, TOUCH } from '../util.js';
import { DECODE_LAYERS, decodeEnabled, satelliteSkipped } from '../../data/decodeQueue.js';
import { wis2boxByCentre } from '../../messages/wis2box.js';
import { showDecoded, decodeSource, showDecodeError, openPopup } from './popup.js';
import { FORECAST_PAGE } from '../../page.js';
import { track, trackOnce } from '../analytics.js';

// The file types forecast products come in: the forecasts page's only type filters
const FORECAST_FORMATS = ['grib', 'hdf', 'json'];
// The sidebar: the message list (newest first, grouped, filtered), the centre picker
// and filter chips, and the Datasets tab beside it (src/data/catalogue.js)

export function selectQueueTab(tab) {
    document.querySelectorAll('.queue-tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
    document.querySelectorAll('.queue-pane').forEach((pane) => { pane.hidden = pane.dataset.pane !== tab; });
    if (tab === 'messages') flushQueue();
    if (tab === 'datasets') {
        if (!gdcSearched) searchCatalogue();
        else sortDatasetRows();
    }
}

// Sidebar listing incoming messages, newest first
export const QUEUE_MAX = 200;    // Rows shown in the sidebar

export const RECENT_MAX = 1000;  // Messages kept for re-filtering

export const recent = [];

export let pending = [];

export let queueTotal = 0;

export let queuePaused = false;

export let queueNew = null;  // The button that shows messages held while reading

export let queueList, queueCount, queueFilter, queueMapped, queuePause, queueToggle;

export const centres = new Map();  // centre-id -> its item in the picker

export let centreList, centreSearch, centreToggle, centreChips;

// A small switch at the start of a filter row: Only (keep matches) or Hide (drop matches)
export function filterModeButton(key) {
    return `<button type="button" class="filter-mode" data-filter="${key}" aria-pressed="false" title="Only: show just what matches. Hide: show everything except what matches.">Only</button>`;
}

export function paintFilterMode(button) {
    var hide = filterModes[button.dataset.filter] === 'hide';
    button.textContent = hide ? 'Hide' : 'Only';
    button.setAttribute('aria-pressed', hide);
    // Selected chips and centres turn red while their filter hides them
    document.body.classList.toggle(`hide-${button.dataset.filter}`, hide);
}

// The filters in force, each with a way to take it off (keeping the sidebar's controls in step)
export function filterChips() {
    var not = (key) => (filterModes[key] === 'hide' ? 'not ' : '');
    var chips = [];
    var clearTopic = () => {
        filters.text = '';
        queueFilter.value = '';
    };
    // A dataset shown on the map is one chip for it and its topic filter
    if (shownDataset && filters.text === shownDataset.topic) {
        chips.push({ label: `dataset “${shownDataset.title}”`, clear: () => {
            setShownDataset(null);
            clearTopic();
        } });
    } else {
        // One per term, each taking only itself out of the topic box
        var terms = topicTerms();
        terms.forEach((term) => chips.push({ label: `${not('text')}topic “${term}”`, clear: terms.length === 1 ? clearTopic : () => {
            filters.text = topicTerms().filter((t) => t !== term).join(', ');
            queueFilter.value = filters.text;
        } }));
    }
    [...filters.centres].sort().forEach((centre) => chips.push({ label: `${not('centres')}${centre}`, clear: () => {
        filters.centres.delete(centre);
        var item = centres.get(centre);
        if (item) item.querySelector('input').checked = false;
        showSelectedCentres();
    } }));
    filters.format.forEach((f) => chips.push({ label: `${not('format')}${FORMATS[f]}`, clear: () => {
        filters.format.delete(f);
        document.querySelector(`.queue-chip[data-format="${f}"]`)?.setAttribute('aria-pressed', 'false');
    } }));
    filters.disciplines.forEach((d) => chips.push({ label: `${not('disciplines')}${DISCIPLINES[d]}`, clear: () => {
        filters.disciplines.delete(d);
        document.querySelector(`.queue-chip[data-discipline="${d}"]`)?.setAttribute('aria-pressed', 'false');
    } }));
    filters.policy.forEach((p) => chips.push({ label: `${not('policy')}${POLICY_LABELS[p]}`, clear: () => {
        filters.policy.delete(p);
        document.querySelector(`.queue-chip[data-policy="${p}"]`)?.setAttribute('aria-pressed', 'false');
    } }));
    return chips;
}

// Over the map while any filter is on, sidebar open or not: one chip per filter to remove it, and Clear all
export function renderFilterBanner() {
    var banner = document.querySelector('.filter-banner');
    if (!banner) return;
    var chips = filterChips();
    banner.hidden = !chips.length;
    banner.querySelector('.filter-banner-chips').replaceChildren(...chips.map((c) => {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'filter-banner-chip';
        chip.title = `Remove the filter: ${c.label}`;
        chip.textContent = c.label;
        chip.addEventListener('click', () => {
            c.clear();
            applyFilters();
        });
        return chip;
    }));
}

export function applyFilters() {
    notify('filters', 'filterModes');
    applyMapFilter();
    rebuildQueue();
    // What's filtered, as the URL now says it (writeFiltersToUrl, below), once things settle
    setTimeout(() => trackOnce('filters', 3000, 'filters_change', { filters: location.search.slice(1) || 'none' }), 1000);
    var active = filtersActive();
    if (queueToggle) {
        queueToggle.classList.toggle('filtered', active);
        queueToggle.title = active ? 'Layers, filters and messages (filters on)' : 'Layers, filters and messages';
    }
    document.querySelector('.queue-reset').hidden = !active;
    writeFiltersToUrl();  // Shows Copy link too, while the URL has filters or styling to share
    scheduleReplay();  // The replay asks for what the filters now keep
    filterDatasetRows();
    renderFilterBanner();
}

export function zoomToCentres(selected) {
    var bounds = new maplibregl.LngLatBounds();
    for (var record of records.values()) {
        if (selected.has(record.centre)) bounds.extend(record.coords);
    }
    if (bounds.isEmpty()) return;
    var sidebar = document.querySelector('.queue').getBoundingClientRect().width;
    map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: sidebar + 60, right: 60 }, maxZoom: 7 });
}

// Adds a centre to the picker, or names one already listed
export function addCentreOption(centre, name) {
    var item = centres.get(centre);
    if (!item) {
        item = document.createElement('li');
        item.innerHTML = '<label><input type="checkbox" class="form-check-input"><strong></strong><span></span></label>';
        item.dataset.centre = centre;
        item.querySelector('input').value = centre;
        item.querySelector('input').checked = filters.centres.has(centre);
        item.querySelector('strong').textContent = centre;
        var next = [...centreList.children].find((li) => li.dataset.centre > centre);
        centreList.insertBefore(item, next || null);
        centres.set(centre, item);
    }
    if (name) item.querySelector('span').textContent = name;
    item.dataset.search = `${centre} ${item.querySelector('span').textContent}`.toLowerCase();
    item.hidden = !item.dataset.search.includes(centreSearch.value.trim().toLowerCase());
}

export function searchCentres() {
    var query = centreSearch.value.trim().toLowerCase();
    for (var item of centres.values()) {
        item.hidden = !item.dataset.search.includes(query);
    }
}

export function toggleCentre(centre, on) {
    on ? filters.centres.add(centre) : filters.centres.delete(centre);
    var item = centres.get(centre);
    if (item) item.querySelector('input').checked = on;
    showSelectedCentres();
    applyFilters();
    if (on) zoomToCentres(filters.centres);
}

// Summarises the selection on the picker button and lists it as removable chips
export function showSelectedCentres() {
    var selected = [...filters.centres].sort();
    centreToggle.textContent = !selected.length ? 'All centres'
        : selected.length === 1 ? selected[0] : `${selected.length} centres`;
    centreChips.replaceChildren(...selected.map((centre) => {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'queue-chip';
        chip.setAttribute('aria-pressed', 'true');
        chip.title = `Remove ${centre}`;
        chip.textContent = `${centre} ×`;
        chip.addEventListener('click', () => toggleCentre(centre, false));
        return chip;
    }));
}

// The picker lists every centre in the WMO register; centres seen in messages
// but not registered are still added as they arrive. A browser can't rely on the
// register: codes.wmo.int answers every page with the Access-Control-Allow-Origin of
// whichever page asked before (checked 2026-11-23), so most requests are blocked. The
// site uses a bundled snapshot of it; the local dev and preview servers fetch the live
// register through their proxy (localProxyHosts.js), and the snapshot if that fails
export const CENTRE_REGISTER = 'https://codes.wmo.int/wis/topic-hierarchy/centre-id?_format=jsonld';

export const CENTRE_SNAPSHOT = 'assets/data/centre-id.json';

export async function loadCentres() {
    var list = null;
    var proxied = viaProxy(CENTRE_REGISTER);
    if (LOCAL && proxied !== CENTRE_REGISTER) {  // Not through the site's Worker: the snapshot does
        try {
            list = parseCentreRegister(await fetchJson(proxied));
        } catch (err) {
            console.debug('Could not load the centre-id register, using the snapshot');
        }
    }
    if (!list) list = await fetchJson(CENTRE_SNAPSHOT).catch(() => []);
    list.forEach(([centre, name]) => addCentreOption(centre, name));
}

// Returns [[centre-id, description], ...] for the centres not retired
export function parseCentreRegister(register) {
    var list = (register['@graph'] || [])
        .filter((item) => item['@type'] === 'skos:Concept' && item['skos:notation'])
        .filter((item) => (item['reg:status'] || {})['@id'] !== 'reg:statusRetired')
        .map((item) => [item['skos:notation'], (item['dct:description'] || {})['@value'] || '']);
    if (!list.length) throw new Error('empty centre-id register');
    return list;
}

export async function fetchJson(url) {
    var response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.json();
}

// Builds the sidebar (filters, Layers, Datasets and Messages tabs). It isn't on the
// map itself: the tab on its edge opens and closes it
export class QueueControl {
    onAdd(map) {
        var container = document.createElement('div');

        var sidebar = document.createElement('aside');
        sidebar.className = 'queue';
        sidebar.innerHTML = `
            <!-- Filters shared by the map and the message list -->
            <div class="queue-header queue-filters">
                <div class="queue-title"><strong>Filters</strong>
                    <button type="button" class="btn btn-sm btn-outline-danger queue-reset" hidden title="Remove every filter">Clear filters</button>
                    <button type="button" class="btn btn-sm btn-link queue-share" hidden title="Copy a link that opens the map with these filters">Copy link</button>
                </div>
                <div class="filter-row">${filterModeButton('text')}<input type="search" class="form-control form-control-sm" placeholder="Filter topics (commas for more)" aria-label="Filter topics, separated by commas"></div>
                <div class="queue-selects">
                    <div class="filter-row">${filterModeButton('centres')}<div class="centre-picker">
                        <button type="button" class="form-select form-select-sm centre-toggle" aria-label="Centres" aria-expanded="false">All centres</button>
                        <div class="centre-menu" hidden>
                            <input type="search" class="form-control form-control-sm" placeholder="Search centres" aria-label="Search centres">
                            <ul class="centre-list" aria-label="Centres"></ul>
                        </div>
                    </div></div>
                    <div class="queue-chips centre-chips" aria-label="Selected centres"></div>
                </div>
                <div class="queue-chips" role="group" aria-label="File type">
                    ${filterModeButton('format')}
                    ${Object.entries(FORMATS).filter(([key]) => !FORECAST_PAGE || FORECAST_FORMATS.includes(key)).map(([key, label]) =>
                        `<button type="button" class="queue-chip" data-format="${key}" aria-pressed="false">${label}</button>`).join('')}
                </div>
                ${FORECAST_PAGE ? '' : `
                <div class="queue-chips" role="group" aria-label="Earth system discipline">
                    ${filterModeButton('disciplines')}
                    ${Object.entries(DISCIPLINES).map(([key, label]) =>
                        `<button type="button" class="queue-chip" data-discipline="${key}" aria-pressed="false">${label}</button>`).join('')}
                </div>
                <div class="queue-chips" role="group" aria-label="Data policy">
                    ${filterModeButton('policy')}
                    ${Object.entries(POLICY_LABELS).map(([key, label]) =>
                        `<button type="button" class="queue-chip" data-policy="${key}" aria-pressed="false" title="${key === 'core'
                            ? 'Core data: free and unrestricted, and copied by the global caches'
                            : 'Recommended data: shared by choice, possibly with conditions of use, and only from its origin'}">${label}</button>`).join('')}
                </div>`}
            </div>
            <div class="queue-tabs" role="tablist">
                <button type="button" role="tab" data-tab="layers" aria-selected="true">Layers</button>
                <button type="button" role="tab" data-tab="datasets" aria-selected="false">Datasets</button>
                <button type="button" role="tab" data-tab="messages" aria-selected="false">Messages</button>
            </div>
            <div class="queue-pane queue-pane-layers" data-pane="layers"></div>
            <div class="queue-pane queue-pane-datasets" data-pane="datasets" hidden>
                <div class="gdc-controls">
                    <input type="search" class="form-control form-control-sm gdc-query" placeholder="Search the WIS2 catalogue" aria-label="Search the WIS2 Global Discovery Catalogue">
                </div>
                <div class="gdc-status legend-note"></div>
                <ol class="gdc-list"></ol>
                <button type="button" class="btn btn-sm btn-outline-secondary gdc-more" hidden>More</button>
            </div>
            <div class="queue-pane queue-pane-messages" data-pane="messages" hidden>
                <div class="queue-controls">
                    <select class="form-select form-select-sm queue-mapped" aria-label="Messages to list">
                        <option value="">All messages</option>
                        <option value="on">On map</option>
                        <option value="off">Not on map</option>
                    </select>
                    <span class="queue-count"></span>
                    <button type="button" class="btn btn-sm btn-outline-secondary queue-pause">Pause</button>
                </div>
                <button type="button" class="queue-new" hidden></button>
                <ol class="queue-list"></ol>
            </div>`;
        sidebar.querySelector('.queue-filters .queue-title').insertAdjacentHTML('beforeend',
            '<button type="button" class="btn btn-sm btn-outline-secondary queue-close" title="Close (Esc)">Close</button>');
        sidebar.querySelector('.queue-close').addEventListener('click', () => document.body.classList.remove('queue-open'));
        // A tab on the sidebar's edge, halfway down: at the left of the map while it's
        // collapsed (› opens it), on its edge while it's open (‹ closes it)
        var handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'queue-handle';
        handle.setAttribute('aria-label', 'Open or close the sidebar');
        handle.addEventListener('click', () => {
            var open = !document.body.classList.contains('queue-open');
            document.body.classList.toggle('queue-open', open);
            if (open) flushQueue();
        });
        sidebar.appendChild(handle);
        document.body.appendChild(sidebar);
        sidebar.querySelectorAll('.queue-tabs button').forEach((button) => button.addEventListener('click', () => selectQueueTab(button.dataset.tab)));
        queueList = sidebar.querySelector('.queue-list');
        queueCount = sidebar.querySelector('.queue-count');
        queueFilter = sidebar.querySelector('input[type=search]');
        queueMapped = sidebar.querySelector('.queue-mapped');
        queuePause = sidebar.querySelector('.queue-pause');
        centreList = sidebar.querySelector('.centre-list');
        centreSearch = sidebar.querySelector('.centre-menu input');
        centreToggle = sidebar.querySelector('.centre-toggle');
        centreChips = sidebar.querySelector('.centre-chips');
        var centreMenu = sidebar.querySelector('.centre-menu');
        loadCentres();
        // File types, disciplines and data policies: each chip toggles its own, and any number can be on
        var toggleChips = (attr, set) => {
            var list = [...sidebar.querySelectorAll(`.queue-chip[data-${attr}]`)];
            list.forEach((chip) => chip.addEventListener('click', function(){
                var key = chip.dataset[attr];
                set.has(key) ? set.delete(key) : set.add(key);
                chip.setAttribute('aria-pressed', set.has(key));
                applyFilters();
            }));
            return list;
        };
        var formatChips = toggleChips('format', filters.format);
        var policyChips = toggleChips('policy', filters.policy);
        var chips = [...sidebar.querySelectorAll('.queue-chip[data-discipline]')];

        queueFilter.addEventListener('input', function(){
            filters.text = queueFilter.value.trim().toLowerCase();
            applyFilters();
        });
        var openCentreMenu = (open) => {
            centreMenu.hidden = !open;
            centreToggle.setAttribute('aria-expanded', open);
            if (open) centreSearch.focus();
        };
        centreToggle.addEventListener('click', () => openCentreMenu(centreMenu.hidden));
        centreSearch.addEventListener('input', searchCentres);
        centreSearch.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                openCentreMenu(false);
                centreToggle.focus();
            } else if (e.key === 'Enter') {
                // Toggle the only match, or the first one
                var match = [...centreList.children].find((li) => !li.hidden);
                if (match) toggleCentre(match.dataset.centre, !filters.centres.has(match.dataset.centre));
            }
        });
        centreList.addEventListener('change', (e) => toggleCentre(e.target.value, e.target.checked));
        document.addEventListener('click', (e) => {
            if (!centreMenu.hidden && !e.target.closest('.centre-picker')) openCentreMenu(false);
        });
        chips.forEach((chip) => chip.addEventListener('click', function(){
            var key = chip.dataset.discipline;
            filters.disciplines.has(key) ? filters.disciplines.delete(key) : filters.disciplines.add(key);
            chip.setAttribute('aria-pressed', filters.disciplines.has(key));
            applyFilters();
        }));
        sidebar.querySelectorAll('.filter-mode').forEach((button) => button.addEventListener('click', () => {
            var key = button.dataset.filter;
            filterModes[key] = filterModes[key] === 'only' ? 'hide' : 'only';
            paintFilterMode(button);
            applyFilters();
        }));
        // The filters in force, over the map (see renderFilterBanner)
        var banner = document.createElement('div');
        banner.className = 'filter-banner';
        banner.hidden = true;
        banner.setAttribute('role', 'region');
        banner.setAttribute('aria-label', 'Filters in force');
        banner.innerHTML = '<span class="filter-banner-label">Filtered</span><span class="filter-banner-chips"></span>'
            + '<button type="button" class="filter-banner-clear" title="Remove every filter">Clear all</button>';
        banner.querySelector('.filter-banner-clear').addEventListener('click', () => {
            setShownDataset(null);  // Its chip goes too
            sidebar.querySelector('.queue-reset').click();
        });
        document.body.appendChild(banner);
        sidebar.querySelector('.queue-reset').addEventListener('click', function(){
            Object.keys(filterModes).forEach((key) => { filterModes[key] = 'only'; });
            sidebar.querySelectorAll('.filter-mode').forEach(paintFilterMode);
            filters.text = '';
            filters.format.clear();
            filters.disciplines.clear();
            filters.policy.clear();
            filters.centres.clear();
            queueFilter.value = centreSearch.value = '';
            [...chips, ...formatChips, ...policyChips].forEach((chip) => chip.setAttribute('aria-pressed', 'false'));
            centreList.querySelectorAll('input').forEach((input) => { input.checked = false; });
            searchCentres();
            showSelectedCentres();
            applyFilters();
        });
        // Filters given in the link this page was opened with
        queueFilter.value = filters.text;
        formatChips.forEach((chip) => chip.setAttribute('aria-pressed', filters.format.has(chip.dataset.format)));
        policyChips.forEach((chip) => chip.setAttribute('aria-pressed', filters.policy.has(chip.dataset.policy)));
        chips.forEach((chip) => chip.setAttribute('aria-pressed', filters.disciplines.has(chip.dataset.discipline)));
        sidebar.querySelectorAll('.filter-mode').forEach(paintFilterMode);
        showSelectedCentres();
        // The map's filter needs the rest of the script, so apply once it has run
        if (filtersActive()) setTimeout(applyFilters);
        var share = sidebar.querySelector('.queue-share');
        share.addEventListener('click', async () => {
            writeFiltersToUrl();
            try {
                await navigator.clipboard.writeText(location.href);
                share.textContent = 'Copied';
            } catch (err) {
                share.textContent = 'Copy from the address bar';
            }
            setTimeout(() => { share.textContent = 'Copy link'; }, 2000);
        });
        // The catalogue's code comes later in the script, so wire it up once that has run
        setTimeout(() => initCatalogue(sidebar));
        queueMapped.addEventListener('change', rebuildQueue);
        queuePause.addEventListener('click', function(){
            queuePaused = !queuePaused;
            flushQueue();
        });
        // Back to the newest messages
        queueNew = sidebar.querySelector('.queue-new');
        queueNew.addEventListener('click', () => {
            queueList.scrollTop = 0;
            flushQueue(true);
        });
        // Scrolling back to the top lets the held messages in
        queueList.addEventListener('scroll', () => { if (queueList.scrollTop <= 4) flushQueue(); }, { passive: true });

        // Often enough to feel live, seldom enough to read between updates
        setInterval(flushQueue, 1500);
        return container;
    }

    onRemove() {
        // Nothing to do here
    }
}

export function queueMessage(topic, message, record, feature) {
    var [channel, t] = topic.split('/a/wis2/');
    var entry = {
        time: new Date(),
        topic: topic,
        channel: channel,
        centre: t.split('/', 1)[0],
        path: t.slice(t.indexOf('/') + 1),
        discipline: disciplineOf(t),
        // What the topic says it holds, for messages that aren't on the map
        kind: topicClass({ topic, webcam: false, props: (feature && feature.properties) || {} }),
        format: feature ? formatOf(feature, topic) : 'other',
        dataId: feature && feature.properties ? feature.properties.data_id : null,
        decodeKey: feature ? decodeKey(topic, feature) : null,
        // The decode layer this message goes to, when that layer is on. Origin copies
        // aren't downloaded, but are linked to what their cache copy decodes to.
        decodeKind: feature && !record ? Object.keys(DECODE_LAYERS).find((k) => decodeEnabled.has(k)
            && DECODE_LAYERS[k](topic.replace(/^origin\//, 'cache/'), feature) && !satelliteSkipped(k, topic)) : null,
        message: message,
        wis2box: wis2boxVersion(feature),
        record: record,
        row: null,
    };
    queueTotal++;
    if (entry.decodeKind && entry.decodeKey) {
        // A cache that announces the file after it has been decoded links straight away
        var decoded = decodedFirst.get(entry.decodeKey);
        if (decoded && onMap(decoded)) entry.record = decoded;
        else awaitDecode(entry);
    }
    if (centreList && !centres.has(entry.centre)) addCentreOption(entry.centre);
    recent.push(entry);
    if (recent.length > RECENT_MAX) recent.shift();
    if (matchesQueueFilter(entry)) {
        pending.push(entry);
        if (pending.length > QUEUE_MAX) pending.shift();
    }
}

export function matchesQueueFilter(entry) {
    if (queueMapped && queueMapped.value && (queueMapped.value === 'on') !== !!entry.record) return false;
    return matchesFilters(entry);
}

export function flushQueue(force) {
    if (!queueList || !document.body.classList.contains('queue-open')) return;

    queueCount.textContent = `${queueTotal.toLocaleString()} received`;
    queuePause.textContent = queuePaused ? `Resume (${pending.length} new)` : 'Pause';
    // While someone is reading (scrolled down, or the mouse is over the list), new
    // messages wait behind a button instead of pushing the rows down
    var reading = !force && (queueList.scrollTop > 4 || (!TOUCH.matches && queueList.matches(':hover')));
    queueNew.hidden = queuePaused || !reading || !pending.length;
    queueNew.textContent = `↑ ${pending.length.toLocaleString()} new message${pending.length === 1 ? '' : 's'}`;
    if (queuePaused || reading || !pending.length) return;

    // Oldest first, so each message either joins a recent group (which moves to the
    // top) or becomes the new top row
    for (var entry of pending) {
        var key = groupKey(entry), group = findGroup(key, entry.time, isSpaceBased(entry.topic));
        if (group) {
            addToGroup(group, entry);
            queueList.prepend(group);
        } else {
            var row = renderQueueRow(entry);
            row.dataset.group = key;
            row.groupEntries = [entry];
            row.latest = entry.time;
            queueList.prepend(row);
        }
    }
    pending = [];
    while (queueList.childElementCount > QUEUE_MAX) {
        queueList.lastElementChild.remove();
    }
}

// Messages that arrive in runs share a row with a count: back-to-back ones with
// the same topic, and satellite series (one message per granule or bulletin)
export const GROUP_WINDOW_MS = 2 * 60 * 1000;

export function groupKey(entry) {
    // Satellite bulletin numbers vary within a series (e.g. I/N/C/X/40/EUMP, .../41/EUMP)
    var path = isSpaceBased(entry.topic) ? entry.path.replace(/\/\d+(?=\/|$)/g, '/…') : entry.path;
    return `${entry.channel} ${entry.centre} ${path}`;
}

// The row this message joins: any topic merges with an identical row directly
// above it (back to back); satellite series, which interleave with other
// traffic, also look further down the recent rows
export const GROUP_SEARCH_ROWS = 40;

export function findGroup(key, time, satellite) {
    var row = queueList.firstElementChild;
    for (var i = 0; row && i < (satellite ? GROUP_SEARCH_ROWS : 1); i++, row = row.nextElementSibling) {
        if (row.dataset.group === key && time - row.latest <= GROUP_WINDOW_MS) return row;
    }
    return null;
}

export function addToGroup(row, entry) {
    row.groupEntries.push(entry);
    row.latest = entry.time;
    row.querySelector('.queue-meta').textContent = queueMeta(entry);
    row.querySelector('.queue-topic').textContent = row.dataset.group.split(' ').slice(2).join(' ');
    var badge = row.querySelector('.queue-group-count');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'queue-group-count';
        row.firstElementChild.appendChild(badge);
        row.title = 'Click to list these messages';
    }
    badge.textContent = `× ${row.groupEntries.length}`;
    var list = row.querySelector('.queue-group');
    if (list) list.prepend(renderQueueRow(entry));
}

// Opens or closes the list of messages in a group row
export function toggleGroup(row) {
    var list = row.querySelector('.queue-group');
    if (list) {
        list.remove();
        row.classList.remove('queue-group-open');
        return;
    }
    list = document.createElement('ol');
    list.className = 'queue-group';
    list.addEventListener('click', (e) => e.stopPropagation());  // Rows inside act on their own
    row.groupEntries.slice().reverse().forEach((entry) => list.appendChild(renderQueueRow(entry)));
    row.appendChild(list);
    row.classList.add('queue-group-open');
    // Pause so the group isn't pushed out of the list while it's open
    queuePaused = true;
    flushQueue();
}

export function rebuildQueue() {
    queueList.replaceChildren();
    pending = recent.filter(matchesQueueFilter).slice(-QUEUE_MAX);
    var paused = queuePaused;
    queuePaused = false;
    flushQueue(true);
    queuePaused = paused;
}

// Expanded view of a message that isn't on the map: decode its data or show the raw JSON
export function renderQueueDetail(entry) {
    var text = entry.message.toString();
    try {
        var message = JSON.parse(text);
        text = JSON.stringify(message, null, 2);
    } catch (err) {
        message = null;
    }
    var props = (message && message.properties) || {};
    var source = message && bufrSource(message, props, entry.topic);

    var detail = document.createElement('div');
    detail.className = 'queue-detail';
    detail.innerHTML = `
        <div class="pp-actions"></div>
        <div class="pp-decoded"></div>
        <pre hidden></pre>`;
    detail.addEventListener('click', (e) => e.stopPropagation());  // Keep it open
    var actions = detail.querySelector('.pp-actions');
    var out = detail.querySelector('.pp-decoded');
    var pre = detail.querySelector('pre');
    pre.textContent = text;

    // Expanding a row means wanting the data, so decode straight away
    var decode = async () => {
        try {
            showDecoded(out, null, await decodeSource(source, stationId(props), out));
        } catch (err) {
            showDecodeError(out, err, decode, source);
        }
    };
    if (source) decode();
    var json = document.createElement('button');
    json.type = 'button';
    json.className = 'btn btn-sm btn-outline-secondary';
    json.textContent = 'Show message';
    json.addEventListener('click', () => {
        pre.hidden = !pre.hidden;
        json.textContent = pre.hidden ? 'Show message' : 'Hide message';
    });
    actions.appendChild(json);
    return detail;
}

// The row's dot describes the message itself, matching the map: origin
// messages are rings in the origin colour (even when a cache copy is what's
// drawn), cache messages are filled with their point's colour, and messages
// waiting to be decoded have a dashed ring in their layer's colour; anything
// not on the map gets a small grey dot, so it can't be mistaken for a ring
export function paintQueueDot(dot, entry) {
    dot.className = 'queue-dot';
    dot.style.background = dot.style.borderColor = '';
    if (entry.channel !== 'cache' && entry.record) {
        dot.classList.add('queue-dot-ring');
        dot.style.borderColor = COLORS.origin;
    } else if (entry.record) {
        dot.style.background = entry.record.color;
        dot.style.borderColor = darken(entry.record.color);
        if (isGateway(entry.record)) dot.classList.add('is-gts');
    } else if (entry.decodeKind) {
        dot.classList.add('queue-dot-pending');
        if (['gts', 'gts-satellite', 'gts-text', 'wis2gts'].includes(entry.decodeKind)) dot.classList.add('is-gts');
        dot.style.borderColor = COLORS[entry.decodeKind];
    } else {
        dot.classList.add('queue-dot-none');  // Not on the map, coloured by what its topic says it holds
        if (entry.kind && entry.kind !== 'other') dot.style.background = OBS_CLASSES[entry.kind].color;
    }
}

// Channel, the kind of data its topic says it holds, and time
export function queueMeta(entry) {
    var kind = entry.kind && entry.kind !== 'other' ? ` · ${OBS_CLASSES[entry.kind].short || OBS_CLASSES[entry.kind].label}` : '';
    return `${entry.channel}${kind} · ${entry.time.toLocaleTimeString()}`;
}

// The point a message is drawn as now: a cache copy may have replaced the
// origin point it was first linked to
export function currentRecord(entry) {
    if (!entry.record) return null;
    if (onMap(entry.record)) return entry.record;
    var latest = byDataId.get(entry.record.props.data_id);
    return latest && records.has(latest.id) ? latest : null;
}

// Entries waiting for their file to be decoded, by decodeKey. Kept apart from
// the recent list, which busy brokers cycle through in seconds, so a row still
// on screen can be linked however long decoding takes.
export const DECODE_WAITING_MAX = 5000;

export const decodeWaiting = new Map();

export const decodedFirst = new Map();  // decodeKey -> first report plotted from that file

// The same GTS bulletin is relayed by more than one gateway (DWD and JMA) under
// different data_ids, so gateway files are known by their abbreviated heading
// (TTAAii CCCC YYGGgg, plus BBB for amendments) and decoded once
export function decodeKey(topic, feature) {
    var props = feature.properties || {}, dataId = props.data_id;
    var heading = GATEWAY_TOPIC.test(topic) && /([A-Z]{4}\d{2}[A-Z]{4}\d{6}(?:[A-Z]{3})?)(?=[_/]|$)/.exec(dataId || '');
    var key = heading ? `gts:${heading[1]}` : dataId;
    // An update reuses its data_id, but is a new file to decode
    return key && isUpdate(feature) ? `${key}@${props.pubtime}` : key;
}

export function awaitDecode(entry) {
    var list = decodeWaiting.get(entry.decodeKey) || [];
    list.push(entry);
    decodeWaiting.set(entry.decodeKey, list);
    if (decodeWaiting.size > DECODE_WAITING_MAX) decodeWaiting.delete(decodeWaiting.keys().next().value);
}

// Once reports decoded from a message are plotted, link its sidebar entries
// to the first of them and repaint their rows
export function linkDecoded(key, record) {
    if (!key) return;
    decodedFirst.set(key, record);
    if (decodedFirst.size > DECODE_WAITING_MAX) decodedFirst.delete(decodedFirst.keys().next().value);
    var waiting = decodeWaiting.get(key);
    if (!waiting) return;
    decodeWaiting.delete(key);
    for (var entry of waiting) {
        if (entry.record) continue;
        entry.record = record;
        if (entry.row) {
            paintQueueDot(entry.row.querySelector('.queue-dot'), entry);
            entry.row.title = 'Show on map';
        }
    }
}

export function renderQueueRow(entry) {
    var row = document.createElement('li');
    row.className = 'queue-row';
    row.title = entry.record ? 'Show on map' : 'Not on map: click to decode or view the message';

    var head = document.createElement('div');
    var dot = document.createElement('span');
    paintQueueDot(dot, entry);
    var centre = document.createElement('strong');
    centre.textContent = entry.centre;
    var meta = document.createElement('span');
    meta.className = 'queue-meta';
    meta.textContent = queueMeta(entry);
    head.append(dot, centre, meta);
    if (entry.wis2box || wis2boxByCentre.has(entry.centre)) {
        var version = document.createElement('span');
        version.className = 'queue-wis2box';
        version.textContent = entry.wis2box ? `wis2box ${entry.wis2box}` : 'wis2box';
        version.title = entry.wis2box ? 'Published by wis2box' : 'This centre runs wis2box';
        head.append(version);
    }

    var path = document.createElement('div');
    path.className = 'queue-topic';
    path.textContent = entry.path;
    row.append(head, path);

    entry.row = row;
    row.addEventListener('click', function(){
        if (row.groupEntries && row.groupEntries.length > 1) return toggleGroup(row);
        var target = currentRecord(entry);
        if (target) {
            openPopup(target);
            map.flyTo({ center: target.coords, zoom: Math.max(map.getZoom(), 5) });
            return;
        }
        var detail = row.querySelector('.queue-detail');
        if (detail) return detail.remove();
        row.appendChild(renderQueueDetail(entry));
        // Pause so the row isn't pushed out of the list while it's being read
        queuePaused = true;
        flushQueue();
    });
    // A double click centres the map on the message: on its report, or where its
    // notification says, even if the report is filtered out or not drawn. Its two
    // clicks open and close the same thing, so they leave the row as it was
    // (and don't select its text, which a single drag still can)
    row.addEventListener('mousedown', (e) => { if (e.detail > 1) e.preventDefault(); });
    row.addEventListener('dblclick', function(){
        var coords = messageCoords(entry);
        if (coords) map.easeTo({ center: coords, zoom: Math.max(map.getZoom(), 5) });
        track('message_centre', { located: !!coords });
    });
    return row;
}

// Where a message is: its report on the map, the report it was, or its notification's geometry
export function messageCoords(entry) {
    var record = currentRecord(entry) || entry.record;
    if (record && record.coords) return record.coords;
    var feature = parseMessage(entry.topic, entry.message);
    return (feature && feature.geometry && pointFor(feature.geometry)) || null;
}
