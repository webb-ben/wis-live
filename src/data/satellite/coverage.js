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
import { h3Cell, H3_RESOLUTION_MAX, H3_RESOLUTION, convexHull, h3SampleDeg, inOrNearRing, h3Neighbors, h3NeighborRings, reportSpacingKm, resolutionForSpacing, cellRing, distanceKm, cellsBorder, enclosedGaps, getResolution } from '../../lib/geo.js';
import { map } from '../../map/map.js';
import { satelliteKey, satelliteName, addSatelliteRow, satelliteLink } from './rows.js';
import { metricValues } from '../metrics.js';
import { METRICS, SATELLITE_STYLE } from '../../config.js';
import { state } from '../../state.js';
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
import { showInfo, closeInfo, selectedMarker, selectOnOverview, keepPopupInView, openPopup, bindMetricTiles } from '../../lib/ui/popup.js';
export const SWATH_MIN_REPORTS = 5;
export const SWATH_FILES_MAX = 3000;  // Files whose coverage is kept, oldest dropped first...
export const SWATH_KEEP_MS = 12 * 3600e3;  // ...and none older than this
export const SWATH_FLUSH_MS = 1000;
export let swathFeatureIds = 0;
export let swathsBuilt = 0;
export let swathPointsShown = false;  // Coverage switched off: swath reports are drawn as points

// The grids kept (globalGrid, and viewGrid while zoomed in), and the one the map draws.
// Each grid's cells hold what every file adds to them (its share, see fileShare); the
// grid on the map also notes which cells changed (dirty) and went (removed) since it was drawn
export let pendingGrid = null;  // A view grid still being built, a few files at a time
export let gridBuilds = 0;
let selectedCellResolution = null;
export function grids() {
    return [globalGrid, viewGrid, pendingGrid].filter(Boolean);
}
export function shownGrid() {
    return viewGrid || globalGrid;
}

export function swathCellId(sat, lon, lat, grid = shownGrid()) {
    return `${sat}|${h3Cell(lon, lat, cellRes(sat, grid))}`;
}

// ---------- Finer cells zoomed in: about the same size on screen at any zoom
// (resolution 2 below zoom 2, then one finer per zoom level, to H3_RESOLUTION_MAX at
// zoom 4). GRID_ZOOM_SHIFT brings each step that many zoom levels earlier than the
// zoom itself would (resolution 3 at zoom 3 without it). Finer cells cover only the
// area in view, with as much again round it, so panning a little doesn't rebuild them
export const GRID_ZOOM_SHIFT = 1;
export function gridResolution(zoom) {
    return Math.min(H3_RESOLUTION_MAX, Math.max(H3_RESOLUTION, Math.floor(zoom) + GRID_ZOOM_SHIFT));
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
    var grid = pendingGrid = newGrid(`view${++gridBuilds}`, res, viewBounds(0.5));
    var files = [...swathFiles.values()];
    var step = () => {
        if (pendingGrid !== grid) return;
        var until = performance.now() + GRID_SLICE_MS;
        while (files.length && performance.now() < until) {
            var file = files.shift();
            // Gone, replaced by an update, or added since (already in)
            if (swathFiles.get(file.key) !== file || grid.files.has(file)) continue;
            addToGrid(file, grid);
        }
        if (files.length) return setTimeout(step, 0);
        refreshAllHoles(grid);
        pendingGrid = null;
        setViewGrid(grid);
    };
    step();
}

// How many rings of neighbours a cell without reports is estimated from. A file's cells
// are about as far apart as its reports (see coverageKey), so two rings reach about two
// reports away whatever the instrument
export const NEIGHBOR_RINGS = 2;

// A grid of cells at one resolution, res: no file's cells are finer than that, nor
// finer than its reports' spacing (cellRes), so one grid can hold several
// resolutions, each in a coverage layer of its own (coverageKey). Built as the grid
// fills: rings remembers each cell's neighbours (they never change); means, on the
// global grid only, each cell's values until any of its cells change, since the
// overview draws every one of them each time
export function newGrid(key, res, bounds) {
    return { key, res, bounds, cells: new Map(), dirty: new Set(), removed: [], files: new Set(),
        ringCount: NEIGHBOR_RINGS, rings: new Map(), means: new Map() };
}

// The coverage layer a file's cells go in: its satellite and the resolution its
// reports' spacing allows ('sat:satellite:metop-b@4'). A satellite sends products as
// dense as an imager's or as sparse as cloud-motion winds; each spacing is a layer of
// its own, so cells of one resolution only ever neighbour cells of the same
export function coverageKey(satellite, res) {
    return `${satellite}@${res}`;
}

// The resolution of a coverage layer's cells on a grid
export function cellRes(layer, grid) {
    return Math.min(grid.res, Number(layer.slice(layer.lastIndexOf('@') + 1)));
}

// A cell's neighbours on this grid's resolution, ring by ring
export function gridRings(grid, h3) {
    var rings = grid.rings.get(h3);
    if (!rings) grid.rings.set(h3, rings = h3NeighborRings(h3, grid.ringCount));
    return rings;
}

// Forgets a grid's share in every file
export function dropGrid(grid) {
    if (pendingGrid === grid) pendingGrid = null;
    swathFiles.forEach((file) => {
        delete file.cells[grid.key];
        delete file.holes[grid.key];
    });
    grid.files.clear();
    grid.rings.clear();
}

export function setViewGrid(grid) {
    if (grid && selectedCellResolution !== null && grid.res > selectedCellResolution) closeInfo();
    if (viewGrid) dropGrid(viewGrid);
    viewGrid = grid;
    // The map's cells all at once; changes after this go in as they come (flushSwaths)
    var shown = shownGrid();
    map.getSource('swaths').setData({ type: 'FeatureCollection', features: [...shown.cells.values()].map((cell) => swathFeature(cell, shown)) });
    shown.dirty.clear();
    shown.valued?.clear();
    if (selectedSat) outlineSatellite(selectedSat);
    shown.removed = [];
    hoveredCell = null;
    swathsBuilt = Date.now();
}

// Packs a decoded satellite file's reports into one swath file and adds it to the cells
export function addSwathFile(job, reports) {
    var first = reports[0], n = reports.length;
    var coords = Float32Array.from(reports.flatMap((r) => r.coords));
    // Its cells as fine as its reports' spacing allows, in that spacing's layer
    var res = resolutionForSpacing(reportSpacingKm(coords));
    var sat = coverageKey(satelliteKey(first) || `${first.subLayer}:${first.fileKey}`, res);
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
    var oldShares = old && removeSwathFile(old);  // An update replaces it
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
        coords,
        res,  // The finest its cells are drawn (see resolutionForSpacing)
        // When its last report was observed: where coverage overlaps, the latest is on top
        latest: reports.reduce((t, r) => Math.max(t, r.observed || 0), 0),
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
        cells: {},  // grid key -> cell id -> what this file adds to it (the global grid's only, see fileShare)
        holes: {},  // finer grid key -> the cell ids it has hole shares in
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
    var shares = new Map(grids().map((grid) => [grid, addToGrid(file, grid)]));
    trimSwathFiles();
    // Holes round where the file is, and where the one it replaced was
    for (var g of grids()) {
        if (oldShares?.has(g)) refreshSatelliteHoles(old.sat, g, shareCells(oldShares.get(g)));
        if (shares.has(g)) refreshSatelliteHoles(sat, g, shareCells(shares.get(g)));
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

// A file's share of a grid: cell id -> what it adds there. The global grid keeps every
// file's share (file.cells); a finer grid, built only for the view, would hold one for
// every file at up to resolution 5, so there it's built again when wanted (taking the
// file off, holes round it, a cell's summary) from the same reports, which gives the
// same share. Only its hole shares are noted (file.holes), as those are added later
export function fileShare(file, grid) {
    var kept = file.cells[grid.key];
    if (kept) return kept;
    var share = buildSwathCells(file, grid);
    for (var id of file.holes[grid.key] || []) share.set(id, holeShare(id.slice(id.lastIndexOf('|') + 1)));
    return share;
}

// Adds a file to a grid, and keeps its share only where the grid keeps them
export function addToGrid(file, grid) {
    var share = buildSwathCells(file, grid);
    if (grid === globalGrid) file.cells[grid.key] = share;
    grid.files.add(file);
    applySwathShare(file, share, 1, grid);
    return share;
}

// A hole share: the file's fill, no reports (see refreshSatelliteHoles)
export function holeShare(h3) {
    return { cell: h3, fill: true, hole: true, n: 0, t0: Infinity, t1: -Infinity, sums: {}, counts: {}, mins: {}, maxs: {} };
}

// A file's cells in a grid: those its footprint covers (fill), and those its reports
// fall in. A grid with bounds gets only the cells within them
export function buildSwathCells(file, grid) {
    var cells = new Map(), res = cellRes(file.sat, grid);
    var cellFor = (lon, lat) => {
        var cell = h3Cell(lon, lat, res), id = `${file.sat}|${cell}`;
        if (!cells.has(id)) cells.set(id, { cell, fill: false, n: 0, t0: Infinity, t1: -Infinity, sums: {}, counts: {}, mins: {}, maxs: {}, windX: 0, windY: 0 });
        return cells.get(id);
    };
    var ring = file.ring, spacing = h3SampleDeg(res);
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
        var speed = file.metrics.satWind?.[i], direction = file.metrics.windDir?.[i];
        if (!isNaN(speed) && speed > 0 && !isNaN(direction)) {
            var radians = direction * Math.PI / 180;
            cell.windX += speed * Math.sin(radians);
            cell.windY += speed * Math.cos(radians);
        }
    }
    return cells;
}

// Adds a file's share to a grid's cells (sign 1), or takes it off again (-1)
export function applySwathShare(file, share, sign, grid) {
    for (var [id, c] of share) applySwathCell(file, id, c, sign, grid);
}

export function applySwathCell(file, id, c, sign, grid) {
    var cell = grid.cells.get(id);
    if (!cell) {
        if (sign < 0) return;
        // real: how many files cover it themselves; none, and it's only a filled hole
        cell = { fid: ++swathFeatureIds, h3: c.cell, sat: file.sat, real: 0,
            files: new Set(), sums: {}, counts: {}, fillSums: {}, fillCounts: {}, windX: 0, windY: 0 };
        grid.cells.set(id, cell);
    }
    // Any change on the global grid can change its cells' estimates
    if (grid === globalGrid) grid.means.clear();
    if (sign > 0) cell.files.add(file);
    else cell.files.delete(file);
    if (!c.hole) cell.real += sign;
    for (var m in c.sums) {
        cell.sums[m] = (cell.sums[m] || 0) + sign * c.sums[m];
        cell.counts[m] = (cell.counts[m] || 0) + sign * c.counts[m];
    }
    cell.windX += sign * (c.windX || 0);
    cell.windY += sign * (c.windY || 0);
    if (c.fill) {
        for (var mf in file.fillMeans) {
            cell.fillSums[mf] = (cell.fillSums[mf] || 0) + sign * file.fillMeans[mf];
            cell.fillCounts[mf] = (cell.fillCounts[mf] || 0) + sign;
        }
    }
    // Only the grid on the map notes its changes; another is drawn whole when shown
    var shown = grid === shownGrid();
    if (shown) {
        grid.dirty.add(id);
        // Its reports shade the cells around it too (swathMeans): redrawn at the flush
        if (c.n) (grid.valued ||= new Map()).set(id, cell);
    }
    if (!cell.files.size) {
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

// The H3 cells of a file's share
export function shareCells(share) {
    return [...share.values()].map((c) => c.cell);
}

// Whether a file's share in a cell of a grid is only a hole share
function isHoleShare(file, grid, id) {
    var kept = file.cells[grid.key];
    return kept ? !!kept.get(id)?.hole : !!file.holes[grid.key]?.has(id);
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
                    cellAt(n).files.forEach((f) => { if (!isHoleShare(f, grid, nid)) wanted.add(f); });
                }
            }
        }
        // Hole shares no longer wanted go...
        for (var file of cell ? [...cell.files] : []) {
            if (!isHoleShare(file, grid, id) || wanted.has(file)) continue;
            applySwathCell(file, id, holeShare(h3), -1, grid);
            if (file.cells[key]) file.cells[key].delete(id);
            else file.holes[key].delete(id);
        }
        // ...and missing ones come (never over a file's own share)
        for (var file of wanted) {
            if (grid.cells.get(id)?.files.has(file)) continue;
            var c = holeShare(h3);
            if (file.cells[key]) file.cells[key].set(id, c);
            else (file.holes[key] ||= new Set()).add(id);
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

// Takes a file off the map. Gives back the shares it had in each grid it was in, for
// the holes round where it was (see refreshSatelliteHoles)
export function removeSwathFile(file) {
    swathFiles.delete(file.key);
    var shares = new Map();
    for (var grid of grids()) {
        // A grid still being built may not have reached it
        if (!grid.files.has(file)) continue;
        var share = fileShare(file, grid);
        applySwathShare(file, share, -1, grid);
        grid.files.delete(file);
        shares.set(grid, share);
    }
    file.cells = {};
    file.holes = {};
    hideSwathPoints(file);
    keyChanged();
    return shares;
}

// Drops the oldest files beyond the caps
export function trimSwathFiles() {
    var oldest = Date.now() - SWATH_KEEP_MS;
    var removed = [];
    for (var file of swathFiles.values()) {
        if (swathFiles.size <= SWATH_FILES_MAX && file.born >= oldest) break;
        removed.push([file, removeSwathFile(file)]);
    }
    for (var [gone, shares] of removed) shares.forEach((share, grid) => refreshSatelliteHoles(gone.sat, grid, shareCells(share)));
}

// Redraws only the cells that changed since last time
export function flushSwaths(now) {
    trimSwathFiles();
    var grid = shownGrid();
    if (!grid.dirty.size && !grid.removed.length) return;
    swathsBuilt = now;
    // Cells whose own values changed: the cells within ringCount of them shade from them too
    if (grid.valued?.size) {
        for (var cell of grid.valued.values()) {
            for (var ring of gridRings(grid, cell.h3)) {
                for (var h3 of ring) {
                    var neighborId = `${cell.sat}|${h3}`;
                    if (grid.cells.has(neighborId)) grid.dirty.add(neighborId);
                }
            }
        }
        grid.valued.clear();
    }
    var add = [];
    for (var id of grid.dirty) {
        var shown = grid.cells.get(id);
        if (shown) add.push(swathFeature(shown, grid));
    }
    grid.dirty.clear();
    map.getSource('swaths').updateData({ add, remove: grid.removed });
    grid.removed = [];
}

// How much each of a cell's own reports counts, against each report in its first ring
// (4/9 each with two rings, see swathMeans) and its second (1/9 each). A cell holding
// one report beside three others that report is about half its own; one holding many
// stays near its own mean, and a lone outlier among many reports is pulled in
export const REPORT_WEIGHT = 1;
// On a finer grid, at most this share of the cells at the edge of the reports' reach
// (ring k, half as many at k - 1) is left without a value, so a lone report's
// estimate isn't a neat hexagonal lilypad
export const EDGE_DROP = 0.6;

// Every metric's value for a cell, as { metric: value }: a weighted mean of every report
// within the grid's k rings, each report counting by how far its cell is: its own
// REPORT_WEIGHT, ring r (1 - r / (k + 1))², so a report's share fades to nothing just
// past the reach. Each report counts, not each cell: a cell of one report is pulled
// towards the many around it, one of many hardly moves. A cell without reports also
// takes its files' fill, weighted as one report at ring k: weighted more, a whole
// file's average would pull the cells between reports off their reports' values.
// Only reports are blended, never other estimates: the cells are as far apart as the
// reports (coverageKey), so neighbours that report are near enough.
// Neighbours are visited once for all metrics. The global grid's values are remembered
// (grid.means) for the overview, which draws them all each time
export function swathMeans(cell, grid = shownGrid()) {
    var cached = grid === globalGrid && grid.means.get(cell);
    if (cached) return cached;
    var means = {}, sums = {}, weights = {}, nearest = {}, m;
    var own = (metric) => cell.counts[metric] > 0;
    for (m in cell.counts) {
        if (!own(m)) continue;
        sums[m] = cell.sums[m] * REPORT_WEIGHT;
        weights[m] = cell.counts[m] * REPORT_WEIGHT;
    }
    var missing = Object.keys(METRICS).some((metric) => !own(metric));
    var k = grid.ringCount, sat = cell.sat, rings = gridRings(grid, cell.h3);
    for (var r = 0; r < rings.length; r++) {
        var weight = (1 - (r + 1) / (k + 1)) ** 2;
        for (var h3 of rings[r]) {
            var neighbor = grid.cells.get(`${sat}|${h3}`);
            if (!neighbor) continue;
            for (m in neighbor.counts) {
                var n = neighbor.counts[m];
                if (!n) continue;
                sums[m] = (sums[m] || 0) + neighbor.sums[m] * weight;
                weights[m] = (weights[m] || 0) + n * weight;
                if (!(m in nearest)) nearest[m] = r + 1;
            }
        }
    }
    if (missing) {
        var background = 1 / (k + 1) ** 2;
        for (m in cell.fillCounts) {
            if (own(m) || !cell.fillCounts[m]) continue;
            sums[m] = (sums[m] || 0) + cell.fillSums[m] / cell.fillCounts[m] * background;
            weights[m] = (weights[m] || 0) + background;
        }
    }
    for (m in sums) {
        if (grid !== globalGrid && !own(m) && dropAtEdge(cell, nearest[m], k)) continue;
        means[m] = sums[m] / weights[m];
    }
    if (grid === globalGrid) grid.means.set(cell, means);
    return means;
}

// Whether a finer cell without reports is left without a value: one at the edge of its
// reports' reach (the nearest at ring k, or k - 1 for half the chance, but never ring
// 1: a cell next to a report is inside the coverage, not at its edge) is dropped at
// random, up to EDGE_DROP of them; one shaded only by its files' fill (nearestRing
// null: no report near, but the file's values agree) never is. Random by the cell
// itself, so the same each redraw
export function dropAtEdge(cell, nearestRing, k) {
    var ringEdge = nearestRing == null || nearestRing < 2 ? 0 : nearestRing >= k ? 1 : nearestRing === k - 1 ? 0.5 : 0;
    var chance = EDGE_DROP * ringEdge;
    return chance > 0 && cellNoise(cell) < chance;
}

// A number in [0, 1) fixed for a cell (FNV-1a of its H3 index), remembered on it
export function cellNoise(cell) {
    if (cell.noise == null) {
        var hash = 2166136261;
        for (var i = 0; i < cell.h3.length; i++) hash = Math.imul(hash ^ cell.h3.charCodeAt(i), 16777619);
        cell.noise = (hash >>> 0) / 4294967296;
    }
    return cell.noise;
}

export function swathFeature(cell, grid = shownGrid()) {
    var props = {};
    var means = swathMeans(cell, grid);
    for (var m in METRICS) {
        var mean = means[m];
        if (mean != null) props[`m_${m}`] = mean;
        // Its files measure this, though the cell has no value (see applyMapFilter)
        else if ([...cell.files].some((f) => f.means[m] != null)) props[`no_${m}`] = true;
    }
    if (cell.counts.satWind && (cell.windX || cell.windY)) {
        props.m_windDir = (Math.atan2(cell.windX, cell.windY) * 180 / Math.PI + 360) % 360;
    }
    var file = cell.files.values().next().value;
    var born = 0;
    var latest = 0;  // Its latest observation, which draws it over older coverage (see swaths-fill)
    cell.files.forEach((f) => {
        born = Math.max(born, f.born);
        latest = Math.max(latest, f.latest);
    });
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
            latest,
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
    selectedCellResolution = grid.res;
    showInfo(buildCellSummary(id, cell, lngLat, grid));
    selectedMarker.remove();
    outlineSatellite(sat);
    // On the world map too: the satellite's border on the global grid, which it draws
    overviewSelection = { at: [lngLat.lng, lngLat.lat], colour: cell.files.values().next().value.template.color,
        border: satelliteBorder(sat, globalGrid) };
    selectOnOverview(overviewSelection);
    keepPopupInView();
}

export function clearSelectedCell() {
    selectedCellResolution = null;
}

export function buildCellSummary(id, cell, lngLat, grid) {
    var parts = [...cell.files].map((file) => ({ file, part: fileShare(file, grid).get(id) })).filter((p) => p.part)
        .sort((a, b) => b.file.born - a.file.born);
    var t = parts[0].file.template;
    var reports = parts.reduce((n, p) => n + p.part.n, 0);
    var withReports = parts.filter((p) => p.part.n);
    var t0 = Math.min(...withReports.map((p) => p.part.t0)), t1 = Math.max(...withReports.map((p) => p.part.t1));
    var satName = t.satName || 'Satellite';
    // Where the files came from, as one grid holds both: WIS2, the GTS or both
    var via = [...new Set(parts.map((p) => (p.file.props.gateway ? 'GTS' : 'WIS2')))].sort().reverse().join(' and ');
    var tiles = [`<div class="pp-tile" data-metric="${SATELLITE_STYLE}"><div>Satellite</div><strong>${satelliteLink(satName)}</strong><div>via ${via}</div></div>`];
    for (var [key, m] of Object.entries(METRICS)) {
        if (m.targets !== 'satellite') continue;
        var count = parts.reduce((n, p) => n + (p.part.counts[key] || 0), 0);
        if (count) {
            var sum = parts.reduce((n, p) => n + (p.part.sums[key] || 0), 0);
            var lo = Math.min(...parts.filter((p) => p.part.counts[key]).map((p) => p.part.mins[key]));
            var hi = Math.max(...parts.filter((p) => p.part.counts[key]).map((p) => p.part.maxs[key]));
            tiles.push(`<div class="pp-tile" data-metric="${key}"><div>${esc(m.label)}${count > 1 ? ', mean' : ''}</div><strong>${esc(formatMetric(sum / count, m))}</strong>`
                + `<div>${count > 1 ? `${esc(formatMetric(lo, m).split(' ')[0])} to ${esc(formatMetric(hi, m))} · ` : ''}${count} report${count === 1 ? '' : 's'}</div></div>`);
        } else {
            var mean = swathMeans(cell, grid)[key];
            if (mean != null) {
                tiles.push(`<div class="pp-tile" data-metric="${key}"><div>${esc(m.label)}</div><strong>${esc(formatMetric(mean, m))}</strong><div>coverage estimate</div></div>`);
            }
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
            <dt>Cell</dt><dd class="pp-mono" title="H3 cell, resolution ${getResolution(cell.h3)}">${esc(cell.h3)}</dd>
        </dl>
        <div class="pp-status">${reports
            ? 'The cell is coloured by the reports in it, blended with those in the cells around it, so a lone report doesn\'t stand apart; the values here are its own reports\'. Of each file only some reports are kept, spread across it; these are the ones here.'
            : 'No kept report falls in this cell; it is shaded with an estimate from the reports around it.'}</div>
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
export const globalGrid = newGrid('global', H3_RESOLUTION, null);

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
    selectedSat = null;
    overviewSelection = null;
    var source = map.getSource('swath-selected');
    if (source) source.setData({ type: 'FeatureCollection', features: cell ? [swathFeature(cell, shownGrid())] : [] });
}

// A clicked coverage cell's satellite, outlined all round its coverage (white on a soft
// dark halo, see swath-lift-edge) until the panel closes; redrawn when the grid changes
export let selectedSat = null;
// The selected satellite on the world map (see openCellSummary), while it's selected
let overviewSelection = null;

// Again after the style changes, which changes which cells are drawn (see applyMapFilter)
export function refreshSatelliteOutline() {
    if (!selectedSat) return;
    outlineSatellite(selectedSat);
    if (overviewSelection) {
        overviewSelection.border = satelliteBorder(selectedSat, globalGrid);
        selectOnOverview(overviewSelection);
    }
}
export function outlineSatellite(sat) {
    var source = map.getSource('swath-selected');
    if (!source) return;
    source.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { sat },
        geometry: { type: 'MultiLineString', coordinates: satelliteBorder(sat, shownGrid()) } }] });
    selectedSat = sat;
}

// The border round the outside of what's drawn of a satellite on a grid, as [lon, lat]
// segments: every layer of it (each product spacing, see coverageKey), but only cells
// shown for the measure styled by (the satellite page leaves out cells without a
// value). Cells of different resolutions share no edges, so a layer's edge whose far
// side another layer covers is inside the coverage, and left out
export function satelliteBorder(sat, grid) {
    var metric = METRICS[state.colourBy] && state.colourBy;
    var satellite = sat.slice(0, sat.lastIndexOf('@')), layers = new Map();
    for (var c of grid.cells.values()) {
        if (c.sat.slice(0, c.sat.lastIndexOf('@')) !== satellite) continue;
        if (metric && state.colouredOnly && swathMeans(c, grid)[metric] == null) continue;
        if (!layers.has(c.sat)) layers.set(c.sat, new Set());
        layers.get(c.sat).add(c.h3);
    }
    // Nor round gaps inside it (where no report was near enough to estimate from)
    return [...layers].flatMap(([layer, cells]) => {
        var gaps = enclosedGaps(cells);
        return cellsBorder(cells, (lon, lat, beyond) => gaps.has(beyond)
            || [...layers].some(([other, otherCells]) => other !== layer && otherCells.has(h3Cell(lon, lat, cellRes(other, grid)))));
    });
}

// Outlines the coverage cell under the pointer (null takes it away)
export let hoveredCell = null;

export function outlineSwathCell(lngLat, sat) {
    var source = map.getSource('swath-hover');
    var grid = shownGrid();
    var cell = lngLat && h3Cell(lngLat.lng, lngLat.lat, cellRes(sat, grid));
    var id = cell ? `${sat}|${cell}` : null;
    if (!source || id === hoveredCell) return;
    hoveredCell = id;
    source.setData({ type: 'FeatureCollection', features: cell ? [{ type: 'Feature', properties: { role: 'cell' },
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
