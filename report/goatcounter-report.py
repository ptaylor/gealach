#!/usr/bin/env python3
"""
goatcounter-report.py

Fetch GoatCounter stats via the stats API for a date range, compute the
numbers that matter for Gealach, generate charts (PNG), and write a
self-contained HTML report with the images embedded.

Usage:
  python3 report/goatcounter-report.py --period "this month"
  python3 report/goatcounter-report.py --site gealach --period "last month"
  python3 report/goatcounter-report.py --start 2026-10-01 --end 2026-10-10

Notes:
  - Calls GoatCounter API v0 stats endpoints per https://www.goatcounter.com/api.html
  - API token is read from GOATCOUNTER_API_TOKEN. The script auto-loads .env.sh
    from the project root if present, but a value already set in the environment
    wins over .env.sh (a warning is printed when the two disagree — a common
    cause of confusing 401/404 responses).
  - Transient API failures (connection errors, 429, 5xx, and non-JSON replies
    such as GoatCounter's HTML error page) are retried with exponential backoff.
  - Produces a timestamped directory under reports/:
      reports/<timestamp>_<start>_<end>/
        index.html   (self-contained HTML report)
        data.json    (raw metrics & breakdown)
        charts/      (PNG chart images)

The Gealach event vocabulary read here is the one documented in AGENTS.md:
  entry        search-name | search-coords | search-geolocate | search-map
  geocoding    geocode-fallback-photon | geocode-ambiguous
  source       source-marine-ie | source-open-meteo | source-fallback-open-meteo
  distance     distance-local | distance-warned | distance-global
  surge        surge-shown | surge-none
  switches     switch-marine | switch-openmeteo | datum-lat | datum-odm
  engagement   details-open | map-open | station-jump | title-reset
               favourite-add | favourite-open | favourite-rename | favourite-remove
               favourite-map | install-shown | installed
               hint-search | hint-jump | hint-map-tap | hint-heart | hint-details | hint-rename
  failures     error-geocode | error-marine-ie | error-open-meteo | error-surge | error-source
"""

import argparse
import base64
import datetime as dt
import io
import json
import os
import sys
import time

import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

# Charts are optional: the script still writes the HTML + JSON without them, so
# a machine without pandas/matplotlib still produces a usable report. The
# imports are attempted once, here, and the flags gate the chart code.
try:
    import pandas as pd

    HAVE_PANDAS = True
except Exception:
    HAVE_PANDAS = False

try:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    HAVE_MPL = True
except Exception:
    HAVE_MPL = False


# ---------------------------------------------------------------------------
# .env.sh auto-loading
# ---------------------------------------------------------------------------

def load_dotenv_sh():
    """Load environment variables from .env.sh in the project root (if present).
    Only sets vars that aren't already in the environment.

    Returns the names of variables defined in .env.sh but skipped because the
    environment already had a different value (the environment wins).
    """
    shadowed = []
    env_file = os.path.join(PROJECT_ROOT, ".env.sh")
    if not os.path.exists(env_file):
        return shadowed
    with open(env_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:]
            if "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if not key:
                continue
            if key not in os.environ:
                os.environ[key] = val
            elif os.environ[key] != val:
                shadowed.append(key)
    return shadowed


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

def get_api_base(site):
    """Build the API base URL from a site identifier."""
    if site.startswith("http://") or site.startswith("https://"):
        return site.rstrip("/") + "/api/v0"
    return f"https://{site}.goatcounter.com/api/v0"


API_ATTEMPTS = 3   # total attempts per request (1 = no retries)
API_BACKOFF = 1.5  # seconds before the first retry; doubles each attempt


def _is_json_response(resp):
    """True if the response looks like JSON (per Content-Type or body)."""
    ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if ctype in ("application/json", "text/json") or ctype.endswith("+json"):
        return True
    body = (resp.text or "").lstrip()
    return body.startswith("{") or body.startswith("[")


def _body_snippet(resp, limit=200):
    """Collapsed first `limit` characters of the response body."""
    body = " ".join((resp.text or "").split())
    return body[:limit] + ("…" if len(body) > limit else "")


