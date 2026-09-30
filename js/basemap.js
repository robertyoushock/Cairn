// Basemap style for Cairn, built on free OpenMapTiles data served by OpenFreeMap (no API key).
// The palette, road widths, border dashes and label treatment follow the "Tegna" Maputnik design;
// the data source and fonts are swapped for free equivalents.

const C = {
  land: 'rgb(227, 225, 219)',
  builtUp: 'rgb(205, 201, 193)',
  green: 'rgb(182, 194, 168)',
  forest: 'rgb(136, 164, 117)',
  water: 'rgb(153, 187, 214)',
  building: 'rgb(179, 173, 159)',
  road: '#ffffff',
  boundary: 'rgb(179, 174, 159)',
  label: '#0a2740',
  waterLabel: '#2f5f82',
  halo: '#ffffff',
};

const REG = ['Noto Sans Regular'];
const BOLD = ['Noto Sans Bold'];
const ITALIC = ['Noto Sans Italic'];

const z = (...stops) => ['interpolate', ['linear'], ['zoom'], ...stops.flat()];
const fade = (from, to) => z([from, 0], [to, 1]);

const cls = (...names) => ['in', ['get', 'class'], ['literal', names]];
const notTunnel = ['!=', ['get', 'brunnel'], 'tunnel'];
const isTunnel = ['==', ['get', 'brunnel'], 'tunnel'];

// Road widths taken from the source design (zoom, width) and kept per road tier.
const W = {
  highway: z([7, 0.75], [10, 2.25], [12, 4.5], [15, 10.5], [18, 22.5], [23, 225]),
  throughway: z([7, 0.75], [10, 1.875], [12, 3.75], [15, 9], [18, 18.75], [23, 195]),
  main: z([10, 1.5], [11, 3], [12, 3.375], [15, 7.5], [18, 15], [23, 180]),
  minor: z([10, 1.5], [12, 2.25], [15, 6], [18, 12], [23, 150]),
  street: z([12, 0.75], [13, 1.5], [15, 4.5], [18, 9], [23, 75]),
  service: z([12, 0.75], [13, 1.5], [15, 2.25], [18, 6], [23, 75]),
};

function road(id, classes, minzoom, width, opacityFrom) {
  const base = { 'line-color': C.road, 'line-width': width, 'line-opacity': fade(opacityFrom, opacityFrom + 1) };
  return [
    {
      id: `road-tunnel-${id}`, type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom,
      filter: ['all', cls(...classes), isTunnel],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { ...base, 'line-dasharray': [2, 2] },
    },
    {
      id: `road-${id}`, type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom,
      filter: ['all', cls(...classes), notTunnel],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: base,
    },
  ];
}

const dashedBorder = {
  'line-color': C.boundary,
  'line-width': z([0, 0.5], [4, 1], [6, 1.3], [8, 2], [12, 2.5], [16, 3], [23, 25]),
};

