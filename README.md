# Cairn

Free, no-backend web tool for finding US boundaries and ArcGIS layers, previewing them on a map, and downloading them as **KML, KMZ, GPX or GeoJSON**.

Test URL: https://robertyoushock.github.io/cairn/ (custom domain maps.robertyoushock.com planned, see below).

## What v1 does

- **US boundaries** from the Census Bureau's TIGERweb service: ZIP codes (ZCTAs), state house and senate districts, congressional districts, counties. Search by ID, by prefix (`802*`), or by what is in the map view.
- **ArcGIS finder**: search ArcGIS Online (or another portal), paste a service, layer or folder URL, filter with a SQL where clause, and pull up to 50,000 features with paging.
- **Export** to KML, KMZ, GPX, GeoJSON. GPX has no polygon type, so boundaries are written as closed tracks.

Everything runs in the browser. There is no server and no API key.

## Roadmap (not built yet)

1. Route builder: click to draw, walk / bike / car / plane + car, export GPX/KML. Plan: OpenRouteService (free key, proxied through a small Cloudflare Worker so the key is not public).
2. Google Maps link to GPX: parse origin, destination and waypoints from a pasted link and re-route with the open provider. Short links (maps.app.goo.gl) need the Worker to resolve the redirect.
3. Simplify geometry before export, merge selected features, draw-to-select.

## Run locally

```sh
npm test      # converter and query-builder checks, no network needed
npm start     # serves the folder with `serve`
```

ES modules need a server, so opening `index.html` from disk will not work.

## Deploy to GitHub Pages at maps.robertyoushock.com

1. This repo is `robertyoushock/cairn`.
2. Repo Settings, Pages: deploy from branch `main`, folder `/ (root)`. Add a `CNAME` file containing `maps.robertyoushock.com` only when the DNS record below is in place (it is left out during testing so the github.io test URL keeps working).
3. In IONOS DNS for robertyoushock.com add a `CNAME` record: host `maps`, value `<your-github-username>.github.io`.
4. Back in Pages, wait for the DNS check, then tick **Enforce HTTPS**.
5. The "Source on GitHub" link in `index.html` already points at this repo.

## Data notes

- Census layer IDs change every vintage, so the app looks layers up by name at run time. If the Census renames a layer, update the regexes in `js/sources.js`.
- ZIP codes here are **ZCTAs**, Census approximations of USPS ZIP areas. They are not official USPS delivery boundaries, and some ZIPs (PO boxes, single buildings) have no ZCTA.
- ArcGIS servers must allow cross-origin requests (CORS) for this to read them. ArcGIS Online and most public servers do; some county servers do not, and the app says so when a request is blocked. Those need the planned Worker proxy.
- The base map is a custom style (`js/basemap.js`) on free OpenMapTiles vector tiles from [OpenFreeMap](https://openfreemap.org), with no API key. The look follows a Maputnik design; the data and fonts (Noto Sans) are free equivalents. Attribution to OpenFreeMap, OpenMapTiles and OpenStreetMap is shown on the map. If traffic grows, consider donating to OpenFreeMap or self-hosting tiles.
- Never commit API keys or tokens. `test/basemap.test.mjs` fails if the style contains any.
- Respect each data publisher's license. The app shows the layer's copyright text when the server provides it.
