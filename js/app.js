import { geojsonToKml, geojsonToGpx, kmlToKmz, featureName, bboxOf } from './convert.js';
import { basemapStyle } from './basemap.js';
import {
  STATES, BOUNDARY_TYPES, queryBoundaries, identifyAt, searchPlaces, cleanAddress,
  searchPortal, inspectUrl, loadLayer, loadGeoJsonUrl, applyLabels, getJson, PICK_ORDER, fullFeature,
} from './sources.js';
import { boundaryResult } from './intent.js';
import { loadCatalog, searchCatalog } from './catalog.js';
import { vetResults, pickLabelFields, displayTitle, describeCandidate, sourceLink } from './vet.js';
import { RELAY_URL } from './config.js';
import { DETAIL_LEVELS, simplifyCollection, countPoints, estimateBytes, prettyBytes, sizeWarnings } from './simplify.js';
import { makeMatcher } from './listfilter.js';
import { MODES, MAX_STOPS, buildRoute, parseMapsLink } from './routes.js';

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
  state: 'State',
  route: 'Route',
  place: 'City or town',
  school: 'School district',
  tract: 'Census tract',
};
const CARD_COPY = {
  zip: ['ZIP codes', 'Like 80202'],
  sldl: ['State house districts', 'Your state representative'],
  sldu: ['State senate districts', 'Your state senator'],
  cd: ['Congressional districts', 'Your U.S. House seat'],
  county: ['Counties', 'Like Denver County'],
  place: ['Cities and towns', 'City limits'],
  school: ['School districts', 'Like Jeffco Schools'],
  tract: ['Census tracts', 'Small statistical areas'],
  state: ['States', 'Whole-state outline'],
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
  map.addSource('route', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 7 } });
  // Road legs are solid; the flight leg is dashed. (Dash patterns cannot vary per feature, hence two layers.)
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: ['!=', ['get', 'mode'], 'Fly'], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#0f5c63', 'line-width': 4 } });
  map.addLayer({ id: 'route-fly', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'Fly'],
    paint: { 'line-color': '#0f5c63', 'line-width': 3, 'line-dasharray': [2, 2] } });
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

let selectionVersion = 0;
function renderSelection() {
  selectionVersion++;
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
  // A filter is only worth showing once the list is long enough to get lost in.
  if (n <= 5 && $('list-filter').value) $('list-filter').value = '';
  $('list-filter-wrap').hidden = n <= 5;
  renderList();

  if (!nameTouched) {
    const types = new Set(feats.map((f) => f.properties?._type));
    $('x-name').value = n && types.size === 1 && BOUNDARY_TYPES[[...types][0]]
      ? CARD_COPY[[...types][0]][0].toLowerCase().replace(/\s+/g, '-')
      : 'cairn-export';
  }
  updateDownload();
}

// The rows under "Check your list", narrowed by the filter box when it has text.
function matchingFeatures() {
  const q = $('list-filter').value.trim();
  const feats = [...selection.values()];
  return { q, feats, shown: q ? feats.filter(makeMatcher(q)) : feats };
}

function renderList() {
  const { q, feats, shown } = matchingFeatures();
  const n = feats.length;
  const list = $('feature-list');
  list.replaceChildren();
  shown.slice(0, 100).forEach((f) => {
    const zoomBtn = el('button', { type: 'button', textContent: featureName(f), title: 'Zoom to this' });
    zoomBtn.addEventListener('click', () => fit(bboxOf({ features: [f] })));
    const remove = el('button', { type: 'button', className: 'act remove', textContent: 'Remove' });
    remove.setAttribute('aria-label', `Remove ${featureName(f)}`);
    remove.addEventListener('click', () => { selection.delete(f.properties._key); renderSelection(); refreshHere(); });
    list.append(el('li', {}, el('span', { className: 'name' }, zoomBtn, el('br'), el('span', { className: 'kind', textContent: kindOf(f) })), remove));
  });
  if (shown.length > 100) list.append(el('li', { textContent: `…and ${(shown.length - 100).toLocaleString()} more.${q ? '' : ' They will all be in the download.'}` }));
  if (q && n && !shown.length) list.append(el('li', { textContent: 'Nothing in your list matches. The filter looks at names and every detail, including state.' }));

  const narrowed = q && shown.length > 0 && shown.length < n;
  $('filter-actions').hidden = !narrowed;
  $('filter-count').textContent = narrowed ? `${shown.length.toLocaleString()} of ${n.toLocaleString()} match` : '';
  // Outline the matches on the map so it is clear what "Keep only these" will keep.
  if (mode !== 'spot' || q) whenReady(() => map.getSource('preview').setData(narrowed && shown.length <= 500 ? { type: 'FeatureCollection', features: shown } : EMPTY));
}

