// The main page: the live map, its sidebar and popups. Pieces other pages can use
// live in their own modules
import maplibregl from 'maplibre-gl';
// Stylesheets in cascade order: the app's own rules win over Bootstrap's and MapLibre's
import './bootstrap.scss';  // Only the parts of Bootstrap the page uses
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { state, setState, notify, subscribe } from './state.js';
import { noteCacheLinks } from './data/caches.js';
import { DATA_LINKS_MAX, linksSeen, decodeHref, fetchTracked, rememberLinks, bufrSource, fetchData, bufrPart, isUtf8 } from './data/download.js';
import { COLORS, OBS_CLASSES, METRICS, COLOURABLE, SATELLITE_LAYERS, NO_VALUE_COLOR, SOURCE_COLORS, SATELLITE_STYLE, WAVE_STYLE, WAVE_CLASSES } from './config.js';
import { parseMessage, DISCIPLINES, FORMATS, isDataLink, isUpdate, formatOf, GATEWAY_TOPIC, GATEWAY_SATELLITE, GATEWAY_AIRCRAFT,
    GATEWAY_UPPER_AIR, isSpaceBased, disciplineOf, topicClass, stationId, pointFor, wis2boxVersion } from './messages/messages.js';
import { esc, darken, svgEl, knots, PHONE, TOUCH } from './lib/util.js';
import { distanceKm, segments, unwrap, convexHull, inOrNearRing, H3_RESOLUTION, H3_RESOLUTION_MAX, h3SampleDeg, getResolution, h3Cell, h3Neighbors, cellRing, cellsOutline } from './lib/geo.js';
import { connectFastest, brokerState } from './messages/mqtt.js';
import { callDecoder, preloadDecoder, decoderReady, decoderGaveUp, onDecoderSettled } from './data/decoder.js';
import { SATELLITE_NAMES, satelliteOscarUrl, INSTRUMENT_NAMES, AMV_METHODS, PIXEL_TYPES, satelliteNamed } from './data/satellite/names.js';
import { showSpectrum } from './data/satellite/spectrum.js';
import { oceanTiles, renderOceanProfile, renderTSDiagram, openOceanProfile } from './data/ocean/profile.js';
import { waveSpectrum, miniWaveSpectrum, renderWaveSpectrum, marineCompass } from './data/ocean/wavespec.js';
import { createOverview } from './lib/ui/overview.js';
import { WIND_PROFILE_COLUMNS, openSounding, renderWindProfile, reportSite, showSoundingCharts, soundingTiles, soundingTime, windProfileColumns,
    windProfileLevels, windProfileTiles } from './plots/sounding.js';
