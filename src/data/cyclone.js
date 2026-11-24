// Tropical cyclone track forecasts in BUFR (template 3 16 082; ECMWF's ensemble, JSXX..ECEP on
// the GTS, and deterministic ones like it): one subset per ensemble member, each a storm
// (001025 storm identifier, 001027 its name), its run (004001-004005) and, at each forecast
// step (008021 = 4, then 004024 hours), the storm's centre (008005 = 1, or 4 at the analysis)
// with its central pressure (010051), and where its strongest wind is (008005 = 3) with that
// wind (011012). Missing values are left out of the decoded rows, so a member that lost the
// storm simply has no positions after that step.
//
// These are forecasts, not observations: rather than a point per member (where the first
// position that happened to be there would put it), each file is drawn as tracks: every
// member a thin line, and the ensemble mean, where at least half the members still have
// the storm, a bold one with a dot every 24 hours. A click on a track shows the mean's table.
// Each storm keeps only its latest run
import maplibregl from 'maplibre-gl';
import { esc } from '../lib/util.js';
import { effectiveHidden } from '../map/layers.js';
import { subscribe } from '../state.js';
import { track } from '../lib/analytics.js';
import { FORECAST_PAGE } from '../page.js';

const STORMS_MAX = 40;
const storms = new Map();  // storm key -> { key, storm, name, centre, run, layer, members, mean }
let map = null;
let deps = { pointAt: () => null };
let popup = null;

// Whether a subset's decoded rows ([descriptor, name, value, unit]) are a cyclone track:
// a storm identifier, forecast steps and meteorological attribute significance
export function isCycloneTrack(rows) {
    var ids = new Set((rows || []).map((r) => r[0]));
    return (ids.has(1025) || ids.has(1027)) && ids.has(4024) && ids.has(8005);
}

// One member's track from its rows: { storm, name, centre, member, run (ms), points:
// [{ h, lat, lon, p (hPa), wind (m/s) }] in step order, only steps with a position }
export function cycloneTrack(rows) {
    var out = { storm: null, name: null, centre: null, member: null, run: null, points: [] };
    var date = {};
    var at = new Map();  // hours -> point
    var h = 0, sig = null, lat = null;
    var point = () => {
        if (!at.has(h)) at.set(h, { h, lat: null, lon: null, p: null, wind: null });
        return at.get(h);
    };
    for (var [id, , v] of rows) {
        if (id === 1025) out.storm = String(v).trim();
        else if (id === 1027) out.name = String(v).trim();
        else if (id === 1033 && out.centre == null) out.centre = v;
        else if (id === 1091) out.member = v;
        else if (id >= 4001 && id <= 4005 && !(id in date)) date[id] = v;
        else if (id === 4024) h = v;
        else if (id === 8005) { sig = v; lat = null; }
        else if (id === 5001 || id === 5002) lat = v;
        else if ((id === 6001 || id === 6002) && lat != null) {
            // The storm's centre: at the analysis, its position there (4) beats the warning's (1)
            if (sig === 1 || sig === 4) {
                var p = point();
                if (p.lat == null || sig === 4) { p.lat = lat; p.lon = v; }
            }
            lat = null;
        } else if (id === 10051 && (sig === 1 || sig === 4)) point().p = v / 100;
        else if (id === 11012 && sig === 3) point().wind = v;
    }
    if (date[4001]) out.run = Date.UTC(date[4001], (date[4002] || 1) - 1, date[4003] || 1, date[4004] || 0, date[4005] || 0);
    out.points = [...at.values()].filter((p) => p.lat != null && p.lon != null).sort((a, b) => a.h - b.h);
    return out;
}

// Longitudes made continuous along a track, so one crossing 180° doesn't streak across the map
function unwrapped(points) {
    var prev = null;
    return points.map((p) => {
        var lon = p.lon;
        if (prev != null) while (lon - prev > 180) lon -= 360;
        if (prev != null) while (prev - lon > 180) lon += 360;
        prev = lon;
        return { ...p, lon };
    });
}