def _is_retryable(status):
    """Transient HTTP statuses worth retrying."""
    return status in (404, 408, 425, 429) or status >= 500


def _describe_failure(url, resp):
    """Explanatory message for a failed API call."""
    ctype = resp.headers.get("Content-Type") or "unknown content type"
    if not _is_json_response(resp):
        return (
            f"API error ({resp.status_code}) for {url}: GoatCounter returned {ctype} "
            f"instead of JSON, so the request did not reach the API: {_body_snippet(resp)}"
        )
    try:
        detail = json.dumps(resp.json())
    except Exception:
        detail = _body_snippet(resp)
    return f"API error ({resp.status_code}) for {url}: {detail}"


def api_get(api_base, path, params=None, timeout=60, attempts=API_ATTEMPTS):
    """Authenticated GET against the GoatCounter API. Returns parsed JSON.

    Auth failures (401/403) raise immediately. Transient failures — connection
    errors, 404/408/425/429, 5xx, and non-JSON replies — are retried with
    exponential backoff before giving up with a readable message.
    """
    token = os.getenv("GOATCOUNTER_API_TOKEN")
    if not token:
        raise RuntimeError(
            "GOATCOUNTER_API_TOKEN not set. Source .env.sh or set the env var before running."
        )
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    url = f"{api_base}/{path.lstrip('/')}"

    for attempt in range(1, attempts + 1):
        error = None
        retryable = True
        try:
            resp = requests.get(url, headers=headers, params=params, timeout=timeout)
        except requests.RequestException as e:
            error = f"{type(e).__name__} for {url}: {e}"
        else:
            if resp.status_code in (401, 403):
                raise RuntimeError(
                    f"Auth error ({resp.status_code}) for {url}. Check GOATCOUNTER_API_TOKEN."
                )
            if resp.ok and _is_json_response(resp):
                return resp.json()
            error = _describe_failure(url, resp)
            retryable = _is_retryable(resp.status_code) or (resp.ok and not _is_json_response(resp))

        if not retryable or attempt == attempts:
            raise RuntimeError(error)

        delay = API_BACKOFF * (2 ** (attempt - 1))
        print(f"  ⚠ {error}")
        print(f"    retrying in {delay:.1f}s (attempt {attempt + 1} of {attempts}) ...")
        time.sleep(delay)


def fetch_stats_data(site, start, end):
    """Fetch the stats this report reads. Returns a dict of API responses."""
    api_base = get_api_base(site)

    def _to_datetime(d, default_time):
        return f"{d}T{default_time}Z" if "T" not in d else d

    params = {"start": _to_datetime(start, "00:00:00"), "end": _to_datetime(end, "23:59:59")}
    hits_params = {**params, "limit": 200}

    total = api_get(api_base, "stats/total", params)
    hits = api_get(api_base, "stats/hits", hits_params)

    # Optional breakdowns (best-effort — a missing one is not a failure).
    browsers = systems = locations = refs = None
    try:
        browsers = api_get(api_base, "stats/browsers", params)
    except Exception:
        pass
    try:
        systems = api_get(api_base, "stats/systems", params)
    except Exception:
        pass
    try:
        locations = api_get(api_base, "stats/locations", params)
    except Exception:
        pass
    try:
        refs = api_get(api_base, "stats/toprefs", params)
    except Exception:
        pass

    return {
        "total": total,
        "hits": hits,
        "browsers": browsers,
        "systems": systems,
        "locations": locations,
        "refs": refs,
    }


# ---------------------------------------------------------------------------
# Period parsing
# ---------------------------------------------------------------------------

