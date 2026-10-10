<p align="center"><img src="icons/icon-512.png" alt="Gealach icon" width="96" /></p>

# Gealach — tides

> *"And the moon goad the waters night and day"*
> — W. B. Yeats, [*The Wanderings of Oisin*](https://en.wikisource.org/wiki/The_Wanderings_of_Oisin_and_Other_Poems/The_Wanderings_of_Oisin) (1889)

What the sea is doing at a coastal place, on a phone in a pocket: the tide's
height and state now, when it turns, what the range is, whether we are on
springs or neaps, and — where a model is available — which way the water is
running. It starts with Ireland.

**Not for navigation.** Predictions exclude storm surge (surge is shown
separately where published), and the modelled currents are model output. This
notice lives in the interface, permanently.

## How to use it

- **Search** a place name or a latitude/longitude. A search *locates* the
  point — it opens the map and drops a pin; it does not load a tide.
- **Tap the map** to read the tide at that point. The tide is only ever fetched
  for a point you can see.
- If the point is inland or vague, the map card offers a **jump to the nearest
  prediction station** (still no fetch — tap the map to read it).
- **Save a spot** to your favourites with the heart. Each favourite can be
  **opened** (loads its tide), **shown on the map** (locates it, no fetch), or
  **renamed**.
- **Tap the title** to return home — the search bar (cleared) and your
  favourites — from anywhere.
- **Hold the title** (800 ms) for the about panel. A hidden developer door
  lives in the top-right corner of that panel (a 3-second hold).

The first time you reach a feature, a short hint points it out. Hints show once
per device.

## Run locally

```sh
python3 -m http.server 8000
```

then open <http://localhost:8000>. A service worker needs a secure context, so
`localhost` works for the desk but not the pocket — see below.

## Tests

```sh
npm test        # node --test, no dependencies
```

## Install on a phone

It is a PWA. Serve it over HTTPS (GitHub Pages works; `file://` and
`http://192.168.x.x` do not — a service worker needs a secure context).

- **Android / desktop**: the browser offers an install prompt.
- **iOS**: there is no install prompt. Use Share → *Add to Home Screen*.

## Publish

The app is already a static site, so publishing is a version tag plus a push
of a fixed file whitelist to the `public` branch — `main` is the working
branch and is never published directly. Point GitHub Pages at `public` once
(Settings → Pages → Deploy from a branch → `public`, `/(root)`), then:

```sh
./publish.sh        # stamps the version, tags vX.(Y+1), pushes main + tag + public
```

The site is then served at <https://ptaylor.github.io/gealach/>.

## Data sources and attribution

- **Marine Institute ERDDAP** — Irish tide predictions, high/low turns, surge
  split. CC-BY 4.0; attributed in the interface.
- **Open-Meteo Marine API** — global-model tide and modelled currents.
- **Open-Meteo Geocoding API** (GeoNames-derived) — place name → coordinates
  and timezone. CC-BY 4.0.
- **NOAA CO-OPS** — US predictions (extension).

Details, endpoints, datums and the traps that were hit live in
`docs/data-sources.md`. The formulas are in `docs/derivations.md`.

## Known limitations

- **Not for navigation.** In the interface permanently, not in a dismissible
  toast.
- **The Marine Institute is not always up.** `erddap.marine.ie` has returned
  HTTP 504 / timed out for a full day twice in a week. When it is down the app
  falls back, within 12 s, to the Open-Meteo **global** model and says
  "Outside the Irish prediction stations" — a coarser answer, honestly
  labelled, not a silent substitution.
- **The prediction excludes storm surge.** Where the Marine Institute publishes
  it, surge is shown separately so the two can be compared.
- **Springs and neaps are an inference from the predicted range**, not a form
  factor (the constituents are not published). See `docs/derivations.md`.
- **Modelled currents are model output**, at the model's resolution, not a
  measurement.

Usage is measured with **GoatCounter** — no cookies, no personal data. Custom
events are categorical only: the search string and picked coordinates never
leave the device.

## Layout

See `AGENTS.md` — the single deliberate departure from the house single-file
preference is the PWA: a service worker must be its own URL, and the two
tested modules must import into Node, so the JavaScript is three small ES
modules.

## License

MIT (see `LICENSE`). The *data* keeps its own licence (CC-BY 4.0) and is
attributed regardless of the code licence.

---

This file was written with an AI coding assistant.
Assisted-by: GitHub Copilot (DeepSeek V4 Pro)
