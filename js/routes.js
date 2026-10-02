// Routes: directions between stops, plane + car trips, and reading Google Maps links.
// Directions come from free, open servers. Nothing here can run up a bill.

const OSRM = 'https://routing.openstreetmap.de';
const OSRM_PROFILE = { car: 'routed-car', bike: 'routed-bike', walk: 'routed-foot' };
export const MODES = {
  car: { label: 'Drive', verb: 'Drive' },
  bike: { label: 'Bike', verb: 'Bike' },
  walk: { label: 'Walk', verb: 'Walk' },
  plane: { label: 'Fly + drive', verb: 'Fly' },
};
export const MAX_STOPS = 25;

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function distanceKm(a, b) {
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The curved line a plane follows between two points.
export function greatCircle(a, b, steps = 64) {
  const [l1, p1, l2, p2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d === 0) return [a, b];
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    out.push([Number(deg(Math.atan2(y, x)).toFixed(6)), Number(deg(Math.atan2(z, Math.sqrt(x * x + y * y))).toFixed(6))]);
  }
  return out;
}

// The airport a traveler would realistically use: the closest one, with a nudge toward big airports
// so a major hub 40 miles away beats a tiny regional strip 30 miles away.
export function pickAirport(point, airports) {
  let best = null;
  let bestScore = Infinity;
  for (const a of airports) {
    const d = distanceKm(point, [a.lng, a.lat]);
    const score = d + (a.big ? 0 : 60);
    if (score < bestScore) { bestScore = score; best = { ...a, km: d }; }
  }
  return best;
}

export function planFlight(start, end, airports) {
  const from = pickAirport(start, airports);
  const to = pickAirport(end, airports);
  if (!from || !to) throw new Error('No airports found for this trip.');
  if (from.code === to.code || distanceKm([from.lng, from.lat], [to.lng, to.lat]) < 250) {
    throw new Error('These two places are close enough to drive. Pick Drive, or choose stops farther apart.');
  }
  return { from, to };
}

export const miles = (m) => m / 1609.344;
export function prettyDistance(m) {
  const mi = miles(m);
  return mi < 0.2 ? `${Math.round(m * 3.28084)} ft` : `${mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString()} mi`;
}
export function prettyDuration(s) {
  const min = Math.round(s / 60);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.floor(min / 60);
  return `${h} hr${min % 60 ? ` ${min % 60} min` : ''}`;
}

async function fetchJson(url, init) {
  let res;
  try { res = await fetch(url, init); } catch { throw new Error('Could not reach the directions service. Check your connection and try again.'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || body.error || body.message || `The directions service answered ${res.status}.`);
  return body;
}

// One leg by road. Returns { coordinates, distance (m), duration (s), provider }.
export async function roadLeg(points, mode, { relay = '' } = {}) {
  if (points.length < 2) throw new Error('Add at least two stops.');
  if (points.length > MAX_STOPS) throw new Error(`Routes can have at most ${MAX_STOPS} stops.`);
  if (relay) {
    try {
      const j = await fetchJson(`${relay.replace(/\/+$/, '')}/route`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, points }),
      });
      const f = j.features?.[0];
      if (f?.geometry?.coordinates?.length) {
        return { coordinates: f.geometry.coordinates.map((c) => [c[0], c[1]]), distance: f.properties.summary.distance, duration: f.properties.summary.duration, provider: 'OpenRouteService' };
      }
    } catch {
      // Fall through to the keyless server: quota used up, key missing, or relay down.
    }
  }
  const path = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');
  const j = await fetchJson(`${OSRM}/${OSRM_PROFILE[mode]}/route/v1/driving/${path}?overview=full&geometries=geojson&continue_straight=false`);
  const r = j.routes?.[0];
  if (j.code !== 'Ok' || !r) throw new Error(j.code === 'NoRoute' ? 'No route found between these stops. Try moving a stop closer to a road.' : 'The directions service could not build this route.');
  return { coordinates: r.geometry.coordinates, distance: r.distance, duration: r.duration, provider: 'OSRM (FOSSGIS)' };
}

const lineFeature = (name, coordinates, props) => ({ type: 'Feature', properties: { name, ...props }, geometry: { type: 'LineString', coordinates } });

