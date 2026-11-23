import maplibregl from 'maplibre-gl';
import { effectiveHidden } from '../../map/layers.js';
import { swathPointsShown, liftSwathCell, clearSelectedCell } from '../../data/satellite/coverage.js';
import { map } from '../../map/map.js';
import { PHONE, darken, esc, knots } from '../util.js';
import { isDataLink, isSpaceBased } from '../../messages/messages.js';
import { wis2boxOf } from '../../messages/wis2box.js';
import { twinKind, twinsNear } from '../../map/twins.js';
import { isGateway, layerOf, setFeatureProperties, byDataId, observedAt, records } from '../../map/points.js';
import { timeAgo, formatLabel, formatBytes, stationName, formatValue, titleCase, highlightJson } from '../format.js';
import { datasetId, showDatasetInPopup } from '../../data/catalogue.js';
import { showForecast } from '../../plots/forecast.js';
import { bufrSource, fetchData, fetchHead, isUtf8 } from '../../data/download.js';
import { parseGribHeader, gribRows } from '../../data/grib/gribHeader.js';
import { showGribArea, fileDetails } from '../../data/grib/grib.js';
import { metricValues } from '../../data/metrics.js';
import { attachSpectrum } from '../../data/stationDecode.js';
import { decoderReady, callDecoder } from '../../data/decoder.js';
import { renderCap } from '../../data/alerts/cap.js';
import { renderCitypage } from '../../plots/citypage.js';
import { METRICS, SATELLITE_STYLE } from '../../config.js';
import { state } from '../../state.js';
import { setColourBy } from '../../map/colour.js';
import { windProfileLevels, soundingTiles, windProfileTiles, soundingTime, showSoundingCharts, openSounding, windProfileColumns, WIND_PROFILE_COLUMNS, renderWindProfile, reportSite,
    emptyWindTiles, shortSiteName, windProfileColumnsOrEmpty } from '../../plots/sounding.js';
import { satelliteTiles } from '../../data/satellite/tiles.js';
import { oceanTiles, renderOceanProfile, renderTSDiagram, openOceanProfile } from '../../data/ocean/profile.js';
import { aircraftTiles } from '../../data/aviation/aircraft.js';
import { renderWaveSpectrum, waveSpectrum, marineCompass } from '../../data/ocean/wavespec.js';
import { showSpectrum } from '../../data/satellite/spectrum.js';
import { distanceKm } from '../geo.js';
import { overview, stylePanel } from './legend.js';
// The info panel on the right: what a point, a coverage cell or a dataset is, its
// decoded report with tiles, charts and the raw fields, the notification behind it,
// and model forecasts at that point. Also the hover label, and the ring that marks
// the selected point

// The selected point's details open in a panel on the right, and a ring marks
// the point on the map
export let infobar = null;
export const selectedMarker = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'selected-marker' }) });
export const hoverLabel = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    className: 'hover-label',
    offset: 10,
});
// Whatever the label is put on (a point, a track, a coverage cell) is marked on the
// world overview too, and unmarked when it goes
{
    const placeLabel = hoverLabel.setLngLat.bind(hoverLabel), removeLabel = hoverLabel.remove.bind(hoverLabel);
    hoverLabel.setLngLat = (lngLat) => {
        if (overview) overview.hover(maplibregl.LngLat.convert(lngLat));
        return placeLabel(lngLat);
    };
    hoverLabel.remove = () => {
        if (overview) overview.hover(null);
        return removeLabel();
    };
}

// Info panel
export function openPopup(record) {
    if (!record) return;
    clearSelectedCell();
    showInfo(buildPopup(record));
    var inAir = record.track && record.track.startsWith('aircraft:') && !effectiveHidden().includes('gts-tracks');
    // A report drawn as part of satellite coverage is shown by outlining its cell
    var inCoverage = record.swath && !swathPointsShown;
    selectedMarker.setLngLat(record.coords);
    if (inAir || inCoverage) selectedMarker.remove(); else selectedMarker.addTo(map);
    liftSwathCell(inCoverage ? record : null);
    selectOnOverview({ at: record.coords, colour: record.color });
    keepPopupInView();
}

// What the info panel shows, marked on the world overview until it closes
export function selectOnOverview(selected) {
    if (overview) overview.select(selected);
}

// Puts content in the info panel (built on first use) and opens it
export function showInfo(content) {
    hoverLabel.remove();
    if (!infobar) {
        infobar = document.createElement('aside');
        infobar.className = 'infobar';
        infobar.setAttribute('aria-label', 'Selected observation');
        infobar.innerHTML = '<button type="button" class="btn-close infobar-close" aria-label="Close" title="Close (Esc)"></button><div class="infobar-body"></div>';
        infobar.querySelector('.infobar-close').addEventListener('click', closeInfo);
        // On a phone, swiping the sheet up opens it to full screen, and pulling it
        // down from the top returns it to half (a tap on the grab bar toggles)
        var body = infobar.querySelector('.infobar-body'), startY = null;
        infobar.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
        infobar.addEventListener('touchmove', (e) => {
            if (!PHONE.matches || startY === null) return;
            var dy = e.touches[0].clientY - startY;
            if (dy < -30 && !infobar.classList.contains('infobar-full')) { infobar.classList.add('infobar-full'); startY = null; }
            else if (dy > 40 && body.scrollTop <= 0 && infobar.classList.contains('infobar-full')) { infobar.classList.remove('infobar-full'); startY = null; }
        }, { passive: true });
        body.addEventListener('scroll', () => { if (PHONE.matches && body.scrollTop > 24) infobar.classList.add('infobar-full'); }, { passive: true });
        infobar.addEventListener('click', (e) => {
            if (PHONE.matches && e.target === infobar && e.clientY - infobar.getBoundingClientRect().top < 20) infobar.classList.toggle('infobar-full');
        });
        document.body.appendChild(infobar);
    }
    // On narrow screens the two panels can't both fit
    if (window.innerWidth < 760) document.body.classList.remove('queue-open');
    infobar.querySelector('.infobar-body').replaceChildren(content);
    infobar.querySelector('.infobar-body').scrollTop = 0;
    infobar.classList.remove('infobar-full');
    document.body.classList.add('info-open');
}