import { showForecast } from './plots/forecast.js';
import { reportClass, reportId, reportTime, shipTrackKey } from './data/reports.js';
import { renderCitypage } from './plots/citypage.js';
import { renderCap } from './data/alerts/cap.js';
import { SYNOP_TOPIC, plotSynopBulletin, rememberStation } from './data/gts/synop.js';
import { seenFlash, flashTime, plotLightningText } from './data/lightning/lightning.js';
import { plotCitypage } from './data/alerts/citypage.js';
import { initGrib, addGribLayers, GRIB_LAYERS } from './data/grib/grib.js';
import { initRadar, RADAR_COLORS, RADAR_FILE_MAX_BYTES, radars, plotRadar, radarHeading, radarNoReflectivity, radarThrottled } from './data/radar/radar.js';
import { DIAMOND_HALF, arrowSdf, squareSdf, diamondSdf } from './map/symbols.js';
import { map, centreOnVisitor } from './map/map.js';
import { GTS_OPT_IN, OWN_SECTION, LAYER_GROUPS, hiddenLayers, LAYER_PARENTS, ancestors, effectiveHidden, seenLayers } from './map/layers.js';
import { records, byDataId, latestByStation, newId, observedAt, initPoints, layerOf, setFeatureProperties, takePending, isGateway, isSpaceRecord, removePoint, addPoint, pools, MAX_SATELLITE_POINTS, linkDecoded } from './map/points.js';
import { formatValue, formatLabel, formatBytes, timeAgo, titleCase, stationName, scaleLabel, formatMetric, highlightJson } from './lib/format.js';
import { aircraftTrack, aircraftAltitude, aircraftTiles, trackRoute } from './data/aviation/aircraft.js';
import { initAirports, queueAirports } from './data/aviation/airports.js';
import { makeMinimizable, initKeyToggles, startKeyToggles, keyToggle, hiddenKeyRows, bindKeyToggles } from './lib/ui/panels.js';
import { externalStation, twinKind, twinsNear, TWIN_LAYERS } from './map/twins.js';
import { TRACK_REBUILD_MS, rebuildTracks, shipTrackLayers, trackKey, markTracksDirty } from './map/tracks.js';
import { tickPulses } from './map/pulses.js';
import { startWindFlow } from './map/windFlow.js';
import { RecentreControl } from './map/recentre.js';
import { welcomeFirstVisit } from './lib/ui/welcome.js';
import { satelliteColours, satelliteLabel, satelliteMatch, syncSatelliteRows, satelliteKey, satelliteName, addSatelliteRow, satelliteLink } from './data/satellite/rows.js';
import { metricValues } from './data/metrics.js';
import { swathsBuilt, SWATH_FLUSH_MS, flushSwaths } from './data/satellite/coverage.js';
import { addCoverageLayers } from './data/satellite/coverageLayers.js';
import { SATELLITE_PAGE, PAGE_TOPICS } from './page.js';
import { initFeedPause, receive } from './messages/feedPause.js';
import { initAnalytics, countMessage, trackOnce } from './lib/analytics.js';
import { isColourable, isColourTarget, satelliteStyled, IS_AIRCRAFT, setColourBy, paintAge, showColourStatus, windArrows, POINT_RADIUS } from './map/colour.js';
import { showDatasetFromUrl, gdcSearched, searchCatalogue, sortDatasetRows, datasetId, showDatasetInPopup, filterDatasetRows, initCatalogue, noteDataset, rankGdcs, startDataset, shownDataset, setShownDataset, setStartDataset } from './data/catalogue.js';
import { scheduleReplay, replayPosition, replayWindowMs, REPLAY_TICKS, replayMinutesAt, replayWindowLabel, setReplayWindow, setReplayWindowMs, REPLAY_RANGE_MINUTES } from './messages/replay.js';
import { applyMapFilter } from './map/filter.js';
import { startColour, writeFiltersToUrl, readFiltersFromUrl } from './lib/url.js';
import { rebuildQueue, QueueControl, selectQueueTab, queueMessage, decodeKey } from './lib/ui/queue.js';
import { passesFilters } from './lib/filters.js';
import { decodePlotted, decodeEnabled, DECODE_LAYERS, setDecodeEnabled } from './data/decodeQueue.js';
import { wis2boxOf } from './messages/wis2box.js';
import { onMessage, topicOnPage } from './messages/handle.js';
import { updateModelField, modelFieldUrl } from './map/modelFields.js';
import { attachSpectrum } from './data/stationDecode.js';
import { hoverLabel, openPopup, closeInfo, infobar } from './lib/ui/popup.js';
import { stylePanel, updateMapKey, keyChanged, refreshKey, LegendControl, StyleControl, MapKey, addAbout } from './lib/ui/legend.js';

// Colours, kinds of observation and the measures to colour by are in config.js

// Keeps the model field on the current hour
setInterval(() => {
    if (stylePanel && state.modelFieldOn) updateModelField(stylePanel);
}, 10 * 60 * 1000);

// Key rows switch layers through the sidebar, or straight in hiddenLayers for any without a row
initKeyToggles({
    hiddenLayers,
    directChange: () => {
        notify('hiddenLayers');
        applyMapFilter();
    },
    refresh: () => updateMapKey(),
});
// Airports' METARs (src/data/aviation/airports.js), fetched while their layer is on
initAirports({
    shown: () => !effectiveHidden().includes('airports'),
    centre: () => map.getCenter(),
    addStation: (stations, station) => externalStation(stations, station),
});
// What data modules plot through (src/map/points.js)
initPoints({
    linked: (key, record) => linkDecoded(key, record),
    plotted: (kind, n) => { decodePlotted[kind] += n; },
    decoding: (kind) => decodeEnabled.has(kind),
});

// Weather radar images (src/radar/radar.js), drawn as radar files are decoded
initRadar({
    map,
    enabled: () => decodeEnabled.has('radar'),
    shown: () => !effectiveHidden().includes('radar'),
    plotted: () => decodePlotted.radar++,
    changed: () => updateMapKey(),
});

// GRIB files' grids (src/data/grib/grib.js), outlined while that row is on
initGrib({
    map,
    enabled: () => decodeEnabled.has('grib'),
    plotted: () => decodePlotted.grib++,
    changed: () => updateMapKey(),
    pointAt: (point) => nearestPoint(point),
});