def parse_period(period):
    """Return (start, end) ISO date strings for a friendly period phrase.

    Accepts: today, yesterday, this week, last week, this month, last month,
    this year, last year; a single date YYYY-MM-DD; or a range
    YYYY-MM-DD:YYYY-MM-DD.
    """
    if not period:
        return None
    s = period.strip().lower()
    if ":" in s:
        parts = s.split(":")
        if len(parts) == 2:
            try:
                start = dt.datetime.strptime(parts[0].strip(), "%Y-%m-%d").date()
                end = dt.datetime.strptime(parts[1].strip(), "%Y-%m-%d").date()
                return (start.isoformat(), end.isoformat())
            except Exception:
                raise ValueError("Invalid explicit range. Use YYYY-MM-DD:YYYY-MM-DD")
    today = dt.date.today()
    if s == "today":
        return (today.isoformat(), today.isoformat())
    if s == "yesterday":
        d = today - dt.timedelta(days=1)
        return (d.isoformat(), d.isoformat())
    if s in ("this week", "current week", "week"):
        start = today - dt.timedelta(days=today.weekday())
        return (start.isoformat(), today.isoformat())
    if s in ("last week", "previous week"):
        start = today - dt.timedelta(days=today.weekday() + 7)
        end = start + dt.timedelta(days=6)
        return (start.isoformat(), end.isoformat())
    if s in ("this month", "month"):
        start = today.replace(day=1)
        return (start.isoformat(), today.isoformat())
    if s in ("last month", "previous month"):
        first_of_this = today.replace(day=1)
        last_month_end = first_of_this - dt.timedelta(days=1)
        start = last_month_end.replace(day=1)
        return (start.isoformat(), last_month_end.isoformat())
    if s in ("this year", "year"):
        start = today.replace(month=1, day=1)
        return (start.isoformat(), today.isoformat())
    if s in ("last year", "previous year"):
        start = today.replace(year=today.year - 1, month=1, day=1)
        end = today.replace(year=today.year - 1, month=12, day=31)
        return (start.isoformat(), end.isoformat())
    try:
        single = dt.datetime.strptime(s, "%Y-%m-%d").date()
        return (single.isoformat(), single.isoformat())
    except Exception:
        raise ValueError(f"Unrecognized period: '{period}'")


# ---------------------------------------------------------------------------
# Report building — the Gealach KPIs
# ---------------------------------------------------------------------------

# Events are grouped into the questions a reader of this report actually asks:
# did people find the place, did the tide answer, did a source fail, did they
# come back. Anything not listed falls into its own "other" bucket.

ENTRY_EVENTS = ("search-name", "search-coords", "search-geolocate", "search-map")
GEOCODE_EVENTS = ("geocode-fallback-photon", "geocode-ambiguous")
SOURCE_EVENTS = ("source-marine-ie", "source-open-meteo")
DISTANCE_EVENTS = ("distance-local", "distance-warned", "distance-global")
SURGE_EVENTS = ("surge-shown", "surge-none")
SWITCH_EVENTS = ("switch-marine", "switch-openmeteo", "datum-lat", "datum-odm")
ENGAGEMENT_EVENTS = (
    "details-open", "map-open", "station-jump", "title-reset",
    "favourite-add", "favourite-open", "favourite-rename", "favourite-remove",
    "favourite-map", "install-shown", "installed",
)
HINT_EVENTS = (
    "hint-search", "hint-jump", "hint-map-tap", "hint-heart",
    "hint-details", "hint-rename",
)
FAILURE_EVENTS = (
    "error-geocode", "error-marine-ie", "error-open-meteo",
    "error-surge", "error-source",
)


def _count_map(hits_list, keys):
    """{key: count} for the given keys, in the given order."""
    by_path = {h.get("path", ""): h.get("count", 0) for h in hits_list}
    return {k: by_path.get(k, 0) for k in keys}


