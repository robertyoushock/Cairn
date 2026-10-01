import { geojsonToKml, geojsonToGpx, kmlToKmz, featureName, bboxOf } from './convert.js';
import { basemapStyle } from './basemap.js';
import {
  STATES, BOUNDARY_TYPES, queryBoundaries, identifyAt, searchPlaces,
  searchPortal, inspectUrl, loadLayer,
} from './sources.js';

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
  if (zoom && features.length) fit(bboxOf({ features }));
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

async function identify(lng, lat) {
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

map.on('click', (e) => {
  identify(e.lngLat.lng, e.lngLat.lat).catch((err) => status(err.message, 'error'));
});

// ---------- Search a place / my location ----------
$('place-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('place-text').value.trim();
  if (!text) return status('Type a place or address first.', 'error');
  run(e.submitter?.type === 'submit' ? e.submitter : null, 'Searching…', async () => {
    const res = await searchPlaces(text);
    const ul = $('place-results');
    ul.replaceChildren();
    if (!res.length) {
      ul.hidden = true;
      return status('No place found. Try adding a city or state.', 'error');
    }
    res.forEach((r) => {
      const b = el('button', { type: 'button' }, el('span', { className: 't', textContent: r.name }));
      b.addEventListener('click', () => {
        ul.hidden = true;
        goTo(r);
      });
      ul.append(el('li', {}, b));
    });
    ul.hidden = false;
    status('Pick the right place.');
  });
});

function goTo({ lng, lat, bbox }) {
  const small = bbox && bbox[2] - bbox[0] < 0.3;
  if (bbox && !small) fit(bbox, 12);
  else map.flyTo({ center: [lng, lat], zoom: 13.5, duration: 700 });
  if (small || !bbox) identify(lng, lat).catch((err) => status(err.message, 'error'));
  else status('Zoomed there. Click the map to see what boundaries cover a spot.');
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

// ---------- Other public map data (ArcGIS) ----------
let selectedLayer = null;
const CHIPS = ['school districts Colorado', 'fire stations', 'parks and trails', 'voting precincts', 'city limits', 'bike lanes'];
for (const c of CHIPS) {
  const b = el('button', { type: 'button', className: 'chip', textContent: c });
  b.addEventListener('click', () => { $('s-text').value = c; $('search-form').requestSubmit(); });
  $('chips').append(b);
}

function showBrowse(title, items) {
  $('browse').hidden = false;
  $('browse-title').textContent = title;
  const ul = $('browse-list');
  ul.replaceChildren();
  for (const it of items) {
    const b = el('button', { type: 'button' }, el('span', { className: 't', textContent: it.title }));
    if (it.sub) b.append(el('span', { className: 's', textContent: it.sub }));
    b.addEventListener('click', it.onPick);
    ul.append(el('li', {}, b));
  }
  if (!items.length) ul.append(el('li', { textContent: 'Nothing found.', style: 'padding:10px' }));
}

async function openUrl(url) {
  const r = await inspectUrl(url);
  $('u-url').value = r.url;
  if (r.kind === 'layer') return pickLayer(r.url, r.name);
  if (r.kind === 'service') {
    // One layer means there is nothing to choose: go straight to it.
    if (r.layers.length === 1) return pickLayer(`${r.url}/${r.layers[0].id}`, r.layers[0].name || r.name);
    showBrowse(`${r.name || 'This dataset'} has ${plural(r.layers.length, 'layer', 'layers')}. Pick one:`, r.layers.map((l) => ({
      title: l.name, onPick: () => pickLayer(`${r.url}/${l.id}`, l.name),
    })));
    return status('Pick a layer to preview.');
  }
  const go = (u, label) => run(null, label, () => openUrl(u));
  const items = [
    ...r.folders.map((f) => ({ title: `${f.name}/`, sub: 'Folder', onPick: () => go(f.url, 'Opening folder…') })),
    ...r.services.map((s) => ({ title: s.name, sub: s.url.split('/').pop(), onPick: () => go(s.url, 'Opening…') })),
  ];
  showBrowse('Folders and datasets', items);
  status(`${plural(items.length, 'item', 'items')} found.`);
}

function pickLayer(url, name) {
  selectedLayer = { url, name: name || 'Layer' };
  $('layer-form').hidden = false;
  $('layer-title').textContent = selectedLayer.name;
  status(`Ready to add "${selectedLayer.name}". Use the button below.`);
  $('layer-form').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('s-text').value.trim();
  if (!text) return status('Type what you are looking for first.', 'error');
  run(e.submitter?.type === 'submit' ? e.submitter : null, 'Searching…', async () => {
    const res = await searchPortal('https://www.arcgis.com', text, 'all');
    showBrowse(res.length ? `${plural(res.length, 'result', 'results')}. Pick one:` : 'No results', res.map((r) => ({
      title: r.title,
      sub: `By ${r.owner}${r.views ? `, ${r.views.toLocaleString()} views` : ''}`,
      onPick: () => run(null, 'Opening…', () => openUrl(r.url)),
    })));
    status(res.length ? 'Pick a result to see what is inside.' : 'No public maps matched. Try fewer or simpler words.', res.length ? '' : 'error');
  });
});

$('url-form').addEventListener('submit', (e) => {
  e.preventDefault();
  run(e.submitter, 'Reading the link…', () => openUrl($('u-url').value));
});

$('layer-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!selectedLayer) return;
  const layerName = selectedLayer.name;
  run(e.submitter, 'Adding features…', async () => {
    const limit = Number($('l-limit').value);
    const r = await loadLayer({
      url: selectedLayer.url,
      where: $('l-where').value,
      bbox: $('l-view').checked ? mapBbox() : null,
      limit,
      onProgress: (n) => status(`Loaded ${n.toLocaleString()} so far…`, 'busy'),
    });
    if (!r.fc.features.length) return status('That layer has nothing matching your filter.', 'error');
    const tagged = r.fc.features.map((f, i) => ({
      ...f,
      properties: { ...f.properties, _type: 'other', _layer: layerName, _key: `${selectedLayer.url}#${f.id ?? f.properties?.OBJECTID ?? i}` },
    }));
    const added = addFeatures(tagged);
    $('source-note').textContent = r.copyright ? `Data: ${r.copyright}` : '';
    status(r.truncated
      ? `Added the first ${added.toLocaleString()}. There are more; raise "Most to add" or filter to get the rest.`
      : `Added ${plural(added, 'item', 'items')} from "${layerName}".`);
  });
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
