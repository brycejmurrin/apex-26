// Cover crown/tail and fin graphic painters for LiveryTex. Ported verbatim from
// f1-game js/car/livery-graphics.js:1-505: create(context) receives the atlas's
// drawing and paint-selection helpers (liverytex.js:1472-1475) and returns
// { drawSpineTop, drawTailTop, drawTailGraphic }.
import type { LiveryColour, LiveryCtx2D, LiveryRect } from "./livery-canvas";
import type { WordmarkOpts } from "./crest-draw";

/** The livery fields these painters read (`colors.*`). */
export interface GraphicsLivery {
  spineTint?: LiveryColour | null | undefined;
  saddleTint?: LiveryColour | null | undefined;
  spineLogo?: string | null | undefined;
  coverBind?: string | null | undefined;
}

/** bandTrim's three rules (livery-graphics.js:25-31). */
export interface BandTrim {
  a(a: number): number;
  w(w: number): number;
  lw(px: number, W: number): number;
}

interface TailStyle { kind: string; a: number }

/** What create() destructures (livery-graphics.js:6-8). */
export interface GraphicsDeps {
  cssA(c: LiveryColour, a: number): string;
  clipToRegion(ctx: LiveryCtx2D, R: LiveryRect): void;
  drawNumber(ctx: LiveryCtx2D, n: number | string, R: LiveryRect, ink: LiveryColour, accent: LiveryColour, bg: LiveryColour | null | undefined,
    fontId: string | null | undefined, reserveTop: number, halo?: LiveryColour | null): void;
  drawWordmark(ctx: LiveryCtx2D, text: string, R: LiveryRect, ink: LiveryColour, opts?: WordmarkOpts): void;
  CROWN_SQUASH: number;
  coverBindOf(liv: GraphicsLivery | null | undefined): string;
  saddleFill(liv: GraphicsLivery | null | undefined, bandC: LiveryColour, coverPaint: LiveryColour): LiveryColour | null;
  ridgeFill(liv: GraphicsLivery | null | undefined, bandC: LiveryColour, coverPaint: LiveryColour): LiveryColour;
  pickOn(cands: readonly (LiveryColour | null | undefined | false)[], bg: LiveryColour | readonly (LiveryColour | null | undefined)[] | null | undefined, floor: number): LiveryColour;
  INK_LIGHT: LiveryColour;
  INK_DARK: LiveryColour;
  SUN_FLOOR: number;
  TAIL_STYLE_IDS: readonly string[];
}