export function closeInfo() {
    document.body.classList.remove('info-open');
    clearSelectedCell();
    selectedMarker.remove();
    liftSwathCell(null);
    selectOnOverview(null);
}

export function buildPopup(record) {
    var props = record.props;
    var canonical = record.links.find((l) => isDataLink(l));
    var oscar = record.links.find((l) => l.rel == 'via' && /oscar/.test(l.href));
    var image = record.webcam && canonical;
    var wis2box = record.external ? null : wis2boxOf(record);
    // A WIS2 or GTS station that is also an airport links its METAR
    var twinAirport = twinKind(record) === 'station' ? twinsNear(record, 'airport')[0] : null;

    var div = document.createElement('div');
    div.className = 'pp';
    div.innerHTML = `
        <header class="pp-head">
            <span class="pp-dot${record.channel !== 'cache' && !record.external ? ' pp-ring' : ''}${isGateway(record) ? ' is-gts' : ''}${record.external || record.replay ? ' is-ext' : ''}" style="--color: ${record.color}; --outline: ${darken(record.color)}"></span>
            <div>
                <div class="pp-title"></div>
                <div class="pp-sub">
                    ${esc(record.centre)}
                    <span class="pp-badge pp-${record.channel}">${record.external ? esc(record.badge) : esc(record.channel)}</span>
                    ${record.replay ? '<span class="pp-badge pp-replay" title="From the Global Replay service">replay</span>' : ''}
                    ${props.pubtime ? `<span title="${esc(props.pubtime)}">${timeAgo(props.pubtime)}</span>` : ''}
                </div>
            </div>
        </header>
        ${image ? `<a href="${esc(image.href)}" target="_blank" rel="noopener"><img class="pp-image" src="${esc(image.href)}" alt="Webcam image"></a>` : ''}
        <dl class="pp-meta">
            ${record.wsi ? `<dt>Station</dt><dd>${oscar
                ? `<a href="${esc(oscar.href)}" target="_blank" rel="noopener">${esc(record.wsi)}</a>`
                : esc(record.wsi)}${twinAirport
                ? ` · METAR <a href="#" class="pp-twin" title="The same station's latest METAR">${esc(twinAirport.wsi)}</a>` : ''}</dd>` : ''}
            ${props.datetime ? `<dt>Observed</dt><dd>${esc(new Date(props.datetime).toLocaleString())} (${timeAgo(props.datetime)})</dd>` : ''}
            <dt>Topic</dt><dd class="pp-mono">${esc(record.path)}</dd>
            ${wis2box ? `<dt>wis2box</dt><dd>${[wis2box.version && esc(wis2box.version), wis2box.url
                && `<a href="${esc(wis2box.url)}" target="_blank" rel="noopener" title="Open the wis2box this message came from">${esc(new URL(wis2box.url).host)}</a>`].filter(Boolean).join(' · ')}</dd>` : ''}
        </dl>
        <div class="pp-actions"></div>
        <div class="pp-tabs" role="tablist">
            <button type="button" role="tab" data-tab="data" aria-selected="true">Data</button>
            ${isSpaceBased(record.topic) || /-satellite$/.test(layerOf(record)) ? '' : '<button type="button" role="tab" data-tab="forecast" aria-selected="false">Model forecast</button>'}
            ${record.external ? '' : '<button type="button" role="tab" data-tab="message" aria-selected="false">Message</button>'}
        </div>
        <div class="pp-decoded" data-panel="data"></div>
        <div class="pp-forecast" data-panel="forecast" hidden></div>
        <div class="pp-message" data-panel="message" hidden></div>
        <div class="pp-dataset" hidden></div>`;

    var title = div.querySelector('.pp-title');
    title.textContent = record.wsi || props.metadata_id || record.centre;
    var twin = div.querySelector('.pp-twin');
    // What the dataset is, from the Global Discovery Catalogue
    var dataset = datasetId(record);
    if (dataset) showDatasetInPopup(div.querySelector('.pp-dataset'), dataset);
    if (twin) twin.addEventListener('click', (e) => {
        e.preventDefault();
        openPopup(twinAirport);
    });

    var actions = div.querySelector('.pp-actions');
    var out = div.querySelector('.pp-decoded');
    if (canonical && !image) {
        var download = document.createElement('a');
        download.className = 'btn btn-sm btn-outline-secondary';
        download.href = canonical.href;
        download.target = '_blank';
        download.rel = 'noopener';
        download.textContent = `Download ${formatLabel(canonical.type)}${canonical.length ? ` (${formatBytes(canonical.length)})` : ''}`;
        actions.appendChild(download);
    }
    // Data and model forecast tabs; the forecast is only fetched once its tab is opened
    var forecastOut = div.querySelector('.pp-forecast');
    var messageOut = div.querySelector('.pp-message');
    div.querySelectorAll('.pp-tabs button').forEach((button) => button.addEventListener('click', () => {
        var key = button.dataset.tab;
        div.querySelectorAll('.pp-tabs button').forEach((b) => b.setAttribute('aria-selected', b === button));
        div.querySelectorAll('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== key; });
        if (key === 'forecast' && !forecastOut.hasChildNodes()) showForecast(forecastOut, record, keepPopupInView);
        if (key === 'message' && !messageOut.hasChildNodes()) showMessage(messageOut, record);
        keepPopupInView();
    }));
    if (!record.source && !record.decoded) {
        out.innerHTML = '<div class="pp-status">No data to decode for this message.</div>';
    }
    // A satellite report keeps only its first values; the rest come from decoding it again
    var fullSource = record.decoded && record.decoded.trimmed && record.notification && bufrSource(record.notification, record.notification.properties || {}, record.topic);
    if (fullSource && !record.decoded.loadFull) {
        record.decoded.loadFull = () => decodeSource(fullSource, '', document.createElement('div'), record.fileIndex);
    }
    // Opening a popup means wanting the data, so decode straight away
    if (record.decoded) {
        showDecoded(out, title, record.decoded);
    } else if (record.source) {
        decodeRecord(record, out, title);
    }
    return div;
}

export async function decodeRecord(record, out, title) {
    try {
        record.decoded = await decodeSource(record.source, record.wsi, out, record.subsetIndex);
        setFeatureProperties(record, metricValues(record));
        attachSpectrum(record);
        showDecoded(out, title, record.decoded);
        var forecast = out.parentNode && out.parentNode.querySelector('.pp-forecast');
        if (forecast && forecast.rerender) forecast.rerender();
    } catch (err) {
        showDecodeError(out, err, () => decodeRecord(record, out, title), record.source);
    }
    keepPopupInView();
}

// source: what failed to download, which Retry then also looks for on caches that
// haven't announced it (see guessedCopies)
export function showDecodeError(out, err, retry, source) {
    out.innerHTML = `<div class="pp-status pp-error">Could not decode: ${esc(err.message)}</div>`;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm btn-outline-primary pp-retry';
    button.textContent = 'Retry';
    button.addEventListener('click', () => {
        if (source) source.guess = true;
        retry();
    });
    out.appendChild(button);
}

// Downloads and decodes a message's data: BUFR is decoded, text (e.g. a GTS
// bulletin) is returned as-is
// index picks one report in a file of many, such as a satellite swath
export async function decodeSource(source, wsi, out, index) {
    // GRIB (gridded model output): only its headers are read, from the start of the file,
    // for what it holds and the grid it covers (gribHeader.js); its values aren't decoded
    if (source.format === 'grib' && !source.content) {
        out.innerHTML = '<div class="pp-status">Reading the GRIB headers…</div>';
        var head = await fetchHead(source);
        return { grib: parseGribHeader(head.bytes), href: head.url };
    }
    // HDF and NetCDF (the Met Office's forecasts run to 146 MB) aren't decoded either, so
    // they aren't downloaded: what they hold and where, from the notification
    if (source.format === 'hdf' && !source.content && source.feature) {
        return { fileInfo: fileDetails(source.feature, source.topic || ''), geometry: source.feature.geometry };
    }
    out.innerHTML = '<div class="pp-status">Downloading data…</div>';
    try {
        var data = await fetchData(source);
    } catch (err) {
        // CAP servers often block browser downloads; the notification still
        // carries the alert's urgency, severity and certainty
        if (source.cap) return { cap: null, capInfo: source.cap, href: source.urls[0] };
        throw err;
    }
    if (!data.bufr) {
        var text = new TextDecoder(isUtf8(data.bytes) ? 'utf-8' : 'latin1').decode(data.bytes);
        if (/<alert[\s>]/.test(text) && /emergency:cap/.test(text)) return { cap: text, href: data.url };
        if (/^\s*(<\?xml[^>]*\?>\s*)?<[A-Za-z]/.test(text)) return { xml: text, href: data.url };
        return { text: text };
    }

    out.innerHTML = `<div class="pp-status">${decoderReady ? 'Decoding…' : 'Loading decoder (first time only)…'}</div>`;
    var key = source.dataId || data.url || String(Date.now());
    var result = JSON.parse(await callDecoder('decode_bufr', data.bytes, wsi || '', key, index ?? -1));
    result.key = key;
    result.source = source;  // So the pager can fetch the file again if the decoder has let it go
    return result;
}

export function showDecoded(out, title, decoded) {
    if (decoded.grib) {
        // What the file holds, and its grid outlined on the map
        out.innerHTML = `<table class="pp-table grib-table">${gribRows(decoded.grib).map(([k, v]) =>
            `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`
            + '<div class="pp-status">From the headers of the file’s first field; its values aren’t drawn.'
            + (decoded.href ? ` <a href="${esc(decoded.href)}" target="_blank" rel="noopener">Download the file</a>` : '') + '</div>';
        if (decoded.grib.grid && decoded.grib.grid.outline) showGribArea(decoded.grib.grid.outline);
    } else if (decoded.fileInfo) {
        var f = decoded.fileInfo;
        var mb = f.length ? `${(f.length / 1e6).toFixed(f.length < 1e7 ? 1 : 0)} MB` : null;
        var rows = [['Holds', f.summary], ['File', f.file], ['Run', f.run], ['Lead time', f.hours !== null ? `${f.hours} h` : null],
            ['Format', 'HDF / NetCDF'], ['Size', mb]].filter(([, v]) => v);
        out.innerHTML = `<table class="pp-table grib-table">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`
            + '<div class="pp-status">From the notification: HDF and NetCDF files aren’t downloaded or decoded here.'
            + (f.href ? ` <a href="${esc(f.href)}" target="_blank" rel="noopener">Download the file</a>` : '') + '</div>';
        var g = decoded.geometry;
        var ring = g && g.type === 'Polygon' ? g.coordinates[0] : g && g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
        if (ring) showGribArea(ring.map((p) => p.slice(0, 2)));
    } else if (decoded.cap !== undefined) {
        renderCap(out, title, decoded, showAlertArea);
    } else if (decoded.xml !== undefined) {
        renderXml(out, title, decoded);
    } else if (decoded.text !== undefined) {
        out.innerHTML = '<pre class="pp-text"></pre>';
        out.firstChild.textContent = decoded.text.trim();
    } else {
        renderDecoded(out, title, decoded);
    }
}

// XML: Environment Canada citypage forecasts get their own view; anything else
// is shown as a collapsible tree, with the raw text a click away
export function renderXml(out, title, decoded) {
    var doc = new DOMParser().parseFromString(decoded.xml, 'application/xml');
    if (doc.querySelector('parsererror')) {
        out.innerHTML = '<pre class="pp-text"></pre>';
        out.firstChild.textContent = decoded.xml.trim();
        return;
    }
    if (doc.documentElement.nodeName === 'siteData' && doc.querySelector('location > name')) {
        renderCitypage(out, title, doc, keepPopupInView);
    } else {
        out.innerHTML = '<div class="xml-tree"></div>';
        out.firstChild.appendChild(xmlTree(doc.documentElement, 0, { count: 0 }));
    }
    var raw = document.createElement('details');
    raw.className = 'pp-more';
    raw.innerHTML = '<summary>Raw XML</summary><pre class="pp-text"></pre>';
    raw.querySelector('pre').textContent = decoded.xml.trim();
    out.appendChild(raw);
}

// Elements holding only text are shown as "name: value"; the rest open and close
export const XML_TREE_MAX = 3000;  // Nodes drawn before the rest is cut off

export function xmlTree(el, depth, drawn) {
    var attrs = [...el.attributes].filter((a) => !/^xmlns|^xsi:/.test(a.name));
    var label = document.createElement('span');
    label.className = 'xml-tag';
    label.textContent = el.localName;
    var attrText = attrs.map((a) => `${a.name}="${a.value}"`).join(' ');
    var children = [...el.children];
    if (++drawn.count > XML_TREE_MAX) {
        var more = document.createElement('div');
        more.className = 'pp-status';
        more.textContent = '… (truncated, see the raw XML)';
        return more;
    }
    if (!children.length) {
        var leaf = document.createElement('div');
        leaf.className = 'xml-leaf';
        var value = document.createElement('span');
        value.className = 'xml-value';
        value.textContent = el.textContent.trim();
        leaf.append(label, value);
        if (attrText) leaf.title = attrText;
        return leaf;
    }
    var node = document.createElement('details');
    node.className = 'xml-node';
    node.open = depth < 3;
    var summary = document.createElement('summary');
    summary.appendChild(label);
    if (attrText) {
        var a = document.createElement('span');
        a.className = 'xml-attrs';
        a.textContent = attrText;
        summary.appendChild(a);
    }
    node.appendChild(summary);
    for (var child of children) {
        if (drawn.count > XML_TREE_MAX) break;
        node.appendChild(xmlTree(child, depth + 1, drawn));
    }
    return node;
}

// citypage and CAP views themselves are in src/plots/citypage.js and src/alerts/cap.js)
export function showAlertArea(rings, color) {
    map.getSource('alert-area').setData({
        type: 'FeatureCollection',
        features: rings.map((ring) => ({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [ring] },
            properties: { color: color },
        })),
    });
    var bounds = new maplibregl.LngLatBounds();
    rings.flat().forEach((c) => bounds.extend(c));
    var sidebar = document.body.classList.contains('queue-open')
        ? document.querySelector('.queue').getBoundingClientRect().width : 0;
    map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: sidebar + 60, right: 60 }, maxZoom: 9 });
}

// Another report from a file the decoder has (it keeps the last few); one it has let
// go is downloaded and decoded again
export async function showReport(out, title, key, index, source) {
    try {
        try {
            var result = JSON.parse(await callDecoder('decode_bufr', null, '', key, index));
            result.key = key;
            result.source = source;
        } catch (err) {
            if (!source || !/no longer cached/.test(err.message)) throw err;
            result = await decodeSource(source, '', out, index);
        }
        renderDecoded(out, title, result);
    } catch (err) {
        out.innerHTML = `<div class="pp-status pp-error">Could not decode: ${esc(err.message)}</div>`;
    }
}

// Pan so the selected point isn't hidden under the sidebar or the info panel
export function keepPopupInView() {
    var lngLat = selectedMarker.getLngLat();
    if (!lngLat || !document.body.classList.contains('info-open')) return;
    var point = map.project(lngLat);
    var view = map.getContainer().getBoundingClientRect();
    var phone = PHONE.matches;
    var left = !phone && document.body.classList.contains('queue-open') ? document.querySelector('.queue').getBoundingClientRect().right - view.left : 0;
    var right = phone ? view.width : infobar.getBoundingClientRect().left - view.left;
    var bottom = phone ? infobar.getBoundingClientRect().top - view.top : view.height;
    var margin = 40;
    var dx = point.x < left + margin ? point.x - (left + margin) : point.x > right - margin ? point.x - (right - margin) : 0;
    var dy = point.y < margin ? point.y - margin : point.y > bottom - margin ? point.y - (bottom - margin) : 0;
    if (!dx && !dy) return;
    try {
        map.panBy([dx, dy]);
    } catch (err) {
        // On the zoomed-out globe a large pan can run past a pole; leave the view as is
    }
}

// Headline values shown as tiles, by BUFR descriptor
export const KEY_VALUES = [
    { label: 'Altitude', ids: [7010, 10070] },
    { label: 'Temperature', ids: [12101, 12001] },
    { label: 'Dew point', ids: [12103, 12003] },
    { label: 'Humidity', ids: [13003] },
    { label: 'Pressure (MSL)', ids: [10051] },
    { label: 'Station pressure', ids: [10004], unless: [10051] },
    { label: 'Wind speed', ids: [11002], wind: true },
    { label: 'Visibility', ids: [20001] },
    { label: 'Cloud cover', ids: [20010] },
    { label: 'Precipitation', ids: [13011] },
    { label: 'Zenith path delay', ids: [15031] },
    { label: 'Precipitable water', ids: [13016] },
];

// Wind as separate cards: speed (m/s and knots), the strongest gust when
// reported, and direction with an arrow showing where the wind blows to
export const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

// metric: the measure the speed tile colours the map by (wind at stations, or a satellite wind)
export function windTiles(values, metric) {
    var tile = (label, html, key) => `<div class="pp-tile"${key ? ` data-metric="${key}"` : ''}><div>${esc(label)}</div><strong>${html}</strong></div>`;
    var number = (id) => (values.has(id) && typeof values.get(id)[0] === 'number' ? values.get(id)[0] : null);
    var speed = number(11002), dir = number(11001), gust = number(11041);
    var tiles = [];
    if (speed !== null) tiles.push(tile('Wind speed', `${esc(Number(speed.toFixed(1)))} m/s <small>${knots(speed)} kn</small>`, metric));
    if (dir !== null && speed !== 0) {
        var point = COMPASS_POINTS[Math.round(dir / 22.5) % 16];
        tiles.push(tile('Wind direction', `<span class="wind-arrow" style="--to: ${(dir + 180) % 360}deg" aria-hidden="true">↑</span>`
            + `From ${esc(point)} <small>${esc(Math.round(dir))}°</small>`));
    } else if (speed === 0) {
        tiles.push(tile('Wind direction', 'Calm'));
    }
    // A gust no stronger than the mean wind is an unset or unrelated value; leave it out
    if (gust !== null && gust > (speed || 0)) tiles.push(tile('Wind gust', `${esc(Number(gust.toFixed(1)))} m/s <small>${knots(gust)} kn</small>`));
    return tiles;
}

// Tiles that can style the map: a value the map can be coloured by marks its tile with
// the measure (data-metric), found from its descriptor among the satellite measures or
// the surface ones. A click colours the map by it; a click on the measure in use goes
// back to colouring by observation type
export function metricTileAttr(id, satellite) {
    if (id === undefined) return '';
    var key = Object.keys(METRICS).find((k) => METRICS[k].ids.includes(id) && (METRICS[k].targets === 'satellite') === !!satellite);
    return key ? ` data-metric="${key}"` : '';
}

export function syncMetricTile(tile) {
    // A measure, or satellite (the Satellite tile: each satellite in its colour)
    var key = tile.dataset.metric;
    var on = state.colourBy === key, label = key === SATELLITE_STYLE ? 'satellite' : METRICS[key].label.toLowerCase();
    tile.setAttribute('aria-pressed', on);
    tile.title = on ? `The map is coloured by ${label}. Click to colour it by observation type` : `Colour the map by ${label}`;
}

export function bindMetricTiles(out) {
    out.querySelectorAll('.pp-tile[data-metric]').forEach((tile) => {
        tile.classList.add('pp-tile-metric');
        tile.tabIndex = 0;
        tile.setAttribute('role', 'button');
        syncMetricTile(tile);
        var choose = () => {
            var next = state.colourBy === tile.dataset.metric ? 'kind' : tile.dataset.metric;
            stylePanel.querySelector('select').value = next;
            setColourBy(next, stylePanel);
        };
        tile.addEventListener('click', choose);
        tile.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            choose();
        });
    });
}

export function renderDecoded(out, title, result) {
    var values = new Map();
    for (var [id, name, value, unit] of result.rows) {
        if (!values.has(id)) values.set(id, [value, unit]);
    }
    // Station or site name (001015), falling back to the long name (001019), then a
    // ship's or mobile land station's identifier (001011, e.g. its call sign)
    var name = [1015, 1019, 1011].map((id) => stationName(values.get(id))).find(Boolean);
    // Ocean profilers have a platform number (001087), not a name
    if (!name && values.has(1087) && result.ocean) name = `Float ${values.get(1087)[0]}`;
    // Radars and profilers often only have a short site name (e.g. ROS)
    if (!name) name = shortSiteName(values);
    if (name && title) title.textContent = name;

    var profile = result.profile && result.profile.filter((l) => l[0] > 0);
    // Satellite profiles (e.g. radio occultations) aren't radiosonde soundings, so no Skew-T for them
    var sounding = profile && profile.length >= 2 && !values.has(1007);
    var satellite = values.has(1007);
    // Argo floats, XBT and CTD casts, gliders: temperature and salinity with depth (see src/ocean/profile.js)
    var ocean = !sounding && !satellite && result.ocean && result.ocean.levels.length >= 3 ? result.ocean : null;
    // Wind profilers and radar VAD winds: heights without pressure
    var winds = !sounding && !satellite && !ocean ? windProfileLevels(result.rows) : null;
    // A radar or profiler that measured no winds this time
    var noWinds = !sounding && !satellite && !ocean && !winds && [3, 6].includes((values.get(2003) || [])[0]);
    // Hyperspectral sounders: channel radiances, maybe only the first of them for now (see showSpectrum)
    var spectrum = satellite && (result.fullSpectrum || values.has(14044) || values.has(14046));
    var marine = sounding || winds || ocean || noWinds ? null : marineDetails(result.rows, satellite);
    var tiles = sounding ? soundingTiles(profile) : satellite ? satelliteTiles(result.rows, values) : winds ? windProfileTiles(winds, values)
        : ocean ? oceanTiles(ocean, values) : noWinds ? emptyWindTiles(values) : [];
    for (var key of sounding || satellite || winds || ocean || noWinds ? [] : KEY_VALUES) {
        var id = key.ids.find((i) => values.has(i));
        if (!id || (key.unless && key.unless.some((i) => values.has(i)))) continue;
        if (key.wind) {
            tiles.push(...windTiles(values, 'wind'));
            continue;
        }
        var text = formatValue(...values.get(id)).join(' ');
        tiles.push(`<div class="pp-tile"${metricTileAttr(id, false)}><div>${esc(key.label)}</div><strong>${esc(text)}</strong></div>`);
    }
    // Aircraft: where the flight is from and going (first), and what it's doing (last)
    var flight = aircraftTiles(values);
    tiles.unshift(...flight.route);
    tiles.push(...flight.phase);

    out.innerHTML = `
        ${result.subsets > 1 ? `
        <div class="pp-pager">
            <button type="button" class="btn btn-sm btn-outline-secondary" data-step="-1" aria-label="Previous report"${result.index > 0 ? '' : ' disabled'}>&lsaquo;</button>
            <span class="pp-status">Report ${result.index + 1} of ${result.subsets}</span>
            <button type="button" class="btn btn-sm btn-outline-secondary" data-step="1" aria-label="Next report"${result.index < result.subsets - 1 ? '' : ' disabled'}>&rsaquo;</button>
        </div>` : ''}
        ${name && !title ? `<div class="pp-name">${esc(name)}</div>` : ''}
        ${sounding ? `
        <div class="sounding"></div>
        <button type="button" class="btn btn-sm btn-outline-secondary sounding-expand">Expand sounding</button>` : ''}
        ${winds || noWinds ? '<div class="wind-profile"></div>' : ''}
        ${tiles.length ? `<div class="pp-tiles">${tiles.join('')}</div>` : ''}
        ${ocean ? `
        <div class="ocean-graphs">
            <div class="ocean-graphs-head">
                <div class="pp-section">Profile</div>
                <button type="button" class="btn btn-sm btn-outline-secondary ocean-expand">Expand graphs</button>
            </div>
            <div class="ocean-profile"></div>
            <div class="pp-section ocean-bgc-head">Biogeochemistry</div>
            <div class="ocean-bgc"></div>
            <div class="pp-section ocean-ts-head">T–S diagram</div>
            <div class="ocean-ts"></div>
        </div>` : ''}
        ${spectrum ? '<div class="pp-section">Infrared spectrum</div><div class="pp-spectrum"></div>' : ''}
        ${marine ? `
        <div class="pp-section">${satellite ? 'Sea state from space' : marine.ship ? 'Sea state and ship' : 'Sea state'}</div>
        <div class="pp-marine">
            ${marine.spectrum && marine.spectrum.peak ? '' : marine.compass}
            <div class="pp-tiles">${marine.tiles.join('')}</div>
        </div>
        ${marine.spectrum ? `<div class="pp-section">Wave spectrum</div>
        ${marine.spectrum.peak ? '<div class="wave-spectrum"></div>'
            : '<div class="pp-status">Calm: every band is below the 0.1 m²/Hz the buoy reports to</div>'}` : ''}` : ''}
        <details class="pp-more"${tiles.length ? '' : ' open'}>
            <summary>All decoded fields (${result.rows.length})</summary>
            <table class="table table-sm">${result.rows.map(([id, name, value, unit]) => `
                <tr><td>${esc(titleCase(name))}</td><td>${esc(formatValue(value, unit).join(' ').trim())}</td></tr>`).join('')}
            </table>
        </details>
        ${result.tac ? `
        <details class="pp-more" open>
            <summary>Report as sent (SYNOP code)</summary>
            <pre class="pp-text">${esc(result.tac)}</pre>
        </details>` : ''}`;
    out.querySelectorAll('.pp-pager button').forEach((button) => button.addEventListener('click', () => {
        showReport(out, title, result.key, result.index + Number(button.dataset.step), result.source);
    }));
    bindMetricTiles(out);
    if (marine && marine.spectrum && marine.spectrum.peak) {
        // The compass's wind, wave and heading arrows go on the spectrum instead
        renderWaveSpectrum(out.querySelector('.wave-spectrum'), marine.spectrum, { width: 300, ...marine.dirs });
    }
    if (winds || noWinds) showWindProfiles(out.querySelector('.wind-profile'), result);
    if (ocean) {
        // Temperature and salinity, then any biogeochemical variables, then the T–S diagram;
        // a part with nothing to draw goes with its heading (an XBT has temperature only)
        var graphs = out.querySelector('.ocean-graphs');
        var drop = (cls) => graphs.querySelectorAll(`.${cls}, .${cls}-head`).forEach((el) => el.remove());
        renderOceanProfile(graphs.querySelector('.ocean-profile'), ocean, { width: 300, height: 340, only: 'physical' });
        if (!renderOceanProfile(graphs.querySelector('.ocean-bgc'), ocean, { width: 300, height: 300, only: 'bgc' })) drop('ocean-bgc');
        if (!renderTSDiagram(graphs.querySelector('.ocean-ts'), ocean, { width: 300, height: 240 })) drop('ocean-ts');
        var when = soundingTime(values);
        var subtitle = [when ? when.toUTCString().replace(':00 GMT', ' UTC') : null, `${ocean.levels.length.toLocaleString()} levels`].filter(Boolean).join(' · ');
        graphs.querySelector('.ocean-expand').addEventListener('click', () => openOceanProfile(ocean, name || (title && title.textContent) || 'Ocean profile', subtitle));
    }
    if (spectrum) showSpectrum(out.querySelector('.pp-spectrum'), result);
    if (sounding) {
        var label = name || (title && title.textContent) || 'Sounding';
        showSoundingCharts(out.querySelector('.sounding'), profile, { width: 300, height: 390, time: soundingTime(values) });
        out.querySelector('.sounding-expand').addEventListener('click', () => openSounding(profile, label, values));
    }
}

// Ships, buoys and other marine reports: sea temperature, waves, swell, ice and
// the platform's own motion. Wave and swell groups can repeat (e.g. a first and
// second swell system), so every occurrence is kept. Returns null when the
// report has none of these.
// From a satellite, the platform's motion (001012/001013) is the satellite's, not a ship's
export function marineDetails(rows, satellite) {
    var all = new Map();
    for (var [id, , value] of rows) {
        if (typeof value !== 'number') continue;
        all.has(id) ? all.get(id).push(value) : all.set(id, [value]);
    }
    var first = (...ids) => ids.map((id) => all.get(id)).find(Boolean)?.[0];
    var nth = (id, i) => (all.get(id) || [])[i];
    // id: the descriptor of a value the map can be coloured by (see metricTileAttr)
    var tile = (label, text, id) => `<div class="pp-tile"${metricTileAttr(id, satellite)}><div>${esc(label)}</div><strong>${esc(text)}</strong></div>`;
    var wave = (height, period, from) => [
        height !== undefined ? `${Number(height.toFixed(1))} m` : null,
        period !== undefined ? `${period} s` : null,
        from !== undefined ? `from ${from}°` : null,
    ].filter(Boolean).join(' · ');

    var tiles = [];
    var sea = first(22043, 22049, 22042);
    if (sea !== undefined) tiles.push(tile('Sea temperature', `${(sea - 273.15).toFixed(1)} °C`, 22043));
    var salinity = first(22062);
    if (salinity !== undefined) tiles.push(tile('Salinity', `${salinity} ‰`));
    // Wave buoys: significant and maximum height, mean period and the direction
    // of the dominant waves; the peak period comes from the spectrum when there
    // is one, since the reported value is often unset
    var spectrum = waveSpectrum(rows);
    var peak = spectrum && spectrum.peak ? 1 / spectrum.peak.f : first(22071) > 1 ? first(22071) : undefined;
    var dominant = first(22076);
    if (all.has(22070)) {
        tiles.push(tile('Wave height', [`${first(22070)} m significant`, all.has(22073) ? `max ${first(22073)} m` : null].filter(Boolean).join(' · '), 22070));
    }
    if (all.has(22074) || peak !== undefined) {
        tiles.push(tile('Wave period', [all.has(22074) ? `mean ${first(22074)} s` : null, peak !== undefined ? `peak ${peak.toFixed(1)} s` : null,
            dominant !== undefined ? `from ${dominant}°` : null].filter(Boolean).join(' · ')));
    }
    // Instrumental waves (022021/022011), then estimated wind waves (022022/022012)
    if (all.has(22021) || all.has(22011)) tiles.push(tile('Waves (measured)', wave(first(22021), first(22011))));
    if (all.has(22022) || all.has(22012)) tiles.push(tile('Wind waves', wave(first(22022), first(22012))));
    var swells = Math.max(...[22003, 22013, 22023].map((id) => (all.get(id) || []).length));
    var swellDirs = [];
    for (var i = 0; i < swells; i++) {
        swellDirs.push(nth(22003, i));
        tiles.push(tile(swells > 1 ? `Swell ${i + 1}` : 'Swell', wave(nth(22023, i), nth(22013, i), nth(22003, i))));
    }
    var course = first(1012), speed = first(1013);
    if (course !== undefined || speed !== undefined) {
        tiles.push(tile(satellite ? 'Satellite heading' : 'Ship heading', speed === 0 ? 'Stopped'
            : [course !== undefined ? `${course}°` : null, speed !== undefined ? `${speed} m/s (${knots(speed)} kn)` : null].filter(Boolean).join(' at ')));
    }
    var ice = first(20031);
    if (ice !== undefined) tiles.push(tile('Ice on deck', `${Math.round(ice * 100)} cm`));
    if (!tiles.length) return null;

    var waveDirs = [dominant, ...swellDirs].filter((d) => d !== undefined);
    var dirs = { wind: first(11001), waves: waveDirs, heading: speed ? course : undefined };
    return { tiles, spectrum, dirs, ship: course !== undefined || speed !== undefined, compass: marineCompass(dirs.wind, dirs.waves, dirs.heading) };
}

// src/plots/forecast.js)
// The WIS2 notification the point came from (for a decoded report, the
// notification of the file it was decoded from), as highlighted JSON
export function showMessage(out, record) {
    var message = record.notification;
    if (!message) {
        out.innerHTML = '<div class="pp-status">No notification kept for this point.</div>';
        return;
    }
    var json = JSON.stringify(message, null, 2);
    out.innerHTML = `
        <div class="pp-message-head">
            <span class="pp-status">WIS2 notification${isGateway(record) || record.decodedLayer ? ' for the file this report was decoded from' : ''}</span>
            <button type="button" class="btn btn-sm btn-outline-secondary">Copy</button>
        </div>
        <div class="pp-mono pp-message-topic"></div>
        <pre class="pp-json"></pre>`;
    out.querySelector('.pp-message-topic').textContent = record.topic;
    out.querySelector('.pp-json').innerHTML = highlightJson(json);
    var copy = out.querySelector('button');
    copy.addEventListener('click', () => {
        navigator.clipboard.writeText(json).then(() => {
            copy.textContent = 'Copied';
            setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
        }).catch(() => { copy.textContent = 'Copy failed'; });
    });
}

// in time (the charts and the sounding viewer are in src/plots/sounding.js)
export const WIND_PROFILE_REPORTS = 11;  // The site's other reports added to the one opened...

export const WIND_PROFILE_HOURS = 24;    // ...within this long of it

// The report opened (all the times it holds), with the site's other reports on the
// map either side of it in time; those not decoded yet are downloaded and decoded
// one at a time. The WIND_PROFILE_COLUMNS times nearest the opened report are drawn.
export function showWindProfiles(container, result) {
    var record = byDataId.get(result.key);
    var opened = record ? observedAt(record) : Date.now();
    var columns = [];
    var add = (more, fallback) => (more || []).forEach((c) => {
        var time = c.time || fallback;
        if (!columns.some((k) => k.time === time)) columns.push({ time, levels: c.levels });
    });
    add(windProfileColumnsOrEmpty(result.rows, opened), opened);
    var draw = (status) => {
        var nearest = columns.slice().sort((a, b) => Math.abs(a.time - opened) - Math.abs(b.time - opened)).slice(0, WIND_PROFILE_COLUMNS);
        renderWindProfile(container, nearest, { width: 300, height: 280, status });
    };
    var site = reportSite(result.rows);
    var others = !record ? [] : [...records.values()].filter((r) => r !== record && r.source
            && (record.wsi ? r.wsi === record.wsi : r.topic === record.topic && distanceKm(r.coords, record.coords) < 5)
            && Math.abs(observedAt(r) - opened) < WIND_PROFILE_HOURS * 3600e3)
        .sort((a, b) => Math.abs(observedAt(a) - opened) - Math.abs(observedAt(b) - opened))
        .slice(0, WIND_PROFILE_REPORTS);
    draw(others.length ? 'Adding this site’s other reports…' : '');
    if (!others.length) return;
    (async () => {
        for (var r of others) {
            if (!container.isConnected) return;  // The popup moved on
            try {
                if (!r.decoded) {
                    var data = await fetchData(r.source);
                    if (!data.bufr) continue;
                    var key = r.source.dataId || data.url;
                    var decoded = JSON.parse(await callDecoder('decode_bufr', data.bytes, r.wsi || '', key));
                    decoded.key = key;
                    decoded.source = r.source;  // For the pager, should the decoder let the file go
                    r.decoded = decoded;
                    setFeatureProperties(r, metricValues(r));
                }
                var rows = r.decoded.rows || [];
                var where = reportSite(rows);
                // A file can hold several sites; keep only this one's, once per time
                if (site && where && distanceKm(site, where) > 5) continue;
                add(windProfileColumnsOrEmpty(rows, observedAt(r)), observedAt(r));
                if (container.isConnected) draw('Adding this site’s other reports…');
            } catch (err) {
                console.debug(`Could not decode a wind profile: ${err.message}`);
            }
        }
        if (container.isConnected) draw('');
    })();
}
