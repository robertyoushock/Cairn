// Pure conversion helpers: GeoJSON <-> KML / GPX, Esri JSON -> GeoJSON.
// No DOM access, so these run in the browser and in Node tests.

const NAME_KEYS = ['name', 'NAME', 'Name', 'BASENAME', 'label', 'LABEL', 'title', 'TITLE', 'GEOID', 'ZCTA5'];

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Strip characters that are illegal in XML 1.0.
function clean(s) {
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

export function featureName(f, i = 0) {
  const p = f.properties || {};
  for (const k of NAME_KEYS) {
    if (p[k] !== undefined && p[k] !== null && String(p[k]).trim() !== '') return String(p[k]);
  }
  return `Feature ${i + 1}`;
}

const r6 = (n) => Math.round(n * 1e6) / 1e6;
const kmlCoord = (c) => `${r6(c[0])},${r6(c[1])},${c[2] !== undefined ? c[2] : 0}`;
const kmlRing = (ring) => ring.map(kmlCoord).join(' ');

function kmlPolygon(rings) {
  const [outer, ...holes] = rings;
  return (
    `<Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlRing(outer)}</coordinates></LinearRing></outerBoundaryIs>` +
    holes
      .map((h) => `<innerBoundaryIs><LinearRing><coordinates>${kmlRing(h)}</coordinates></LinearRing></innerBoundaryIs>`)
      .join('') +
    `</Polygon>`
  );
}

export function kmlGeometry(g) {
  if (!g) return '';
  switch (g.type) {
    case 'Point':
      return `<Point><coordinates>${kmlCoord(g.coordinates)}</coordinates></Point>`;
    case 'LineString':
      return `<LineString><tessellate>1</tessellate><coordinates>${kmlRing(g.coordinates)}</coordinates></LineString>`;
    case 'Polygon':
      return kmlPolygon(g.coordinates);
    case 'MultiPoint':
    case 'MultiLineString':
    case 'MultiPolygon': {
      const single = g.type.replace('Multi', '');
      const inner = g.coordinates.map((c) => kmlGeometry({ type: single, coordinates: c })).join('');
      return `<MultiGeometry>${inner}</MultiGeometry>`;
    }
    case 'GeometryCollection':
      return `<MultiGeometry>${g.geometries.map(kmlGeometry).join('')}</MultiGeometry>`;
    default:
      return '';
  }
}

// "#rrggbb" plus opacity 0..1 -> KML's aabbggrr.
export function kmlColor(hex, opacity = 1) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '') || [, '1f', '4f', 'e2'];
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0');
  return (a + m[3] + m[2] + m[1]).toLowerCase();
}

// A point guaranteed to sit on the shape's biggest part, used to pin a name label to an area or line.
export function labelPoint(g) {
  if (!g) return null;
  if (g.type === 'Point') return g.coordinates;
  if (g.type === 'LineString') return g.coordinates[Math.floor(g.coordinates.length / 2)];
  if (g.type === 'MultiLineString') return labelPoint({ type: 'LineString', coordinates: g.coordinates.reduce((a, b) => (b.length > a.length ? b : a)) });
  const ringBox = (ring) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of ring) { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; }
    return [x0, y0, x1, y1];
  };
  if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    let best = null, bestArea = -1;
    for (const p of polys) {
      const b = ringBox(p[0]);
      const area = (b[2] - b[0]) * (b[3] - b[1]);
      if (area > bestArea) { bestArea = area; best = p[0]; }
    }
    if (!best) return null;
    // Scan across the middle of the ring and take the midpoint of the widest inside stretch,
    // so the label lands inside even for C-shaped areas.
    const b = ringBox(best);
    const y = (b[1] + b[3]) / 2;
    const xs = [];
    for (let i = 0; i < best.length - 1; i++) {
      const [x1, y1] = best[i];
      const [x2, y2] = best[i + 1];
      if ((y1 > y) !== (y2 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((p, q) => p - q);
    let span = -1, x = (b[0] + b[2]) / 2;
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > span) { span = xs[i + 1] - xs[i]; x = (xs[i] + xs[i + 1]) / 2; }
    return [x, y];
  }
  if (g.type === 'MultiPoint') return g.coordinates[0];
  if (g.type === 'GeometryCollection') return labelPoint(g.geometries[0]);
  return null;
}