def build_report(site, start, end, data):
    """Turn the raw stats responses into the structured report dict."""
    total = data["total"]
    hits_list = data["hits"].get("hits", [])

    pages = [h for h in hits_list if not h.get("event")]
    events = [h for h in hits_list if h.get("event")]

    daily = [{"day": s["day"], "visitors": s.get("daily", 0)} for s in total.get("stats", [])]

    top_events = sorted(
        ({"event_type": e.get("path", ""), "cnt": e.get("count", 0)} for e in events),
        key=lambda x: x["cnt"],
        reverse=True,
    )
    top_pages = sorted(
        ({"path": p.get("path", ""), "cnt": p.get("count", 0)} for p in pages),
        key=lambda x: x["cnt"],
        reverse=True,
    )

    entry = _count_map(events, ENTRY_EVENTS)
    source = _count_map(events, SOURCE_EVENTS)
    distance = _count_map(events, DISTANCE_EVENTS)
    failures = _count_map(events, FAILURE_EVENTS)
    hints = _count_map(events, HINT_EVENTS)
    engagement = _count_map(events, ENGAGEMENT_EVENTS)
    switch = _count_map(events, SWITCH_EVENTS)
    surge = _count_map(events, SURGE_EVENTS)
    geocode = _count_map(events, GEOCODE_EVENTS)

    # The primary answer came from an Irish gauge or from the global model.
    # "fallback" is the subset of global-model answers where the Marine
    # Institute was tried and failed — the number that tracks its reliability.
    irish = source["source-marine-ie"]
    global_model = source["source-open-meteo"]
    fallback = _count_map(events, ("source-fallback-open-meteo",))["source-fallback-open-meteo"]

    searches = sum(entry.values())
    # A search "landed" if a tide was then read for a point.
    answers = irish + global_model

    metrics = {
        "visitors": total.get("total", 0),
        "events": total.get("total_events", 0),
        "pageviews": total.get("total", 0) - total.get("total_events", 0),
        "searches": searches,
        "answers": answers,
        "irish": irish,
        "global_model": global_model,
        "fallback": fallback,
        "errors_marine_ie": failures["error-marine-ie"],
        "errors_total": sum(failures.values()),
        "favourites_added": engagement["favourite-add"],
        "favourites_opened": engagement["favourite-open"],
        "stations_jumped": engagement["station-jump"],
        "map_taps": entry["search-map"],
    }

    report = {
        "site": site,
        "period": {"start": start, "end": end},
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "generated_by": "report/goatcounter-report.py",
        "metrics": metrics,
        "daily": daily,
        "entry": entry,
        "geocode": geocode,
        "source": source,
        "distance": distance,
        "surge": surge,
        "switches": switch,
        "engagement": engagement,
        "hints": hints,
        "failures": failures,
        "top_events": top_events,
        "top_pages": top_pages,
    }

    for key, label in (("browsers", "browsers"), ("systems", "systems"),
                       ("locations", "locations")):
        if data.get(key):
            report[label] = data[key].get("stats", [])
    if data.get("refs"):
        report["referrers"] = data["refs"].get("stats", [])

    return report


def percent(part, whole):
    return round(100.0 * part / whole, 1) if whole else 0.0


def short_summary(report):
    m = report["metrics"]
    return (
        f"Period {report['period']['start']} → {report['period']['end']}: "
        f"visitors={m['visitors']}, events={m['events']}, "
        f"searches={m['searches']}, answers={m['answers']} "
        f"({m['irish']} Irish / {m['global_model']} global), "
        f"marine-ie errors={m['errors_marine_ie']}"
    )


# ---------------------------------------------------------------------------
# Chart helpers
# ---------------------------------------------------------------------------

def fig_to_base64(fig, charts_dir, name):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", dpi=150)
    plt.close(fig)
    buf.seek(0)
    png = buf.read()
    with open(os.path.join(charts_dir, name), "wb") as f:
        f.write(png)
    return base64.b64encode(png).decode("ascii")


def _chart_daily(report, charts_dir):
    if not (HAVE_PANDAS and HAVE_MPL) or not report["daily"]:
        return None
    df = pd.DataFrame(report["daily"])
    df["day"] = pd.to_datetime(df["day"])
    fig, ax = plt.subplots(figsize=(10, 4))
    ax.bar(df["day"], df["visitors"], color="#0b6bcb", width=0.7)
    ax.set_title(f"Visitors per day ({report['period']['start']} → {report['period']['end']})")
    ax.set_xlabel("Day")
    ax.set_ylabel("Visitors")
    ax.margins(x=0.02)
    fig.tight_layout()
    return fig_to_base64(fig, charts_dir, "daily-visitors.png")


