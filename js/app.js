import { geojsonToKml, geojsonToGpx, kmlToKmz, featureName, bboxOf } from './convert.js';
import { STATES, BOUNDARY_TYPES, queryBoundaries, searchPortal, inspectUrl, loadLayer } from './sources.js';

const $ = (id) => document.getElementById(id);

// ---------- Map ----------
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  },
  center: [-98.5, 39.5],
  zoom: 3.6,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

const EMPTY = { type: 'FeatureCollection', features: [] };
let current = EMPTY;
let currentLabel = 'boundaries';

map.on('load', () => {
  map.addSource('data', { type: 'geojson', data: EMPTY, generateId: true });
  map.addLayer({ id: 'data-fill', type: 'fill', source: 'data', filter: ['==', '$type', 'Polygon'],
    paint: { 'fill-color': '#ffc933', 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.5, 0.28] } });
  map.addLayer({ id: 'data-line', type: 'line', source: 'data', filter: ['!=', '$type', 'Point'],
    paint: { 'line-color': '#0a4349', 'line-width': 2 } });
  map.addLayer({ id: 'data-point', type: 'circle', source: 'data', filter: ['==', '$type', 'Point'],
    paint: { 'circle-radius': 5, 'circle-color': '#ffc933', 'circle-stroke-color': '#0a4349', 'circle-stroke-width': 2 } });

  let hovered = null;
  map.on('mousemove', 'data-fill', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    if (hovered !== null) map.setFeatureState({ source: 'data', id: hovered }, { hover: false });
    hovered = e.features[0].id;
    map.setFeatureState({ source: 'data', id: hovered }, { hover: true });
  });
  map.on('mouseleave', 'data-fill', () => {
    map.getCanvas().style.cursor = '';
    if (hovered !== null) map.setFeatureState({ source: 'data', id: hovered }, { hover: false });
    hovered = null;
  });
  for (const layer of ['data-fill', 'data-line', 'data-point']) {
    map.on('click', layer, (e) => showPopup(e.features[0], e.lngLat));
  }
});

function showPopup(feature, lngLat) {
  // Built with DOM nodes, never innerHTML: attribute values come from third-party servers.
  const box = document.createElement('div');
  const h = document.createElement('h3');
  h.textContent = featureName({ properties: feature.properties });
  box.append(h);
  const table = document.createElement('table');
  for (const [k, v] of Object.entries(feature.properties)) {
    if (v === null || v === '' || k === 'STGEOMETRY' || k === 'name') continue;
    const tr = table.insertRow();
    tr.insertCell().textContent = k;
    tr.insertCell().textContent = String(v);
  }
  box.append(table);
  new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(lngLat).setDOMContent(box).addTo(map);
}

function mapBbox() {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

// ---------- Status ----------
function status(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = kind;
}

async function run(button, label, fn) {
  button.disabled = true;
  status(label, 'busy');
  try {
    await fn();
  } catch (e) {
    status(e.message || String(e), 'error');
  } finally {
    button.disabled = false;
  }
}

// ---------- Results ----------
function show(fc, { label, source, note = '' }) {
  current = fc;
  currentLabel = label;
  map.getSource('data').setData(fc);
  const box = bboxOf(fc);
  if (box) map.fitBounds([[box[0], box[1]], [box[2], box[3]]], { padding: 48, duration: 600, maxZoom: 15 });

  const n = fc.features.length;
  $('results').hidden = n === 0;
  $('results-title').textContent = `${n.toLocaleString()} ${n === 1 ? 'feature' : 'features'}`;
  $('x-name').value = label;
  $('source-note').textContent = source ? `Data: ${source}` : '';
  $('x-note').textContent = fc.features.some((f) => /Polygon/.test(f.geometry?.type || ''))
    ? 'GPX has no polygon type, so boundaries are saved as closed tracks.'
    : '';

  const list = $('feature-list');
  list.replaceChildren();
  fc.features.slice(0, 300).forEach((f, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = featureName(f, i);
    b.addEventListener('click', () => {
      const bb = bboxOf({ features: [f] });
      if (bb) map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, duration: 500, maxZoom: 16 });
    });
    li.append(b);
    list.append(li);
  });

  if (n === 0) status('No features matched. Check the values or widen the filter.', 'error');
  else status(note || `Loaded ${n.toLocaleString()} ${n === 1 ? 'feature' : 'features'}.`);
}

