// Filter the list by a name or a state, across every attribute. Pure functions.
import { STATES } from './sources.js';
import { ABBR } from './intent.js';

const FIPS_TO_ABBR = Object.fromEntries(Object.entries(ABBR).map(([a, f]) => [f, a.toLowerCase()]));
const NAME_TO_ABBR = Object.fromEntries(Object.entries(STATES).map(([f, n]) => [n.toLowerCase(), FIPS_TO_ABBR[f]]));
const ABBR_TO_NAME = Object.fromEntries(Object.entries(NAME_TO_ABBR).map(([n, a]) => [a, n]));

function haystack(f) {
  const vals = [];
  for (const [k, v] of Object.entries(f.properties || {})) {
    if (k === '_key' || v == null || typeof v === 'object') continue;
    vals.push(String(v));
  }
  const text = vals.join(' \u0001 ').toLowerCase();
  return { text, words: new Set(text.split(/[^a-z0-9]+/).filter(Boolean)) };
}

// "colorado" also finds rows that only say CO (or US-CO); "CO" also finds rows that say Colorado.
// Short terms must match a whole word so "co" does not match "Coconino".
export function makeMatcher(query) {
  const terms = (query || '').toLowerCase().split(/\s*,\s*|\s+or\s+/).map((t) => t.trim()).filter(Boolean);
  if (!terms.length) return () => true;
  const tests = terms.map((t) => {
    const abbr = NAME_TO_ABBR[t];
    const name = ABBR_TO_NAME[t];
    return (h) =>
      (t.length <= 2 ? h.words.has(t) : h.text.includes(t)) ||
      (abbr ? h.words.has(abbr) : false) ||
      (name ? h.text.includes(name) : false);
  });
  return (f) => { const h = haystack(f); return tests.some((fn) => fn(h)); };
}

export const filterFeatures = (features, query) => features.filter(makeMatcher(query));
