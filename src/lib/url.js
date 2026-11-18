import { filters, filterModes } from './filters.js';
import { FORMATS, DISCIPLINES } from '../messages/messages.js';
import { SATELLITE_STYLE, WAVE_STYLE, METRICS } from '../config.js';
import { hiddenLayers } from '../map/layers.js';
import { SATELLITE_PAGE, GBON_PAGE, metricOnPage } from '../page.js';
import { setState, state } from '../state.js';
import { setStartDataset, shownDataset, startDataset, setShownDataset } from '../data/catalogue.js';
import { setReplayWindowMs, REPLAY_RANGE_MINUTES, replayWindowMs } from '../messages/replay.js';


// Filters and point styling in the address bar, so a view can be shared:
// ?topic=synop&centre=de-dwd,jp-jma&format=bufr&discipline=ocean&hide=centres
// (hide lists the filters set to Hide rather than Only), and style=temp&require=1&base=1
// (the measure points are coloured by, Require value, the model base layer; style is
// left out for the default, observation type). Other parameters are kept.
export const FILTER_PARAMS = { text: 'topic', centres: 'centre', format: 'format', disciplines: 'discipline' };

export const DEFAULT_COLOUR = SATELLITE_PAGE ? SATELLITE_STYLE : 'kind';

export let startColour = DEFAULT_COLOUR;  // The measure the page opens coloured by

export function readFiltersFromUrl() {
    var params = new URLSearchParams(location.search);
    var list = (name) => (params.get(name) || '').split(',').map((s) => s.trim()).filter(Boolean);
    filters.text = (params.get(FILTER_PARAMS.text) || '').trim().toLowerCase();
    list(FILTER_PARAMS.centres).forEach((c) => filters.centres.add(c));
    filters.format = FORMATS.hasOwnProperty(params.get(FILTER_PARAMS.format)) ? params.get(FILTER_PARAMS.format) : '';
    list(FILTER_PARAMS.disciplines).filter((d) => DISCIPLINES.hasOwnProperty(d)).forEach((d) => filters.disciplines.add(d));
    list('hide').filter((key) => filterModes.hasOwnProperty(key)).forEach((key) => { filterModes[key] = 'hide'; });
    // Only the styles this page offers (see page.js); another page's are ignored. Wave
    // spectra are ships' and buoys', which the GBON page doesn't show
    var style = params.get('style');
    var onPage = SATELLITE_PAGE ? style === SATELLITE_STYLE || (METRICS[style] && metricOnPage(METRICS[style]))
        : style === 'kind' || (style === WAVE_STYLE && !GBON_PAGE) || (METRICS[style] && metricOnPage(METRICS[style]));
    if (onPage) startColour = style;
    // The satellite page has no Require value / Satellites only checkbox: it's always on there (see state.js)
    setState({ colouredOnly: SATELLITE_PAGE || params.get('require') === '1', modelFieldOn: params.get('base') === '1' });
    // The full id, or without its urn:wmo:md: (dataset=ma-marocmeteo:h6vqw6); either may be URL-encoded or not
    var dataset = (params.get('dataset') || '').trim();
    if (/^[a-z0-9-]+:\S+$/i.test(dataset) && !/^urn:/i.test(dataset)) dataset = `urn:wmo:md:${dataset}`;
    if (/^urn:wmo:md:/i.test(dataset)) setStartDataset(dataset);
    var replayMinutes = params.has('replay') ? replayMinutesFrom(params.get('replay')) : null;
    if (replayMinutes) {
        hiddenLayers.delete('replay');
        setReplayWindowMs(replayMinutes * 60 * 1000);
    }
}

// ?replay= turns the Global Replay on, reaching back a duration (90m, 2h, or plain
// minutes) or to a time (ISO 8601, URL-encoded: 2026-11-17T12%3A00Z), held within
// what its slider allows (5 minutes to 12 hours). Null if it reads as neither
export function replayMinutesFrom(value) {
    var duration = /^(\d+(?:\.\d+)?)\s*(m|min|h)?$/i.exec(value.trim());
    var minutes = duration ? Number(duration[1]) * (/^h$/i.test(duration[2] || '') ? 60 : 1)
        : (Date.now() - Date.parse(value)) / 60000;
    if (!(minutes > 0)) return null;
    var [far, near] = REPLAY_RANGE_MINUTES;
    return Math.round(Math.min(far, Math.max(near, minutes)));
}

// The replay window as written in the URL: whole hours as 2h, anything else as 90m
export function replayParam(minutes) {
    return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

export function writeFiltersToUrl() {
    var params = new URLSearchParams(location.search);
    var set = (name, value) => (value ? params.set(name, value) : params.delete(name));
    // A dataset shown on the map stands for its topic filter; changing the filter leaves it a plain filter
    if (shownDataset && !startDataset && filters.text !== shownDataset.topic) setShownDataset(null);
    set(FILTER_PARAMS.text, shownDataset && filters.text === shownDataset.topic ? '' : filters.text);
    set(FILTER_PARAMS.centres, [...filters.centres].sort().join(','));
    set(FILTER_PARAMS.format, filters.format);
    set(FILTER_PARAMS.disciplines, [...filters.disciplines].join(','));
    // A mode only matters while its filter is set
    set('hide', Object.keys(filterModes).filter((key) => filterModes[key] === 'hide' && (key === 'text' ? filters.text
        : key === 'format' ? filters.format : filters[key].size)).join(','));
    // The options only count while colouring by a measure (and the base layer only for one with a model field)
    var m = METRICS[state.colourBy];
    set('style', state.colourBy !== DEFAULT_COLOUR ? state.colourBy : '');
    set('require', !SATELLITE_PAGE && state.colouredOnly && (m || state.colourBy === SATELLITE_STYLE) ? '1' : '');
    set('base', state.modelFieldOn && m && m.wms ? '1' : '');
    if (!startDataset) set('dataset', shownDataset ? shownDataset.id : '');  // Kept while a link's dataset is still loading
    // A duration, not a time, so the link still means something tomorrow
    set('replay', hiddenLayers.has('replay') ? '' : replayParam(Math.round(replayWindowMs / 60000)));
    var share = document.querySelector('.queue-share');
    if (share) share.hidden = !['topic', 'centre', 'format', 'discipline', 'style', 'require', 'base', 'dataset', 'replay'].some((p) => params.has(p));
    // Commas, colons and slashes read better unescaped (a dataset's urn:wmo:md:..., a
    // topic's a/b/c), and are all allowed as they are in a query
    var query = params.toString().replace(/%2C/gi, ',').replace(/%3A/gi, ':').replace(/%2F/gi, '/');
    try {
        history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    } catch (err) {
        // Some embedded views don't allow it; the filters still apply
    }
}
