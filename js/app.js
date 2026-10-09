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
  nextMoonEvents,
  MAX_STATION_DISTANCE_KM,
} from "./tide.js";
import {
  geocode,
  marineIeTides,
  marineIeSurge,
  openMeteoMarine,
  timezoneAt,
  reverseGeocode,
  photonSearch,
} from "./sources.js";

// Beyond this distance the Irish prediction stations stop being "local" at all
// and we show the global model instead, and say so.
const GLOBAL_MODEL_FALLBACK_KM = 100;

const $ = (id) => document.getElementById(id);
const iso = (d) => d.toISOString();
const isoHoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

// GoatCounter: cookie-less, no personal data. Custom events are categorical
// slugs only — never a search string or a picked coordinate. The counter
// script (gc.zgo.at/count.js) is absent when offline or blocked, so every
// fire is a no-op unless window.goatcounter exists.
function trackEvent(path) {
  if (typeof window !== "undefined" && window.goatcounter) {
    window.goatcounter.count({ path, event: true });
  }
}

// Which distance band the resolved station sits in, so the primary-vs-global
// split and the "distant station" warning are measurable.
function distanceBandEvent(r) {
  if (r.kind === "global-model") return "distance-global";
  if (r.distanceKm == null) return "distance-global";
  if (r.distanceKm <= MAX_STATION_DISTANCE_KM) return "distance-local";
  if (r.distanceKm <= GLOBAL_MODEL_FALLBACK_KM) return "distance-warned";
  return "distance-global";
}

// ---------------------------------------------------------------------------
// colour theme
//
// The palette follows the device by default (prefers-color-scheme). The reader
// can override it to light or dark; the choice is kept in localStorage and
// applied as data-theme on <html>, which wins over the media query. "system"
// (the default) removes the attribute and lets the device decide.

const THEME_KEY = "gealach-theme";
const THEME_CYCLE = ["system", "light", "dark"];

function initTheme() {
  applyTheme(getStoredTheme());
}

function getStoredTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEME_CYCLE.includes(v) ? v : "system";
  } catch {
    return "system";
  }
}

function cycleTheme() {
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(getStoredTheme()) + 1) % THEME_CYCLE.length];
  try {
    if (next === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage unavailable — the choice just is not persisted */
  }
  applyTheme(next);
  trackEvent(`theme-${next}`);
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);

  const btn = document.querySelector("#theme-toggle");
  if (btn) {
    btn.setAttribute("data-theme", theme);
    btn.setAttribute("aria-label", `Colour theme: ${theme}`);
    btn.title = `Colour theme: ${theme}`;
  }
  updateThemeColorMeta();
}

// The status-bar / browser-chrome tint has one meta per scheme, chosen by the
// media attribute. When the reader forces a scheme, collapse them to a single
// meta whose content matches what is actually on screen.
function updateThemeColorMeta() {
  const explicit = document.documentElement.getAttribute("data-theme");
  const dark = explicit
    ? explicit === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const metas = [...document.querySelectorAll('meta[name="theme-color"]')];
  if (!metas.length) return;
  metas[0].setAttribute("content", dark ? "#0f1115" : "#0b6bcb");
  metas[0].removeAttribute("media");
  for (const extra of metas.slice(1)) extra.remove();
}

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
let sourceChoice = "auto";
let map = null;
let mapMarker = null;
let favourites = [];
let currentPoint = null;
// The nearest prediction station offered as a one-tap jump for a located point.
let stationOffer = null;
const FAVOURITES_KEY = "gealach-favourites";

// ---------------------------------------------------------------------------
// first-run hints
//
// A short set of coachmarks, each anchored to the element it explains and shown
// at most once ever. The later hints point at controls that do not exist on a
// cold first run (the heart, a favourite's rename pencil), so a hint is only
// offered when its target is on screen and usable — driven from the flow, not a
// fixed tour. "Seen" is a growing list in localStorage, so a hint already shown
// never returns, on this device.
const HINTS_KEY = "gealach-hints-seen";
const HINTS = [
  {
    id: "search",
    anchor: () => $("q"),
    text: "Start here: type a place name (or “53.27, -9.05”) and tap search. The map opens where it finds.",
  },
  {
    id: "jump",
    anchor: () => (isVisible($("coast-row")) ? $("coast-btn") : null),
    text: "That place is inland, so here is the nearest sea. Tap to jump the map to it.",
  },
  {
    id: "map-tap",
    anchor: () => (isVisible($("map-card")) && !currentPoint ? $("map") : null),
    text: "Tap anywhere on the coast — that sets the point the tide is read for.",
  },
  {
    id: "heart",
    anchor: () => (isVisible($("sum-heart")) ? $("sum-heart") : null),
    text: "Save this spot to your favourites, so you can return to it in one tap.",
  },
  {
    id: "details",
    anchor: () => (isVisible($("details-toggle")) ? $("details-toggle") : null),
    text: "Open Details for the datum, the modelled current, the moon, and the source behind every number.",
  },
  {
    id: "rename",
    anchor: () => document.querySelector("#favourites-list .fave-rename"),
    text: "Tap the pencil to rename a favourite — call it anything you like.",
  },
];

init();

