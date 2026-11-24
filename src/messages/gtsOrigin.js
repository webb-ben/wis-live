// The centre a GTS bulletin really comes from. The gateways (de-dwd-gts-to-wis2,
// jp-jma-gts-to-wis2) republish the GTS into WIS2 under their own centre-id, but each bulletin
// names the centre that issued it in its heading, CCCC (EDZW, RJTD, LFPW…). That is mapped to
// a WIS2 centre-id: from the table below; else by the ICAO country it begins with (ED…:
// Germany) to the one national centre WIS2's register has for that country (or the one
// preferred for it, where it has several); else the CCCC itself is the answer, rather than a guess

// Centres known by their CCCC (WMO-No. 386, Volume II): the ones seen on the GTS most, each a
// centre-id in WIS2's register (checked 2026-11-24; Denmark, Norway and Portugal had none)
const CCCC_CENTRES = {
    RJTD: 'jp-jma', BABJ: 'cn-cma', EDZW: 'de-dwd', ECMF: 'int-ecmwf', ECEP: 'int-ecmwf', EGRR: 'uk-metoffice',
    KWBC: 'us-noaa-nws', KWNO: 'us-noaa-nws', KWAL: 'us-noaa-nws', KNHC: 'us-noaa-nws', PHFO: 'us-noaa-nws', PGUM: 'us-noaa-nws',
    CWAO: 'ca-eccc-msc', CYQX: 'ca-eccc-msc', CWUL: 'ca-eccc-msc', RKSL: 'kr-kma', LFPW: 'fr-meteofrance', LFVW: 'fr-meteofrance',
    FMEE: 'fr-meteofrance',  // La Réunion (Météo-France), not Madagascar as its FM prefix would say
    AMMC: 'au-bom', ADRM: 'au-bom', APRF: 'au-bom',  // The Bureau of Meteorology (INFERRED below)
    SBBR: 'br-inmet', LEMM: 'es-aemet', LIIB: 'it-meteoam', LOWM: 'at-geosphere', LSSW: 'ch-meteoswiss', EHDB: 'nl-knmi-nms',
    EBUM: 'be-rmib', ESWI: 'se-smhi', EFKL: 'fi-fmi', EIDB: 'ie-meteireann',
    SABM: 'ar-smn', SCSC: 'cl-meteochile', FAPR: 'za-weathersa', OEJD: 'sa-ncm', OMAA: 'ae-ncm',
    DEMS: 'in-imd', VABB: 'in-imd', WMKK: 'my-metmalaysia', WSSS: 'sg-mss', NZKL: 'nz-metservice',
    EUMS: 'int-eumetsat', EUMG: 'int-eumetsat', EUMP: 'int-eumetsat', EUSR: 'int-eumetsat',
};

// ICAO location indicator prefixes to ISO 3166 country codes (the codes WIS2 centre-ids begin
// with: the UK's are uk-, not gb-). Two letters before one, as K (USA) or C (Canada) alone
const ICAO_COUNTRIES = {
    ED: 'de', ET: 'de', LF: 'fr', EG: 'uk', EI: 'ie', LE: 'es', LP: 'pt', LI: 'it', LO: 'at', LS: 'ch', LK: 'cz',
    LZ: 'sk', EP: 'pl', EH: 'nl', EB: 'be', EL: 'lu', EK: 'dk', EN: 'no', ES: 'se', EF: 'fi', BI: 'is', LG: 'gr',
    LT: 'tr', LH: 'hu', LR: 'ro', LB: 'bg', LY: 'rs', LD: 'hr', LJ: 'si', LQ: 'ba', LW: 'mk', LA: 'al', LU: 'md',
    LC: 'cy', LM: 'mt', EV: 'lv', EY: 'lt', EE: 'ee', UK: 'ua', UM: 'by', UG: 'ge', UD: 'am', UB: 'az', UA: 'kz',
    UT: 'uz', RJ: 'jp', RO: 'jp', RK: 'kr', ZK: 'kp', ZM: 'mn', VH: 'hk', VM: 'mo', VV: 'vn', VT: 'th', VL: 'la',
    VD: 'kh', VY: 'mm', WM: 'my', WB: 'my', WS: 'sg', WI: 'id', WA: 'id', WR: 'id', RP: 'ph', VI: 'in', VA: 'in',
    VE: 'in', VO: 'in', VC: 'lk', VG: 'bd', VN: 'np', VQ: 'bt', VR: 'mv', OP: 'pk', OA: 'af', OI: 'ir', OR: 'iq',
    OS: 'sy', OJ: 'jo', OL: 'lb', LL: 'il', OE: 'sa', OM: 'ae', OB: 'bh', OK: 'kw', OT: 'qa', OO: 'om', OY: 'ye',
    HE: 'eg', HL: 'ly', DT: 'tn', DA: 'dz', GM: 'ma', HS: 'sd', HA: 'et', HK: 'ke', HT: 'tz', HU: 'ug', HR: 'rw',
    HB: 'bi', HD: 'dj', FA: 'za', FB: 'bw', FV: 'zw', FL: 'zm', FW: 'mw', FQ: 'mz', FM: 'mg', FI: 'mu', FS: 'sc',
    FN: 'ao', FC: 'cg', FZ: 'cd', FK: 'cm', FO: 'ga', DN: 'ng', DG: 'gh', DI: 'ci', DB: 'bj', DX: 'tg', DF: 'bf',
    DR: 'ne', GA: 'ml', GO: 'sn', GB: 'gm', GU: 'gn', GV: 'cv', GQ: 'mr', FT: 'td', SB: 'br', SA: 'ar', SC: 'cl',
    SK: 'co', SP: 'pe', SE: 'ec', SV: 've', SU: 'uy', SG: 'py', SL: 'bo', SM: 'sr', SY: 'gy', MM: 'mx', MU: 'cu',
    MK: 'jm', MD: 'do', MT: 'ht', MR: 'cr', MP: 'pa', MN: 'ni', MH: 'hn', MS: 'sv', MG: 'gt', MZ: 'bz', MY: 'bs',
    TB: 'bb', TT: 'tt', NZ: 'nz', NF: 'fj', NS: 'ws', NT: 'pf', AY: 'pg', AG: 'sb', NV: 'vu', PH: 'us', PA: 'us',
    PG: 'us', K: 'us', C: 'ca', Y: 'au', Z: 'cn', U: 'ru',
    // WMO's own for some centres, not ICAO's: RU… for Russia's (RUMS Moscow, RUHB Khabarovsk)
    RU: 'ru', AM: 'au', AD: 'au', AP: 'au', AB: 'au', AS: 'au',  // and A… for Australia's (AMMC Melbourne, ADRM Darwin, APRF Perth, ABRF Brisbane)
};

