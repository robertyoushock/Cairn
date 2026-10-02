# Cairn

Free, no-backend web tool for finding US boundaries and ArcGIS layers, previewing them on a map, and downloading them as **KML, KMZ, GPX or GeoJSON**.

Live at https://robertyoushock.com/cairn/

## What it does

Built for people who have never used GIS software.

- **One search box.** Type what you want in plain words: "texas state house", "boulder city limits colorado", "wildfires", "flood zones", "fire stations". Results come in two groups: **Verified** (Census boundaries and a hand-checked catalog) and **More from ArcGIS Online**, where every result was opened and checked first. Empty layers, tables and duplicates are dropped. Results near the spot you last clicked come first.
- **Click the map** to see every ZIP code, city, school district, legislative district and county at that spot. **Right-click** for a quick menu of every area there, from census tract up to the whole state.
- **Preview before adding.** A sample is drawn on the map and you see how shapes will be named. A menu fixes layers that label by the wrong field. Every result links to its source.
- **One running list.** Click shapes on the map to inspect, remove or keep only one. Filter the list by name or state.
- **Routes.** Click the map or type addresses to build a route for driving, biking, walking, or flying plus driving. Or paste a Google Maps directions link.
- **Download for where you will use it:** Google Earth or Google Maps (KML, KMZ), GPS watches and hiking apps (GPX), or mapping software (GeoJSON). Choose colors and labels, and shrink big files with a detail setting that warns you about Google My Maps limits.

Everything runs in the browser. No accounts, no ads, no tracking, and nothing that can run up a bill. See `docs/HANDOFF.md` for how it is built and the rules that keep it free.

## Verified sources

US Census Bureau (ZIP areas, state house and senate, congressional, counties, cities and towns, school districts, tracts), NIFC wildfires, USGS earthquakes, National Park Service boundaries, national forests and trails, FEMA flood zones, NWS weather alerts, DeFlock license plate reader cameras. Full credits: `credits.html`.

## Status (checkpoint, 2 October 2026)

Live and checked in a real browser: every item under "What it does", including routes from a Google Maps link, fly + drive, flood zones, weather alerts, parks, DeFlock cameras through the helper, list filter, styled KML export and size warnings.

Not checked in a real browser: short Google Maps links (maps.app.goo.gl) through the helper, the OpenRouteService backup (no key added yet), national forest trails, and anything on a phone.

## Roadmap

Agreed, waiting: a polished README with screenshots (after the UI settles), merge shapes and draw-to-select.
Offered, not yet approved: automated checks on GitHub (free), shareable links, save and reload a list.

## Run locally

```sh
npm test      # all checks, no network needed
npm start     # serves the folder with `serve`
```

ES modules need a server, so opening `index.html` from disk will not work.

## Deploy

GitHub Pages, branch `main`, folder `/`. The page path follows the repo name and is case sensitive. The optional helper lives in `worker/` (see `worker/README.md`).

## Data notes

- Census layer IDs change every vintage, so the app looks layers up by name at run time. If the Census renames a layer, update the regexes in `js/sources.js`.
- ZIP codes here are **ZCTAs**, Census approximations of USPS ZIP areas. They are not official USPS delivery boundaries, and some ZIPs (PO boxes, single buildings) have no ZCTA.
- ArcGIS servers must allow cross-origin requests (CORS) for this to read them. ArcGIS Online and most public servers do; some county servers do not, and the app says so when a request is blocked. Those need the planned Worker proxy.
- The base map is a custom style (`js/basemap.js`) on free OpenMapTiles vector tiles from [OpenFreeMap](https://openfreemap.org), with no API key. The look follows a Maputnik design; the data and fonts (Noto Sans) are free equivalents. Attribution to OpenFreeMap, OpenMapTiles and OpenStreetMap is shown on the map. If traffic grows, consider donating to OpenFreeMap or self-hosting tiles.
- Never commit API keys or tokens. `test/basemap.test.mjs` fails if the style contains any.
- Respect each data publisher's license. The app shows the layer's copyright text when the server provides it.
