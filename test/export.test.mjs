import assert from 'node:assert/strict';
import { geojsonToKml, kmlColor, labelPoint } from '../js/convert.js';
import { simplifyLine, simplifyCollection, countPoints, estimateBytes, prettyBytes, sizeWarnings } from '../js/simplify.js';
import { makeMatcher, filterFeatures } from '../js/listfilter.js';

// ---- KML styling ----
assert.equal(kmlColor('#ff8800', 1), 'ff0088ff', 'KML wants alpha, blue, green, red');
assert.equal(kmlColor('#ff8800', 0.5), '800088ff');
assert.equal(kmlColor('nonsense', 1), 'ffe24f1f', 'bad input falls back to the default blue');
const sq = { type: 'Feature', properties: { name: 'Square <1>', POP: 5, _key: 'k', _type: 'other' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] } };
const fc = { type: 'FeatureCollection', features: [sq] };
const plain = geojsonToKml(fc, 'T');
assert.match(plain, /<Data name="POP"><value>5<\/value>/);
assert.ok(!plain.includes('_key') && !plain.includes('_type'), 'internal fields never reach the file');
assert.ok(!plain.includes('<Point>'), 'no label pin unless asked');
const styled = geojsonToKml(fc, 'T', { line: '#ff0000', fill: '#00ff00', fillOpacity: 0.5, width: 4, labels: true, attributes: false });
assert.match(styled, /<LineStyle><color>ff0000ff<\/color><width>4<\/width>/);
assert.match(styled, /<PolyStyle><color>8000ff00<\/color>/);
assert.ok(!styled.includes('ExtendedData'));
assert.match(styled, /<MultiGeometry><Point><coordinates>1,1,0<\/coordinates><\/Point><Polygon>/, 'label pin sits inside the square');
assert.match(styled, /<IconStyle>.*<scale>0<\/scale><\/IconStyle>/, 'pin itself is invisible');
assert.match(styled, /Square &lt;1&gt;/);
// C-shaped area: the box center is in the gap, the label point must not be
const c = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 2], [2, 2], [2, 8], [10, 8], [10, 10], [0, 10], [0, 0]]] };
const lp = labelPoint(c);
assert.ok(lp[0] > 0 && lp[0] < 2 && lp[1] === 5, `label at ${lp} is inside the C`);
assert.deepEqual(labelPoint({ type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] }), [1, 1]);

// ---- simplification ----
const wiggle = Array.from({ length: 1001 }, (_, i) => [i / 1000, Math.sin(i) * 0.00001]);
const s = simplifyLine(wiggle, 0.0001);
assert.equal(s.length, 2, 'tiny wiggles are removed');
assert.deepEqual([s[0], s.at(-1)], [wiggle[0], wiggle.at(-1)], 'ends never move');
assert.equal(simplifyLine(wiggle, 0).length, 1001);
const circle = Array.from({ length: 361 }, (_, i) => [Math.cos((i * Math.PI) / 180), Math.sin((i * Math.PI) / 180)]);
circle[360] = circle[0];
const big = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'c' }, geometry: { type: 'Polygon', coordinates: [circle] } }, { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } }] };
const small = simplifyCollection(big, 'small');
const ring = small.features[0].geometry.coordinates[0];
assert.ok(ring.length < 100 && ring.length >= 4, `circle went from 361 to ${ring.length} points`);
assert.deepEqual(ring[0], ring.at(-1), 'ring stays closed');
assert.equal(small.features.length, 2, 'nothing is dropped');
assert.deepEqual(small.features[1].geometry.coordinates, [1, 2]);
assert.equal(big.features[0].geometry.coordinates[0].length, 361, 'the original list is untouched');
assert.equal(simplifyCollection(big, 'full'), big);
const tri = { type: 'Polygon', coordinates: [[[0, 0], [0.00001, 0], [0, 0.00001], [0, 0]]] };
assert.equal(simplifyCollection({ features: [{ geometry: tri }] }, 'small').features[0].geometry.coordinates[0].length, 4, 'tiny shapes stay valid');
assert.equal(countPoints(big), 362);

// ---- size estimates are in the right ballpark ----
const real = geojsonToKml(big, 'x').length;
const est = estimateBytes(big, 'kml');
assert.ok(est > real * 0.5 && est < real * 2, `estimate ${est} vs real ${real}`);
assert.equal(prettyBytes(512), '512 B');
assert.equal(prettyBytes(3.2 * 1048576), '3.2 MB');
assert.equal(sizeWarnings(6 * 1048576, 10, 'kml').length, 1);
assert.equal(sizeWarnings(100, 2500, 'kml').length, 1);
assert.equal(sizeWarnings(100, 10, 'kml').length, 0);
assert.equal(sizeWarnings(6 * 1048576, 10, 'geojson').length, 0);

// ---- list filter ----
const fires = [
  { properties: { name: 'Luna', attr_POOState: 'US-CO', _key: 'colorado-should-not-count' } },
  { properties: { name: 'Coconino Rim', attr_POOState: 'US-AZ' } },
  { properties: { name: 'Pogo', attr_POOState: 'US-CA', county: 'Colorado River district' } },
  { properties: { name: 'Shaw', STATE: 'Colorado' } },
];
const names = (q) => filterFeatures(fires, q).map((f) => f.properties.name);
assert.deepEqual(names('CO'), ['Luna', 'Pogo', 'Shaw'], '"CO" is a whole word and also means Colorado; never matches Coconino');
assert.deepEqual(names('colorado'), ['Luna', 'Pogo', 'Shaw'], 'state name also finds the code');
assert.deepEqual(names('coco'), ['Coconino Rim']);
assert.deepEqual(names('luna, pogo'), ['Luna', 'Pogo'], 'commas mean either');
assert.deepEqual(names(''), ['Luna', 'Coconino Rim', 'Pogo', 'Shaw']);
assert.equal(makeMatcher('zzz')(fires[0]), false);

console.log('export checks passed');
