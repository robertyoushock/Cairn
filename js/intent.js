// Turn plain-language searches into structured intent. Pure functions, no network.
// "texas state house" -> { type: 'sldl', state: '48' }

import { STATES } from './sources.js';

const NAME_TO_FIPS = Object.fromEntries(Object.entries(STATES).map(([fips, name]) => [name.toLowerCase(), fips]));

export const ABBR = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11', FL: '12', GA: '13',
  HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24', MA: '25',
  MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36',
  NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48',
  UT: '49', VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56', PR: '72',
};

// Longest names first so "west virginia" beats "virginia".
const STATE_NAMES = Object.keys(NAME_TO_FIPS).sort((a, b) => b.length - a.length);

export function findState(text) {
  const lower = ` ${text.toLowerCase()} `;
  for (const name of STATE_NAMES) {
    if (lower.includes(` ${name} `) || lower.includes(` ${name},`)) {
      return { fips: NAME_TO_FIPS[name], matched: name };
    }
  }
  // Two-letter codes only count when typed in capitals, so "or", "in" and "me" stay ordinary words.
  const m = text.match(/(?:^|[\s,])([A-Z]{2})(?=$|[\s,])/);
  if (m && ABBR[m[1]]) return { fips: ABBR[m[1]], matched: m[1] };
  return null;
}

const TYPE_RULES = [
  ['school', /\b(school\s+districts?|school\s+boundar(?:y|ies)|isd)\b/],
  ['tract', /\b(census\s+tracts?|tracts)\b/],
  ['sldu', /\b(state\s+senate|senate\s+districts?|upper\s+chamber|state\s+senators?)\b/],
  ['sldl', /\b(state\s+house|house\s+districts?|state\s+assembly|assembly\s+districts?|lower\s+chamber|state\s+representatives?|state\s+reps?)\b/],
  ['cd', /\b(congressional|congress\s+districts?|us\s+house|u\.s\.\s+house|congressmen|congresswomen)\b/],
  ['county', /\b(counties|county)\b/],
  ['zip', /\b(zip\s*codes?|zips|zcta|postal\s+codes?)\b/],
  ['place', /\b(city\s+limits?|city\s+boundar(?:y|ies)|cities|towns|municipalit(?:y|ies)|municipal\s+boundar(?:y|ies)|incorporated\s+places?|town\s+limits?)\b/],
];

const NAMED = new Set(['school', 'place', 'county']);
const FILLER = new Set(['in', 'of', 'the', 'all', 'for', 'and', 'map', 'maps', 'boundary', 'boundaries', 'area', 'areas', 'state', 'public', 'show', 'me', 'find', 'list', 'every', 'near']);

export function parseIntent(raw) {
  const text = (raw || '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const rule = TYPE_RULES.find(([, re]) => re.test(lower));
  const zips = text.match(/\b\d{5}\b/g) || [];
  const type = rule ? rule[0] : zips.length ? 'zip' : null;
  if (!type) return null;
  const st = findState(text);
  const out = { type, state: st ? st.fips : null, zips };
  if (NAMED.has(type)) {
    // Whatever is left after the type words and the state is taken as a name: "denver city limits colorado" -> "denver".
    let rest = lower.replace(rule[1], ' ');
    if (st) rest = rest.replace(new RegExp(`\\b${st.matched.toLowerCase()}\\b`), ' ');
    rest = rest.replace(/[^a-z0-9.\s'-]/g, ' ').split(/\s+/).filter((w) => w && !FILLER.has(w)).join(' ');
    out.names = rest ? [rest] : [];
  }
  if (type === 'sldl' || type === 'sldu' || type === 'cd') {
    out.numbers = [...lower.matchAll(/\b(?:district|dist|hd|sd|cd)\.?\s*#?\s*(\d{1,3})\b/g)].map((m) => m[1]);
  }
  return out;
}

export const TYPE_TITLES = {
  zip: 'ZIP codes',
  sldl: 'State house districts',
  sldu: 'State senate districts',
  cd: 'Congressional districts',
  county: 'Counties',
  place: 'Cities and towns',
  school: 'School districts',
  tract: 'Census tracts',
};

// A "Verified" result for Census boundaries, or null when the search is not about them.
export function boundaryResult(raw) {
  const intent = parseIntent(raw);
  if (!intent) return null;
  const { type, state, zips, numbers = [], names = [] } = intent;
  const stateName = state ? STATES[state] : null;

  if (type === 'zip') {
    if (zips.length) {
      return { kind: 'boundary', type, state: null, input: zips.join(', '), title: `ZIP code${zips.length > 1 ? 's' : ''} ${zips.join(', ')}`, sub: 'U.S. Census Bureau' };
    }
    // ZIP areas have no state field, so a whole-state list is not possible; send people to the form.
    return { kind: 'boundary-form', type, state, title: stateName ? `ZIP codes in ${stateName}` : 'ZIP codes', sub: 'Enter the ZIP codes you want', };
  }
  if (!stateName) {
    return { kind: 'boundary-form', type, state: null, input: names.join(', '), title: TYPE_TITLES[type], sub: 'Choose a state to continue' };
  }
  const picked = numbers.length ? numbers.map((n) => `#${n}`).join(', ') : names.join(', ');
  const detail = picked ? `: ${picked}` : ' (all)';
  return {
    kind: 'boundary', type, state, input: numbers.length ? numbers.join(', ') : names.join(', '),
    // Extra words might be a name or might be a different topic ("parcels jefferson county"), so keep searching too.
    loose: !numbers.length && names.length > 0,
    title: `${stateName} ${TYPE_TITLES[type].toLowerCase()}${detail}`,
    sub: 'U.S. Census Bureau',
  };
}
