import assert from 'node:assert/strict';
import { checkRequest } from '../worker/relay.js';
const mk = (u) => `https://r.example/?url=${encodeURIComponent(u)}`;
assert.equal(checkRequest(mk('https://data.dontgetflocked.com/cameras.geojson.gz'), 'https://robertyoushock.com').ok, true);
assert.equal(checkRequest(mk('https://evil.example/x'), null).status, 403);
assert.equal(checkRequest(mk('http://data.dontgetflocked.com/x'), null).status, 400);
assert.equal(checkRequest('https://r.example/', null).status, 400);
assert.equal(checkRequest(mk('https://data.dontgetflocked.com/x'), 'https://evil.example').status, 403);
console.log('relay checks passed');
