// The values a decoded report gives for the measures the map can be styled by
// (METRICS), as feature properties (m_temp, ...)
import { METRICS } from '../config.js';

// decoded data: GTS and decoded-file reports have it already; cache stations
// are downloaded and decoded in the background while a measure is selected.
// Precipitation totals (013011) by the window before them (004024, hours ago)
export function precipitationTotals(rows) {
    var totals = new Map(), period = null;
    for (var [id, , value] of rows) {
        if (id === 4024 && typeof value === 'number') period = -value;
        else if (id === 13011 && typeof value === 'number' && period > 0 && !totals.has(period)) totals.set(period, value);
    }
    return totals;
}

// Feature properties ("m_temp", ...) for the measures a record's decoded data holds
export function metricValues(record) {
    var rows = record.decoded && record.decoded.rows;
    // Swath reports carry the values their file kept
    if (!rows) return record.metrics || {};
    var out = {};
    var totals = precipitationTotals(rows);
    for (var [key, m] of Object.entries(METRICS)) {
        var row = m.ids.map((id) => rows.find((r) => r[0] === id && typeof r[2] === 'number')).find(Boolean);
        var value = m.period && totals.has(m.period) ? totals.get(m.period) : row ? row[2] : undefined;
        // Negative precipitation codes trace amounts
        if (m.period && value < 0) value = 0;
        if (value !== undefined) out[`m_${key}`] = m.convert ? m.convert(value) : value;
    }
    // Not a measure of its own: turns points into arrows while wind speed is the colour
    var direction = rows.find((r) => r[0] === 11001 && typeof r[2] === 'number');
    if (direction) out.m_windDir = direction[2];
    return out;
}
