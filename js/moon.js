// js/moon.js
//
// The Moon's disc as SVG, and the eight named phases that the app and
// moon.html both draw. DOM-free and dependency-free, so it imports cleanly
// into Node and into any page — the glyph markup is a string, not a node.
//
// This is the one implementation: js/app.js uses moonGlyph() for the tide
// card, and moon.html uses it for the phase gallery. Moving the drawing here
// is what stops the two drifting apart.

const TAU = 2 * Math.PI;

/**
 * The eight phases, in order from new moon, with the point of the synodic
 * month at which each begins and the Wikipedia article that describes it.
 * `fraction` is 0 at new moon and 0.5 at full.
 */
export const MOON_PHASES = [
  {
    name: "New moon",
    irish: "Gealach nua",
    fraction: 0,
    day: "Day 0",
    wiki: "New_moon",
    blurb: "Between us and the Sun, so the lit face is turned away and nothing shows. The spring tides that follow are the sea's answer to this alignment.",
  },
  {
    name: "Waxing crescent",
    irish: "Gealach ag fás",
    fraction: 1 / 8,
    day: "Day 3.7",
    wiki: "Crescent",
    blurb: "A thin sliver of light on the right, low in the evening sky. The lit portion is growing.",
  },
  {
    name: "First quarter",
    irish: "Céad cheathrú",
    fraction: 1 / 4,
    day: "Day 7.4",
    wiki: "Lunar_phase",
    blurb: "Half lit, on the right, with a straight terminator. The range of the tide is near its smallest — neap tides.",
  },
  {
    name: "Waxing gibbous",
    irish: "Gealach ag fás",
    fraction: 3 / 8,
    day: "Day 11.1",
    wiki: "Gibbous_moon",
    blurb: "More than half lit and still growing. The Moon is up through the afternoon and evening.",
  },
  {
    name: "Full moon",
    irish: "Gealach lán",
    fraction: 1 / 2,
    day: "Day 14.8",
    wiki: "Full_moon",
    blurb: "The whole disc lit and opposite the Sun, rising as the Sun sets. The spring tides near this date are the largest of the month.",
  },
  {
    name: "Waning gibbous",
    irish: "Gealach ag dul i laige",
    fraction: 5 / 8,
    day: "Day 18.5",
    wiki: "Gibbous_moon",
    blurb: "Still more than half lit, but the lit limb has moved to the left and is shrinking.",
  },
  {
    name: "Last quarter",
    irish: "An cheathrú dheireanach",
    fraction: 3 / 4,
    day: "Day 22.2",
    wiki: "Lunar_phase",
    blurb: "Half lit, on the left, well up at dawn. Again neap tides, with a smaller range.",
  },
  {
    name: "Waning crescent",
    irish: "Gealach ag dul i laige",
    fraction: 7 / 8,
    day: "Day 25.8",
    wiki: "Crescent",
    blurb: "A thin sliver on the left before dawn, running down to the next new moon and the next spring tides.",
  },
];

/**
 * SVG markup for the Moon's disc with the lit portion filled. Only
 * `phase.fraction` is read, so a lunarPhase() result and a MOON_PHASES entry
 * are both acceptable. The colours come from the page's CSS custom
 * properties, so the glyph follows the app's theme.
 */
export function moonGlyph(phase, size = 64) {
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 3;
  const p = phase.fraction;
  // The lit portion is the disc minus a shadow circle of the same radius whose
  // centre sweeps across: at new moon it covers the disc, at full moon it has
  // moved fully off, at the quarters it covers a half. Waxing is lit on the
  // right, waning on the left (Northern-hemisphere convention).
  const d = R * (1 - Math.cos(TAU * p));
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
  while (d < 0) d += TAU;
  return d;
}

function cwDelta(a, b) {
  let d = a - b;
  while (d < 0) d += TAU;
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

/** An arc split into cubic Bézier segments, as [from, c1, c2, to] tuples. */
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