// ---------- Tabs ----------
function selectTab(name) {
  for (const t of ['census', 'arcgis']) {
    const on = t === name;
    $(`tab-${t}`).setAttribute('aria-selected', String(on));
    $(`tab-${t}`).tabIndex = on ? 0 : -1;
    $(`view-${t}`).hidden = !on;
  }
}
$('tab-census').addEventListener('click', () => selectTab('census'));
$('tab-arcgis').addEventListener('click', () => selectTab('arcgis'));
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const next = $('tab-census').getAttribute('aria-selected') === 'true' ? 'arcgis' : 'census';
    selectTab(next);
    $(`tab-${next}`).focus();
  }
});

// ---------- Census boundaries ----------
const typeSel = $('b-type');
for (const [k, t] of Object.entries(BOUNDARY_TYPES)) typeSel.add(new Option(t.label, k));
const stateSel = $('b-state');
for (const [fips, name] of Object.entries(STATES)) stateSel.add(new Option(name, fips));
stateSel.value = '08';

function syncCensusForm() {
  const t = BOUNDARY_TYPES[typeSel.value];
  $('b-state-wrap').hidden = !t.needsState;
  $('b-input').placeholder = t.placeholder;
  $('b-hint').textContent = t.hint;
  $('b-input-label').textContent = typeSel.value === 'county' ? 'County names' : typeSel.value === 'zip' ? 'ZIP codes' : 'District numbers';
}
typeSel.addEventListener('change', syncCensusForm);
syncCensusForm();

$('census-form').addEventListener('submit', (e) => {
  e.preventDefault();
  run(e.submitter || e.target.querySelector('.primary'), 'Asking the Census Bureau…', async () => {
    const type = typeSel.value;
    const { fc, source } = await queryBoundaries({
      type,
      state: stateSel.value,
      input: $('b-input').value,
      bbox: $('b-view').checked ? mapBbox() : null,
    });
    const t = BOUNDARY_TYPES[type];
    const label = [type === 'zip' ? 'zip-codes' : t.label.toLowerCase().replace(/\s+/g, '-'), t.needsState ? STATES[stateSel.value].toLowerCase().replace(/\s+/g, '-') : '']
      .filter(Boolean).join('-');
    const capped = fc.features.length >= 2000 ? 'Showing the first 2,000 matches. Narrow the search to get the rest.' : '';
    show(fc, { label, source, note: capped });
  });
});

// ---------- ArcGIS ----------
let selectedLayer = null;

function renderPicklist(items) {
  const ul = $('browse-list');
  ul.replaceChildren();
  for (const it of items) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = it.title;
    b.append(t);
    if (it.sub) {
      const s = document.createElement('span');
      s.className = 's';
      s.textContent = it.sub;
      b.append(s);
    }
    b.addEventListener('click', it.onPick);
    li.append(b);
    ul.append(li);
  }
  if (!items.length) {
    const li = document.createElement('li');
    li.style.padding = '10px';
    li.textContent = 'Nothing found.';
    ul.append(li);
  }
}

function showBrowse(title, items) {
  $('browse').hidden = false;
  $('browse-title').textContent = title;
  renderPicklist(items);
}

