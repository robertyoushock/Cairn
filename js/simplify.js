// Make big shapes lighter before download, and estimate how large the file will be. Pure functions.

// Douglas-Peucker on one line or ring, tolerance in degrees. Iterative, so huge rings cannot overflow the stack.
export function simplifyLine(pts, tol) {
  const n = pts.length;
  if (tol <= 0 || n <= 2) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const dx = pts[b][0] - ax;
    const dy = pts[b][1] - ay;
    const len2 = dx * dx + dy * dy;
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] - ax;
      const py = pts[i][1] - ay;
      let d2;
      if (len2 === 0) d2 = px * px + py * py;
      else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const ex = px - t * dx;
        const ey = py - t * dy;
        d2 = ex * ex + ey * ey;
      }
      if (d2 > worst) { worst = d2; at = i; }
    }
    if (worst > t2 && at > 0) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// A ring must stay closed with at least four points, or map software rejects it.
function simplifyRing(ring, tol) {
  if (ring.length <= 4) return ring;
  // Split at the farthest point from the start so a closed ring does not collapse to a sliver.
  let far = 0;
  let best = -1;
  for (let i = 1; i < ring.length - 1; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const a = simplifyLine(ring.slice(0, far + 1), tol);
  const b = simplifyLine(ring.slice(far), tol);
  const out = a.concat(b.slice(1));
  return out.length >= 4 ? out : ring;
}

export function simplifyGeometry(g, tol) {
  if (!g || tol <= 0) return g;
  switch (g.type) {
    case 'LineString': return { ...g, coordinates: simplifyLine(g.coordinates, tol) };
    case 'MultiLineString': return { ...g, coordinates: g.coordinates.map((l) => simplifyLine(l, tol)) };
    case 'Polygon': return { ...g, coordinates: g.coordinates.map((r) => simplifyRing(r, tol)) };
    case 'MultiPolygon': return { ...g, coordinates: g.coordinates.map((p) => p.map((r) => simplifyRing(r, tol))) };
    case 'GeometryCollection': return { ...g, geometries: g.geometries.map((x) => simplifyGeometry(x, tol)) };
    default: return g;
  }
}

export const DETAIL_LEVELS = {
  full: { label: 'Full detail', tol: 0 },
  light: { label: 'Slightly simplified (about 30 ft)', tol: 0.0001 },
  medium: { label: 'Simplified (about 150 ft)', tol: 0.0005 },
  small: { label: 'Smallest file (about 700 ft)', tol: 0.002 },
};

export function simplifyCollection(fc, level = 'full') {
  const tol = DETAIL_LEVELS[level]?.tol || 0;
  if (!tol) return fc;
  return { ...fc, features: fc.features.map((f) => ({ ...f, geometry: simplifyGeometry(f.geometry, tol) })) };
}

export function countPoints(fc) {
  let n = 0;
  const walk = (c) => { if (typeof c[0] === 'number') n++; else c.forEach(walk); };
  const geoms = (g) => (!g ? [] : g.type === 'GeometryCollection' ? g.geometries.flatMap(geoms) : [g]);
  (fc.features || []).forEach((f) => geoms(f.geometry).forEach((g) => walk(g.coordinates)));
  return n;
}

// Rough bytes per point and per item for each format; measured against real exports, good to about 20%.
const PER = { kml: [24, 260], kmz: [7, 80], gpx: [44, 90], geojson: [22, 60] };
export function estimateBytes(fc, fmt, { attributes = true } = {}) {
  const [perPoint, perFeature] = PER[fmt] || PER.kml;
  const feats = fc.features || [];
  let attrs = 0;
  if (attributes && fmt !== 'gpx') {
    // Sample attributes so a 50,000-item list stays quick to measure.
    const step = Math.max(1, Math.floor(feats.length / 200));
    let sampled = 0;
    let bytes = 0;
    for (let i = 0; i < feats.length; i += step) { bytes += JSON.stringify(feats[i].properties || {}).length; sampled++; }
    attrs = sampled ? (bytes / sampled) * feats.length * (fmt === 'kml' ? 2.2 : fmt === 'kmz' ? 0.5 : 1) : 0;
  }
  return Math.round(countPoints(fc) * perPoint + feats.length * perFeature + attrs);
}

export const prettyBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`);

// Plain-language warnings about limits in the places people take these files.
export function sizeWarnings(bytes, featureCount, fmt) {
  const out = [];
  const MB = 1048576;
  if ((fmt === 'kml' || fmt === 'kmz') && bytes > 5 * MB) out.push('Google My Maps only accepts files up to 5 MB. Pick a smaller detail level, or use Google Earth, which takes bigger files.');
  if ((fmt === 'kml' || fmt === 'kmz') && featureCount > 2000) out.push('Google My Maps shows at most 2,000 items per layer. Google Earth has no such limit.');
  if (fmt === 'gpx' && bytes > 10 * MB) out.push('Many GPS apps and watches struggle with GPX files over 10 MB. Pick a smaller detail level.');
  if (bytes > 50 * MB) out.push('This file is very large and may be slow to open. Consider a smaller detail level or fewer items.');
  return out;
}
