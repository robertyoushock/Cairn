import { geojsonToKml, geojsonToGpx, kmlToKmz, featureName, bboxOf } from './convert.js';
import { basemapStyle } from './basemap.js';
import {
  STATES, BOUNDARY_TYPES, queryBoundaries, identifyAt, searchPlaces, cleanAddress,
  searchPortal, inspectUrl, loadLayer, loadGeoJsonUrl, applyLabels, getJson,
} from './sources.js';
import { boundaryResult } from './intent.js';
import { loadCatalog, searchCatalog } from './catalog.js';
import { vetResults, pickLabelFields, displayTitle, describeCandidate } from './vet.js';
import { RELAY_URL } from './config.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

const KIND = {
  zip: 'ZIP code',
  sldl: 'State house district',
  sldu: 'State senate district',
  cd: 'Congressional district',
  county: 'County',
};
const CARD_COPY = {
  zip: ['ZIP codes', 'Like 80202'],
  sldl: ['State house districts', 'Your state representative'],
  sldu: ['State senate districts', 'Your state senator'],
  cd: ['Congressional districts', 'Your U.S. House seat'],
  county: ['Counties', 'Like Denver County'],
};

// ---------- Map ----------
const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle,
  center: [-98.5, 39.5],
  zoom: 3.6,
  maxPitch: 0,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

const EMPTY = { type: 'FeatureCollection', features: [] };
let mapReady = false;
const afterLoad = [];
map.on('load', () => {
  map.addSource('data', { type: 'geojson', data: EMPTY });
  map.addSource('preview', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'data-fill', type: 'fill', source: 'data', filter: ['==', '$type', 'Polygon'],
    paint: { 'fill-color': '#ffc933', 'fill-opacity': 0.32 } });
  map.addLayer({ id: 'data-line', type: 'line', source: 'data', filter: ['!=', '$type', 'Point'],
    paint: { 'line-color': '#0a4349', 'line-width': 2 } });
  map.addLayer({ id: 'data-point', type: 'circle', source: 'data', filter: ['==', '$type', 'Point'],
    paint: { 'circle-radius': 5, 'circle-color': '#ffc933', 'circle-stroke-color': '#0a4349', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'preview-line', type: 'line', source: 'preview',
    paint: { 'line-color': '#10222b', 'line-width': 3, 'line-dasharray': [2, 1.5] } });
  mapReady = true;
  afterLoad.splice(0).forEach((fn) => fn());
});
const whenReady = (fn) => (mapReady ? fn() : afterLoad.push(fn));

const mapBbox = () => {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
};
const fit = (box, maxZoom = 15) =>
  box && map.fitBounds([[box[0], box[1]], [box[2], box[3]]], { padding: 60, duration: 600, maxZoom });

// ---------- Status and busy buttons ----------
function status(msg, kind = '') {
  const s = $('status');
  s.textContent = msg;
  s.className = kind;
}
async function run(button, label, fn) {
  button?.classList.add('busy');
  if (button) button.disabled = true;
  status(label, 'busy');
  try {
    await fn();
  } catch (e) {
    status(e.message || String(e), 'error');
  } finally {
    if (button) { button.disabled = false; button.classList.remove('busy'); }
  }
}
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// ---------- The list ----------
const selection = new Map(); // key -> feature
let nameTouched = false;

function addFeatures(features, { zoom = true } = {}) {
  let added = 0;
  for (const f of features) {
    const key = f.properties?._key || `x:${selection.size}:${Math.random().toString(36).slice(2, 8)}`;
    if (!selection.has(key)) { selection.set(key, f); added++; }
  }
  renderSelection();
  if (zoom && features.length) { fit(bboxOf({ features })); setMode('list'); }
  return added;
}

function kindOf(f) {
  return KIND[f.properties?._type] || f.properties?._layer || 'Map feature';
}

