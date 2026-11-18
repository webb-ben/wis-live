// Satellite coverage. Each decoded satellite file covers the convex hull
// of its reports; the hulls of one satellite are joined on a grid, so its passes
// read as one area with no seams, and each cell's opacity is the cloud amount of
// the reports in it. Files with only a few reports (e.g. a radio occultation)
// stay as points.
//
// A swath file isn't kept as points: its reports are packed into typed arrays,
// and what it adds to each cell is worked out once, when it arrives, and taken
// off again when it goes. So coverage can stay up for hours without slowing the
// map, and a report only becomes a full record when it is clicked (or drawn as a
// point, with coverage switched off). Of each report only the values the map can be
// styled by are kept (metrics, in typed arrays): a popup decodes the rest again.
import { h3Cell, H3_RESOLUTION_MAX, H3_RESOLUTION, convexHull, h3SampleDeg, inOrNearRing, h3Neighbors, cellRing, distanceKm, cellsOutline, getResolution } from '../../lib/geo.js';
import { map } from '../../map/map.js';
import { satelliteKey, satelliteName, addSatelliteRow, satelliteLink } from './rows.js';
import { metricValues } from '../metrics.js';
import { METRICS, SATELLITE_STYLE } from '../../config.js';
import { isGateway, isSpaceRecord, linkDecoded, newId, records, addPoint, removePoint, MAX_SATELLITE_POINTS, countPlotted } from '../../map/points.js';
import { seenLayers, hiddenLayers, effectiveHidden } from '../../map/layers.js';
import { darken, esc } from '../../lib/util.js';
import { bufrSource } from '../download.js';
import { formatMetric, timeAgo } from '../../lib/format.js';
import { isDataLink } from '../../messages/messages.js';
import { satelliteStyled } from '../../map/colour.js';
import { datasetId, showDatasetInPopup } from '../catalogue.js';
import { plotRecord } from '../decodeQueue.js';
import { showLegendRow, keyChanged } from '../../lib/ui/legend.js';
import { showInfo, selectedMarker, selectOnOverview, keepPopupInView, openPopup, bindMetricTiles } from '../../lib/ui/popup.js';
export const SWATH_MIN_REPORTS = 5;
export const SWATH_FILES_MAX = 3000;  // Files whose coverage is kept, oldest dropped first...
export const SWATH_KEEP_MS = 12 * 3600e3;  // ...and none older than this
export const SWATH_FLUSH_MS = 1000;
export let swathFeatureIds = 0;
export let swathsBuilt = 0;
export let swathPointsShown = false;  // Coverage switched off: swath reports are drawn as points

// The grids kept (globalGrid, and viewGrid while zoomed in), and the one the map draws.
// Each grid's cells hold what every file adds to them (file.cells[grid.key]); the grid
// on the map also notes which cells changed (dirty) and went (removed) since it was drawn
export let pendingGrid = null;  // A view grid still being built, a few files at a time
export let gridBuilds = 0;
export function grids() {
    return [globalGrid, viewGrid, pendingGrid].filter(Boolean);
}
export function shownGrid() {
    return viewGrid || globalGrid;
}

export function swathCellId(sat, lon, lat, grid = shownGrid()) {
    return `${sat}|${h3Cell(lon, lat, grid.res)}`;
}

// ---------- Finer cells zoomed in: about the same size on screen at any zoom
// (resolution 2 below zoom 3, then one finer per zoom level, to H3_RESOLUTION_MAX).
// Finer cells cover only the area in view, with as much again round it, so panning
// a little doesn't rebuild them
export function gridResolution(zoom) {
    return Math.min(H3_RESOLUTION_MAX, Math.max(H3_RESOLUTION, Math.floor(zoom)));
}

// [west, south, east, north] of the view, west to east possibly past ±180
export function viewBounds(pad) {
    var b = map.getBounds(), w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
    if (e < w) e += 360;
    var dx = (e - w) * pad, dy = (n - s) * pad;
    return [w - dx, Math.max(-90, s - dy), e + dx, Math.min(90, n + dy)];
}

