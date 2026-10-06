// js/tide.js
//
// Pure derivations over the normalised source shape produced by js/sources.js.
// No network, no DOM, and no clock of its own: every function that cares about
// "now" takes it as a parameter so it can be tested against a fixed instant.
//
// Times are ISO 8601 UTC strings ("2026-09-30T06:00:00Z"). Heights are metres
// and always travel with their datum on the object that carries them.

export const MAX_STATION_DISTANCE_KM = 25;

const EARTH_RADIUS_KM = 6371;
const DAY_MS = 24 * 3600 * 1000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two points, in kilometres. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/**
 * Nearest station to a point.
 * point: { latitude, longitude }
 * stations: [{ id, latitude, longitude, ... }]
 * Returns { id, latitude, longitude, distanceKm } or null when the list is empty.
 */
export function nearestStation(point, stations) {
  let best = null;
  let bestKm = Infinity;
  for (const s of stations) {
    const km = haversineKm(
      point.latitude,
      point.longitude,
      s.latitude,
      s.longitude,
    );
    if (km < bestKm) {
      bestKm = km;
      best = s;
    }
  }
  if (!best) return null;
  // Spread the station entry so optional fields (name, kind) travel with it.
  return { ...best, distanceKm: bestKm };
}

/**
 * State of the tide at a moment, derived from a series.
 * series: [{ time, height }] sorted ascending by time.
 * Returns { rising, rateMh, height } or null when the series does not
 * bracket `now` (or has fewer than two points). rateMh is metres per hour,
 * positive while the tide is rising.
 */
export function tideStateAt(series, now = new Date()) {
  if (!series || series.length < 2) return null;
  const nowMs = new Date(now).getTime();
  const times = series.map((p) => Date.parse(p.time));
  if (nowMs < times[0] || nowMs > times[times.length - 1]) return null;

  let i = 0;
  while (i < times.length - 1 && times[i + 1] <= nowMs) i += 1;
  const a = series[i];
  const b = series[i + 1];
  const dtMs = times[i + 1] - times[i];
  if (dtMs <= 0) return null;

  const rateMh = ((b.height - a.height) / dtMs) * 3600000;
  const height = a.height + (b.height - a.height) * ((nowMs - times[i]) / dtMs);
  return { rising: rateMh > 0, rateMh, height };
}

/**
 * The next high and next low after `now`, with minutes remaining.
 * extremes: [{ time, type: "HIGH"|"LOW", height, heightODM? }] in any order.
 * Returns { nextHigh, nextLow } where each is
 * { time, height, heightODM, minutesTo } or null. `height` is the primary
 * datum of the source; `heightODM` is present only where the source also
 * publishes an OD Malin value.
 */
export function nextTurns(extremes, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const future = extremes
    .filter((e) => Date.parse(e.time) > nowMs)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  const find = (type) => future.find((e) => e.type === type) || null;
  const shape = (e) =>
    e && {
      time: e.time,
      height: e.height ?? null,
      heightODM: e.heightODM ?? null,
      minutesTo: Math.round((Date.parse(e.time) - nowMs) / 60000),
    };

  return { nextHigh: shape(find("HIGH")), nextLow: shape(find("LOW")) };
}

/**
 * Springs/neaps by inference from the predicted range, not from the form
 * factor (Marine Institute publishes prediction series, not harmonic
 * constituents — see docs/derivations.md).
 *
 * Builds the half-tide range of each successive HIGH/LOW pair, compares the
 * current range with the mean of a rolling fortnight (±7 days), and labels it
 * springs near the local maximum, neaps near the local minimum. The next
 * spring is the date of the next local maximum of that range series.
 *
 * Returns { label: "springs"|"neaps"|"mid"|null, nextSpring: ISO|null,
 *           nextNeap: ISO|null, basis: "range-inference" }.
 */
