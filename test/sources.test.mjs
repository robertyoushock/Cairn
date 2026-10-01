import assert from 'node:assert/strict';
import { queryBoundaries, identifyAt, decorate, searchPlaces, cleanAddress, inspectUrl } from '../js/sources.js';

const calls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const body = init?.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
  calls.push({ u, body });
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  if (u.includes('/Legislative/MapServer?f=json'))
    return json({ layers: [
      { id: 0, name: '120th Congressional Districts', parentLayerId: -1, type: 'Feature Layer', maxScale: 1001 },
      { id: 1, name: '2026 State Legislative Districts - Upper', parentLayerId: -1, type: 'Feature Layer', maxScale: 1001 },
      { id: 2, name: '2026 State Legislative Districts - Lower', parentLayerId: -1, type: 'Feature Layer', maxScale: 1001 },
      { id: 6, name: '2024 State Legislative Districts - Lower', parentLayerId: 3, type: 'Feature Layer', maxScale: 1001 },
    ] });
  if (u.includes('/Legislative/MapServer/0?f=json')) return json({ fields: [{ name: 'CD120' }, { name: 'CDSESSN' }, { name: 'STATE' }] });
  if (u.includes('/Legislative/MapServer/2?f=json')) return json({ fields: [{ name: 'SLDL' }, { name: 'STATE' }] });
  if (u.includes('/Legislative/MapServer/1?f=json')) return json({ fields: [{ name: 'SLDU' }, { name: 'STATE' }] });
  if (u.includes('/State_County/MapServer?f=json'))
    return json({ layers: [
      { id: 0, name: 'States', parentLayerId: -1, type: 'Feature Layer', maxScale: 1001 },
      { id: 1, name: 'Counties', parentLayerId: -1, type: 'Feature Layer', maxScale: 1001 },
      { id: 3, name: 'Counties', parentLayerId: -1, type: 'Feature Layer', maxScale: 42001 },
    ] });
  if (u.includes('/State_County/MapServer/1?f=json')) return json({ fields: [{ name: 'BASENAME' }, { name: 'STATE' }] });
  if (u.includes('PUMA_TAD_TAZ_UGA_ZCTA/MapServer?f=json'))
    return json({ layers: [{ id: 1, name: '2020 Census ZIP Code Tabulation Areas', parentLayerId: -1, type: 'Feature Layer', maxScale: 1001 }] });
  if (u.includes('PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1?f=json')) return json({ fields: [{ name: 'GEOID' }] });
  if (u.endsWith('/query'))
    return json({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { GEOID: '80202', NAME: 'ZCTA5 80202' }, geometry: null }] });
  throw new Error('unexpected ' + u);
};

const last = () => calls.filter((c) => c.u.endsWith('/query')).at(-1).body;

await queryBoundaries({ type: 'zip', input: '80202, 802*', state: '', bbox: null });
assert.equal(last().where, "GEOID IN ('80202') OR GEOID LIKE '802%'");
assert.ok(!last().outFields.includes('*') && last().outFields.includes('GEOID'));

await assert.rejects(() => queryBoundaries({ type: 'zip', input: "80202'; drop", state: '', bbox: null }), /not a ZIP code/);
await assert.rejects(() => queryBoundaries({ type: 'zip', input: '', state: '', bbox: null }), /at least one ZIP/);

const r = await queryBoundaries({ type: 'sldl', input: '1, 18', state: '08', bbox: null });
assert.equal(last().where, "STATE = '08' AND SLDL IN ('001','018')");
assert.equal(r.fc.features[0].properties.name, 'ZCTA5 80202');

await queryBoundaries({ type: 'cd', input: '1', state: '08', bbox: null });
assert.equal(last().where, "STATE = '08' AND CD120 IN ('01')");

await queryBoundaries({ type: 'county', input: "Denver County, O'Brien", state: '08', bbox: null });
assert.match(last().where, /UPPER\(BASENAME\) LIKE 'DENVER%'/);
assert.match(last().where, /'O''BRIEN%'/);
assert.ok(calls.some((c) => c.u.includes('/State_County/MapServer/1?f=json')), 'picked the most detailed county layer');

await queryBoundaries({ type: 'sldu', input: '', state: '08', bbox: [-105, 39, -104, 40] });
assert.equal(last().where, "STATE = '08'");
assert.equal(last().geometry, '-105,39,-104,40');


// decorate: friendly names and stable keys
const z = decorate('zip', { properties: { GEOID: '80202' } });
assert.equal(z.properties.name, 'ZIP 80202');
assert.equal(z.properties._key, 'zip:80202');
assert.equal(decorate('county', { properties: { GEOID: '08031', NAME: 'Denver County' } }).properties.name, 'Denver County');

// identifyAt: one point query per Census layer, tolerant of a layer failing
const before = calls.length;
const id = await identifyAt(-104.99, 39.74);
const pointCalls = calls.slice(before).filter((c) => c.u.endsWith('/query'));
assert.equal(pointCalls.length, 5);
assert.ok(pointCalls.every((c) => c.body.geometryType === 'esriGeometryPoint' && c.body.geometry === '-104.99,39.74'));
assert.equal(id.failed, 0);
assert.ok(id.features.length >= 1 && id.features.every((f) => f.properties._key));

// place search: bbox order is converted to [west, south, east, north]
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [{ display_name: 'Denver', lat: '39.74', lon: '-104.99', boundingbox: ['39.6', '39.9', '-105.1', '-104.6'] }] });
const places = await searchPlaces('denver');
assert.deepEqual(places[0].bbox, [-105.1, 39.6, -104.6, 39.9]);
globalThis.fetch = realFetch;

// unit numbers are stripped so geocoders can find the building
assert.equal(cleanAddress('18 Sea Grass Cir #18, South Dennis, MA 02660'), '18 Sea Grass Cir, South Dennis, MA 02660');
assert.equal(cleanAddress('500 Main St Apt 4B, Denver, CO'), '500 Main St, Denver, CO');
assert.equal(cleanAddress('1437 Bannock St, Denver'), '1437 Bannock St, Denver');

await assert.rejects(() => inspectUrl('javascript:alert(1)'), /https/);

console.log('all source checks passed');