export function inBounds(lon, lat, bounds) {
    if (!bounds) return true;
    var [w, s, e, n] = bounds;
    return lat >= s && lat <= n && (e - w >= 360 || ((((lon - w) % 360) + 360) % 360) <= e - w);
}

export function boundsWithin(inner, outer) {
    return inner[1] >= outer[1] && inner[3] <= outer[3] && (outer[2] - outer[0] >= 360
        || (inBounds(inner[0], inner[1], outer) && inBounds(inner[2], inner[1], outer) && inner[2] - inner[0] <= outer[2] - outer[0]));
}

// After the map moves: the finer grid for the new zoom or area, or back to the global one.
// A new grid is built a slice at a time, so thousands of files don't stall the page;
// the cells on the map stay until it's done. Files arriving or going meanwhile go
// straight into it (it's among grids())
export const GRID_SLICE_MS = 25;
export function syncSwathGrid() {
    if (!map.getSource('swaths')) return;
    var res = gridResolution(map.getZoom());
    var wanted = res === H3_RESOLUTION ? null : viewBounds(0);
    var fits = (grid) => grid && grid.res === res && boundsWithin(wanted, grid.bounds);
    if (pendingGrid && (!wanted || !fits(pendingGrid))) dropGrid(pendingGrid);
    if (!wanted) {
        if (viewGrid) setViewGrid(null);
        return;
    }
    if (fits(viewGrid) || fits(pendingGrid)) return;
    var grid = pendingGrid = { key: `view${++gridBuilds}`, res, bounds: viewBounds(0.5), cells: new Map(), dirty: new Set(), removed: [] };
    var files = [...swathFiles.values()];
    var step = () => {
        if (pendingGrid !== grid) return;
        var until = performance.now() + GRID_SLICE_MS;
        while (files.length && performance.now() < until) {
            var file = files.shift();
            // Gone, replaced by an update, or added since (already in)
            if (swathFiles.get(file.key) !== file || file.cells[grid.key]) continue;
            buildSwathCells(file, grid);
            applySwathFile(file, 1, grid);
        }
        if (files.length) return setTimeout(step, 0);
        refreshAllHoles(grid);
        pendingGrid = null;
        setViewGrid(grid);
    };
    step();
}

// Forgets a grid's share in every file
export function dropGrid(grid) {
    if (pendingGrid === grid) pendingGrid = null;
    swathFiles.forEach((file) => { delete file.cells[grid.key]; });
}

export function setViewGrid(grid) {
    if (viewGrid) dropGrid(viewGrid);
    viewGrid = grid;
    // The map's cells all at once; changes after this go in as they come (flushSwaths)
    var shown = shownGrid();
    map.getSource('swaths').setData({ type: 'FeatureCollection', features: [...shown.cells.values()].map(swathFeature) });
    shown.dirty.clear();
    shown.removed = [];
    hoveredCell = null;
    swathsBuilt = Date.now();
}