// Build the whole trip as map features, plus a one-line summary.
// stops: [{ lng, lat, label }]. For plane mode only the first and last stops are used.
export async function buildRoute(stops, mode, { relay = '', airports = [] } = {}) {
  if (stops.length < 2) throw new Error('Add at least two stops.');
  const first = stops[0];
  const last = stops[stops.length - 1];
  const label = (s, i) => s.label || `Stop ${i + 1}`;
  const title = `${label(first, 0)} to ${label(last, stops.length - 1)}`;
  if (mode !== 'plane') {
    const leg = await roadLeg(stops.map((s) => [s.lng, s.lat]), mode, { relay });
    const sum = `${prettyDistance(leg.distance)}, about ${prettyDuration(leg.duration)}`;
    return {
      features: [lineFeature(`${MODES[mode].verb}: ${title} (${prettyDistance(leg.distance)})`, leg.coordinates, {
        mode: MODES[mode].label, distance_miles: Number(miles(leg.distance).toFixed(2)), duration_minutes: Math.round(leg.duration / 60), directions_by: leg.provider,
      })],
      summary: `${MODES[mode].label}: ${sum}`,
      provider: leg.provider,
    };
  }
  const { from, to } = planFlight([first.lng, first.lat], [last.lng, last.lat], airports);
  const [out, back] = await Promise.all([
    roadLeg([[first.lng, first.lat], [from.lng, from.lat]], 'car', { relay }),
    roadLeg([[to.lng, to.lat], [last.lng, last.lat]], 'car', { relay }),
  ]);
  const arc = greatCircle([from.lng, from.lat], [to.lng, to.lat]);
  const airM = distanceKm([from.lng, from.lat], [to.lng, to.lat]) * 1000;
  // Cruise at about 500 mph plus half an hour for taxi, climb and descent. A rough guide, not a schedule.
  const airS = (airM / 1000 / 800) * 3600 + 1800;
  const features = [
    lineFeature(`Drive: ${label(first, 0)} to ${from.code} (${prettyDistance(out.distance)})`, out.coordinates, { mode: 'Drive', distance_miles: Number(miles(out.distance).toFixed(2)), duration_minutes: Math.round(out.duration / 60) }),
    lineFeature(`Fly: ${from.code} to ${to.code} (${prettyDistance(airM)})`, arc, { mode: 'Fly', from_airport: from.name, to_airport: to.name, distance_miles: Number(miles(airM).toFixed(0)), duration_minutes: Math.round(airS / 60) }),
    lineFeature(`Drive: ${to.code} to ${label(last, stops.length - 1)} (${prettyDistance(back.distance)})`, back.coordinates, { mode: 'Drive', distance_miles: Number(miles(back.distance).toFixed(2)), duration_minutes: Math.round(back.duration / 60) }),
  ];
  return {
    features,
    summary: `Drive ${prettyDistance(out.distance)} to ${from.code}, fly ${prettyDistance(airM)} to ${to.code}, drive ${prettyDistance(back.distance)}. About ${prettyDuration(out.duration + airS + back.duration)} in motion, not counting the airport.`,
    provider: out.provider,
    airports: { from, to },
    ignoredStops: Math.max(0, stops.length - 2),
  };
}

// ---------- Google Maps links ----------

const COORD = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
const G_MODE = { driving: 'car', walking: 'walk', bicycling: 'bike', transit: 'car', flying: 'plane' };
const DATA_MODE = { 0: 'car', 1: 'bike', 2: 'walk', 3: 'car', 4: 'plane' };

function stopFrom(text) {
  const t = decodeURIComponent(String(text).replace(/\+/g, ' ')).trim();
  if (!t) return null;
  const m = COORD.exec(t);
  if (m && Math.abs(Number(m[1])) <= 90 && Math.abs(Number(m[2])) <= 180) return { lat: Number(m[1]), lng: Number(m[2]), label: `${Number(m[1]).toFixed(4)}, ${Number(m[2]).toFixed(4)}` };
  return { text: t, label: t.split(',')[0] };
}

// Reads the stops and travel mode out of a Google Maps directions link.
// Returns { stops, mode } or { short: true } for a short link that must be expanded first.
// Throws a plain-language error when the link is not a directions link.
export function parseMapsLink(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('That does not look like a link. Copy the whole address from Google Maps.'); }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'g.co') return { short: true, url: u.toString() };
  if (!/(^|\.)google\.[a-z.]+$/.test(host)) throw new Error('That is not a Google Maps link.');

  let stops = [];
  let mode = 'car';
  const q = u.searchParams;
  const seg = u.pathname.split('/');
  const at = seg.indexOf('dir');
  if (at >= 0 && seg.length > at + 1 && seg.slice(at + 1).some((s) => s && !s.startsWith('@') && !s.startsWith('data='))) {
    for (const s of seg.slice(at + 1)) {
      if (s.startsWith('@') || s.startsWith('data=')) break;
      const st = stopFrom(s);
      if (st) stops.push(st);
    }
    const data = (seg.find((s) => s.startsWith('data=')) || '') + (q.get('data') || '');
    const dm = /!3e(\d)/.exec(data);
    if (dm && DATA_MODE[dm[1]]) mode = DATA_MODE[dm[1]];
    // Google also tucks each stop's exact coordinates into the data blob. Use them when they line up one to one.
    const exact = [...data.matchAll(/!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/g)].map((m) => ({ lng: Number(m[1]), lat: Number(m[2]) }));
    if (exact.length === stops.length) stops = stops.map((s, i) => (s.text ? { ...s, ...exact[i] } : s));
  } else if (q.get('destination') || q.get('origin')) {
    stops = [q.get('origin'), ...(q.get('waypoints') || '').split('|'), q.get('destination')].map((s) => (s ? stopFrom(s) : null)).filter(Boolean);
    mode = G_MODE[q.get('travelmode')] || 'car';
  } else if (q.get('daddr')) {
    stops = [q.get('saddr'), ...q.get('daddr').split(/\s*\+?to:\s*/)].map((s) => (s ? stopFrom(s) : null)).filter(Boolean);
    const df = q.get('dirflg') || '';
    mode = df.includes('w') ? 'walk' : df.includes('b') ? 'bike' : 'car';
  } else {
    throw new Error('That link shows a place, not directions. In Google Maps, get directions first, then copy the link.');
  }
  if (stops.length < 2) throw new Error('That link has only one stop. Directions from "Your location" cannot be read; type a starting address in Google Maps first.');
  return { stops: stops.slice(0, MAX_STOPS), mode };
}
