// What made a satellite report and what it holds, from BUFR code tables.
// Code tables 0 01 007 (satellite, all of it) and 0 02 019 (instrument, common entries
// only); anything else shows its code.

// The WMO satellite identifiers (common code table C-5, as BUFR 0 01 007 uses them).
// 811 is listed as COMS-2, which flew as GEO-KOMPSAT-2A; 71 (Meteosat-12, MTG-I1) and
// 524 (FY-3E) are newer than the list this was taken from
export const SATELLITE_NAMES = {
    1: 'ERS 1', 2: 'ERS 2', 3: 'METOP-1 (Metop-B)', 4: 'METOP-2 (Metop-A)', 5: 'METOP-3 (Metop-C)', 20: 'SPOT1',
    21: 'SPOT2', 22: 'SPOT3', 23: 'SPOT4', 40: 'OERSTED', 41: 'CHAMP', 42: 'TerraSAR-X', 43: 'TanDEM-X', 44: 'PAZ',
    46: 'SMOS', 47: 'CryoSat-2', 48: 'AEOLUS', 50: 'METEOSAT 3', 51: 'METEOSAT 4', 52: 'METEOSAT 5', 53: 'METEOSAT 6',
    54: 'METEOSAT 7', 55: 'METEOSAT 8', 56: 'METEOSAT 9', 57: 'METEOSAT 10', 58: 'METEOSAT 1', 59: 'METEOSAT 2',
    60: 'ENVISAT', 61: 'Sentinel 3A', 62: 'Sentinel 1A', 63: 'Sentinel 1B', 64: 'Sentinel 5P', 65: 'Sentinel 3B',
    70: 'METEOSAT 11', 71: 'Meteosat-12', 120: 'ADEOS', 121: 'ADEOS II', 122: 'GCOM-W1', 140: 'GOSAT', 150: 'GMS 3',
    151: 'GMS 4', 152: 'GMS 5', 153: 'GMS', 154: 'GMS 2', 171: 'MTSAT-1R', 172: 'MTSAT-2', 173: 'Himawari-8',
    174: 'Himawari-9', 200: 'NOAA 8', 201: 'NOAA 9', 202: 'NOAA 10', 203: 'NOAA 11', 204: 'NOAA 12', 205: 'NOAA 14',
    206: 'NOAA 15', 207: 'NOAA 16', 208: 'NOAA 17', 209: 'NOAA 18', 220: 'LANDSAT 5', 221: 'LANDSAT 4',
    222: 'LANDSAT 7', 223: 'NOAA 19', 224: 'NPP', 225: 'NOAA 20', 226: 'NOAA 21', 240: 'DMSP 7', 241: 'DMSP 8',
    242: 'DMSP 9', 243: 'DMSP 10', 244: 'DMSP 11', 245: 'DMSP 12', 246: 'DMSP 13', 247: 'DMSP 14', 248: 'DMSP 15',
    249: 'DMSP 16', 250: 'GOES 6', 251: 'GOES 7', 252: 'GOES 8', 253: 'GOES 9', 254: 'GOES 10', 255: 'GOES 11',
    256: 'GOES 12', 257: 'GOES 13', 258: 'GOES 14', 259: 'GOES 15', 260: 'JASON 1', 261: 'JASON 2', 262: 'JASON 3',
    269: 'Spire Lemur 3U CubeSat', 270: 'GOES 16', 271: 'GOES 17', 272: 'GOES 18', 273: 'GOES 19', 281: 'QUIKSCAT',
    282: 'TRMM', 283: 'CORIOLIS', 285: 'DMSP 17', 286: 'DMSP 18', 287: 'DMSP 19', 288: 'GPM-core',
    289: 'Orbiting Carbon Observatory – 2 (OCO-2, NASA)', 310: 'GOMS 1', 311: 'GOMS 2', 320: 'METEOR 2-21',
    321: 'METEOR 3-5', 322: 'METEOR 3M-1', 323: 'METEOR 3M-2', 341: 'RESURS 01-4', 410: 'KALPANA-1', 421: 'Oceansat-2',
    422: 'ScatSat-1', 423: 'Oceansat-3', 430: 'INSAT 1B', 431: 'INSAT 1C', 432: 'INSAT 1D', 440: 'Megha-Tropiques',
    441: 'SARAL', 450: 'INSAT 2A', 451: 'INSAT 2B', 452: 'INSAT 2E', 470: 'INSAT 3A', 471: 'INSAT 3D', 472: 'INSAT 3E',
    473: 'INSAT 3DR', 474: 'INSAT 3DS', 500: 'FY-1C', 501: 'FY-1D', 502: 'Hai Yang 2A (HY-2A, SOA/NSOAS China)',
    503: 'Hai Yang 2B (HY-2B, SOA/NSOAS China)', 510: 'FY-2', 512: 'FY-2B', 513: 'FY-2C', 514: 'FY-2D', 515: 'FY-2E',
    516: 'FY-2F', 517: 'FY-2G', 520: 'FY-3A', 521: 'FY-3B', 522: 'FY-3C', 523: 'FY-3D', 524: 'FY-3E', 530: 'FY-4A',
    700: 'TIROS M (ITOS 1)', 701: 'NOAA 1', 702: 'NOAA 2', 703: 'NOAA 3', 704: 'NOAA 4', 705: 'NOAA 5', 706: 'NOAA 6',
    707: 'NOAA 7', 708: 'TIROS-N', 710: 'GOES (SMS 1)', 711: 'GOES (SMS 2)', 720: 'TOPEX',
    721: 'GFO (GEOSAT follow on)', 722: 'GRACE A', 723: 'GRACE B', 724: 'COSMIC-2 P1', 725: 'COSMIC-2 P2',
    726: 'COSMIC-2 P3', 727: 'COSMIC-2 P4', 728: 'COSMIC-2 P5', 729: 'COSMIC-2 P6', 731: 'GOES 1', 732: 'GOES 2',
    733: 'GOES 3', 734: 'GOES 4', 735: 'GOES 5', 740: 'COSMIC-1', 741: 'COSMIC-2', 742: 'COSMIC-3', 743: 'COSMIC-4',
    744: 'COSMIC-5', 745: 'COSMIC-6', 750: 'COSMIC-2 E1', 751: 'COSMIC-2 E2', 752: 'COSMIC-2 E3', 753: 'COSMIC-2 E4',
    754: 'COSMIC-2 E5', 755: 'COSMIC-2 E6', 763: 'NIMBUS 3', 764: 'NIMBUS 4', 765: 'NIMBUS 5', 766: 'NIMBUS 6',
    767: 'NIMBUS 7', 780: 'ERBS', 781: 'UARS', 782: 'EARTH PROBE', 783: 'TERRA', 784: 'AQUA', 785: 'AURA',
    786: 'C/NOFS', 787: 'CALIPSO', 788: 'CloudSat', 800: 'SUNSAT', 801: 'International Space Station (ISS)',
    802: 'CFOSAT', 803: 'GRACE C (GRACE-FO)', 804: 'GRACE D (GRACE-FO)', 810: 'COMS-1', 811: 'GEO-KOMPSAT-2A',
    812: 'SCISAT-1', 813: 'ODIN', 820: 'SAC-C', 821: 'SAC-D', 825: 'KOMPSAT-5', 850: 'Combination of TERRA and AQUA',
    851: 'Combination of NOAA 16 to NOAA 19', 852: 'Combination of Metop-1 to Metop-3',
    853: 'Combination of METEOSAT and DMSP',
    854: 'Non-specific mixture of geostationary and low Earth-orbiting satellites',
    855: 'Combination of INSAT 3D and INSAT 3DR',
};
export const INSTRUMENT_NAMES = { 203: 'MHS', 221: 'IASI', 570: 'AMSU-A', 591: 'AVHRR/3', 616: 'VIIRS', 620: 'CrIS', 621: 'ATMS' };