// Packs a decoded satellite file's reports into one swath file and adds it to the cells
export function addSwathFile(job, reports) {
    var first = reports[0], n = reports.length;
    var sat = satelliteKey(first) || `${first.subLayer}:${first.fileKey}`;
    // Longitudes unwrapped around the first report so a pass across ±180 stays whole
    var lon0 = first.coords[0];
    var unwrapLon = (lon) => {
        while (lon - lon0 > 180) lon -= 360;
        while (lon - lon0 < -180) lon += 360;
        return lon;
    };
    var ring = convexHull(reports.map((r) => [unwrapLon(r.coords[0]), r.coords[1]]));
    // Reports in a line have no area to cover
    if (!ring) { reports.forEach((r) => plotRecord(job, r)); return; }
    var old = swathFiles.get(first.fileKey);
    if (old) removeSwathFile(old);  // An update replaces it
    var values = reports.map(metricValues);
    var metrics = {};
    for (var key of [...Object.keys(METRICS), 'windDir']) {
        if (values.some((v) => `m_${key}` in v)) metrics[key] = Float32Array.from(values, (v) => v[`m_${key}`] ?? NaN);
    }
    var file = {
        key: first.fileKey,
        sat,
        n,
        // What every report shares; swathRecord adds the rest
        template: { ...first, decoded: null, satName: satelliteName(first) },
        coords: Float32Array.from(reports.flatMap((r) => r.coords)),
        observed: Float64Array.from(reports, (r) => r.observed),
        index: Int32Array.from(reports, (r) => r.fileIndex),
        // Report ids only for files whose reports have them (most satellite files don't)
        wsi: reports.some((r) => r.wsi) ? reports.map((r) => r.wsi) : null,
        metrics,
        born: Date.now(),
        // For the same filters as the points
        props: {
            layer: first.subLayer, via: first.decodedLayer || '', gateway: isGateway(first), sat: satelliteKey(first),
            channel: first.channel, centre: first.centre, format: first.format, discipline: first.discipline,
            space: isSpaceRecord(first), topic: first.topic.toLowerCase(),
        },
        means: {},
        fillMeans: {},  // The means that may fill its empty cells (see below)
        ring,  // Its footprint
        cells: {},  // grid key -> cell id -> what this file adds to it
        points: null,
    };
    // The file's own means fill cells it covers that hold none of its reports, but only
    // where the file's values agree: a mean of widely spread values (a full-disk wind
    // file, 3 to 40 m/s) would paint large areas one made-up colour, so those stay unfilled
    for (var m of Object.keys(METRICS)) {
        var known = metrics[m] ? metrics[m].filter((v) => !isNaN(v)) : [];
        if (!known.length) continue;
        var mean = file.means[m] = known.reduce((a, b) => a + b, 0) / known.length;
        var spread = Math.sqrt(known.reduce((a, v) => a + (v - mean) ** 2, 0) / known.length);
        var stops = METRICS[m].stops;
        var scale = stops ? Math.abs(stops[stops.length - 1][0] - stops[0][0]) : 0;
        if (!scale || spread <= scale * FILL_SPREAD_MAX) file.fillMeans[m] = mean;
    }
    swathFiles.set(file.key, file);
    for (var grid of grids()) {
        buildSwathCells(file, grid);
        applySwathFile(file, 1, grid);
    }
    trimSwathFiles();
    // Holes round where the file is, and where the one it replaced was
    for (var g of grids()) {
        if (old) refreshSatelliteHoles(old.sat, g, fileCellsIn(old, g));
        refreshSatelliteHoles(sat, g, fileCellsIn(file, g));
    }
    if (!seenLayers.has(first.subLayer)) showLegendRow(first.subLayer);
    if (file.props.sat) addSatelliteRow(file.props.sat);
    countPlotted(job.kind, n);
    if (!job.linked) {
        job.linked = true;
        linkDecoded(job.key, swathRecord(file, 0));
    }
    if (swathPointsShown) showSwathPoints(file);
    keyChanged();
}

// A file's cells in a grid: those its footprint covers (fill), and those its reports
// fall in. A grid with bounds gets only the cells within them
export function buildSwathCells(file, grid) {
    var cells = file.cells[grid.key] = new Map();
    var cellFor = (lon, lat) => {
        var cell = h3Cell(lon, lat, grid.res), id = `${file.sat}|${cell}`;
        if (!cells.has(id)) cells.set(id, { cell, fill: false, n: 0, t0: Infinity, t1: -Infinity, sums: {}, counts: {}, mins: {}, maxs: {} });
        return cells.get(id);
    };
    var ring = file.ring, spacing = h3SampleDeg(grid.res);
    var xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    var xMin = Math.min(...xs) - spacing, xMax = Math.max(...xs) + spacing;
    var yMin = Math.max(-90, Math.min(...ys) - spacing), yMax = Math.min(90, Math.max(...ys) + spacing);
    // The longitudes to sample: the footprint's, cut to the bounds (in the footprint's
    // frame, which can run past ±180)
    var spans = [[xMin, xMax]];
    if (grid.bounds) {
        var [w, s, e, n] = grid.bounds;
        yMin = Math.max(yMin, s);
        yMax = Math.min(yMax, n);
        spans = e - w >= 360 ? spans : [-360, 0, 360]
            .map((k) => [Math.max(xMin, w + k), Math.min(xMax, e + k)]).filter(([a, b]) => a <= b);
    }
    for (var lat = yMin; lat <= yMax; lat += spacing) {
        for (var [from, to] of spans) {
            for (var lon = from; lon <= to; lon += spacing) {
                if (inOrNearRing([lon, lat], ring, spacing)) cellFor(lon, lat).fill = true;
            }
        }
    }
    for (var i = 0; i < file.n; i++) {
        if (!inBounds(file.coords[2 * i], file.coords[2 * i + 1], grid.bounds)) continue;
        var cell = cellFor(file.coords[2 * i], file.coords[2 * i + 1]);
        cell.n++;
        cell.t0 = Math.min(cell.t0, file.observed[i]);
        cell.t1 = Math.max(cell.t1, file.observed[i]);
        for (var [mk, arr] of Object.entries(file.metrics)) {
            if (mk === 'windDir' || isNaN(arr[i])) continue;
            cell.sums[mk] = (cell.sums[mk] || 0) + arr[i];
            cell.counts[mk] = (cell.counts[mk] || 0) + 1;
            cell.mins[mk] = Math.min(cell.mins[mk] ?? Infinity, arr[i]);
            cell.maxs[mk] = Math.max(cell.maxs[mk] ?? -Infinity, arr[i]);
        }
    }
}