export const basemapStyle = {
  version: 8,
  name: 'Cairn',
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    ofm: {
      type: 'vector',
      url: 'https://tiles.openfreemap.org/planet',
      attribution:
        '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
        '© <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
        'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    },
  },
  layers: [
    { id: 'land', type: 'background', paint: { 'background-color': C.land } },

    // Land cover and land use
    {
      id: 'built-up', type: 'fill', source: 'ofm', 'source-layer': 'landuse', minzoom: 7,
      filter: cls('residential', 'commercial', 'industrial', 'retail', 'hospital', 'school', 'university', 'stadium', 'neighbourhood', 'suburb', 'quarter'),
      paint: { 'fill-color': C.builtUp, 'fill-opacity': fade(7, 8) },
    },
    {
      id: 'recreation', type: 'fill', source: 'ofm', 'source-layer': 'landuse', minzoom: 12,
      filter: cls('playground', 'pitch', 'cemetery'),
      paint: { 'fill-color': C.green, 'fill-opacity': fade(12, 13) },
    },
    {
      id: 'grass', type: 'fill', source: 'ofm', 'source-layer': 'landcover', minzoom: 10,
      filter: cls('grass'),
      paint: { 'fill-color': C.green, 'fill-opacity': fade(10, 11) },
    },
    {
      id: 'park', type: 'fill', source: 'ofm', 'source-layer': 'park', minzoom: 7,
      paint: { 'fill-color': C.green, 'fill-opacity': fade(7, 9) },
    },
    {
      id: 'forest', type: 'fill', source: 'ofm', 'source-layer': 'landcover', minzoom: 7,
      filter: cls('wood'),
      paint: { 'fill-color': C.forest, 'fill-opacity': z([8, 0], [10, 0.85]) },
    },

    // Water
    {
      id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water',
      filter: ['!=', ['get', 'brunnel'], 'tunnel'],
      paint: { 'fill-color': C.water },
    },

    // Buildings
    {
      id: 'building', type: 'fill', source: 'ofm', 'source-layer': 'building', minzoom: 13,
      paint: { 'fill-color': C.building, 'fill-opacity': fade(13, 14) },
    },

    // Roads, drawn small to large so the big ones sit on top
    ...road('service', ['service'], 13, W.service, 13),
    ...road('street', ['path', 'pedestrian', 'track'], 12, W.street, 12),
    ...road('minor', ['minor'], 10, W.minor, 10),
    ...road('main', ['secondary', 'tertiary'], 9, W.main, 9),
    ...road('throughway', ['primary'], 9, W.throughway, 9),
    ...road('highway', ['motorway', 'trunk'], 7, W.highway, 7),

    // Borders
    {
      id: 'border-state', type: 'line', source: 'ofm', 'source-layer': 'boundary', minzoom: 2,
      filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
      layout: { 'line-join': 'round' },
      paint: { ...dashedBorder, 'line-dasharray': [5, 3] },
    },
    {
      id: 'border-country', type: 'line', source: 'ofm', 'source-layer': 'boundary',
      filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1], ['!=', ['get', 'disputed'], 1]],
      layout: { 'line-join': 'round' },
      paint: dashedBorder,
    },
    {
      id: 'border-country-disputed', type: 'line', source: 'ofm', 'source-layer': 'boundary',
      filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1], ['==', ['get', 'disputed'], 1]],
      paint: { ...dashedBorder, 'line-dasharray': [2, 2] },
    },

    // Labels
    {
      id: 'label-road', type: 'symbol', source: 'ofm', 'source-layer': 'transportation_name', minzoom: 13,
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: {
        'symbol-placement': 'line',
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': REG,
        'text-letter-spacing': 0.1,
        'text-size': z([10, 8], [20, 14]),
        'text-transform': 'uppercase',
      },
      paint: { 'text-color': '#000000', 'text-halo-color': C.halo, 'text-halo-width': 2 },
    },
    {
      id: 'label-water', type: 'symbol', source: 'ofm', 'source-layer': 'water_name',
      filter: ['==', ['geometry-type'], 'Point'],
      layout: {
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': ITALIC,
        'text-size': z([2, 10], [10, 13], [14, 16]),
        'text-max-width': 8,
      },
      paint: { 'text-color': C.waterLabel, 'text-halo-color': 'rgba(153, 187, 214, 0.8)', 'text-halo-width': 1.5 },
    },
    {
      id: 'label-suburb', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 11, maxzoom: 17,
      filter: cls('suburb', 'neighbourhood', 'quarter', 'hamlet', 'village'),
      layout: {
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': REG,
        'text-letter-spacing': 0.1,
        'text-size': z([11, 10], [16, 14]),
        'text-max-width': 8,
      },
      paint: { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.5 },
    },
    {
      id: 'label-town', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 7, maxzoom: 15,
      filter: cls('town'),
      layout: {
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': BOLD,
        'text-letter-spacing': 0.04,
        'text-size': z([7, 11], [12, 15]),
        'text-max-width': 8,
      },
      paint: { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.6 },
    },
    {
      id: 'label-city', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 3, maxzoom: 15,
      filter: cls('city'),
      layout: {
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': BOLD,
        'text-letter-spacing': 0.04,
        'text-size': z([3, 11], [8, 16], [12, 20]),
        'text-max-width': 8,
      },
      paint: { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.8 },
    },
    {
      id: 'label-state', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 3, maxzoom: 8,
      filter: cls('state'),
      layout: {
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': BOLD,
        'text-letter-spacing': 0.1,
        'text-size': z([3, 10], [7, 16]),
        'text-transform': 'uppercase',
        'text-max-width': 8,
      },
      paint: { 'text-color': C.label, 'text-opacity': 0.75, 'text-halo-color': C.halo, 'text-halo-width': 1.5 },
    },
    {
      id: 'label-country', type: 'symbol', source: 'ofm', 'source-layer': 'place', maxzoom: 6,
      filter: cls('country'),
      layout: {
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': BOLD,
        'text-letter-spacing': 0.1,
        'text-size': z([1, 11], [5, 20]),
        'text-max-width': 8,
      },
      paint: { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.5 },
    },
    {
      id: 'label-airport', type: 'symbol', source: 'ofm', 'source-layer': 'aerodrome_label', minzoom: 9,
      filter: ['==', ['get', 'class'], 'international'],
      layout: {
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': REG,
        'text-size': 12,
        'text-max-width': 8,
      },
      paint: { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.5 },
    },
  ],
};