async function init() {
  initTheme();
  $("theme-toggle").addEventListener("click", cycleTheme);
  $("search").addEventListener("submit", onSubmit);
  // iOS fires a `search` event on a type=search input instead of submitting the
  // form; route it through the same path so the keyboard search key works there.
  $("q").addEventListener("search", (e) => {
    e.preventDefault();
    onSubmit(e);
  });
  $("map-toggle").addEventListener("click", toggleMap);
  $("coast-btn").addEventListener("click", jumpToNearestStation);
  $("sum-locate").addEventListener("click", showOnMap);
  $("sum-name").addEventListener("click", showOnMap);
  $("sum-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      showOnMap();
    }
  });
  $("details-toggle").addEventListener("click", toggleDetails);
  for (const b of $("source-switch").querySelectorAll("button")) {
    b.addEventListener("click", () => setSource(b.dataset.source));
  }
  $("details").addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="toggle-datum"]');
    if (btn) toggleDatum();
  });
  $("sum-heart").addEventListener("click", toggleFavourite);
  $("locate").addEventListener("click", locateMe);
  $("hint-ok").addEventListener("click", dismissHint);
  $("hint-scrim").addEventListener("click", dismissHint);
  window.addEventListener("scroll", repositionHint, { passive: true });
  window.addEventListener("resize", repositionHint);
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (activeHint) dismissHint();
    else if (!$("debug-overlay").classList.contains("hidden")) closeDebug();
  });
  $("info-close").addEventListener("click", closeInfo);
  $("info-overlay").addEventListener("click", (e) => {
    if (e.target === $("info-overlay")) closeInfo();
  });
  const hotspot = $("debug-hotspot");
  hotspot.addEventListener("pointerdown", startDebugHold);
  hotspot.addEventListener("pointerup", cancelDebugHold);
  hotspot.addEventListener("pointerleave", cancelDebugHold);
  hotspot.addEventListener("pointercancel", cancelDebugHold);
  hotspot.addEventListener("contextmenu", (e) => e.preventDefault());
  $("debug-clear-hints").addEventListener("click", clearFirstRunHints);
  $("debug-clear-all").addEventListener("click", clearAllData);
  $("debug-close").addEventListener("click", closeDebug);
  $("debug-overlay").addEventListener("click", (e) => {
    if (e.target === $("debug-overlay")) closeDebug();
  });
  const brand = $("brand");
  brand.addEventListener("pointerdown", startInfoHold);
  brand.addEventListener("pointerup", cancelInfoHold);
  brand.addEventListener("pointerleave", cancelInfoHold);
  brand.addEventListener("pointercancel", cancelInfoHold);
  brand.addEventListener("contextmenu", (e) => e.preventDefault());
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

  // Installability: count how often the browser offers installation and how
  // often it is accepted. No preventDefault — the native prompt stays intact.
  window.addEventListener("beforeinstallprompt", () => {
    trackEvent("install-shown");
  });
  window.addEventListener("appinstalled", () => {
    trackEvent("installed");
  });

  window.addEventListener("offline", () => setOffline(true));
  window.addEventListener("online", () => setOffline(false));
  setOffline(!navigator.onLine);

  loadFavourites();
  renderFavourites();

  // Cold first run: offer the opening hint once everything above is wired.
  maybeHint();
}

// ---------------------------------------------------------------------------
// first-run hints (the engine for HINTS above)

function isVisible(el) {
  return !!el && !el.classList.contains("hidden") && el.offsetParent !== null;
}