// Adds a file's share to a grid's cells (sign 1), or takes it off again (-1)
export function applySwathFile(file, sign, grid) {
    for (var [id, c] of file.cells[grid.key] || []) applySwathCell(file, id, c, sign, grid);
}

export function applySwathCell(file, id, c, sign, grid) {
    var cell = grid.cells.get(id);
    if (!cell) {
        if (sign < 0) return;
        // real: how many files cover it themselves; none, and it's only a filled hole
        cell = { fid: ++swathFeatureIds, h3: c.cell, sat: file.sat, real: 0,
            files: new Set(), sums: {}, counts: {}, fillSums: {}, fillCounts: {} };
        grid.cells.set(id, cell);
    }
    if (sign > 0) cell.files.add(file);
    else cell.files.delete(file);
    if (!c.hole) cell.real += sign;
    for (var m in c.sums) {
        cell.sums[m] = (cell.sums[m] || 0) + sign * c.sums[m];
        cell.counts[m] = (cell.counts[m] || 0) + sign * c.counts[m];
    }
    if (c.fill) {
        for (var mf in file.fillMeans) {
            cell.fillSums[mf] = (cell.fillSums[mf] || 0) + sign * file.fillMeans[mf];
            cell.fillCounts[mf] = (cell.fillCounts[mf] || 0) + sign;
        }
    }
    // Only the grid on the map notes its changes; another is drawn whole when shown
    var shown = grid === shownGrid();
    if (cell.files.size) {
        if (shown) grid.dirty.add(id);
    } else {
        grid.cells.delete(id);
        grid.dirty.delete(id);
        if (shown) grid.removed.push(cell.fid);
    }
}

// ---------- Holes: one-cell gaps in a satellite's coverage (between the strips of a
// pass, say). A cell no file of the satellite covers itself, but all six of whose
// neighbours one does, is filled: each file covering a neighbour gives it a hole
// share (its footprint's fill, no reports). A file coming or going can only change
// cells at or next to its own, so only those are looked at.

// The H3 cells a file has a share in, in a grid
export function fileCellsIn(file, grid) {
    return [...(file.cells[grid.key] || new Map()).values()].map((c) => c.cell);
}

export function refreshSatelliteHoles(sat, grid, h3s) {
    var key = grid.key;
    var cellAt = (h3) => grid.cells.get(`${sat}|${h3}`);
    var area = new Set(h3s);
    for (var h3 of h3s) h3Neighbors(h3).forEach((n) => area.add(n));
    for (var h3 of area) {
        var id = `${sat}|${h3}`, cell = cellAt(h3);
        // The files it should have hole shares from: none if a file covers it itself
        var wanted = new Set();
        if (!cell || !cell.real) {
            var neighbors = h3Neighbors(h3);
            if (neighbors.length && neighbors.every((n) => cellAt(n)?.real > 0)) {
                for (var n of neighbors) {
                    var nid = `${sat}|${n}`;
                    cellAt(n).files.forEach((f) => { if (!f.cells[key].get(nid).hole) wanted.add(f); });
                }
            }
        }
        // Hole shares no longer wanted go...
        for (var file of cell ? [...cell.files] : []) {
            var c = file.cells[key].get(id);
            if (!c.hole || wanted.has(file)) continue;
            applySwathCell(file, id, c, -1, grid);
            file.cells[key].delete(id);
        }
        // ...and missing ones come (never over a file's own share)
        for (var file of wanted) {
            if (file.cells[key].has(id)) continue;
            var c = { cell: h3, fill: true, hole: true, n: 0, t0: Infinity, t1: -Infinity, sums: {}, counts: {}, mins: {}, maxs: {} };
            file.cells[key].set(id, c);
            applySwathCell(file, id, c, 1, grid);
        }
    }
}

