import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  geocode,
  marineIeTides,
  marineIeSurge,
  openMeteoMarine,
  noaaPredictions,
} from "../js/sources.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = async (name) =>
  JSON.parse(await readFile(join(here, "fixtures", name), "utf8"));

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      date: new Date().toUTCString(),
    },
  });
}

// Stub global fetch: first route whose needle appears in the URL answers.
function route(routes) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [needle, body] of routes) {
      if (u.includes(needle)) return jsonResponse(body);
    }
    throw new Error(`unexpected URL in test: ${u}`);
  };
}

test("geocode parses results and exposes the alternatives", async () => {
  route([["geocoding-api.open-meteo.com", await fixture("geocode-galway.json")]]);
  const out = await geocode("Galway");
  assert.equal(out.source, "open-meteo-geocoding");
  assert.equal(out.results.length, 5);
  assert.equal(out.results[0].name, "Galway");
  assert.equal(out.results[0].countryCode, "IE");
  assert.equal(out.results[0].timezone, "Europe/Dublin");
  assert.ok(out.results.some((r) => r.countryCode === "US"), "US alternatives shown");
});

test("marineIeTides normalises the ERDDAP curve and turns", async () => {
  const stations = [
    { id: "Galway", name: "Galway", kind: "gauge", latitude: 53.27, longitude: -9.05 },
  ];
  route([
    ["IMI_TidePrediction_HighLow", await fixture("erddap-highlow-galway.json")],
    ["imiTidePrediction", await fixture("erddap-curve-galway.json")],
  ]);

  const out = await marineIeTides(
    { latitude: 53.27, longitude: -9.05 },
    {
      curveStart: "2026-09-30T05:00:00Z",
      curveEnd: "2026-09-30T09:00:00Z",
      extremesStart: "2026-09-30T00:00:00Z",
      extremesEnd: "2026-10-01T00:00:00Z",
    },
    stations,
  );

  assert.equal(out.source, "marine-ie");
  assert.equal(out.station, "Galway");
  assert.equal(out.kind, "gauge");
  assert.equal(out.datum, "LAT");
  assert.ok(out.distanceKm < 0.1);
  assert.equal(out.series.length, 7);
  assert.equal(out.series[0].height, 4.85);
  assert.equal(out.seriesODM.length, 7);

  const turn = out.extremes.find((e) => e.time === "2026-09-30T07:00:00Z");
  assert.equal(turn.type, "HIGH");
  assert.equal(turn.heightODM, 2.235);
  assert.ok(Math.abs(turn.height - 5.175) < 1e-9, "LAT height interpolated from the curve");

  const early = out.extremes.find((e) => e.time === "2026-09-30T00:35:00Z");
  assert.equal(early.type, "LOW");
  assert.equal(early.height, null, "turn outside the curve window has no LAT height");
  assert.equal(early.heightODM, -2.274);
});

test("marineIeTides throws when there is no station", async () => {
  await assert.rejects(
    () => marineIeTides({ latitude: 53.27, longitude: -9.05 }, {}, []),
    /no Marine Institute prediction station/,
  );
});

test("marineIeTides throws when the curve is empty", async () => {
  const stations = [{ id: "Galway", latitude: 53.27, longitude: -9.05 }];
  route([
    ["IMI_TidePrediction_HighLow", await fixture("erddap-highlow-galway.json")],
    ["imiTidePrediction", { table: { columnNames: [], columnTypes: [], rows: [] } }],
  ]);
  await assert.rejects(
    () => marineIeTides({ latitude: 53.27, longitude: -9.05 }, {}, stations),
    /no curve predictions/,
  );
});

test("marineIeSurge normalises the tide/surge split", async () => {
  route([["imiSurgeObservationINTGN", await fixture("erddap-surge-galway.json")]]);
  const out = await marineIeSurge("Galway", {
    start: "2026-09-30T00:00:00Z",
    end: "2026-09-30T01:00:00Z",
  });
  assert.equal(out.dataset, "imiSurgeObservationINTGN");
  assert.equal(out.series[0].tide, -2.141);
  assert.equal(out.series[0].surge, 0.392);
});

test("openMeteoMarine normalises the marine response", async () => {
  const raw = await fixture("openmeteo-galway.json");
  route([["marine-api.open-meteo.com", raw]]);

  const out = await openMeteoMarine({ latitude: 53.27, longitude: -9.05 });
  assert.equal(out.source, "open-meteo");
  assert.equal(out.kind, "global-model");
  assert.equal(out.datum, "MSL");
  assert.equal(out.latitude, 53.291664);
  assert.equal(out.longitude, -9.0416565);
  assert.ok(out.distanceKm > 2 && out.distanceKm < 3, "grid point offset shown");

  assert.equal(out.series[0].time, "2026-10-04T00:00:00Z");
  assert.ok(Math.abs(out.series[0].height - raw.hourly.sea_level_height_msl[0]) < 1e-9);

  const velKmh = raw.hourly.ocean_current_velocity[0];
  assert.ok(Math.abs(out.currents[0].speed - velKmh / 3.6) < 1e-9, "km/h to m/s");
  assert.equal(out.currents[0].direction, raw.hourly.ocean_current_direction[0]);
});

test("noaaPredictions normalises the hilo response", async () => {
  route([["api.tidesandcurrents.noaa.gov", await fixture("noaa-9414290-hilo.json")]]);
  const out = await noaaPredictions("9414290", {
    start: "2026-10-04T00:00:00Z",
    end: "2026-10-05T00:00:00Z",
  });
  assert.equal(out.source, "noaa");
  assert.equal(out.datum, "MLLW");
  assert.equal(out.extremes.length, 8);
  assert.equal(out.extremes[0].time, "2026-10-04T00:11:00Z");
  assert.equal(out.extremes[0].type, "HIGH");
  assert.equal(out.extremes[0].height, 1.765);
});
