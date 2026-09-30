import assert from 'node:assert/strict';
import { basemapStyle } from '../js/basemap.js';

const text = JSON.stringify(basemapStyle);
// The repo is public: no credentials may ever appear in the basemap style.
for (const bad of ['access_token', 'apiKey', 'api_key', 'key=', 'mc-cdn', 'hereapi', 'maptiler']) {
  assert.ok(!text.toLowerCase().includes(bad.toLowerCase()), `style must not contain "${bad}"`);
}
assert.equal(basemapStyle.version, 8);
assert.ok(basemapStyle.sources.ofm.attribution.includes('OpenStreetMap'), 'attribution is required');
const ids = basemapStyle.layers.map((l) => l.id);
assert.equal(new Set(ids).size, ids.length, 'layer ids are unique');
for (const l of basemapStyle.layers) {
  if (l.source) assert.ok(basemapStyle.sources[l.source], `${l.id} uses a defined source`);
}
console.log('basemap checks passed');