// The ensemble mean at each step at least half the members (with any position) still have
function ensembleMean(members) {
    var tracks = members.filter((m) => m.points.length);
    if (tracks.length <= 1) return tracks.length ? tracks[0].points : [];
    var steps = new Map();
    for (var m of tracks) for (var p of m.points) {
        if (!steps.has(p.h)) steps.set(p.h, []);
        steps.get(p.h).push(p);
    }
    var ref = tracks[0].points[0].lon;
    var mean = [];
    for (var [h, ps] of [...steps].sort((a, b) => a[0] - b[0])) {
        if (ps.length < tracks.length / 2) continue;
        var avg = (key) => {
            var vs = ps.map((p) => p[key]).filter((v) => v != null);
            return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
        };
        // Longitudes near the first member's start, so the mean of 179° and -179° is 180°
        var lons = ps.map((p) => p.lon + Math.round((ref - p.lon) / 360) * 360);
        mean.push({ h, lat: avg('lat'), lon: lons.reduce((a, b) => a + b, 0) / lons.length,
            p: avg('p'), wind: avg('wind'), members: ps.length });
    }
    return mean;
}

// A decoded file's subsets (each its rows), from decodeQueue: drawn as its storm's tracks.
// layer: the legend row whose switch shows or hides them (the decode layer it came by)
export function addCycloneFile(job, subsetRows, layer) {
    var members = subsetRows.map(cycloneTrack).filter((m) => m.points.length);
    if (!members.length) return 0;
    var first = members[0];
    var key = `${first.centre}|${first.storm || first.name}`;
    var old = storms.get(key);
    if (old && old.run > (first.run || 0)) return 0;  // An older run than the one drawn
    storms.delete(key);
    storms.set(key, { key, storm: first.storm, name: first.name && first.name !== first.storm ? first.name : null,
        centre: centreName(first.centre, job.topic), run: first.run, layer, total: subsetRows.length,
        members: members.map((m) => ({ member: m.member, points: unwrapped(m.points) })), mean: unwrapped(ensembleMean(members)) });
    if (storms.size > STORMS_MAX) storms.delete(storms.keys().next().value);
    redraw();
    return members.length;
}

const CENTRES = { 98: 'ECMWF', 7: 'NCEP', 34: 'JMA', 74: 'Met Office', 54: 'ECCC', 38: 'CMA', 85: 'Météo-France' };
function centreName(id, topic) {
    return CENTRES[id] || (id != null ? `Centre ${id}` : (topic || '').split('/a/wis2/')[1]?.split('/', 1)[0]) || '';
}

function redraw() {
    if (!map || !map.getSource('cyclones')) return;
    var hidden = effectiveHidden();
    var features = [];
    for (var s of storms.values()) {
        if (hidden.includes(s.layer)) continue;
        s.members.forEach((m, i) => {
            if (m.points.length > 1) features.push({ type: 'Feature', properties: { kind: 'member', storm: s.key, member: i },
                geometry: { type: 'LineString', coordinates: m.points.map((p) => [p.lon, p.lat]) } });
            // Where the member first has the storm: at the start, or where it forms later on
            features.push({ type: 'Feature', properties: { kind: 'begin', storm: s.key, member: i },
                geometry: { type: 'Point', coordinates: [m.points[0].lon, m.points[0].lat] } });
        });
        if (s.mean.length > 1) features.push({ type: 'Feature', properties: { kind: 'mean', storm: s.key },
            geometry: { type: 'LineString', coordinates: s.mean.map((p) => [p.lon, p.lat]) } });
        for (var p of s.mean) {
            if (p.h % 24 === 0) features.push({ type: 'Feature', properties: { kind: p.h === 0 ? 'start' : 'day', storm: s.key },
                geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });
        }
    }
    map.getSource('cyclones').setData({ type: 'FeatureCollection', features });
    if (FORECAST_PAGE) renderCycloneList();
}

// Every point of a storm's tracks, for zooming to it
function stormBounds(s) {
    var bounds = new maplibregl.LngLatBounds();
    for (var m of s.members) for (var p of m.points) bounds.extend([p.lon, p.lat]);
    return bounds;
}