async function openUrl(url) {
  const r = await inspectUrl(url);
  $('u-url').value = r.url;
  if (r.kind === 'layer') return pickLayer(r.url, r.name);
  if (r.kind === 'service') {
    showBrowse(`${r.name || 'Service'}: choose a layer`, r.layers.map((l) => ({
      title: l.name, sub: `Layer ${l.id}`, onPick: () => pickLayer(`${r.url}/${l.id}`, l.name),
    })));
    return status(`${r.layers.length} layers found.`);
  }
  const items = [
    ...r.folders.map((f) => ({ title: `${f.name}/`, sub: 'Folder', onPick: () => run($('url-form').querySelector('button'), 'Opening folder…', () => openUrl(f.url)) })),
    ...r.services.map((s) => ({ title: s.name, sub: s.url.split('/').pop(), onPick: () => run($('url-form').querySelector('button'), 'Opening service…', () => openUrl(s.url)) })),
  ];
  showBrowse('Folders and services', items);
  status(`${items.length} items found.`);
}

function pickLayer(url, name) {
  selectedLayer = { url, name };
  $('layer-form').hidden = false;
  $('layer-title').textContent = name || 'Layer';
  status(`Selected ${name || 'layer'}. Set a filter if you want one, then load it.`);
  $('layer-form').scrollIntoView({ block: 'nearest' });
}

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('s-text').value.trim();
  if (!text) return status('Type something to search for.', 'error');
  run(e.target.querySelector('.primary'), 'Searching…', async () => {
    const res = await searchPortal($('s-portal').value, text, $('s-kind').value);
    showBrowse(`${res.length} results`, res.map((r) => ({
      title: r.title,
      sub: `${r.type} by ${r.owner}${r.views ? `, ${r.views.toLocaleString()} views` : ''}`,
      onPick: () => run(e.target.querySelector('.primary'), 'Opening service…', () => openUrl(r.url)),
    })));
    status(res.length ? 'Pick a result to see its layers.' : 'No public services matched that search.', res.length ? '' : 'error');
  });
});

$('url-form').addEventListener('submit', (e) => {
  e.preventDefault();
  run(e.target.querySelector('button'), 'Reading the URL…', () => openUrl($('u-url').value));
});

$('layer-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!selectedLayer) return;
  run(e.target.querySelector('.primary'), 'Loading features…', async () => {
    const r = await loadLayer({
      url: selectedLayer.url,
      where: $('l-where').value,
      bbox: $('l-view').checked ? mapBbox() : null,
      limit: Number($('l-limit').value),
      onProgress: (n) => status(`Loaded ${n.toLocaleString()} features…`, 'busy'),
    });
    const slug = (selectedLayer.name || 'layer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    show(r.fc, {
      label: slug || 'layer',
      source: r.copyright || selectedLayer.url,
      note: r.truncated ? `Stopped at the ${Number($('l-limit').value).toLocaleString()} feature limit. Raise it or add a filter for the rest.` : '',
    });
  });
});

// ---------- Export ----------
function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

document.querySelector('.formats').addEventListener('click', async (e) => {
  const fmt = e.target.dataset?.fmt;
  if (!fmt || !current.features.length) return;
  const base = ($('x-name').value.trim() || currentLabel).replace(/[^\w.-]+/g, '-');
  const title = $('x-name').value.trim() || currentLabel;
  try {
    if (fmt === 'kml') download(new Blob([geojsonToKml(current, title)], { type: 'application/vnd.google-earth.kml+xml' }), `${base}.kml`);
    if (fmt === 'kmz') download(await kmlToKmz(geojsonToKml(current, title), JSZip), `${base}.kmz`);
    if (fmt === 'gpx') download(new Blob([geojsonToGpx(current, title)], { type: 'application/gpx+xml' }), `${base}.gpx`);
    if (fmt === 'geojson') download(new Blob([JSON.stringify(current)], { type: 'application/geo+json' }), `${base}.geojson`);
  } catch (err) {
    status(`Could not build the ${fmt.toUpperCase()} file: ${err.message}`, 'error');
  }
});

// ---------- Mobile panel ----------
$('panel-toggle').addEventListener('click', () => {
  const panel = $('panel');
  const collapsed = panel.classList.toggle('collapsed');
  $('panel-toggle').textContent = collapsed ? 'Show panel' : 'Hide panel';
  $('panel-toggle').setAttribute('aria-expanded', String(!collapsed));
  map.resize();
});
