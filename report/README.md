# GoatCounter report

A Python script that fetches Gealach's [GoatCounter][gc] stats via the
[stats API][api] and writes a **self-contained HTML report** with embedded
charts, plus the raw data as JSON.

[gc]: https://gealach.goatcounter.com/
[api]: https://www.goatcounter.com/api.html

It is a sibling of `foighne/report/goatcounter-report.py` and follows the same
shape: a timestamped output directory, `.env.sh` auto-loading, retrying API
calls, and an HTML file with the chart PNGs base64-embedded so it can be
mailed or archived as one file.

## Quickstart

```bash
# One-time setup (a venv lives inside report/, so nothing global is touched)
python3 -m venv report/.venv
report/.venv/bin/pip install -r report/requirements.txt

# Run a report (the API token is auto-loaded from ../.env.sh)
report/.venv/bin/python report/goatcounter-report.py --period "this month"
```

Output lands under `reports/`:

```
reports/<timestamp>_<start>_<end>/
  index.html   (self-contained HTML report with embedded charts)
  data.json    (every metric the report reads, as JSON)
  charts/      (PNG chart images, also embedded inline in index.html)
```

## Usage

```bash
report/.venv/bin/python report/goatcounter-report.py --period "today"
report/.venv/bin/python report/goatcounter-report.py --period "last week"
report/.venv/bin/python report/goatcounter-report.py --period "this month"
report/.venv/bin/python report/goatcounter-report.py --period "last month"
report/.venv/bin/python report/goatcounter-report.py --period "this year"

# Explicit range, or a single day
report/.venv/bin/python report/goatcounter-report.py --start 2026-10-01 --end 2026-10-10
report/.venv/bin/python report/goatcounter-report.py --period 2026-10-04

# A chosen output directory
report/.venv/bin/python report/goatcounter-report.py --period "this month" --out /tmp/x
```

Friendly periods: `today`, `yesterday`, `this week`, `last week`,
`this month`, `last month`, `this year`, `last year`; a single date
`YYYY-MM-DD`; or a range `YYYY-MM-DD:YYYY-MM-DD`.

## Authentication

The script reads `GOATCOUNTER_API_TOKEN` from the environment and auto-loads
`.env.sh` from the project root if present:

```sh
export GOATCOUNTER_API_TOKEN=your-api-token-here
```

A value already set in the environment wins over `.env.sh`, and the script
warns when the two disagree — a common cause of confusing `401`/`404`
responses. To force `.env.sh`, run with
`env -u GOATCOUNTER_API_TOKEN report/.venv/bin/python …`.

API tokens are per-site, so Gealach needs its own token from
<https://gealach.goatcounter.com/settings/api>.

## What the report shows

The Gealach event vocabulary (see `AGENTS.md`) is grouped into the questions
the report answers:

- **Metric cards** — visitors, events, searches, tides read, `% from Irish
  stations`, global fallbacks, Marine-ie errors, all source errors.
- **Visitors per day** — a bar chart of the period.
- **Where the tide came from** — a pie of Irish-station vs global-model
  answers, the app's central distinction.
- **How close the answering station was** — local / warned / global.
- **Engagement** — searches, map taps, station jumps, details opened,
  favourites added/opened, title resets.
- **Source and request failures** — `error-marine-ie`, `error-open-meteo`,
  `error-surge`, `error-source`, counted per API so a pattern is visible even
  when the reader never saw a problem.
- **Tables** — entry, source, distance, surge & switches, engagement,
  first-run hints, failures, geocoding, plus browsers / systems / countries and
  the top events and pages.

## Dependencies

- `requests` — GoatCounter API calls
- `pandas` + `matplotlib` — charts (optional; without them the script still
  writes the HTML and JSON, just without chart images)

## Notes

- The GoatCounter **export** API has no date-range filtering, so this uses the
  **stats** API (`/api/v0/stats/total`, `/stats/hits`, …), which does.
- The token lives in `.env.sh`, which is git-ignored — never commit a key.
- Generated output under `reports/` and the `report/.venv/` are git-ignored
  too; the script and its docs are the only committed parts.

---

This file was written with an AI coding assistant.
Assisted-by: GitHub Copilot (DeepSeek V4 Flash)