let filterTimer = 0;
$('list-filter').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(renderList, 150); });
$('filter-keep').addEventListener('click', () => {
  const { shown } = matchingFeatures();
  const keep = new Set(shown.map((f) => f.properties._key));
  for (const k of [...selection.keys()]) if (!keep.has(k)) selection.delete(k);
  $('list-filter').value = '';
  renderSelection(); refreshHere();
  fit(bboxOf({ features: shown }));
  status(`Kept ${plural(shown.length, 'item', 'items')}.`);
});
$('filter-remove').addEventListener('click', () => {
  const { shown } = matchingFeatures();
  shown.forEach((f) => selection.delete(f.properties._key));
  $('list-filter').value = '';
  renderSelection(); refreshHere();
  status(`Removed ${plural(shown.length, 'item', 'items')}.`);
});

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
  $('mode-route').setAttribute('aria-pressed', String(m === 'route'));
  if (popup) { popup.remove(); popup = null; }
  setPreview(null);
  map.getCanvas().style.cursor = m === 'route' ? 'crosshair' : '';
  if (m !== 'route' && $('route').open) $('route').open = false;
  if (m !== 'spot') {
    if (marker) { marker.remove(); marker = null; }
    $('here').hidden = true;
  }
  if (m === 'list') status('Click a shape on the map to inspect it, remove it, or keep only that one.');
  else if (m === 'route') {
    if (!$('route').open) $('route').open = true;
    $('panel').classList.remove('collapsed');
    $('route').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    status('Click the map to add stops in the order you will travel.');
  } else status('Click anywhere on the map to see the boundaries at that spot.');
}
$('mode-spot').addEventListener('click', () => setMode('spot'));
$('mode-list').addEventListener('click', () => setMode('list'));
$('mode-route').addEventListener('click', () => setMode('route'));
$('route').addEventListener('toggle', () => {
  if ($('route').open && mode !== 'route') setMode('route');
  else if (!$('route').open && mode === 'route') setMode(selection.size ? 'list' : 'spot');
});

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
  if (mode === 'route') return addStop({ lng: e.lngLat.lng, lat: e.lngLat.lat, label: '' });
  if (mode === 'list') return inspectList(e.point, e.lngLat);
  identify(e.lngLat.lng, e.lngLat.lat).catch((err) => status(err.message, 'error'));
});
map.on('mousemove', (e) => {
  if (mode !== 'list' || !mapReady) return;
  map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers: DATA_LAYERS }).length ? 'pointer' : '';
});

// ---------- Right-click: pick an area ----------
// A small outline of the shape, so "Denver County" and "Colorado" are recognisable at a glance.
function shapeIcon(g) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('aria-hidden', 'true');
  const polys = !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  const box = bboxOf({ features: [{ geometry: g }] });
  if (!polys.length || !box) return svg;
  // Squash longitude by the cosine of the latitude so shapes look the way they do on the map.
  const k = Math.cos(((box[1] + box[3]) / 2) * Math.PI / 180);
  const w = (box[2] - box[0]) * k || 1e-9;
  const h = box[3] - box[1] || 1e-9;
  const s = 20 / Math.max(w, h);
  const ox = 2 + (20 - w * s) / 2;
  const oy = 2 + (20 - h * s) / 2;
  let d = '';
  for (const poly of polys) for (const ring of poly) {
    const step = Math.max(1, Math.floor(ring.length / 120));
    ring.forEach((c, n) => {
      if (n % step && n !== ring.length - 1) return;
      d += `${d && n === 0 ? ' ' : ''}${n === 0 ? 'M' : 'L'}${(ox + (c[0] - box[0]) * k * s).toFixed(1)} ${(oy + (box[3] - c[1]) * s).toFixed(1)}`;
    });
    d += 'Z';
  }
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);
  return svg;
}

