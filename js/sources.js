// js/sources.js
//
// Source adapters: the only place that knows a provider's URL shape. Each
// adapter takes a point (or a place query) and a time window and returns the
// same normalised shape, in UTC, with provenance attached. Nothing above this
// layer knows what ERDDAP is or that Open-Meteo exists.
//
// DOM-free and dependency-free (Node imports this file directly for tests).
//
// Normalised shape returned by a tide adapter:
//   {
//     source,                 // "marine-ie" | "open-meteo" | "noaa"
//     station,                // provider's id for the station/grid point
//     stationName,            // display name
//     kind,                   // "gauge" | "model" | "global-model"
//     latitude, longitude,    // of the station or model grid point
//     distanceKm,             // from the requested point (null when unknown)
//     datum,                  // datum of `height` in `series`
//     series,                 // [{ time, height }] ascending
//     seriesODM,              // [{ time, height }] OD Malin, or null
//     extremes,               // [{ time, type: "HIGH"|"LOW", height, heightODM }]
//     currents,               // [{ time, speed, direction }] or null
//     fetchedAt,              // ISO 8601 UTC
//   }
//
// `height` is the primary datum of the source. `heightODM` on an extreme is
// the OD Malin value, present only where the source publishes one.

import { haversineKm, nearestStation } from "./tide.js";

const ERDDAP = "https://erddap.marine.ie/erddap";
const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
const OPEN_METEO_MARINE = "https://marine-api.open-meteo.com/v1/marine";
const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";
const PHOTON = "https://photon.komoot.io";
const NOAA = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// helpers

const iso = (d) => d.toISOString();