// On the forecasts page, the storms above the forecast products: a click zooms to its tracks
// and opens its popup
function renderCycloneList() {
    var section = document.querySelector('.legend-section-forecast');
    if (!section) return;
    var box = section.querySelector('.forecast-cyclones');
    if (!box) {
        box = document.createElement('div');
        box.className = 'forecast-cyclones';
        var products = section.querySelector('.forecast-products');
        products ? products.before(box) : section.appendChild(box);
        box.addEventListener('click', (e) => {
            var button = e.target.closest('button[data-storm]');
            var s = button && storms.get(button.dataset.storm);
            if (!s) return;
            map.fitBounds(stormBounds(s), { padding: 60, maxZoom: 6 });
            var at = s.mean[0] || s.members[0].points[0];
            if (popup) popup.remove();
            popup = new maplibregl.Popup({ maxWidth: '440px', className: 'grib-popup' }).setLngLat([at.lon, at.lat])
                .setHTML(stormHtml(s, null)).addTo(map);
            track('cyclone_open', { storm: s.storm, centre: s.centre, from: 'list' });
        });
    }
    var list = [...storms.values()].sort((a, b) => (b.run || 0) - (a.run || 0));
    box.hidden = !list.length;
    box.innerHTML = list.length ? `<div class="forecast-centre"><strong>Tropical cyclones</strong><ul>${list.map((s) =>
        `<li><button type="button" data-storm="${esc(s.key)}" title="Zoom to its tracks">${esc(s.name || s.storm || 'Storm')}`
        + `<small>${esc(s.centre)} ${s.total > 1 ? `ensemble, ${s.members.length} members` : 'forecast'}`
        + `${s.run ? ` · run ${validTime(s.run, 0)}` : ''}</small></button></li>`).join('')}</ul></div>` : '';
}

function fmt(v, digits = 0) {
    return v == null ? '–' : v.toFixed(digits);
}