function renderSelection() {
  const feats = [...selection.values()];
  const fc = { type: 'FeatureCollection', features: feats };
  whenReady(() => map.getSource('data').setData(fc));

  const n = feats.length;
  $('empty').hidden = n > 0;
  $('feature-list').hidden = n === 0;
  $('list-actions').hidden = n === 0;
  $('count').textContent = plural(n, 'item', 'items');
  $('mode-count').textContent = n ? `(${n.toLocaleString()})` : '';
  $('mode-list').disabled = n === 0;
  if (n === 0 && mode === 'list') setMode('spot');

  const list = $('feature-list');
  list.replaceChildren();
  feats.slice(0, 100).forEach((f) => {
    const zoomBtn = el('button', { type: 'button', textContent: featureName(f), title: 'Zoom to this' });
    zoomBtn.addEventListener('click', () => fit(bboxOf({ features: [f] })));
    const remove = el('button', { type: 'button', className: 'act remove', textContent: 'Remove' });
    remove.setAttribute('aria-label', `Remove ${featureName(f)}`);
    remove.addEventListener('click', () => { selection.delete(f.properties._key); renderSelection(); refreshHere(); });
    list.append(el('li', {}, el('span', { className: 'name' }, zoomBtn, el('br'), el('span', { className: 'kind', textContent: kindOf(f) })), remove));
  });
  if (n > 100) list.append(el('li', { textContent: `…and ${(n - 100).toLocaleString()} more. They will all be in the download.` }));

  if (!nameTouched) {
    const types = new Set(feats.map((f) => f.properties?._type));
    $('x-name').value = n && types.size === 1 && BOUNDARY_TYPES[[...types][0]]
      ? CARD_COPY[[...types][0]][0].toLowerCase().replace(/\s+/g, '-')
      : 'cairn-export';
  }
  updateDownload();
}

$('clear').addEventListener('click', () => { selection.clear(); renderSelection(); refreshHere(); status('List cleared.'); });

// ---------- Click the map ----------
let hereFeatures = [];
let hereToken = 0;
let marker = null;

function setPreview(f) {
  whenReady(() => map.getSource('preview').setData(f ? { type: 'FeatureCollection', features: [f] } : EMPTY));
}

function refreshHere() {
  if ($('here').hidden) return;
  renderHere(hereFeatures);
}

function renderHere(features) {
  hereFeatures = features;
  const ul = $('here-list');
  ul.replaceChildren();
  features.forEach((f) => {
    const have = selection.has(f.properties._key);
    const add = el('button', { type: 'button', className: 'act', textContent: have ? 'Added' : 'Add', disabled: have });
    add.setAttribute('aria-label', `Add ${featureName(f)}`);
    add.addEventListener('click', () => {
      addFeatures([f], { zoom: false });
      renderHere(hereFeatures);
      status(`Added ${featureName(f)}.`);
    });
    const li = el('li', {}, el('span', { className: 'name' }, el('strong', { textContent: featureName(f) }), el('br'), el('span', { className: 'kind', textContent: KIND[f.properties._type] })), add);
    li.addEventListener('mouseenter', () => { li.classList.add('preview-hover'); setPreview(f); });
    li.addEventListener('mouseleave', () => { li.classList.remove('preview-hover'); setPreview(null); });
    ul.append(li);
  });
  $('here').hidden = features.length === 0;
}

