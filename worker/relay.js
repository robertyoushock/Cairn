// Cairn's one small helper on Cloudflare Workers (free plan). It does four things a web page cannot do alone:
//   GET  /?url=…        fetch an allowlisted public dataset that blocks browser downloads (DeFlock cameras)
//   POST /route         ask OpenRouteService for directions, keeping the API key secret
//   GET  /resolve?url=… expand a short Google Maps link (maps.app.goo.gl) to its full address
//   GET  /geocode?q=…   look up a US street address with the Census Bureau geocoder
//
// STAYING FREE: this Worker must stay on the Workers Free plan. On Free, going over the daily request
// allowance makes requests fail; it never bills. Do not attach a paid plan, KV, D1, R2 or Durable Objects.
// It is not an open proxy: only the hosts and sites listed below work, and each visitor is rate limited.

export const ALLOWED_HOSTS = ['data.dontgetflocked.com'];
export const ALLOWED_ORIGINS = [
  'https://robertyoushock.com',
  'https://www.robertyoushock.com',
  'https://maps.robertyoushock.com',
  'https://robertyoushock.github.io',
  'http://localhost:3000',
  'http://localhost:8000',
];
export const PROFILES = { car: 'driving-car', bike: 'cycling-regular', walk: 'foot-walking' };
export const MAX_ROUTE_POINTS = 25;
const SHORT_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl)$/;
const MAPS_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl|maps\.google\.com|www\.google\.com|google\.com)$/;

export function checkRequest(requestUrl, origin) {
  const u = new URL(requestUrl);
  const target = u.searchParams.get('url');
  if (!target) return { ok: false, status: 400, message: 'Missing ?url=' };
  let t;
  try { t = new URL(target); } catch { return { ok: false, status: 400, message: 'Bad url' }; }
  if (t.protocol !== 'https:') return { ok: false, status: 400, message: 'https only' };
  if (!ALLOWED_HOSTS.includes(t.hostname)) return { ok: false, status: 403, message: 'Host not allowed' };
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return { ok: false, status: 403, message: 'Origin not allowed' };
  return { ok: true, target: t.toString() };
}

// Validate a routing request before spending any of the daily OpenRouteService allowance on it.
export function checkRoute(body) {
  if (!body || typeof body !== 'object') return { ok: false, message: 'Send JSON' };
  const profile = PROFILES[body.mode];
  if (!profile) return { ok: false, message: 'mode must be car, bike or walk' };
  const pts = body.points;
  if (!Array.isArray(pts) || pts.length < 2) return { ok: false, message: 'Need at least two points' };
  if (pts.length > MAX_ROUTE_POINTS) return { ok: false, message: `At most ${MAX_ROUTE_POINTS} points` };
  for (const p of pts) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) {
      return { ok: false, message: 'Each point must be [longitude, latitude]' };
    }
  }
  return { ok: true, profile, coordinates: pts.map((p) => [Number(p[0].toFixed(6)), Number(p[1].toFixed(6))]) };
}

export function checkMapsLink(raw) {
  let t;
  try { t = new URL(raw); } catch { return { ok: false, message: 'Bad url' }; }
  if (t.protocol !== 'https:' || !MAPS_HOSTS.test(t.hostname)) return { ok: false, message: 'Only Google Maps links can be expanded' };
  return { ok: true, target: t.toString() };
}

// Best-effort limit per visitor. Memory is per Worker instance, so this slows abuse rather than stopping it;
// the hard stops are the free plan's daily request cap and OpenRouteService's own daily quota.
const hits = new Map();
export function allow(ip, now = Date.now(), limit = 40, windowMs = 60000) {
  const rec = hits.get(ip);
  if (!rec || now - rec.start > windowMs) { hits.set(ip, { start: now, n: 1 }); return true; }
  rec.n += 1;
  if (hits.size > 5000) hits.clear();
  return rec.n <= limit;
}

const json = (obj, status, cors) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export default {
  async fetch(request, env = {}) {
    const origin = request.headers.get('Origin');
    const okOrigin = origin && ALLOWED_ORIGINS.includes(origin);
    const cors = { 'Access-Control-Allow-Origin': okOrigin ? origin : ALLOWED_ORIGINS[0], Vary: 'Origin' };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
    }
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, routing: Boolean(env.ORS_KEY) }, 200, cors);
    if (origin && !okOrigin) return json({ error: 'Origin not allowed' }, 403, cors);
    if (!allow(request.headers.get('CF-Connecting-IP') || 'unknown')) return json({ error: 'Too many requests. Wait a minute and try again.' }, 429, cors);

    try {
      if (url.pathname === '/route') {
        if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
        if (!okOrigin) return json({ error: 'Origin required' }, 403, cors);
        if (!env.ORS_KEY) return json({ error: 'Routing is not set up yet (no OpenRouteService key).' }, 503, cors);
        const check = checkRoute(await request.json().catch(() => null));
        if (!check.ok) return json({ error: check.message }, 400, cors);
        const up = await fetch(`https://api.openrouteservice.org/v2/directions/${check.profile}/geojson`, {
          method: 'POST',
          headers: { Authorization: env.ORS_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ coordinates: check.coordinates, instructions: false }),
        });
        const text = await up.text();
        if (up.status === 429 || up.status === 403) return json({ error: 'The free daily routing allowance is used up. Try again tomorrow.' }, 429, cors);
        return new Response(text, { status: up.status, headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/resolve') {
        const check = checkMapsLink(url.searchParams.get('url') || '');
        if (!check.ok) return json({ error: check.message }, 400, cors);
        // Only short links are followed. A full google.com address is returned as it is, because Google
        // answers automated requests for those with a robot check page.
        let target = check.target;
        for (let i = 0; i < 3 && SHORT_HOSTS.test(new URL(target).hostname); i++) {
          const r = await fetch(target, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Cairn)' } });
          const next = r.headers.get('Location');
          if (r.status < 300 || r.status >= 400 || !next) return json({ error: 'That short link could not be opened.' }, 502, cors);
          const step = checkMapsLink(new URL(next, target).toString());
          if (!step.ok || step.target.includes('/sorry/')) return json({ error: 'That short link could not be opened.' }, 502, cors);
          target = step.target;
        }
        return json({ url: target }, 200, cors);
      }

      if (url.pathname === '/geocode') {
        const q = (url.searchParams.get('q') || '').slice(0, 200);
        if (!q) return json({ error: 'Missing ?q=' }, 400, cors);
        const p = new URLSearchParams({ address: q, benchmark: 'Public_AR_Current', format: 'json' });
        const up = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${p}`, { cf: { cacheTtl: 86400, cacheEverything: true } });
        return new Response(await up.text(), { status: up.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' } });
      }

      const check = checkRequest(request.url, origin);
      if (!check.ok) return new Response(check.message, { status: check.status, headers: cors });
      const upstream = await fetch(check.target, { cf: { cacheTtl: 3600, cacheEverything: true } });
      // Pass bytes through untouched, including gzip, so the browser does the decompressing.
      const headers = new Headers(cors);
      headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
      headers.set('Cache-Control', 'public, max-age=3600');
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (e) {
      return json({ error: 'The relay could not reach that service.' }, 502, cors);
    }
  },
};
