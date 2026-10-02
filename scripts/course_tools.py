"""Helpers used once to turn captured race courses into the GeoJSON files in data/courses/.
Courses were packed in the browser as base64 varint deltas (1e-5 degrees) with a SHA-256 prefix, so a
copying mistake is caught instead of silently bending the route."""
import base64, hashlib, json, math, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'courses')

def unpack(b64, sha):
    assert hashlib.sha256(b64.encode()).hexdigest()[:12] == sha, 'checksum mismatch: the packed course was copied wrong'
    vals, cur, shift = [], 0, 0
    for b in base64.b64decode(b64):
        cur |= (b & 0x7F) << shift
        if b & 0x80: shift += 7; continue
        vals.append(-((cur + 1) >> 1) if cur & 1 else cur >> 1)
        cur, shift = 0, 0
    pts, x, y = [], 0, 0
    for i in range(0, len(vals), 2):
        x += vals[i]; y += vals[i + 1]
        pts.append([x / 1e5, y / 1e5])
    return pts

def miles(pts):
    t = 0
    for a, b in zip(pts, pts[1:]):
        h = math.sin(math.radians(b[1] - a[1]) / 2) ** 2 + math.cos(math.radians(a[1])) * math.cos(math.radians(b[1])) * math.sin(math.radians(b[0] - a[0]) / 2) ** 2
        t += 2 * 3958.8 * math.asin(math.sqrt(h))
    return t

def write(name, features):
    with open(os.path.join(OUT, name), 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': features}, f, separators=(',', ':'))
    return len(features)

def line(name, pts, **props):
    return {'type': 'Feature', 'properties': {'name': name, 'miles': round(miles(pts), 1), **props}, 'geometry': {'type': 'LineString', 'coordinates': pts}}

def point(name, lng, lat, **props):
    return {'type': 'Feature', 'properties': {'name': name, **props}, 'geometry': {'type': 'Point', 'coordinates': [lng, lat]}}
