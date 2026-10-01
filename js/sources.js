// Data access: Census TIGERweb boundaries and generic ArcGIS REST / portal search.
import { esriToGeoJSON } from './convert.js';

const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb';

export const STATES = {
  '01': 'Alabama', '02': 'Alaska', '04': 'Arizona', '05': 'Arkansas', '06': 'California',
  '08': 'Colorado', '09': 'Connecticut', '10': 'Delaware', '11': 'District of Columbia', '12': 'Florida',
  '13': 'Georgia', '15': 'Hawaii', '16': 'Idaho', '17': 'Illinois', '18': 'Indiana', '19': 'Iowa',
  '20': 'Kansas', '21': 'Kentucky', '22': 'Louisiana', '23': 'Maine', '24': 'Maryland',
  '25': 'Massachusetts', '26': 'Michigan', '27': 'Minnesota', '28': 'Mississippi', '29': 'Missouri',
  '30': 'Montana', '31': 'Nebraska', '32': 'Nevada', '33': 'New Hampshire', '34': 'New Jersey',
  '35': 'New Mexico', '36': 'New York', '37': 'North Carolina', '38': 'North Dakota', '39': 'Ohio',
  '40': 'Oklahoma', '41': 'Oregon', '42': 'Pennsylvania', '44': 'Rhode Island', '45': 'South Carolina',
  '46': 'South Dakota', '47': 'Tennessee', '48': 'Texas', '49': 'Utah', '50': 'Vermont',
  '51': 'Virginia', '53': 'Washington', '54': 'West Virginia', '55': 'Wisconsin', '56': 'Wyoming',
  '72': 'Puerto Rico',
};

// Layer ids change with each Census vintage, so layers are found by name at run time.
export const BOUNDARY_TYPES = {
  zip: {
    label: 'ZIP codes (ZCTA)',
    service: 'PUMA_TAD_TAZ_UGA_ZCTA',
    layer: /ZIP Code Tabulation Areas/i,
    needsState: false,
    hint: 'Enter ZIP codes separated by commas. Use 802* for every ZIP starting with 802.',
    placeholder: '80202, 80203, 802*',
  },
  sldl: {
    label: 'State house districts',
    service: 'Legislative',
    layer: /State Legislative Districts - Lower/i,
    needsState: true,
    fieldPrefix: 'SLDL',
    hint: 'Enter district numbers separated by commas. Leave blank for the whole state.',
    placeholder: '1, 2, 18',
  },
  sldu: {
    label: 'State senate districts',
    service: 'Legislative',
    layer: /State Legislative Districts - Upper/i,
    needsState: true,
    fieldPrefix: 'SLDU',
    hint: 'Enter district numbers separated by commas. Leave blank for the whole state.',
    placeholder: '1, 2, 18',
  },
  cd: {
    label: 'Congressional districts',
    service: 'Legislative',
    layer: /Congressional Districts/i,
    needsState: true,
    fieldPrefix: 'CD',
    hint: 'Enter district numbers separated by commas. Leave blank for the whole state.',
    placeholder: '1, 2',
  },
  county: {
    label: 'Counties',
    service: 'State_County',
    layer: /^Counties$/i,
    needsState: true,
    fieldPrefix: 'BASENAME',
    hint: 'Enter county names separated by commas. Leave blank for the whole state.',
    placeholder: 'Denver, Jefferson',
  },
};

