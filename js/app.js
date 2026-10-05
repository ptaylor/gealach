// js/app.js
//
// DOM, rendering, install prompt, offline banner. Everything that touches the
// document lives here; js/tide.js and js/sources.js stay DOM-free.

import {
  nearestStation,
  tideStateAt,
  nextTurns,
  rangeAnalysis,
  nearestCurrent,
  compassPoint,
  lunarPhase,
  MAX_STATION_DISTANCE_KM,
} from "./tide.js";
import {
  geocode,
  marineIeTides,
  marineIeSurge,
  openMeteoMarine,
  timezoneAt,
  reverseGeocode,
} from "./sources.js";

// Beyond this distance the Irish prediction stations stop being "local" at all
// and we show the global model instead, and say so.
const GLOBAL_MODEL_FALLBACK_KM = 100;

const $ = (id) => document.getElementById(id);
const iso = (d) => d.toISOString();
const isoHoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

const ATTRIBUTION =
  "Data: Marine Institute (CC-BY 4.0) · Open-Meteo & GeoNames (CC-BY 4.0) · NOAA · OpenStreetMap (ODbL).";

let stations = [];
let stationMap = null;
let controller = null;
let tideResult = null;
let surgeResult = null;
let currentResult = null;
let geoResults = [];
let placeLabel = "";
let zone = "UTC";
let zoneOffset = "+00:00";
let zoneAbbr = "UTC";
let datumChoice = "LAT";
let map = null;
let mapMarker = null;

init();

async function init() {
  $("search").addEventListener("submit", onSubmit);
  $("datum-toggle").addEventListener("click", toggleDatum);
  $("map-toggle").addEventListener("click", toggleMap);
  $("attribution").textContent = ATTRIBUTION;

  // Vendored snapshots. A failed fetch degrades gracefully: no station list
  // means the global model is used for every point.
  try {
    const res = await fetch("data/stations.json");
    if (res.ok) {
      const data = await res.json();
      stations = Array.isArray(data) ? data : data.stations || [];
    }
  } catch {
    /* fall through to the global model */
  }
  try {
    const res = await fetch("data/station-map.json");
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.map || [];
      const map = {};
      for (const row of list) map[row.prediction] = row;
      stationMap = map;
    }
  } catch {
    /* no surge section then */
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  window.addEventListener("offline", () => setOffline(true));
  window.addEventListener("online", () => setOffline(false));
  setOffline(!navigator.onLine);

  renderMoon();
}

// ---------------------------------------------------------------------------
// map browsing

function toggleMap() {
  const card = $("map-card");
  const show = card.classList.contains("hidden");
  card.classList.toggle("hidden", !show);
  $("map-toggle").setAttribute("aria-expanded", String(show));
  if (show) {
    initMap();
    // Leaflet measures its container on creation; re-measure once it is shown.
    requestAnimationFrame(() => map && map.invalidateSize());
  }
}

function initMap() {
  if (map || !window.L) return;
  // Start on the Irish coast — the region the app knows first.
  map = L.map("map").setView([53.4, -8.2], 7);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  map.on("click", onMapClick);
}

function placeMarker(lat, lon) {
  if (mapMarker) mapMarker.remove();
  mapMarker = L.circleMarker([lat, lon], {
    radius: 7,
    color: "#0b6bcb",
    weight: 2,
    fillColor: "#0b6bcb",
    fillOpacity: 0.8,
  }).addTo(map);
}

async function onMapClick(e) {
  const lat = e.latlng.lat;
  const lon = e.latlng.lng;
  placeMarker(lat, lon);
  hideChoices();
  $("result").classList.add("hidden");
  setStatus("Fetching tides…");
  abort();

  let label = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  try {
    const [tz, place] = await Promise.all([
      timezoneAt({ latitude: lat, longitude: lon }, { signal: controller.signal }),
      reverseGeocode({ latitude: lat, longitude: lon }, { signal: controller.signal }).catch(() => null),
    ]);
    setZone(tz.timezone);
    if (place && place.name) {
      label = place.name;
      if (place.state) label += `, ${place.state}`;
      else if (place.country) label += `, ${place.country}`;
    }
  } catch {
    setZone("UTC");
    label += " (UTC shown)";
  }
  placeLabel = label;
  await load({ latitude: lat, longitude: lon });
}