let pickToken = 0;
async function pickMenu(lngLat) {
  const token = ++pickToken;
  if (popup) popup.remove();
  const head = el('div', { className: 'pick-head', textContent: 'Pick an area' });
  const list = el('ul', { className: 'pick-list' }, el('li', { className: 'pick-note', textContent: 'Looking up this spot…' }));
  const wrap = el('div', { className: 'pick' }, head, list);
  const mine = new maplibregl.Popup({ maxWidth: '380px', className: 'pick-pop' }).setLngLat(lngLat).setDOMContent(wrap).addTo(map);
  popup = mine;
  mine.on('close', () => { if (popup === mine) popup = null; setPreview(null); });
  // Rough shapes come back in a fraction of the time; the full shape is fetched when one is picked.
  const { features, failed } = await identifyAt(lngLat.lng, lngLat.lat, { types: PICK_ORDER, generalize: 0.002 }).catch(() => ({ features: [], failed: PICK_ORDER.length }));
  if (token !== pickToken || popup !== mine) return;
  list.replaceChildren();
  if (!features.length) {
    list.append(el('li', { className: 'pick-note', textContent: failed ? 'The Census server did not answer. Right-click again in a moment.' : 'No US areas here. Try a spot inside the United States.' }));
    return;
  }
  features.forEach((f) => {
    const have = () => selection.has(f.properties._key);
    const b = el('button', { type: 'button' }, shapeIcon(f.geometry), el('span', { className: 'pn', textContent: featureName(f) }), el('span', { className: 'pk', textContent: have() ? 'Added' : KIND[f.properties._type] }));
    b.addEventListener('mouseenter', () => setPreview(f));
    b.addEventListener('mouseleave', () => setPreview(null));
    b.addEventListener('click', async () => {
      if (have() || b.disabled) return;
      b.disabled = true;
      b.querySelector('.pk').textContent = 'Adding…';
      try {
        const full = await fullFeature(f);
        addFeatures([full], { zoom: false });
        refreshHere();
        b.querySelector('.pk').textContent = 'Added';
        b.classList.add('done');
        status(`Added ${featureName(full)}. Pick more, or close the menu.`);
      } catch (e) {
        b.disabled = false;
        b.querySelector('.pk').textContent = KIND[f.properties._type];
        status(e.message, 'error');
      }
    });
    if (have()) { b.disabled = true; b.classList.add('done'); }
    list.append(el('li', {}, b));
  });
  if (failed) list.append(el('li', { className: 'pick-note', textContent: 'Some areas could not be loaded. Right-click again to retry.' }));
}
map.on('contextmenu', (e) => {
  e.preventDefault();
  pickMenu(e.lngLat);
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
  $('t-input').closest('label').hidden = Boolean(t.noInput);
  if (t.noInput) $('t-input').value = '';
  $('t-input').placeholder = t.placeholder;
  $('t-hint').textContent = t.hint;
  $('t-label').textContent = { county: 'County names', zip: 'ZIP codes', place: 'City or town names', school: 'District names', tract: 'Tract numbers' }[type] || 'District numbers';
  if (!t.noInput) $('t-input').focus();
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

const ARROW = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M8 7h9v9"/></svg>';
function sourceAnchor(href, label, className = 'src') {
  if (!href) return null;
  const a = el('a', { href, target: '_blank', rel: 'noopener noreferrer', className, title: 'Open the source in a new tab' });
  a.setAttribute('aria-label', `Open source: ${label}`);
  a.innerHTML = `<span>Source</span>${ARROW}`;
  return a;
}

function resultRow(title, sub, badge, onPick, href) {
  const t = el('span', { className: 't', textContent: title });
  if (badge) t.append(el('span', { className: badge.soft ? 'badge soft' : 'badge', textContent: badge.text }));
  const b = el('button', { type: 'button' }, t);
  if (sub) b.append(el('span', { className: 's', textContent: sub }));
  b.addEventListener('click', onPick);
  return el('li', {}, b, sourceAnchor(href, title));
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
      verified.append(resultRow(b.title, b.sub, { text: 'Verified' }, () => pickBoundary(b), 'https://tigerweb.geo.census.gov/tigerwebmain/TIGERweb_main.html'));
    }
    cat.forEach((en) => verified.append(resultRow(en.title, `${en.agency} · ${en.freshness || ''}`.replace(/ · $/, ''), { text: 'Verified' }, () => openDetail({ source: 'catalog', entry: en }), en.page || en.url)));
    const nVerified = verified.children.length;
    $('r-verified-h').hidden = verified.hidden = nVerified === 0;

    // A clear Census match needs no ArcGIS hunt. Offer it, but do not make people wade through it.
    if (b && b.kind === 'boundary' && !b.loose) {
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
      more.append(resultRow(displayTitle(c), describeCandidate(c), c.authoritative ? { text: 'Authoritative' } : null, () => openDetail({ source: 'arcgis', cand: c }), sourceLink(c)));
    });
  };
  // Two searches at once: one limited to the area around the last spot, one everywhere. Local results go first
  // so they are sure to be checked; worldwide layers that merely overlap the spot are pushed back.
  const near = lastSpot;
  const [local, global] = await Promise.all([
    near ? searchPortal('https://www.arcgis.com', text, 'all', near).catch(() => []) : [],
    searchPortal('https://www.arcgis.com', text, 'all'),
  ]);
  if (token !== findToken) return;
  const span = (it) => (it.extent && it.extent.length === 2 ? Math.abs(it.extent[1][0] - it.extent[0][0]) : 360);
  const localFirst = local.filter((it) => span(it) < 20).sort((x, y) => span(x) - span(y)).slice(0, 10);
  const seen = new Set(localFirst.map((it) => it.id));
  const items = [...localFirst, ...global.filter((it) => !seen.has(it.id))];
  if (!items.length) {
    prog.textContent = 'Nothing on ArcGIS Online matched. Try fewer or simpler words.';
    return status(cat.length ? 'Pick a verified result.' : 'No matches. Try simpler words.', cat.length ? '' : 'error');
  }
  const final = await vetResults(items, text, {
    near: lastSpot || (() => { const c = map.getCenter(); return { lng: c.lng, lat: c.lat }; })(),
    max: 18,
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
    if (b.input) $('t-input').value = b.input;
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
// Opens a ready-to-send GitHub issue so wrong labels and dead layers get reported with the details attached.
function reportLink(title, url, query) {
  const body = [
    'What went wrong? (wrong names, empty, will not load, out of date, something else)',
    '',
    '',
    '---',
    `Result: ${title}`,
    `Layer: ${url}`,
    query ? `Search: ${query}` : '',
  ].filter((l) => l !== null).join('\n');
  const p = new URLSearchParams({ title: `Bad result: ${title}`, body, labels: 'bad-result' });
  return `https://github.com/robertyoushock/cairn/issues/new?${p}`;
}

const labelChoices = (props) =>
  Object.entries(props || {})
    .filter(([k, v]) => typeof v === 'string' && v.trim() && !k.startsWith('_') && k !== 'name')
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
  $('detail-source').replaceChildren(sourceAnchor(entry ? entry.page || entry.url : sourceLink(cand), title, 'src inline') || '');
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
  const big = Boolean(entry?.large || (cand && cand.count > 20000));
  // Huge datasets default to the current map view, so "Add" never tries to pull the whole country.
  $('l-view').checked = big;
  $('detail-limit').open = big;
  const tooWide = big && map.getZoom() < 8;
  if (big) notes.push(tooWide
    ? 'This dataset is very large. Zoom the map in to your town or county, then press "Preview this area".'
    : 'This dataset is very large, so only what is on the screen right now will be added.');
  $('detail-reload').hidden = !big;
  add.disabled = add.disabled || tooWide;
  $('detail-report').href = reportLink(title, entry ? entry.url : cand.url, $('find-text').value.trim());
  if (notes.length) { warn.textContent = notes.join(' '); warn.hidden = false; }
  $('detail-sample').textContent = '';
  const sel = $('detail-label');
  sel.replaceChildren();
  $('detail-label-wrap').hidden = !!entry?.fixedLabel;

  const setLabelOptions = (opts, chosen) => {
    sel.replaceChildren();
    // The pre-chosen field always makes the short list, even when the layer has dozens of fields ahead of it.
    const picked = opts.find((o) => o.name === chosen);
    const short = picked ? [picked, ...opts.filter((o) => o !== picked)].slice(0, 8) : opts.slice(0, 8);
    short.forEach((o) => sel.add(new Option(o.alias && o.alias !== o.name ? `${o.alias} (${o.name})` : o.name, o.name)));
    sel.add(new Option('Just number them (Feature 1, 2…)', ''));
    sel.value = picked ? chosen : short[0]?.name ?? '';
  };

  if (cand) setLabelOptions(cand.labelOptions, cand.labelField);
  if (blocked) return status('Preview unavailable until the relay is set up.', 'error');
  if (tooWide) return status('Zoom in first, then press "Preview this area".');

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
      const r = await loadLayer({ url, limit: 300, bbox: big ? mapBbox() : null, generalize: big ? 0 : 0.003 });
      sample = r.fc.features;
    } else {
      const r = await loadGeoJsonUrl({ url: entry.url, gz: !!entry.gz, labelField: entry.labelField, fixedLabel: entry.fixedLabel, limit: 300, bbox: big ? mapBbox() : null, relay: RELAY_URL, relayFirst: !!entry.needsRelay });
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
    if (!big) fit(bboxOf({ features: sample }), 9); // big datasets stay on the area the person chose
    status('Check the names below. Change "Name each shape by" if they look wrong.');
  } catch (e) {
    if (token === findToken) status(`Could not preview this: ${e.message}`, 'error');
  }
}

