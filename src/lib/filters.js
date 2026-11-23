// The filters shared by the map and the sidebar (state.filters), whether each keeps
// or hides what matches (state.filterModes), and whether a message or point passes them
import { state } from '../state.js';
import { effectiveHidden } from '../map/layers.js';
import { isSpaceBased } from '../messages/messages.js';
import { isSpaceRecord } from '../map/points.js';

// Filters shared by the map and the sidebar, and whether each keeps or hides what
// matches: kept in state.js (applyFilters tells its listeners)
// text is the topic box as typed (lower case); format a Set of FORMATS keys
export const filters = state.filters;

// The topic filter's terms: its text split at commas, so "synop, temp" keeps either
export function topicTerms() {
    return filters.text.split(',').map((term) => term.trim()).filter(Boolean);
}

// Whether a topic has any of the terms in it
export function matchesTopic(topic) {
    var lower = topic.toLowerCase();
    return topicTerms().some((term) => lower.includes(term));
}

export const filterModes = state.filterModes;

// The WIS2 data policies (…/data/core/…, …/data/recommended/…), as the Policy chips name them
export const POLICY_LABELS = { core: 'Core', recommended: 'Recommended' };

export function policyOf(topic) {
    var m = /\/data\/(core|recommended)\//.exec(topic || '');
    return m ? m[1] : null;
}

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
        && test('format', filters.format.size, filters.format.has(item.format))
        && test('disciplines', filters.disciplines.size, matchesDiscipline(item))
        && test('policy', filters.policy.size, filters.policy.has(policyOf(item.topic)))
        && test('text', topicTerms().length, matchesTopic(item.topic));
}

// The Space chip covers space weather and satellite observations, whatever discipline
// their topic gives (WIS2 space-based-observations, GTS IN and IE bulletins)
export function matchesDiscipline(item) {
    return filters.disciplines.has(item.discipline) || (filters.disciplines.has('space-weather')
        && (isSpaceBased(item.topic) || (item.record && isSpaceRecord(item.record))));
}

export function filtersActive() {
    return !!(topicTerms().length || filters.centres.size || filters.format.size || filters.disciplines.size || filters.policy.size);
}

// Layers with a point drawn on the map now: switched on, and passing the same
// filters as applyMapFilter. The decode options a report came through (via) count too
// Whether a point's properties (or a swath file's) pass the layer switches and the
// filters, as applyMapFilter decides on the map. hidden is a Set of effectiveHidden()
export function passesFilters(p, hidden) {
    var test = (key, active, matches) => !active || (filterModes[key] === 'hide' ? !matches : matches);
    return !(hidden.has(p.layer) || hidden.has(p.via) || hidden.has(p.sat) || (p.replay && hidden.has('replay')))
        && test('centres', filters.centres.size, filters.centres.has(p.centre))
        && test('format', filters.format.size, filters.format.has(p.format))
        && test('disciplines', filters.disciplines.size, filters.disciplines.has(p.discipline) || (filters.disciplines.has('space-weather') && p.space))
        && test('policy', filters.policy.size, filters.policy.has(policyOf(p.topic)))
        && test('text', topicTerms().length, matchesTopic(p.topic));
}
