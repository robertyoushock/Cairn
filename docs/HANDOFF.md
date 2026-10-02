# Cairn handoff

Written 2 October 2026 for whoever picks this up next, human or AI, with no memory of how it was built.
Read this before changing anything. The README says what Cairn does; this says why it is built this way and what bites.

## What Cairn is

A free, static web page that lets people who have never used GIS software find US map data, check it on a map,
and download it as KML, KMZ, GPX or GeoJSON. Owner: Robert Youshock. Repo: `github.com/robertyoushock/cairn`.
Live at `robertyoushock.com/cairn/` (GitHub Pages, project site under the user site's custom domain).

The bar Robert set: "10x user friendly, not ArcGIS Pro users only", and "you should find it all from right here",
meaning no manual uploads and no sending people elsewhere to search.

## Rule one: it must stay free

Robert asked for this explicitly. Public traffic must never be able to cost him money. Keep these true:

1. **No build step, no server.** Plain HTML, CSS and ES modules on GitHub Pages. Every visitor's browser talks
   straight to the data publishers. More users does not mean more load on anything Robert pays for.
2. **No API key in the page, ever.** Anything in this repo is public. `test/basemap.test.mjs` fails the build if the
   map style contains a key or token.
3. **Nothing on a plan that bills for overage.** The optional Cloudflare Worker must stay on **Workers Free**: over
   the daily allowance it returns errors, it does not bill. Do not add a paid plan, KV, D1, R2 or Durable Objects.
4. **Keys live only as Worker secrets.** The OpenRouteService key is `ORS_KEY` in Cloudflare. ORS's free plan has
   a daily quota that cuts off rather than bills.
5. **Every third-party service used is keyless or free-tier with a hard stop.** See the table below. If one
   starts charging or blocks the site, swap it; never "just add a card".
6. **The Worker is not an open proxy.** Host allowlist, origin allowlist, per-visitor rate limit. Keep it that way,
   or strangers can spend the daily allowance.

| Used for | Service | Key? | What happens under heavy use |
|---|---|---|---|
| Hosting | GitHub Pages (public repo) | none | Soft limit about 100 GB a month; the site is a few hundred KB |
| Boundaries | US Census TIGERweb | none | Public service, may slow down |
| Search | ArcGIS Online search + each publisher's server | none | Per-publisher limits |
| Base map | OpenFreeMap vector tiles | none | Donation funded. If Cairn gets big: donate or self-host tiles |
| Place search | Esri World Geocoder, then OSM Nominatim | none | Nominatim asks for about 1 request a second; throttles or blocks |
| Directions | FOSSGIS OSRM (`routing.openstreetmap.de`), then FOSSGIS Valhalla | none | Fair use. OSRM blocked an address for a while after about 80 requests in two minutes (while tracing race courses); Valhalla takes over when that happens |
| Directions (backup) | OpenRouteService via the Worker | Worker secret | Daily quota, then errors |
| Blocked datasets | Cloudflare Worker relay | none | 100,000 requests a day, then errors |
| Libraries, fonts | unpkg, Google Fonts | none | Free CDNs |

**Open question, not a cost risk but a terms risk:** Esri's geocoder is called without a key
(`forStorage=false`, results shown once, never stored). That works, but whether Esri's terms allow it for a public
site was never confirmed. If it becomes a problem, remove `esriSearch` from `searchPlaces` in `js/sources.js`.
The Worker already has `/geocode` (Census Bureau geocoder, public domain) ready to take its place for street addresses;
it is not wired into the page yet.

## Map of the code

```
index.html        the whole page: left panel (3 steps) + map
credits.html      attribution page
style.css
js/app.js         all UI wiring. No framework. Sections are marked with // ---------- headers
js/sources.js     Census boundary queries, click-to-identify, ArcGIS search/load, place search, GeoJSON URL loader
js/intent.js      plain words -> Census boundary ("texas state house" -> type sldl, state 48)
js/catalog.js     search over data/catalog.json
js/vet.js         opens each ArcGIS search hit and checks it; label-field picking; ranking
js/convert.js     GeoJSON -> KML / GPX / KMZ, Esri JSON -> GeoJSON. Pure, no DOM
js/simplify.js    shape simplification, file size estimates and limit warnings
js/listfilter.js  filter the list by name or state
js/routes.js      directions, fly + drive, Google Maps link parsing
js/basemap.js     MapLibre style (OpenFreeMap tiles, look ported from Robert's Maputnik "Tegna" style)
js/config.js      RELAY_URL. Empty string means "no Worker deployed"
data/catalog.json hand-verified sources shown first in search
data/airports.json US airports with scheduled service (OurAirports, public domain)
worker/relay.js   the optional Cloudflare Worker
test/*.mjs        Node tests, no network. Run `npm test`
```

`npm start` serves the folder. ES modules need a server; opening `index.html` from disk does not work.

## How search works (the part Robert cares most about)

One box. Results come in two groups.

1. **Verified.** `intent.js` recognises Census boundaries from plain words. `catalog.js` matches the hand-checked
   catalog. A clean Census match (type + state, nothing else) skips the ArcGIS hunt and offers it as a link.
   If extra words are present ("parcels jefferson county colorado") the match is marked `loose` and the ArcGIS
   search runs as well, because the words might be a different topic.
2. **More from ArcGIS Online.** `vet.js` takes the top 12 hits and, for each, opens the service, drops tables,
   empty layers, unqueryable layers and duplicates, picks a label field, and reads the layer's footprint.
   Results are sorted by distance from the last spot the person clicked or searched (25 km steps), then last
   update, then feature count. That order was Robert's request.

Then **preview before add**: a 300-feature sample is drawn, and "Name each shape by" lets people fix a bad label.

Why label picking matters: ArcGIS layers declare a `displayField`, and it is often useless. NIFC's incident layer
defaults to `IncidentCommanderName`, which is blank. `pickLabelFields` penalises person, user, id and owner fields
and prefers anything ending in `name`. `test/search.test.mjs` has this exact case as a regression test.

### Adding a catalog entry

Add an object to `data/catalog.json`. Before committing, open the URL in a browser and confirm: it loads from a
web page (CORS), `returnCountOnly` is above zero, and `labelField` holds real names. Field names are case
sensitive (USFS uses lowercase). Set `"large": true` for anything over about 20,000 features; the app then
defaults to "only what is on the screen". `labelPrefix` turns `A` into `Flood zone A`. `needsRelay` marks sources
that block browsers.

### Adding a Census boundary type

Add it to `BOUNDARY_TYPES` in `sources.js`, add a rule to `TYPE_RULES` and a title to `TYPE_TITLES` in `intent.js`,
and labels to `KIND` and `CARD_COPY` in `app.js`. Layers are found by **name** at run time because Census layer ids
change every vintage. If Census renames a layer, fix the regex.

## Things that bit us (read these)

- **GitHub Pages paths are case sensitive.** `/Cairn/` and `/cairn/` are different. The Pages path follows the
  repo name exactly. Repo URLs on github.com are not case sensitive, so links to the repo work either way.
- **Pages serves stale files for a while after a push.** Allow about a minute for the build, then hard refresh.
  When checking from a script: `fetch(file, { cache: 'reload' })` for each changed file, then reload.
- **The live site's origin is `https://www.robertyoushock.com`**, with `www`. The Worker's `ALLOWED_ORIGINS` must
  include it or every relay call fails with 403.
- **CORS decides what is possible.** The Census geocoder, DeFlock's export and public Overpass servers cannot be
  called from a web page. That is what the Worker is for. Do not paper over a CORS failure; show an honest message.
- **Census quirks.** On the ZIP layer, filter on `GEOID` and list `outFields` by name; the `ZCTA5` field breaks
  queries. The county service lists "Counties" twice at different scales; take the one with the lowest `maxScale`.
  The congressional field is named after the session (`CD120`), not `CDSESSN`.
- **The `hidden` attribute loses to CSS `display`.** `style.css` has `[hidden] { display: none !important; }`.
  Keep it.
- **MapLibre cannot vary `line-dasharray` per feature.** The route layer is split in two (road legs, flight leg).
- **Never commit Robert's original Maputnik export.** It contains provider credentials. `js/basemap.js` is a clean
  rebuild on free tiles.
- **Pushing:** Robert sometimes edits on GitHub (the CNAME file, for one). `git fetch origin main` and
  `git rebase FETCH_HEAD` before every push.
- **Custom domain:** `maps.robertyoushock.com` was planned, then dropped. Robert is happy with
  `robertyoushock.com/cairn/`. There is deliberately no CNAME file in this repo.

## The Worker (optional)

`worker/relay.js`, single file, pasted into the Cloudflare dashboard or deployed with `wrangler deploy`.
After deploying, put its address in `js/config.js` as `RELAY_URL`.

- `GET /?url=` fetches an allowlisted dataset (DeFlock cameras).
- `POST /route` proxies OpenRouteService. Needs the `ORS_KEY` secret. Without it returns 503 and the page falls
  back to the keyless OSRM servers.
- `GET /resolve?url=` expands short Google Maps links.
- `GET /geocode?q=` Census address lookup (not used by the page yet).
- `GET /health` reports whether routing is configured.

Everything works without the Worker except DeFlock cameras and short Google Maps links.

## State of things on 2 October 2026

Built and tested: boundaries (ZIP, state house, state senate, congressional, county, city, school district,
tract, state), click-to-identify, place search, guided search with vetting and distance ranking, preview with label
picker, source links, map click modes (What's here? / My list / Route), right-click "Pick an area" menu (tract up to state, rough shapes for speed, full shape fetched on pick), list filter, KML colors, labels and
attributes, shape detail levels with size warnings, route builder, Google Maps link reader, report-a-problem
link, credits page.

Check `README.md` "Status" for what was and was not verified in a real browser.

### Agreed but not done

- **Merge shapes and draw-to-select.** Approved, then set aside ("don't worry about merging shapes").
- **Mobile beyond the basics.** Robert asked only that phones look decent for the showcase. The menu is a sheet
  under the map with one Map / Menu button. It was checked in a phone-sized browser window, never on a real phone.

### How the README images were made

`docs/images/` holds composed showcase images in the style of Robert's "Our Places" project page. The screenshots
are real captures of the live site at a 1600 x 1000 desktop layout (taken as four tiles and stitched). They were
then placed in a browser frame with callouts using a throwaway HTML page rendered with Playwright, in the brand
font (Schibsted Grotesk) and colors. `img/social.png` (the link preview) was made the same way. If the UI changes
a lot, retake them; the README says what each one shows.

### Marathon courses

Robert asked for major city marathons to come up in search, with water stations where the data exists. There is
no single open dataset of race courses (OpenStreetMap has only Boston, and its relation holds both sides of
divided roads, so it does not stitch into one line). Each course is its own small research job. Three kinds:

1. **Live ArcGIS layers** where a city, county or the race publishes one (Los Angeles, Marine Corps, Oklahoma City,
   Chicago, Twin Cities, St. George, Anchorage). Catalog entries with `"group": "marathon"`. Many services hold
   several things in one layer, so entries carry a `where` filter and sometimes a `fixedLabel`.
2. **Static files in `data/courses/`** copied from the organizer's own public course map (Denver Colfax: the
   official page embeds a RaceJoy map whose course, mile marker, water stop and medical KML files are public).
   Look for this first on any race site: open the course page, list its iframes and network requests.
3. **Traced by Cairn**: when an organizer publishes only a picture and turn-by-turn directions, the course is
   drawn by routing along OpenStreetMap roads through each turn, then checked against 26.2 miles. These say
   "approximate" in their description.

How to add one: get the line as GeoJSON, check its length is 26.2 to 26.8 miles (hand-drawn lines run long), save
it in `data/courses/`, add catalog entries for the course and any station layers, say the year in `freshness`,
and credit the source. `scripts/course_tools.py` has the helpers that wrote the existing files. Courses change
most years; the catalog check cannot tell a stale course from a current one, so review them each season.

Boston, New York City and Miami were traced with the Valhalla router using `costing: auto`, ten stops per
request, one request a second. Boston was checked against an independent line and stayed within 80 meters of it.
New York and Miami had no reference, only the 26.2-mile check and known mile points, so treat those as the least
certain; Miami runs about 3 percent long.

Houston, Honolulu and Philadelphia were traced later with `costing: pedestrian` (`shortest: true`), which is the
better choice: the public Valhalla server does **not** honor `ignore_oneways` for `auto`, so a course that runs
against traffic on a one-way street gets pushed a block over (Arch Street in Philadelphia came out on Race
Street). Pedestrian routing ignores one-ways; use `auto` only for a stretch on a freeway. Because of this, New
York and Miami may hide a block-long detour somewhere; retrace them with `pedestrian` when their courses are next
reviewed. Things that bit while tracing:

- The router takes the shortest way between two stops, not the race's way. Loops need a stop in the middle of
  them (Hawaii Kai Drive in Honolulu, States Drive in Philadelphia).
- A stop past a turn makes an out-and-back spur. Look for U-turns in the result.
- Always look at the line on a map before saving it. Total length alone hid all three problems above.
- What each was checked against: Houston, the organizer's 2026 refueling map (mile markers and stations read off
  the picture; the traced line is 26.6 miles); Honolulu, the organizer's 2025 traffic advisory turn list
  (26.3 miles, finish line position estimated); Philadelphia, the 2025 closure list and a mile-by-mile spectator
  guide (26.6 miles; the West Fairmount Park section between Belmont Avenue and Black Road is a best guess).