// Layers that draw observation points: WIS2 circles and GTS diamonds
const POINT_LAYERS = ['points', 'points-gts', 'points-ext', 'points-arrow', 'points-spectrum'];

function nearestPoint(point) {
    var reach = TOUCH.matches ? 14 : 5;
    var box = [[point.x - reach, point.y - reach], [point.x + reach, point.y + reach]];
    var best = null, bestDistance = Infinity;
    for (var f of map.queryRenderedFeatures(box, { layers: POINT_LAYERS.filter((id) => map.getLayer(id)) })) {
        var record = records.get(f.id);
        if (!record) continue;
        var p = map.project(record.coords), d = Math.hypot(p.x - point.x, p.y - point.y);
        if (d < bestDistance) { best = f; bestDistance = d; }
    }
    return best;
}

// Point size by zoom (POINT_RADIUS, in colour.js), shared by the WIS2 circles and the GTS diamonds;
// icon-size per pixel of circle radius, with diamonds a little larger so their area matches a circle's
const DIAMOND_SCALE = 1.3 / (DIAMOND_HALF / 2);

// Altitude in metres to a colour, light near the ground to deep at cruise height
const ALTITUDE_COLORS = ['interpolate', ['linear'], ['coalesce', ['get', 'alt'], 0],
    0, '#99e9f2', 3000, '#22b8cf', 7000, '#1971c2', 11000, '#5f3dc4'];

// Extrusion height in metres from a feature property, exaggerated when zoomed
// out so heights stay visible on the globe
function altitudeHeight(property) {
    var alt = ['get', property];
    return ['interpolate', ['linear'], ['zoom'], 1, ['*', alt, 60], 4, ['*', alt, 20], 8, ['*', alt, 4], 12, alt];
}

