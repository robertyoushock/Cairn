// Opens every verified source and reports, in plain words, anything a visitor would trip over.
// Prints a Markdown report to stdout. Exit code 1 when anything is broken.
// Run by .github/workflows/catalog-check.yml, or by hand: node scripts/check-catalog.mjs
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { BOUNDARY_TYPES } from '../js/sources.js';

const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb';
const catalog = JSON.parse(fs.readFileSync(new URL('../data/catalog.json', import.meta.url)));

async function getJson(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'cairn-catalog-check (github.com/robertyoushock/cairn)' } });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || `ArcGIS error ${json.error.code}`);
      return json;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
    }
  }
  throw last;
}

export async function checkArcgis(entry, get = getJson) {
  const info = await get(`${entry.url}?f=json`);
  if (!info.geometryType) return 'is no longer a map layer (no shapes)';
  const fields = (info.fields || []).map((f) => f.name);
  if (entry.labelField && !fields.includes(entry.labelField)) return `no longer has the name field "${entry.labelField}" (fields now: ${fields.slice(0, 12).join(', ')})`;
  const count = (await get(`${entry.url}/query?where=1%3D1&returnCountOnly=true&f=json`)).count;
  // Live feeds such as current fires can honestly be empty; anything else at zero is broken.
  if (!count && !/current|24|live|alerts/i.test(`${entry.id} ${entry.freshness}`)) return 'has no features';
  if (count && entry.labelField) {
    const q = await get(`${entry.url}/query?where=1%3D1&outFields=${encodeURIComponent(entry.labelField)}&returnGeometry=false&resultRecordCount=25&f=json`);
    const vals = (q.features || []).map((f) => f.attributes?.[entry.labelField]);
    const named = vals.filter((v) => v != null && String(v).trim() !== '').length;
    if (vals.length && named / vals.length < 0.5) return `name field "${entry.labelField}" is mostly blank (${named} of ${vals.length} sampled)`;
  }
  return null;
}

export async function checkGeojson(entry) {
  const res = await fetch(entry.url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) return `answered ${res.status}`;
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  const json = JSON.parse(buf.toString('utf8'));
  const feats = (json.features || []).filter((f) => f && f.geometry);
  if (!feats.length && !/day|hour|live/i.test(`${entry.id} ${entry.freshness}`)) return 'has no features';
  if (feats.length && entry.labelField && !feats.slice(0, 25).some((f) => f.properties?.[entry.labelField])) return `no longer has the name field "${entry.labelField}"`;
  return null;
}

async function checkCensus(type, t) {
  const svc = await getJson(`${TIGER}/${t.service}/MapServer?f=json`);
  const want = [t.layer, ...(t.alsoLayers || [])];
  const missing = want.filter((re) => !(svc.layers || []).some((l) => l.parentLayerId === -1 && re.test(l.name)));
  return missing.length ? `Census no longer lists a layer matching ${missing.join(', ')}` : null;
}

async function main() {
  const rows = [];
  for (const entry of catalog.entries) {
    let problem;
    try { problem = entry.type === 'arcgis' ? await checkArcgis(entry) : await checkGeojson(entry); }
    catch (e) { problem = `could not be reached (${e.message})`; }
    rows.push({ name: entry.title, where: `data/catalog.json, id \`${entry.id}\``, url: entry.url, problem });
  }
  for (const [type, t] of Object.entries(BOUNDARY_TYPES)) {
    let problem;
    try { problem = await checkCensus(type, t); }
    catch (e) { problem = `could not be reached (${e.message})`; }
    rows.push({ name: `Census: ${t.label}`, where: `js/sources.js, BOUNDARY_TYPES.${type}`, url: `${TIGER}/${t.service}/MapServer`, problem });
  }
  const bad = rows.filter((r) => r.problem);
  const out = [];
  out.push(bad.length ? `## ${bad.length} of ${rows.length} sources need attention` : `## All ${rows.length} sources are healthy`, '');
  out.push(`Checked ${new Date().toISOString().slice(0, 10)}.`, '');
  for (const r of bad) out.push(`- **${r.name}** ${r.problem}.`, `  - Where to fix: ${r.where}`, `  - Link: ${r.url}`);
  if (bad.length) out.push('', 'How to fix: open the link, find where the publisher moved the layer or renamed the field, and update the entry. See "Adding a catalog entry" in docs/HANDOFF.md. A server that was only down for the day needs no change; this issue can be closed.', '');
  out.push('<details><summary>Everything that was checked</summary>', '', ...rows.map((r) => `- ${r.problem ? 'BROKEN' : 'ok'}: ${r.name}`), '', '</details>');
  console.log(out.join('\n'));
  process.exit(bad.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
