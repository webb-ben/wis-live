// ---------- Model fields from ECCC GeoMet (WMS). GeoMet serves its default time,
// the current hour; the hour in the URL only makes browsers fetch fresh tiles.
import { METRICS } from '../config.js';
import { state } from '../state.js';
import { map } from './map.js';
import { updateMapKey } from '../lib/ui/legend.js';
export const GEOMET = 'https://geo.weather.gc.ca/geomet';

export function modelFieldUrl(key) {
    var hour = new Date().toISOString().slice(0, 13);
    return `${GEOMET}?service=WMS&version=1.3.0&request=GetMap&layers=${METRICS[key].wms}&styles=&crs=EPSG:3857`
        + `&bbox={bbox-epsg-3857}&width=256&height=256&format=image/png&transparent=true&_h=${hour}`;
}

// Shows the model base layer for the selected measure, if asked for, with its legend.
// The switch is only offered while colouring by a measure, and says when that measure has no model field.
export function updateModelField(legend) {
    var m = METRICS[state.colourBy], available = !!m && !!m.wms, on = state.modelFieldOn && available;
    var row = legend.querySelector('.legend-model');
    // Only for a measure the model has a field for; the choice comes back with one that has
    row.hidden = !available;
    row.querySelector('input').checked = on;
    row.querySelector('.legend-model-note').textContent = available
        ? `ECCC ${m.wms.split('_')[0]} ${m.wmsLabel || m.label.toLowerCase()},${new Date().toISOString().slice(11, 13)}:00 UTC, under the points` : '';
    var info = legend.querySelector('.legend-model-info');
    info.hidden = !on;
    if (map.getLayer('model-field')) {
        if (on) map.getSource('model-field').setTiles([modelFieldUrl(state.colourBy)]);
        map.setLayoutProperty('model-field', 'visibility', on ? 'visible' : 'none');
    }
    if (on) info.querySelector('img').src = `${GEOMET}?version=1.3.0&service=WMS&request=GetLegendGraphic&sld_version=1.1.0&layer=${m.wms}&format=image/png`;
    updateMapKey();
}
