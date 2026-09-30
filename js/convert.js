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

export function geojsonToKml(fc, docName = 'Export') {
  const feats = fc.features || [];
  const placemarks = feats
    .map((f, i) => {
      const p = f.properties || {};
      const data = Object.entries(p)
        .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
        .map(([k, v]) => `<Data name="${esc(k)}"><value>${esc(v)}</value></Data>`)
        .join('');
      return (
        `<Placemark><name>${esc(featureName(f, i))}</name>` +
        (data ? `<ExtendedData>${data}</ExtendedData>` : '') +
        `<styleUrl>#s</styleUrl>${kmlGeometry(f.geometry)}</Placemark>`
      );
    })
    .join('\n');
  return clean(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(docName)}</name>` +
      `<Style id="s"><LineStyle><color>ff1f4fe2</color><width>2</width></LineStyle>` +
      `<PolyStyle><color>401f4fe2</color></PolyStyle></Style>\n${placemarks}\n</Document></kml>\n`
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
      `<gpx version="1.1" creator="maps.robertyoushock.com" xmlns="http://www.topografix.com/GPX/1/1">` +
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
