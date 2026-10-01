// Optional CORS relay for Cairn. Some public datasets (like DeFlock's camera export) do not allow
// browser downloads from other sites. This tiny Cloudflare Worker fetches an allowlisted URL and
// returns it with the headers a browser needs. It is not an open proxy: only hosts listed below work.

export const ALLOWED_HOSTS = ['data.dontgetflocked.com'];
export const ALLOWED_ORIGINS = ['https://robertyoushock.com', 'https://maps.robertyoushock.com', 'http://localhost:8000'];

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

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin');
    const cors = { 'Access-Control-Allow-Origin': origin || '*', Vary: 'Origin' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    const check = checkRequest(request.url, origin);
    if (!check.ok) return new Response(check.message, { status: check.status, headers: cors });
    const upstream = await fetch(check.target, { cf: { cacheTtl: 3600, cacheEverything: true } });
    // Pass bytes through untouched, including gzip, so the browser does the decompressing.
    const headers = new Headers(cors);
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
    headers.set('Cache-Control', 'public, max-age=3600');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