export const KML_DEFAULTS = { line: '#1f4fe2', fill: '#1f4fe2', fillOpacity: 0.25, width: 2, labels: false, attributes: true };

export function geojsonToKml(fc, docName = 'Export', options = {}) {
  const o = { ...KML_DEFAULTS, ...options };
  const feats = fc.features || [];
  const placemarks = feats
    .map((f, i) => {
      const p = f.properties || {};
      const data = !o.attributes ? '' : Object.entries(p)
        .filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined && typeof v !== 'object')
        .map(([k, v]) => `<Data name="${esc(k)}"><value>${esc(v)}</value></Data>`)
        .join('');
      let geom = kmlGeometry(f.geometry);
      // Google Earth only draws a name next to a point, so areas and lines get an invisible pin to carry the label.
      if (o.labels && f.geometry && f.geometry.type !== 'Point' && f.geometry.type !== 'MultiPoint') {
        const lp = labelPoint(f.geometry);
        if (lp && lp.every(Number.isFinite)) {
          const inner = geom.startsWith('<MultiGeometry>') ? geom.slice(15, -16) : geom;
          geom = `<MultiGeometry><Point><coordinates>${kmlCoord(lp)}</coordinates></Point>${inner}</MultiGeometry>`;
        }
      }
      return (
        `<Placemark><name>${esc(featureName(f, i))}</name>` +
        (data ? `<ExtendedData>${data}</ExtendedData>` : '') +
        `<styleUrl>#s</styleUrl>${geom}</Placemark>`
      );
    })
    .join('\n');
  const hasPoints = feats.some((f) => f.geometry && /Point$/.test(f.geometry.type));
  // With labels on, pins on areas are hidden (scale 0) unless the data has real points to show.
  const icon = `<IconStyle><color>${kmlColor(o.line, 1)}</color><scale>${hasPoints ? 1 : 0}</scale></IconStyle>`;
  return clean(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(docName)}</name>` +
      `<Style id="s">${icon}<LabelStyle><scale>${o.labels || hasPoints ? 1 : 0}</scale></LabelStyle>` +
      `<LineStyle><color>${kmlColor(o.line, 1)}</color><width>${Number(o.width) || 2}</width></LineStyle>` +
      `<PolyStyle><color>${kmlColor(o.fill, o.fillOpacity)}</color></PolyStyle></Style>\n${placemarks}\n</Document></kml>\n`
  );
}

const gpxPt = (tag, c, name) =>
  `<${tag} lat="${r6(c[1])}" lon="${r6(c[0])}">` +
  (c[2] !== undefined && c[2] !== 0 ? `<ele>${c[2]}</ele>` : '') +
  (name ? `<name>${esc(name)}</name>` : '') +
  `</${tag}>`;

const gpxTrack = (name, lines) =>
  `<trk><name>${esc(name)}</name>` +
  lines.map((l) => `<trkseg>${l.map((c) => gpxPt('trkpt', c)).join('')}</trkseg>`).join('') +
  `</trk>`;

function gpxFromGeometry(g, name) {
  if (!g) return { wpt: '', trk: '' };
  switch (g.type) {
    case 'Point':
      return { wpt: gpxPt('wpt', g.coordinates, name), trk: '' };
    case 'MultiPoint':
      return { wpt: g.coordinates.map((c) => gpxPt('wpt', c, name)).join(''), trk: '' };
    case 'LineString':
      return { wpt: '', trk: gpxTrack(name, [g.coordinates]) };
    case 'MultiLineString':
      return { wpt: '', trk: gpxTrack(name, g.coordinates) };
    // GPX has no polygon type, so boundaries become closed tracks.
    case 'Polygon':
      return { wpt: '', trk: gpxTrack(name, g.coordinates) };
    case 'MultiPolygon':
      return { wpt: '', trk: gpxTrack(name, g.coordinates.flat()) };
    case 'GeometryCollection':
      return g.geometries.reduce(
        (a, sub) => {
          const r = gpxFromGeometry(sub, name);
          return { wpt: a.wpt + r.wpt, trk: a.trk + r.trk };
        },
        { wpt: '', trk: '' }
      );
    default:
      return { wpt: '', trk: '' };
  }
}

export function geojsonToGpx(fc, docName = 'Export') {
  let wpts = '';
  let trks = '';
  (fc.features || []).forEach((f, i) => {
    const r = gpxFromGeometry(f.geometry, featureName(f, i));
    wpts += r.wpt;
    trks += r.trk;
  });
  return clean(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<gpx version="1.1" creator="Cairn, robertyoushock.com/cairn" xmlns="http://www.topografix.com/GPX/1/1">` +
      `<metadata><name>${esc(docName)}</name></metadata>\n${wpts}\n${trks}\n</gpx>\n`
  );
}

