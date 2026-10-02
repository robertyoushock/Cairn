import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseMapsLink, greatCircle, distanceKm, pickAirport, planFlight, buildRoute, roadLeg, prettyDistance, prettyDuration } from '../js/routes.js';
import { geojsonToGpx } from '../js/convert.js';

const airports = JSON.parse(fs.readFileSync(new URL('../data/airports.json', import.meta.url))).airports;
assert.ok(airports.length > 300);
const DEN = [-104.9903, 39.7392];
const BOS = [-71.0589, 42.3601];
const CAPE = [-70.156, 41.689]; // South Dennis, MA

// ---- geometry ----
assert.ok(Math.abs(distanceKm(DEN, BOS) - 2840) < 40, 'Denver to Boston is about 2,840 km');
const arc = greatCircle(DEN, BOS, 32);
assert.equal(arc.length, 33);
assert.ok(Math.abs(arc[0][0] - DEN[0]) < 1e-5 && Math.abs(arc.at(-1)[1] - BOS[1]) < 1e-5);
assert.ok(arc[16][1] > 42 && Math.max(...arc.map((c) => c[1])) > 42.6, 'the arc bows north of a straight line (which would be 41.05 at the middle)');

// ---- airports ----
assert.equal(pickAirport(DEN, airports).code, 'DEN');
assert.equal(pickAirport(BOS, airports).code, 'BOS');
assert.equal(pickAirport(CAPE, airports).code, 'BOS', 'a major airport beats the small local one');
assert.equal(pickAirport([-110.36, 46.6], airports).big, false, 'rural Montana still gets its regional airport');
assert.equal(planFlight(DEN, BOS, airports).to.code, 'BOS');
assert.throws(() => planFlight(DEN, [-105.27, 40.01], airports), /close enough to drive/);

// ---- formatting ----
assert.equal(prettyDistance(100), '328 ft');
assert.equal(prettyDistance(5000), '3.1 mi');
assert.equal(prettyDistance(500000), '311 mi');
assert.equal(prettyDuration(1500), '25 min');
assert.equal(prettyDuration(7500), '2 hr 5 min');

// ---- Google Maps links ----
let p = parseMapsLink('https://www.google.com/maps/dir/1437+Bannock+St,+Denver,+CO+80202/Boulder,+CO/@39.87,-105.2,10z/data=!3m1!4b1!4m14!4m13!1m5!1m1!1s0x876c78d!2m2!1d-104.9909!2d39.7391!1m5!1m1!1s0x876b8d!2m2!1d-105.2705!2d40.015!3e1');
assert.equal(p.mode, 'bike');
assert.deepEqual(p.stops.map((s) => s.label), ['1437 Bannock St', 'Boulder']);
assert.deepEqual([p.stops[0].lng, p.stops[0].lat], [-104.9909, 39.7391], 'exact coordinates come from the data blob');
p = parseMapsLink('https://www.google.com/maps/dir/39.7392,-104.9903/Red+Rocks+Amphitheatre/Golden,+CO');
assert.equal(p.stops.length, 3);
assert.deepEqual([p.stops[0].lat, p.stops[0].lng], [39.7392, -104.9903]);
assert.equal(p.stops[1].text, 'Red Rocks Amphitheatre');
assert.equal(p.mode, 'car');
p = parseMapsLink('https://www.google.com/maps/dir/?api=1&origin=Denver%2C+CO&destination=Boulder%2C+CO&waypoints=Golden%2C+CO%7CLouisville%2C+CO&travelmode=walking');
assert.deepEqual(p.stops.map((s) => s.label), ['Denver', 'Golden', 'Louisville', 'Boulder']);
assert.equal(p.mode, 'walk');
p = parseMapsLink('https://maps.google.com/maps?saddr=Denver,+CO&daddr=Golden,+CO+to:Boulder,+CO&dirflg=b');
assert.deepEqual(p.stops.map((s) => s.label), ['Denver', 'Golden', 'Boulder']);
assert.equal(p.mode, 'bike');
assert.deepEqual(parseMapsLink('https://maps.app.goo.gl/AbC123xyz'), { short: true, url: 'https://maps.app.goo.gl/AbC123xyz' });
assert.throws(() => parseMapsLink('https://www.google.com/maps/place/Denver,+CO/@39.7,-104.9,11z'), /place, not directions/);
assert.throws(() => parseMapsLink('https://www.google.com/maps/dir//Boulder,+CO/'), /only one stop/);
assert.throws(() => parseMapsLink('https://example.com/maps/dir/A/B'), /not a Google Maps link/);
assert.throws(() => parseMapsLink('hello'), /does not look like a link/);

