# Derivations

Every number the interface shows is either read from a source or derived by a
pure function in `js/tide.js`. This file records the formula for each derived
number, so an inference is never presented as a measurement.

## Distance

Great-circle (haversine) distance between two points, in kilometres:

$$
d = 2R \arcsin\left(\sqrt{\sin^2\frac{\Delta\varphi}{2}
  + \cos\varphi_1\cos\varphi_2\sin^2\frac{\Delta\lambda}{2}}\right),
\quad R = 6371\ \text{km}
$$

The nearest station is the one with the smallest such distance.

## State: rising / falling, and rate

The 5-minute prediction series is a sequence of $(t_i, h_i)$ points. At a
moment $t$ bracketed by $t_i \le t < t_{i+1}$:

$$
h(t) = h_i + (h_{i+1} - h_i)\frac{t - t_i}{t_{i+1} - t_i}
\qquad
\text{rate} = \frac{h_{i+1} - h_i}{t_{i+1} - t_i}\ \text{(m/h)}
$$

The tide is *rising* when the rate is positive, *falling* when negative, and
labelled *steady* when $|\text{rate}| < 0.05\ \text{m/h}$. The rate is
datum-invariant (it is a difference quotient).

## Next turn

The next high is the first `HIGH` extreme strictly after now; the next low the
first `LOW`. Time remaining is the difference in minutes. Turn heights come
from the high/low dataset's OD Malin value, with the LAT height interpolated
from the curve where the turn falls inside the curve window.

## Springs and neaps — by inference, not the form factor

The textbook definition uses the **form factor**

$$
F = \frac{K_1 + O_1}{M_2 + S_2}
$$

from the station's harmonic constituents. Marine Institute publishes
pre-computed prediction series, not constituents, so $F$ is not available to
us without requesting the data separately. We chose not to.

What we do instead, and label as an inference:

1. For each successive HIGH/LOW pair in the extremes, take the half-tide range
   $|h_{\text{high}} - h_{\text{low}}|$, timed at the midpoint of the pair.
   (The range uses OD Malin heights where the source publishes them; a range
   is a difference, so the datum offset cancels.)
2. Compare the current range with the mean of the ranges within a rolling
   fortnight ($\pm 7$ days) of now.
3. Label it **springs** when the current range is more than 5 % above that
   mean, **neaps** when more than 5 % below, and **mid** otherwise. The 5 %
   band stops the label flapping between adjacent pairs.
4. The **next spring tide** is the date of the next local maximum of the
   half-tide range series.

This is defensible and reproducible from the data we already have, but it is
an inference about the *range*, not a calculation of the form factor.

## Source choice and distance thresholds

Two named constants decide which source answers, and how loudly the interface
warns:

- `MAX_STATION_DISTANCE_KM = 25` (`js/tide.js`) — requirement 3. A Marine
  Institute station further than this is shown with a prominent warning, never
  silently presented as local.
- `GLOBAL_MODEL_FALLBACK_KM = 100` (`js/app.js`) — a point whose nearest Irish
  station is beyond this is answered by the Open-Meteo global model instead,
  and the interface says that this is what happened. (This is the
  implementation of "outside the 38 Irish stations" — requirement 10.)

## Modelled current

The current shown is the Open-Meteo Marine grid reading nearest in time to
now, speed converted from km/h to m/s, direction kept as compass degrees and
labelled "heading towards". It is model output, and is labelled as such with
the model's resolution.

## Rounding — made once, at presentation

| Quantity | Rounding |
| --- | --- |
| Heights | 0.1 m |
| Rates | 0.1 m/h |
| Times | to the minute |
| Distances | 1 km |
| Current speed | 0.1 m/s |

Rounding happens at render time in `js/app.js`, never in the data or in the
derivations, so no value is rounded twice.

## Time: UTC in, local out

Sources speak UTC and stay UTC through the adapters and the derivations. Only
`js/app.js` converts to the location's IANA timezone (from the geocoder) with
`Intl.DateTimeFormat`, and it prints the offset and abbreviation alongside.
For a raw coordinate, where no timezone is known, times are shown in UTC and
labelled as such.

---

This file was written with an AI coding assistant.
Assisted-by: GitHub Copilot (DeepSeek V4 Pro)
