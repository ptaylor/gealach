# AGENTS.md

Instructions for any human or AI agent working in this repository.

`tides` is a small tool for reading what the sea is doing at a coastal place:
the tide's height and state now, when it turns, what the range is, whether we
are on springs or neaps, and — where a model is available — which way the water
is running. It is built for a phone in a pocket, and it starts with Ireland.

The name is **Gealach** (Irish for *moon*). As in the sibling repos, prose
carries the capitalised form and identifiers stay ASCII (`gealach`, `tides`);
the provisional working name was `taoidí` (*tides*) until 2026-10-05.

## Status

The first implementation now exists in the repository: the app shell, the
three ES modules, the PWA shell, the tests and the docs. The vendored station
snapshot (`data/stations.json`) is **generated** — `tools/refresh-stations.sh`
regenerated all 38 stations on **2026-10-07** once `erddap.marine.ie` recovered
from the HTTP 504 it was returning on **2026-10-04**. The hand-checked key
mapping (`data/station-map.json`) is **generated** on **2026-10-07** by matching
the three station-list spellings against the live `distinct()` responses, so
the surge feature now answers Irish points from the Marine Institute prediction
and observation datasets.

The research below was executed against the live services on **2026-09-30**
(ERDDAP) and **2026-10-04** (Open-Meteo, NOAA); the observed output is
recorded with it. Nothing in this file is aspirational about a source that was
not called. Where a candidate source was *not* verified, it says so (see
*Candidates, not adopted*).

## What the tool is for

1. **Find a place on the map** — type a place name or a latitude/longitude, or
   tap the map, then read the tide there, or at the nearest place that has
   predictions. A search only *locates* the point (it opens the map, pans to it
   and drops a pin); the tide is fetched when the map itself is tapped, so the
   reader always sees where the number came from.
2. **Say what the tide is doing**, not just what height it is: rising or
   falling, how fast, how long until high or low, what height that turn will
   be, and whether the range is spring or neap.
3. **Say what the water is doing** where a current model covers the point:
   speed and compass direction, labelled as model output.
4. **Be honest about distance and provenance.** A prediction from 40 km away is
   not a prediction "for here", and a point inside the mesh of a regional model
   is not a tide gauge. Both are shown, never glossed.
5. **Extend beyond Ireland** without rewriting the interface — a new region is
   a new source adapter, not a new page.

### Non-goals

- **Not for navigation.** Marine Institute predictions exclude storm surge (we
  can show surge separately — see the observations below — but the prediction
  itself does not contain it), and Open-Meteo says in its own documentation that
  its sea-level product "is not suitable for coastal navigation". The interface
  says so too, permanently, not in a dismissible toast.
- **No harmonic synthesis.** No FES/UTide/PyTides dependency and no field of
  constituents: we ask services for predicted series and derive from those.
- **No UX pass yet.** The page is plain, readable and phone-sized; the look of
  it is a later conversation, by agreement.
- **No backend, no accounts.** Every source is called directly from the
  browser (all three primary sources send `access-control-allow-origin: *` —
  verified). Nothing about the user is stored or sent anywhere except the
  place name they typed, which goes to the geocoder. Favourites are an
  exception in name only: they live in `localStorage` on the device and never
  leave it.
- **Analytics is minimal and privacy-first.** Usage is measured with GoatCounter
  (`gealach.goatcounter.com`, no cookies, no personal data). Custom events are
  categorical slugs only — never the search string, a picked coordinate, or a
  favourite's contents.
- **No native app.** A PWA, installed from the browser.

## Data sources — verified 2026-09-30

### Primary: Marine Institute ERDDAP (Ireland)

`https://erddap.marine.ie/erddap` — ERDDAP 2.14, no key, CORS open, data
licensed **CC-BY 4.0**, so attribution is mandatory in the interface. 38
prediction "stations" (`stationID` values are underscored: `Galway`,
`Malin_Head`, `Dublin_Port`, `Tom_Clarke_Bridge`, …), spanning 51.56–55.37 N
and 10.28–6.01 W.

| Dataset (`tabledap`) | Gives | Shape |
| --- | --- | --- |
| `IMI_TidePrediction_HighLow` | the turns: `time`, `tide_time_category` (`HIGH`/`LOW`), `Water_Level_ODMalin` | 4 rows/day/station |
| `imiTidePrediction` | the curve: `Water_Level` (above local **LAT**, i.e. chart datum) and `Water_Level_ODM` (relative to **OD Malin**) | 5-minute steps |
| `imiSurgePrediction` | predicted tide and surge, kept apart: `sea_surface_elevation_due_to_tide`, `..._due_to_storm_surge` | 5-minute steps |
| `imiSurgeObservationINTGN` | observed tide and surge, kept apart (same two variables) | 21 stations, ~3 h behind real time |
| `IrishNationalTideGaugeNetwork` | observed water level: `Water_Level_LAT`, `Water_Level_OD_Malin`, `QC_Flag` | 23 stations, 5-minute, near-real-time |

Verified by execution:

```
# the turns, one station
https://erddap.marine.ie/erddap/tabledap/IMI_TidePrediction_HighLow.json?stationID,time,tide_time_category,Water_Level_ODMalin&stationID="Galway"&time>=2026-09-30T00:00:00Z&time<=2026-10-02T00:00:00Z
  → ["Galway","2026-09-30T00:35:00Z","LOW",-2.274] ["Galway","2026-09-30T07:00:00Z","HIGH",2.235] …

# the curve, one station
https://erddap.marine.ie/erddap/tabledap/imiTidePrediction.json?stationID,time,Water_Level,Water_Level_ODM&stationID="Galway"&time>=2026-09-30T06:00:00Z&time<=2026-09-30T08:00:00Z
  → ["Galway","2026-09-30T06:00:00Z",4.85,1.91], then 5-minute steps rising to the 07:00 turn

# the station list, for the vendored snapshot
https://erddap.marine.ie/erddap/tabledap/IMI_TidePrediction_HighLow.csv?stationID,longitude,latitude&distinct()

# observed level (note the variables — `altitude` is a dummy)
https://erddap.marine.ie/erddap/tabledap/IrishNationalTideGaugeNetwork.json?station_id,time,Water_Level_LAT,Water_Level_OD_Malin,QC_Flag&station_id="Galway Port"&time>=2026-09-30T00:00:00Z
  → ["Galway Port","2026-09-30T00:00:00Z",1.2,-1.749,0]

# observed tide and surge, split
https://erddap.marine.ie/erddap/tabledap/imiSurgeObservationINTGN.json?stationID,time,sea_surface_elevation_due_to_tide,sea_surface_elevation_due_to_storm_surge&stationID="Galway"&time>=2026-09-30T00:00:00Z
  → ["Galway","2026-09-30T00:00:00Z",-2.141,0.392] …
```

Traps, each one observed rather than guessed:

- **A raw `>` or `<` in the request target is rejected by Tomcat.** The server
  behind ERDDAP returns HTTP 400 "Invalid character found in the request
  target" for `time>=…` sent literally. `curl` does **not** encode them, so
  scripts and hand-checks must write `time%3E=` / `time%3C=`; the browser's
  `fetch` encodes them automatically, which is why the app works and the shell
  script did not.
- **The URL builder must not add a second `=`.** ERDDAP constraints are
  `key>=value` — the `=` is part of the `>=`/`<=` operator — so a builder that
  writes `${key}=${value}` for a key like `"time>="` emits `time>==value` and
  gets a 400. Keys that already end in `=` (the time comparisons) must be
  joined to their value without another `=`; keys like `stationID` carry their
  own `=`.
- **`Water_Level` and `Water_Level_ODM` are different datums**, not a rounding
  difference: for Galway at 06:00Z they were 4.85 m and 1.91 m. Chart datum
  (LAT) is the one a chart and a tide table use; OD Malin is the land datum.
  The interface must name which one it is showing, and default to LAT.
- **`IrishNationalTideGaugeNetwork.altitude` is a dummy** — declared
  `valid_min 0.0, valid_max 0.0` and it returns `0.0` for every row. The
  observation is in `Water_Level_LAT` / `Water_Level_OD_Malin`. Do not plot
  `altitude`.
- **Three datasets, three spellings of the station key.** Predictions use
  `stationID` (`Galway`), the gauge network uses `station_id` with long names
  (`Galway Port`), and the surge observation uses `stationID` again but with
  compact names (`Galway`, `Dublinport`, `Malinhead`, `Tmbridge`, `Unionhall`).
  Joining them needs an explicit mapping table; a lookup on the string alone
  finds nothing (`station_id="Galway"` returns `nRows = 0`).