let lastSpot = null; // where results are ranked from: last click, search or location
async function identify(lng, lat) {
  lastSpot = { lng, lat };
  const token = ++hereToken;
  if (marker) marker.remove();
  marker = new maplibregl.Marker({ color: '#0f5c63' }).setLngLat([lng, lat]).addTo(map);
  status('Looking up this spot…', 'busy');
  const { features, failed } = await identifyAt(lng, lat);
  if (token !== hereToken) return; // a newer click replaced this one
  renderHere(features);
  if (!features.length) {
    status(failed ? 'The Census server did not answer. Try again in a moment.' : 'No US boundaries here. Click inside the United States.', 'error');
    return;
  }
  status(failed ? 'Found most boundaries here. Some could not be loaded; click again to retry.' : 'Pick what you want from the list below. Hover a row to preview it.');
  $('panel').classList.remove('collapsed');
  $('panel-toggle').textContent = 'Hide panel';
  $('here').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- Click modes ----------
// "spot": click anywhere to see boundaries there. "list": click shapes already added to inspect or remove them.
let mode = 'spot';
let popup = null;
const DATA_LAYERS = ['data-fill', 'data-line', 'data-point'];

function setMode(m) {
  if (m === 'list' && selection.size === 0) m = 'spot';
  mode = m;
  $('mode-spot').setAttribute('aria-pressed', String(m === 'spot'));
  $('mode-list').setAttribute('aria-pressed', String(m === 'list'));
  if (popup) { popup.remove(); popup = null; }
  setPreview(null);
  if (m === 'list') {
    if (marker) { marker.remove(); marker = null; }
    $('here').hidden = true;
    status('Click a shape on the map to inspect it, remove it, or keep only that one.');
  } else {
    status('Click anywhere on the map to see the boundaries at that spot.');
  }
}
$('mode-spot').addEventListener('click', () => setMode('spot'));
$('mode-list').addEventListener('click', () => setMode('list'));

function hitCard(f, close) {
  const full = selection.get(f.properties._key) || f;
  const box = el('div', { className: 'hit' }, el('div', { className: 'hn', textContent: featureName(full) }), el('div', { className: 'hk', textContent: kindOf(full) }));
  const acts = el('div', { className: 'acts' });
  const rm = el('button', { type: 'button', textContent: 'Remove' });
  rm.addEventListener('click', () => { selection.delete(full.properties._key); renderSelection(); close(); status(`Removed ${featureName(full)}.`); });
  const only = el('button', { type: 'button', textContent: 'Keep only this' });
  only.addEventListener('click', () => {
    const k = full.properties._key;
    for (const key of [...selection.keys()]) if (key !== k) selection.delete(key);
    renderSelection(); close(); fit(bboxOf({ features: [full] })); status(`Kept only ${featureName(full)}.`);
  });
  const more = el('button', { type: 'button', textContent: 'Details' });
  let dl = null;
  more.addEventListener('click', () => {
    if (dl) { dl.remove(); dl = null; return; }
    dl = el('dl');
    Object.entries(full.properties).filter(([k, v]) => !k.startsWith('_') && v != null && String(v).trim() !== '').slice(0, 14)
      .forEach(([k, v]) => dl.append(el('dt', { textContent: k }), el('dd', { textContent: String(v).slice(0, 120) })));
    box.append(dl);
  });
  acts.append(rm, only, more);
  box.append(acts);
  return box;
}

function inspectList(point, lngLat) {
  const seen = new Set();
  const hits = map.queryRenderedFeatures(point, { layers: DATA_LAYERS }).filter((f) => {
    const k = f.properties._key;
    if (!k || seen.has(k) || !selection.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 8);
  if (popup) popup.remove();
  if (!hits.length) return status('Nothing from your list here. Click a shape you added, or switch to "What\'s here?".');
  setPreview(selection.get(hits[0].properties._key));
  const close = () => { if (popup) popup.remove(); popup = null; setPreview(null); };
  const wrap = el('div', { className: 'hits' });
  hits.forEach((h) => wrap.append(hitCard(h, close)));
  popup = new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(lngLat).setDOMContent(wrap).addTo(map);
  popup.on('close', () => { popup = null; setPreview(null); });
  status(hits.length > 1 ? `${hits.length} shapes overlap here. Pick the one you want.` : 'Inspect it, or remove it from your list.');
}

map.on('click', (e) => {
  if (mode === 'list') return inspectList(e.point, e.lngLat);
  identify(e.lngLat.lng, e.lngLat.lat).catch((err) => status(err.message, 'error'));
});
map.on('mousemove', (e) => {
  if (mode !== 'list' || !mapReady) return;
  map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers: DATA_LAYERS }).length ? 'pointer' : '';
});

// ---------- Search a place / my location ----------
$('place-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('place-text').value.trim();
  if (!text) return status('Type a place or address first.', 'error');
  run(e.submitter?.type === 'submit' ? e.submitter : null, 'Searching…', async () => {
    let res = await searchPlaces(text);
    if (!res.length) {
      // Retry without unit numbers like "#18" or "Apt 4".
      const cleaned = cleanAddress(text);
      if (cleaned && cleaned !== text) res = await searchPlaces(cleaned);
    }
    const ul = $('place-results');
    ul.replaceChildren();
    if (!res.length) {
      ul.hidden = true;
      return status('No place found. Try the street and city only, like "1437 Bannock St, Denver".', 'error');
    }
    // Go straight to the best match. Other matches stay available in case it guessed wrong.
    const [best, ...others] = res;
    goTo(best);
    if (!others.length) { ul.hidden = true; return; }
    ul.append(el('li', { className: 'hint', textContent: 'Not the right place? Try:' }));
    others.forEach((r) => {
      const b = el('button', { type: 'button' }, el('span', { className: 't', textContent: r.name }));
      b.addEventListener('click', () => { ul.hidden = true; goTo(r); });
      ul.append(el('li', {}, b));
    });
    ul.hidden = false;
  });
});

