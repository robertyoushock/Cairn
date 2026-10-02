import assert from 'node:assert/strict';
import { queryBoundaries, identifyAt, decorate, searchPlaces, cleanAddress, inspectUrl, PICK_ORDER, fullFeature } from '../js/sources.js';

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
  if (u.includes('/State_County/MapServer/0?f=json')) return json({ fields: [{ name: 'BASENAME' }, { name: 'STATE' }] });
  if (u.includes('/School/MapServer?f=json'))
    return json({ layers: [
      { id: 0, name: 'Unified School Districts', parentLayerId: -1, type: 'Feature Layer', maxScale: 1001 },
      { id: 1, name: 'Secondary School Districts', parentLayerId: -1, type: 'Feature Layer', maxScale: 1001 },
      { id: 2, name: 'Elementary School Districts', parentLayerId: -1, type: 'Feature Layer', maxScale: 1001 },
      { id: 5, name: 'Unified School Districts', parentLayerId: 4, type: 'Feature Layer', maxScale: 1001 },
    ] });
  if (/\/School\/MapServer\/[012]\?f=json/.test(u)) return json({ fields: [{ name: 'BASENAME' }, { name: 'STATE' }] });
  if (u.includes('/Places_CouSub_ConCity_SubMCD/MapServer?f=json'))
    return json({ layers: [{ id: 4, name: 'Incorporated Places', parentLayerId: -1, type: 'Feature Layer', maxScale: 1001 }, { id: 5, name: 'Census Designated Places', parentLayerId: -1, type: 'Feature Layer', maxScale: 1001 }] });
  if (u.includes('/Places_CouSub_ConCity_SubMCD/MapServer/4?f=json')) return json({ fields: [{ name: 'BASENAME' }, { name: 'STATE' }] });
  if (u.includes('/Tracts_Blocks/MapServer?f=json'))
    return json({ layers: [{ id: 0, name: 'Census Tracts', parentLayerId: -1, type: 'Feature Layer', maxScale: 1001 }] });
  if (u.includes('/Tracts_Blocks/MapServer/0?f=json')) return json({ fields: [{ name: 'BASENAME' }, { name: 'STATE' }] });
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

await queryBoundaries({ type: 'place', input: 'Denver, Boulder city', state: '08', bbox: null });
assert.equal(last().where, "STATE = '08' AND (UPPER(BASENAME) LIKE 'DENVER%' OR UPPER(BASENAME) LIKE 'BOULDER%')");
const sdBefore = calls.length;
const sdr = await queryBoundaries({ type: 'school', input: 'Jefferson', state: '08', bbox: null });
assert.equal(last().where, "STATE = '08' AND (UPPER(BASENAME) LIKE '%JEFFERSON%')");
assert.equal(calls.slice(sdBefore).filter((c) => c.u.endsWith("/query")).length, 3, 'unified, secondary and elementary are all asked');
assert.equal(sdr.fc.features.length, 3);
await queryBoundaries({ type: 'tract', input: '34.02', state: '08', bbox: null });
assert.equal(last().where, "STATE = '08' AND BASENAME IN ('34.02')");
await assert.rejects(() => queryBoundaries({ type: 'tract', input: 'abc', state: '08', bbox: null }), /not a tract number/);

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
assert.equal(pointCalls.length, 7);
assert.ok(pointCalls.every((c) => c.body.geometryType === 'esriGeometryPoint' && c.body.geometry === '-104.99,39.74'));
assert.equal(id.failed, 0);
assert.ok(id.features.length >= 1 && id.features.every((f) => f.properties._key));

// right-click menu: every level from tract to state, asked for as rough shapes, upgraded to full when picked
await queryBoundaries({ type: 'state', input: '', state: '08', bbox: null });
assert.equal(last().where, "STATE = '08'");
const pb = calls.length;
const pick = await identifyAt(-104.99, 39.74, { types: PICK_ORDER, generalize: 0.002 });
const pc = calls.slice(pb).filter((c) => c.u.endsWith('/query'));
assert.equal(pc.length, 9);
assert.ok(pc.every((c) => c.body.maxAllowableOffset === '0.002'));
assert.ok(pick.features.every((f) => f.properties._rough && f.properties._url));
const full = await fullFeature(pick.features[0]);
assert.equal(last().where, "GEOID = '80202'");
assert.equal(last().maxAllowableOffset, undefined, 'the picked shape is fetched at full detail');
assert.ok(!full.properties._rough);
assert.equal(await fullFeature(full), full, 'a full shape is left alone');

// place search: bbox order is converted to [west, south, east, north]
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [{ display_name: 'Denver', lat: '39.74', lon: '-104.99', boundingbox: ['39.6', '39.9', '-105.1', '-104.6'] }] });
const places = await searchPlaces('denver');
assert.deepEqual(places[0].bbox, [-105.1, 39.6, -104.6, 39.9]);
// Esri geocoder is tried first and wins when it has a match
globalThis.fetch = async (url) => {
  assert.match(String(url), /geocode\.arcgis\.com/);
  return { ok: true, status: 200, json: async () => ({ candidates: [
    { address: '18 Seagrass Cir, South Dennis, Massachusetts, 02660', score: 99.5, location: { x: -70.155, y: 41.707 }, extent: { xmin: -70.156, ymin: 41.706, xmax: -70.154, ymax: 41.708 } },
    { address: 'Far away', score: 40, location: { x: 0, y: 0 } },
  ] }) };
};
const esri = await searchPlaces('18 Sea Grass Cir #18, South Dennis, MA 02660');
assert.equal(esri.length, 1, 'low-score candidates are dropped');
assert.deepEqual(esri[0].bbox, [-70.156, 41.706, -70.154, 41.708]);

// ...and OpenStreetMap is the fallback when Esri has nothing or fails
globalThis.fetch = async (url) => String(url).includes('arcgis')
  ? { ok: false, status: 500, json: async () => ({}) }
  : { ok: true, status: 200, json: async () => [{ display_name: 'Fallback', lat: '1', lon: '2', boundingbox: ['0', '2', '1', '3'] }] };
assert.equal((await searchPlaces('x'))[0].name, 'Fallback');
globalThis.fetch = realFetch;

// unit numbers are stripped so geocoders can find the building
assert.equal(cleanAddress('18 Sea Grass Cir #18, South Dennis, MA 02660'), '18 Sea Grass Cir, South Dennis, MA 02660');
assert.equal(cleanAddress('500 Main St Apt 4B, Denver, CO'), '500 Main St, Denver, CO');
assert.equal(cleanAddress('1437 Bannock St, Denver'), '1437 Bannock St, Denver');

await assert.rejects(() => inspectUrl('javascript:alert(1)'), /https/);

console.log('all source checks passed');
