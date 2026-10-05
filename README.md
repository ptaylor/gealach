<p align="center"><img src="icons/icon-512.png" alt="taoidí icon" width="96" /></p>

# taoidí — tides

What the sea is doing at a coastal place, on a phone in a pocket: the tide's
height and state now, when it turns, what the range is, whether we are on
springs or neaps, and — where a model is available — which way the water is
running. It starts with Ireland.

**Not for navigation.** Predictions exclude storm surge (surge is shown
separately where published), and the modelled currents are model output. This
notice lives in the interface, permanently.

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

The app is already a static site at the repo root, so publishing is a version
tag plus a push. Point GitHub Pages at the `main` branch root once
(Settings → Pages → Deploy from a branch → `main`, `/(root)`), then:

```sh
./publish.sh        # tags vX.(Y+1), pushes main and the tag
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
