# Data sources

The contract each adapter in `js/sources.js` implements, and the evidence for
it. Every endpoint below was called against the live service; the date of that
verification is recorded with the response.

## The normalised shape

Every tide adapter returns one object, in UTC, with provenance attached:

```
{
  source,                 // "marine-ie" | "open-meteo" | "noaa"
  station,                // provider's id for the station/grid point
  stationName,            // display name
  kind,                   // "gauge" | "model" | "global-model"
  latitude, longitude,    // of the station or model grid point
  distanceKm,             // from the requested point (null when unknown)
  datum,                  // datum of `height` in `series`
  series,                 // [{ time, height }] ascending
  seriesODM,              // [{ time, height }] OD Malin, or null
  extremes,               // [{ time, type: "HIGH"|"LOW", height, heightODM }]
  currents,               // [{ time, speed, direction }] or null
  fetchedAt,              // ISO 8601 UTC
}
```

`height` is the primary datum of the source. On an extreme, `heightODM` is the
OD Malin value, present only where the source publishes one. All times are
ISO 8601 UTC strings.

## Marine Institute ERDDAP (Ireland) — primary

`https://erddap.marine.ie/erddap` — ERDDAP 2.14, no key, CORS open, data
licensed **CC-BY 4.0**. 38 prediction "stations" (`stationID` values are
underscored: `Galway`, `Malin_Head`, `Dublin_Port`, …), spanning 51.56–55.37 N
and 10.28–6.01 W.

| Dataset (`tabledap`) | Gives | Adapter |
| --- | --- | --- |
| `IMI_TidePrediction_HighLow` | the turns: `time`, `tide_time_category` (`HIGH`/`LOW`), `Water_Level_ODMalin` | `marineIeTides` (extremes) |
| `imiTidePrediction` | the curve: `Water_Level` (above local **LAT**, chart datum) and `Water_Level_ODM` (relative to **OD Malin**) | `marineIeTides` (series, seriesODM) |
| `imiSurgeObservationINTGN` | observed tide and surge, kept apart | `marineIeSurge` |

Verified by execution (2026-09-30):

```
# the turns, one station
https://erddap.marine.ie/erddap/tabledap/IMI_TidePrediction_HighLow.json?stationID,time,tide_time_category,Water_Level_ODMalin&stationID="Galway"&time>=2026-09-30T00:00:00Z&time<=2026-10-02T00:00:00Z
  → ["Galway","2026-09-30T00:35:00Z","LOW",-2.274] ["Galway","2026-09-30T07:00:00Z","HIGH",2.235] …

# the curve, one station
https://erddap.marine.ie/erddap/tabledap/imiTidePrediction.json?stationID,time,Water_Level,Water_Level_ODM&stationID="Galway"&time>=2026-09-30T06:00:00Z&time<=2026-09-30T08:00:00Z
  → ["Galway","2026-09-30T06:00:00Z",4.85,1.91], then 5-minute steps rising to the 07:00 turn

# observed tide and surge, split
https://erddap.marine.ie/erddap/tabledap/imiSurgeObservationINTGN.json?stationID,time,sea_surface_elevation_due_to_tide,sea_surface_elevation_due_to_storm_surge&stationID="Galway"&time>=2026-09-30T00:00:00Z
  → ["Galway","2026-09-30T00:00:00Z",-2.141,0.392] …
```

### Traps, each one observed rather than guessed

- **`Water_Level` and `Water_Level_ODM` are different datums**, not a rounding
  difference: for Galway at 06:00Z they were 4.85 m and 1.91 m. Chart datum
  (LAT) is what a chart and a tide table use; OD Malin is the land datum. The
  interface names which one it is showing and defaults to LAT.
- **The high/low dataset publishes only the OD Malin height** for a turn. The
  adapter therefore takes the turn's *time* and *category* from
  `IMI_TidePrediction_HighLow`, takes its OD Malin height from the same row,
  and interpolates the LAT height from the 5-minute `imiTidePrediction` curve
  (linear interpolation between the bracketing steps). Ranges for the
  springs/neaps inference use OD Malin, which is fine: a range is a difference
  and the datum offset cancels.
- **Three datasets, three spellings of the station key.** Predictions use
  `stationID` (`Galway`), the gauge network uses `station_id` (`Galway Port`),
  and the surge observation uses `stationID` again with compact names
  (`Galway`, `Dublinport`, `Malinhead`, …). The mapping lives in
  `data/station-map.json`, hand-checked, not guessed.