def _chart_source_split(report, charts_dir):
    """Irish stations vs the global model — the app's central distinction."""
    if not HAVE_MPL:
        return None
    m = report["metrics"]
    if m["irish"] + m["global_model"] == 0:
        return None
    labels = ["Irish stations", "Global model"]
    sizes = [m["irish"], m["global_model"]]
    colors = ["#166534", "#b45309"]
    fig, ax = plt.subplots(figsize=(5.5, 5.5))
    wedges, _, autotexts = ax.pie(
        sizes, labels=None, autopct=lambda p: f"{p:.0f}%" if p else "",
        startangle=90, colors=colors,
        textprops=dict(color="white", fontsize=12, weight="bold"),
    )
    ax.legend(wedges, [f"{l} ({s:,})" for l, s in zip(labels, sizes)],
              loc="center left", bbox_to_anchor=(0.95, 0, 0.5, 1), frameon=False)
    ax.set_title("Where the tide came from")
    fig.tight_layout()
    return fig_to_base64(fig, charts_dir, "source-split.png")


def _chart_distance(report, charts_dir):
    d = report["distance"]
    if not HAVE_MPL or sum(d.values()) == 0:
        return None
    labels = ["Local (<25 km)", "Warned (25–100 km)", "Global (>100 km)"]
    sizes = [d["distance-local"], d["distance-warned"], d["distance-global"]]
    fig, ax = plt.subplots(figsize=(8, 3.2))
    bars = ax.barh(labels, sizes, color=["#166534", "#b45309", "#b91c1c"])
    ax.invert_yaxis()
    ax.set_title("How close the answering station was")
    ax.set_xlabel("Readings")
    for b, v in zip(bars, sizes):
        ax.text(b.get_width(), b.get_y() + b.get_height() / 2, f"  {v:,}", va="center", fontsize=9)
    fig.tight_layout()
    return fig_to_base64(fig, charts_dir, "distance.png")


def _chart_failures(report, charts_dir):
    f = report["failures"]
    if not HAVE_MPL or sum(f.values()) == 0:
        return None
    labels = list(f.keys())
    sizes = [f[k] for k in labels]
    fig, ax = plt.subplots(figsize=(8, 3.6))
    bars = ax.barh(labels, sizes, color="#b91c1c")
    ax.invert_yaxis()
    ax.set_title("Source and request failures (by API)")
    ax.set_xlabel("Failures")
    for b, v in zip(bars, sizes):
        ax.text(b.get_width(), b.get_y() + b.get_height() / 2, f"  {v:,}", va="center", fontsize=9)
    fig.tight_layout()
    return fig_to_base64(fig, charts_dir, "failures.png")


def _chart_engagement(report, charts_dir):
    """The gestures that mean the reader got somewhere."""
    if not HAVE_MPL:
        return None
    e = report["engagement"]
    entry = report["entry"]
    rows = [
        ("Searches", report["metrics"]["searches"]),
        ("Map taps", entry["search-map"]),
        ("Locate-me", entry["search-geolocate"]),
        ("Station jumps", e["station-jump"]),
        ("Details opened", e["details-open"]),
        ("Favourites added", e["favourite-add"]),
        ("Favourites opened", e["favourite-open"]),
        ("Title reset", e["title-reset"]),
    ]
    rows = [(l, v) for l, v in rows if v]
    if not rows:
        return None
    labels = [r[0] for r in rows]
    sizes = [r[1] for r in rows]
    fig, ax = plt.subplots(figsize=(8, 0.5 * len(rows) + 1.5))
    bars = ax.barh(labels, sizes, color="#0b6bcb")
    ax.invert_yaxis()
    ax.set_title("Engagement")
    ax.set_xlabel("Count")
    for b, v in zip(bars, sizes):
        ax.text(b.get_width(), b.get_y() + b.get_height() / 2, f"  {v:,}", va="center", fontsize=9)
    fig.tight_layout()
    return fig_to_base64(fig, charts_dir, "engagement.png")


