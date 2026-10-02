import assert from 'node:assert/strict';
import worker, { checkRequest, checkRoute, checkMapsLink, allow, ALLOWED_ORIGINS } from '../worker/relay.js';
const mk = (u) => `https://r.example/?url=${encodeURIComponent(u)}`;
const SITE = 'https://www.robertyoushock.com';
assert.ok(ALLOWED_ORIGINS.includes(SITE), 'the live site is served from www');
assert.equal(checkRequest(mk('https://data.dontgetflocked.com/cameras.geojson.gz'), 'https://robertyoushock.com').ok, true);
assert.equal(checkRequest(mk('https://evil.example/x'), null).status, 403);
assert.equal(checkRequest(mk('http://data.dontgetflocked.com/x'), null).status, 400);
assert.equal(checkRequest('https://r.example/', null).status, 400);
assert.equal(checkRequest(mk('https://data.dontgetflocked.com/x'), 'https://evil.example').status, 403);

// routing input is validated before any quota is spent
assert.equal(checkRoute({ mode: 'car', points: [[-105, 39.7], [-105.3, 40]] }).profile, 'driving-car');
assert.equal(checkRoute({ mode: 'bike', points: [[-105, 39.7], [-105.3, 40]] }).profile, 'cycling-regular');
assert.equal(checkRoute({ mode: 'plane', points: [[-105, 39.7], [-105.3, 40]] }).ok, false);
assert.equal(checkRoute({ mode: 'car', points: [[-105, 39.7]] }).ok, false);
assert.equal(checkRoute({ mode: 'car', points: [[-105, 139.7], [0, 0]] }).ok, false);
assert.equal(checkRoute({ mode: 'car', points: Array.from({ length: 26 }, () => [0, 0]) }).ok, false);
assert.equal(checkRoute(null).ok, false);

// only Google Maps links are expanded
assert.equal(checkMapsLink('https://maps.app.goo.gl/abc123').ok, true);
assert.equal(checkMapsLink('https://www.google.com/maps/dir/A/B').ok, true);
assert.equal(checkMapsLink('https://evil.example/maps').ok, false);
assert.equal(checkMapsLink('http://maps.app.goo.gl/abc').ok, false);

// rate limit
for (let i = 0; i < 40; i++) assert.equal(allow('1.2.3.4', 1000), true);
assert.equal(allow('1.2.3.4', 1000), false);
assert.equal(allow('1.2.3.4', 1000 + 61000), true, 'window resets');

// end to end with a fake upstream
const realFetch = globalThis.fetch;
let sent = null;
globalThis.fetch = async (u, init) => { sent = { u: String(u), init }; return new Response('{"type":"FeatureCollection","features":[]}', { status: 200 }); };
const req = (path, init = {}) => new Request(`https://r.example${path}`, { ...init, headers: { Origin: SITE, 'CF-Connecting-IP': `9.9.9.${Math.floor(Math.random() * 250)}`, ...(init.headers || {}) } });
const body = JSON.stringify({ mode: 'walk', points: [[-105, 39.7], [-105.3, 40]] });
let r = await worker.fetch(req('/route', { method: 'POST', body }), {});
assert.equal(r.status, 503, 'no key: says so, never calls out');
assert.equal(sent, null);
r = await worker.fetch(req('/route', { method: 'POST', body }), { ORS_KEY: 'secret' });
assert.equal(r.status, 200);
assert.match(sent.u, /foot-walking\/geojson$/);
assert.equal(sent.init.headers.Authorization, 'secret');
assert.equal(r.headers.get('Access-Control-Allow-Origin'), SITE);
assert.ok(!(await r.text()).includes('secret'), 'the key never reaches the browser');
r = await worker.fetch(req('/route', { method: 'POST', body, headers: { Origin: 'https://evil.example' } }), { ORS_KEY: 'secret' });
assert.equal(r.status, 403);
r = await worker.fetch(req('/health'), { ORS_KEY: 'secret' });
assert.deepEqual(await r.json(), { ok: true, routing: true });
// short links are followed one hop; full links are returned untouched
let hops = 0;
globalThis.fetch = async (u) => { hops++; return new Response(null, { status: 302, headers: { Location: 'https://www.google.com/maps/dir/Denver/Boulder' } }); };
r = await worker.fetch(req('/resolve?url=' + encodeURIComponent('https://maps.app.goo.gl/abc')), {});
assert.deepEqual(await r.json(), { url: 'https://www.google.com/maps/dir/Denver/Boulder' });
assert.equal(hops, 1);
r = await worker.fetch(req('/resolve?url=' + encodeURIComponent('https://www.google.com/maps/dir/A/B')), {});
assert.deepEqual(await r.json(), { url: 'https://www.google.com/maps/dir/A/B' });
assert.equal(hops, 1, 'google.com itself is never fetched');
globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: 'https://www.google.com/sorry/index?continue=x' } });
r = await worker.fetch(req('/resolve?url=' + encodeURIComponent('https://maps.app.goo.gl/abc')), {});
assert.equal(r.status, 502, 'a robot-check page is reported, not returned');
globalThis.fetch = realFetch;
console.log('relay checks passed');