// jszip is passed in so this file stays dependency-free.
export async function kmlToKmz(kmlString, JSZip) {
  const zip = new JSZip();
  zip.file('doc.kml', kmlString);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.google-earth.kmz', compression: 'DEFLATE' });
}

// ---- Esri JSON -> GeoJSON (fallback for servers without f=geojson) ----

function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a / 2;
}

export function esriToGeoJSON(esri) {
  const features = (esri.features || []).map((f) => {
    const g = f.geometry;
    let geometry = null;
    if (g) {
      if (g.x !== undefined && g.y !== undefined) {
        geometry = { type: 'Point', coordinates: [g.x, g.y] };
      } else if (g.points) {
        geometry = { type: 'MultiPoint', coordinates: g.points };
      } else if (g.paths) {
        geometry =
          g.paths.length === 1
            ? { type: 'LineString', coordinates: g.paths[0] }
            : { type: 'MultiLineString', coordinates: g.paths };
      } else if (g.rings) {
        // Esri outer rings are clockwise (negative area in a y-up frame); holes are counter-clockwise.
        const polys = [];
        for (const ring of g.rings) {
          if (ringArea(ring) <= 0 || polys.length === 0) polys.push([ring]);
          else polys[polys.length - 1].push(ring);
        }
        geometry =
          polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
      }
    }
    return { type: 'Feature', properties: f.attributes || {}, geometry };
  });
  return { type: 'FeatureCollection', features };
}

export function bboxOf(fc) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    } else c.forEach(walk);
  };
  const geoms = (g) => (!g ? [] : g.type === 'GeometryCollection' ? g.geometries.flatMap(geoms) : [g]);
  (fc.features || []).forEach((f) => geoms(f.geometry).forEach((g) => walk(g.coordinates)));
  return minX === Infinity ? null : [minX, minY, maxX, maxY];
}

// Like bboxOf, but ignores the few strays that sit far from everything else (a fire record with a
// mistyped longitude should not zoom the map out to the whole world). Small lists are used as they are.
export function bboxOfMost(fc) {
  const feats = (fc.features || []).filter((f) => f.geometry);
  if (feats.length < 40) return bboxOf(fc);
  const boxes = feats.map((f) => bboxOf({ features: [f] })).filter(Boolean);
  const mid = boxes.map((b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
  const pick = (i, q) => mid.map((m) => m[i]).sort((a, b) => a - b)[Math.min(mid.length - 1, Math.floor(q * mid.length))];
  const [x0, x1, y0, y1] = [pick(0, 0.02), pick(0, 0.98), pick(1, 0.02), pick(1, 0.98)];
  const out = [Infinity, Infinity, -Infinity, -Infinity];
  boxes.forEach((b, i) => {
    const [x, y] = mid[i];
    if (x < x0 || x > x1 || y < y0 || y > y1) return;
    out[0] = Math.min(out[0], b[0]); out[1] = Math.min(out[1], b[1]); out[2] = Math.max(out[2], b[2]); out[3] = Math.max(out[3], b[3]);
  });
  return out[0] === Infinity ? bboxOf(fc) : out;
}