# ---------------------------------------------------------------------------
# HTML
# ---------------------------------------------------------------------------

def _esc(s):
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _metric_card(value, label, hint=""):
    tip = f'<div class="hint">{_esc(hint)}</div>' if hint else ""
    return (
        f'<div class="metric-card"><div class="value">{value}</div>'
        f'<div class="label">{_esc(label)}</div>{tip}</div>'
    )


def _img_section(title, b64, note=""):
    if not b64:
        return ""
    note_html = f'<p class="note">{_esc(note)}</p>' if note else ""
    return (
        f'<section class="card"><h2>{_esc(title)}</h2>{note_html}'
        f'<img src="data:image/png;base64,{b64}" alt="{_esc(title)}"></section>'
    )


def _table_section(title, rows, col_a, col_b, limit=None, note=""):
    """rows: a dict {label: count}, or a list of (label, count) pairs."""
    if isinstance(rows, dict):
        rows = list(rows.items())
    rows = [(str(a), b) for a, b in rows if b]
    if not rows:
        return ""
    if limit:
        rows = rows[:limit]
    note_html = f'<p class="note">{_esc(note)}</p>' if note else ""
    body = "".join(
        f"<tr><td>{_esc(a)}</td><td>{b:,}</td></tr>" for a, b in rows
    )
    return (
        f'<section class="card"><h2>{_esc(title)}</h2>{note_html}<table>'
        f"<tr><th>{_esc(col_a)}</th><th>{_esc(col_b)}</th></tr>"
        f"{body}</table></section>"
    )


STYLE = """
:root {
  --bg: #f5f6f8; --card: #ffffff; --fg: #1b1e24; --muted: #5c6470;
  --border: #dde1e7; --accent: #0b6bcb; --ok: #166534; --warn: #b45309;
  --bad: #b91c1c; --moon-lit: #b8860b; --radius: 14px;
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.container { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
header {
  border-bottom: 1px solid var(--border); padding-bottom: 1rem; margin-bottom: 1.5rem;
}
header h1 { margin: 0 0 0.25rem; font-size: 1.6rem; }
header .sub { color: var(--muted); font-size: 0.9rem; }
header .quote {
  font-family: Georgia, 'Times New Roman', serif; font-style: italic;
  color: var(--moon-lit); margin-top: 0.6rem; font-size: 0.95rem;
}
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.75rem; margin-bottom: 1.5rem; }
.metric-card { background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1rem 1.1rem; }
.metric-card .value { font-size: 1.9rem; font-weight: 700; line-height: 1.1;
  color: var(--accent); font-variant-numeric: tabular-nums; }
.metric-card .label { font-size: 0.78rem; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--muted); margin-top: 0.35rem; }
.metric-card .hint { font-size: 0.75rem; color: var(--muted); margin-top: 0.3rem; }
.metric-card.good .value { color: var(--ok); }
.metric-card.warn .value { color: var(--warn); }
.metric-card.bad .value { color: var(--bad); }
.card { background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.25rem; margin-bottom: 1.25rem; }
.card h2 { margin: 0 0 0.75rem; font-size: 1.1rem; }
.card .note { color: var(--muted); font-size: 0.85rem; margin: -0.4rem 0 0.8rem; }
.card img { max-width: 100%; height: auto; border-radius: 6px; display: block; }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-size: 0.75rem; text-transform: uppercase;
  letter-spacing: 0.04em; font-weight: 600; }
td:last-child, th:last-child { text-align: right; font-variant-numeric: tabular-nums; }
tr:last-child td { border-bottom: 0; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
@media (max-width: 40rem) { .grid2 { grid-template-columns: 1fr; } }
footer { color: var(--muted); font-size: 0.8rem; text-align: center; margin-top: 2rem; }
footer a { color: var(--accent); }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1115; --card: #181b21; --fg: #e7e9ee; --muted: #9aa2ae;
    --border: #2a303b; --accent: #5aa7ff; --ok: #4ade80; --warn: #fbbf24;
    --bad: #f87171; --moon-lit: #f0c75e; }
}
"""