function loadSeenHints() {
  try {
    const raw = localStorage.getItem(HINTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function markHintSeen(id) {
  try {
    const seen = loadSeenHints();
    if (!seen.includes(id)) seen.push(id);
    localStorage.setItem(HINTS_KEY, JSON.stringify(seen));
  } catch {
    /* storage unavailable — the hint may show again this session, harmless */
  }
}

let activeHint = null;

// Offer the first hint whose target is on screen and which has not been shown
// before. Called from the flow at the points where a hint's subject becomes
// reachable; a no-op when a hint is already up.
function maybeHint() {
  if (activeHint) return;
  // Never interrupt the developer overlay (its "clear" actions can make a hint
  // eligible again; it should wait until the overlay is closed).
  if (!$("debug-overlay").classList.contains("hidden")) return;
  const seen = loadSeenHints();
  for (const h of HINTS) {
    if (seen.includes(h.id)) continue;
    const target = h.anchor();
    if (!target) continue; // its turn has not come yet — try again later
    showHint(h, target);
    return;
  }
}

function showHint(hint, target) {
  activeHint = hint;
  const layer = $("hint-layer");
  const ring = $("hint-ring");
  const bubble = $("hint-bubble");
  const text = $("hint-text");
  const step = $("hint-step");
  const idx = HINTS.findIndex((h) => h.id === hint.id);
  text.textContent = hint.text;
  step.textContent = `${idx + 1} of ${HINTS.length}`;
  layer.classList.remove("hidden");
  // Bring the target into view first (its anchor may be below the fold), then
  // place the ring and bubble against where it actually landed.
  target.scrollIntoView({ block: "center", behavior: "instant" });
  positionHint(target, ring, bubble);
  $("hint-ok").focus({ preventScroll: true });
  trackEvent(`hint-${hint.id}`);
}

// Place the spotlight ring over the target and the bubble below (or above) it,
// keeping both inside the viewport. Re-run on scroll/resize while open.
function positionHint(target, ring, bubble) {
  const pad = 6;
  const r = target.getBoundingClientRect();
  ring.style.top = `${r.top - pad}px`;
  ring.style.left = `${r.left - pad}px`;
  ring.style.width = `${r.width + pad * 2}px`;
  ring.style.height = `${r.height + pad * 2}px`;
  ring.classList.toggle("flat", r.width > window.innerWidth * 0.7);

  const margin = 10;
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  let left = r.left + r.width / 2 - bw / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - bw - margin));
  // Prefer below the target; fall back to above; if neither fits (a tall
  // target), pin to whichever side has more room and clamp into the viewport.
  let top = r.bottom + margin;
  if (top + bh > window.innerHeight - margin) top = r.top - bh - margin;
  top = Math.max(margin, Math.min(top, window.innerHeight - bh - margin));
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
}

function dismissHint() {
  if (!activeHint) return;
  markHintSeen(activeHint.id);
  activeHint = null;
  $("hint-layer").classList.add("hidden");
  // One action can make the next hint eligible too (search reveals the map,
  // so "jump" and "map-tap" can both become true at once); chain to it rather
  // than waiting for another event.
  setTimeout(maybeHint, 0);
}

// Keep the spotlight glued to its target while the page moves under it.
function repositionHint() {
  if (!activeHint) return;
  const target = activeHint.anchor();
  if (!target) {
    dismissHint();
    return;
  }
  positionHint(target, $("hint-ring"), $("hint-bubble"));
}

// ---------------------------------------------------------------------------
// map browsing

function toggleMap() {
  const card = $("map-card");
  const show = card.classList.contains("hidden");
  card.classList.toggle("hidden", !show);
  $("map-toggle").setAttribute("aria-expanded", String(show));
  if (show) {
    trackEvent("map-open");
    initMap();
    // Leaflet measures its container on creation; re-measure once it is shown.
    requestAnimationFrame(() => map && map.invalidateSize());
  }
}

function showOnMap() {
  if (!currentPoint) return;
  const { latitude: lat, longitude: lon } = currentPoint;
  revealMapAt(lat, lon, 14);
}

// Locate a searched point on the map: reveal the map, pan to the point and
// drop the pin. No tide is fetched — the reader taps the map for that.
function locateOnMap(lat, lon) {
  // Decide the station offer first, so that when the map is revealed the hint
  // pass sees the "jump to nearest sea" button (which ranks before the map-tap
  // hint) rather than defaulting to the map.
  updateStationOffer(lat, lon);
  revealMapAt(lat, lon, 14);
  // No tide for a located point: clear any result already on screen.
  $("summary").classList.add("hidden");
  $("result").classList.add("hidden");
  setSearchError("");
  setStatus("");
}

// Offer a one-tap jump to the nearest place that actually has a tide, so a
// search for an inland or vague place still lands somewhere answerable. Hidden
// when the point is already at (or very near) a station.
function updateStationOffer(lat, lon) {
  const row = $("coast-row");
  const btn = $("coast-btn");
  const status = $("coast-status");
  status.textContent = "";
  btn.disabled = false;
  const near = stations.length ? nearestStation({ latitude: lat, longitude: lon }, stations) : null;
  if (!near || near.distanceKm <= MAX_STATION_DISTANCE_KM) {
    row.classList.add("hidden");
    return;
  }
  stationOffer = near;
  btn.textContent = `Jump to ${near.name} (${km(near.distanceKm)} away)`;
  row.classList.remove("hidden");
  // Now that the jump is offered, point it out (once).
  maybeHint();
}

// Move the map to the nearest station offered for the located point. The tide
// is still loaded by tapping the map, so the reader sees where it came from.
function jumpToNearestStation() {
  if (!stationOffer) return;
  trackEvent("station-jump");
  const { latitude: lat, longitude: lon, name, distanceKm } = stationOffer;
  revealMapAt(lat, lon, 13);
  $("coast-status").textContent = `${name} — the nearest place with a tide (${km(distanceKm)}). Tap the map to read it.`;
}

function revealMapAt(lat, lon, zoom) {
  const card = $("map-card");
  if (card.classList.contains("hidden")) {
    card.classList.remove("hidden");
    $("map-toggle").setAttribute("aria-expanded", "true");
  }
  initMap();
  map.setView([lat, lon], zoom);
  placeMarker(lat, lon);
  requestAnimationFrame(() => map && map.invalidateSize());
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  // The map is on screen: if the reader has not yet tapped it for a tide, hint.
  maybeHint();
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
  trackEvent("search-map");
  resolvePoint(e.latlng.lat, e.latlng.lng);
}

function locateMe() {
  if (!navigator.geolocation) {
    setStatus("Location is not available in this browser.");
    return;
  }
  const btn = $("locate");
  btn.disabled = true;
  setStatus("Finding your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.disabled = false;
      const { latitude: lat, longitude: lon } = pos.coords;
      trackEvent("search-geolocate");
      initMap();
      map.setView([lat, lon], 14);
      resolvePoint(lat, lon);
    },
    (err) => {
      btn.disabled = false;
      setStatus(geolocationError(err));
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
}

function geolocationError(err) {
  if (err.code === 1) return "Location permission denied — allow access and try again.";
  if (err.code === 2) return "Location unavailable right now — try again.";
  if (err.code === 3) return "Location request timed out — try again.";
  return "Could not get your location.";
}

function resolvePoint(lat, lon) {
  placeMarker(lat, lon);
  abort();
  namePoint(lat, lon);
}

async function namePoint(lat, lon) {
  const coordLabel = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  let tz = "UTC";
  let label = `${coordLabel} (UTC shown)`;
  try {
    const [tzInfo, place] = await Promise.all([
      timezoneAt({ latitude: lat, longitude: lon }, { signal: controller.signal }),
      reverseGeocode({ latitude: lat, longitude: lon }, { signal: controller.signal }).catch(() => null),
    ]);
    tz = tzInfo.timezone;
    if (place && place.name) {
      label = place.name;
      if (place.state) label += `, ${place.state}`;
      else if (place.country) label += `, ${place.country}`;
    } else {
      label = coordLabel;
    }
  } catch {
    /* tz stays "UTC" and label keeps the "(UTC shown)" form */
  }
  await loadPoint({ latitude: lat, longitude: lon }, { zone: tz, label });
}

// ---------------------------------------------------------------------------
// search flow

let lastSearchQ = "";
let lastSearchMs = 0;

async function onSubmit(e) {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  // A browser can fire both `search` and `submit` for one action; de-duplicate
  // the identical query within a second rather than fetching twice.
  const now = Date.now();
  if (q === lastSearchQ && now - lastSearchMs < 1000) return;
  lastSearchQ = q;
  lastSearchMs = now;
  abort();
  hideChoices();
  // A search locates a point on the map and does not load a tide, so any
  // previous result (the summary card and the surge/provenance block) is
  // cleared until the reader taps the map. The map card is cleared too, so a
  // failed lookup leaves just the message under the search bar rather than a
  // stale pin from the last search.
  $("result").classList.add("hidden");
  $("summary").classList.add("hidden");
  $("map-card").classList.add("hidden");
  $("map-toggle").setAttribute("aria-expanded", "false");
  $("coast-row").classList.add("hidden");
  stationOffer = null;
  setSearchError("");
  setStatus(`Looking up “${q}”…`);

  const coord = q.match(/^\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)\s*$/);
  if (coord) {
    const lat = Number(coord[1]);
    const lon = Number(coord[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      trackEvent("search-coords");
      setStatus("");
      locateOnMap(lat, lon);
      return;
    }
  }

  trackEvent("search-name");
  // Ask the GeoNames-backed geocoder for Irish matches first — this is an
  // Irish tide tool, so "Galway" should mean Galway. The worldwide list is
  // fetched as well so the alternatives are still offered, not hidden.
  let geo;
  let world;
  try {
    [geo, world] = await Promise.all([
      geocode(q, { countryCode: "IE", signal: controller.signal }),
      geocode(q, { signal: controller.signal }),
    ]);
  } catch (err) {
    if (err.name === "AbortError") return;
    trackEvent("error-geocode");
    setStatus("");
    setSearchError(`Could not look up “${q}”: ${err.message}`);
    return;
  }
  if (!geo.results.length && !world.results.length) {
    setStatus("");
    setSearchError(`No place found for “${q}”.`);
    return;
  }
  // Prefer Ireland, but show the alternatives rather than silently choosing.
  // Merge the Irish-biased list ahead of the worldwide one (Irish first, then
  // the rest, de-duplicated) so the reader sees Ireland at the top.
  // GeoNames misses many Irish townlands (e.g. "Cahore" only resolves to
  // Ontario), so when there is no Irish match, merge in Photon (OSM) results.
  let results = mergeGeoResults(geo.results, world.results);
  if (!results.some((r) => r.countryCode === "IE")) {
    try {
      const photon = await photonSearch(q, { signal: controller.signal });
      if (photon.results.length) {
        trackEvent("geocode-fallback-photon");
        results = mergeGeoResults(results, photon.results);
      }
    } catch (err) {
      if (err.name === "AbortError") return;
      /* keep the Open-Meteo results on a Photon failure */
    }
  }
  // Ireland always ranks first, regardless of which source supplied the match.
  results = sortByIreland(results);
  geoResults = results;
  if (results.length > 1) trackEvent("geocode-ambiguous");
  const def = results.find((r) => r.countryCode === "IE") || results[0];
  showChoices(results, def);
  // A search locates a position on the map and nothing more; the tide loads
  // when the reader taps the map. Keep the alternatives on screen so a
  // different match can be picked.
  choose(def);
}

// Pick a geocoder result: move the map there and drop the pin, without
// loading a tide. `fromChip` is a tap on one of the alternatives.
function choose(r, { fromChip = false } = {}) {
  if (fromChip) hideChoices();
  else showChoices(geoResults, r);
  placeLabel = `${r.name}, ${r.admin1 ?? r.country}`;
  locateOnMap(r.latitude, r.longitude);
}

async function load(point) {
  currentPoint = point;
  $("details").classList.add("hidden");
  $("details-toggle").setAttribute("aria-expanded", "false");
  setStatus("Fetching tides…");
  try {
    const near = stations.length ? nearestStation(point, stations) : null;
    const marineAvailable = !!near && near.distanceKm <= GLOBAL_MODEL_FALLBACK_KM;
    const useMarine = marineAvailable && sourceChoice !== "open-meteo";

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
    trackEvent(tideResult.source === "marine-ie" ? "source-marine-ie" : "source-open-meteo");
    trackEvent(distanceBandEvent(tideResult));
    trackEvent(surgeResult && surgeResult.series.length ? "surge-shown" : "surge-none");
  } catch (err) {
    if (err.name === "AbortError") return;
    trackEvent("error-source");
    setStatus(`Something went wrong: ${err.message}`);
  }
}

// Shared preamble for resolving a point: cancel any in-flight request, clear
// the previous choices and any search error, apply the place's label and
// timezone, and load. Callers that need the timezone before loading still call
// abort() first (a second abort is harmless).
function loadPoint(point, { zone: tz, label } = {}) {
  abort();
  hideChoices();
  // A tide is being loaded for this point, so the "jump to a station" offer
  // for a previously located point no longer applies.
  $("coast-row").classList.add("hidden");
  stationOffer = null;
  $("result").classList.add("hidden");
  setSearchError("");
  if (tz) setZone(tz);
  if (label != null) placeLabel = label;
  setStatus("Fetching tides…");
  return load(point);
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

  // Situational caveat, up front: a prediction from far away (or from the
  // global model) is not a prediction for here (requirements 3 and 10).
  const warnEl = $("proximity-warning");
  if (r.kind === "global-model") {
    warnEl.textContent =
      "Outside the Irish prediction stations — showing the global model (Open-Meteo).";
    warnEl.classList.remove("hidden");
  } else if (r.distanceKm != null && r.distanceKm > MAX_STATION_DISTANCE_KM) {
    warnEl.textContent = `Nearest prediction station is ${km(r.distanceKm)} away — this is not a prediction for here.`;
    warnEl.classList.remove("hidden");
  } else {
    warnEl.textContent = "";
    warnEl.classList.add("hidden");
  }

  // Surge
  renderSurge();

  // Provenance
  $("provenance").innerHTML =
    `Source ${r.source} · station ${escapeHtml(r.station)} · datum ${escapeHtml(r.datum)} · ` +
    `fetched ${fmtDayTime(r.fetchedAt, zone)} (${zoneAbbr}, ${zoneOffset})`;

  renderHeart();

  // A point the source cannot predict: say so in a sentence rather than draw
  // an empty chart with no turns on it.
  if (!hasTideData(r)) {
    $("summary").classList.add("hidden");
    renderNoData(r);
    return;
  }
  $("no-data").classList.add("hidden");
  renderSummary();
}

/** Whether the result carries any usable tide series for the display window. */
function hasTideData(r) {
  const series = activeSeries(r);
  if (!Array.isArray(series) || !series.length) return false;
  // The curve is drawn for now-2h .. now+12h; a series that stops before that
  // can only produce an empty chart, so treat it as no data.
  const nowMs = Date.now();
  const from = nowMs - 2 * 3600000;
  const to = nowMs + 12 * 3600000;
  return series.some((p) => {
    if (p.height == null) return false;
    const t = Date.parse(p.time);
    return t >= from && t <= to;
  });
}

// The plain "we cannot predict here" card, shown instead of the summary when a
// source returns no points for the point asked about.
function renderNoData(r) {
  const card = $("no-data");
  const body = $("no-data-body");
  const where = placeLabel ? escapeHtml(placeLabel) : "this point";

  if (r.kind === "global-model") {
    body.innerHTML =
      `The global model (Open-Meteo Marine) has no sea-level series for ${where} ` +
      `in the next few days. It is a coarse model, and some coastal and enclosed ` +
      `points fall outside it.`;
  } else {
    body.innerHTML =
      `The prediction source has no data for ${where} in the next few days.`;
  }
  card.classList.remove("hidden");
}

function activeSeries(r) {
  return datumChoice === "ODM" && r.seriesODM && r.seriesODM.length
    ? r.seriesODM
    : r.series;
}

/** Whether the result carries an OD Malin series alongside the primary datum. */
function hasODMSeries(r) {
  return Array.isArray(r.seriesODM) && r.seriesODM.length > 0;
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
    b.addEventListener("click", () => choose(r, { fromChip: true }));
    box.appendChild(b);
  }
  box.classList.remove("hidden");
}

function hideChoices() {
  $("choices").classList.add("hidden");
  $("choices").innerHTML = "";
}

// Merge two geocoder result lists, dropping duplicate (name, country) pairs
// so the alternatives list does not repeat the same place twice.
function mergeGeoResults(a, b) {
  const seen = new Set();
  const out = [];
  for (const r of [...a, ...b]) {
    const key = `${r.name}|${r.countryCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// Ireland first, then everything else in the order the geocoder gave it. This
// is an Irish tide tool: an Irish match should be the one the map jumps to and
// the one the alternatives list leads with, without hiding the rest.
function sortByIreland(results) {
  return [...results].sort(
    (a, b) => (b.countryCode === "IE" ? 1 : 0) - (a.countryCode === "IE" ? 1 : 0),
  );
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

// A message directly under the search bar, for a search that cannot be
// answered at all (a place that does not exist, a geocoder that is down).
function setSearchError(msg) {
  const el = $("search-error");
  if (msg) {
    el.textContent = msg;
    el.classList.remove("hidden");
  } else {
    el.textContent = "";
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
  trackEvent(datumChoice === "LAT" ? "datum-lat" : "datum-odm");
  if (tideResult) {
    render();
    renderTideBlock();
  }
}

// ---------------------------------------------------------------------------
// moon phase

function renderMoonBlock() {
  const now = new Date();
  const phase = lunarPhase(now);
  const ev = nextMoonEvents(now);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  $("details-moon").innerHTML =
    `<h2>Moon</h2>` +
    `<div class="dt-moon-row">` +
    `<svg viewBox="0 0 64 64" width="40" height="40" aria-hidden="true">${moonGlyph(phase, 64)}</svg>` +
    `<div><div class="dt-moon-name">${phase.name}</div>` +
    `<div class="muted">${Math.round(phase.illuminated * 100)}% illuminated · ${phase.ageDays.toFixed(1)} days old</div></div>` +
    `</div>` +
    `<div>Next full moon: <strong>${fmtDayTime(ev.nextFull.toISOString(), tz)}</strong> (${daysUntil(ev.nextFull, now)})</div>` +
    `<div>Next new moon: <strong>${fmtDayTime(ev.nextNew.toISOString(), tz)}</strong> (${daysUntil(ev.nextNew, now)})</div>`;
}

function daysUntil(d, now) {
  const days = (d.getTime() - now.getTime()) / 86400000;
  if (days < 1) return `in ${Math.max(0, Math.round(days * 24))} h`;
  return `in ${days.toFixed(1)} days`;
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
// favourites

function loadFavourites() {
  try {
    const raw = localStorage.getItem(FAVOURITES_KEY);
    favourites = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(favourites)) favourites = [];
  } catch {
    favourites = [];
  }
}

function persistFavourites() {
  try {
    localStorage.setItem(FAVOURITES_KEY, JSON.stringify(favourites));
  } catch {
    /* storage unavailable — favourites are just not persisted */
  }
}

function heartKey(point) {
  return `${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`;
}

function isFavourited(point) {
  return !!point && favourites.some((f) => f.id === heartKey(point));
}

function renderHeart() {
  const btn = $("sum-heart");
  if (!currentPoint) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  const saved = isFavourited(currentPoint);
  btn.innerHTML = iconSvg(saved ? "heart-filled" : "heart");
  btn.classList.toggle("saved", saved);
  btn.setAttribute("aria-label", saved ? "Remove from favourites" : "Save to favourites");
}

// Small inline SVG icons, so the UI does not depend on emoji rendering (which
// varies by platform and clashes with the crisp inline SVGs used elsewhere).
function iconSvg(name) {
  const paths = {
    heart:
      `<path fill="none" stroke="currentColor" stroke-width="2" d="M12 20.3l-1.45-1.32C5.4 14.24 2 11.16 2 7.4A5.4 5.4 0 0 1 7.4 2c1.74 0 3.41.81 4.6 2.09A6.02 6.02 0 0 1 16.6 2 5.4 5.4 0 0 1 22 7.4c0 3.76-3.4 6.84-8.55 11.59z"/>`,
    "heart-filled":
      `<path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09A5.99 5.99 0 0 1 16.5 3C19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z"/>`,
    pencil:
      `<path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>`,
  };
  return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}

function removeFavourite(id) {
  favourites = favourites.filter((f) => f.id !== id);
  trackEvent("favourite-remove");
  persistFavourites();
  renderFavourites();
  renderHeart();
}

function toggleFavourite() {
  if (!currentPoint) return;
  const id = heartKey(currentPoint);
  const existing = favourites.find((f) => f.id === id);
  if (existing) {
    removeFavourite(id);
  } else {
    favourites.push({
      id,
      name: placeLabel,
      latitude: currentPoint.latitude,
      longitude: currentPoint.longitude,
      timezone: zone,
    });
    trackEvent("favourite-add");
    persistFavourites();
    renderFavourites();
    renderHeart();
  }
}

function renderFavourites() {
  const list = $("favourites-list");
  const card = $("favourites-card");
  list.innerHTML = "";
  // Before anything is saved the card is pure noise — fold it away entirely.
  if (!favourites.length) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  for (const f of favourites) {
    const li = document.createElement("li");
    li.dataset.id = f.id;

    const go = document.createElement("button");
    go.type = "button";
    go.className = "fave-go";
    const nameSpan = document.createElement("span");
    nameSpan.className = "fave-name";
    nameSpan.textContent = f.name;
    const subSpan = document.createElement("span");
    subSpan.className = "fave-sub";
    subSpan.textContent = `${f.latitude.toFixed(3)}, ${f.longitude.toFixed(3)}`;
    go.append(nameSpan, subSpan);
    go.addEventListener("click", () => goFavourite(f));

    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "fave-rename";
    rename.innerHTML = iconSvg("pencil");
    rename.title = "Rename";
    rename.setAttribute("aria-label", `Rename ${f.name}`);
    rename.addEventListener("click", () => beginRename(li, f));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "fave-remove saved";
    remove.innerHTML = iconSvg("heart-filled");
    remove.title = "Remove";
    remove.setAttribute("aria-label", `Remove ${f.name}`);
    remove.addEventListener("click", () => removeFavourite(f.id));

    li.append(go, rename, remove);
    list.appendChild(li);
  }
  // With a saved favourite on screen, point out the rename pencil (once).
  maybeHint();
}

function beginRename(li, f) {
  const go = li.querySelector(".fave-go");
  const input = document.createElement("input");
  input.type = "text";
  input.value = f.name;
  input.className = "fave-input";
  input.setAttribute("aria-label", "Rename favourite");
  const commit = () => {
    const name = input.value.trim();
    if (name) f.name = name;
    trackEvent("favourite-rename");
    persistFavourites();
    renderFavourites();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    else if (e.key === "Escape") {
      input.value = f.name;
      input.blur();
    }
  });
  input.addEventListener("blur", commit);
  go.replaceWith(input);
  input.focus();
  input.select();
}

function goFavourite(f) {
  trackEvent("favourite-open");
  loadPoint(
    { latitude: f.latitude, longitude: f.longitude },
    { zone: f.timezone || "UTC", label: f.name },
  );
}

// ---------------------------------------------------------------------------
// about overlay (long-press the title/icon)

let infoHoldTimer = null;

function startInfoHold() {
  cancelInfoHold();
  infoHoldTimer = setTimeout(openInfo, 800);
}

function cancelInfoHold() {
  if (infoHoldTimer) {
    clearTimeout(infoHoldTimer);
    infoHoldTimer = null;
  }
}

function openInfo() {
  $("info-version").textContent = versionText();
  $("info-overlay").classList.remove("hidden");
}

function closeInfo() {
  $("info-overlay").classList.add("hidden");
}

function versionText() {
  const meta = document.querySelector('meta[name="version"]');
  return meta ? `Version ${meta.content}` : "Version unknown";
}

// ---------------------------------------------------------------------------
// developer overlay (long-press the top-right corner of the info panel)
//
// A hidden door for testing device state without devtools: it can clear the
// first-run hints (so the coachmarks show again) or wipe every localStorage
// key this app owns. Nothing here talks to a source; it only touches the
// device's own stored state.

const LOCAL_KEYS = [THEME_KEY, FAVOURITES_KEY, HINTS_KEY];

let debugHoldTimer = null;

function startDebugHold() {
  cancelDebugHold();
  debugHoldTimer = setTimeout(openDebug, 3000);
}

function cancelDebugHold() {
  if (debugHoldTimer) {
    clearTimeout(debugHoldTimer);
    debugHoldTimer = null;
  }
}

function openDebug() {
  closeInfo();
  setDebugNote("Local data on this device.");
  $("debug-overlay").classList.remove("hidden");
}

function closeDebug() {
  $("debug-overlay").classList.add("hidden");
  // A clear action may have made a hint eligible again; offer it now the
  // overlay is out of the way (a no-op when every hint is already seen).
  maybeHint();
}

function setDebugNote(msg) {
  $("debug-note").textContent = msg;
}

// Clear one or more of our own localStorage keys, then re-apply the state so
// the change is visible without a manual reload.
function clearLocalKeys(keys) {
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* storage unavailable — nothing to clear */
    }
  }
}

