#!/bin/sh
set -eu
# Regenerate data/stations.json from Marine Institute ERDDAP.
# Requires curl and jq. Writes to a temp file and moves it into place, so a
# failed fetch never truncates the committed snapshot.
#
# data/station-map.json is NOT generated here: it maps three spellings of each
# station key (prediction `stationID`, gauge-network `station_id`, surge-observation
# `stationID`) and is hand-checked, not guessed. Its shape is a wrapper object
# whose `map` value is the list:
#   { "map": [ { "prediction": "Galway", "gauge": "Galway Port", "surge": "Galway" }, … ] }
#
# Generated with an AI coding assistant.
# Assisted-by: GitHub Copilot (DeepSeek V4 Pro)

if ! command -v curl >/dev/null 2>&1; then
  echo "refresh-stations: curl is required" >&2; exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "refresh-stations: jq is required" >&2; exit 1
fi

cd "$(dirname "$0")/.."
mkdir -p data

ERDDAP="https://erddap.marine.ie/erddap"
TODAY="$(date -u +%Y-%m-%d)"
TOMORROW="$(date -u -v+1d +%Y-%m-%d 2>/dev/null || date -u -d tomorrow +%Y-%m-%d)"

# One day of high/low rows across all stations (4 rows/station/day), then
# collapse to the distinct station list. This avoids ERDDAP's slow distinct().
# Tomcat rejects a raw `>` or `<` in the request target, so the comparison
# operators are percent-encoded (%3E, %3C) here — curl does not encode them.
URL="${ERDDAP}/tabledap/IMI_TidePrediction_HighLow.json?stationID,longitude,latitude&time%3E=${TODAY}T00:00:00Z&time%3C=${TOMORROW}T00:00:00Z"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if ! curl -fsS --max-time 120 "$URL" -o "$TMP"; then
  echo "refresh-stations: fetch failed (ERDDAP unreachable?) — snapshot not changed" >&2
  exit 1
fi

if ! jq -e '.table.rows | length > 0' "$TMP" >/dev/null; then
  echo "refresh-stations: empty response — snapshot not changed" >&2
  exit 1
fi

jq --arg url "$URL" '
  .table.rows
  | map({
      id: .[0],
      name: .[0],
      latitude: .[2],
      longitude: .[1],
      kind: (if (.[0] | test("MODELLED"; "i")) then "model" else "gauge" end)
    })
  | unique_by(.id)
  | sort_by(.id)
  | {
      generated: (now | todate),
      source: $url,
      note: "Vendored snapshot of the Marine Institute prediction stations. Regenerate with tools/refresh-stations.sh.",
      stations: .
    }
' "$TMP" > data/stations.json

echo "Wrote data/stations.json ($(jq '.stations | length' data/stations.json) stations)"
