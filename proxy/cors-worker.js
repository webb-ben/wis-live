// A CORS proxy for the servers that send no CORS headers (global caches such as DWD's and
// KMA's, ECCC's dd.weather.gc.ca, WMO's code lists), so WIS 2.0 Live's pages can download
// their files in the browser. A Cloudflare Worker:
//
//   GET https://<worker>/?url=<the file's URL, encoded>
//
// It only fetches from the hosts in ALLOWED_HOSTS (over HTTPS), so it isn't an open proxy:
// the same list the local dev and preview servers proxy (src/data/localProxyHosts.js, which
// wrangler bundles in). It passes the file through with Access-Control-Allow-Origin added for
// the pages' origins, and a Range request through as one (206, Content-Range: GRIB headers
// and single fields are read that way). Whole files are kept at Cloudflare's edge for an
// hour: a cache's file doesn't change, and many viewers ask for the same ones.
//
// Deploy from this folder: npx wrangler login (once), npx wrangler deploy; then set
// CORS_PROXY in src/data/caches.js to the address it prints.
import { LOCAL_PROXY_HOSTS } from '../src/data/localProxyHosts.js';

const ALLOWED_HOSTS = LOCAL_PROXY_HOSTS;

// The pages' origins: the site, and the local dev and preview servers
const ALLOWED_ORIGINS = ['https://benwebb.com', 'http://localhost:5173', 'http://localhost:4173'];

const EDGE_CACHE_SECONDS = 3600;

export default {
    async fetch(request) {
        const origin = request.headers.get('Origin') || '';
        const cors = {
            'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
            // So the page can read how much of a file a range response holds
            'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
            'Vary': 'Origin',
        };
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD',
                'Access-Control-Allow-Headers': 'Range', 'Access-Control-Max-Age': '86400' } });
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return new Response('Only GET and HEAD', { status: 405, headers: cors });
        }
        let target;
        try {
            target = new URL(new URL(request.url).searchParams.get('url'));
        } catch (err) {
            return new Response('Give the file as ?url=', { status: 400, headers: cors });
        }
        if (target.protocol !== 'https:' || !ALLOWED_HOSTS.includes(target.hostname)) {
            return new Response('Not a host this proxy fetches from', { status: 403, headers: cors });
        }
        // A range is asked of the server as it is, and not kept at the edge (that would fetch
        // the whole file first: a GRIB file can run to gigabytes); a whole file is kept an hour
        const range = request.headers.get('Range');
        let upstream;
        try {
            upstream = await fetch(target, range
                ? { method: request.method, headers: { Range: range } }
                : { method: request.method, cf: { cacheEverything: true, cacheTtl: EDGE_CACHE_SECONDS } });
        } catch (err) {
            return new Response(`Could not reach ${target.hostname}`, { status: 502, headers: cors });
        }
        const headers = new Headers(upstream.headers);
        for (const [name, value] of Object.entries(cors)) headers.set(name, value);
        headers.delete('Set-Cookie');
        return new Response(upstream.body, { status: upstream.status, headers });
    },
};