const prefixFor = (d, field) => (d.entry?.labelPrefix && field === d.entry.labelField ? d.entry.labelPrefix : '');

function refreshSample() {
  if (!detail?.sample.length) return;
  const field = $('detail-label').value;
  applyLabels(detail.sample, field || null, detail.entry?.fixedLabel || null, prefixFor(detail, field));
  const names = detail.sample.slice(0, 3).map((f) => f.properties.name);
  $('detail-sample').textContent = `Shapes will be named like: ${names.join(', ')}`;
}
$('detail-label').addEventListener('change', refreshSample);
$('detail-back').addEventListener('click', () => { showResults(); status(''); });
$('detail-reload').addEventListener('click', () => { if (detail) openDetail({ source: detail.source, entry: detail.entry, cand: detail.cand }); });

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
      r = await loadLayer({ url: d.cand ? d.cand.url : d.entry.url, where: $('l-where').value, bbox, limit, labelField, labelPrefix: prefixFor(d, labelField), onProgress });
    } else {
      r = await loadGeoJsonUrl({ url: d.entry.url, gz: !!d.entry.gz, labelField, fixedLabel: d.entry.fixedLabel, bbox, limit, relay: RELAY_URL, relayFirst: !!d.entry.needsRelay });
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

// ---------- Routes ----------
let routeStops = []; // { lng, lat, label, marker }
let routeResult = null;
let routeToken = 0;
let routeTimer = 0;
let airportsCache = null;
const routeMode = () => document.querySelector('input[name="rmode"]:checked').value;

// Ask the helper once whether it has a routing key. Without one, skip it and go straight to the keyless server.
let relayRouting = null;
async function routingRelay() {
  if (!RELAY_URL) return '';
  if (relayRouting === null) {
    relayRouting = await fetch(`${RELAY_URL.replace(/\/+$/, '')}/health`).then((r) => r.json()).then((j) => Boolean(j.routing)).catch(() => false);
  }
  return relayRouting ? RELAY_URL : '';
}

async function loadAirports() {
  if (!airportsCache) airportsCache = (await getJson('data/airports.json')).airports;
  return airportsCache;
}

function stopLabel(s, i) {
  return s.label || `Stop ${i + 1} (${s.lat.toFixed(4)}, ${s.lng.toFixed(4)})`;
}

function addStop(stop, { recalc = true } = {}) {
  if (routeStops.length >= MAX_STOPS) return status(`A route can have at most ${MAX_STOPS} stops.`, 'error');
  const pin = el('div', { className: 'stop-pin' });
  const s = { ...stop };
  s.marker = new maplibregl.Marker({ element: pin, draggable: true }).setLngLat([s.lng, s.lat]).addTo(map);
  s.marker.on('dragend', () => {
    const p = s.marker.getLngLat();
    s.lng = p.lng; s.lat = p.lat; s.label = '';
    renderStops(); scheduleRoute();
  });
  // Clicking a pin should not also drop a new stop underneath it.
  pin.addEventListener('click', (e) => e.stopPropagation());
  routeStops.push(s);
  renderStops();
  if (recalc) scheduleRoute();
}

function renderStops() {
  const ol = $('r-stops');
  ol.replaceChildren();
  ol.hidden = routeStops.length === 0;
  routeStops.forEach((s, i) => {
    s.marker.getElement().textContent = String(i + 1);
    const up = el('button', { type: 'button', className: 'act', textContent: 'Up', disabled: i === 0 });
    up.setAttribute('aria-label', `Move stop ${i + 1} earlier`);
    up.addEventListener('click', () => { [routeStops[i - 1], routeStops[i]] = [routeStops[i], routeStops[i - 1]]; renderStops(); scheduleRoute(); });
    const rm = el('button', { type: 'button', className: 'act remove', textContent: 'Remove' });
    rm.setAttribute('aria-label', `Remove stop ${i + 1}`);
    rm.addEventListener('click', () => { s.marker.remove(); routeStops.splice(i, 1); renderStops(); scheduleRoute(); });
    ol.append(el('li', {}, el('span', { className: 'num', textContent: String(i + 1) }), el('span', { className: 'lbl', textContent: stopLabel(s, i), title: stopLabel(s, i) }), up, rm));
  });
}

function scheduleRoute() {
  clearTimeout(routeTimer);
  routeTimer = setTimeout(drawRoute, 350);
}

async function drawRoute() {
  const token = ++routeToken;
  routeResult = null;
  $('r-save').disabled = true;
  if (routeStops.length < 2) {
    whenReady(() => map.getSource('route').setData(EMPTY));
    $('r-summary').textContent = routeStops.length ? 'Add one more stop to see the route.' : '';
    return;
  }
  $('r-summary').textContent = 'Finding the route…';
  try {
    const m = routeMode();
    const r = await buildRoute(routeStops, m, { relay: await routingRelay(), airports: m === 'plane' ? await loadAirports() : [] });
    if (token !== routeToken) return;
    routeResult = r;
    whenReady(() => map.getSource('route').setData({ type: 'FeatureCollection', features: r.features }));
    const extra = r.ignoredStops ? ' Fly + drive uses only your first and last stops.' : '';
    $('r-summary').textContent = `${r.summary}${extra}`;
    $('r-save').disabled = false;
    $('source-note').textContent = `Directions: ${r.provider}, © OpenStreetMap contributors`;
  } catch (e) {
    if (token !== routeToken) return;
    whenReady(() => map.getSource('route').setData(EMPTY));
    $('r-summary').textContent = e.message;
  }
}
document.querySelectorAll('input[name="rmode"]').forEach((r) => r.addEventListener('change', scheduleRoute));

function clearRoute() {
  routeStops.forEach((s) => s.marker.remove());
  routeStops = [];
  routeResult = null;
  routeToken++;
  renderStops();
  whenReady(() => map.getSource('route').setData(EMPTY));
  $('r-summary').textContent = '';
  $('r-save').disabled = true;
}
$('r-clear').addEventListener('click', clearRoute);

$('r-add').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('r-text').value.trim();
  if (!text) return;
  run(e.submitter, 'Finding that place…', async () => {
    let res = await searchPlaces(text);
    if (!res.length && cleanAddress(text) !== text) res = await searchPlaces(cleanAddress(text));
    if (!res.length) return status('No place found. Try the street and city only.', 'error');
    addStop({ lng: res[0].lng, lat: res[0].lat, label: res[0].name.split(',').slice(0, 2).join(',') });
    $('r-text').value = '';
    if (routeStops.length === 1) map.flyTo({ center: [res[0].lng, res[0].lat], zoom: 11, duration: 600 });
    else fit(bboxOf({ features: routeStops.map((s) => ({ geometry: { type: 'Point', coordinates: [s.lng, s.lat] } })) }), 13);
    status(`Added stop ${routeStops.length}.`);
  });
});