// Every hole in a grid, as when it's first built
export function refreshAllHoles(grid) {
    var bySat = new Map();
    for (var cell of grid.cells.values()) {
        if (!bySat.has(cell.sat)) bySat.set(cell.sat, []);
        bySat.get(cell.sat).push(cell.h3);
    }
    bySat.forEach((h3s, sat) => refreshSatelliteHoles(sat, grid, h3s));
}

// Takes a file off the map. Its shares stay listed in file.cells, for the holes
// round where it was (see refreshSatelliteHoles)
export function removeSwathFile(file) {
    swathFiles.delete(file.key);
    for (var grid of grids()) applySwathFile(file, -1, grid);
    hideSwathPoints(file);
    keyChanged();
}

// Drops the oldest files beyond the caps
export function trimSwathFiles() {
    var oldest = Date.now() - SWATH_KEEP_MS;
    var removed = [];
    for (var file of swathFiles.values()) {
        if (swathFiles.size <= SWATH_FILES_MAX && file.born >= oldest) break;
        removeSwathFile(file);
        removed.push(file);
    }
    for (var gone of removed) grids().forEach((grid) => refreshSatelliteHoles(gone.sat, grid, fileCellsIn(gone, grid)));
}

// Redraws only the cells that changed since last time
export function flushSwaths(now) {
    trimSwathFiles();
    var grid = shownGrid();
    if (!grid.dirty.size && !grid.removed.length) return;
    swathsBuilt = now;
    var add = [];
    for (var id of grid.dirty) add.push(swathFeature(grid.cells.get(id)));
    grid.dirty.clear();
    map.getSource('swaths').updateData({ add, remove: grid.removed });
    grid.removed = [];
}

export function swathFeature(cell) {
    var props = {};
    for (var m of Object.keys(METRICS)) {
        if (cell.counts[m]) props[`m_${m}`] = cell.sums[m] / cell.counts[m];
        else if (cell.fillCounts[m]) props[`m_${m}`] = cell.fillSums[m] / cell.fillCounts[m];
        // Its files measure this, though the cell has no value (see applyMapFilter)
        else if ([...cell.files].some((f) => f.means[m] != null)) props[`no_${m}`] = true;
    }
    var file = cell.files.values().next().value;
    var born = 0;
    cell.files.forEach((f) => { born = Math.max(born, f.born); });
    return {
        type: 'Feature',
        id: cell.fid,
        geometry: { type: 'Polygon', coordinates: [cellRing(cell.h3)] },
        properties: {
            ...file.props,
            swath: cell.sat,
            label: file.template.satName || 'Satellite',
            color: file.template.color,
            outline: darken(file.template.color),
            born,
            ...props,
        },
    };
}

// A full record for one report in a swath file, made when it's wanted
export function swathRecord(file, i) {
    var t = file.template;
    var metrics = {};
    for (var [m, values] of Object.entries(file.metrics)) {
        if (!isNaN(values[i])) metrics[`m_${m}`] = values[i];
    }
    return {
        ...t,
        id: newId(),
        coords: [file.coords[2 * i], file.coords[2 * i + 1]],
        observed: file.observed[i],
        props: { ...t.props, data_id: `${file.key}#${i}`, datetime: new Date(file.observed[i]).toISOString() },
        wsi: file.wsi ? file.wsi[i] : null,
        decoded: null,
        // Only the values the map can be styled by are kept (metrics); the popup decodes
        // the rest of the report from the file again
        source: bufrSource(t.notification, t.notification.properties || {}, t.topic),
        subsetIndex: file.index[i],
        fileIndex: file.index[i],
        metrics,
        swath: true,
    };
}

