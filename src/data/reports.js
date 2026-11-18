// What a decoded report is, from the identifiers it carries: the GTS sublayer it
// goes on (reportClass), its id (reportId) and when it was observed (reportTime).
// values: descriptor -> value
import { windProfileLevels } from '../plots/sounding.js';

// Which GTS sublayer a report belongs to, from the identifiers it carries.
// Order matters: satellite and aircraft reports can also carry station-like ids.
export function reportClass(values, profile, rows) {
    if (values.has(1007)) return 'satellite';
    if (values.has(1008) || values.has(1006) || values.has(7010) || values.has(8009) || values.has(8004)) return 'aircraft';
    // Wind profilers are 6 in code table 0 02 003. Radar (3) only says some radar measured the
    // winds (e.g. weather radar VAD winds, which Norway sends as IUPD bulletins), so it counts
    // only with winds at heights
    if (values.get(2003) === 6 || (values.get(2003) === 3 && rows && windProfileLevels(rows))) return 'radarwind';
    if (profile && profile.length >= 2) return 'upperair';
    // Radars that sent no winds this time (e.g. Clee Hill's IUPA, Hannover's IUPD) aren't soundings either
    if (values.get(2003) === 3) return 'other';
    // PILOTs name their equipment, even with no levels to report
    if (values.has(2003)) return 'upperair';
    if (values.has(1011)) return 'ship';
    if (values.has(1087) || values.has(1005) || values.has(2149)) return 'buoy';
    // GNSS receivers have site names but report path delays (e.g. template 3 07 022)
    if (values.has(15031) || values.has(15011)) return 'gnss';
    if (values.has(1015) || values.has(1001) || values.has(1125)) return 'station';
    return 'other';
}

// WIGOS id, WMO block/station, ship, buoy or aircraft identifier
export function reportId(values) {
    var text = (id) => typeof values.get(id) === 'string' && values.get(id).trim();
    if (values.has(1125) && text(1128)) {
        return `${values.get(1125)}-${values.get(1126)}-${values.get(1127)}-${text(1128)}`;
    }
    if (typeof values.get(1001) === 'number' && typeof values.get(1002) === 'number') {
        return `0-20000-0-${String(values.get(1001)).padStart(2, '0')}${String(values.get(1002)).padStart(3, '0')}`;
    }
    return text(1011) || text(1008) || (values.has(1087) && String(values.get(1087)))
        || (values.has(1005) && String(values.get(1005))) || null;
}

export function reportTime(values) {
    var [y, mo, d, h, mi] = [4001, 4002, 4003, 4004, 4005].map((id) => values.get(id));
    if (![y, mo, d, h].every((v) => typeof v === 'number')) return undefined;
    return new Date(Date.UTC(y, mo - 1, d, h, mi || 0)).toISOString();
}