export function create(context: GraphicsDeps) {
  const { cssA, clipToRegion, drawNumber, drawWordmark, CROWN_SQUASH,
    coverBindOf, saddleFill, ridgeFill, pickOn, INK_LIGHT, INK_DARK,
    SUN_FLOOR, TAIL_STYLE_IDS } = context;

  // A band that cannot clear the cover it lands on is carried by its TRIM.
  // Only an AUTHORED tint gets there — the derived pick is floored at
  // BAND_ON_COVER — and Alpine's is one: BWT pink on the body-blue cover
  // (both photographed, LIVERY-2026-REFERENCE.md) reads 1.56:1, and every
  // band design below wore hairline trim at 0.3–0.6 alpha and ~1 % of the
  // crown, the width carbon's keylines were found too thin at. Measured on
  // Alpine: saddle, panel and rungs 0 % of the crown readable, wedge 1.1 %,
  // streaks 2.9 % (cover-legibility.test.mjs, floor 3 %). So under a weak
  // band the trim is drawn at KEYLINE weight — full ink, 3 % of the crown,
  // carbon's own recipe — and where the band clears nothing changes: every
  // other team's atlas is byte-identical (the edges are written as
  // `edge - width` so the derived path reproduces the literal edges exactly). `weak` is decided ONCE at the call
  // site, from the same pair the band was picked against.
  const TRIM_KEY = 0.03;       // a keyline, of the crown width (carbon: 0.035)
  const TRIM_STROKE = 0.02;    // a stroked edge straddles the outline: half in
  function bandTrim(weak: boolean): BandTrim {
    return {
      a: (a: number) => (weak ? 0.9 : a),                          // ink alpha
      w: (w: number) => (weak ? Math.max(w, TRIM_KEY) : w),        // keyline, of W
      lw: (px: number, W: number) => (weak ? Math.max(px, W * TRIM_STROKE) : px),   // stroke px
    };
  }
  // These bands continue unchanged from the crown onto the cover tail.
  function drawCoverBand(ctx: LiveryCtx2D, id: string, R: LiveryRect, acc: LiveryColour, ink: LiveryColour, colors: GraphicsLivery | null | undefined, coverPaint: LiveryColour, T: BandTrim): void {
    const X = R.x, Y = R.y, W = R.w, H = R.h;
    if (id === "stripe") {
      // One centreline band with firm ink edges — trim, not a smear. A hair
      // narrower (18 %) so Williams / Aston leave crown paint either side.
      ctx.fillStyle = cssA(acc, 0.96); ctx.fillRect(X + W * 0.41, Y, W * 0.18, H);
      const kw = W * T.w(0.014);
      ctx.fillStyle = cssA(ink, T.a(0.62));
      ctx.fillRect(X + W * 0.41, Y, kw, H); ctx.fillRect(X + W * (0.59 - T.w(0.014)), Y, kw, H);
    } else if (id === "ridge") {
      // Thin centreline only — thinner than `stripe` — in the ridge zone colour.
      const ridgeC = ridgeFill(colors || {}, acc, coverPaint);
      const rw = W * 0.07;
      ctx.fillStyle = cssA(ridgeC, 0.96);
      ctx.fillRect(X + W * 0.5 - rw / 2, Y, rw, H);
      ctx.fillStyle = cssA(ink, 0.55);
      ctx.fillRect(X + W * 0.5 - rw / 2, Y, W * 0.008, H);
      ctx.fillRect(X + W * 0.5 + rw / 2 - W * 0.008, Y, W * 0.008, H);
    } else if (id === "twin") {
      // Two pinstripes ON the shoulder creases — the W17's teal lines along
      // the cover's edges — not down the middle of the crown. Inner ink
      // keylines keep them readable on silver when the stripe colour is close.
      ctx.fillStyle = cssA(acc, 0.96);
      ctx.fillRect(X + W * 0.035, Y, W * 0.052, H); ctx.fillRect(X + W * 0.913, Y, W * 0.052, H);
      const kw = W * T.w(0.010);
      ctx.fillStyle = cssA(ink, T.a(0.55));
      ctx.fillRect(X + W * (0.088 - T.w(0.010)), Y, kw, H); ctx.fillRect(X + W * 0.912, Y, kw, H);
    }
  }

  function drawSpineTop(ctx: LiveryCtx2D, id: string, R: LiveryRect, c1: LiveryColour, acc: LiveryColour, ink: LiveryColour, name: string, num: number | string,
    numFont: string | null | undefined, acc2: LiveryColour | null | undefined, colors: GraphicsLivery | null | undefined, weak: boolean): void {
    const X = R.x, Y = R.y, W = R.w, H = R.h;
    const T = bandTrim(weak);
    ctx.save();
    clipToRegion(ctx, R);
    if (id === "bigmark") {
      // Handled by the caller: the team mark at the full crown WIDTH, without
      // its plate (Red Bull's bull straight on the RB22's cover). Not "the
      // length of the crown", as this said until it was measured: the mark is
      // drawn in a SQUARE box and squashed by CROWN_SQUASH so it lands round,
      // which caps its along-crown extent at 52 % of the region however large
      // the box gets (measured maximum on any team: 44 %). A round mark cannot
      // run the length of a strip 1.9x longer than it is wide. Nothing to paint
      // here — the crest painters need the livery, not a colour.
    } else if (id === "saddle") {
      // The whole crown, shoulder to shoulder, in the accent, AND down the
      // flanks with a raked rear edge — Ferrari's white engine-cover top on
      // the SF-26, where the white runs from the airbox over the shoulders
      // and the number sits in it. The band is painted here first; a flank
      // pick (plate, number) lands on top of it.
      // Only the CROWN here: drawSpineTop runs inside a clip to R, and a
      // canvas clip only ever narrows, so the flank half is drawn by
      // saddleFlanks() at the call site instead — inside this clip it was
      // silently erased, and the atlas shipped a saddle with bare sides.
      // Shoulder hairlines keep the saddle reading as a panel on pale covers
      // (Ferrari / Cadillac) where a pure fill vanishes into the cover paint.
      ctx.fillStyle = cssA(acc, 0.97); ctx.fillRect(X, Y, W, H);
      const kw = W * T.w(0.012);
      ctx.fillStyle = cssA(ink, T.a(0.28));
      ctx.fillRect(X, Y, kw, H); ctx.fillRect(X + W * (1 - T.w(0.012)), Y, kw, H);
    } else if (id === "panel") {
      // Vinyl block: parallel sides, hard rake at the airbox, square at the
      // tail. Slightly narrower than before so papaya / Haas panels leave a
      // cover margin; dual keylines (ink outer + light inner) sell the edge.
      ctx.fillStyle = cssA(acc, 0.97);
      ctx.beginPath();
      ctx.moveTo(X + W * 0.30, Y);                 // tail (canvas top = rear)
      ctx.lineTo(X + W * 0.70, Y);
      ctx.lineTo(X + W * 0.70, Y + H * 0.78);
      ctx.lineTo(X + W * 0.30, Y + H * 0.94);      // raked front edge
      ctx.closePath(); ctx.fill();
      const kw = W * T.w(0.012);
      ctx.fillStyle = cssA(ink, T.a(0.65));
      ctx.fillRect(X + W * 0.30, Y, kw, H * 0.94); ctx.fillRect(X + W * (0.70 - T.w(0.012)), Y, kw, H * 0.78);
      ctx.fillStyle = cssA(ink, 0.22);
      ctx.fillRect(X + W * 0.312, Y, W * 0.008, H * 0.92); ctx.fillRect(X + W * 0.680, Y, W * 0.008, H * 0.76);
    } else if (id === "stripe") {
      drawCoverBand(ctx, id, R, acc, ink, colors, c1, T);
    } else if (id === "streaks") {
      // Parallel raked streaks down the crown — Racing Bulls blue speed lines
      // on a white cover. Four strokes, not a solid stripe; ink edges keep them
      // readable when acc is close to the cover.
      for (let i = 0; i < 4; i++) {
        const t = (i + 0.85) / 5;
        const x0 = X + W * (t - 0.028), x1 = X + W * (t + 0.028);
        ctx.fillStyle = cssA(acc, 0.96);
        ctx.beginPath();
        ctx.moveTo(x0 + W * 0.012, Y);
        ctx.lineTo(x1 + W * 0.012, Y);
        ctx.lineTo(x1 - W * 0.012, Y + H);
        ctx.lineTo(x0 - W * 0.012, Y + H);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = cssA(ink, T.a(0.45)); ctx.lineWidth = T.lw(Math.max(1.2, W * 0.008), W); ctx.stroke();
      }
    } else if (id === "twin") {
      drawCoverBand(ctx, id, R, acc, ink, colors, c1, T);
    } else if (id === "carbon") {
      // An exposed-carbon crown panel: near-black with a faint diagonal weave
      // and an accent keyline where the paint stops.
      const px = X + W * 0.28, pw = W * 0.44;
      ctx.fillStyle = "rgb(22,23,26)"; ctx.fillRect(px, Y, pw, H);
      ctx.strokeStyle = "rgba(255,255,255,0.11)"; ctx.lineWidth = 3;
      for (let d = -H; d < pw + H; d += 12) {
        ctx.beginPath(); ctx.moveTo(px + d, Y); ctx.lineTo(px + d + H, Y + H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px + d + H, Y); ctx.lineTo(px + d, Y + H); ctx.stroke();
      }
      // The keylines are what a viewer actually SEES of this design: the panel
      // is exposed carbon, so on a dark car it is near-black on near-black and
      // the weave is a wash over it — measured at 0 % of the crown readable
      // on five of twelve cars, which is a design that does not exist. At 1.4 %
      // of the crown each they were too thin to register at chase distance;
      // 3.5 % keeps them keylines and puts carbon level with the thinnest
      // design that does read (Mercedes' twin stripes). The colour is already
      // the cover-aware band, so they contrast whatever they land on.
      const kw = W * 0.035;
      ctx.fillStyle = cssA(acc, 0.9);
      ctx.fillRect(px - kw, Y, kw, H); ctx.fillRect(px + pw, Y, kw, H);
    } else if (id === "chevron") {
      // Three arrows pointing at the NOSE down the crown — Alpine's, and the
      // shape a swept wing leaves on a cover. The crest canvas is drawn
      // front-at-the-BOTTOM (car-mesh maps vB to the front station), so the tip
      // of each arrow is at the HIGHER y: pointing them the intuitive way put
      // three arrows aimed at the rear wing. Slightly thicker shafts + ink
      // outline so Racing Bulls' chevrons read from the side garage camera.
      ctx.fillStyle = cssA(acc, 0.96);
      for (let i = 0; i < 3; i++) {
        const y0 = Y + H * (0.08 + i * 0.29), tip = y0 + H * 0.12, th = H * 0.088;
        ctx.beginPath();
        ctx.moveTo(X, y0); ctx.lineTo(X + W / 2, tip); ctx.lineTo(X + W, y0);
        ctx.lineTo(X + W, y0 + th); ctx.lineTo(X + W / 2, tip + th); ctx.lineTo(X, y0 + th);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = cssA(ink, T.a(0.45)); ctx.lineWidth = T.lw(Math.max(1.5, H * 0.012), W);
        ctx.stroke();
      }
    } else if (id === "tricolour") {
      // Three bands ACROSS the crown at the airbox end — the national flash a
      // works team paints there (Ferrari's tricolore, Alpine's bleu-blanc-rouge).
      // Body paint is the middle band, so only the outer two are drawn: a
      // three-colour livery cannot be assumed, and c1 in the middle always reads.
      // The two drawn bands are picked against the COVER — one as the band
      // colour, one as the crest ink — and never against EACH OTHER, so a
      // livery whose two picks land together wears one colour repeated.
      // Measured: Mercedes 1.01:1 between its own bands, Aston Martin 1.03,
      // Williams 1.07, Red Bull 1.31 — four of eleven teams in a two-colour
      // "tricolour", which is the one thing the design is named for. acc2 is
      // the second band re-picked against the cover AND the first band; where
      // the two already separate it IS the ink and nothing changes.
      const bandH = H * 0.095, top = Y + H * 0.60, gap = H * 0.018;
      ctx.fillStyle = cssA(acc, 0.97); ctx.fillRect(X, top, W, bandH);
      ctx.fillStyle = cssA(acc2 || ink, 0.97); ctx.fillRect(X, top + bandH + gap * 2, W, bandH);
      ctx.fillStyle = cssA(ink, T.a(0.35));
      ctx.fillRect(X, top + bandH, W, gap); ctx.fillRect(X, top + bandH + gap, W, gap);
    } else if (id === "wedge") {
      // A band WIDE at the airbox tapering to a point at the tail — the shape a
      // cover wears when the spine colour is swept back off the roll hoop.
      // Nothing else in this set tapers: `panel` is a parallel block with a
      // raked front edge, `stripe` is parallel end to end, `saddle` takes the
      // whole crown. Canvas top is the REAR (see `panel`), so the wide end is
      // the HIGHER y and the point is at Y. Ink edge on both sides so the taper
      // does not dissolve into cover paint at chase distance.
      ctx.fillStyle = cssA(acc, 0.97);
      ctx.beginPath();
      ctx.moveTo(X + W * 0.5 - W * 0.06, Y);        // tail: a stub, not a spike
      ctx.lineTo(X + W * 0.5 + W * 0.06, Y);
      ctx.lineTo(X + W * 0.88, Y + H);               // airbox: nearly the full crown
      ctx.lineTo(X + W * 0.12, Y + H);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = cssA(ink, T.a(0.5)); ctx.lineWidth = T.lw(Math.max(2, W * 0.012), W); ctx.stroke();
    } else if (id === "rungs") {
      // Bars ACROSS the crown, repeated down it — the one direction nothing
      // else in this set runs. `twin` and `stripe` run along the car, `chevron`
      // points along it, `tricolour` is a single flash at the airbox; this is a
      // ladder the length of the cover, and it reads as motion from directly
      // behind, which is the camera the player actually has.
      ctx.fillStyle = cssA(acc, 0.96);
      for (let i = 0; i < 5; i++) {
        const inset = W * (0.05 + i * 0.038);        // narrowing toward the tail
        const y = Y + H * (0.07 + i * 0.185), h = H * 0.072;
        ctx.fillRect(X + inset, y, W - inset * 2, h);
        ctx.fillStyle = cssA(ink, T.a(0.4));
        ctx.fillRect(X + inset, y, W - inset * 2, weak ? W * TRIM_KEY : Math.max(1.5, h * 0.14));
        ctx.fillStyle = cssA(acc, 0.96);
      }
    } else if (id === "wordmark") {
      // The title sponsor along the spine, rotated to run nose → tail so it
      // reads from the SIDE of the car, the way a real engine cover carries it.
      // TWICE, once per half of the crown, each turned the other way: one copy
      // read upside down from whichever side it was not drawn for. The crown is
      // narrow and the mark only ever used a third of its width, so two columns
      // cost almost nothing in letter height (0.30 W each against 0.32 W).
      for (const s2 of [-1, 1]) {
        ctx.save();
        ctx.translate(X + W / 2 + s2 * W * 0.25, Y + H / 2); ctx.rotate(s2 * Math.PI / 2);
        drawWordmark(ctx, name, { x: -H / 2, y: -W * 0.15, w: H, h: W * 0.30 }, ink, { align: "center" });
        ctx.restore();
      }
    } else if (id === "number") {
      // TOP-DOWN: upright with the nose up — the chase camera's view and a
      // plan view of the car (by design; the crest matches). Squashed
      // along the spine so the digits come out in proportion.
      ctx.translate(X + W / 2, Y + H / 2); ctx.rotate(Math.PI); ctx.scale(1, CROWN_SQUASH);
      drawNumber(ctx, num, { x: -W * 0.34, y: -W * 0.34, w: W * 0.68, h: W * 0.68 }, ink, acc, null, numFont, 0);
    } else if (id === "cap") {
      // Solid block airbox → mid-cover with a soft rear cut. Shoulders follow
      // coverBind: saddleWrap fills the whole crown in the saddle zone, spineOnly
      // keeps shoulders on the cover paint, independent paints the block in the
      // band colour alone. Flank spill is saddleFlanks at the call site.
      // The cut used to be a hard fillRect edge; under cover UVs that read as a
      // stair-stepped band (Ferrari podFloor / cover close-ups). A short
      // alpha ramp (~3 % of H) keeps the silhouette while killing the jaggies.
      const liv = colors || {};
      const bind = coverBindOf(liv);
      // Explicit saddleTint under wrap is a pick — paint it. Otherwise the
      // band colour (already cover-safe via bandC).
      const fill = bind === "saddleWrap" ? (saddleFill(liv, acc, c1) || acc) : acc;
      const cutY = Y + H * 0.38;
      const bh = Y + H - cutY;
      const feather = Math.max(2, H * 0.03);
      const paintCap = (px: number, pw: number) => {
        const solidY = cutY + feather;
        const solidH = Math.max(0, Y + H - solidY);
        if (solidH > 0) {
          ctx.fillStyle = cssA(fill, 0.97);
          ctx.fillRect(px, solidY, pw, solidH);
        }
        const g = ctx.createLinearGradient(0, cutY, 0, solidY);
        g.addColorStop(0, cssA(fill, 0));
        g.addColorStop(1, cssA(fill, 0.97));
        ctx.fillStyle = g;
        ctx.fillRect(px, cutY, pw, feather);
        ctx.fillStyle = cssA(ink, 0.28);
        ctx.fillRect(px, cutY + feather * 0.55, pw, Math.max(1.5, H * 0.008));
      };
      if (bind === "spineOnly") {
        paintCap(X + W * 0.28, W * 0.44);
      } else {
        paintCap(X, W);
        if (bind === "independent") {
          ctx.fillStyle = cssA(ink, 0.35);
          ctx.fillRect(X, cutY + feather, W * 0.012, Math.max(0, bh - feather));
          ctx.fillRect(X + W * 0.988, cutY + feather, W * 0.012, Math.max(0, bh - feather));
        }
      }
      if (liv.spineTint) {
        const ridgeC = ridgeFill(liv, acc, c1), rw = W * 0.018;
        ctx.fillStyle = cssA(ridgeC, 0.9);
        ctx.fillRect(X + W * 0.5 - rw / 2, cutY + feather * 0.5, rw, Math.max(0, bh - feather * 0.5));
      }
    } else if (id === "ridge") {
      drawCoverBand(ctx, id, R, acc, ink, colors, c1, T);
    } else if (id === "fade") {
      // Ordered halftone on the crown: regular grid, radius ramps nose→tail
      // (canvas top = rear). Ground is the cover. An authored BAND is this
      // graphic's colour (the sheet promises the pick is used as-is); only a
      // DERIVED band is re-picked to clear the cover.
      // The previous hash-skip field clumped into a noisy "broken text"
      // dot-matrix at garage close-up (Mercedes cover, 1024/2048 atlas).
      const dotInk = (colors && colors.spineTint)
        || pickOn([acc, ink, INK_LIGHT, INK_DARK].filter(Boolean), c1, SUN_FLOOR);
      // Cell size tracks atlas width so 1024 and 2048 stay crisp (≈32/64 cols).
      const cols = Math.max(12, Math.round(W / Math.max(4, W * 0.028)));
      const rows = Math.max(16, Math.round(H / Math.max(4, W * 0.028)));
      const cellW = W / cols, cellH = H / rows;
      const rMax = Math.min(cellW, cellH) * 0.46;
      ctx.fillStyle = cssA(dotInk, 0.97);
      for (let j = 0; j < rows; j++) {
        // t = 0 at rear (sparse / tiny), 1 at airbox (full dots).
        const t = (j + 0.5) / rows;
        const amp = t * t;                         // ease-in: clean empty tail
        const r = rMax * amp;
        if (r < 0.4) continue;                     // sub-pixel: leave bare
        const cy = Y + (j + 0.5) * cellH;
        for (let i = 0; i < cols; i++) {
          const cx = X + (i + 0.5) * cellW;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }
  // The cover's TAIL top (REGIONS.tail, a narrow strip behind the crown): the
  // band designs continue down it so a stripe or a saddle runs to the wing,
  // and "wordmark" puts the SECOND sponsor there reading from behind. The
  // marks (logo, number) and "none" leave it bare.
  function drawTailTop(ctx: LiveryCtx2D, id: string, R: LiveryRect, acc: LiveryColour, ink: LiveryColour, name2: string, colors: GraphicsLivery | null | undefined, coverPaint: LiveryColour, weak: boolean): void {
    const X = R.x, Y = R.y, W = R.w, H = R.h;
    const T = bandTrim(weak);      // the crown's trim rule, continued down the tail
    ctx.save();
    clipToRegion(ctx, R);
    if (id === "saddle") { ctx.fillStyle = cssA(acc, 0.97); ctx.fillRect(X, Y, W, H); }
    else if (id === "panel") {
      ctx.fillStyle = cssA(acc, 0.97); ctx.fillRect(X + W * 0.30, Y, W * 0.40, H);
      const kw = W * T.w(0.012);
      ctx.fillStyle = cssA(ink, T.a(0.55));
      ctx.fillRect(X + W * 0.30, Y, kw, H); ctx.fillRect(X + W * (0.70 - T.w(0.012)), Y, kw, H);
    }
    else if (id === "stripe") {
      drawCoverBand(ctx, id, R, acc, ink, colors, coverPaint, T);
    } else if (id === "ridge") {
      drawCoverBand(ctx, id, R, acc, ink, colors, coverPaint, T);
    } else if (id === "streaks") {
      for (let i = 0; i < 4; i++) {
        const tt = (i + 0.85) / 5;
        const x0 = X + W * (tt - 0.028), x1 = X + W * (tt + 0.028);
        ctx.fillStyle = cssA(acc, 0.96);
        ctx.beginPath();
        ctx.moveTo(x0 + W * 0.008, Y); ctx.lineTo(x1 + W * 0.008, Y);
        ctx.lineTo(x1 - W * 0.008, Y + H); ctx.lineTo(x0 - W * 0.008, Y + H);
        ctx.closePath(); ctx.fill();
      }

    } else if (id === "twin") {
      drawCoverBand(ctx, id, R, acc, ink, colors, coverPaint, T);
    } else if (id === "wedge") {
      // The point runs OUT along the tail rather than stopping at the crown's
      // edge: the crown hands over a stub ~12 % wide, and it closes to nothing.
      ctx.fillStyle = cssA(acc, 0.97);
      ctx.beginPath();
      ctx.moveTo(X + W * 0.5 - W * 0.014, Y); ctx.lineTo(X + W * 0.5 + W * 0.014, Y);
      ctx.lineTo(X + W * 0.5 + W * 0.06, Y + H); ctx.lineTo(X + W * 0.5 - W * 0.06, Y + H);
      ctx.closePath(); ctx.fill();
    } else if (id === "rungs") {
      // One more bar, narrowest of the ladder.
      ctx.fillStyle = cssA(acc, 0.96);
      ctx.fillRect(X + W * 0.24, Y + H * 0.28, W * 0.52, H * 0.34);
    } else if (id === "carbon") {
      // Same 3.5 % keylines as the crown carbon panel — 1.4 % vanished at chase
      // distance on the tail continuation (see drawSpineTop "carbon").
      const px = X + W * 0.28, pw = W * 0.44;
      const kw = W * 0.035;
      ctx.fillStyle = "rgb(22,23,26)"; ctx.fillRect(px, Y, pw, H);
      ctx.fillStyle = cssA(acc, 0.9); ctx.fillRect(px - kw, Y, kw, H); ctx.fillRect(px + pw, Y, kw, H);
    } else if (id === "wordmark" && name2) {
      // Reads from behind: the tail is what the car behind sees.
      ctx.translate(X + W / 2, Y + H / 2); ctx.rotate(Math.PI);
      drawWordmark(ctx, name2, { x: -W / 2, y: -H / 2, w: W, h: H }, ink, { align: "center", pad: 6 });
    }
    ctx.restore();
  }
  const TAIL_STYLE: Record<string, TailStyle> = {
    redbull:     { kind: "diag",    a: 0.80 },   // charging diagonal slash
    racingbulls: { kind: "diag",    a: 0.70 },   // youthful bold slash
    ferrari:     { kind: "sweep",   a: 0.66 },   // low sweeping curve
    mclaren:     { kind: "chevron", a: 0.74 },   // aero speed chevrons
    mercedes:    { kind: "streak",  a: 0.62 },   // fine parallel streaks
    williams:    { kind: "chevron", a: 0.62 },   // engineering chevrons
    alpine:      { kind: "sweep",   a: 0.64 },   // chic flowing curve
    audi:        { kind: "streak",  a: 0.60 },   // precise fine lines
    astonmartin: { kind: "sweep",   a: 0.62 },   // graceful wing sweep
    haas:        { kind: "diag",    a: 0.68 },   // industrial hard slash
    cadillac:    { kind: "chevron", a: 0.60 },   // bold Detroit chevrons
  };
  // `styleId` is the livery's TAIL STYLE pick: "team" (or absent) keeps the
  // per-team motif, a kind name overrides it at the team's own strength, and
  // "none" returns before a single pixel — the player asked for a plain fin.
  function drawTailGraphic(ctx: LiveryCtx2D, teamId: string | null | undefined, R: LiveryRect, _c1: LiveryColour, c2: LiveryColour, stripe: LiveryColour | null | undefined, styleId: string | null | undefined): void {
    if (styleId === "none") return;
    const team = TAIL_STYLE[teamId as string] || { kind: "diag", a: 0.6 };
    const st: TailStyle = (styleId && styleId !== "team" && TAIL_STYLE_IDS.includes(styleId))
      ? { kind: styleId, a: team.a } : team;
    const acc = stripe || c2;
    const X = R.x, Y = R.y, W = R.w, H = R.h;
    ctx.save();
    // Clip to the panel. The motif strokes are authored PAST the region edges
    // (a sweep ends at X + 1.08 W, a slash at Y - 0.08 H) so their round caps
    // never show inside it — unclipped, the overshoot lands on the atlas: the
    // sweep's tail reaches x 504 in a fin region ending at 470, four pixels
    // into the fin BADGE region next door, which shows whenever the badge is off.
    clipToRegion(ctx, R);
    const g = ctx.createLinearGradient(X, Y + H, X + W, Y);
    g.addColorStop(0.0, cssA(acc, 0));
    g.addColorStop(0.5, cssA(acc, st.a * 0.85));
    g.addColorStop(1.0, cssA(acc, 0));
    ctx.fillStyle = g;
    ctx.fillRect(X, Y, W, H);
    // 2) bold motif strokes per style — cleaner shapes, crisper falloff.
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (st.kind === "chevron") {
      // Nested arrowheads pointing forward — bold at front, fading rearward.
      ctx.lineWidth = W * 0.085;
      for (let i = 0; i < 4; i++) {
        const o = X + W * (0.16 + i * 0.20), a2 = st.a * (1 - i * 0.20);
        ctx.strokeStyle = cssA(acc, a2);
        ctx.beginPath();
        ctx.moveTo(o - W * 0.16, Y + H * 0.10);
        ctx.lineTo(o, Y + H * 0.5);
        ctx.lineTo(o - W * 0.16, Y + H * 0.90);
        ctx.stroke();
      }
    } else if (st.kind === "sweep") {
      // A few clean stacked curves sweeping low-to-high across the panel.
      ctx.lineWidth = W * 0.115;
      for (let i = 0; i < 3; i++) {
        ctx.strokeStyle = cssA(acc, st.a * (1 - i * 0.26));
        ctx.beginPath();
        ctx.moveTo(X - W * 0.08, Y + H * (0.72 + i * 0.11));
        ctx.quadraticCurveTo(X + W * 0.5, Y + H * (0.04 + i * 0.11), X + W * 1.08, Y + H * (0.46 + i * 0.11));
        ctx.stroke();
      }
    } else if (st.kind === "streak") {
      // Fine, evenly spaced parallel racing lines raked forward.
      ctx.lineWidth = W * 0.032;
      for (let i = 0; i < 8; i++) {
        ctx.strokeStyle = cssA(acc, st.a * (0.45 + 0.55 * (1 - i / 8)));
        const o = X + W * (0.05 + i * 0.115);
        ctx.beginPath();
        ctx.moveTo(o, Y + H);
        ctx.lineTo(o + W * 0.42, Y);
        ctx.stroke();
      }
    } else if (st.kind === "stars") {
      // Scattered four-point stars, big at the front and thinning rearward —
      // the W17's star flake over its sidepods and cover. Deterministic
      // positions (a fixed table, no RNG) so the atlas is the same every paint.
      const pts: readonly (readonly [number, number, number])[] = [[0.08, 0.30, 1.0], [0.22, 0.72, 0.75], [0.30, 0.22, 0.55], [0.44, 0.58, 0.85],
                   [0.55, 0.18, 0.45], [0.62, 0.80, 0.60], [0.74, 0.40, 0.70], [0.86, 0.66, 0.40], [0.93, 0.20, 0.50]];
      for (let i = 0; i < pts.length; i++) {
        const cx = X + W * pts[i]![0], cy = Y + H * pts[i]![1], r = H * 0.26 * pts[i]![2], q = r * 0.22;
        ctx.fillStyle = cssA(acc, st.a * (1.05 - 0.6 * pts[i]![0]));
        ctx.beginPath();
        ctx.moveTo(cx, cy - r); ctx.lineTo(cx + q, cy - q); ctx.lineTo(cx + r, cy); ctx.lineTo(cx + q, cy + q);
        ctx.lineTo(cx, cy + r); ctx.lineTo(cx - q, cy + q); ctx.lineTo(cx - r, cy); ctx.lineTo(cx - q, cy - q);
        ctx.closePath(); ctx.fill();
      }
    } else if (st.kind === "check") {
      // Chequered flag: two rows of squares that fade rearward, skewed to the
      // same rake as the slashes so it reads as speed and not as a tablecloth.
      const n = 8, cw = W / n, ch = H / 2, skew = W * 0.06;
      for (let r = 0; r < 2; r++) {
        for (let i = 0; i < n; i++) {
          if ((i + r) % 2) continue;
          // Fades rearward like the other motifs but from a higher floor: a
          // flag that is half gone by mid-fin reads as dirt, not as a flag.
          const a2 = st.a * (1.10 - 0.7 * i / n);
          ctx.fillStyle = cssA(acc, Math.max(0.22, a2));
          const x0 = X + i * cw + skew * (1 - r), y0 = Y + r * ch;
          ctx.beginPath();
          ctx.moveTo(x0, y0 + ch); ctx.lineTo(x0 + cw, y0 + ch);
          ctx.lineTo(x0 + cw - skew, y0); ctx.lineTo(x0 - skew, y0);
          ctx.closePath(); ctx.fill();
        }
      }
    } else { // diag slash
      // Bold parallel slashes charging up to the right — hero stroke leads.
      ctx.lineWidth = W * 0.15;
      for (let i = 0; i < 3; i++) {
        ctx.strokeStyle = cssA(acc, st.a * (1 - i * 0.32));
        const o = X + W * (0.08 + i * 0.30);
        ctx.beginPath();
        ctx.moveTo(o, Y + H * 1.08);
        ctx.lineTo(o + W * 0.58, Y - H * 0.08);
        ctx.stroke();
      }
    }
    // 3) fade the panel edges to transparent so it blends into the bodywork.
    const rg = ctx.createRadialGradient(X + W / 2, Y + H / 2, W * 0.34, X + W / 2, Y + H / 2, W * 0.72);
    rg.addColorStop(0, "rgba(0,0,0,0)");
    rg.addColorStop(1, "rgba(0,0,0,1)");
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = rg;
    ctx.fillRect(X, Y, W, H);
    ctx.restore();
  }

  return { drawSpineTop, drawTailTop, drawTailGraphic };
}

/** f1-game's frozen `LiveryGraphics` global (livery-graphics.js:503-505). */
export const LiveryGraphics = Object.freeze({ create });