// Whether a record is on the map, as a point or as part of a swath
export function onMap(record) {
    return records.has(record.id) || (!!record.swath && swathFiles.has(record.fileKey));
}

// A coverage cell's summary: what a click on a cell shows. Its colour is
// the mean of the reports in it, so the panel gives that mean for each measure, with
// the range and how many reports, and lists the files they came from. Nothing is
// downloaded; a single report is decoded only when asked for (Open a report)
export function openCellSummary(sat, lngLat) {
    var grid = shownGrid();
    var id = swathCellId(sat, lngLat.lng, lngLat.lat, grid), cell = grid.cells.get(id);
    if (!cell) return;
    showInfo(buildCellSummary(id, cell, lngLat, grid));
    selectedMarker.remove();
    liftCell(cell);
    selectOnOverview({ at: [lngLat.lng, lngLat.lat], h3: cell.h3, colour: cell.files.values().next().value.template.color });
    keepPopupInView();
}

export function buildCellSummary(id, cell, lngLat, grid) {
    var parts = [...cell.files].map((file) => ({ file, part: file.cells[grid.key]?.get(id) })).filter((p) => p.part)
        .sort((a, b) => b.file.born - a.file.born);
    var t = parts[0].file.template;
    var reports = parts.reduce((n, p) => n + p.part.n, 0);
    var withReports = parts.filter((p) => p.part.n);
    var t0 = Math.min(...withReports.map((p) => p.part.t0)), t1 = Math.max(...withReports.map((p) => p.part.t1));
    var satName = t.satName || 'Satellite';
    var tiles = [`<div class="pp-tile" data-metric="${SATELLITE_STYLE}"><div>Satellite</div><strong>${satelliteLink(satName)}</strong></div>`];
    for (var [key, m] of Object.entries(METRICS)) {
        if (m.targets !== 'satellite') continue;
        var count = parts.reduce((n, p) => n + (p.part.counts[key] || 0), 0);
        if (count) {
            var sum = parts.reduce((n, p) => n + (p.part.sums[key] || 0), 0);
            var lo = Math.min(...parts.filter((p) => p.part.counts[key]).map((p) => p.part.mins[key]));
            var hi = Math.max(...parts.filter((p) => p.part.counts[key]).map((p) => p.part.maxs[key]));
            tiles.push(`<div class="pp-tile" data-metric="${key}"><div>${esc(m.label)}${count > 1 ? ', mean' : ''}</div><strong>${esc(formatMetric(sum / count, m))}</strong>`
                + `<div>${count > 1 ? `${esc(formatMetric(lo, m).split(' ')[0])} to ${esc(formatMetric(hi, m))} · ` : ''}${count} report${count === 1 ? '' : 's'}</div></div>`);
        } else if (cell.fillCounts[key] && !reports) {
            // No report falls in the cell: it's shaded with its files' averages
            tiles.push(`<div class="pp-tile" data-metric="${key}"><div>${esc(m.label)}</div><strong>${esc(formatMetric(cell.fillSums[key] / cell.fillCounts[key], m))}</strong><div>files' average</div></div>`);
        }
    }
    var when = (ms) => new Date(ms).toISOString().slice(11, 16);
    var div = document.createElement('div');
    div.className = 'pp';
    div.innerHTML = `
        <header class="pp-head">
            <span class="pp-dot" style="--color: ${t.color}; --outline: ${darken(t.color)}"></span>
            <div>
                <div class="pp-title">${satelliteLink(satName)}</div>
                <div class="pp-sub">Coverage cell · ${reports ? `${reports} report${reports === 1 ? '' : 's'}` : 'no reports'} from ${parts.length} file${parts.length === 1 ? '' : 's'}</div>
            </div>
        </header>
        <dl class="pp-meta">
            ${reports ? `<dt>Observed</dt><dd>${t1 - t0 < 60e3 ? `${esc(new Date(t1).toLocaleString())}` : `${esc(new Date(t0).toLocaleDateString())} ${when(t0)}–${when(t1)} UTC`} (${timeAgo(new Date(t1).toISOString())})</dd>` : ''}
            <dt>Cell</dt><dd class="pp-mono" title="H3 cell, resolution ${grid.res}">${esc(cell.h3)}</dd>
        </dl>
        <div class="pp-status">${reports
            ? 'The cell is coloured by the mean of the reports in it. Of each file only some reports are kept, spread across it; these are the ones here.'
            : 'No kept report falls in this cell; it is shaded with the average of the files that cover it.'}</div>
        <div class="pp-tiles pp-cell-tiles">${tiles.join('')}</div>
        <div class="pp-cell-files"></div>
        <div class="pp-dataset" hidden></div>`;
    var list = div.querySelector('.pp-cell-files');
    for (var { file, part } of parts.slice(0, 10)) {
        var row = document.createElement('div');
        row.className = 'pp-cell-file';
        // The file's name (e.g. A_IEXX23EUMP..._C_RJTD_...bufr) says more than its topic
        var link = (file.template.links || []).find(isDataLink);
        var name = link ? decodeURIComponent(link.href.split(/[?#]/)[0].split('/').pop()) : file.template.path;
        row.innerHTML = `<div><span class="pp-mono">${esc(name)}</span><br><small>${part.n ? `${part.n} report${part.n === 1 ? '' : 's'} here` : 'covers it'} · published ${timeAgo(file.template.props.pubtime || new Date(file.born).toISOString())}</small></div>`;
        var nearest = nearestReportInCell(file, cell.h3, lngLat);
        if (nearest !== null) {
            var open = document.createElement('button');
            open.type = 'button';
            open.className = 'btn btn-sm btn-outline-secondary';
            open.textContent = 'Open a report';
            open.title = 'Decode the report nearest where you clicked, from this file';
            open.addEventListener('click', ((f, i) => () => openPopup(swathRecord(f, i)))(file, nearest));
            row.appendChild(open);
        }
        list.appendChild(row);
    }
    if (parts.length > 10) list.insertAdjacentHTML('beforeend', `<div class="pp-status">and ${parts.length - 10} more files</div>`);
    var dataset = datasetId(t);
    if (dataset) showDatasetInPopup(div.querySelector('.pp-dataset'), dataset);
    bindMetricTiles(div);
    return div;
}

// The file's kept report in the cell nearest a point, or null if none is in it
export function nearestReportInCell(file, h3, lngLat) {
    var best = null, bestKm = Infinity;
    for (var i = 0; i < file.n; i++) {
        var lon = file.coords[2 * i], lat = file.coords[2 * i + 1];
        if (h3Cell(lon, lat, getResolution(h3)) !== h3) continue;
        var km = distanceKm([lon, lat], [lngLat.lng, lngLat.lat]);
        if (km < bestKm) { best = i; bestKm = km; }
    }
    return best;
}

// With coverage switched off, every swath report is a point
export function showSwathPoints(file) {
    file.points = [];
    for (var i = 0; i < file.n; i++) {
        var record = swathRecord(file, i);
        addPoint(record);
        file.points.push(record);
    }
}

export function hideSwathPoints(file) {
    (file.points || []).forEach((r) => records.has(r.id) && removePoint(r));
    file.points = null;
}

export function syncSwathPoints() {
    var want = hiddenLayers.has('sat-coverage') && !effectiveHidden().includes('satellite');
    if (want === swathPointsShown) return;
    swathPointsShown = want;
    if (!want) {
        swathFiles.forEach(hideSwathPoints);
        return;
    }
    // The newest files the satellite pool has room for, added oldest first so it drops the right ones
    var files = [], total = 0;
    for (var file of [...swathFiles.values()].reverse()) {
        if (total + file.n > MAX_SATELLITE_POINTS) break;
        files.unshift(file);
        total += file.n;
    }
    files.forEach(showSwathPoints);
}

export const FILL_SPREAD_MAX = 0.1;  // A file's mean fills its empty coverage cells only if its values' spread (SD) is within this share of the colour scale

// Satellite coverage (see the Satellite coverage section). Declared here as the key,
// built while the page loads, lists what they hold
export const swathFiles = new Map();  // file data_id -> swath file, oldest first

// Coverage is kept in grids of H3 cells (see the Satellite coverage section): the whole
// globe's, always (the overview and the map key use it), and while zoomed in a finer one
// over the area in view, which the map then draws instead
export const globalGrid = { key: 'global', res: H3_RESOLUTION, bounds: null, cells: new Map(), dirty: new Set(), removed: [] };

export let viewGrid = null;

export const swathCells = globalGrid.cells;  // satellite + H3 cell -> totals of the files covering it

// Opacity of satellite coverage, from the slider under Space-based (kept in localStorage).
// Shaded evenly it stays faint; styled by a satellite measure it's solid, so the colours read true
export const SWATH_OPACITY_DEFAULT = 0.1;

export const swathOpacity = { plain: SWATH_OPACITY_DEFAULT, styled: 1 };

// Which opacity the coverage uses now
export function swathOpacityKey() {
    return satelliteStyled() ? 'styled' : 'plain';
}

let opacitySlider = null;  // Set by LegendControl (setOpacitySlider); follows the measure

export function setOpacitySlider(el) {
    opacitySlider = el;
}

// Shows the opacity in use: the plain one, or the one for a satellite measure
export function syncOpacitySlider() {
    if (!opacitySlider) return;
    var percent = Math.round(swathOpacity[swathOpacityKey()] * 100);
    opacitySlider.querySelector('input').value = percent;
    opacitySlider.querySelector('output').textContent = `${percent}%${swathOpacityKey() === 'styled' ? ' while styled' : ''}`;
}

// Marks the coverage cell holding a selected report, or a selected cell (null clears it)
export function liftSwathCell(record) {
    var file = record && swathFiles.get(record.fileKey);
    liftCell(file && shownGrid().cells.get(swathCellId(file.sat, ...record.coords)));
}

export function liftCell(cell) {
    var source = map.getSource('swath-selected');
    if (source) source.setData({ type: 'FeatureCollection', features: cell ? [swathFeature(cell)] : [] });
}

// Outlines the coverage cell under the pointer, and thinly all of its satellite's
// coverage (null takes both away)
export let hoveredCell = null;

export const SAT_OUTLINE_MAX_CELLS = 2500;  // Of about 5,900 at resolution 3; more is too slow to outline

export let satOutline = { sat: null, cells: 0, features: [] };  // The satellite's outline, kept while its coverage is unchanged

export function outlineSwathCell(lngLat, sat) {
    var source = map.getSource('swath-hover');
    var grid = shownGrid();
    var cell = lngLat && h3Cell(lngLat.lng, lngLat.lat, grid.res);
    var id = cell ? `${sat}|${cell}` : null;
    if (!source || id === hoveredCell) return;
    hoveredCell = id;
    if (cell) {
        var cells = [...grid.cells.values()].filter((c) => c.sat === sat).map((c) => c.h3);
        if (satOutline.sat !== sat || satOutline.cells !== cells.length || satOutline.grid !== grid) {
            // H3 can't merge some areas (one wrapping round the globe throws) and takes minutes
            // over nearly global ones; then only the cell itself is outlined, rather than the
            // hover failing or freezing the page
            var rings = [];
            try {
                if (cells.length <= SAT_OUTLINE_MAX_CELLS) rings = cellsOutline(cells);
            } catch (err) {
                console.debug(`No coverage outline for ${sat}: ${err.message}`);
            }
            satOutline = { sat, grid, cells: cells.length, features: rings.map((ring) => ({ type: 'Feature',
                properties: { role: 'sat' }, geometry: { type: 'LineString', coordinates: ring } })) };
        }
    }
    source.setData({ type: 'FeatureCollection', features: cell ? [...satOutline.features, { type: 'Feature', properties: { role: 'cell' },
        geometry: { type: 'LineString', coordinates: cellRing(cell) } }] : [] });
}

// The opacities as each viewer left them
try {
    for (const key of Object.keys(swathOpacity)) {
        const stored = parseFloat(localStorage.getItem(`wis-coverage-opacity-${key}`));
        if (stored >= 0 && stored <= 1) swathOpacity[key] = stored;
    }
} catch (err) {
    // Storage unavailable; use the defaults
}
