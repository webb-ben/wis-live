// The filters shared by the map and the sidebar (state.filters), whether each keeps
// or hides what matches (state.filterModes), and whether a message or point passes them
import { state } from '../state.js';
import { effectiveHidden } from '../map/layers.js';
import { isSpaceBased } from '../messages/messages.js';
import { isSpaceRecord } from '../map/points.js';

// Filters shared by the map and the sidebar, and whether each keeps or hides what
// matches: kept in state.js (applyFilters tells its listeners)
export const filters = state.filters;

export const filterModes = state.filterModes;

export function matchesFilters(item) {
    // The Cache and Origin layer switches apply to the message list as well
    var hidden = effectiveHidden();
    return !(item.channel === 'cache' ? hidden.includes('obs') : hidden.includes('origin')) && passesFilterChips(item);
}

// The filters alone (centre, format, discipline, topic text), for a message as
// queueMessage describes it; also what the Global Replay keeps (see loadReplay)
export function passesFilterChips(item) {
    var test = (key, active, matches) => !active || (filterModes[key] === 'hide' ? !matches : matches);
    return test('centres', filters.centres.size, filters.centres.has(item.centre))
        && test('format', filters.format, item.format === filters.format)
        && test('disciplines', filters.disciplines.size, matchesDiscipline(item))
        && test('text', filters.text, item.topic.toLowerCase().includes(filters.text));
}

// The Space chip covers space weather and satellite observations, whatever discipline
// their topic gives (WIS2 space-based-observations, GTS IN and IE bulletins)
export function matchesDiscipline(item) {
    return filters.disciplines.has(item.discipline) || (filters.disciplines.has('space-weather')
        && (isSpaceBased(item.topic) || (item.record && isSpaceRecord(item.record))));
}

export function filtersActive() {
    return !!(filters.text || filters.centres.size || filters.format || filters.disciplines.size);
}

// Layers with a point drawn on the map now: switched on, and passing the same
// filters as applyMapFilter. The decode options a report came through (via) count too
// Whether a point's properties (or a swath file's) pass the layer switches and the
// filters, as applyMapFilter decides on the map. hidden is a Set of effectiveHidden()
export function passesFilters(p, hidden) {
    var test = (key, active, matches) => !active || (filterModes[key] === 'hide' ? !matches : matches);
    return !(hidden.has(p.layer) || hidden.has(p.via) || hidden.has(p.sat) || (p.replay && hidden.has('replay')))
        && test('centres', filters.centres.size, filters.centres.has(p.centre))
        && test('format', filters.format, p.format === filters.format)
        && test('disciplines', filters.disciplines.size, filters.disciplines.has(p.discipline) || (filters.disciplines.has('space-weather') && p.space))
        && test('text', filters.text, p.topic.includes(filters.text));
}
