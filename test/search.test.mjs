import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseIntent, boundaryResult, findState } from '../js/intent.js';
import { scoreEntry, searchCatalog, tokenize } from '../js/catalog.js';
import { pickLabelFields, scoreCandidate, dedupe, displayTitle, describeCandidate, distanceToBox, sortCandidates, sourceLink } from '../js/vet.js';
import { applyLabels } from '../js/sources.js';

// ---- plain-language intent ----
assert.deepEqual({ ...parseIntent('texas state house'), zips: undefined }, { type: 'sldl', state: '48', zips: undefined, numbers: [] });
assert.equal(parseIntent('Colorado state senate').type, 'sldu');
assert.equal(parseIntent('colorado congressional districts').type, 'cd');
assert.equal(parseIntent('counties in Ohio').state, '39');
assert.equal(parseIntent('80202 80203').type, 'zip');
assert.deepEqual(parseIntent('zip 80202, 80203').zips, ['80202', '80203']);
assert.equal(parseIntent('west virginia state house').state, '54', 'longest state name wins');
assert.equal(parseIntent('virginia counties').state, '51');
assert.equal(parseIntent('wildfires'), null);
assert.equal(parseIntent('fire stations'), null);
assert.equal(findState('what is in or out'), null, 'lowercase "or" is not Oregon');
assert.equal(findState('house districts in OR').fips, '41');
assert.deepEqual(parseIntent('texas state house district 12').numbers, ['12']);

const tx = boundaryResult('texas state house');
assert.equal(tx.kind, 'boundary');
assert.equal(tx.state, '48');
assert.equal(tx.input, '');
assert.match(tx.title, /Texas state house districts/);
assert.equal(boundaryResult('state house').kind, 'boundary-form', 'no state: ask for one');
assert.equal(boundaryResult('zip codes colorado').kind, 'boundary-form', 'whole-state ZIP lists are not possible');
assert.equal(boundaryResult('school districts').kind, 'boundary-form');
assert.equal(boundaryResult('fire stations'), null);
const sd = boundaryResult('school districts colorado');
assert.deepEqual([sd.kind, sd.type, sd.state, sd.input, !!sd.loose], ['boundary', 'school', '08', '', false]);
const bc = boundaryResult('boulder city limits colorado');
assert.deepEqual([bc.type, bc.input, bc.loose], ['place', 'boulder', true]);
assert.equal(boundaryResult('denver city limits').kind, 'boundary-form');
assert.equal(boundaryResult('denver city limits').input, 'denver', 'name is carried into the form');
assert.equal(boundaryResult('census tracts colorado').type, 'tract');
const pj = boundaryResult('parcels jefferson county colorado');
assert.equal(pj.loose, true, 'extra words keep the wider search running');
assert.equal(boundaryResult('counties in Ohio').loose, false);

// ---- catalog search ----
const cat = JSON.parse(fs.readFileSync(new URL('../data/catalog.json', import.meta.url)));
assert.ok(cat.entries.length >= 8);
const ids = (q) => searchCatalog(cat.entries, q).map((e) => e.id);
assert.equal(ids('wildfire')[0].startsWith('nifc-fire'), true);
assert.ok(ids('fires burning now').includes('nifc-fire-perimeters-current'));
assert.equal(ids('earthquakes')[0].startsWith('usgs-earthquakes'), true);
assert.ok(ids('flock cameras').includes('deflock-alpr-cameras'));
assert.ok(ids('license plate readers').includes('deflock-alpr-cameras'));
assert.deepEqual(ids('school districts colorado'), [], 'no false positives');
assert.deepEqual(ids('xyzzy'), []);
assert.ok(ids('wildfire perimeters')[0].includes('perimeters'));
assert.ok(tokenize('The Fires of Colorado').includes('fires'));
// every catalog entry has what the UI needs
for (const e of cat.entries) {
  assert.ok(e.id && e.title && e.agency && e.description && e.url && ['arcgis', 'geojson'].includes(e.type), e.id);
  assert.ok(e.type === 'geojson' ? e.labelField || e.fixedLabel : e.labelField, `${e.id} has an explicit label`);
}