// ---------------------------------------------------------------------------
// search flow

async function onSubmit(e) {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  abort();
  hideChoices();
  $("result").classList.add("hidden");
  setStatus(`Looking up “${q}”…`);

  const coord = q.match(/^\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)\s*$/);
  if (coord) {
    const lat = Number(coord[1]);
    const lon = Number(coord[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      setZone("UTC");
      placeLabel = `${lat.toFixed(4)}, ${lon.toFixed(4)} (coordinates — UTC shown)`;
      await load({ latitude: lat, longitude: lon });
      return;
    }
  }

  let geo;
  try {
    geo = await geocode(q, { signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") return;
    setStatus(`Could not look up “${q}”: ${err.message}`);
    return;
  }
  if (!geo.results.length) {
    setStatus(`No place found for “${q}”.`);
    return;
  }
  // Prefer Ireland, but show the alternatives rather than silently choosing.
  geoResults = geo.results;
  const def = geo.results.find((r) => r.countryCode === "IE") || geo.results[0];
  showChoices(geoResults, def);
  await choose(def);
}

async function choose(r) {
  abort();
  setZone(r.timezone || "UTC");
  placeLabel = `${r.name}, ${r.admin1 ?? r.country}`;
  showChoices(geoResults, r);
  await load({ latitude: r.latitude, longitude: r.longitude });
}

async function load(point) {
  setStatus("Fetching tides…");
  try {
    const near = stations.length ? nearestStation(point, stations) : null;
    const useMarine = near && near.distanceKm <= GLOBAL_MODEL_FALLBACK_KM;

    if (useMarine) {
      const [marine, om] = await Promise.all([
        marineIeTides(point, {}, stations, { signal: controller.signal }),
        openMeteoMarine(point, { signal: controller.signal }),
      ]);
      tideResult = marine;
      currentResult = om;
    } else {
      tideResult = await openMeteoMarine(point, { signal: controller.signal });
      currentResult = tideResult;
    }

    surgeResult = null;
    if (useMarine && stationMap) {
      const entry = stationMap[tideResult.station];
      if (entry && entry.surge) {
        try {
          surgeResult = await marineIeSurge(entry.surge, {
            start: isoHoursAgo(24),
            end: iso(new Date()),
            signal: controller.signal,
          });
        } catch {
          surgeResult = null;
        }
      }
    }

    setStatus("");
    render();
  } catch (err) {
    if (err.name === "AbortError") return;
    setStatus(`Something went wrong: ${err.message}`);
  }
}

function abort() {
  if (controller) controller.abort();
  controller = new AbortController();
}

// ---------------------------------------------------------------------------
// rendering

function render() {
  const r = tideResult;
  const now = new Date();
  $("result").classList.remove("hidden");

  // Where
  const kindWord =
    r.kind === "global-model" ? "global model" :
    r.kind === "model" ? "model" : "prediction station";
  $("where").innerHTML =
    `<strong>${escapeHtml(placeLabel)}</strong><br>` +
    `<span class="muted">${kindWord} <strong>${escapeHtml(r.stationName)}</strong>` +
    `${r.distanceKm != null ? ` — ${km(r.distanceKm)} from where you asked` : ""}</span>`;

  // Warning
  const warn = $("warning");
  if (r.kind === "global-model") {
    warn.textContent =
      "Outside the Irish prediction stations — showing the global model (Open-Meteo).";
    warn.classList.remove("hidden");
  } else if (r.distanceKm != null && r.distanceKm > MAX_STATION_DISTANCE_KM) {
    warn.textContent =
      `Nearest prediction station is ${km(r.distanceKm)} away — this is not a prediction for here.`;
    warn.classList.remove("hidden");
  } else {
    warn.classList.add("hidden");
  }

  // Datum label + toggle
  const hasODM = Array.isArray(r.seriesODM) && r.seriesODM.length > 0;
  const dt = $("datum-label");
  const dtBtn = $("datum-toggle");
  if (hasODM) {
    dt.textContent = datumChoice === "LAT" ? "Heights: chart datum (LAT)" : "Heights: OD Malin";
    dtBtn.textContent = datumChoice === "LAT" ? "Show OD Malin" : "Show LAT";
    dtBtn.classList.remove("hidden");
  } else {
    dt.textContent =
      r.datum === "MSL" ? "Heights: mean sea level (not chart datum)" : `Heights: ${r.datum}`;
    dtBtn.classList.add("hidden");
  }

  // Now
  const series = activeSeries(r);
  const st = tideStateAt(series, now);
  if (st) {
    $("height-now").textContent = m(st.height);
    if (Math.abs(st.rateMh) < 0.05) {
      $("state-now").textContent = "Steady";
    } else {
      const cls = st.rising ? "rising" : "falling";
      const word = st.rising ? "Rising" : "Falling";
      $("state-now").innerHTML =
        `<span class="${cls}">${word}</span> at ${Math.abs(st.rateMh).toFixed(1)} m/h`;
    }
  } else {
    $("height-now").textContent = "—";
    $("state-now").textContent = "Not available for this moment";
  }

  // Turns
  renderTurns(nextTurns(r.extremes, now), hasODM);

  // Springs / neaps
  renderSprings(rangeAnalysis(r.extremes, now));

  // Curve
  drawCurve(series, now);

  // Currents
  renderCurrents(r.currents, now);

  // Surge
  renderSurge();

  // Provenance
  $("provenance").innerHTML =
    `Source ${r.source} · station ${escapeHtml(r.station)} · datum ${escapeHtml(r.datum)} · ` +
    `fetched ${fmtDayTime(r.fetchedAt, zone)} (${zoneAbbr}, ${zoneOffset})`;
}

function activeSeries(r) {
  return datumChoice === "ODM" && r.seriesODM && r.seriesODM.length
    ? r.seriesODM
    : r.series;
}

function renderTurns(turns, hasODM) {
  const rows = [];
  const pairs = [
    ["High", turns.nextHigh],
    ["Low", turns.nextLow],
  ];
  for (const [label, t] of pairs) {
    if (!t) {
      rows.push(
        `<div class="turn-row"><span class="kind">Next ${label}</span><span class="time">—</span></div>`,
      );
      continue;
    }
    const useODM = datumChoice === "ODM" && hasODM && t.heightODM != null;
    const h = useODM ? t.heightODM : t.height;
    const when = t.minutesTo >= 0 ? `in ${fmtDur(t.minutesTo)}` : "now";
    rows.push(
      `<div class="turn-row"><span class="kind">${label}</span>` +
      `<span class="time">${fmtClock(t.time, zone)} (${when})</span>` +
      `<span class="height">${m(h)} m</span></div>`,
    );
  }
  $("turns").innerHTML = rows.join("");
}

function renderSprings(spring) {
  const parts = [];
  parts.push(`Currently: <strong>${spring.label ?? "not available"}</strong>`);
  if (spring.nextSpring) {
    parts.push(`Next spring tide around <strong>${fmtDay(spring.nextSpring, zone)}</strong>`);
  }
  parts.push(`<span class="muted">(inferred from the predicted range)</span>`);
  $("springs").innerHTML = parts.join("<br>");
}

function drawCurve(series, now) {
  const svg = $("curve");
  const W = 360;
  const H = 130;
  const padTop = 12;
  const padBottom = 24;
  const padLeft = 40;
  const padRight = 8;
  const nowMs = now.getTime();
  const from = nowMs - 2 * 3600000;
  const to = nowMs + 12 * 3600000;

  const win = series.filter((p) => {
    const t = Date.parse(p.time);
    return t >= from && t <= to;
  });

  if (win.length < 2) {
    svg.innerHTML =
      `<text class="curve-label" x="180" y="65" text-anchor="middle">No curve for this window</text>`;
    $("curve-note").textContent = "";
    return;
  }

  let min = Infinity;
  let max = -Infinity;
  for (const p of win) {
    if (p.height != null) {
      if (p.height < min) min = p.height;
      if (p.height > max) max = p.height;
    }
  }
  if (!Number.isFinite(min)) {
    svg.innerHTML = "";
    $("curve-note").textContent = "";
    return;
  }
  const pad = (max - min) * 0.15 || 0.5;
  min -= pad;
  max += pad;

  const x = (t) => padLeft + ((t - from) / (to - from)) * (W - padLeft - padRight);
  const y = (h) => padTop + (1 - (h - min) / (max - min)) * (H - padTop - padBottom);

  const pts = win
    .map((p) => `${x(Date.parse(p.time)).toFixed(1)},${y(p.height).toFixed(1)}`)
    .join(" ");
  const nowX = x(nowMs).toFixed(1);

  const yLabels = [max, (max + min) / 2, min]
    .map((h) =>
      `<text class="curve-label" x="${padLeft - 5}" y="${y(h) + 3}" text-anchor="end">${m(h)}</text>`,
    )
    .join("");
  const xLabels = [
    [from, fmtClock(iso(new Date(from)), zone), "start"],
    [nowMs, "now", "middle"],
    [to, fmtClock(iso(new Date(to)), zone), "end"],
  ]
    .map(
      ([t, label, anchor]) =>
        `<text class="curve-label" x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${label}</text>`,
    )
    .join("");

  svg.innerHTML =
    yLabels +
    `<polyline class="curve-line" points="${pts}" />` +
    `<line class="curve-now" x1="${nowX}" y1="${padTop}" x2="${nowX}" y2="${H - padBottom}" />` +
    xLabels;

  const datumName =
    datumChoice === "ODM" && tideResult.seriesODM && tideResult.seriesODM.length
      ? "OD Malin"
      : tideResult.datum;
  $("curve-note").textContent =
    `Heights in ${datumName}; ${fmtClock(iso(new Date(from)), zone)} to ${fmtClock(iso(new Date(to)), zone)}.`;
}

function renderCurrents(currents, now) {
  const card = $("currents-card");
  const box = $("currents");
  const c = nearestCurrent(currents, now);
  if (!c || c.speed == null) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  box.innerHTML =
    `<div class="current-big">${c.speed.toFixed(1)} m/s</div>` +
    `<div>${compassPoint(c.direction)} (${Math.round(c.direction)}°, heading towards)</div>` +
    `<div class="muted">Open-Meteo Marine, ~8 km grid, at ${fmtClock(c.time, zone)} — model output, not suitable for coastal navigation.</div>`;
}

function renderSurge() {
  const card = $("surge-card");
  const box = $("surge");
  if (!surgeResult || !surgeResult.series.length) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  const latest = surgeResult.series[surgeResult.series.length - 1];
  box.innerHTML =
    `Latest observed at ${fmtDayTime(latest.time, zone)}:<br>` +
    `tide <strong>${m(latest.tide)} m</strong>, ` +
    `surge <strong>${m(latest.surge)} m</strong>` +
    `<div class="muted">The prediction above excludes this surge.</div>`;
}

// ---------------------------------------------------------------------------
// small UI helpers

function showChoices(results, picked) {
  const box = $("choices");
  box.innerHTML = "";
  for (const r of results) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${r.name}, ${r.admin1 ?? r.country} (${r.countryCode})`;
    if (r === picked) b.classList.add("picked");
    b.addEventListener("click", () => choose(r));
    box.appendChild(b);
  }
  box.classList.remove("hidden");
}

function hideChoices() {
  $("choices").classList.add("hidden");
  $("choices").innerHTML = "";
}

function setStatus(msg) {
  const el = $("status");
  if (msg) {
    el.textContent = msg;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

function setOffline(offline) {
  const el = $("offline");
  if (!el) return;
  el.classList.toggle("hidden", !offline);
}

function setZone(z) {
  zone = z;
  const info = zoneInfo(z, new Date());
  zoneOffset = info.offset;
  zoneAbbr = info.abbr;
}

function toggleDatum() {
  datumChoice = datumChoice === "LAT" ? "ODM" : "LAT";
  if (tideResult) render();
}

// ---------------------------------------------------------------------------
// moon phase

function renderMoon() {
  const phase = lunarPhase(new Date());
  $("moon-glyph").innerHTML = moonGlyph(phase);
  $("moon-name").textContent = phase.name;
  $("moon-detail").textContent =
    `${Math.round(phase.illuminated * 100)}% illuminated · ` +
    `${phase.ageDays.toFixed(1)} days old`;
}

/** SVG for the Moon's disc with the lit portion filled. */
function moonGlyph(phase, size = 64) {
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 3;
  const p = phase.fraction;
  // The lit portion is the disc minus a shadow circle of the same radius whose
  // centre sweeps across: at new moon it covers the disc, at full moon it has
  // moved fully off, at the quarters it covers a half. Waxing is lit on the
  // right, waning on the left (Northern-hemisphere convention).
  const d = R * (1 - Math.cos(2 * Math.PI * p));
  const shadowCx = p <= 0.5 ? cx - d : cx + d;

  const disc = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="var(--moon)"/>`;
  let lit = "";
  if (d >= 2 * R - 0.5) {
    lit = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="var(--moon-lit)"/>`;
  } else if (d >= 0.5) {
    const path = lunePath(cx, cy, R, shadowCx, cy, R);
    if (path) lit = `<path d="${path}" fill="var(--moon-lit)"/>`;
  }
  return disc + lit;
}

/** Region of circle (cx,cy,R) not covered by circle (bx,by,r), as an SVG path. */
function lunePath(cx, cy, R, bx, by, r) {
  const dx = bx - cx;
  const dy = by - cy;
  const dist = Math.hypot(dx, dy);
  if (!(Math.abs(R - r) < dist && dist < R + r)) return "";
  const a = (R * R - r * r + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, R * R - a * a));
  const mx = cx + (a * dx) / dist;
  const my = cy + (a * dy) / dist;
  const ox = (-dy / dist) * h;
  const oy = (dx / dist) * h;
  const P1 = [mx + ox, my + oy];
  const P2 = [mx - ox, my - oy];

  const a1 = Math.atan2(P1[1] - cy, P1[0] - cx);
  const a2 = Math.atan2(P2[1] - cy, P2[0] - cx);
  const b1 = Math.atan2(P1[1] - by, P1[0] - bx);
  const b2 = Math.atan2(P2[1] - by, P2[0] - bx);

  const outerDelta = outsideMidpoint(cx, cy, R, a1, ccwDelta(a1, a2), bx, by, r)
    ? ccwDelta(a1, a2)
    : -cwDelta(a1, a2);
  const innerDelta = insideMidpoint(bx, by, r, b1, ccwDelta(b1, b2), cx, cy, R)
    ? ccwDelta(b1, b2)
    : -cwDelta(b1, b2);

  const outer = arcCubics(cx, cy, R, a1, outerDelta);
  const inner = arcCubics(bx, by, r, b1, innerDelta);

  let path = `M ${P1[0].toFixed(3)} ${P1[1].toFixed(3)}`;
  for (const [, c1, c2, p2] of outer) {
    path += ` C ${c1[0].toFixed(3)} ${c1[1].toFixed(3)} ${c2[0].toFixed(3)} ${c2[1].toFixed(3)} ${p2[0].toFixed(3)} ${p2[1].toFixed(3)}`;
  }
  for (const [p1, c1, c2] of [...inner].reverse()) {
    path += ` C ${c2[0].toFixed(3)} ${c2[1].toFixed(3)} ${c1[0].toFixed(3)} ${c1[1].toFixed(3)} ${p1[0].toFixed(3)} ${p1[1].toFixed(3)}`;
  }
  return `${path} Z`;
}

function ccwDelta(a, b) {
  let d = b - a;
  while (d < 0) d += 2 * Math.PI;
  return d;
}

function cwDelta(a, b) {
  let d = a - b;
  while (d < 0) d += 2 * Math.PI;
  return d;
}

function outsideMidpoint(cx, cy, r, aStart, delta, sx, sy, sr) {
  const mx = cx + r * Math.cos(aStart + delta / 2);
  const my = cy + r * Math.sin(aStart + delta / 2);
  return Math.hypot(mx - sx, my - sy) > sr;
}

function insideMidpoint(cx, cy, r, aStart, delta, bx, by, R) {
  const mx = cx + r * Math.cos(aStart + delta / 2);
  const my = cy + r * Math.sin(aStart + delta / 2);
  return Math.hypot(mx - bx, my - by) < R;
}

function arcCubics(cx, cy, r, aStart, delta) {
  const n = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const seg = delta / n;
  const segs = [];
  for (let i = 0; i < n; i += 1) {
    const s = aStart + i * seg;
    const e = aStart + (i + 1) * seg;
    const k = ((4 / 3) * Math.tan(seg / 4)) * r;
    const p1 = [cx + r * Math.cos(s), cy + r * Math.sin(s)];
    const p2 = [cx + r * Math.cos(e), cy + r * Math.sin(e)];
    const t1 = [-Math.sin(s), Math.cos(s)];
    const t2 = [-Math.sin(e), Math.cos(e)];
    const c1 = [p1[0] + k * t1[0], p1[1] + k * t1[1]];
    const c2 = [p2[0] - k * t2[0], p2[1] - k * t2[1]];
    segs.push([p1, c1, c2, p2]);
  }
  return segs;
}

// ---------------------------------------------------------------------------
// formatting

const m = (n) => (n == null ? "—" : n.toFixed(1));
const km = (n) => (n == null ? "—" : `${Math.round(n)} km`);

function fmtClock(isoStr, z) {
  return new Intl.DateTimeFormat("en-IE", {
    timeZone: z,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoStr));
}

function fmtDay(isoStr, z) {
  return new Intl.DateTimeFormat("en-IE", {
    timeZone: z,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(isoStr));
}

function fmtDayTime(isoStr, z) {
  return new Intl.DateTimeFormat("en-IE", {
    timeZone: z,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoStr));
}

function fmtDur(min) {
  const h = Math.floor(min / 60);
  const rem = min % 60;
  if (h <= 0) return `${rem} min`;
  if (rem === 0) return `${h} h`;
  return `${h} h ${rem} min`;
}

function zoneInfo(z, date) {
  const offsetSeconds = zoneOffsetSeconds(z, date);
  const sign = offsetSeconds >= 0 ? "+" : "-";
  const abs = Math.abs(offsetSeconds);
  const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
  const mm = String(Math.round((abs % 3600) / 60)).padStart(2, "0");
  const abbr =
    new Intl.DateTimeFormat("en-IE", { timeZone: z, timeZoneName: "short" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  return { offset: `${sign}${hh}:${mm}`, abbr };
}

function zoneOffsetSeconds(z, date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: z,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  // formatToParts truncates milliseconds, so the raw difference carries a
  // sub-second error; round to whole minutes (all real offsets are whole
  // minutes) before multiplying back to seconds.
  const diffMs = asUTC - date.getTime();
  return Math.round(diffMs / 60000) * 60;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}