- Houston's refueling stations are points placed along the traced line at the mile positions shown on the
  organizer's map. They are labelled approximate.

Not done: **San Francisco**. The organizer publishes a picture and a Strava link (login needed) and the city's
closure list names districts, not turns. The Golden Gate Bridge out-and-back and the Golden Gate Park loops
cannot be traced honestly from that. If the organizer ever publishes a GPX or a turn list, it is a one-hour job.

Sources that did not work: Garmin Connect courses (need a login), NYRR's course page (no data behind it),
Overpass (timed out every time), Strava routes (need a login).

### Automated checks

- `.github/workflows/test.yml` runs `npm test` on every push.
- `.github/workflows/catalog-check.yml` runs `scripts/check-catalog.mjs` every Monday and on demand. It opens
  every catalog source and every Census layer. When something is broken it opens (or comments on) an issue titled
  "Catalog check: sources need attention", which emails Robert. DeFlock puts a robot check in front of GitHub's
  servers, so that one source is reported as "could not check" rather than broken.
- `.github/workflows/course-reminder.yml` runs `scripts/course-reminder.mjs` on January 4 each year and on
  demand. It opens an issue titled "Marathon courses: yearly review (YEAR)" with a checkbox per race, oldest
  course first, each linking to the organizer. Nothing else can tell a stale course from a current one.
- GitHub switches off scheduled workflows in a repository that has had no commits for 60 days, and emails first.
  The weekly check re-enables itself and the yearly review through the API on every run, which resets that
  clock. If an email saying "scheduled workflow disabled" ever arrives anyway, open the Actions tab and press
  "Enable workflow" on both.

### Ideas not yet discussed further

Shareable links that restore a search and list; saving and reloading a list; satellite basemap (licence check
first); remembering which label field worked for a layer; searching state and county open-data hubs beyond
ArcGIS Online; vetting more than the top 12 hits.

## How Robert likes to work

Short messages, fast iterations, he tests on the live site himself. He is a designer and motion artist, fluent
in ArcGIS but not a developer: explain Cloudflare, keys and deploys in plain steps. Say plainly what was and was
not verified. He values honest "this cannot be done yet" messages in the product over features that silently fail.