// ---- directions, with fake servers ----
const calls = [];
const realFetch = globalThis.fetch;
const ok = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  calls.push(u);
  if (u.includes('relay.example/route')) {
    const b = JSON.parse(init.body);
    if (b.points.length === 99) return ok({ error: 'nope' }, 503);
    return ok({ features: [{ geometry: { type: 'LineString', coordinates: b.points.map((p) => [...p, 1600]) }, properties: { summary: { distance: 45000, duration: 2400 } } }] });
  }
  if (u.includes('routing.openstreetmap.de')) {
    if (u.includes('routed-foot') && u.includes('0.000000,0.000000')) return ok({ code: 'NoRoute' });
    const pts = u.split('/driving/')[1].split('?')[0].split(';').map((s) => s.split(',').map(Number));
    return ok({ code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: pts }, distance: 45184, duration: 2500 }] });
  }
  throw new Error('unexpected ' + u);
};

let leg = await roadLeg([DEN, [-105.27, 40.01]], 'bike');
assert.equal(leg.provider, 'OSRM (FOSSGIS)');
assert.match(calls.at(-1), /routed-bike\/route\/v1\/driving\/-104\.990300,39\.739200;-105\.270000,40\.010000\?overview=full/);
leg = await roadLeg([DEN, [-105.27, 40.01]], 'car', { relay: 'https://relay.example/' });
assert.equal(leg.provider, 'OpenRouteService');
assert.equal(leg.coordinates[0].length, 2, 'elevation is dropped so files stay small');
await assert.rejects(() => roadLeg([[0, 0], [1, 1]], 'walk'), /No route found/);
await assert.rejects(() => roadLeg([DEN], 'car'), /at least two/);

const stops = [{ lng: DEN[0], lat: DEN[1], label: 'Denver' }, { lng: -105.22, lat: 39.75, label: 'Golden' }, { lng: -105.27, lat: 40.01, label: 'Boulder' }];
let r = await buildRoute(stops, 'car');
assert.equal(r.features.length, 1);
assert.equal(r.features[0].properties.name, 'Drive: Denver to Boulder (28 mi)');
assert.equal(r.features[0].geometry.coordinates.length, 3, 'all stops are routed through');
assert.match(r.summary, /^Drive: 28 mi, about 42 min$/);

r = await buildRoute([{ lng: DEN[0], lat: DEN[1], label: 'Denver' }, { lng: CAPE[0], lat: CAPE[1], label: 'South Dennis' }], 'plane', { airports });
assert.equal(r.features.length, 3);
assert.match(r.features[0].properties.name, /^Drive: Denver to DEN/);
assert.match(r.features[1].properties.name, /^Fly: DEN to (HYA|BOS|PVD) \(1,7\d\d mi\)$/);
assert.equal(r.features[1].geometry.coordinates.length, 65);
assert.match(r.features[2].properties.name, /to South Dennis/);
assert.match(r.summary, /fly 1,7\d\d mi/);
await assert.rejects(() => buildRoute(stops, 'plane', { airports }), /close enough to drive/);

// a route exports to GPX as a track
const gpx = geojsonToGpx({ features: r.features }, 'trip');
assert.equal((gpx.match(/<trk>/g) || []).length, 3);
assert.match(gpx, /<name>Fly: DEN to/);

globalThis.fetch = realFetch;
console.log('route checks passed');