function goTo({ lng, lat, bbox }) {
  lastSpot = { lng, lat };
  const small = bbox && bbox[2] - bbox[0] < 0.3;
  if (bbox && !small) fit(bbox, 12);
  else map.flyTo({ center: [lng, lat], zoom: 13.5, duration: 700 });
  if ((small || !bbox) && mode === 'spot') identify(lng, lat).catch((err) => status(err.message, 'error'));
  else if (mode === 'spot') status('Zoomed there. Click the map to see what boundaries cover a spot.');
}

$('locate').addEventListener('click', () => {
  if (!navigator.geolocation) return status('This browser cannot share your location. Search for a place instead.', 'error');
  status('Finding your location…', 'busy');
  navigator.geolocation.getCurrentPosition(
    (pos) => goTo({ lng: pos.coords.longitude, lat: pos.coords.latitude, bbox: null }),
    () => status('Could not get your location. Allow location access, or search for a place instead.', 'error'),
    { timeout: 10000 }
  );
});

// ---------- Choose a type ----------
const stateSel = $('t-state');
for (const [fips, name] of Object.entries(STATES)) stateSel.add(new Option(name, fips));
stateSel.value = '08';

let openType = null;
const cards = $('cards');
for (const [type] of Object.entries(BOUNDARY_TYPES)) {
  const [title, blurb] = CARD_COPY[type];
  const b = el('button', { type: 'button', className: 'card' }, el('span', { textContent: title }), el('small', { textContent: blurb }));
  b.dataset.type = type;
  b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', () => chooseType(openType === type ? null : type));
  cards.append(b);
}

function chooseType(type) {
  openType = type;
  cards.querySelectorAll('.card').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.type === type)));
  $('type-form').hidden = !type;
  if (!type) return;
  const t = BOUNDARY_TYPES[type];
  $('type-title').textContent = CARD_COPY[type][0];
  $('t-state-wrap').hidden = !t.needsState;
  $('t-input').placeholder = t.placeholder;
  $('t-hint').textContent = t.hint;
  $('t-label').textContent = type === 'county' ? 'County names' : type === 'zip' ? 'ZIP codes' : 'District numbers';
  $('t-input').focus();
}
$('type-cancel').addEventListener('click', () => chooseType(null));

$('type-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const type = openType;
  run(e.submitter, 'Asking the Census Bureau…', async () => {
    const { fc, source } = await queryBoundaries({
      type,
      state: stateSel.value,
      input: $('t-input').value,
      bbox: $('t-view').checked ? mapBbox() : null,
    });
    const n = fc.features.length;
    if (!n) return status('Nothing matched. Check the spelling or numbers.', 'error');
    const added = addFeatures(fc.features);
    $('source-note').textContent = `Data: ${source}`;
    const capped = n >= 2000 ? ' That is the most we fetch at once, so narrow the search for the rest.' : '';
    status(`Added ${plural(added, 'item', 'items')}${added < n ? ` (${n - added} were already in your list)` : ''}.${capped}`);
  });
});

// ---------- Find data ----------
const CHIPS = ['texas state house', 'wildfires', 'earthquakes', 'school districts colorado', 'flock cameras', 'fire stations', 'bike lanes'];
for (const c of CHIPS) {
  const b = el('button', { type: 'button', className: 'chip', textContent: c });
  b.addEventListener('click', () => { $('find-text').value = c; $('find-form').requestSubmit(); });
  $('chips').append(b);
}

let findToken = 0;
let detail = null; // what is open in the preview panel

function resultRow(title, sub, badge, onPick) {
  const t = el('span', { className: 't', textContent: title });
  if (badge) t.append(el('span', { className: badge.soft ? 'badge soft' : 'badge', textContent: badge.text }));
  const b = el('button', { type: 'button' }, t);
  if (sub) b.append(el('span', { className: 's', textContent: sub }));
  b.addEventListener('click', onPick);
  return el('li', {}, b);
}

function showResults() {
  $('detail').hidden = true;
  setPreview(null);
  detail = null;
  $('find-results').hidden = false;
}