map.on('load', () => {
    var empty = { type: 'FeatureCollection', features: [] };
    map.addSource('points', { type: 'geojson', data: empty });
    map.addSource('pulses', { type: 'geojson', data: empty });
    // Optional model field for the selected measure (ECCC GeoMet WMS), under everything else
    map.addSource('model-field', { type: 'raster', tiles: [modelFieldUrl('temp')], tileSize: 256,
        attribution: 'Model fields: ECCC GDPS/GDWPS via GeoMet' });
    map.addLayer({ id: 'model-field', type: 'raster', source: 'model-field', layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.55, 'raster-fade-duration': 0 } });
    map.addSource('alert-area', { type: 'geojson', data: empty });
    map.addLayer({
        id: 'alert-area',
        type: 'fill',
        source: 'alert-area',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 },
    });
    map.addLayer({
        id: 'alert-area-line',
        type: 'line',
        source: 'alert-area',
        paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
    });
    map.addLayer({
        id: 'pulses',
        type: 'circle',
        source: 'pulses',
        paint: {
            'circle-color': 'rgba(0, 0, 0, 0)',
            // The source's colour from the legend: GTS purple, WIS2 blue
            'circle-stroke-color': ['case', ['get', 'gateway'], SOURCE_COLORS.gts, SOURCE_COLORS.wis2],
            'circle-stroke-width': 1.5,
            'circle-pitch-alignment': 'map',
        },
    });
    // Satellite coverage, under the points (src/data/satellite/coverageLayers.js)
    addCoverageLayers({ pointLayers: POINT_LAYERS, nearestPoint });
    // Aircraft flight paths, under the points
    map.addSource('tracks', { type: 'geojson', data: empty });
    map.addLayer({
        id: 'tracks',
        type: 'line',
        source: 'tracks',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
            // Aircraft segments are coloured by altitude
            'line-color': ['case', ['has', 'alt'], ALTITUDE_COLORS, ['get', 'color']],
            'line-width': ['interpolate', ['linear'], ['zoom'], 1, 2, 6, 3.5],
        },
    });
    // Aircraft paths float at their altitude: a band coloured by height, dark
    // chevrons pointing the way of travel, and a red arrowhead at the latest report
    map.addLayer({
        id: 'track-ribbons',
        type: 'fill-extrusion',
        source: 'tracks',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
            'fill-extrusion-color': ['match', ['get', 'role'], 'marker', '#e03131', 'arrow', '#212529', ALTITUDE_COLORS],
            'fill-extrusion-height': altitudeHeight('top'),
            'fill-extrusion-base': altitudeHeight('bottom'),
            'fill-extrusion-opacity': 0.9,
        },
    });
    map.addLayer({
        id: 'points',
        type: 'circle',
        source: 'points',
        layout: { 'circle-sort-key': ['get', 'order'] },  // Newest on top
        paint: {
            // Origin-only messages are hollow rings; cache copies are filled, outlined a shade darker
            'circle-color': ['get', 'color'],
            'circle-stroke-color': ['case', ['get', 'origin'], ['get', 'color'], ['get', 'outline']],
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 1, 0.75, 6, 1.5],
            'circle-radius': POINT_RADIUS,
            'circle-pitch-alignment': 'map',
        },
    });
    // GTS gateway reports are diamonds with a dark outline, so they stay apart
    // from WIS2 circles even when zoomed out and the outlines are too thin to see
    map.addImage('diamond', diamondSdf(), { sdf: true, pixelRatio: 2 });
    map.addLayer({
        id: 'points-gts',
        type: 'symbol',
        source: 'points',
        layout: {
            'icon-image': 'diamond',
            'icon-size': ['interpolate', ['linear'], ['zoom'], ...POINT_RADIUS.slice(3).map((v, i) => (i % 2 ? v * DIAMOND_SCALE : v))],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-pitch-alignment': 'map',
            'symbol-sort-key': ['get', 'order'],
        },
        paint: {
            'icon-color': ['get', 'color'],
            'icon-halo-color': ['get', 'outline'],
            'icon-halo-width': ['interpolate', ['linear'], ['zoom'], 1, 0.75, 6, 1.5],
        },
    });
    // Wind arrows point the way the wind blows (reports give where it comes from)
    map.addImage('arrow', arrowSdf(), { sdf: true, pixelRatio: 2 });
    map.on('moveend', () => scheduleReplay());
    scheduleReplay(0);  // If switched on (it starts off), once the decoder has loaded
    // Points from other sources (airports) are squares
    map.addImage('square', squareSdf(), { sdf: true, pixelRatio: 2 });
    map.addLayer({
        id: 'points-ext',
        type: 'symbol',
        source: 'points',
        layout: {
            'icon-image': 'square',
            'icon-size': ['interpolate', ['linear'], ['zoom'], ...POINT_RADIUS.slice(3).map((v, i) => (i % 2 ? v / 10 : v))],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-pitch-alignment': 'map',
            'symbol-sort-key': ['get', 'order'],
        },
        paint: {
            'icon-color': ['get', 'color'],
            'icon-halo-color': ['get', 'outline'],
            'icon-halo-width': ['interpolate', ['linear'], ['zoom'], 1, 0.75, 6, 1.5],
        },
    });
    map.addLayer({
        id: 'points-arrow',
        type: 'symbol',
        source: 'points',
        filter: ['boolean', false],
        layout: {
            'icon-image': 'arrow',
            'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 0.75, 10, 1],
            'icon-rotate': ['+', ['to-number', ['get', 'm_windDir'], 0], 180],
            'icon-rotation-alignment': 'map',
            // Where stations crowd, arrows that would overlap are left out (the
            // strongest winds go first) and come back on zooming in
            'icon-allow-overlap': false,
            'icon-ignore-placement': true,
            'icon-padding': 0,
            'icon-pitch-alignment': 'map',
            'symbol-sort-key': ['get', 'order'],
        },
        paint: {
            'icon-color': ['get', 'color'],
            // A light edge keeps neighbouring arrows apart
            'icon-halo-color': 'rgba(255, 255, 255, 0.9)',
            'icon-halo-width': 1,
        },
    });
    // Styled by wave spectrum: each report with one as its small polar spectrum,
    // under its point, which sits at the middle. North stays north as the map turns
    map.addLayer({
        id: 'points-spectrum',
        type: 'symbol',
        source: 'points',
        filter: ['boolean', false],
        layout: {
            'icon-image': ['get', 'spec'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 5, 0.85, 9, 1.2],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-rotation-alignment': 'map',
            'icon-pitch-alignment': 'map',
        },
    }, 'points');
    // Forecast products' outlines and drawn fields, under the tracks and points (src/data/grib/grib.js)
    addGribLayers('tracks');
    paintAge();
    setInterval(paintAge, 30 * 1000);
    // Styled by wind, streaks flow the way it blows (src/map/windFlow.js)
    startWindFlow();
    applyMapFilter();
    // Open coloured by observation type, or as the link says (style=temp and so on), near the visitor
    if (stylePanel) {
        stylePanel.querySelector('.legend-colour select').value = startColour;
        stylePanel.querySelector('.legend-coloured-only input').checked = state.colouredOnly;
        setColourBy(startColour, stylePanel);
    }
    // A link to a dataset shows it as its Show on map would (the catalogue code is wired up just after load)
    if (startDataset) setTimeout(() => showDatasetFromUrl(startDataset));
    centreOnVisitor();
    preloadDecoder();
    flushPoints();
    setInterval(flushPoints, 500);

    // The point nearest a click or tap, within reach of a finger (or a mouse)
    map.on('click', (e) => {
        var near = nearestPoint(e.point);
        if (near) { openPopup(records.get(near.id)); return; }
        // A click on empty map closes the info panel
        var hit = map.queryRenderedFeatures(e.point, { layers: ['tracks', 'track-ribbons', 'swaths-fill', ...GRIB_LAYERS].filter((id) => map.getLayer(id)) });
        if (!hit.length && document.body.classList.contains('info-open')) closeInfo();
    });
    map.on('click', 'tracks', (e) => {
        // Points take precedence where both are under the pointer
        if (nearestPoint(e.point)) return;
        openPopup(records.get(e.features[0].properties.recordId || e.features[0].properties.lastId));
    });
    map.on('mousemove', 'tracks', (e) => {
        if (map.queryRenderedFeatures(e.point, { layers: POINT_LAYERS }).length) return;
        var f = e.features[0].properties;
        map.getCanvas().style.cursor = 'pointer';
        hoverLabel.setLngLat(e.lngLat).setText(f.alt !== undefined
            ? `${f.label} · ${Math.round(f.alt).toLocaleString()} m` : `${f.label} · ${f.count} reports`).addTo(map);
    });
    map.on('mouseleave', 'tracks', () => {
        map.getCanvas().style.cursor = '';
        hoverLabel.remove();
    });
    map.on('click', 'track-ribbons', (e) => openPopup(records.get(e.features[0].properties.recordId)));
    map.on('mousemove', 'track-ribbons', (e) => {
        var f = e.features[0].properties;
        map.getCanvas().style.cursor = 'pointer';
        hoverLabel.setLngLat(e.lngLat).setText(`${f.label} · ${Math.round(f.alt).toLocaleString()} m${f.role === 'marker' ? ' · latest' : ''}`).addTo(map);
    });
    map.on('mouseleave', 'track-ribbons', () => {
        map.getCanvas().style.cursor = '';
        hoverLabel.remove();
    });
    // Band and arrow sizes are in screen pixels, so rebuild them after zooming
    map.on('zoomend', () => markTracksDirty());
    map.on('mousemove', POINT_LAYERS, (e) => {
        var record = records.get(e.features[0].id);
        map.getCanvas().style.cursor = 'pointer';
        if (!record) return hoverLabel.remove();
        var route = record.subLayer && record.subLayer.endsWith('-aircraft') ? trackRoute([record]) : null;
        // While colouring by a measure, the point's value too
        var m = METRICS[state.colourBy], value = m && e.features[0].properties[`m_${state.colourBy}`];
        var text = m && typeof value === 'number' ? formatMetric(value, m)
            : [record.wsi || record.props.metadata_id || record.centre, route].filter(Boolean).join(' · ');
        hoverLabel.setLngLat(record.coords).setText(text).addTo(map);
    });
    map.on('mouseleave', POINT_LAYERS, () => {
        map.getCanvas().style.cursor = '';
        hoverLabel.remove();
    });
});

