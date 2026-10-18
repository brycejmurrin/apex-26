// LiveryCrests: the team-mark painters of LiveryTex (traced, Mercedes, Haas, Audi,
// generic) and the CRESTS table. Ported verbatim from f1-game js/car/crest-draw.js:1-268.
// create(d) closes over the atlas module's helpers and constants exactly as the
// original does; ./liverytex.ts destructures the result.
//
// Deviation: tracePath's no-progress guard logged through f1-game's Log global
// (crest-draw.js:56) before breaking; the break is kept, the log line is dropped.
import type { CrestSpec } from "./crest-paths";
import type { LiveryColour, LiveryCtx2D, LiveryFit, LiveryRect } from "./livery-canvas";

/** The colours a crest paints (markPalette's result, crest-draw.js:141-145). */
export interface CrestPalette {
  mark: LiveryColour;
  alt: LiveryColour;
  plate: LiveryColour | null;
  part: LiveryColour | null;
}

/** drawWordmark's options (liverytex.js:185-188). */
export interface WordmarkOpts {
  pad?: number;
  spacing?: number;
  align?: string;
  halo?: LiveryColour | null;
}

/** The slice of a Legends entry the crest path reads. */
export interface CrestLegend {
  car?: string | null | undefined;
  marque?: string | null | undefined;
}

export interface CrestDisc { cx: number; cy: number; r: number }

/** What create() closes over (crest-draw.js:7). */
export interface CrestDeps {
  css(c: LiveryColour): string;
  fit(R: LiveryRect, margin?: number | null): LiveryFit;
  drawWordmark(ctx: LiveryCtx2D, text: string, R: LiveryRect, ink: LiveryColour, opts?: WordmarkOpts): void;
  teamShort(id: string | null | undefined): string;
  crestSpecFor(teamId: string | null | undefined): CrestSpec | false | undefined;
  crestKey(teamId: string | null | undefined): string;
  legendOf(teamId: string | null | undefined): CrestLegend | null | undefined;
  CREST_DISC: Readonly<Record<string, CrestDisc>>;
  CREST_MARGIN: number;
  STROKE_MIN: number;
  TEXT_MIN: number;
}

/** A team-mark painter: every one takes the same five arguments (crest-draw.js:127-133). */
export type CrestFn = (ctx: LiveryCtx2D, R: LiveryRect, P: CrestPalette, bare: boolean, teamId: string | null | undefined) => void;