export function rangeAnalysis(extremes, now = new Date()) {
  const series = rangeSeries(extremes);
  const basis = "range-inference";
  if (series.length < 3) return { label: null, nextSpring: null, basis };

  const nowMs = new Date(now).getTime();
  const WINDOW = 7 * DAY_MS;

  const near = series.filter((r) => Math.abs(Date.parse(r.time) - nowMs) <= WINDOW);
  const mean = near.length
    ? near.reduce((sum, r) => sum + r.range, 0) / near.length
    : null;

  const current =
    [...series].reverse().find((r) => Date.parse(r.time) <= nowMs) || series[0];

  let label = null;
  if (mean !== null) {
    if (current.range > mean * 1.05) label = "springs";
    else if (current.range < mean * 0.95) label = "neaps";
    else label = "mid";
  }

  let nextSpring = null;
  for (let i = 1; i < series.length - 1; i += 1) {
    if (Date.parse(series[i].time) <= nowMs) continue;
    // A local maximum, tolerant of a flat plateau (two neighbouring pairs can
    // share a range value): not lower than the previous point and strictly
    // higher than the next.
    if (
      series[i].range >= series[i - 1].range &&
      series[i].range > series[i + 1].range
    ) {
      nextSpring = series[i].time;
      break;
    }
  }

  let nextNeap = null;
  for (let i = 1; i < series.length - 1; i += 1) {
    if (Date.parse(series[i].time) <= nowMs) continue;
    // A local minimum: the mirror of the spring scan.
    if (
      series[i].range <= series[i - 1].range &&
      series[i].range < series[i + 1].range
    ) {
      nextNeap = series[i].time;
      break;
    }
  }

  return { label, nextSpring, nextNeap, basis };
}

/**
 * Height used for range computation. Ranges are datum-invariant, so a source
 * that publishes OD Malin on every turn (Marine Institute) uses heightODM,
 * and every other source uses height. A single turn never mixes datums: for a
 * given source, the same field is present on every extreme.
 */
function rangeHeight(e) {
  return e.heightODM ?? e.height;
}

/** Half-tide ranges of successive HIGH/LOW pairs, timed at their midpoint. */
function rangeSeries(extremes) {
  const sorted = [...extremes].sort(
    (a, b) => Date.parse(a.time) - Date.parse(b.time),
  );
  const out = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a.type === b.type) continue;
    const midpoint = (Date.parse(a.time) + Date.parse(b.time)) / 2;
    out.push({
      time: new Date(midpoint).toISOString(),
      range: Math.abs(rangeHeight(a) - rangeHeight(b)),
    });
  }
  return out;
}

/**
 * The current reading nearest to `now` in a currents array, with the offset in
 * minutes between the reading and the moment asked about.
 * currents: [{ time, speed, direction }] sorted ascending.
 */
export function nearestCurrent(currents, now = new Date()) {
  if (!currents || !currents.length) return null;
  const nowMs = new Date(now).getTime();
  let best = currents[0];
  let bestD = Infinity;
  for (const c of currents) {
    const d = Math.abs(Date.parse(c.time) - nowMs);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return { ...best, minutesOffset: Math.round(bestD / 60000) };
}

const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/** Compass point ("where the water is heading towards") from degrees. */
export function compassPoint(degrees) {
  const idx = Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS[idx];
}

// ---------------------------------------------------------------------------
// Lunar phase

const SYNODIC_MONTH_MS = 29.530588853 * 86400000;
// A well-known new-moon instant, used as the reference epoch.
const NEW_MOON_EPOCH_MS = Date.parse("2000-01-06T18:14:00Z");

const PHASE_NAMES = [
  "New moon",
  "Waxing crescent",
  "First quarter",
  "Waxing gibbous",
  "Full moon",
  "Waning gibbous",
  "Last quarter",
  "Waning crescent",
];

/**
 * The phase of the Moon at a moment, from the synodic month since a reference
 * new moon. `fraction` runs 0 (new) → 0.5 (full) → 1 (new again);
 * `illuminated` is the fraction of the disc lit (0..1); `ageDays` is the age
 * of the Moon in days since the last new moon; `waxing` is true before full,
 * false after. This is a phase approximation, not a navigation ephemeris.
 */
export function lunarPhase(now = new Date()) {
  const t = new Date(now).getTime();
  const ageMs =
    (((t - NEW_MOON_EPOCH_MS) % SYNODIC_MONTH_MS) + SYNODIC_MONTH_MS) %
    SYNODIC_MONTH_MS;
  const fraction = ageMs / SYNODIC_MONTH_MS;
  const illuminated = 0.5 * (1 - Math.cos(2 * Math.PI * fraction));
  return {
    fraction,
    illuminated,
    ageDays: ageMs / 86400000,
    name: PHASE_NAMES[Math.round(fraction * 8) % 8],
    waxing: fraction < 0.5,
  };
}

/**
 * The next new-moon and full-moon instants, from the same synodic-month
 * arithmetic as lunarPhase. Both are strictly in the future.
 */
export function nextMoonEvents(now = new Date()) {
  const t = new Date(now).getTime();
  const p = lunarPhase(t);
  const toFull =
    (p.fraction < 0.5 ? 0.5 - p.fraction : 1.5 - p.fraction) * SYNODIC_MONTH_MS;
  const toNew = (1 - p.fraction) * SYNODIC_MONTH_MS;
  return {
    nextFull: new Date(t + toFull),
    nextNew: new Date(t + toNew),
  };
}