// Batch updates so the map isn't redrawn for every message
function flushPoints() {
    var source = map.getSource('points');
    if (!source) return;
    var pending = takePending();
    if (pending) {
        source.updateData(pending);
        keyChanged();
    }
    var now = Date.now();
    refreshKey(now);
    if (now - swathsBuilt > SWATH_FLUSH_MS) flushSwaths(now);
    rebuildTracks(now);
    tickPulses(now);
}

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.target.closest('input, select, textarea, dialog')) return;
    if (document.body.classList.contains('info-open')) closeInfo();
    else document.body.classList.remove('queue-open');
});

// ---------- A warning's area on the map, and keeping the info panel in view (the

// ---------- Satellite reports: what made them and what they measure.
// Code tables 0 01 007 (satellite) and 0 02 019 (instrument), common entries only;
// anything else shows its code.

// ---------- The notification behind a point (model forecasts at a point are in

// ---------- Radar wind profiles: the opened report with the site's others either side

readFiltersFromUrl();  // Before the sidebar is built, so its controls start set
// The sidebar, opened from the tab on its edge
new QueueControl().onAdd(map);
// Layer switches and styling live in the sidebar's Layers tab; the map shows a
// read-only key of what is currently drawn
document.querySelector('.queue-pane-layers').appendChild(new LegendControl().onAdd(map));
// The key and Style by top right; the zoom buttons top left (they
// step aside as the sidebar opens); the world map and broker status bottom right.
// The satellite page, which has no sidebar, keeps the top of the map clear: its key and
// Style by are bottom left instead
map.addControl(new StyleControl(), SATELLITE_PAGE ? 'bottom-left' : 'top-right');
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
// Under them, a button that centres the globe again (src/map/recentre.js)
map.addControl(new RecentreControl(() => {
    var padding = panelPaddingNow();
    panelPadding = `${padding.left}|${padding.right}|${padding.bottom}`;
    return padding;
}), 'top-left');
map.addControl(new MapKey(), 'bottom-right');
addAbout();
welcomeFirstVisit();

