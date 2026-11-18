// The points on the map, as the modules that plot them see them: every record,
// each observation's record by data_id, each station's latest, and new ids. Adding
// and removing a point (drawing it, the legend, pools, twins...) is the page's,
// passed in with initPoints, so a data module plots through here instead of
// reaching into main.js.

export const records = new Map();  // id -> record for every point on the map
export const byDataId = new Map();  // data_id -> record, so each observation is drawn once
// The latest report on the map from each station, so a replayed report that is
// older than one already here can be left out (bounded by the points on the map)
export const latestByStation = new Map();  // station id -> record
let nextId = 1;
let hooks = null;

export function newId() {
    return nextId++;
}

export function observedAt(record) {
    return Date.parse(record.props.datetime || '') || record.born;
}

// add(record): draws a point, or returns the record already drawn for the same
// observation. remove(record). linked(key, record): the reports decoded from a
// file are on the map (its sidebar entries link to the first). plotted(kind):
// counts a report decoded by an optional layer. decoding(kind): whether that
// layer is still on
export function initPoints(options) {
    hooks = options;
}

export function addPoint(record) {
    return hooks.add(record);
}

export function removePoint(record) {
    hooks.remove(record);
}

export function linkDecoded(key, record) {
    hooks.linked(key, record);
}

export function countPlotted(kind) {
    hooks.plotted(kind);
}

export function decoding(kind) {
    return hooks.decoding(kind);
}