// Satellite pages in OSCAR/Space (space.oscar.wmo.int/satellites/view/<slug>).
// Most slugs follow from the name (see satelliteOscarUrl); these are the WMO
// identifiers whose slug doesn't, checked against OSCAR's satellites.json.
// Null: OSCAR has no page (combinations, or satellites it doesn't list)
const range = (from, to, slug) => Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [from + i, slug(from + i)]));
const OSCAR_SLUGS = {
    3: 'metop_b', 4: 'metop_a', 5: 'metop_c', 20: 'spot_1', 21: 'spot_2', 22: 'spot_3', 23: 'spot_4', 40: null, 44: 'seosar_paz',
    121: 'adeos_2', 122: 'gcom_w', 150: 'himawari_3_gms_3', 151: 'himawari_4_gms_4', 152: 'himawari_5_gms_5',
    153: 'himawari_1_gms_1', 154: 'himawari_2_gms_2', 171: 'himawari_6_mtsat_1r', 172: 'himawari_7_mtsat_2', 224: 'snpp',
    // DMSP 7 to 16 (240-249) and 17 to 19 (285-287) are OSCAR's DMSP-F07 to F19
    ...range(240, 249, (id) => `dmsp_f${String(id - 233).padStart(2, '0')}`),
    ...range(285, 287, (id) => `dmsp_f${id - 268}`),
    258: 'ews_g3_formerly_goes_14', 269: null, 288: 'gpm_core_observatory', 289: 'oco_2', 310: 'electro_goms', 311: null,
    322: 'meteor_3m', 323: null, 341: 'resurs_o1_4', 423: 'oceansat_3_eos_06', 472: null, 502: 'hy_2a', 503: 'hy_2b',
    510: null, 700: 'itos_1_tiros_m', 710: 'sms_1', 711: 'sms_2', 720: 'topex_poseidon', 721: 'gfo',
    // COSMIC-2's twelve (724-729, 750-755) share one page; 740-745 are the six of the first COSMIC
    ...range(724, 729, () => 'cosmic_2'), ...range(750, 755, () => 'cosmic_2'), ...range(740, 745, () => 'cosmic_1'),
    782: 'toms_earth_probe', 786: 'c_nofs', 800: null, 801: null, 810: 'coms', ...range(850, 855, () => null),
};