- **The high/low and curve datasets spell twelve stations differently.** The
  curve dataset (`imiTidePrediction`) appends `_MODELLED` to the stations it
  derives from the regional ROMS model, while the turns dataset
  (`IMI_TidePrediction_HighLow`) keeps the plain name: the high/low list has
  `Bray_Harbour`, `Wicklow`, `Kinsale`, `Dungarvan`, `Lahinch`,
  `Achill_Island`, `Carrigaholt`, `Clare_Island`, `Crosshaven`,
  `Killary_Harbour`, `Letterfrack` and `Tory_Island`; the curve list has each
  with `_MODELLED`. Asking `imiTidePrediction` for the high/low spelling
  returns `nRows = 0` — an **HTTP 404**, not an empty table — and takes the
  whole lookup down with it (seen 2026-10-08 for Bray). The curve id is
  therefore generated into `data/stations.json` as `curveId` (verified against
  the curve dataset's own `distinct()` list, not derived by string surgery) and
  carried by `js/sources.js`; `kind` is set from it too, so these twelve read
  "model", not "gauge".
- **Prediction coverage moves.** At the time of writing `imiTidePrediction`
  spanned 2026-01-01 → 2029-01-01, and Marine Institute documents prediction
  generation for a 6-day window up to two years ahead. Never assume the end
  date; read the series that comes back, and say so if the request falls
  outside it.
- **Not every "station" is a gauge.** The dataset's `files/` listing contains
  `TP_Achill_Island_MODELLED.nc` beside `TP_Aranmore.nc`: Marine Institute
  derives predictions from gauge harmonic analysis *and* from its regional ROMS
  model. Which kind it is changes what the number means — and it is what
  decides the curve station id (above).
- **Harmonic constituents are not published here.** A search of the server for
  `harmonic` returns nothing but the tide datasets themselves, so a real form
  factor cannot be computed from what we have — see *Springs and neaps*.
- **There is no radar/currents observation dataset.** A search for `radar`
  returns "no matching results". Measured surface currents on this server are
  the ADCP time series (`smartbay_obs_adcp`, `spiddal_obs_adcp`), which are two
  Galway Bay sites, not a national picture.
- **Modelled currents that do exist**: `IMI_NEATL` (gridded, 48–58 N,
  18–1 W, `sea_surface_x_velocity` / `sea_surface_y_velocity` and bottom
  equivalents in m/s) and the higher-resolution Connemara model
  (`IMI_CONN_2D`, `IMI_CONN_3D`) over Galway Bay.

### Fallback and currents: Open-Meteo Marine API

`https://marine-api.open-meteo.com/v1/marine` — no key, CORS open, free for
non-commercial use below 10,000 calls/day, attribution required. Variables used:
`sea_level_height_msl` (metres), `ocean_current_velocity`,
`ocean_current_direction` (compass, "where the current is heading towards").
Backed by Météo-France SMOC at 0.08° (~8 km), hourly, ~10 days ahead, updated
daily. Verified for Galway: the grid cell came back at 53.2917 N, 9.0417 W —
about 2.5 km from the requested point, which is itself worth showing.

Open-Meteo's own documentation is unambiguous and we repeat it in the
interface: "Accuracy is limited in coastal areas … This data is not suitable
for coastal navigation."

### Geocoding: Open-Meteo Geocoding API

`https://geocoding-api.open-meteo.com/v1/search?name=…` — no key, CORS open,
GeoNames-derived (CC-BY 4.0). Returns `latitude`, `longitude` **and `timezone`**
(`Europe/Dublin` for Galway) plus `country_code`, `admin1`, `population`. One
call therefore answers both "where is this" and "what time is it there", which
is why the app never has to guess a timezone.

### Extension: NOAA CO-OPS (United States)

`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` — no key, CORS open,
verified. Products `predictions` (`interval=hilo|h|1|6|…`), `currents_predictions`
(`interval=max_slack` gives max flood, max ebb and slack water — the flood/ebb
tide-stream data Ireland does not publish), `water_level`, `datums`. US stations
only, 7-character IDs (`9414290`, `cb1401`). NOAA asks for an `application=`
parameter and throttles heavy use, so an adapter must identify itself and space
its calls.

### Map browsing: OpenStreetMap + Photon (2026-10-05)

Verified live on 2026-10-05:

- **Tiles**: `https://tile.openstreetmap.org/{z}/{x}/{y}.png` — standard OSM
  raster tiles, no key, rendered by Leaflet (vendored under `vendor/leaflet/`).
  Data is © OpenStreetMap contributors, ODbL; attribution is in the map and the
  footer. Tiles are ordinary network images, so the map itself does not work
  offline — the rest of the shell does.
- **Geocoding (reverse and forward)**: Photon — an OpenStreetMap-based geocoder,
  no key, `access-control-allow-origin: *` (Nominatim itself does **not** send
  CORS headers, so the browser cannot call it; Photon can).
  - Reverse: `https://photon.komoot.io/reverse?lat=…&lon=…` returns
    `features[0].properties` (`name`, `country`, `countrycode`, `state`) — used
    to name a point picked on the map.
  - Forward: `https://photon.komoot.io/api/?q=…&limit=…&lang=…` returns the
    same features — used as a fallback when the GeoNames geocoder has no Irish
    match, because GeoNames misses many Irish townlands. "Cahore" alone
    geocodes to a town in Ontario, where OSM has Cahore Point in Wexford
    (verified 2026-10-07). Photon returns no timezone, so the app resolves it
    through Open-Meteo's `timezone=auto` endpoint.
- **Timezone for a picked point**: the map pick has no name, so no geocoder
  timezone. Open-Meteo's forecast endpoint with `timezone=auto`
  (`https://api.open-meteo.com/v1/forecast?latitude=…&longitude=…&current_weather=true&timezone=auto`)
  returns the IANA zone (`Europe/Dublin` for Galway), which keeps requirement 11
  honest for map picks.

### Candidates, not adopted

Listed with what was and was not checked, so nobody re-derives it:

- **Copernicus Marine — `NWSHELF_ANALYSISFORECAST_PHY_004_013`** (read
  2026-09-30; *not* called). 1.5 km, 33 levels, hourly, 7-day forecast, covering
  46–62.74 N and 16 W–13 E — i.e. all of Ireland — with tides coupled in,
  barotropic and 3-D currents, and companion "assuming no tide" sea-level and
  velocity fields that would separate tide from weather. Delivered as NetCDF-4
  from a free-account store, so it needs a server component or a conversion
  step; it cannot be read by the browser directly.
- **WorldTides v3** (`https://www.worldtides.info/api/v3`, docs read, not
  called) — global heights, extremes and datums by lat/lon, `datum=CD|LAT`,
  a `stationDistance` that would match our nearest-station rule, and a required
  copyright attribution in every app that uses it. Key plus credits; commercial.
- **Stormglass v2** (`https://api.stormglass.io/v2`, docs read, not called) —
  global tide extremes; key required.
- **UKHO Admiralty UK Tidal API** — commercial, subscription key, covers UK and
  Irish waters. The developer portal returned HTTP 503 when checked, so this
  entry is a name and a licence model only; treat it as unevaluated.
- **Local harmonic synthesis** (FES2014 + a constituent solver) — rejected for
  now: it trades a network call for a dependency, a bundle of coefficients and
  a correctness argument we do not need while the Marine Institute publishes
  gauge-derived predictions for the waters we care about.

## Architecture

Two layers, and the seam between them is the thing to protect:

1. **Sources** (`js/sources.js`) — one adapter per provider. An adapter takes a
   point and a time window and returns the same normalised shape, in UTC, with
   provenance attached: `{ source, station, datum, latitude, longitude,
   distanceKm, kind: "gauge" | "model" | "global-model", series[], extremes[],
   currents?, surge?, fetchedAt }`. Nothing above this layer knows what ERDDAP
   is, what an ERDDAP constraint looks like, or that Open-Meteo exists.
2. **Derivation** (`js/tide.js`) — pure functions over that shape: nearest
   station, rising/falling and rate, minutes to the next turn, range, springs
   or neaps, flood/ebb labelling. No network, no DOM, no clock of its own.
3. **Presentation** (`index.html`, `js/app.js`) — reads the two above and draws.

Rules that keep the seam honest:

- **`js/tide.js` and `js/sources.js` must be DOM-free** — no `document`, no
  `window` at module scope — because they are the two files unit-tested in Node.
  Anything that needs the DOM belongs in `js/app.js`.
- **Nothing is guessed.** If a value is not in the data, the interface says
  "not available for this place" rather than estimating it. Weather-driven
  surge is the worked example: it is shown when
  `imiSurgeObservationINTGN`/`imiSurgePrediction` covers the station, and
  otherwise the interface says that the prediction excludes surge.
- **Every number carries its provenance** to the screen: which source, which
  station, how far away, what datum, and when it was fetched.

## Requirements

Numbered, as agreed, so a later change can be checked against them.

1. Enter a location as a place name or as latitude/longitude. A name is
   geocoded live; a coordinate is used as given.
2. **The search locates, it does not fetch.** A name or coordinate opens the
   map, pans to the point and drops a pin — nothing else. The tide is loaded
   when the **map is tapped**, which is the one gesture that answers "what is
   the tide at this point". "Locate me" and opening a favourite are the
   exceptions: they name a place already chosen, so they load the tide
   directly. Whichever path is taken, resolve the point to the **nearest
   prediction station**, and show its name, its coordinates and the distance
   from the point asked about. When the located point is further than
   `MAX_STATION_DISTANCE_KM` from any station — an inland or vague search — the
   map card offers a one-tap **jump to the nearest prediction station**, which
   pans there but still does not fetch; the tap that reads the tide is the
   reader's, so the number always has a point on screen behind it.
3. Warn — prominently, not subtly — when the nearest station is further than a
   documented threshold (`MAX_STATION_DISTANCE_KM`, **25 km**), and never
   silently present a distant station as local.
4. Show the tide as both **the turns** (`IMI_TidePrediction_HighLow`: next high
   and next low, with times and heights) and **the curve** (`imiTidePrediction`,
   5-minute), so the next few hours can be read at a glance.
5. Derive and show the state: **rising or falling**, the **rate in m/h** at the
   current moment, and **time remaining to the next high and the next low**.
6. Choose the **datum explicitly** — chart datum (LAT, `Water_Level`) by
   default, OD Malin (`Water_Level_ODM`) available — and print which one is in
   use next to the figures.
7. Show **spring or neap**, and the date of the next spring tide, by inference
   from the predicted range, labelled as an inference (see *Springs and neaps*).
8. Show **modelled current** speed and compass direction for the point
   (Open-Meteo Marine; `IMI_NEATL` for Irish waters when a gridded subset is
   wanted), labelled with the model's resolution and the word "model".
9. Show **surge separately** where the Marine Institute publishes it, so it is
   visible that the prediction excludes it and by how much the two differ.
10. Fall back to the **global model** (Open-Meteo Marine) when the point is
    outside the 38 Irish stations (`GLOBAL_MODEL_FALLBACK_KM`, **100 km**, in
    `js/app.js`), and say that this is what happened.
11. **All times in the location's own timezone**, taken from the geocoder, with
    the offset and the abbreviation shown; the data itself is UTC and stays UTC
    until the moment of display.
12. **Work offline for the app shell**, and show the last fetched prediction
    with a visible "as of" timestamp rather than a silent stale number.
13. **Attribute** Marine Institute (CC-BY 4.0), Open-Meteo and GeoNames in the
    interface, not only in this file.
14. **State the limits**: not for navigation, predictions exclude surge, model
    currents are model currents.
15. **Fail visibly.** A source that is down, a point with no station within a
    sane distance, a request outside the published prediction window — each is
    a sentence on the screen, not an empty chart.

## Springs and neaps — how, and why not the textbook way

The textbook definition uses the **form factor** $F=(K_1+O_1)/(M_2+S_2)$ from
the station's harmonic constituents. Marine Institute publishes pre-computed
prediction series, not constituents (verified above), so $F$ is not available
to us without requesting the data separately.

What we do instead, and label as such: take the predicted **range** of each
successive high–low pair over a rolling fortnight, compare each day's range with
the mean of that window, and call it springs near the local maximum, neaps near
the local minimum. That is defensible, reproducible from the data we already
have, and it can name the date of the next spring tide — but it is an inference
about the range, not a calculation of the form factor, and `docs/derivations.md`
must say so in exactly those terms, with the `F`-factor definition recorded as
the alternative we chose not to use.

## Deliverable shape — a PWA, and why not the usual single file

The house rule prefers single-file scripts with embedded assets. A PWA cannot be
one file, and the reason is structural rather than aesthetic: a service worker
must be a separate script at its own URL, and the manifest is a separate JSON
document by specification. So the override is deliberate:

- `index.html` keeps the CSS inline (one file, one style block).
- The JavaScript is split by the seam above — three small ES modules — because
  the two testable ones must import cleanly into Node, which they could not do
  from inside an HTML file.
- Everything else stays as close to "one file" as the platform allows: no
  bundler, no framework, no build step, no `node_modules` at run time.

Two platform traps to remember, both of which cost an afternoon if forgotten:

- **A service worker needs a secure context.** `http://localhost` counts;
  `http://192.168.x.x` from the phone does **not**. So the phone tests against
  an HTTPS origin (GitHub Pages, `file://` will not do) — a local dev server is
  for the desk, not the pocket.
- **iOS has no install prompt.** `beforeinstallprompt` does not exist there;
  installing is Share → *Add to Home Screen*, and the interface has to say so
  in words rather than showing a button that never appears.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | The app shell — markup, inline CSS, module entry, the about overlay and the first-run hint layer. |
| `js/sources.js` | Source adapters; the only place that knows a provider's URL shape. DOM-free, unit-tested. |
| `js/tide.js` | Pure derivations: nearest station, rate, next turn, range, springs/neaps. DOM-free, unit-tested. |
| `js/app.js` | DOM, rendering, map browsing, install prompt, offline banner. |
| `vendor/leaflet/` | Vendored Leaflet 1.9.4 (`leaflet.js`, `leaflet.css`) for the map; BSD-2-Clause. |
| `sw.js` | Service worker: app shell cache, and a short-TTL cache for API responses. |
| `manifest.webmanifest` | Name, icons, colours, `display: standalone`. |
| `icons/` | `icon.svg` source plus generated PNG sizes; generated, not drawn by hand. |
| `data/stations.json` | Vendored snapshot of the 38 prediction stations: `{ id, name, latitude, longitude, curveId, kind }`, with the regeneration command and date in its header. `curveId` is the `imiTidePrediction` spelling, which differs from `id` for the twelve modelled stations. |
| `data/station-map.json` | The name mapping between the three spellings: `{ prediction, gauge, surge }` per station. Hand-checked, not guessed. |
| `tools/refresh-stations.sh` | Regenerates `data/stations.json` from ERDDAP (`curl` + `jq`). |
| `tools/make-icons.sh` | Rasterises `icons/icon.svg` with ImageMagick. |
| `publish.sh` | Stamps the version, tags the release, and publishes a fixed file whitelist to the `public` branch; `main` is never published directly. |
| `test/` | `node --test` units for `js/tide.js` and `js/sources.js`, with recorded fixtures. |
| `docs/data-sources.md` | The source contract: endpoints, variables, datums, licences, sample responses. |
| `docs/derivations.md` | The formulas, including springs/neaps and why not the form factor. |
| `README.md` | What it is, how to run it, how to install it on a phone. |
| `LICENSE` | MIT. |

## Commands

| Task | Command |
| --- | --- |
| Run locally | `python3 -m http.server 8000` then open `http://localhost:8000` |
| Unit tests | `npm test` (which is `node --test`, no dependencies) |
| Refresh station list | `./tools/refresh-stations.sh` |
| Regenerate icons | `./tools/make-icons.sh` |
| Publish to GitHub Pages | `./publish.sh` (stamps the version in `index.html` and bumps the service-worker cache version in `sw.js`, tags `vX.(Y+1)`, pushes main + tag + the `public` branch; Pages must be set to the `public` branch root once) |
| Check a source by hand | see the recorded queries under *Data sources* above |

`package.json` exists only to set `"type": "module"` and the test script. It
declares **no dependencies**; if it ever grows one, that is a decision to record
here in the same commit.

## Technology Stack

Update this section in the same commit that adds or upgrades a dependency.

### HTML and CSS (vanilla)

- **Role**: the app shell and all styling; no framework, no preprocessor.
- **Version**: whatever Safari and Chrome shipped this year; no pinning, and no
  feature we cannot see working on the phone in hand.
- **Best Practices**:
  - Phone-first: readable at arm's length, outdoors, one-handed. Large type for
    the two numbers that matter (height now, and time to the next turn).
  - One stylesheet, inline in `index.html`, per the house preference.
  - `prefers-color-scheme` respected, and overridable: the header's theme
    button cycles System → Light → Dark. The choice is kept in `localStorage`
    (`gealach-theme`) and applied as `data-theme` on `<html>`, which wins over
    the media query; "System" removes the attribute and follows the device
    again. The button shows one of three glyphs (half-filled circle, sun,
    moon) for the active state, and the `theme-color` meta is collapsed to a
    single value matching what is on screen.
- **Docs**: <https://developer.mozilla.org/en-US/docs/Web/CSS>

### JavaScript (ES modules, no bundler)

- **Role**: everything that runs; the app is three ES modules plus a worker.
- **Version**: ES2022 baseline (`fetch`, `Intl`, optional chaining, top-level
  `await` in modules). No transpiler, so no syntax that the target browsers
  cannot parse.
- **Best Practices**:
  - `js/tide.js` and `js/sources.js` stay DOM-free and dependency-free so Node
    can import and test them directly.
  - Time is handled with `Intl.DateTimeFormat` and IANA names from the geocoder.
    Never hand-roll an offset, and never store a local time without its zone.
  - Abort in-flight requests when the location changes; a slow answer for the
    previous station must not paint over the current one.
- **Docs**: <https://developer.mozilla.org/en-US/docs/Web/JavaScript>

### Leaflet (vendored, no bundler)

- **Role**: the OpenStreetMap browser for picking a coastal point.
- **Version**: 1.9.4, vendored under `vendor/leaflet/` (BSD-2-Clause). A
  deliberate dependency — the house rule prefers zero dependencies, but an
  interactive pan/zoom map is not worth hand-rolling; vendoring keeps it
  self-contained with no build step and no CDN at run time.
- **Best Practices**:
  - Tiles are OSM raster tiles; they are ordinary network images, so the map
    does not work offline even though the shell does.
  - Use `L.circleMarker` for the picked point, so no marker image assets are
    needed beyond `leaflet.js` and `leaflet.css`.
  - Create the map lazily and call `invalidateSize()` after un-hiding its
    container; Leaflet measures the container on creation.
- **Docs**: <https://leafletjs.com/reference.html>

### Web App Manifest and Service Worker (PWA)

- **Role**: installability on the phone and offline availability of the shell.
- **Version**: manifest served as `application/manifest+json`; service worker
  with a documented cache strategy rather than a stale-forever one.
- **Best Practices**:
  - Cache the shell (cache-first); cache API responses network-first with a
    short TTL and an explicit "fetched at" stamp shown in the interface.
  - Bump the cache name when the shell changes, and delete old caches on
    `activate`.
  - Service worker only over HTTPS or `localhost` — see *Deliverable shape*.
  - Provide `192`, `512` and a `purpose: maskable` icon; iOS additionally wants
    `apple-touch-icon`.
- **Docs**:
  <https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps> ·
  <https://web.dev/learn/pwa/service-workers/>

### GoatCounter (analytics)

- **Role**: privacy-friendly usage measurement — page views plus categorical
  custom events. Reverses the earlier "no analytics" non-goal (2026-10-07).
- **Version**: `https://gealach.goatcounter.com`; loaded in `index.html` as
  `<script data-goatcounter="https://gealach.goatcounter.com/count" async
  src="//gc.zgo.at/count.js">`. No cookies, no personal data (IPs hashed).
- **Best Practices**:
  - Custom events go through one guarded helper, `trackEvent(path)` in
    `js/app.js`, which fires `window.goatcounter.count({ path, event: true })`
    only when `window.goatcounter` exists (it is absent offline or blocked).
  - Event paths are **categorical slugs only** — never the typed place name, a
    picked coordinate, or a favourite's contents — so the "nothing about the
    user leaves the device" promise holds.
  - The counter script is third-party (`gc.zgo.at`) and is deliberately not
    cached by the service worker: beacons are never served stale and simply do
    not fire offline.
  - The footer discloses it: "Usage is measured with GoatCounter — no cookies,
    no personal data."
  - Event vocabulary: entry `search-name|coords|geolocate|map`; geocoding
    `geocode-fallback-photon`, `geocode-ambiguous`; source
    `source-marine-ie|open-meteo`, `source-fallback-open-meteo` (the Marine
    Institute was unreachable and the global model answered instead); distance
    `distance-local|warned|global`;
    surge `surge-shown|none`; switches `switch-marine|openmeteo`,
    `datum-lat|odm`; engagement `details-open`, `map-open`,
    `favourite-add|open|rename|remove`, `install-shown`, `installed`,
    `station-jump` (the offer to reach the nearest prediction station from a
    located inland point), `hint-search|jump|map-tap|heart|details|rename` (a
    first-run coachmark was shown);
    failures `error-geocode`, `error-source`. `error-no-station` and
    `error-out-of-window` are reserved for when those failure paths become
    explicit.
- **Docs**: <https://www.goatcounter.com/> · <https://www.goatcounter.com/api.html>

### Fetch feedback (loading, timeouts, failures)

- **Role**: make slow and failing sources visible rather than silent — the
  status line names *what* is being fetched (with a spinner), and a failure is
  a card with a friendly message and a retry.
- **Best Practices**:
  - **Name the source, not just "loading".** `setStatus` writes into
    `#status-text` beside a `.spinner`; each stage says which source and which
    product ("Fetching the tide from the Marine Institute and the current from
    Open-Meteo…").
  - **Bound every operation, not every request.** Adapters make several
    requests (the Marine Institute's high/low then its curve), so a per-request
    ceiling is not enough — a hung source would still take minutes.
    `withDeadline()` (`DEADLINE_MS`, 12 s) caps the whole operation;
    `sources.js` also gives each request a 15 s ceiling as a backstop.
  - **One source down is not a failure.** The Marine Institute and Open-Meteo
    are settled apart (`Promise.allSettled`); if Marine is unreachable the
    global model answers and `source-fallback-open-meteo` fires, alongside the
    existing global-model proximity warning. Only when *both* fail is the
    error card shown.
  - **A timeout is a failure, a cancel is a cancel.** `fetchJson` throws an
    ordinary `Error` on timeout so callers can fall back; only the caller's own
    signal (the point changed) stays an `AbortError`, which aborts the load
    silently.
  - `setFetchError`/`clearFetchError` drive the `#error-card` (a **Try again**
    button calls `retryFetch`, which aborts first for a fresh controller);
    `setSearchError` remains for a search that cannot be answered at all.
### First-run hints (coachmarks)

- **Role**: a short set of coachmarks that point out the app's gestures the
  first time each becomes reachable — search, jump-to-nearest-sea, tap-the-map,
  save-to-favourites, rename-a-favourite. A one-off onboarding experiment
  (2026-10-09).
- **Version**: no dependency; plain DOM in `index.html` (`.hint-layer`) and
  `js/app.js`.
- **Best Practices**:
  - **Contextual, not a fixed tour.** The later hints anchor to controls that
    do not exist on a cold first run (the heart, a favourite's rename pencil),
    so each hint is offered from the flow at the moment its subject appears, via
    one guarded `maybeHint()` call. `HINTS` order is the priority order.
  - **Once per device.** "Seen" is a growing array under
    `localStorage["gealach-hints-seen"]`; a hint already there is never shown
    again. It is **not** versioned, so a release does not re-show them (a
    deliberate choice — see the experiment note).
  - The spotlight is a ring (`#hint-ring`) with a huge spread `box-shadow`, so
    the hole tracks the element's live rect without any masking; the ring and
    bubble are repositioned on scroll/resize while open.
  - Dismissed by the "Got it" button, a tap on the scrim, or `Escape`. It is a
    real modal (`role="dialog"`, `aria-modal`) that dims the page — it does not
    let the reader interact through it.
  - These are UI-only; nothing here talks to a source. Remove the whole feature
    by deleting `HINTS`/the hint functions and the `.hint-*` CSS/markup.

### Developer overlay (the hidden door — "The Secret Rose")

- **Role**: a developer/testing panel to reset this device's stored state
  without devtools. Two actions: clear the first-run hints (so the coachmarks
  show again) and clear **all** local data (theme, favourites and hints). A
  testing aid (2026-10-09), not a user feature. Titled **"The Secret Rose"** —
  a Yeats poem, set in the same gold italic serif as the app's other quotes and
  linked to Wikisource — so the door reads as a place, not a settings menu.
- **Version**: no dependency; plain DOM in `index.html` (`#debug-overlay`) and
  `js/app.js`.
- **Best Practices**:
  - **Hidden by design.** Opened only by a **3-second long-press** on an
    invisible hit-area (`#debug-hotspot`) in the top-right corner of the
    *about* panel (`.overlay-panel` is `position: relative`, the hotspot is
    absolute). A short press does nothing; the hotspot has no visual presence,
    so it does not invite a tap. It does not appear on the page itself.
  - **It only clears our own keys**, listed once in `LOCAL_KEYS`
    (`gealach-theme`, `gealach-favourites`, `gealach-hints-seen`). "Clear all
    data" also re-applies theme/favourites through the normal
    `initTheme`/`loadFavourites`/`renderFavourites` paths, so the change is
    visible without a reload.
  - Closing the overlay calls `maybeHint()`, so clearing the hints makes the
    next coachmark reappear. While the overlay is open `maybeHint()` is a no-op
    (it must not pop a hint over the panel it was launched from).
  - Dismissed by the Close button, a tap on the backdrop, or `Escape`.
  - Remove the feature by deleting `#debug-overlay`/`#debug-hotspot` and the
    `startDebugHold`/`openDebug`/`clearLocalKeys`/… functions and the
    `.debug-*` CSS.
### Marine Institute ERDDAP (primary data source)

- **Role**: Irish tide predictions, high/low turns, surge split, gauge
  observations.
- **Version**: ERDDAP 2.14 at `erddap.marine.ie`; dataset IDs are pinned
  (`IMI_TidePrediction_HighLow`, `imiTidePrediction`, `imiSurgePrediction`,
  `imiSurgeObservationINTGN`, `IrishNationalTideGaugeNetwork`).
- **Best Practices**:
  - Ask for the exact variables and the exact time window; the gauge datasets
    are large and an unbounded query returns nothing useful.
  - Read the returned series' own extent rather than assuming coverage.
  - Use `.json` for the app and `.csv`/`.das` when investigating by hand.
  - Attribution "Marine Institute" (CC-BY 4.0) on screen.
  - A deprecated dataset exists beside every current one (`IMI-TidePrediction`,
    `IMI-TidePrediction_epa`, "to be replaced" in their titles): always take the
    current ID, never the one next to it.
- **Docs**: <https://erddap.marine.ie/erddap/index.html> ·
  <https://erddap.marine.ie/erddap/tabledap/documentation.html> ·
  <https://www.marine.ie/site-area/data-services/real-time-observations/tidal-predictions>

### Open-Meteo Marine API (fallback tide, modelled currents)

- **Role**: tide and current for points outside the Irish station set, and the
  modelled current over Irish waters.
- **Version**: `/v1/marine`: `sea_level_height_msl`, `ocean_current_velocity`,
  `ocean_current_direction`; Météo-France SMOC, 0.08° (~8 km), hourly, ~10-day.
- **Best Practices**:
  - Free tier is **non-commercial and under 10,000 calls/day** — cache rather
    than re-request on every view, and revisit before any public deployment.
  - Use the response's own `latitude`/`longitude` as *the model grid point* and
    display the offset from the requested point; do not pretend it is exact.
  - `sea_level_height_msl` is referenced to global mean sea level, **not** LAT —
    it is a different thing from a chart datum, and the interface says so.
  - Show `sea_level_height_msl` as a shape and a state (rising/falling, time to
    turn) rather than as a navigational height.
- **Docs**: <https://open-meteo.com/en/docs/marine-weather-api> ·
  <https://open-meteo.com/en/licence>

### Open-Meteo Geocoding API

- **Role**: place name → coordinates, timezone, and country.
- **Version**: `/v1/search`, GeoNames-derived.
- **Best Practices**:
  - Send `count` and `language`, and bias the search towards Ireland with the
    API's own `countryCode=IE` filter (a second, unbounded call supplies the
    worldwide alternatives). Ireland always ranks first — an Irish tide tool
    should mean Irish Galway — but the alternatives are **shown**, never hidden
    or silently picked — "Galway" also matches a town in Tennessee (verified).
  - GeoNames misses many Irish townlands, so when no result has
    `country_code = "IE"`, fall back to Photon forward geocoding (OSM) and
    merge the alternatives; resolve Photon's missing timezone with
    `timezone=auto` at choose time.
  - Take `timezone` from this response; do not infer it from longitude.
  - Attribute GeoNames/Open-Meteo (CC-BY 4.0).
- **Docs**: <https://open-meteo.com/en/docs/geocoding-api>

### Node.js (development only)

- **Role**: the test runner (`node --test` with `node:assert`). Nothing at run
  time depends on Node.
- **Version**: v22.22.0 is what is installed here; the built-in test runner
  needs nothing beyond it.
- **Best Practices**: keep tests dependency-free, and keep fixtures as recorded
  real responses (trimmed) so a source changing shape fails a test rather than
  the app.
- **Docs**: <https://nodejs.org/api/test.html>

### Python 3 (development only)

- **Role**: `python3 -m http.server` for a local origin.
- **Version**: 3.14.6 here; any 3.x with `http.server` will do.
- **Best Practices**: local dev only. It writes nothing, so it leaves no cache
  directories to ignore — and remember it is not a secure context for anything
  but `localhost`.
- **Docs**: <https://docs.python.org/3/library/http.server.html>

### ImageMagick (`magick`) — development only

- **Role**: rasterising `icons/icon.svg` into the PNG sizes the manifest and iOS
  need.
- **Version**: 7.1.1-34 here, called as `magick`.
- **Best Practices**:
  - **`-background none` goes *before* the input file.** After it, transparent
    areas are silently filled opaque white, which puts a white square behind a
    rounded icon. Verify with
    `magick -background none f.svg -format '%[pixel:p{2,2}] %[fx:minima.a]' info:`
    (corner pixel must be `srgba(0,0,0,0)`).
  - This build has **no librsvg delegate**, so its internal renderer drops
    gradients and dashes. Keep `icon.svg` flat — solid fills, no gradients, no
    dashes, no filters — and the PNG matches a browser rendering to ~1.7 % RMSE.
    Do not reach for a browser screenshot for flat art.
- **Docs**: <https://imagemagick.org/Usage/>

### Shell, `curl` and `jq` (development only)

- **Role**: `tools/refresh-stations.sh` — fetch the station list from ERDDAP and
  write `data/stations.json`.
- **Version**: `jq` 1.7.1 here; the script must check for both and say what is
  missing rather than writing a broken file.
- **Best Practices**: write to a temporary file and move it into place; record
  the generation date and the exact URL in the JSON header; never let a failed
  fetch truncate the committed snapshot.
- **Docs**: <https://stedolan.github.io/jq/manual/> ·
  <https://erddap.marine.ie/erddap/tabledap/documentation.html>

## Keeping `.gitignore` current — required

`.gitignore` is part of a change, never a follow-up to it. When a change creates
files that should not be committed, the patterns go in **the same commit** — a
cached response committed by accident is much harder to remove than a line is
to add.

Keep current, at minimum, for this project:

- **Tool and dependency output**: `node_modules/` and npm logs (present even
  though we declare no dependencies), plus any cache directory a tool invents.
- **Local state**: `.env`, `*.env`, `.env.local` — unused today, but the moment
  a keyed source (WorldTides, Stormglass, UKHO) is tried, its key lives here and
  never in the repository. Also `*.log`.
- **Editor and OS metadata**: `.DS_Store`, `*.swp`.

Rules and the two traps this project has specifically:

- **`data/stations.json` and `data/station-map.json` are source.** They are
  vendored snapshots the app needs at run time, so they are committed — a
  blanket `*.json` or `data/` ignore would break the app, which is exactly the
  failure the house rules warn about.
- **Do not ignore `.vscode/` wholesale.** Ignore the specific local artefacts
  inside it instead; a shared `launch.json` or `tasks.json` is useful here and
  an un-ignore rule added later is confusing.
- No Python ignore patterns: the only Python in the project is `python3 -m
  http.server`, which writes nothing. If a `tools/*.py` ever lands, add
  `__pycache__/` and `*.py[cod]` in that same commit.
- Prefer official patterns (npm's own `.gitignore` template) over invented ones.

## Project rules

- **Never present an inference as a measurement.** Springs/neaps, "the tide is
  flooding", a current direction: each is derived or modelled, and the interface
  says which. `docs/derivations.md` carries the formula for each.
- **Distance and datum are always visible.** A height without its datum, or a
  station without its distance, is a number a user cannot act on.
- **Rounding is a presentation decision, made once**: heights to 0.1 m, times to
  the minute, rates to 0.1 m/h, distances to 1 km. Do not round twice.
- **UTC in, local out.** Sources are UTC; `Intl` with the geocoded IANA zone
  does the conversion at render time, and nothing stores a naive local time.
- **Provenance travels with the number** — source, station, distance, datum,
  fetch time — so no screen can show a value whose origin is unknowable.
- **A new region is a new adapter**, plus fixtures and tests, and a line in
  *Data sources*. The UI must not need to change.
- **Verification is part of the change.** Run `npm test`, load the page in the
  browser, exercise the changed path against the live source, and put the
  outcome in the commit body. "It should work" is not a result.
- **Update this file in the same commit** that adds a source or a dependency,
  with rationale, Best Practices and docs links; add the `.gitignore` patterns
  at the same time.

## Commit conventions

- Imperative sentences, no conventional-commit prefix: "Add the Marine
  Institute high/low adapter".
- The subject says what changed; the body says **why**, and records the trap
  avoided or the measurement that justified the choice — the datum
  confusion, the `altitude` dummy, the station-key mismatch.
- One logical change per commit.
- Record the source verification in the body when the change touches an
  adapter: the URL called and what came back.

## AI attribution — required

Any commit produced with an AI coding assistant — for the code, the docs, the
artwork, or the commit message itself — must end with a trailer naming the
assistant **and** the exact model and version:

```
Assisted-by: <assistant> (<model> <version>)
```

```
Assisted-by: GitHub Copilot (DeepSeek V4 Flash)
```

Rules:

- Name the model you were actually running, and its version when it has one.
  "AI", "Copilot", "an LLM" or a bare tool name is not attribution.
- One trailer per assistant: two assistants on one commit means two
  `Assisted-by:` trailers.
- Use `git commit --trailer "Assisted-by=GitHub Copilot (DeepSeek V4 Flash)"`
  rather than hand-placing the line, so it lands in the trailer block.
- No trailer means the work was written by hand. Never add one for a change you
  did not make.

### Elsewhere, not only in commits

- **Documents and prose** substantially written by an assistant — this file,
  `README.md`, `docs/derivations.md` — carry the assistant, model and version,
  as a note in the document or in a short "AI contributions" list.
- **Release notes, tags and pull-request descriptions** written with an
  assistant end with the same `Assisted-by:` trailer.
- **Generated artefacts** that are committed (icon PNGs, recorded fixtures)
  record in their header, or in the command that regenerates them, which tooling
  and which assistant produced them, so the result can be reproduced.

When in doubt, attribute. An unnecessary trailer costs a line; a missing one
misrepresents who wrote the work.

## General house rules

These apply to every home project unless a project has a reason to override one.

- **License**: MIT, in `LICENSE`. Nothing here links GPL tooling — ImageMagick
  is used at development time only and is permissively licensed — so the AGPL
  exception for `videos` does not apply. The *data* keeps its own licence
  (Marine Institute CC-BY 4.0, Open-Meteo/GeoNames CC-BY 4.0) and attribution is
  shown in the interface regardless of the code licence.
- **README**: says what the project is, how to run it locally, and how to get it
  onto a phone.
- **Install**: if a CLI ever appears, it installs through an idempotent
  `install.sh` symlinking into `$HOME/bin`, warning when `$HOME/bin` is not on
  `PATH` (zsh). The first version is a web app and needs none.
- **Prefer self-contained, low-dependency tooling**: no build step, no framework,
  no run-time dependency, and the deliberate single-file override explained
  under *Deliverable shape*.
- **Verify before claiming done**: run the tests, load the page, call the source,
  and record the outcome in the commit body.
- **Keep this file current**: a change that introduces a language, library or
  dependency updates `AGENTS.md` and `.gitignore` in the same commit.

<!--
This file was written with an AI coding assistant, and updated with one in
2026-10-04 when the first implementation landed.
Assisted-by: GitHub Copilot (DeepSeek V4 Flash)
Assisted-by: GitHub Copilot (DeepSeek V4 Pro)
-->
