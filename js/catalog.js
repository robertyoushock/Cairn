// Search the hand-verified catalog (data/catalog.json). Pure functions plus one loader.

const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'for', 'and', 'to', 'data', 'map', 'maps', 'layer', 'layers', 'dataset', 'show', 'me', 'all']);

export const tokenize = (s) =>
  (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));

// Crude stemming so "fires" matches "fire" and "cameras" matches "camera".
const stem = (t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);

export function scoreEntry(entry, query) {
  const q = tokenize(query).map(stem);
  if (!q.length) return 0;
  const title = tokenize(entry.title).map(stem);
  const keys = new Set([...(entry.keywords || []).flatMap((k) => tokenize(k)), ...tokenize(entry.agency), ...tokenize(entry.description)].map(stem));
  let score = 0;
  let matched = 0;
  for (const t of q) {
    if (title.includes(t)) { score += 10; matched++; }
    else if ([...keys].includes(t)) { score += 6; matched++; }
    else if ([...keys, ...title].some((k) => k.startsWith(t) && t.length >= 4)) { score += 3; matched++; }
  }
  // Every word should land somewhere. A single stray word is not a match.
  if (matched < q.length) return matched / q.length >= 0.75 ? score * 0.5 : 0;
  return score;
}

export function searchCatalog(entries, query, limit = 6) {
  return entries
    .map((e) => ({ e, s: scoreEntry(e, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.e);
}

let cache = null;
export async function loadCatalog(url = 'data/catalog.json') {
  if (cache) return cache;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    cache = (await res.json()).entries || [];
  } catch {
    cache = [];
  }
  return cache;
}