// ---- label field choice: the real NIFC trap ----
const nifcFields = [
  { name: 'OBJECTID', type: 'esriFieldTypeOID' },
  { name: 'IncidentCommanderName', type: 'esriFieldTypeString' },
  { name: 'IncidentName', type: 'esriFieldTypeString' },
  { name: 'POOState', type: 'esriFieldTypeString' },
  { name: 'GlobalID', type: 'esriFieldTypeGlobalID' },
];
const picked = pickLabelFields(nifcFields, 'IncidentCommanderName');
assert.equal(picked[0].name, 'IncidentName', 'a person field must not win just because it is the default');
assert.equal(pickLabelFields([{ name: 'NAME', type: 'esriFieldTypeString' }, { name: 'ID', type: 'esriFieldTypeString' }], 'ID')[0].name, 'NAME');
assert.equal(pickLabelFields([{ name: 'OBJECTID', type: 'esriFieldTypeOID' }], 'OBJECTID').length, 0);

// ---- candidate scoring and dedupe ----
const base = { itemTitle: 'School Districts', layerName: 'School Districts', owner: 'oit_gis_COOIT', authoritative: false, views: 100, modified: Date.now() - 3 * 864e5 * 30, lastEdit: 0, geometryType: 'esriGeometryPolygon', count: 178, labelOptions: [{ name: 'NAME', score: 100 }] };
const auth = scoreCandidate({ ...base, authoritative: true }, 'school districts colorado', 0);
const plain = scoreCandidate(base, 'school districts colorado', 0);
const junk = scoreCandidate({ ...base, itemTitle: 'School Districts copy', layerName: 'School Districts copy' }, 'school districts colorado', 0);
const unlabeled = scoreCandidate({ ...base, labelOptions: [] }, 'school districts colorado', 0);
assert.ok(auth > plain && plain > junk && plain > unlabeled);
const d = dedupe([{ ...base, score: 50 }, { ...base, score: 80, itemTitle: 'Other' }, { ...base, count: 5, score: 10 }]);
assert.equal(d.length, 2);
assert.equal(d.find((x) => x.count === 178).score, 80, 'keeps the best duplicate');
assert.equal(displayTitle({ itemTitle: 'Districts and Boundaries', layerName: 'School Districts', multi: true }), 'Districts and Boundaries: School Districts');
assert.equal(displayTitle({ itemTitle: 'School Districts', layerName: 'School Districts', multi: false }), 'School Districts');
assert.match(describeCandidate({ ...base }), /^178 areas · updated .* · by oit_gis_COOIT$/);

// ---- labels applied to features ----
const feats = [{ properties: { IncidentName: 'Willard Pit RX', IncidentCommanderName: null } }, { properties: { IncidentName: '' } }];
applyLabels(feats, 'IncidentName');
assert.equal(feats[0].properties.name, 'Willard Pit RX');
assert.equal(feats[1].properties.name, 'Feature 2', 'blank labels get a readable fallback');
const cams = [{ properties: {} }];
applyLabels(cams, null, 'License plate reader');
assert.equal(cams[0].properties.name, 'License plate reader');

// ---- ordering: distance, then last update, then size ----
const denver = { lng: -104.99, lat: 39.74 };
assert.equal(distanceToBox(denver, [-105.2, 39.6, -104.6, 39.9]), 0, 'inside the box');
const toBoulder = distanceToBox(denver, [-105.3, 40.0, -105.2, 40.1]);
assert.ok(toBoulder > 20 && toBoulder < 60, `Denver to Boulder box is ${toBoulder} km`);
assert.equal(distanceToBox(denver, null), null);
const mk = (name, distKm, modified, count) => ({ name, distKm, modified, count, lastEdit: 0 });
const order = sortCandidates([
  mk('far-fresh-big', 3000, 9e12, 9999),
  mk('here-old-big', 0, 1e12, 5000),
  mk('here-fresh-small', 0, 9e12, 10),
  mk('here-fresh-big', 10, 9e12, 500),
  mk('unknown', null, 9e12, 9999),
]).map((c) => c.name);
assert.equal(order[0], 'here-fresh-big', 'same 25 km step: newest first, then biggest');
assert.equal(order[1], 'here-fresh-small');
assert.equal(order[2], 'here-old-big');
assert.equal(order.at(-1), 'unknown', 'unknown footprint sorts last');
assert.match(describeCandidate({ ...base, distKm: 0 }), /covers this spot/);
assert.match(describeCandidate({ ...base, distKm: 100 }), /62 mi away/);

assert.equal(sourceLink({ itemId: 'abc123', url: 'https://x/FeatureServer/0' }), 'https://www.arcgis.com/home/item.html?id=abc123');
assert.equal(sourceLink({ url: 'https://x/FeatureServer/0' }), 'https://x/FeatureServer/0');
for (const e of cat.entries) assert.ok(e.page || e.url, `${e.id} has a source page`);

console.log('search checks passed');
