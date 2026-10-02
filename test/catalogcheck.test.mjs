import assert from 'node:assert/strict';
import { checkArcgis } from '../scripts/check-catalog.mjs';

const entry = { id: 'x', url: 'https://s/FeatureServer/0', labelField: 'IncidentName', freshness: 'Updated' };
const fake = (over = {}) => async (u) => {
  if (u.endsWith('?f=json')) return over.info || { geometryType: 'esriGeometryPolygon', fields: [{ name: 'IncidentName' }, { name: 'OBJECTID' }] };
  if (u.includes('returnCountOnly')) return { count: over.count ?? 12 };
  return { features: over.features || [{ attributes: { IncidentName: 'Luna' } }, { attributes: { IncidentName: 'Shaw' } }] };
};
assert.equal(await checkArcgis(entry, fake()), null);
assert.match(await checkArcgis(entry, fake({ info: { fields: [] } })), /no longer a map layer/);
assert.match(await checkArcgis(entry, fake({ info: { geometryType: 'esriGeometryPolygon', fields: [{ name: 'NAME' }] } })), /no longer has the name field "IncidentName"/);
assert.match(await checkArcgis(entry, fake({ count: 0 })), /has no features/);
assert.equal(await checkArcgis({ ...entry, id: 'fires-current' }, fake({ count: 0 })), null, 'a live feed may honestly be empty');
assert.match(await checkArcgis(entry, fake({ features: [{ attributes: { IncidentName: '' } }, { attributes: { IncidentName: null } }, { attributes: { IncidentName: 'A' } }] })), /mostly blank/);
console.log('catalog check checks passed');