async function fetchJson(url, signal) {
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new Error(`network error fetching ${url}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const data = await res.json();
  return { data, fetchedAt: fetchTime(res) };
}

// When the service worker serves a cached response it stamps x-gealach-fetched;
// otherwise the Date header is the fetch time. Falling back to "now" keeps the
// shape complete when neither header exists.
function fetchTime(res) {
  const raw =
    res.headers.get("x-gealach-fetched") ||
    res.headers.get("date") ||
    new Date().toUTCString();
  const ms = Date.parse(raw);
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

function laterIso(a, b) {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** ERDDAP tabledap JSON -> array of row objects keyed by column name. */
function rowsToObjects(table) {
  const cols = table.columnNames;
  return table.rows.map((row) => {
    const obj = {};
    for (let i = 0; i < cols.length; i += 1) obj[cols[i]] = row[i];
    return obj;
  });
}

/** Build an ERDDAP tabledap .json URL from variables and constraints. */
function erddapUrl(dataset, vars, constraints) {
  const parts = [vars.join(",")];
  for (const [k, v] of constraints) parts.push(`${k}=${encodeURIComponent(v)}`);
  return `${ERDDAP}/tabledap/${dataset}.json?${parts.join("&")}`;
}

/** Linear interpolation of `field` across `rows` (sorted) at time tMs. */
function interpolate(rows, tMs, field) {
  if (!rows.length) return null;
  const times = rows.map((r) => Date.parse(r.time));
  if (tMs < times[0] || tMs > times[times.length - 1]) return null;
  let i = 0;
  while (i < times.length - 1 && times[i + 1] <= tMs) i += 1;
  const a = rows[i][field];
  const b = rows[i + 1][field];
  if (a == null || b == null) return null;
  const dt = times[i + 1] - times[i];
  if (dt <= 0) return a;
  return a + (b - a) * ((tMs - times[i]) / dt);
}

/**
 * Open-Meteo times are "YYYY-MM-DDTHH:mm" (no seconds, no zone). We ask for
 * timezone=UTC, so turn them into UTC instants.
 */
function toIsoUTC(t) {
  if (/Z$/.test(t)) return t;
  if (/:\d{2}:\d{2}$/.test(t)) return `${t}Z`;
  if (/:\d{2}$/.test(t)) return `${t}:00Z`;
  return `${t}Z`;
}

/** NOAA times are "YYYY-MM-DD HH:mm" (GMT when time_zone=gmt). */
function noaaTime(t) {
  return `${t.replace(" ", "T")}:00Z`;
}

/** Turns derived from an hourly series by sign changes of the rate. */
function deriveExtremes(series) {
  const out = [];
  for (let i = 1; i < series.length - 1; i += 1) {
    const prev = series[i - 1].height;
    const cur = series[i].height;
    const next = series[i + 1].height;
    if (prev == null || cur == null || next == null) continue;
    const d1 = cur - prev;
    const d2 = next - cur;
    if (d1 > 0 && d2 < 0) {
      out.push({ time: series[i].time, type: "HIGH", height: cur, heightODM: null });
    } else if (d1 < 0 && d2 > 0) {
      out.push({ time: series[i].time, type: "LOW", height: cur, heightODM: null });
    }
  }
  return out;
}

function defaultWindows(w = {}, now = new Date()) {
  const n = new Date(now);
  const mk = (ms) => iso(new Date(n.getTime() + ms));
  return {
    curveStart: w.curveStart ?? mk(-2 * HOUR_MS),
    curveEnd: w.curveEnd ?? mk(48 * HOUR_MS),
    extremesStart: w.extremesStart ?? mk(-7 * DAY_MS),
    extremesEnd: w.extremesEnd ?? mk(21 * DAY_MS),
  };
}

// ---------------------------------------------------------------------------
// Geocoding (Open-Meteo, GeoNames-derived)

export async function geocode(query, { language = "en", count = 5, signal } = {}) {
  const url =
    `${GEOCODE}?name=${encodeURIComponent(query)}` +
    `&count=${count}&language=${language}&format=json`;
  const { data, fetchedAt } = await fetchJson(url, signal);
  return {
    source: "open-meteo-geocoding",
    query,
    results: (data.results || []).map((r) => ({
      name: r.name,
      country: r.country ?? null,
      countryCode: r.country_code ?? null,
      admin1: r.admin1 ?? null,
      latitude: r.latitude,
      longitude: r.longitude,
      timezone: r.timezone ?? null,
      population: r.population ?? null,
    })),
    fetchedAt,
  };
}

/**
 * IANA timezone for a point, from Open-Meteo's forecast endpoint
 * (timezone=auto). Used when the point came from the map rather than from a
 * geocoded name, so map picks still show local time.
 */
export async function timezoneAt(point, { signal } = {}) {
  const params = new URLSearchParams({
    latitude: String(point.latitude),
    longitude: String(point.longitude),
    current_weather: "true",
    timezone: "auto",
  });
  const { data } = await fetchJson(`${OPEN_METEO_FORECAST}?${params.toString()}`, signal);
  return {
    timezone: data.timezone || "UTC",
    timezoneAbbreviation: data.timezone_abbreviation || null,
  };
}

/**
 * Reverse geocode a point through Photon (OpenStreetMap-based, CORS open).
 * Returns a place name for display; nulls when the point is not named.
 */
export async function reverseGeocode(point, { signal } = {}) {
  const params = new URLSearchParams({
    lat: String(point.latitude),
    lon: String(point.longitude),
    lang: "en",
  });
  const { data } = await fetchJson(`${PHOTON}/reverse?${params.toString()}`, signal);
  const feature = (data.features || [])[0];
  const p = feature?.properties || {};
  return {
    name: p.name ?? null,
    country: p.country ?? null,
    countryCode: p.countrycode ?? null,
    state: p.state ?? null,
  };
}

// ---------------------------------------------------------------------------
// Marine Institute ERDDAP (Ireland): tides, curve, surge

/**
 * Irish tide predictions: the 5-minute curve (chart datum and OD Malin) and
 * the high/low turns. `stations` is the vendored station list
 * ([{ id, name?, kind?, latitude, longitude }]). Windows default to a display
 * window of ~two days and an extremes window of ~four weeks, which is what the
 * springs/neaps inference needs.
 */
export async function marineIeTides(point, windows = {}, stations = [], { signal } = {}) {
  const w = defaultWindows(windows);
  const near = nearestStation(point, stations);
  if (!near) throw new Error("no Marine Institute prediction station available");

  const stationId = near.id;

  // The turns. Only the OD Malin height is documented for this dataset.
  const hlUrl = erddapUrl(
    "IMI_TidePrediction_HighLow",
    ["stationID", "time", "tide_time_category", "Water_Level_ODMalin"],
    [
      ["stationID", `"${stationId}"`],
      ["time>=", w.extremesStart],
      ["time<=", w.extremesEnd],
    ],
  );
  const hl = await fetchJson(hlUrl, signal);
  const hlRows = rowsToObjects(hl.data.table);

  // The curve, in both datums.
  const curveUrl = erddapUrl(
    "imiTidePrediction",
    ["stationID", "time", "Water_Level", "Water_Level_ODM"],
    [
      ["stationID", `"${stationId}"`],
      ["time>=", w.curveStart],
      ["time<=", w.curveEnd],
    ],
  );
  const curve = await fetchJson(curveUrl, signal);
  const curveRows = rowsToObjects(curve.data.table);

  if (!curveRows.length) {
    throw new Error(`no curve predictions for ${stationId} in the requested window`);
  }

  const series = curveRows.map((r) => ({
    time: r.time,
    height: r.Water_Level,
  }));
  const seriesODM = curveRows.map((r) => ({
    time: r.time,
    height: r.Water_Level_ODM,
  }));

  const extremes = hlRows.map((r) => ({
    time: r.time,
    type: r.tide_time_category === "HIGH" ? "HIGH" : "LOW",
    height: interpolate(curveRows, Date.parse(r.time), "Water_Level"),
    heightODM: r.Water_Level_ODMalin,
  }));

  return {
    source: "marine-ie",
    station: stationId,
    stationName: near.name ?? stationId,
    kind: near.kind ?? (/MODELLED/i.test(stationId) ? "model" : "gauge"),
    latitude: near.latitude,
    longitude: near.longitude,
    distanceKm: near.distanceKm,
    datum: "LAT",
    series,
    seriesODM,
    extremes,
    currents: null,
    fetchedAt: laterIso(hl.fetchedAt, curve.fetchedAt),
  };
}

/**
 * Observed tide and surge, kept apart. Takes the *surge* spelling of the
 * station id ("Galway", "Dublinport", … — see data/station-map.json), which is
 * not the same string as the prediction `stationID`.
 */
export async function marineIeSurge(surgeStationId, { start, end, signal } = {}) {
  const url = erddapUrl(
    "imiSurgeObservationINTGN",
    [
      "stationID",
      "time",
      "sea_surface_elevation_due_to_tide",
      "sea_surface_elevation_due_to_storm_surge",
    ],
    [
      ["stationID", `"${surgeStationId}"`],
      ["time>=", start],
      ["time<=", end],
    ],
  );
  const { data, fetchedAt } = await fetchJson(url, signal);
  const rows = rowsToObjects(data.table);
  return {
    source: "marine-ie",
    dataset: "imiSurgeObservationINTGN",
    station: surgeStationId,
    series: rows.map((r) => ({
      time: r.time,
      tide: r.sea_surface_elevation_due_to_tide,
      surge: r.sea_surface_elevation_due_to_storm_surge,
    })),
    fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// Open-Meteo Marine (global fallback tide + modelled currents)

export async function openMeteoMarine(point, { days = 2, start, end, signal } = {}) {
  const params = new URLSearchParams({
    latitude: String(point.latitude),
    longitude: String(point.longitude),
    hourly: "sea_level_height_msl,ocean_current_velocity,ocean_current_direction",
    timezone: "UTC",
  });
  if (start && end) {
    params.set("start_date", start);
    params.set("end_date", end);
  } else {
    params.set("forecast_days", String(days));
  }

  const { data, fetchedAt } = await fetchJson(`${OPEN_METEO_MARINE}?${params.toString()}`, signal);
  const h = data.hourly || {};
  const time = h.time || [];
  const sea = h.sea_level_height_msl || [];
  const vel = h.ocean_current_velocity || [];
  const dir = h.ocean_current_direction || [];

  const series = [];
  const currents = [];
  for (let i = 0; i < time.length; i += 1) {
    const t = toIsoUTC(time[i]);
    if (sea[i] != null) series.push({ time: t, height: sea[i] });
    if (vel[i] != null && dir[i] != null) {
      // Open-Meteo reports current speed in km/h; normalise to m/s.
      currents.push({ time: t, speed: vel[i] / 3.6, direction: dir[i] });
    }
  }

  const gridLat = data.latitude;
  const gridLon = data.longitude;

  return {
    source: "open-meteo",
    station: `grid ${gridLat.toFixed(4)}, ${gridLon.toFixed(4)}`,
    stationName: "Open-Meteo Marine (SMOC, 0.08°)",
    kind: "global-model",
    latitude: gridLat,
    longitude: gridLon,
    distanceKm: haversineKm(point.latitude, point.longitude, gridLat, gridLon),
    datum: "MSL",
    series,
    seriesODM: null,
    extremes: deriveExtremes(series),
    currents,
    fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// NOAA CO-OPS (United States extension)

/**
 * US tide predictions (high/low by default). Returns extremes only; the curve
 * product is a later extension. NOAA wants YYYYMMDD dates and asks every
 * caller to identify itself via `application`.
 */
export async function noaaPredictions(
  stationId,
  { start, end, datum = "MLLW", interval = "hilo", signal } = {},
) {
  const begin = String(start).replace(/-/g, "").slice(0, 8);
  const finish = String(end).replace(/-/g, "").slice(0, 8);
  const params = new URLSearchParams({
    product: "predictions",
    application: "gealach",
    begin_date: begin,
    end_date: finish,
    datum,
    station: stationId,
    time_zone: "gmt",
    units: "metric",
    interval,
    format: "json",
  });

  const { data, fetchedAt } = await fetchJson(`${NOAA}?${params.toString()}`, signal);
  const extremes = (data.predictions || []).map((p) => ({
    time: noaaTime(p.t),
    type: p.type === "H" ? "HIGH" : "LOW",
    height: Number(p.v),
    heightODM: null,
  }));

  return {
    source: "noaa",
    station: stationId,
    stationName: stationId,
    kind: "gauge",
    latitude: null,
    longitude: null,
    distanceKm: null,
    datum,
    series: [],
    seriesODM: null,
    extremes,
    currents: null,
    fetchedAt,
  };
}