$('r-save').addEventListener('click', () => {
  if (!routeResult) return;
  const stamp = Date.now();
  const tagged = routeResult.features.map((f, i) => ({ ...f, properties: { ...f.properties, _type: 'route', _layer: 'Route', _key: `route:${stamp}:${i}` } }));
  const n = tagged.length;
  clearRoute();
  addFeatures(tagged);
  // GPS apps want GPX, so pick it when the list is nothing but routes.
  if (!fmtTouched && [...selection.values()].every((f) => f.properties._type === 'route')) {
    document.querySelector('input[name="fmt"][value="gpx"]').checked = true;
    updateDownload();
  }
  status(`Added the route to your list${n > 1 ? ` as ${n} parts` : ''}. Download it below.`);
});

$('r-link').addEventListener('submit', (e) => {
  e.preventDefault();
  run(e.submitter, 'Reading the link…', async () => {
    let parsed = parseMapsLink($('r-url').value);
    if (parsed.short) {
      if (!RELAY_URL) throw new Error('Short links (maps.app.goo.gl) cannot be read yet. Open the link in your browser, then copy the long address from the address bar and paste that.');
      const j = await getJson(`${RELAY_URL.replace(/\/+$/, '')}/resolve?url=${encodeURIComponent(parsed.url)}`);
      parsed = parseMapsLink(j.url);
      if (parsed.short) throw new Error('That short link could not be opened. Paste the long address from Google Maps instead.');
    }
    clearRoute();
    const missed = [];
    for (const s of parsed.stops) {
      if (s.lng == null) {
        status(`Finding "${s.label}"…`, 'busy');
        let res = await searchPlaces(s.text);
        if (!res.length && cleanAddress(s.text) !== s.text) res = await searchPlaces(cleanAddress(s.text));
        if (!res.length) { missed.push(s.label); continue; }
        s.lng = res[0].lng; s.lat = res[0].lat;
      }
      addStop({ lng: s.lng, lat: s.lat, label: s.label }, { recalc: false });
    }
    if (routeStops.length < 2) throw new Error(`Could not find ${missed.length ? `"${missed.join('", "')}"` : 'the stops in that link'}. Add them by address instead.`);
    document.querySelector(`input[name="rmode"][value="${parsed.mode}"]`).checked = true;
    fit(bboxOf({ features: routeStops.map((s) => ({ geometry: { type: 'Point', coordinates: [s.lng, s.lat] } })) }), 13);
    scheduleRoute();
    status(missed.length ? `Read the link, but could not find "${missed.join('", "')}". Add it by address.` : `Read ${routeStops.length} stops from the link. Check the route, then add it to your list.`, missed.length ? 'error' : '');
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
for (const [k, v] of Object.entries(DETAIL_LEVELS)) $('x-detail').add(new Option(v.label, k));

const lookOptions = () => ({
  line: $('k-line').value,
  fill: $('k-fill').value,
  fillOpacity: Number($('k-opacity').value) / 100,
  width: Number($('k-width').value),
  labels: $('k-labels').checked,
  attributes: $('k-attrs').checked,
});

// What will actually be written: the list at the chosen detail level. Cached, since simplifying a big list takes a moment.
let exportCache = { key: '', fc: null };
function exportCollection() {
  const level = $('x-detail').value;
  const key = `${selectionVersion}|${level}`;
  if (exportCache.key !== key) {
    exportCache = { key, fc: simplifyCollection({ type: 'FeatureCollection', features: [...selection.values()] }, level) };
  }
  return exportCache.fc;
}

// Cairn's own bookkeeping fields (names starting with _) stay out of every file.
const publicProps = (p, keep) => Object.fromEntries(Object.entries(p || {}).filter(([k]) => !k.startsWith('_') && (keep || k === 'name')));

let sizeTimer = 0;
function updateDownload() {
  const n = selection.size;
  const b = $('download');
  b.disabled = n === 0;
  b.textContent = n ? `Download ${fmtLabel[currentFmt()]} (${plural(n, 'item', 'items')})` : 'Add something to your list first';
  $('size-note').textContent = '';
  $('size-warn').hidden = true;
  clearTimeout(sizeTimer);
  if (!n) return;
  sizeTimer = setTimeout(() => {
    const fmt = currentFmt();
    const fc = exportCollection();
    const bytes = estimateBytes(fc, fmt, { attributes: $('k-attrs').checked });
    const pts = countPoints(fc);
    const full = $('x-detail').value === 'full' ? pts : countPoints({ features: [...selection.values()] });
    const saved = full > pts ? ` (${Math.round((1 - pts / full) * 100)}% fewer points than full detail)` : '';
    $('size-note').textContent = `About ${prettyBytes(bytes)} · ${pts.toLocaleString()} points${saved}`;
    const warns = sizeWarnings(bytes, n, fmt);
    if (warns.length && $('x-detail').value !== 'small') warns.push('Change "Shape detail" under Colors, labels and file size.');
    $('size-warn').textContent = warns.join(' ');
    $('size-warn').hidden = warns.length === 0;
    if (warns.length) $('look').open = true;
  }, 250);
}
let fmtTouched = false;
document.querySelectorAll('input[name="fmt"]').forEach((r) => r.addEventListener('change', () => { fmtTouched = true; updateDownload(); }));
['x-detail', 'k-attrs'].forEach((id) => $(id).addEventListener('change', updateDownload));
$('x-name').addEventListener('input', () => { nameTouched = true; });

// The map follows the chosen colors so what you see is what Google Earth will show.
function applyLook() {
  const o = lookOptions();
  whenReady(() => {
    map.setPaintProperty('data-fill', 'fill-color', o.fill);
    map.setPaintProperty('data-fill', 'fill-opacity', o.fillOpacity);
    map.setPaintProperty('data-line', 'line-color', o.line);
    map.setPaintProperty('data-line', 'line-width', o.width);
    map.setPaintProperty('data-point', 'circle-color', o.fill);
    map.setPaintProperty('data-point', 'circle-stroke-color', o.line);
  });
}
['k-line', 'k-fill', 'k-opacity', 'k-width'].forEach((id) => $(id).addEventListener('input', applyLook));

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
  const fc = exportCollection();
  const look = lookOptions();
  try {
    let blob;
    if (fmt === 'kml') blob = new Blob([geojsonToKml(fc, title, look)], { type: 'application/vnd.google-earth.kml+xml' });
    if (fmt === 'kmz') blob = await kmlToKmz(geojsonToKml(fc, title, look), JSZip);
    if (fmt === 'gpx') blob = new Blob([geojsonToGpx(fc, title)], { type: 'application/gpx+xml' });
    if (fmt === 'geojson') {
      const out = { type: 'FeatureCollection', features: fc.features.map((f) => ({ type: 'Feature', properties: publicProps(f.properties, look.attributes), geometry: f.geometry })) };
      blob = new Blob([JSON.stringify(out)], { type: 'application/geo+json' });
    }
    download(blob, `${base}.${fmt}`);
    status(`Downloaded ${base}.${fmt} (${prettyBytes(blob.size)}).`);
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
