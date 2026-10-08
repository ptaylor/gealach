import { test } from "node:test";
import assert from "node:assert/strict";
import {
  haversineKm,
  nearestStation,
  tideStateAt,
  nextTurns,
  rangeAnalysis,
  nearestCurrent,
  compassPoint,
  lunarPhase,
  nextMoonEvents,
  MAX_STATION_DISTANCE_KM,
} from "../js/tide.js";

const DAY = 24 * 3600 * 1000;

test("MAX_STATION_DISTANCE_KM is the documented threshold", () => {
  assert.equal(MAX_STATION_DISTANCE_KM, 25);
});

test("haversineKm: Galway to Dublin is about 186 km", () => {
  const km = haversineKm(53.27, -9.05, 53.35, -6.26);
  assert.ok(Math.abs(km - 185.6) < 2, `expected ~186 km, got ${km}`);
});

test("nearestStation picks the nearest and carries name/kind", () => {
  const stations = [
    { id: "Galway", name: "Galway", kind: "gauge", latitude: 53.27, longitude: -9.05 },
    { id: "Dublin_Port", name: "Dublin Port", latitude: 53.35, longitude: -6.22 },
  ];
  const near = nearestStation({ latitude: 53.27, longitude: -9.05 }, stations);
  assert.equal(near.id, "Galway");
  assert.equal(near.name, "Galway");
  assert.equal(near.kind, "gauge");
  assert.ok(near.distanceKm < 0.1);
});

test("nearestStation returns null for an empty list", () => {
  assert.equal(nearestStation({ latitude: 53.27, longitude: -9.05 }, []), null);
});

test("tideStateAt interpolates height and reports the rate", () => {
  const series = [
    { time: "2026-09-30T06:00:00Z", height: 4.85 },
    { time: "2026-09-30T06:05:00Z", height: 4.9 },
  ];
  const st = tideStateAt(series, "2026-09-30T06:02:30Z");
  assert.equal(st.rising, true);
  assert.ok(Math.abs(st.height - 4.875) < 1e-9);
  assert.ok(Math.abs(st.rateMh - 0.6) < 1e-9);
});

test("tideStateAt returns null outside the series", () => {
  const series = [
    { time: "2026-09-30T06:00:00Z", height: 4.85 },
    { time: "2026-09-30T06:05:00Z", height: 4.9 },
  ];
  assert.equal(tideStateAt(series, "2026-09-30T05:00:00Z"), null);
  assert.equal(tideStateAt(series, "2026-09-30T07:00:00Z"), null);
});

test("nextTurns returns the next high and low with minutes remaining", () => {
  const extremes = [
    { time: "2026-09-30T07:00:00Z", type: "HIGH", height: 2.2, heightODM: 2.235 },
    { time: "2026-09-30T13:10:00Z", type: "LOW", height: -2.1, heightODM: -2.101 },
    { time: "2026-09-30T00:35:00Z", type: "LOW", height: null, heightODM: -2.274 },
  ];
  const { nextHigh, nextLow } = nextTurns(extremes, "2026-09-30T08:00:00Z");
  assert.equal(nextHigh, null);
  assert.equal(nextLow.time, "2026-09-30T13:10:00Z");
  assert.equal(nextLow.minutesTo, 310);
  assert.equal(nextLow.heightODM, -2.101);
});

test("compassPoint maps degrees to the 16-point compass", () => {
  assert.equal(compassPoint(0), "N");
  assert.equal(compassPoint(90), "E");
  assert.equal(compassPoint(180), "S");
  assert.equal(compassPoint(270), "W");
  assert.equal(compassPoint(45), "NE");
});

test("nearestCurrent returns the nearest reading with its offset", () => {
  const currents = [
    { time: "2026-10-04T00:00:00Z", speed: 0.5, direction: 90 },
    { time: "2026-10-04T01:00:00Z", speed: 0.7, direction: 100 },
  ];
  const c = nearestCurrent(currents, "2026-10-04T00:40:00Z");
  assert.equal(c.speed, 0.7);
  assert.equal(c.minutesOffset, 20);
});