// "24/11 12 UTC"
function validTime(run, h) {
    if (!run) return `+${h} h`;
    var d = new Date(run + h * 3600e3);
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1} ${String(d.getUTCHours()).padStart(2, '0')} UTC`;
}

// A track every 12 hours as a table (members: a Members column, for the ensemble mean)
function trackTable(run, points, members) {
    var rows = points.filter((p) => p.h % 12 === 0).map((p) => `<tr><td>+${p.h} h</td><td>${validTime(run, p.h)}</td>
        <td>${fmt(p.lat, 1)}, ${fmt(((p.lon + 540) % 360) - 180, 1)}</td><td>${fmt(p.p)}</td><td>${fmt(p.wind)}</td>
        ${members ? `<td>${p.members}</td>` : ''}</tr>`).join('');
    return `<table class="grib-products cyclone-table"><tr><th>Lead</th><th>Valid</th><th>Centre</th><th>hPa</th><th>Wind m/s</th>
        ${members ? '<th>Members</th>' : ''}</tr>${rows}</table>`;
}

// ECMWF numbers storms that form during the forecast from 70 (70E: the eastern Pacific's
// first such): there's no storm yet, only members that make one
function heading(s) {
    var genesis = /^([7-9]\d)[A-Z]$/.test(s.storm || '');
    var run = s.run ? new Date(s.run).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
    // A member that never has the storm isn't in the file at all
    var ensemble = s.total > 1 ? `ensemble: ${s.members.length} members have it` : 'forecast';
    return `<div class="cyclone-head"><strong>Cyclone track forecast ${esc(s.name || s.storm || '')}</strong>
        <small>${esc(s.centre)} ${ensemble} · run ${esc(run)}${genesis ? ' · a storm that forms during the forecast' : ''}</small></div>`;
}

// Each member in a line: when it has the storm, where it starts, its deepest pressure and strongest wind
function membersTable(s) {
    var rows = s.members.map((m) => {
        var ps = m.points.map((p) => p.p).filter((v) => v != null), ws = m.points.map((p) => p.wind).filter((v) => v != null);
        var a = m.points[0], b = m.points[m.points.length - 1];
        return `<tr><td>${m.member ?? '–'}</td><td>+${a.h}–${b.h} h</td><td>${fmt(a.lat, 1)}, ${fmt(((a.lon + 540) % 360) - 180, 1)}</td>
            <td>${ps.length ? fmt(Math.min(...ps)) : '–'}</td><td>${ws.length ? fmt(Math.max(...ws)) : '–'}</td></tr>`;
    }).join('');
    return `<table class="grib-products cyclone-table"><tr><th>Member</th><th>Has it</th><th>Starts at</th><th>Lowest hPa</th><th>Top wind</th></tr>${rows}</table>`;
}

// A storm's popup: the member clicked (its track), else the ensemble mean, and every member
function stormHtml(s, member) {
    var m = member != null ? s.members[member] : null;
    var parts = [heading(s)];
    if (m) parts.push(`<div class="cyclone-sub">Member ${m.member ?? ''}</div>`, trackTable(s.run, m.points, false));
    else if (s.mean.length > 1) parts.push(`<div class="cyclone-sub">Ensemble mean, where at least half the members have the storm</div>`, trackTable(s.run, s.mean, s.total > 1));
    if (s.members.length > 1) parts.push(`<div class="cyclone-sub">All members</div>`, membersTable(s));
    return `<div class="cyclone-popup">${parts.join('')}</div>`;
}

// The message popup's view of one decoded member (popup.js renderDecoded)
export function cycloneMemberHtml(rows) {
    var t = cycloneTrack(rows);
    var s = { name: t.name, storm: t.storm, centre: centreName(t.centre), run: t.run, total: 1, members: [t], mean: [] };
    var drawn = [...storms.values()].some((x) => x.storm === t.storm);
    return `<div class="cyclone-popup">${heading(s)}${t.points.length ? trackTable(t.run, t.points, false) : '<p>This member has no positions.</p>'}
        ${drawn ? '<p class="cyclone-note">Every member is drawn on the map: click a track for all of them.</p>' : ''}</div>`;
}

export function initCyclones(options) {
    deps = { ...deps, ...options };
    map = options.map;
    subscribe(['hiddenLayers'], redraw);
}

export function addCycloneLayers(before) {
    map.addSource('cyclones', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'cyclone-members', type: 'line', source: 'cyclones', filter: ['==', ['get', 'kind'], 'member'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#e03131', 'line-width': 1, 'line-opacity': 0.35 } }, before);
    map.addLayer({ id: 'cyclone-mean', type: 'line', source: 'cyclones', filter: ['==', ['get', 'kind'], 'mean'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#a51111', 'line-width': 3 } }, before);
    // Where each member first has the storm: small open rings
    map.addLayer({ id: 'cyclone-begins', type: 'circle', source: 'cyclones', filter: ['==', ['get', 'kind'], 'begin'],
        paint: { 'circle-color': '#ffffff', 'circle-opacity': 0.8, 'circle-radius': 3, 'circle-stroke-color': '#e03131', 'circle-stroke-width': 1.5 } }, before);
    map.addLayer({ id: 'cyclone-days', type: 'circle', source: 'cyclones', filter: ['in', ['get', 'kind'], ['literal', ['day', 'start']]],
        paint: { 'circle-color': ['match', ['get', 'kind'], 'start', '#ffffff', '#a51111'], 'circle-radius': ['match', ['get', 'kind'], 'start', 6, 3.5],
            'circle-stroke-color': '#a51111', 'circle-stroke-width': ['match', ['get', 'kind'], 'start', 3, 1] } }, before);
    var layers = ['cyclone-members', 'cyclone-begins', 'cyclone-mean', 'cyclone-days'];
    map.on('click', (e) => {
        if (deps.pointAt(e.point)) return;  // An observation there takes the click
        var box = [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]];
        var hits = map.queryRenderedFeatures(box, { layers });
        // The mean (or its dots) when it's there, else the member clicked
        var hit = hits.find((f) => ['mean', 'day', 'start'].includes(f.properties.kind)) || hits[0];
        var s = hit && storms.get(hit.properties.storm);
        if (!s) return;
        if (popup) popup.remove();
        var member = ['member', 'begin'].includes(hit.properties.kind) ? Number(hit.properties.member) : null;
        popup = new maplibregl.Popup({ maxWidth: '440px', className: 'grib-popup' }).setLngLat(e.lngLat).setHTML(stormHtml(s, member)).addTo(map);
        track('cyclone_open', { storm: s.storm, centre: s.centre });
    });
    for (var layer of layers) {
        map.on('mousemove', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }
    redraw();
}