// Where a country has several centre-ids, the national weather service's
const NATIONAL = { de: 'de-dwd', us: 'us-noaa-nws', uk: 'uk-metoffice', cn: 'cn-cma', br: 'br-inmet', ca: 'ca-eccc-msc',
    kr: 'kr-kma', jp: 'jp-jma', fr: 'fr-meteofrance', ru: 'ru-roshydromet', hk: 'hk-hko', au: 'au-bom' };

// National centres taken as given though the register doesn't have them (yet): the Bureau of
// Meteorology, whose bulletins (AMMC Melbourne, ADRM Darwin, APRF Perth…) are many on the GTS,
// while the register's only Australian centre-id is a project's (au-imos)
const INFERRED = new Set(['au-bom']);

// Not a national centre: WIS2's global services and its regional and project centres
const SERVICE = /global|gts|wis2-to|broker|cache|catalogue|monitor|eumetnet|-wmc$|imos|bafg|grdc|ismn/;

let centreIds = [];

// A country's name in English, from the browser (ISO code; WIS2's uk- is ISO's GB)
let regionNames = null;
function countryName(code) {
    try {
        regionNames = regionNames || new Intl.DisplayNames(['en'], { type: 'region' });
        return regionNames.of((code === 'uk' ? 'gb' : code).toUpperCase()) || code;
    } catch (err) {
        return code.toUpperCase();
    }
}

// WIS2's centre-ids, from its register (queue.js loadCentres)
export function setCentreIds(ids) {
    centreIds = ids;
    found.clear();
}

const found = new Map();  // CCCC -> centre-id, or the CCCC itself

export function originCentre(cccc) {
    if (!cccc || !/^[A-Z]{4}$/.test(cccc)) return null;
    if (CCCC_CENTRES[cccc]) return CCCC_CENTRES[cccc];
    if (found.has(cccc)) return found.get(cccc);
    var country = ICAO_COUNTRIES[cccc.slice(0, 2)] || ICAO_COUNTRIES[cccc[0]];
    var answer = cccc;
    if (country) {
        var national = centreIds.filter((id) => id.startsWith(`${country}-`) && !SERVICE.test(id));
        if (NATIONAL[country] && (centreIds.includes(NATIONAL[country]) || INFERRED.has(NATIONAL[country]))) answer = NATIONAL[country];
        else if (national.length === 1) answer = national[0];
        // A country with no centre in WIS2 yet: the CCCC, with the country's name ("ENMI (Norway)")
        else answer = `${cccc} (${countryName(country)})`;
    }
    found.set(cccc, answer);
    return answer;
}

// A gateway notification's CCCC: its gts property, else the heading in its data_id
// (…/A_HVMY03RJTD241800_C_EDZW…: RJTD)
export function ccccOf(feature) {
    var props = (feature && feature.properties) || {};
    if (props.gts && props.gts.cccc) return props.gts.cccc;
    var m = /([A-Z]{4}\d{2})([A-Z]{4})\d{6}/.exec(props.data_id || '');
    return m ? m[2] : null;
}