- **Prediction coverage moves.** Never assume the end date; the request falls
  outside it, the series that comes back is short, and the interface says so.
- **Not every "station" is a gauge.** Some prediction stations are derived from
  Marine Institute's regional ROMS model. The station list carries a `kind`
  field ("gauge"/"model") where known, and the adapter falls back to a
  `MODELLED` marker in the id.
- **Harmonic constituents are not published here**, so a real form factor
  cannot be computed — see `docs/derivations.md`.

## Open-Meteo Marine API — fallback tide and currents

`https://marine-api.open-meteo.com/v1/marine` — no key, CORS open, free for
non-commercial use below 10,000 calls/day, attribution required. Variables:
`sea_level_height_msl` (metres), `ocean_current_velocity`,
`ocean_current_direction` (compass, "where the current is heading towards").
Backed by Météo-France SMOC at 0.08° (~8 km), hourly, ~10 days ahead.

Verified (2026-10-04), Galway (53.27, -9.05):

```
latitude 53.291664, longitude -9.0416565      ← the model grid point, ~2.5 km from the request
hourly: time "2026-10-04T00:00" (no zone), sea_level_height_msl in m,
        ocean_current_velocity in km/h, ocean_current_direction in °
timezone "GMT"                                ← the API's own answer; the geocoder gives Europe/Dublin
```

The adapter asks for `timezone=UTC` and appends `:00Z` to the returned times,
converts current speed from km/h to m/s, and records the grid point and its
distance from the requested point. `sea_level_height_msl` is referenced to
global mean sea level, **not** a chart datum; the interface says so.

Open-Meteo's own documentation is repeated in the interface: "Accuracy is
limited in coastal areas … This data is not suitable for coastal navigation."

## Open-Meteo Geocoding API

`https://geocoding-api.open-meteo.com/v1/search?name=…` — no key, CORS open,
GeoNames-derived (CC-BY 4.0). Returns `latitude`, `longitude`, `timezone`
(`Europe/Dublin` for Galway), `country_code`, `admin1`, `population`.

Verified (2026-10-04): "Galway" returns Galway IE, Gallaway TN, Galway NY,
Galloway JM, Galway Park MD. The app prefers the `IE` result but shows the
alternatives rather than silently choosing one.

## NOAA CO-OPS — United States extension

`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` — no key, CORS
open. Product `predictions` with `interval=hilo` is the analogue of the Irish
turns. NOAA asks for an `application=` parameter and throttles heavy use; the
adapter identifies itself as `taoidi`.

Verified (2026-10-04), San Francisco (9414290):

```
begin_date=20261004&end_date=20261005&datum=MLLW&time_zone=gmt&units=metric&interval=hilo
  → {"t":"2026-10-04 00:11","v":"1.765","type":"H"} …  (8 rows, 4/day)
```

Heights are in the requested datum (MLLW here). The adapter returns extremes
only; the hourly curve product is a later extension.

## Map browsing — OpenStreetMap, Photon, timezone

- **Tiles**: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, rendered by
  vendored Leaflet 1.9.4. Data is © OpenStreetMap contributors (ODbL), with
  attribution in the map and the footer. Tiles are network images, so the map
  itself does not work offline.
- **Reverse geocoding**: Photon (`https://photon.komoot.io/reverse?lat=…&lon=…`),
  an OpenStreetMap-based geocoder with `access-control-allow-origin: *`
  (Nominatim itself does not send CORS headers). Returns
  `features[0].properties.name`, `country`, `countrycode`, `state`. Used to
  name a point picked on the map. Verified (2026-10-05): 53.27, -9.05 →
  `"Commercial Dock", "Ireland"`.
- **Timezone for a picked point**: Open-Meteo's forecast endpoint with
  `timezone=auto` returns the IANA zone. Verified (2026-10-05): 53.27, -9.05 →
  `"Europe/Dublin"` (`GMT+1`, `utc_offset_seconds: 3600`).

## Candidates, not adopted

See `AGENTS.md` — Copernicus Marine, WorldTides, Stormglass, UKHO Admiralty,
and local harmonic synthesis are recorded there with what was and was not
checked, so nobody re-derives them.

---

This file was written with an AI coding assistant.
Assisted-by: GitHub Copilot (DeepSeek V4 Pro)
