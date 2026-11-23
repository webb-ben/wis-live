// Download hosts in WIS2 notifications that send no CORS headers, so a browser can't
// read their files: global caches and centres' own servers (checked 2026-11-23, from
// 90 seconds of notifications on both channels). The local dev and preview servers
// pass them through at /wis-live/proxy/<host>/… (vite.config.js), and the app uses that
// address on localhost (viaProxy, caches.js). GitHub Pages can't; see proxy/ for that
export const LOCAL_PROXY_HOSTS = [
    // Global caches
    'wis2.dwd.de',
    'gisc.dwd.de',
    'wis2data.kma.go.kr',
    'gc.wis.cma.cn',
    'wis2.ncm.gov.sa',
    // Centres' own servers (origin)
    'dd.weather.gc.ca',
    'dd1.weather.gc.ca',
    'dd2.weather.gc.ca',
    'wis2node.globaldata.nws.noaa.gov',
    'service.meteoswiss.ch',
    'wis2data.eumetsat.int',
    'wis2nc.meteo.fr',
    'wis2-datastore.mss.metoffice.cloud',
    // WMO's code lists: their CORS header names whichever page asked before (see loadCentres)
    'codes.wmo.int',
];