$('find-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('find-text').value.trim();
  if (!text) return status('Type what you are looking for first.', 'error');
  const token = ++findToken;
  $('detail').hidden = true;
  $('find-results').hidden = false;
  const verified = $('r-verified');
  const more = $('r-more');
  verified.replaceChildren();
  more.replaceChildren();
  $('r-progress').textContent = '';
  run(e.submitter, 'Searching…', async () => {
    // 1. Verified: Census boundaries understood from plain words, plus the hand-checked catalog.
    const entries = await loadCatalog();
    if (token !== findToken) return;
    const b = boundaryResult(text);
    const cat = searchCatalog(entries, text);
    if (b) {
      verified.append(resultRow(b.title, b.sub, { text: 'Verified' }, () => pickBoundary(b)));
    }
    cat.forEach((en) => verified.append(resultRow(en.title, `${en.agency} · ${en.freshness || ''}`.replace(/ · $/, ''), { text: 'Verified' }, () => openDetail({ source: 'catalog', entry: en }))));
    const nVerified = verified.children.length;
    $('r-verified-h').hidden = verified.hidden = nVerified === 0;

    // A clear Census match needs no ArcGIS hunt. Offer it, but do not make people wade through it.
    if (b && b.kind === 'boundary') {
      $('r-more-h').hidden = true;
      const again = el('button', { type: 'button', className: 'linkish', textContent: 'Also look in ArcGIS Online' });
      again.addEventListener('click', () => { again.remove(); searchArcgis(text, token, cat); });
      $('r-progress').replaceChildren(again);
      status('Found it. Pick a result.');
      return;
    }
    await searchArcgis(text, token, cat);
  });
});

async function searchArcgis(text, token, cat) {
  $('r-more-h').hidden = false;
  const more = $('r-more');
  const prog = $('r-progress');
  prog.textContent = 'Looking through ArcGIS Online…';
  const known = new Set(cat.map((c) => c.url));
  const render = (cands) => {
    if (token !== findToken) return;
    more.replaceChildren();
    cands.filter((c) => !known.has(c.url)).slice(0, 8).forEach((c) => {
      more.append(resultRow(displayTitle(c), describeCandidate(c), c.authoritative ? { text: 'Authoritative' } : null, () => openDetail({ source: 'arcgis', cand: c })));
    });
  };
  const items = await searchPortal('https://www.arcgis.com', text, 'all');
  if (token !== findToken) return;
  if (!items.length) {
    prog.textContent = 'Nothing on ArcGIS Online matched. Try fewer or simpler words.';
    return status(cat.length ? 'Pick a verified result.' : 'No matches. Try simpler words.', cat.length ? '' : 'error');
  }
  const final = await vetResults(items, text, {
    near: lastSpot || (() => { const c = map.getCenter(); return { lng: c.lng, lat: c.lat }; })(),
    onFound: render,
    onProgress: (d, n) => { if (token === findToken) prog.textContent = `Checking results… ${d} of ${n}`; },
  });
  if (token !== findToken) return;
  render(final);
  const shown = more.children.length;
  prog.textContent = shown
    ? 'Each of these was opened and checked. Sorted by distance from the spot you last clicked, then most recently updated, then most items.'
    : 'None of the results were usable (empty or table-only). Try different words.';
  status(shown || cat.length ? 'Pick a result to preview it.' : 'No usable results. Try different words.', shown || cat.length ? '' : 'error');
}

async function pickBoundary(b) {
  if (b.kind === 'boundary-form') {
    chooseType(b.type);
    if (b.state) stateSel.value = b.state;
    $('type-form').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return status(b.sub);
  }
  run(null, 'Asking the Census Bureau…', async () => {
    const { fc, source } = await queryBoundaries({ type: b.type, state: b.state || stateSel.value, input: b.input, bbox: null });
    if (!fc.features.length) return status('Nothing matched. Check the spelling or numbers.', 'error');
    const added = addFeatures(fc.features);
    $('source-note').textContent = `Data: ${source}`;
    status(`Added ${plural(added, 'item', 'items')}. Check the map, then download below.`);
  });
}

// ---------- Preview before adding ----------
const labelChoices = (props) =>
  Object.entries(props || {})
    .filter(([k, v]) => typeof v === 'string' && v.trim() && !k.startsWith('_'))
    .map(([k]) => ({ name: k, alias: k, score: 5 }));