// The OSCAR/Space page of a satellite, by WMO identifier (BUFR 0 01 007) or by name
// (the table's, or a WIS2 topic's). OSCAR's slugs are mostly the name in lowercase
// ASCII letters and digits, runs of spaces and hyphens as underscores. Null if none
export function satelliteOscarUrl(number, name) {
    var id = number;
    if (id === null && name) {
        var match = Object.keys(SATELLITE_NAMES).find((key) => SATELLITE_NAMES[key] === name);
        if (match) id = Number(match);
    }
    if (id !== null && id in OSCAR_SLUGS) return OSCAR_SLUGS[id] && `https://space.oscar.wmo.int/satellites/view/${OSCAR_SLUGS[id]}`;

    var acronym = String(name || '').trim();

    // Only generate a catalogue link for a satellite acronym already recognised by
    // this table or by a WIS2 topic name. Unknown numeric satellites stay plain text.
    if (!acronym || (number !== null && !SATELLITE_NAMES[number])) return null;

    acronym = acronym
        .normalize('NFKD')
        .replace(/[^\x00-\x7f]/g, '')
        .replace(/[^a-zA-Z0-9 -]/g, '')
        .replace(/[ -]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
    return acronym ? `https://space.oscar.wmo.int/satellites/view/${acronym}` : null;
}
// Code table 0 02 023: which channel cloud-motion winds were tracked in
export const AMV_METHODS = { 1: 'Infrared', 2: 'Visible', 3: 'Water vapour (cloud)', 4: 'Several channels', 5: 'Water vapour (clear air)',
    6: 'Ozone', 7: 'Water vapour' };
// Code table 0 08 072
export const PIXEL_TYPES = { 0: 'Mixed', 1: 'Clear', 2: 'Cloudy', 3: 'Probably clear', 4: 'Probably cloudy', 5: 'Ash' };

// The table's name for a satellite named another way, e.g. in a WIS2 topic
// ("metop-b", "noaa-20", "geo-kompsat-2a"): case, spaces and dashes aside, it matches
// a name or the one in its brackets ("METOP-1 (Metop-B)"). Null if none does
const plain = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const BY_PLAIN_NAME = new Map(Object.values(SATELLITE_NAMES).flatMap((name) => {
    var inBrackets = /\(([^)]+)\)/.exec(name);
    return [[plain(name), name], ...(inBrackets ? [[plain(inBrackets[1]), name]] : [])];
}));
export function satelliteNamed(name) {
    return BY_PLAIN_NAME.get(plain(name)) || null;
}