async function getJson(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(
      `Could not reach ${new URL(url).host}. The server may be down or may not allow browser requests (CORS).`
    );
  }
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}.`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || `ArcGIS error ${json.error.code}`);
  return json;
}

const layerCache = new Map();

async function resolveLayer(type) {
  const t = BOUNDARY_TYPES[type];
  const key = `${t.service}|${t.layer}`;
  if (layerCache.has(key)) return layerCache.get(key);
  const svc = await getJson(`${TIGER}/${t.service}/MapServer?f=json`);
  // Top-level layers only; the newest vintage is listed first. Some services repeat a layer
  // at several map scales, so prefer the one that stays on to the closest zoom (most detailed).
  const top = (svc.layers || [])
    .filter((l) => l.parentLayerId === -1 && l.type !== 'Group Layer' && t.layer.test(l.name))
    .sort((a, b) => (a.maxScale ?? 0) - (b.maxScale ?? 0));
  if (!top.length) throw new Error(`Census service no longer lists a layer matching ${t.label}.`);
  const url = `${TIGER}/${t.service}/MapServer/${top[0].id}`;
  const info = await getJson(`${url}?f=json`);
  const out = { url, name: top[0].name, fields: (info.fields || []).map((f) => f.name) };
  layerCache.set(key, out);
  return out;
}

const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;
const tokens = (s) => s.split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean);

function buildWhere(type, layer, state, input) {
  const t = BOUNDARY_TYPES[type];
  const parts = [];
  const items = tokens(input);
  if (type === 'zip') {
    if (!items.length) return null;
    const exact = [], prefixes = [];
    for (const i of items) {
      if (!/^\d{1,5}\*?$/.test(i)) throw new Error(`"${i}" is not a ZIP code. Use digits only, like 80202 or 802*.`);
      if (i.endsWith('*') || i.length < 5) prefixes.push(i.replace('*', ''));
      else exact.push(i);
    }
    const w = [];
    // GEOID holds the ZIP code. The ZCTA5 field rejects where clauses on this service.
    if (exact.length) w.push(`GEOID IN (${exact.map(sqlStr).join(',')})`);
    prefixes.forEach((p) => w.push(`GEOID LIKE '${p}%'`));
    return w.join(' OR ');
  }
  if (t.needsState) {
    if (!state) throw new Error('Choose a state.');
    parts.push(`STATE = ${sqlStr(state)}`);
  }
  if (items.length) {
    if (type === 'county') {
      parts.push('(' + items.map((n) => `UPPER(BASENAME) LIKE ${sqlStr(n.toUpperCase().replace(/ COUNTY$/, '') + '%')}`).join(' OR ') + ')');
    } else {
      // Congressional layers name the field after the session (CD120, CD119...); CDSESSN is not it.
      const field = layer.fields.find((f) => (type === 'cd' ? /^CD\d+$/.test(f) : f === t.fieldPrefix));
      if (!field) throw new Error('Could not find the district field on this Census layer.');
      const vals = items.map((n) => {
        if (!/^\d{1,3}$/.test(n)) throw new Error(`"${n}" is not a district number.`);
        return sqlStr(field.startsWith('CD') ? n.padStart(2, '0') : n.padStart(3, '0'));
      });
      parts.push(`${field} IN (${vals.join(',')})`);
    }
  }
  return parts.join(' AND ') || '1=1';
}

// Give every Census feature a friendly label and a stable key so lists and de-duplication work.
export function decorate(type, f) {
  const p = f.properties || {};
  const id = p.GEOID || p.OID || p.OBJECTID || p.NAME;
  const name = type === 'zip' ? `ZIP ${p.GEOID || p.BASENAME}` : p.NAME || p.BASENAME || String(id);
  return { ...f, properties: { ...p, name, _type: type, _key: `${type}:${id}` } };
}

const ZIP_FIELDS = 'GEOID,BASENAME,NAME,AREALAND,AREAWATER,INTPTLAT,INTPTLON,POP100,HU100';
const ID_ORDER = ['zip', 'sldl', 'sldu', 'cd', 'county'];

// What boundaries cover this exact point? Asks every Census layer at once; a layer that fails is skipped.
export async function identifyAt(lng, lat) {
  const jobs = ID_ORDER.map(async (type) => {
    const layer = await resolveLayer(type);
    const params = new URLSearchParams({
      geometry: `${lng},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      where: '1=1',
      outFields: type === 'zip' ? ZIP_FIELDS : '*',
      outSR: '4326',
      returnGeometry: 'true',
      geometryPrecision: '6',
      f: 'geojson',
    });
    const fc = await getJson(`${layer.url}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    return (fc.features || []).map((f) => decorate(type, f));
  });
  const settled = await Promise.allSettled(jobs);
  const features = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const failed = settled.filter((r) => r.status === 'rejected').length;
  return { features, failed };
}

export async function queryBoundaries({ type, state, input, bbox }) {
  const layer = await resolveLayer(type);
  let where = buildWhere(type, layer, state, input);
  if (where === null) {
    if (!bbox) throw new Error('Enter at least one ZIP code, or tick "Only what is in the map view".');
    where = '1=1';
  }
  const params = new URLSearchParams({
    where,
    // The ZCTA layer's ZCTA5 column breaks "*" queries, so ask for fields by name there.
    outFields: type === 'zip' ? ZIP_FIELDS : '*',
    outSR: '4326',
    returnGeometry: 'true',
    geometryPrecision: '6',
    resultRecordCount: '2000',
    f: 'geojson',
  });
  if (bbox) {
    params.set('geometry', bbox.join(','));
    params.set('geometryType', 'esriGeometryEnvelope');
    params.set('inSR', '4326');
    params.set('spatialRel', 'esriSpatialRelIntersects');
  }
  const fc = await getJson(`${layer.url}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  fc.features = (fc.features || []).map((f) => decorate(type, f));
  return { fc, source: `US Census Bureau TIGERweb, ${layer.name}` };
}

// ---------- Generic ArcGIS ----------