async function openDetail(d) {
  const token = ++findToken; // cancels any search still filling in
  const entry = d.entry;
  const cand = d.cand;
  const title = entry ? entry.title : displayTitle(cand);
  detail = { ...d, title, token, sample: [] };
  $('find-results').hidden = true;
  $('detail').hidden = false;
  $('detail-title').textContent = title;
  $('detail-meta').textContent = entry ? `${entry.description} Source: ${entry.attribution}.` : `${describeCandidate(cand)}${cand.copyright ? `. ${cand.copyright.slice(0, 120)}` : ''}`;
  const warn = $('detail-warn');
  const add = $('detail-add');
  warn.hidden = true;
  add.disabled = false;
  const blocked = entry?.needsRelay && !RELAY_URL;
  const notes = [];
  if (blocked) {
    notes.push('This source does not allow direct downloads from a web page, and the Cairn relay it needs is not turned on yet, so it cannot be added right now.');
    add.disabled = true;
  }
  if (entry?.large || (cand && cand.count > 20000)) notes.push('This is a very large dataset. Tick "Only what is on the screen right now" under Filter, or zoom to your area first.');
  if (notes.length) { warn.textContent = notes.join(' '); warn.hidden = false; }
  $('detail-sample').textContent = '';
  const sel = $('detail-label');
  sel.replaceChildren();
  $('detail-label-wrap').hidden = !!entry?.fixedLabel;

  const setLabelOptions = (opts, chosen) => {
    sel.replaceChildren();
    opts.slice(0, 8).forEach((o) => sel.add(new Option(o.alias && o.alias !== o.name ? `${o.alias} (${o.name})` : o.name, o.name)));
    sel.add(new Option('Just number them (Feature 1, 2…)', ''));
    sel.value = chosen && opts.some((o) => o.name === chosen) ? chosen : opts[0]?.name ?? '';
  };

  if (cand) setLabelOptions(cand.labelOptions, cand.labelField);
  if (blocked) return status('Preview unavailable until the relay is set up.', 'error');

  status('Loading a preview…', 'busy');
  try {
    let sample;
    if (cand || entry.type === 'arcgis') {
      const url = cand ? cand.url : entry.url;
      if (entry) {
        const info = await getJson(`${url}?f=json`);
        setLabelOptions(pickLabelFields(info.fields, info.displayField), entry.labelField);
        sel.value = entry.labelField || sel.value;
      }
      const r = await loadLayer({ url, limit: 300, bbox: entry?.large ? mapBbox() : null });
      sample = r.fc.features;
    } else {
      const r = await loadGeoJsonUrl({ url: entry.url, gz: !!entry.gz, labelField: entry.labelField, fixedLabel: entry.fixedLabel, limit: 300, relay: RELAY_URL });
      sample = r.fc.features;
      if (!entry.fixedLabel) setLabelOptions(labelChoices(sample[0]?.properties), entry.labelField);
    }
    if (token !== findToken) return;
    detail.sample = sample;
    if (!sample.length) {
      warn.textContent = 'Nothing is in view for this dataset right now. Zoom the map to where you expect it, or search again.';
      warn.hidden = false;
      return status('The preview is empty.', 'error');
    }
    refreshSample();
    whenReady(() => map.getSource('preview').setData({ type: 'FeatureCollection', features: sample }));
    fit(bboxOf({ features: sample }), 9);
    status('Check the names below. Change "Name each shape by" if they look wrong.');
  } catch (e) {
    if (token === findToken) status(`Could not preview this: ${e.message}`, 'error');
  }
}

function refreshSample() {
  if (!detail?.sample.length) return;
  const field = $('detail-label').value;
  applyLabels(detail.sample, field || null, detail.entry?.fixedLabel || null);
  const names = detail.sample.slice(0, 3).map((f) => f.properties.name);
  $('detail-sample').textContent = `Shapes will be named like: ${names.join(', ')}`;
}
$('detail-label').addEventListener('change', refreshSample);
$('detail-back').addEventListener('click', () => { showResults(); status(''); });