export function create(d: CrestDeps) {
  const { css, fit, drawWordmark, teamShort, crestSpecFor, crestKey, legendOf, CREST_DISC, CREST_MARGIN, STROKE_MIN } = d;

  // Narrowest limb any crest may draw. Every stroke goes through this, so the
  // 34 px worst case is enforced by construction rather than by review.
  const swMin = (f: LiveryFit, k: number) => f.S(Math.max(STROKE_MIN, k));

  // ── traced marks ───────────────────────────────────────────────────────────
  // Eight of the eleven marks are path data in ./crest-paths, traced
  // from bitmaps (tools/car/trace-logo.mjs). Hand-drawn from memory as chained
  // canvas calls, Red Bull's two charging bulls come out as a pair of pigs and
  // Aston's spread wings as three chevrons. A silhouette is data.
  //
  // Only M, L and Z — the tracer emits polylines, because a contour walked at
  // 384 px and simplified to a few tenths of a percent is already smoother than
  // a curve anyone would fit to it, and a straight-line path needs no curve
  // support here or in the offline rasteriser that measures these.
  function tracePath(ctx: LiveryCtx2D, f: LiveryFit, d: string): void {
    let i = 0, cmd = "";
    const num = () => {
      while (i < d.length && (d[i] === " " || d[i] === ",")) i++;
      const st = i;
      while (i < d.length && "-+.0123456789eE".indexOf(d[i]!) >= 0) i++;
      return parseFloat(d.slice(st, i));
    };
    ctx.beginPath();
    // EVERY ITERATION MUST CONSUME A CHARACTER. Two branches here could spin
    // forever on input this parser does not handle, and an infinite loop in a
    // livery build is the worst failure shape the game has: the tab locks with
    // no exception, no crash strike and no webglcontextlost, because the OS
    // watchdog takes the whole process.
    //
    //   "M0 0L1 1Z\n"        spins at the newline
    //   "M0 0L1 1z"          spins at a LOWERCASE command
    //   "M0 0L1 1Zm2 2l3 3z" spins at the relative moveto
    //
    // `Z` continued before any i++, so anything after a close that was not an
    // uppercase letter looped; and num() returns parseFloat("") = NaN having
    // consumed NOTHING when it meets a character outside its set.
    let guard = d.length * 4 + 16;   // no legal path needs four passes per char
    while (i < d.length) {
      if (guard-- <= 0) break;   // f1-game logs "tracePath: no progress" here (dropped)
      const c = d[i]!;
      if (c === " " || c === ",") { i++; continue; }
      if (c >= "A" && c <= "Z") { cmd = c; i++; }
      else if (!(c >= "0" && c <= "9") && "-+.".indexOf(c) < 0) { i++; continue; }   // lowercase / unknown: skip it
      if (cmd === "Z") { ctx.closePath(); cmd = ""; continue; }
      const before = i;
      const x = num(), y = num();
      if (i === before) { i++; continue; }              // num() consumed nothing
      if (!isFinite(x) || !isFinite(y)) continue;
      if (cmd === "M") { ctx.moveTo(f.X(x), f.Y(y)); cmd = "L"; }
      else ctx.lineTo(f.X(x), f.Y(y));
    }
  }

  // One crest function for every traced mark. Layers paint back to front and
  // each takes the palette colour its role names. A plate the badge keeps
  // (Ferrari's shield, Red Bull's sun via CREST_DISC) still paints here —
  // dropping it left a bare horse on the tail next to the full lockup on
  // the spine and the garage wall.
  function crestTraced(ctx: LiveryCtx2D, R: LiveryRect, P: CrestPalette, bare: boolean, teamId: string | null | undefined): void {
    const spec = crestSpecFor(teamId);
    if (!spec) { crestGeneric(ctx, R, P, bare, teamId); return; }
    const f = fit(R, CREST_MARGIN);
    ctx.save();
    // The authored backing, behind every traced layer. Red Bull's sun is the
    // only one: the trace could give a union silhouette or nothing, and a
    // silhouette painted gold is a rim, not a sun (see CREST_DISC).
    const disc = CREST_DISC[crestKey(teamId)];
    if (disc && P.plate) {
      ctx.fillStyle = css(P.plate);
      ctx.beginPath();
      ctx.arc(f.X(disc.cx), f.Y(disc.cy), f.S(disc.r), 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < spec.d.length; i++) {
      const role = spec.roles[i] || "mark";
      // Skip a plate layer only when the palette has no plate. Ferrari keeps
      // its shield on the badge (crestKeepsPlate); marks whose badge drops
      // the backing arrive here with P.plate already null.
      if (role === "plate" && !P.plate) continue;
      // `part` is a SAME-INK island — a shape the trace found to share no pixel
      // with the rest of its layer, like Racing Bulls' bull beside its letters.
      // Unset it IS the mark, so the crest ships pixel-identical; authored, it
      // is the one place a single-ink mark can take a second colour.
      let roleFill: LiveryColour | null = P.mark;
      if (role === "plate") roleFill = P.plate;
      else if (role === "alt") roleFill = P.alt;
      else if (role === "part") roleFill = P.part || P.mark;
      ctx.fillStyle = css(roleFill!);
      tracePath(ctx, f, spec.d[i]!);
      // evenodd, so a counter walked as its own loop punches a HOLE rather than
      // filling solid — the whole reason the bitmaps had to go.
      ctx.fill("evenodd");
    }
    ctx.restore();
  }

  // ── the eleven team marks + the custom fallback ────────────────────────────
  // Every one takes the SAME five arguments and paints only from P (see
  // markPalette): P.mark for the dominant shape, P.alt for counters, second
  // colour and lettering, P.plate for a backing shield. No baked colours except
  // the two national bands called out below, no alpha, no destination-out.
  // `bare` is the shark-fin badge: no fillText lettering (34 px cannot carry
  // a wordmark). The lockup itself — shield, disc, ring, weave, box — is the
  // same construction as the engine cover and the garage wall.

  // Mercedes — three-point star inside a ring. Two shapes, and the RING is the
  // one this mark can hand to the DETAIL row: `P.part` is same-ink-unless-
  // authored, so an unset row leaves the star and its ring in one colour, which
  // is the real mark. Drawn at every size, badge included.
  function crestMercedes(ctx: LiveryCtx2D, R: LiveryRect, P: CrestPalette): void {
    const f = fit(R, CREST_MARGIN);
    const cx = f.X(0.5), cy = f.Y(0.5), r = f.S(0.48), rin = f.S(0.39);
    ctx.save();
    ctx.fillStyle = css(P.part || P.mark);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.arc(cx, cy, rin, 0, Math.PI * 2, true);
    ctx.fill("evenodd");
    ctx.fillStyle = css(P.mark);
    // Star tips stop at 0.34, not at 0.99 of the ring's inner radius. That left
    // a 0.004 counter — right for the real mark at print size, and a filled
    // disc the moment the atlas drops to the AI tier.
    const tip = f.S(0.34), baseW = f.S(0.115);
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + i * (Math.PI * 2 / 3);
      const px = cx + Math.cos(a) * tip, py = cy + Math.sin(a) * tip;
      const bx = -Math.sin(a) * baseW, by = Math.cos(a) * baseW;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(cx + bx, cy + by);
      ctx.lineTo(cx - bx, cy - by);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath(); ctx.arc(cx, cy, f.S(0.055), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Haas — slashed H inside a ring. The ring is the lockup, on the fin too.
  function crestHaas(ctx: LiveryCtx2D, R: LiveryRect, P: CrestPalette): void {
    const f = fit(R, CREST_MARGIN);
    ctx.save();
    ctx.strokeStyle = css(P.alt);
    ctx.lineWidth = swMin(f, 0.085);
    ctx.beginPath();
    ctx.arc(f.X(0.5), f.Y(0.5), f.S(0.42), 0, Math.PI * 2);
    ctx.stroke();
    // Uprights over y 0.20..0.80 with outer edges at 0.24 and 0.76 CROSS the
    // ring: at y 0.20 its inner half-width is only 0.229 (x 0.271..0.729).
    // These bounds are the inscribed box instead —
    // corner distance 0.33 against an inner radius of 0.3775. Same box on the
    // badge: a full-height H with the ring around it is a different logo.
    const xa = 0.27, xb = 0.38;
    const y0 = 0.26, y1 = 0.74;
    ctx.fillStyle = css(P.mark);
    ctx.fillRect(f.X(xa), f.Y(y0), f.S(xb - xa), f.S(y1 - y0));            // left upright
    ctx.fillRect(f.X(1 - xb), f.Y(y0), f.S(xb - xa), f.S(y1 - y0));        // right upright
    // Slashed crossbar, anchored ON the uprights' inner edges so it joins them
    // rather than floating between them.
    // A bar this steep runs corner to corner and the letter reads as an N.
    // Keep it in the middle third with a shallow rise: 0.18 over the span, not
    // 0.33, and centred on the uprights' midline.
    const h = y0 + (y1 - y0) * 0.33, d = (y1 - y0) * 0.18, t = (y1 - y0) * 0.24;
    ctx.beginPath();
    ctx.moveTo(f.X(xb), f.Y(h));
    ctx.lineTo(f.X(1 - xb), f.Y(h + d));
    ctx.lineTo(f.X(1 - xb), f.Y(h + d + t));
    ctx.lineTo(f.X(xb), f.Y(h + t));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Audi — four interlocking rings. P.alt is unused: the auto-scored second
  // colour would repaint every shipped car. The DETAIL row lands on `P.part`
  // instead — the SECOND and FOURTH rings — which is same-ink until the player
  // authors it, so an unset row still draws the four-ring mark it always did.
  function crestAudi(ctx: LiveryCtx2D, R: LiveryRect, P: CrestPalette): void {
    const f = fit(R, CREST_MARGIN);
    ctx.save();
    const inkFor = (i: number) => css(i % 2 ? (P.part || P.mark) : P.mark);
    // r 0.135 is the MAXIMUM four rings fit in a unit box at the real ~1.62 r
    // pitch (6.815r + w <= 1); r 0.17 at a 0.20 pitch uses 26% of the box
    // and buries the weave. This lockup is inherently ~3.6:1, so it is the
    // one mark that cannot fill a square box vertically — a written exception,
    // not an oversight.
    const r = f.S(0.135), cy = f.Y(0.5), xs = [0.16, 0.3767, 0.5933, 0.81] as const;
    ctx.lineWidth = swMin(f, 0.075);
    const ring = (i: number) => {
      ctx.strokeStyle = inkFor(i);
      ctx.beginPath();
      ctx.arc(f.X(xs[i]!), cy, r, 0, Math.PI * 2);
      ctx.stroke();
    };
    for (let i = 0; i < 4; i++) ring(i);
    // Weave: re-stroke the OVER ring inside each overlap, alternating which one
    // that is. Four independent arcs lie flat on each other and never interlock.
    // Same weave on the badge — a flat four-ring is a different logo.
    for (let i = 0; i < 3; i++) {
      const mid = (xs[i]! + xs[i + 1]!) / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(f.X(mid - 0.055), f.Y(0.30), f.S(0.11), f.S(0.40));
      ctx.clip();
      ring(i % 2 === 0 ? i + 1 : i);
      ctx.restore();
    }
    ctx.restore();
  }

  // Generic fallback — monogram of the team short code (a wordmark legend: the
  // team's name). The custom team's mark whenever it has no uploaded emblem.
  function crestGeneric(ctx: LiveryCtx2D, R: LiveryRect, P: CrestPalette, _bare: boolean, teamId: string | null | undefined): void {
    const f = fit(R, CREST_MARGIN);
    const box = { x: f.X(0.06), y: f.Y(0.22), w: f.S(0.88), h: f.S(0.56) };
    ctx.save();
    ctx.strokeStyle = css(P.alt);
    ctx.lineWidth = swMin(f, 0.055);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    const legend = legendOf(teamId);
    const label = legend && legend.car ? String(legend.car).split(" ")[0]!.toUpperCase() : teamShort(teamId);
    drawWordmark(ctx, label, box, P.mark, { align: "center", pad: f.S(0.06) });
    ctx.restore();
  }

  // The eleven marks. Eight are traced path data (./crest-paths); the
  // other three are drawn, because for those three a construction beats a trace:
  // Mercedes is a ring and a three-point star, Audi four interlocking rings, and
  // Haas an H inside a ring. Those are exact as maths, and their source bitmaps
  // were the WORST of the set — haas.png traces to a plain red disc and audi.png
  // to four filled blobs, because both had their counters filled in.
  const CRESTS: Record<string, CrestFn> = {
    mercedes: crestMercedes,
    ferrari: crestTraced,
    mclaren: crestTraced,
    redbull: crestTraced,
    alpine: crestTraced,
    racingbulls: crestTraced,
    haas: crestHaas,
    williams: crestTraced,
    audi: crestAudi,
    astonmartin: crestTraced,
    cadillac: crestTraced,
  };

  return { CRESTS, crestGeneric, tracePath };
}

/** f1-game's frozen `LiveryCrests` global (crest-draw.js:267-268). */
export const LiveryCrests = Object.freeze({ create });
