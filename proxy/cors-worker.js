// A CORS proxy for the WIS2 global caches that send no CORS headers, so WIS 2.0 Live's
// pages can download their copies of a file in the browser. A Cloudflare Worker:
//
//   GET https://<worker>/?url=<the cache's file URL, encoded>
//
// It only fetches from the global caches in ALLOWED_HOSTS (over HTTPS), so it isn't an
// open proxy, and passes the file through with Access-Control-Allow-Origin added for
// the pages' origins. Files are kept at Cloudflare's edge for an hour: a cache's file
// doesn't change, and many viewers ask for the same ones. Deploy with `npx wrangler
// deploy` in this folder (wrangler.toml), then set CORS_PROXY in src/data/caches.js.

// The same list as PROXY_HOSTS in src/data/caches.js
const ALLOWED_HOSTS = [
    'wis2.dwd.de',
    'gisc.dwd.de',
    'wis2data.kma.go.kr',
    'gc.wis.cma.cn',
    'wis2.ncm.gov.sa',
    'wis2node.globaldata.nws.noaa.gov',
];

// The pages' origins: the site, and the local dev and preview servers
const ALLOWED_ORIGINS = ['https://benwebb.com', 'http://localhost:5173', 'http://localhost:4173'];

const EDGE_CACHE_SECONDS = 3600;

export default {
    async fetch(request) {
        const origin = request.headers.get('Origin') || '';
        const cors = {
            'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
            'Vary': 'Origin',
        };
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Max-Age': '86400' } });
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
            return new Response('Not a global cache this proxy fetches from', { status: 403, headers: cors });
        }
        let upstream;
        try {
            upstream = await fetch(target, {
                method: request.method,
                cf: { cacheEverything: true, cacheTtl: EDGE_CACHE_SECONDS },
            });
        } catch (err) {
            return new Response(`Could not reach ${target.hostname}`, { status: 502, headers: cors });
        }
        const headers = new Headers(upstream.headers);
        for (const [name, value] of Object.entries(cors)) headers.set(name, value);
        headers.delete('Set-Cookie');
        return new Response(upstream.body, { status: upstream.status, headers });
    },
};