// Keep the globe (the map's centre) in the middle of the area the panels leave
// uncovered: the sidebar and info panel become map padding as they open and close
let panelPadding = '';

// The map's padding for the panels open now
function panelPaddingNow() {
    var queue = document.querySelector('.queue');
    var info = document.body.classList.contains('info-open') && infobar;
    var left = 0, right = 0, bottom = 0;
    if (PHONE.matches) {
        bottom = info ? Math.min(infobar.offsetHeight, window.innerHeight * 0.55) : 0;
    } else {
        left = document.body.classList.contains('queue-open') && queue ? queue.getBoundingClientRect().width : 0;
        right = info ? infobar.getBoundingClientRect().width : 0;
    }
    return { left, right, top: 0, bottom };
}

function updateMapPadding() {
    var padding = panelPaddingNow();
    var key = `${padding.left}|${padding.right}|${padding.bottom}`;
    if (key === panelPadding) return;
    panelPadding = key;
    map.easeTo({ padding, duration: 200 });
}
new MutationObserver(updateMapPadding).observe(document.body, { attributes: true, attributeFilter: ['class'] });
window.addEventListener('resize', () => { panelPadding = ''; updateMapPadding(); });

// On desktop the sidebar starts open on its Layers tab; on phones it would cover the map.
// The satellite page has none: it's built, as its layer switches start the decoding and
// other panels look things up in it, but hidden (style.css) and never opened
if (!PHONE.matches && !SATELLITE_PAGE) {
    document.body.classList.add('queue-open');
    selectQueueTab('layers');
}

// Each message: parsed, drawn and listed (held in a queue instead while the feed is paused, feedPause.js)
initFeedPause((topic, message) => {
    // Each page (page.js) lists only its own messages
    var feature = parseMessage(topic, message);
    if (!topicOnPage(topic, feature)) return;
    countMessage();
    var record = feature && onMessage(topic, feature);
    // Listed in the sidebar's messages, which the satellite page doesn't show
    if (!SATELLITE_PAGE) queueMessage(topic, message, record, feature);
}, () => updateMapKey());

connectFastest({
    // Only the topics the page shows (the satellite page only satellites', see page.js)
    subscribe: PAGE_TOPICS,
    onMessage: receive,
    // The map key shows which broker the page is on
    onState: updateMapKey,
});
// And which catalogue and global cache (see rankGdcs and caches.js)
subscribe(['catalogue', 'cache', 'replay', 'slowNetwork'], updateMapKey);

// Analytics (Google Analytics, cookieless; see analytics.js): where people look,
// at most once every 20 s, the map's centre to 10° and its zoom
initAnalytics();
map.on('moveend', () => {
    var c = map.getCenter();
    trackOnce('map_view', 20e3, 'map_view', { zoom: Math.round(map.getZoom()),
        lat: Math.round(c.lat / 10) * 10, lon: Math.round(c.lng / 10) * 10 });
});

// ---------- Colouring stations, ships and buoys by a measured value. Values come from

// Held back until the decoder has started (or failed to), then goes ahead
onDecoderSettled(() => scheduleReplay(0));

// Timed as the page opens rather than on the first lookup, so the map key can say which is in use
rankGdcs();
setInterval(() => document.hidden || rankGdcs(true), 60e3);

// ---------- Tracks. Aircraft and ship reports are joined by identifier in time order:
