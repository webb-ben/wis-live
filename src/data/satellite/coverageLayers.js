// The map layers satellite coverage is drawn with, and what hovering and clicking them
// does. Added on both pages, so styling and filtering (colour.js, filter.js) find them;
// only the satellite page has files to fill them (see page.js)
import { map } from '../../map/map.js';
import { METRICS } from '../../config.js';
import { state } from '../../state.js';
import { formatMetric } from '../../lib/format.js';
import { hoverLabel } from '../../lib/ui/popup.js';
import { openCellSummary, outlineSwathCell, syncSwathGrid } from './coverage.js';

// pointLayers: the layers of points, which take the pointer over coverage; nearestPoint(point):
// the point a click at that screen point opens, if any
export function addCoverageLayers({ pointLayers, nearestPoint }) {
    var empty = { type: 'FeatureCollection', features: [] };
    // Each decoded satellite file as one footprint (the area its reports cover), under the points
    // tolerance 0: MapLibre's default simplification cuts corners off cells this small
    // at low zooms, which shows as a clipped outline on the selected or hovered cell
    map.addSource('swaths', { type: 'geojson', data: empty, tolerance: 0 });
    // No antialiasing, so neighbouring cells meet without hairline seams. Where passes
    // overlap, the latest observed is drawn on top (on the satellite page, where coverage
    // is opaque, it's the one seen; see paintAge)
    map.addLayer({ id: 'swaths-fill', type: 'fill', source: 'swaths', layout: { 'fill-sort-key': ['get', 'latest'] },
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.3, 'fill-antialias': false } });
    map.addLayer({ id: 'swath-arrows', type: 'symbol', source: 'swaths', filter: ['boolean', false],
        layout: {
            'symbol-placement': 'point',
            'icon-image': 'arrow',
            'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 6, 0.65, 10, 0.9],
            'icon-rotate': ['+', ['to-number', ['get', 'm_windDir'], 0], 180],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': false,
            'icon-ignore-placement': true,
            'icon-pitch-alignment': 'map',
        },
        paint: { 'icon-color': ['get', 'color'], 'icon-halo-color': 'rgba(255, 255, 255, 0.9)', 'icon-halo-width': 1 },
    });
    // The selection in coverage: a clicked cell's whole satellite outlined (a white edge
    // on a soft dark halo), or the cell holding an opened report, also filled more strongly
    map.addSource('swath-selected', { type: 'geojson', data: empty, tolerance: 0 });
    map.addLayer({ id: 'swath-lift', type: 'fill', source: 'swath-selected',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.6 } });
    map.addLayer({ id: 'swath-lift-halo', type: 'line', source: 'swath-selected',
        layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#000000', 'line-width': 4, 'line-opacity': 0.3 } });
    map.addLayer({ id: 'swath-lift-edge', type: 'line', source: 'swath-selected',
        layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 1.5 } });
    // On hover: the cell under the pointer in black on a white halo, like the selected-point marker
    map.addSource('swath-hover', { type: 'geojson', data: empty, tolerance: 0 });
    map.addLayer({ id: 'swath-hover-halo', type: 'line', source: 'swath-hover', paint: { 'line-color': '#ffffff', 'line-width': 5 } });
    map.addLayer({ id: 'swath-hover', type: 'line', source: 'swath-hover', paint: { 'line-color': '#000000', 'line-width': 2 } });
    map.on('click', 'swaths-fill', (e) => {
        if (nearestPoint(e.point)) return;
        openCellSummary(e.features[0].properties.swath, e.lngLat);
    });
    map.on('mousemove', 'swaths-fill', (e) => {
        if (map.queryRenderedFeatures(e.point, { layers: pointLayers }).length) return outlineSwathCell(null);
        var f = e.features[0].properties;
        outlineSwathCell(e.lngLat, f.swath);
        map.getCanvas().style.cursor = 'pointer';
        var m = METRICS[state.colourBy];
        var reading = m && m.targets === 'satellite' && typeof f[`m_${state.colourBy}`] === 'number' ? ` · ${formatMetric(f[`m_${state.colourBy}`], m)}` : '';
        hoverLabel.setLngLat(e.lngLat).setText(`${f.label}${reading}`).addTo(map);
    });
    map.on('mouseleave', 'swaths-fill', () => {
        map.getCanvas().style.cursor = '';
        hoverLabel.remove();
        outlineSwathCell(null);
    });
    // Finer coverage cells zoomed in (see syncSwathGrid)
    map.on('moveend', () => syncSwathGrid());
}