test("rangeAnalysis labels springs and neaps from a synthetic fortnight", () => {
  const extremes = synthExtremes(30);
  const spring = rangeAnalysis(extremes, "2026-10-04T12:00:00Z");
  assert.equal(spring.label, "springs");
  assert.equal(spring.basis, "range-inference");

  const neap = rangeAnalysis(extremes, "2026-10-11T12:00:00Z");
  assert.equal(neap.label, "neaps");
});

test("rangeAnalysis with too few turns returns nulls", () => {
  const out = rangeAnalysis([{ time: "2026-09-30T06:00:00Z", type: "HIGH", height: 1 }]);
  assert.equal(out.label, null);
  assert.equal(out.nextSpring, null);
  assert.equal(out.nextNeap, null);
  assert.equal(out.basis, "range-inference");
});

test("rangeAnalysis names the next spring after now", () => {
  const extremes = synthExtremes(30);
  const base = Date.parse("2026-09-30T00:00:00Z");
  const { nextSpring } = rangeAnalysis(extremes, "2026-09-30T12:00:00Z");
  assert.ok(nextSpring, "expected a next spring");
  const t = Date.parse(nextSpring);
  assert.ok(
    t > base + 3 * DAY && t < base + 6 * DAY,
    `nextSpring ${nextSpring} out of the expected window`,
  );
});

test("rangeAnalysis names the next neap after now", () => {
  const extremes = synthExtremes(30);
  const base = Date.parse("2026-09-30T00:00:00Z");
  const { nextNeap } = rangeAnalysis(extremes, "2026-09-30T12:00:00Z");
  assert.ok(nextNeap, "expected a next neap");
  const t = Date.parse(nextNeap);
  assert.ok(
    t > base + 9 * DAY && t < base + 13 * DAY,
    `nextNeap ${nextNeap} out of the expected window`,
  );
});

test("lunarPhase is new moon at the reference epoch", () => {
  const p = lunarPhase("2000-01-06T18:14:00Z");
  assert.equal(p.name, "New moon");
  assert.ok(Math.abs(p.fraction) < 1e-9);
  assert.ok(Math.abs(p.illuminated) < 1e-9);
});

test("lunarPhase names the quarters across a synodic month", () => {
  assert.equal(lunarPhase("2000-01-14T03:25:00Z").name, "First quarter");
  const full = lunarPhase("2000-01-21T12:36:00Z");
  assert.equal(full.name, "Full moon");
  assert.ok(Math.abs(full.fraction - 0.5) < 0.01);
  assert.equal(lunarPhase("2000-01-28T21:47:00Z").name, "Last quarter");
});

test("lunarPhase reports waxing before full and waning after", () => {
  assert.equal(lunarPhase("2000-01-14T03:25:00Z").waxing, true);
  assert.equal(lunarPhase("2000-01-28T21:47:00Z").waxing, false);
});

test("nextMoonEvents: at new moon, full in half a month and new in a full month", () => {
  const now = new Date("2000-01-06T18:14:00Z");
  const ev = nextMoonEvents(now);
  const toFullDays = (ev.nextFull - now) / DAY;
  const toNewDays = (ev.nextNew - now) / DAY;
  assert.ok(Math.abs(toFullDays - 14.765) < 0.05, `full in ${toFullDays} days`);
  assert.ok(Math.abs(toNewDays - 29.53) < 0.05, `new in ${toNewDays} days`);
});

test("nextMoonEvents: next full is a week away at first quarter", () => {
  const now = new Date("2000-01-14T03:25:00Z");
  const ev = nextMoonEvents(now);
  const toFullDays = (ev.nextFull - now) / DAY;
  assert.ok(toFullDays > 7 && toFullDays < 8, `full in ${toFullDays} days`);
});

// One high and one low per day, range following a ~14.8-day spring/neap cycle
// around a 4.0 m mean with 1.5 m amplitude.
function synthExtremes(days) {
  const base = Date.parse("2026-09-30T00:00:00Z");
  const out = [];
  for (let d = 0; d < days; d += 1) {
    const range = 4.0 + 1.5 * Math.sin((2 * Math.PI * d) / 14.8);
    const t = base + d * DAY;
    out.push({
      time: new Date(t + 6 * 3600000).toISOString(),
      type: "HIGH",
      height: range / 2,
      heightODM: null,
    });
    out.push({
      time: new Date(t + 18 * 3600000).toISOString(),
      type: "LOW",
      height: -range / 2,
      heightODM: null,
    });
  }
  return out;
}
