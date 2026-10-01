// Quality checks for ArcGIS search results. The goal: never show a layer that is empty, a table,
// unqueryable, duplicated, or labeled by a useless field. Pure scoring helpers plus one probe function.

import { getJson } from './sources.js';
import { tokenize } from './catalog.js';

const BAD_NAME = /(commander|username|user_?name|created_?user|last_?edited_?user|editor|creator|owner|manager|email|phone|globalid|guid|^shape|objectid|^fid$|^oid$)/i;
const GOOD_EXACT = new Set(['name', 'names', 'label', 'title', 'fullname', 'full_name']);

// Rank the fields worth using as a label, best first. Prefers real name fields over the layer's own
// default (which is often an ID or a person's name).
export function pickLabelFields(fields = [], displayField = '') {
  const scored = fields
    .filter((f) => f.type === 'esriFieldTypeString')
    .map((f) => {
      const n = f.name;
      const l = n.toLowerCase();
      let s = 0;
      if (GOOD_EXACT.has(l)) s = 100;
      else if (/name$/.test(l)) s = 85;
      else if (/name/.test(l)) s = 75;
      else if (/label|title/.test(l)) s = 65;
      else if (/district|zone|area|city|county|desc/.test(l)) s = 25;
      else s = 5;
      if (BAD_NAME.test(n)) s -= 70;
      if (n === displayField && !BAD_NAME.test(n)) s += 20;
      return { name: n, alias: f.alias || n, score: s };
    })
    .sort((a, b) => b.score - a.score);
  return scored;
}

export const geometryNoun = (g) =>
  ({ esriGeometryPolygon: 'areas', esriGeometryPoint: 'points', esriGeometryMultipoint: 'points', esriGeometryPolyline: 'lines' }[g] || 'features');

const monthsAgo = (ms) => (ms ? (Date.now() - ms) / (1000 * 60 * 60 * 24 * 30.4) : Infinity);
const GOV_OWNER = /(gis|county|city|town|state|dept|department|gov|agency|usgs|noaa|fema|nifc|census|district|authoritative|planning|commission|council)/i;
const JUNK_TITLE = /\b(copy|test|backup|old|deprecated|draft|archive|temp|tmp|sample|demo)\b/i;

export function scoreCandidate(c, query = '', position = 0) {
  const q = tokenize(query);
  const hay = tokenize(`${c.itemTitle} ${c.layerName}`);
  let s = Math.max(0, 10 - position);
  if (c.authoritative) s += 30;
  if (GOV_OWNER.test(c.owner || '')) s += 10;
  const age = monthsAgo(Math.max(c.lastEdit || 0, c.modified || 0));
  s += age <= 12 ? 10 : age <= 36 ? 5 : age > 72 ? -5 : 0;
  s += q.filter((t) => hay.includes(t)).length * 8;
  if (JUNK_TITLE.test(`${c.itemTitle} ${c.layerName}`)) s -= 25;
  s += Math.min(10, Math.log10((c.views || 0) + 1) * 2);
  if (!c.labelOptions?.length) s -= 15;
  return Math.round(s);
}

export function dedupe(cands) {
  const best = new Map();
  for (const c of cands) {
    const key = `${(c.layerName || '').toLowerCase().replace(/[^a-z0-9]/g, '')}|${c.geometryType}|${c.count}`;
    if (!best.has(key) || best.get(key).score < c.score) best.set(key, c);
  }
  return [...best.values()];
}

const isLayerUrl = (u) => /\/(Feature|Map)Server\/\d+$/i.test(u);

async function probeLayer(layerUrl, item, layerNameFallback) {
  const info = await getJson(`${layerUrl}?f=json`);
  if (!info.geometryType) return null; // a table or something with no shapes
  if (info.capabilities && !/query/i.test(info.capabilities)) return null;
  const count = (await getJson(`${layerUrl}/query?where=1%3D1&returnCountOnly=true&f=json`)).count;
  if (!count) return null; // empty layer
  const labelOptions = pickLabelFields(info.fields, info.displayField);
  return {
    url: layerUrl,
    itemTitle: item.title,
    layerName: info.name || layerNameFallback,
    owner: item.owner,
    authoritative: /authoritative/i.test(item.contentStatus || ''),
    views: item.numViews || 0,
    modified: item.modified || 0,
    lastEdit: info.editingInfo?.lastEditDate || 0,
    geometryType: info.geometryType,
    count,
    maxRecordCount: info.maxRecordCount || 1000,
    labelOptions,
    labelField: labelOptions[0] && labelOptions[0].score > 20 ? labelOptions[0].name : null,
    copyright: info.copyrightText || '',
  };
}

// Look inside one search result and return its usable layers. Never throws: a broken service just yields [].
export async function probeItem(item, query = '') {
  try {
    const url = (item.url || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (!url) return [];
    if (isLayerUrl(url)) return [await probeLayer(url, item, item.title)].filter(Boolean);
    if (!/\/(Feature|Map)Server$/i.test(url)) return [];
    const svc = await getJson(`${url}?f=json`);
    const q = tokenize(query);
    const layers = (svc.layers || [])
      .filter((l) => l.subLayerIds == null)
      .map((l) => ({ ...l, rel: tokenize(l.name).filter((t) => q.includes(t)).length }))
      .sort((a, b) => b.rel - a.rel)
      .slice(0, 6);
    const out = await Promise.all(layers.map((l) => probeLayer(`${url}/${l.id}`, item, l.name).catch(() => null)));
    return out.filter(Boolean).map((c) => ({ ...c, multi: layers.length > 1 }));
  } catch {
    return [];
  }
}

export function displayTitle(c) {
  return c.multi && c.layerName && c.layerName !== c.itemTitle ? `${c.itemTitle}: ${c.layerName}` : c.itemTitle || c.layerName;
}

export function describeCandidate(c) {
  const bits = [`${c.count.toLocaleString()} ${geometryNoun(c.geometryType)}`];
  const when = Math.max(c.lastEdit || 0, c.modified || 0);
  if (when) bits.push(`updated ${new Date(when).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`);
  if (c.owner) bits.push(`by ${c.owner}`);
  return bits.join(' · ');
}

// Probe a page of search results with limited concurrency, reporting each good layer as soon as it is found.
export async function vetResults(items, query, { onFound = () => {}, onProgress = () => {}, concurrency = 4, max = 12 } = {}) {
  const queue = items.slice(0, max).map((it, i) => ({ it, i }));
  const found = [];
  let done = 0;
  async function worker() {
    while (queue.length) {
      const { it, i } = queue.shift();
      const layers = await probeItem(it, query);
      for (const c of layers) {
        c.score = scoreCandidate(c, query, i);
        found.push(c);
      }
      done++;
      onProgress(done, Math.min(items.length, max));
      if (layers.length) onFound(dedupe(found).sort((a, b) => b.score - a.score));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return dedupe(found).sort((a, b) => b.score - a.score);
}