function clearFirstRunHints() {
  clearLocalKeys([HINTS_KEY]);
  setDebugNote("First-run hints cleared — they will show again.");
}

function clearAllData() {
  clearLocalKeys(LOCAL_KEYS);
  // Put the app back to a cold state: theme to the device default, empty
  // favourites, no hints seen.
  initTheme();
  loadFavourites();
  renderFavourites();
  setDebugNote("All local data cleared.");
}

// ---------------------------------------------------------------------------
// summary panel

// Catmull-Rom spline through the points as cubic Béziers, so the curve bends
// smoothly instead of joining the samples with straight lines.
function smoothCurveD(points) {
  if (points.length < 2) return "";
  const p = points;
  let d = `M ${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
  for (let i = 0; i < p.length - 1; i += 1) {
    const p0 = p[i - 1] || p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

function renderSummary() {
  const r = tideResult;
  if (!r) return;
  const now = new Date();
  $("summary").classList.remove("hidden");

  $("sum-name").textContent = placeLabel;

  const phase = lunarPhase(now);
  $("sum-moon-glyph").innerHTML = moonGlyph(phase, 64);
  renderCurrentRose(now);

  const series = activeSeries(r);
  const turns = nextTurns(r.extremes, now);
  drawSummaryCurve(series, now, turns);

  const hasODM = hasODMSeries(r);
  // Show the turns in the order they happen, so the next one is always on the
  // left whichever it is. A missing turn keeps its slot as a placeholder so the
  // row stays balanced.
  const turnBlocks = [
    { label: "High", turn: turns.nextHigh },
    { label: "Low", turn: turns.nextLow },
  ]
    .sort((a, b) => {
      const am = a.turn ? a.turn.minutesTo : Infinity;
      const bm = b.turn ? b.turn.minutesTo : Infinity;
      return am - bm;
    })
    .map((b) => {
      const el = document.createElement("div");
      el.className = "sum-turn";
      el.textContent = summaryTurnText(b.label, b.turn, hasODM);
      return el;
    });
  $("sum-turns").replaceChildren(...turnBlocks);

  // The summary is now on screen, so the heart (and anything below it) can be
  // pointed out if it has not been seen yet.
  maybeHint();
}

function summaryTurnText(label, t, hasODM) {
  if (!t) return `${label} —`;
  const h =
    datumChoice === "ODM" && hasODM && t.heightODM != null ? t.heightODM : t.height;
  return `${label} ${fmtClock(t.time, zone)} · ${fmtDur(t.minutesTo)} · ${m(h)} m`;
}

function seriesHeightAt(series, tMs) {
  for (let i = 0; i < series.length - 1; i += 1) {
    const t1 = Date.parse(series[i].time);
    const t2 = Date.parse(series[i + 1].time);
    if (tMs < t1 || tMs > t2) continue;
    const h1 = series[i].height;
    const h2 = series[i + 1].height;
    if (h1 == null || h2 == null) return null;
    const dt = t2 - t1;
    return dt <= 0 ? h1 : h1 + (h2 - h1) * ((tMs - t1) / dt);
  }
  return null;
}

function drawSummaryCurve(series, now, turns) {
  const svg = $("sum-curve");
  const W = 360;
  const H = 150;
  const padTop = 16;
  const padBottom = 12;
  const padLeft = 8;
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
      `<text class="curve-label" x="180" y="75" text-anchor="middle">No tide data for this window</text>`;
    $("sum-axis").innerHTML = "";
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
    return;
  }
  const pad = (max - min) * 0.2 || 0.5;
  min -= pad;
  max += pad;

  const x = (t) => padLeft + ((t - from) / (to - from)) * (W - padLeft - padRight);
  const y = (h) => padTop + (1 - (h - min) / (max - min)) * (H - padTop - padBottom);

  const pts = win.map((p) => [x(Date.parse(p.time)), y(p.height)]);

  let inner = "";
  inner +=
    `<path class="curve-fill" d="${smoothCurveD(pts)} L ${x(to).toFixed(1)},${H - padBottom} L ${x(from).toFixed(1)},${H - padBottom} Z" />`;
  inner += `<path class="curve-line" d="${smoothCurveD(pts)}" />`;

  const nowX = x(nowMs);
  inner += `<line class="curve-now" x1="${nowX.toFixed(1)}" y1="${padTop}" x2="${nowX.toFixed(1)}" y2="${H - padBottom}" />`;
  inner += `<text class="curve-label" x="${nowX.toFixed(1)}" y="${padTop - 4}" text-anchor="middle">NOW</text>`;

  // The current height on the NOW line, so the picture and the headline agree.
  const nowH = seriesHeightAt(series, nowMs);
  if (nowH != null) {
    inner += `<circle cx="${nowX.toFixed(1)}" cy="${y(nowH).toFixed(1)}" r="3.5" fill="var(--card)" stroke="var(--accent)" stroke-width="2" />`;
  }

  for (const [letter, turn] of [["H", turns.nextHigh], ["L", turns.nextLow]]) {
    if (!turn) continue;
    const tm = Date.parse(turn.time);
    if (tm < from || tm > to) continue;
    const h = seriesHeightAt(series, tm);
    if (h == null) continue;
    const mx = x(tm);
    const my = y(h);
    inner += `<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="4" fill="var(--accent)" stroke="var(--card)" stroke-width="1.5" />`;
    inner += `<text class="curve-label" x="${mx.toFixed(1)}" y="${my - 8}" text-anchor="middle">${letter} ${fmtClock(turn.time, zone)}</text>`;
  }

  svg.innerHTML = inner;

  // Values under the curve: the window's start/end clocks, and the height now.
  const axis = $("sum-axis");
  axis.innerHTML =
    `<span>${fmtClock(iso(new Date(from)), zone)}</span>` +
    (nowH != null ? `<span>now ${m(nowH)} m</span>` : "") +
    `<span>${fmtClock(iso(new Date(to)), zone)}</span>`;
}

// ---------------------------------------------------------------------------
// tide details popup

function renderTideBlock() {
  const r = tideResult;
  const el = $("details-tide");
  if (!r) {
    el.innerHTML = "";
    return;
  }
  const now = new Date();

  const kindWord =
    r.kind === "global-model" ? "global model" :
    r.kind === "model" ? "model" : "prediction station";

  // The distance / global-model caveat is shown as a banner above the card
  // (see render()), so it is not repeated here.

  const spring = rangeAnalysis(r.extremes, now);
  const label =
    spring.label === "springs" ? "springs" :
    spring.label === "neaps" ? "neaps" :
    spring.label === "mid" ? "mid-cycle" : "not available";

  const nextLines = [];
  if (spring.nextSpring) {
    nextLines.push(
      `<div>Next spring tide: <strong>${fmtDay(spring.nextSpring, zone)}</strong> (${daysUntil(new Date(spring.nextSpring), now)})</div>`,
    );
  }
  if (spring.nextNeap) {
    nextLines.push(
      `<div>Next neap tide: <strong>${fmtDay(spring.nextNeap, zone)}</strong> (${daysUntil(new Date(spring.nextNeap), now)})</div>`,
    );
  }

  const series = activeSeries(r);
  const hasODM = hasODMSeries(r);
  const useODM = datumChoice === "ODM" && hasODM;
  const st = tideStateAt(series, now);
  let arrow = "";
  let stateText = "";
  if (st && Math.abs(st.rateMh) >= 0.05) {
    arrow = tideArrowSvg(st.rateMh, st.rising);
    stateText = `${st.rising ? "Rising" : "Falling"} at ${Math.abs(st.rateMh).toFixed(1)} m/h · now ${m(st.height)} m`;
  } else {
    arrow = steadyArrowSvg();
    stateText = "Steady now";
  }

  const turns = nextTurns(r.extremes, now);
  let rangeLine = "";
  if (turns.nextHigh && turns.nextLow) {
    const hh = useODM ? turns.nextHigh.heightODM ?? turns.nextHigh.height : turns.nextHigh.height;
    const hl = useODM ? turns.nextLow.heightODM ?? turns.nextLow.height : turns.nextLow.height;
    if (hh != null && hl != null) {
      rangeLine = `Predicted range: ${m(Math.abs(hh - hl))} m`;
    }
  }

  let surge = "";
  if (surgeResult && surgeResult.series.length) {
    const latest = surgeResult.series[surgeResult.series.length - 1];
    surge =
      `<div class="muted">Observed at ${fmtDayTime(latest.time, zone)}: tide <strong>${m(latest.tide)} m</strong> · surge <strong>${m(latest.surge)} m</strong> — the prediction above excludes this surge.</div>`;
  }

  let datumHtml = `Datum ${escapeHtml(r.datum)}`;
  if (hasODM) {
    const shown = datumChoice === "LAT" ? "LAT (chart datum)" : "OD Malin";
    const other = datumChoice === "LAT" ? "OD Malin" : "LAT";
    datumHtml =
      `Datum ${shown} · ` +
      `<button class="datum-mini" type="button" data-action="toggle-datum">Show ${other}</button>`;
  }

  el.innerHTML =
    `<h2>Tide</h2>` +
    `<div class="muted">${escapeHtml(r.stationName)} — ${kindWord}` +
    (r.distanceKm != null ? ` · ${km(r.distanceKm)} from where you asked` : "") +
    `</div>` +
    `<div>Currently: <strong>${label}</strong> <span class="muted">(inferred from the predicted range)</span></div>` +
    nextLines.join("") +
    `<div class="dt-state"><svg class="dt-arrow" viewBox="0 0 32 96" aria-hidden="true">${arrow}</svg><span>${stateText}</span></div>` +
    `<div class="muted">${rangeLine}${rangeLine ? " · " : ""}station ${escapeHtml(r.station)} · ${datumHtml} · fetched ${fmtDayTime(r.fetchedAt, zone)}</div>` +
    surge;
}

function toggleDetails() {
  const details = $("details");
  if (details.classList.contains("hidden")) {
    trackEvent("details-open");
    openDetails();
  } else {
    details.classList.add("hidden");
    $("details-toggle").setAttribute("aria-expanded", "false");
  }
}

function openDetails() {
  renderTideBlock();
  renderMoonBlock();
  renderCurrentBlock();
  renderSourceSwitch();
  $("details").classList.remove("hidden");
  $("details-toggle").setAttribute("aria-expanded", "true");
}

function renderSourceSwitch() {
  const near =
    stations.length && currentPoint ? nearestStation(currentPoint, stations) : null;
  const marineAvailable = !!near && near.distanceKm <= GLOBAL_MODEL_FALLBACK_KM;
  const marineBtn = $("source-switch").querySelector('[data-source="marine-ie"]');
  marineBtn.disabled = !marineAvailable;
  marineBtn.title = marineAvailable
    ? "Irish prediction stations (Marine Institute)"
    : "No Irish station within range — not available";
  const src = tideResult ? tideResult.source : null;
  for (const b of $("source-switch").querySelectorAll("button")) {
    const selected = b.dataset.source === src;
    b.classList.toggle("selected", selected);
    b.setAttribute("aria-pressed", String(selected));
  }
}

async function setSource(source) {
  if (source === sourceChoice) return;
  sourceChoice = source;
  trackEvent(source === "marine-ie" ? "switch-marine" : "switch-openmeteo");
  if (!currentPoint) return;
  await loadPoint(currentPoint);
  openDetails();
}

/** A vertical arrow whose shaft length grows with the rate of rise or fall. */
function tideArrowSvg(rateMh, rising) {
  const cx = 16;
  const maxRate = 1.5; // m/h at which the arrow reaches full length
  const shaft = Math.min(72, 10 + (Math.abs(rateMh) / maxRate) * 62);
  let backY, endY, tipY, baseY;
  if (rising) {
    backY = 90;
    endY = 90 - shaft;
    tipY = endY - 5;
    baseY = endY + 4;
  } else {
    backY = 6;
    endY = 6 + shaft;
    tipY = endY + 5;
    baseY = endY - 4;
  }
  return (
    `<line x1="${cx}" y1="${backY}" x2="${cx}" y2="${endY}" stroke-width="3" stroke-linecap="round" style="stroke:var(--accent)"/>` +
    `<polygon points="${cx},${tipY} ${cx - 6},${baseY} ${cx + 6},${baseY}" style="fill:var(--accent)"/>`
  );
}

/** A short horizontal dash for "steady" — no vertical motion. */
function steadyArrowSvg() {
  return `<line x1="6" y1="48" x2="26" y2="48" stroke-width="3" stroke-linecap="round" style="stroke:var(--accent)"/>`;
}

// ---------------------------------------------------------------------------
// current (water) direction

function renderCurrentRose(now) {
  const btn = $("sum-current");
  const currents = currentResult && currentResult.currents;
  const c = nearestCurrent(currents, now);
  if (!c || c.speed == null || c.direction == null) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  $("sum-current-rose").innerHTML = compassRoseSvg(c.direction);
  $("sum-current-speed").textContent = `${c.speed.toFixed(1)} m/s`;
}

// "now" / "N min ago" / "in N min" for the nearest modelled reading.
function currentOffsetText(c, now) {
  const sign = Date.parse(c.time) >= now.getTime() ? 1 : -1;
  const minutes =
    c.minutesOffset ?? Math.round(Math.abs(Date.parse(c.time) - now.getTime()) / 60000);
  if (minutes < 1) return "now";
  return sign > 0 ? `in ${minutes} min` : `${minutes} min ago`;
}

function renderCurrentBlock() {
  const now = new Date();
  const currents = currentResult && currentResult.currents;
  const c = nearestCurrent(currents, now);
  const el = $("details-current");
  if (!c || c.speed == null || c.direction == null) {
    el.innerHTML = `<h2>Current</h2><div class="muted">No current model covers this point.</div>`;
    return;
  }
  el.innerHTML =
    `<h2>Current</h2>` +
    `<div class="dt-cur-row">` +
    `<svg viewBox="0 0 34 34" width="40" height="40" aria-hidden="true">${compassRoseSvg(c.direction)}</svg>` +
    `<div><div class="dt-cur-speed">${c.speed.toFixed(1)} m/s</div>` +
    `<div class="muted">${compassPoint(c.direction)} (${Math.round(c.direction)}°, heading towards)</div></div>` +
    `</div>` +
    `<div class="muted">Open-Meteo Marine, ~8 km grid, at ${fmtClock(c.time, zone)} (${currentOffsetText(c, now)}) — model output, not suitable for coastal navigation.</div>`;
}

/** A compass rose with an arrow pointing the way the water is heading. */
function compassRoseSvg(direction) {
  const cx = 17, cy = 17, R = 15;
  const rad = (direction * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const headX = cx + R * dx;
  const headY = cy + R * dy;
  const tailX = cx - R * 0.6 * dx;
  const tailY = cy - R * 0.6 * dy;
  const bx = headX - R * 0.42 * dx;
  const by = headY - R * 0.42 * dy;
  const px = -dy, py = dx;
  const half = R * 0.28;
  const b1x = bx + half * px, b1y = by + half * py;
  const b2x = bx - half * px, b2y = by - half * py;
  return (
    `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke-width="1.5" style="stroke:var(--border)"/>` +
    `<line x1="${tailX.toFixed(1)}" y1="${tailY.toFixed(1)}" x2="${headX.toFixed(1)}" y2="${headY.toFixed(1)}" stroke-width="2.5" stroke-linecap="round" style="stroke:var(--accent)"/>` +
    `<polygon points="${headX.toFixed(1)},${headY.toFixed(1)} ${b1x.toFixed(1)},${b1y.toFixed(1)} ${b2x.toFixed(1)},${b2y.toFixed(1)}" style="fill:var(--accent)"/>` +
    `<text x="${cx}" y="7" text-anchor="middle" font-size="6.5" style="fill:var(--muted)">N</text>`
  );
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