$('detail').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!detail) return;
  const d = detail;
  run(e.submitter, 'Adding…', async () => {
    const limit = Number($('l-limit').value);
    const bbox = $('l-view').checked ? mapBbox() : null;
    const labelField = $('detail-label').value || null;
    const onProgress = (n) => status(`Loaded ${n.toLocaleString()} so far…`, 'busy');
    let r;
    if (d.cand || d.entry.type === 'arcgis') {
      r = await loadLayer({ url: d.cand ? d.cand.url : d.entry.url, where: $('l-where').value, bbox, limit, labelField, onProgress });
    } else {
      r = await loadGeoJsonUrl({ url: d.entry.url, gz: !!d.entry.gz, labelField, fixedLabel: d.entry.fixedLabel, bbox, limit, relay: RELAY_URL });
    }
    if (!r.fc.features.length) return status('Nothing matched. Try clearing the filter or zooming out.', 'error');
    const base = d.cand ? d.cand.url : d.entry.url;
    const tagged = r.fc.features.map((f, i) => ({
      ...f,
      properties: { ...f.properties, _type: 'other', _layer: d.title, _key: `${base}#${f.id ?? f.properties?.OBJECTID ?? i}` },
    }));
    const added = addFeatures(tagged);
    const credit = d.entry ? d.entry.attribution : d.cand.copyright;
    $('source-note').textContent = credit ? `Data: ${credit}` : '';
    setPreview(null);
    status(r.truncated
      ? `Added the first ${added.toLocaleString()}. There is more: raise "Most to add" or filter to get the rest.`
      : `Added ${plural(added, 'item', 'items')} from "${d.title}".`);
  });
});

// ---------- Paste a link (advanced) ----------
async function openUrl(url) {
  const r = await inspectUrl(url);
  $('u-url').value = r.url;
  if (r.kind === 'layer') return openLink(r.url, r.name);
  if (r.kind === 'service') {
    if (r.layers.length === 1) return openLink(`${r.url}/${r.layers[0].id}`, r.layers[0].name || r.name);
    const big = r.layers.find((l) => l.name);
    if (big) return openLink(`${r.url}/${big.id}`, big.name);
  }
  throw new Error('That link is not a map layer. Paste a link ending in FeatureServer/0 (or similar), or use the search above.');
}
async function openLink(url, name) {
  const info = await getJson(`${url}?f=json`);
  const labelOptions = pickLabelFields(info.fields, info.displayField);
  const count = (await getJson(`${url}/query?where=1%3D1&returnCountOnly=true&f=json`)).count || 0;
  $('other').open = false;
  openDetail({ source: 'arcgis', cand: { url, itemTitle: name || info.name || 'Layer', layerName: info.name, multi: false, count, geometryType: info.geometryType, modified: 0, lastEdit: info.editingInfo?.lastEditDate || 0, owner: '', labelOptions, labelField: labelOptions[0]?.score > 20 ? labelOptions[0].name : null, copyright: info.copyrightText || '' } });
}
$('url-form').addEventListener('submit', (e) => {
  e.preventDefault();
  run(e.submitter, 'Reading the link…', () => openUrl($('u-url').value));
});

// ---------- Download ----------
const fmtLabel = { kml: 'KML', kmz: 'KMZ', gpx: 'GPX', geojson: 'GeoJSON' };
const currentFmt = () => document.querySelector('input[name="fmt"]:checked').value;

function updateDownload() {
  const n = selection.size;
  const b = $('download');
  b.disabled = n === 0;
  b.textContent = n ? `Download ${fmtLabel[currentFmt()]} (${plural(n, 'item', 'items')})` : 'Add something to your list first';
}
document.querySelectorAll('input[name="fmt"]').forEach((r) => r.addEventListener('change', updateDownload));
$('x-name').addEventListener('input', () => { nameTouched = true; });

function download(blob, filename) {
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

$('export-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selection.size) return;
  const fmt = currentFmt();
  const title = $('x-name').value.trim() || 'cairn-export';
  const base = title.replace(/[^\w.-]+/g, '-');
  const fc = { type: 'FeatureCollection', features: [...selection.values()] };
  try {
    if (fmt === 'kml') download(new Blob([geojsonToKml(fc, title)], { type: 'application/vnd.google-earth.kml+xml' }), `${base}.kml`);
    if (fmt === 'kmz') download(await kmlToKmz(geojsonToKml(fc, title), JSZip), `${base}.kmz`);
    if (fmt === 'gpx') download(new Blob([geojsonToGpx(fc, title)], { type: 'application/gpx+xml' }), `${base}.gpx`);
    if (fmt === 'geojson') download(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }), `${base}.geojson`);
    status(`Downloaded ${base}.${fmt}.`);
  } catch (err) {
    status(`Could not build the ${fmtLabel[fmt]} file: ${err.message}`, 'error');
  }
});

// ---------- Mobile panel ----------
$('panel-toggle').addEventListener('click', () => {
  const collapsed = $('panel').classList.toggle('collapsed');
  $('panel-toggle').textContent = collapsed ? 'Show panel' : 'Hide panel';
  $('panel-toggle').setAttribute('aria-expanded', String(!collapsed));
  map.resize();
});

renderSelection();