def generate_html(report, charts, out_dir):
    m = report["metrics"]
    period = report["period"]

    header = (
        "<header>"
        "<h1>Gealach — GoatCounter report</h1>"
        f'<div class="sub">Site <strong>{_esc(report["site"])}</strong> · '
        f'period {_esc(period["start"])} → {_esc(period["end"])} · '
        f'generated {_esc(report["generated_at"])}</div>'
        '<div class="quote">&ldquo;And the moon goad the waters night and day&rdquo; '
        "— W. B. Yeats</div>"
        "</header>"
    )

    cards = "".join([
        _metric_card(f"{m['visitors']:,}", "Visitors"),
        _metric_card(f"{m['events']:,}", "Events"),
        _metric_card(f"{m['searches']:,}", "Searches"),
        _metric_card(f"{m['answers']:,}", "Tides read"),
        _metric_card(
            f"{percent(m['irish'], m['answers'])}%", "From Irish stations",
            hint=f"{m['irish']:,} of {m['answers']:,}",
        ),
        _metric_card(
            f"{m['fallback']:,}", "Global fallbacks",
            hint="Marine Institute unreachable",
        ),
        _metric_card(
            f"{m['errors_marine_ie']:,}", "Marine-ie errors",
            hint="counted per API, affected or not",
        ),
        _metric_card(
            f"{m['errors_total']:,}", "All source errors",
        ),
    ])

    # Charts
    chart_html = "".join([
        _img_section("Visitors per day", charts.get("daily")),
        _img_section(
            "Where the tide came from", charts.get("source"),
            "The app's central distinction: an Irish gauge prediction, or the "
            "coarser global model with a visible warning.",
        ),
        _img_section("How close the answering station was", charts.get("distance")),
        _img_section("Engagement", charts.get("engagement")),
        _img_section(
            "Source and request failures", charts.get("failures"),
            "Counted whether or not the reader was affected — a pattern here "
            "is the Marine Institute's own reliability.",
        ),
    ])

    # Detail tables
    def _kv(mapping):
        return list(mapping.items())

    tables = "".join([
        _table_section("Entry", _kv(report["entry"]), "Event", "Count",
                       note="How a point was chosen."),
        _table_section("Source", _kv(report["source"]), "Event", "Count",
                       note="Which provider answered the tide."),
        _table_section("Distance", _kv(report["distance"]), "Event", "Count",
                       note="How far the answering station was."),
        _table_section("Surge & switches", {**report["surge"], **report["switches"]},
                       "Event", "Count"),
        _table_section("Engagement", _kv(report["engagement"]), "Event", "Count"),
        _table_section("First-run hints", _kv(report["hints"]), "Hint", "Shown",
                       note="The onboarding experiment — judge whether it earns its keep."),
        _table_section("Failures", _kv(report["failures"]), "Event", "Count"),
        _table_section("Geocoding", _kv(report["geocode"]), "Event", "Count"),
    ])

    audience = ""
    if report.get("browsers") or report.get("systems") or report.get("locations"):
        parts = []
        for key, title in (("browsers", "Browsers"), ("systems", "Systems"),
                           ("locations", "Countries")):
            rows = [(r.get("name", r.get("id", "?")), r.get("count", 0))
                    for r in report.get(key, [])]
            parts.append(_table_section(title, rows, title[:-1] if title.endswith("s") else title, "Count"))
        audience = f'<div class="grid2">{"".join(parts)}</div>'

    top = ""
    if report.get("top_events"):
        top += _table_section(
            "Top events", [(e["event_type"], e["cnt"]) for e in report["top_events"]],
            "Event", "Count", limit=30,
        )
    if report.get("top_pages"):
        top += _table_section(
            "Top pages", [(p["path"] or "/", p["cnt"]) for p in report["top_pages"]],
            "Path", "Visitors", limit=15,
        )

    html = (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        "<title>Gealach — GoatCounter report</title>"
        f"<style>{STYLE}</style></head><body><div class='container'>"
        f"{header}"
        f"<div class='metrics'>{cards}</div>"
        f"{chart_html}"
        f"{tables}"
        f"{audience}"
        f"{top}"
        "<footer>Generated by <code>report/goatcounter-report.py</code>. "
        "GoatCounter: no cookies, no personal data.</footer>"
        "</div></body></html>"
    )

    out_html = os.path.join(out_dir, "index.html")
    with open(out_html, "w", encoding="utf-8") as f:
        f.write(html)
    return out_html


