import assert from 'node:assert/strict';
import { geojsonToKml, geojsonToGpx, esriToGeoJSON, bboxOf, featureName } from '../js/convert.js';

const fc = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { NAME: 'Tom & "Jerry" <Dist>', SLDL: '001', nested: { a: 1 } },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[-105, 39], [-104, 39], [-104, 40], [-105, 39]],
          [[-104.8, 39.2], [-104.6, 39.2], [-104.6, 39.4], [-104.8, 39.2]],
        ],
      },
    },
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-104.99, 39.74] } },
    {
      type: 'Feature',
      properties: { name: 'Trail' },
      geometry: { type: 'MultiLineString', coordinates: [[[-105, 39], [-105.1, 39.1]], [[-105.2, 39.2], [-105.3, 39.3]]] },
    },
    {
      type: 'Feature',
      properties: { name: 'Islands' },
      geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]]]] },
    },
  ],
};

const kml = geojsonToKml(fc, 'Test');
assert.match(kml, /<name>Tom &amp; &quot;Jerry&quot; &lt;Dist&gt;<\/name>/);
assert.match(kml, /<innerBoundaryIs>/);
assert.match(kml, /<MultiGeometry>/);
assert.match(kml, /-105,39,0/);
assert.ok(!kml.includes('nested'), 'object properties are skipped');
assert.equal((kml.match(/<Placemark>/g) || []).length, 4);
assert.match(kml, /<name>Feature 2<\/name>/);

const gpx = geojsonToGpx(fc, 'Test');
assert.match(gpx, /<wpt lat="39.74" lon="-104.99">/);
assert.equal((gpx.match(/<trk>/g) || []).length, 3);
// polygon (outer + hole) = 2 segments, multiline = 2, multipolygon = 2
assert.equal((gpx.match(/<trkseg>/g) || []).length, 6);
assert.match(gpx, /<gpx version="1.1"/);

// Esri JSON: one polygon with a hole, one with no hole.
const esri = esriToGeoJSON({
  features: [
    {
      attributes: { A: 1 },
      geometry: {
        rings: [
          [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]], // clockwise outer
          [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]], // counter-clockwise hole
        ],
      },
    },
    { attributes: { B: 2 }, geometry: { x: -105, y: 39 } },
  ],
});
assert.equal(esri.features[0].geometry.type, 'Polygon');
assert.equal(esri.features[0].geometry.coordinates.length, 2);
assert.equal(esri.features[1].geometry.type, 'Point');

assert.deepEqual(bboxOf(fc), [-105.3, 0, 6, 40]);
assert.equal(featureName({ properties: { ZCTA5: '80202' } }), '80202');

console.log('all converter checks passed');