export async function searchPortal(portal, text, kind) {
  const base = (portal || 'https://www.arcgis.com').replace(/\/+$/, '').replace(/\/sharing\/rest$/, '');
  const types =
    kind === 'all'
      ? '(type:"Feature Service" OR type:"Map Service")'
      : kind === 'map'
      ? 'type:"Map Service"'
      : 'type:"Feature Service"';
  const q = `${text} ${types}`;
  // Default ordering is by relevance, which suits plain-language searches better than popularity.
  const p = new URLSearchParams({ q, num: '25', f: 'json' });
  const json = await getJson(`${base}/sharing/rest/search?${p}`);
  return (json.results || []).map((r) => ({
    id: r.id,
    title: r.title,
    owner: r.owner,
    url: r.url,
    type: r.type,
    snippet: r.snippet || '',
    views: r.numViews,
  }));
}

// Look at a URL and say what it is: a folder/services list, a service with layers, or a single layer.
export async function inspectUrl(rawUrl) {
  const url = rawUrl.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error('Paste a full URL that starts with https://');
  const json = await getJson(`${url}?f=json`);
  if (json.type === 'Feature Layer' || json.type === 'Table' || (json.geometryType && json.fields)) {
    return { kind: 'layer', url, name: json.name, info: json };
  }
  if (json.layers || json.tables) {
    const layers = (json.layers || []).filter((l) => l.subLayerIds == null).map((l) => ({ id: l.id, name: l.name }));
    return { kind: 'service', url, name: json.mapName || json.serviceDescription || url.split('/').slice(-2, -1)[0], layers };
  }
  if (json.services || json.folders) {
    return {
      kind: 'directory',
      url,
      folders: (json.folders || []).map((f) => ({ name: f, url: `${url}/${f}` })),
      services: (json.services || [])
        .filter((s) => /^(Feature|Map)Server$/.test(s.type))
        .map((s) => ({ name: s.name, url: `${url.replace(/\/rest\/services.*$/, '/rest/services')}/${s.name}/${s.type}` })),
    };
  }
  throw new Error('That URL did not look like an ArcGIS REST service, layer or services folder.');
}

export async function loadLayer({ url, where = '1=1', bbox = null, limit = 10000, onProgress = () => {} }) {
  const info = await getJson(`${url}?f=json`);
  const pageSize = Math.min(info.maxRecordCount || 1000, 2000);
  const features = [];
  let offset = 0;
  let truncated = false;
  let useGeoJson = true;
  for (;;) {
    const params = new URLSearchParams({
      where: where || '1=1',
      outFields: '*',
      outSR: '4326',
      returnGeometry: 'true',
      geometryPrecision: '6',
      resultOffset: String(offset),
      resultRecordCount: String(Math.min(pageSize, limit - features.length)),
      f: useGeoJson ? 'geojson' : 'json',
    });
    if (bbox) {
      params.set('geometry', bbox.join(','));
      params.set('geometryType', 'esriGeometryEnvelope');
      params.set('inSR', '4326');
      params.set('spatialRel', 'esriSpatialRelIntersects');
    }
    let res;
    try {
      res = await getJson(`${url}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });
    } catch (e) {
      if (useGeoJson && features.length === 0 && /format|geojson/i.test(e.message)) {
        useGeoJson = false;
        continue;
      }
      throw e;
    }
    const fc = useGeoJson ? res : esriToGeoJSON(res);
    features.push(...(fc.features || []));
    onProgress(features.length);
    const more = res.exceededTransferLimit || res.properties?.exceededTransferLimit || (fc.features || []).length === pageSize;
    if (features.length >= limit) {
      truncated = more || features.length > limit;
      break;
    }
    if (!more || !(fc.features || []).length) break;
    offset += (fc.features || []).length;
  }
  return {
    fc: { type: 'FeatureCollection', features: features.slice(0, limit) },
    truncated,
    name: info.name,
    copyright: info.copyrightText || '',
    geometryType: info.geometryType,
  };
}

// ---------- Place search (OpenStreetMap Nominatim; one request per search, never per keystroke) ----------

export async function searchPlaces(text) {
  const params = new URLSearchParams({ q: text, format: 'jsonv2', limit: '5', countrycodes: 'us' });
  const rows = await getJson(`https://nominatim.openstreetmap.org/search?${params}`);
  return rows.map((r) => ({
    name: r.display_name,
    lng: Number(r.lon),
    lat: Number(r.lat),
    // Nominatim gives [south, north, west, east]; MapLibre wants [west, south, east, north].
    bbox: r.boundingbox ? [Number(r.boundingbox[2]), Number(r.boundingbox[0]), Number(r.boundingbox[3]), Number(r.boundingbox[1])] : null,
  }));
}