def generate_report(report, out_dir):
    charts_dir = os.path.join(out_dir, "charts")
    os.makedirs(charts_dir, exist_ok=True)

    charts = {
        "daily": _chart_daily(report, charts_dir),
        "source": _chart_source_split(report, charts_dir),
        "distance": _chart_distance(report, charts_dir),
        "engagement": _chart_engagement(report, charts_dir),
        "failures": _chart_failures(report, charts_dir),
    }
    html_path = generate_html(report, charts, out_dir)
    return html_path, charts


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    shadowed = load_dotenv_sh()
    if shadowed:
        print("⚠ Values already set in the environment override .env.sh; ignoring:")
        for key in shadowed:
            print(f"    {key} — unset it or run with `env -u {key} ...` to use .env.sh")
        print()

    parser = argparse.ArgumentParser(
        description="Generate a Gealach GoatCounter report with charts.",
    )
    parser.add_argument(
        "--site",
        default=os.getenv("GOAT_SITE", "https://gealach.goatcounter.com/"),
        help="GoatCounter site code (e.g. gealach) or full URL",
    )
    parser.add_argument("--start", help="Start date YYYY-MM-DD (default: today)")
    parser.add_argument("--end", help="End date YYYY-MM-DD (default: today)")
    parser.add_argument(
        "--period",
        help=(
            "Friendly period: today, yesterday, this week, last week, this month, "
            "last month, this year, last year. Overrides --start/--end."
        ),
    )
    parser.add_argument(
        "--out", help="Output directory (default: reports/<timestamp>_<start>_<end>)"
    )
    args = parser.parse_args()

    if args.period:
        try:
            se = parse_period(args.period)
        except Exception as e:
            print(f"Error parsing --period: {e}", file=sys.stderr)
            sys.exit(2)
        args.start, args.end = se

    def _validate(label, val):
        if not val:
            return None
        try:
            return dt.datetime.strptime(val, "%Y-%m-%d").date()
        except ValueError:
            print(f"Invalid --{label} date '{val}'. Expected YYYY-MM-DD.", file=sys.stderr)
            sys.exit(2)

    start_date = _validate("start", args.start) or _validate("start", os.getenv("GOAT_START"))
    end_date = _validate("end", args.end) or _validate("end", os.getenv("GOAT_END"))
    today = dt.date.today()
    start_date = start_date or today
    end_date = end_date or today
    args.start, args.end = start_date.isoformat(), end_date.isoformat()

    print(f"Fetching stats for {args.site}: {args.start} → {args.end} ...")
    data = fetch_stats_data(args.site, args.start, args.end)
    report = build_report(args.site, args.start, args.end, data)

    if args.out:
        out_dir = os.path.abspath(args.out)
    else:
        timestamp = dt.datetime.now().strftime("%Y-%m-%dT%H%M%S")
        out_dir = os.path.join(PROJECT_ROOT, "reports", f"{timestamp}_{args.start}_{args.end}")
    os.makedirs(out_dir, exist_ok=True)

    with open(os.path.join(out_dir, "data.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print(short_summary(report))
    if not (HAVE_PANDAS and HAVE_MPL):
        print("  note: pandas/matplotlib not available — writing HTML without charts")

    html_path, charts = generate_report(report, out_dir)
    made = [k for k, v in charts.items() if v]
    print(f"Report saved to: {out_dir}/")
    print("  index.html  (self-contained)")
    print("  data.json   (raw data)")
    print(f"  charts/     ({', '.join(made) if made else 'none'})")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
