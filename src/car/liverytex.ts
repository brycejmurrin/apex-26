// LiveryTex: the canvas livery texture atlas (REGIONS, SIZE, FLANK, the mark
// palette, crests, sponsor boards, number boards and every spine / flank design).
// Ported verbatim from f1-game js/car/liverytex.js:1-2595; the IIFE becomes module
// scope and the frozen record at the bottom is f1-game's `LiveryTex` return value.
//
// Deviations, all at the seams (no float or draw-order change):
// - The globals f1-game reads behind `typeof` guards (GLX, Teams, Legends,
//   Liveries, Car3D) are an explicit dependency bag set with configureLiveryTex().
//   The default bag is the shipped game's (Teams, Liveries and Car3D.PANEL_COL
//   present, no GLX, no Legends); leaving a member unset reproduces the original's
//   undefined-global branch. IS_MOBILE / IS_PHONE read GLX from the bag when asked
//   instead of once at script load.
// - CrestPaths, LiveryCrests, LiveryGraphics and LiveryDesign are imports, so their
//   `typeof` fallbacks (liverytex.js:491-493, 1073, 1508-1509, 1792) are gone.
// - `document.createElement("canvas")` and `new Image()` come from injected
//   factories (deps.createCanvas / deps.createImage); unset, they fall back to the
//   DOM at call time when one exists. Nothing touches a DOM global at module scope.
// - Log.info (liverytex.js:1632) is dropped.
// - Local renames where TS needs a non-reassigned binding: buildAtlas's `colors`
//   param is `colorsIn` (copied into `const colors`), drawWordmark's `text` is
//   `textIn` (upper-cased into `const text`). Same values, same order.
// - The LiveryTex record is frozen (f1-game's is not); `_internals` exposes the
//   private helpers to tests.
import { CrestPaths } from "./crest-paths";
import { LiveryCrests, type CrestLegend, type WordmarkOpts } from "./crest-draw";
import { LiveryGraphics } from "./livery-graphics";
import { LiveryDesign } from "./livery-design";
import { LIST as TEAMS_LIST } from "./teams";
import { migratePaint } from "./liveries";
import { PANEL } from "./materials";
import type { MVec3, Vec3 } from "./types";
import type {
  LiveryCanvas, LiveryCanvasFactory, LiveryColour as Col, LiveryCtx2D, LiveryDrawable, LiveryFit, LiveryRect,
} from "./livery-canvas";

/** A team id as callers pass it (the custom / legends slots included; may be unset). */
export type TeamId = string | null | undefined;

type OptCol = Col | null | undefined;

/** An ink: a colour tagged with its worst-case contrast (inkOn, liverytex.js:156-170). */
export type Ink = number[] & { worst: number };

/** Every livery field the atlas reads (`colors.*` / `liv.*`). Colours are linear RGB. */
export interface TexLivery {
  id?: string | null | undefined;
  c1?: OptCol;
  c2?: OptCol;
  stripe?: OptCol;
  accent?: OptCol;
  wing?: OptCol;
  fin?: OptCol;
  finArt?: OptCol;
  logo?: OptCol;
  logo2?: OptCol;
  logo3?: OptCol;
  cover?: OptCol;
  spineTint?: OptCol;
  sideTint?: OptCol;
  sunTint?: OptCol;
  bandTint2?: OptCol;
  plateTint?: OptCol;
  saddleTint?: OptCol;
  numFont?: string | null | undefined;
  sponsors?: string | null | undefined;
  finStyle?: string | null | undefined;
  finBadge?: string | null | undefined;
  finShape?: string | null | undefined;
  spineLogo?: string | null | undefined;
  spineSide?: string | null | undefined;
  spineHeight?: string | null | undefined;
  coverBind?: string | null | undefined;
  finHandoff?: string | null | undefined;
  patternPlacement?: string | null | undefined;
  patternSide?: string | null | undefined;
  /** Probe-only skip of the wrap's fallback flank badge (liverytex.js:1844-1845). */
  _bareWrapFlank?: unknown;
  [extra: string]: unknown;
}

/** The slice of a Teams.LIST entry the atlas reads. */
export interface TexTeam {
  id: string;
  short?: string | undefined;
  legend?: string | undefined;
  drivers?: readonly { num: number; code: string }[] | undefined;
}

/** The slice of a Legends entry the atlas reads. */
export interface TexLegend extends CrestLegend {}

/** An uploaded emblem: a decoded image (HTMLImageElement or equivalent). */
export interface LiveryLogo {
  naturalWidth: number;
  naturalHeight: number;
  _avg?: Col | null;
}

/** What setTeamLogo drives: `new Image()`'s members. */
export interface LiveryImage extends LiveryLogo {
  onload: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
}

/** The optional f1-game globals LiveryTex reads, as a typed bag. */
export interface LiveryTexDeps {
  /** js/glx.js: the memory tier and the device (liverytex.js:25-28). */
  GLX?: { mobileTier?: unknown; isMobile?: unknown } | undefined;
  /** js/data/teams.js Teams (short codes, driver codes, the legends slot). */
  Teams?: { LIST?: readonly TexTeam[] | undefined } | undefined;
  /** js/data/legends.js Legends.byId. */
  Legends?: { byId?: ((id: string) => TexLegend | null | undefined) | undefined } | undefined;
  /** js/car/liveries.js Liveries.migratePaint. */
  Liveries?: { migratePaint?: (<T>(liv: T) => T) | undefined } | undefined;
  /** js/car/car3d.js Car3D.PANEL_COL (the sidepod board colour). */
  Car3D?: { PANEL_COL?: Col | undefined } | undefined;
  /** document.createElement("canvas"). */
  createCanvas?: LiveryCanvasFactory | undefined;
  /** new Image(). */
  createImage?: (() => LiveryImage) | undefined;
}

/** The shipped game's globals: Teams, Liveries and Car3D loaded; no GLX (desktop), no Legends. */
export const DEFAULT_DEPS: LiveryTexDeps = Object.freeze({
  Teams: { LIST: TEAMS_LIST },
  Liveries: { migratePaint },
  Car3D: { PANEL_COL: PANEL },
});

let deps: LiveryTexDeps = DEFAULT_DEPS;
/** Install the dependency bag (no argument restores DEFAULT_DEPS). Clears the crest extent cache. */
export function configureLiveryTex(next: LiveryTexDeps = DEFAULT_DEPS): void {
  deps = next;
  for (const k of Object.keys(crestExtentCache)) delete crestExtentCache[k];
}

function makeCanvas(): LiveryCanvas {
  if (deps.createCanvas) return deps.createCanvas();
  if (typeof document !== "undefined") return document.createElement("canvas");
  throw new Error("LiveryTex: no canvas factory (configureLiveryTex({ createCanvas }))");
}

/** The atlas's named regions (canvas pixels, origin top-left, y down). */
export interface Regions {
  crest: LiveryRect; titleA: LiveryRect; titleB: LiveryRect; wing: LiveryRect; num: LiveryRect; strip: LiveryRect;
  fin: LiveryRect; finBadge: LiveryRect; spineSide: LiveryRect; spineSideL: LiveryRect; fwEnd: LiveryRect; tail: LiveryRect;
}

/** markPalette's answer (liverytex.js:801-825). */
export interface MarkPalette {
  mark: number[];
  alt: number[];
  plate: number[] | null;
  part: number[] | null;
  brandPair: boolean;
  brandMark: boolean;
  freeMark: boolean;
  under: number[][];
  halo: number[] | null;
  outline: number[] | null;
}

interface FlankFrame { R: LiveryRect; fx(u: number): number; dir: number }
interface NumFont { font(px: number): string; style: string }
interface Brand { mark: Col; alt: Col; plate: Col | null }
interface FillSurface { key: string; label: string; why: string; tops?: readonly string[]; sides?: readonly string[]; binds?: readonly string[] }
interface CrestOpts { liv?: TexLivery | null | undefined; field?: unknown; bare?: boolean; palette?: MarkPalette | undefined }
interface TeamMarkOpts { halo?: OptCol; crestScale?: boolean; noPlate?: boolean; fullLockup?: boolean }

// Authored at 2048×2560 (was 1024×1280): garage / 3/4 boards need ~2×
// texels so SKYSTRIKE / NITROX edges stay cut-vinyl crisp. UV fractions are
// unchanged — REGIONS scale with SIZE. MEMORY (exact mip chain):
//   one full atlas  ~26.7 MB  (was 6.67 MB)
//   desktop grid    ~61.7 MB  player full + 21 AI at 512×640 (was ~41.7 MB)
// AI and mobile KEEP the same absolute upload sizes as before via atlasDiv
// (divisors doubled with SIZE), so race-distance rivals do not pay 4×.
export const SIZE = 2048;
// The atlas is SIZE wide and SIZE_H tall: the extra rows below y SIZE hold
// the LEFT flank, authored separately from the right (an asymmetric graphic
// — a bull facing forward — cannot be one texture mirrored across the car,
// and text cannot be one texture NOT mirrored; each side gets its own).
// UVs are fractions, so v divides by SIZE_H wherever u divides by SIZE.
export const SIZE_H = 2560;
// Mobile tier: upload atlases at a jetsam-safe absolute size — 22 cars ×
// full RGBA + mips was the biggest GPU consumer on iOS web apps. This READS
// glx.js's answer rather than copying its sniff (a "must match glx.js"
// comment is not a mechanism): the same "phone AND not GRAPHICS: HIGH" tier
// IS_MOBILE means here. glx.js is tagged ahead of this file in both
// index.html and the CARVIEW subset, so the value exists at eval; the
// typeof guard is the standalone-harness fallback (full-size atlas), never a
// path the shipped shell takes.
const isMobileTier = (): boolean => deps.GLX !== undefined && !!deps.GLX.mobileTier;
// The DEVICE, not the tier: GRAPHICS: HIGH buys the player's car a bigger atlas,
// never 21 AI cars at desktop size on a phone (~33 MB, plan perf-memory M-10).
const isPhone = (): boolean => deps.GLX !== undefined && !!deps.GLX.isMobile;
// Which divisor family a build uses: the player follows the memory tier, an AI car the device.
export function atlasMobile(isPlayer: boolean, tier: unknown, phone: unknown): boolean { return isPlayer ? !!tier : !!(tier || phone); }

// How much to shrink an atlas before upload. 1 = the authored 2048×2560.
//
// The livery atlases are the biggest thing on the GPU, and that is MEASURED
// rather than assumed: __apex.texCensus() on a full montreal grid reported
// 146.67 MB of them against 11.33 MB of baked material arrays and 13.8 MB for
// the whole packed world VBO of a mean circuit (notes/PERF-FINDINGS.md §2v).
// Ten times the geometry. One authored atlas with its mip chain is ~26.7 MB.
//
//   tier                 player   AI     upload px        notes
//   mobile                  4      8     512 / 256        unchanged absolutes
//   desktop preview         2      4     1024 / 512       boot + garage-open
//   desktop hi-res          1      —     2048             deferred (car-draw)
//
// The 26.7 MB hi-res player atlas must NOT upload on boot or garage open —
// car-draw paints the 1024 preview first, then requestIdleCallback-upgrades
// to 2048 (mipmapped). AI stays at 512×640. Photo-mode rivals may mint the
// player-tier PREVIEW (1024); only the real player car defers to 2048.
//
// Pure on purpose: rasterising a livery needs a browser (see the boundary
// note in tools/car/parts-sweep.mjs), but the tier DECISION is arithmetic and
// tests/unit/livery-tier.test.mjs holds it to these numbers headlessly.
// hiRes: desktop player only; ignored for AI and mobile (no larger upload).
export function atlasDiv(isPlayer: boolean, mobile: boolean, hiRes?: boolean): number {
  if (mobile) return isPlayer ? 4 : 8;
  if (!isPlayer) return 4;
  return hiRes ? 1 : 2;
}
// True when a desktop player preview can be upgraded to a larger atlas.
export function playerHiResDeferred(mobile?: unknown): boolean {
  return atlasDiv(true, !!mobile, false) > atlasDiv(true, !!mobile, true);
}

// Named atlas regions in CANVAS PIXELS (origin top-left, y down). The 3D side
// maps panel UVs to these rects. Fractions of SIZE / SIZE_H are frozen —
// scale every rect with SIZE, never move them independently.
export const REGIONS: Regions = {
  crest:  { x: 80,  y: 80,  w: 860, h: 860 },  // team crest/logo (engine-cover top; badge copy on the fin via finBadge)
  titleA: { x: 1000, y: 80,  w: 968, h: 340 },  // primary sponsor wordmark
  titleB: { x: 1000, y: 480, w: 968, h: 260 },  // secondary sponsor
  wing:   { x: 80,  y: 1040, w: 1240, h: 300 },  // rear-wing sponsor band
  num:    { x: 1400, y: 840, w: 568, h: 568 },  // nose + both rear endplates: lockup over the driver number
  strip:  { x: 80,  y: 1440, w: 1888, h: 260 },  // long thin sponsor strip (sidepod lower)
  fin:    { x: 80,  y: 1712, w: 860, h: 320 },  // shark-fin tail: the painted graphic, stretched over the whole swept fin
  finBadge: { x: 1000, y: 1712, w: 320, h: 320 },
  spineSide: { x: 1360, y: 1712, w: 608, h: 320 },   // the WHOLE engine-cover flank, the car's RIGHT side (liv.spineSide): z -0.66 → -1.90 across, crease → sidepod line down
  spineSideL: { x: 80, y: 2080, w: 608, h: 320 },  // the same for the LEFT flank, authored in its own outside-view frame
  fwEnd: { x: 760, y: 2080, w: 680, h: 280 },  // front-wing endplate, outer face (both sides); in the extra rows beside spineSideL
  tail: { x: 1000, y: 840, w: 360, h: 160 },   // the cover's TAIL top (z -1.28..-1.92); the SPINE TOP band designs run on down it
};

// Primary driver number per team.
const NUMBERS: Record<string, number> = {
  mercedes: 63, ferrari: 16, mclaren: 1, redbull: 3, alpine: 10,
  racingbulls: 30, haas: 31, williams: 55, audi: 27, astonmartin: 14,
  cadillac: 11,
};
// buildAtlas's override, else the team's own number, else 0 (custom team).
function resolveRaceNumber(numberOverride: number | string | null | undefined, teamId: TeamId): number | string {
  if (numberOverride != null) return numberOverride;
  return NUMBERS[teamId as string] != null ? NUMBERS[teamId as string]! : 0;
}

const teamShort = (id: TeamId): string => {
  const t = (deps.Teams !== undefined && deps.Teams.LIST || []).find((x) => x.id === id);
  return (t && t.short) || String(id || "").slice(0, 3).toUpperCase();
};

export const SPONSORS: Readonly<Record<string, readonly string[]>> = {
  redbull:     ["SKYSTRIKE", "ADRENYX", "VOLTRUSH", "AEROBOLT", "NITROX", "THUNDERA"],
  racingbulls: ["STRADALE", "VELOCE", "URBANO", "SCATTO", "NEONVIA", "RAGAZZO"],
  ferrari:     ["CAVALLO", "MODENESE", "AURELIO", "PRECISO", "SCUDERA", "HERALDO"],
  mclaren:     ["AEROCORE", "PIXLBYTE", "BRITECH", "ORBITAL", "NIMBUS", "QUANTIC"],
  mercedes:    ["VELTRA", "PRAZIS", "AUTOBAHN", "KELVIQ", "STROMTEK", "DIAMYX"],
  alpine:      ["CHAMONIX", "AZURELLE", "ALPIQ", "ESPRIT", "MISTRAL", "BLEUROC"],
  williams:    ["GROVEX", "ALBION", "STRATON", "OXFORD", "IRONOAK", "MERIDEN"],
  haas:        ["IRONGATE", "MILLWORX", "CARBIDE", "FORGECO", "TORQUEX", "RIVETON"],
  audi:        ["VORSPRUN", "ELEKTRA", "PRAZION", "INGOLTEK", "VOLTKERN", "NEURON"],
  astonmartin: ["VERDANCE", "GAYDONA", "AVIONNE", "REGALIS", "WINGCRAFT", "SAVILE"],
  cadillac:    ["DETROX", "CRESTLIN", "LIBERTA", "AMERIGO", "MOTORCTY", "GRANDEUR"],
};
// SPONSOR PACKS — a livery's `sponsors` key swaps the per-team table for one
// of these universal sets (texture only; the physical board is mesh).
// `clean` paints no wordmark at all: the test-livery look.
export const SPONSOR_PACKS: Readonly<Record<string, readonly string[]>> = {
  retro:  ["TURBOLIN", "CORSAVIA", "MOTORELLA", "PISTONIA", "CHEQUERS", "LAPKING"],
  tech:   ["QUBITWARE", "NEURALIX", "CLOUDFORGE", "SYNAPSE", "VECTORA", "LATTICE"],
  energy: ["VOLTSHOT", "FUSIONFUEL", "RAPTORADE", "KINETIQ", "SURGE", "IONBLAST"],
  clean:  [],
};
export const SPONSOR_PACK_IDS: readonly string[] = ["default", "retro", "tech", "energy", "clean"];
// NUMBER FONTS. Real numbers are the driver's own design — most are a bold
// italic — so the default stays today's italic Arial Narrow. Each recipe
// gives the CSS font for a size and how the glyph is layered.
const NUM_FONTS: Record<string, NumFont> & { default: NumFont } = {
  default: { font: (px: number) => "italic 900 " + px + "px 'Arial Narrow', Arial, sans-serif", style: "layered" },
  block:   { font: (px: number) => "900 " + px + "px 'Arial Black', Impact, Arial, sans-serif", style: "layered" },
  stencil: { font: (px: number) => "900 " + px + "px 'Arial Black', Impact, Arial, sans-serif", style: "stencil" },
  narrow:  { font: (px: number) => "800 " + px + "px 'Arial Narrow', 'Liberation Sans Narrow', Arial, sans-serif", style: "layered" },
  rounded: { font: (px: number) => "900 " + px + "px Verdana, 'DejaVu Sans', Arial, sans-serif", style: "rounded" },
  outline: { font: (px: number) => "italic 900 " + px + "px 'Arial Narrow', Arial, sans-serif", style: "outline" },
};
export const NUM_FONT_IDS: readonly string[] = Object.keys(NUM_FONTS);

// ── colour helpers ─────────────────────────────────────────────────────────
function to255(c: Col): [number, number, number] { return [
  Math.round(Math.max(0, Math.min(1, c[0]!)) * 255),
  Math.round(Math.max(0, Math.min(1, c[1]!)) * 255),
  Math.round(Math.max(0, Math.min(1, c[2]!)) * 255),
]; }
function css(c: Col): string { const r = to255(c); return "rgb(" + r[0] + "," + r[1] + "," + r[2] + ")"; }
function cssA(c: Col, a: number): string { const r = to255(c); return "rgba(" + r[0] + "," + r[1] + "," + r[2] + "," + a + ")"; }
// Relative luminance, WCAG-style. The channels MUST be linearised first —
// applying the Rec.709 coefficients straight to gamma-encoded sRGB (which this
// did) overstates mid-tones badly: 0.5 grey reads as luminance 0.5 when it is
// really 0.21. Every ink decision below hangs off this number.
function lin(u: number): number { return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); }
function lum(c: Col): number { return 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!); }
// WCAG contrast ratio, 1 (identical) .. 21 (black on white).
export function contrast(a: Col, b: Col): number {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const INK_DARK: Col = [0.06, 0.06, 0.08], INK_LIGHT: Col = [0.97, 0.97, 0.98];
const INK_TARGET = 6.5;
export function inkOn(bgs: readonly (OptCol | false)[]): Ink {
  const list = bgs.filter(Boolean) as Col[];
  // A COPY here too, and tagged: the shared constant would collect whatever
  // `worst` the next caller wrote onto it. Nothing to score against means
  // nothing to halo for, so Infinity, not a missing field.
  if (!list.length) { const any = INK_LIGHT.slice() as Ink; any.worst = Infinity; return any; }
  const worst = (ink: Col) => Math.min.apply(null, list.map((b) => contrast(ink, b)));
  const d = worst(INK_DARK), l = worst(INK_LIGHT);
  // COPY, never the shared constant: the caller tags the result with its
  // worst-case ratio, and handing back INK_DARK itself would let each region's
  // score overwrite the previous region's.
  const ink = (d >= l ? INK_DARK : INK_LIGHT).slice() as Ink;
  ink.worst = Math.max(d, l);
  return ink;
}
function haloFor(ink: Col): Col { return lum(ink) < 0.5 ? INK_LIGHT : INK_DARK; }

// Opaque underfill for a sponsor region. Glyph AA and generateMipmap both
// average into whatever sits under the ink: a transparent surround smears a
// soft dark fringe into every board letter (createTexture already documents
// the same trap for crests). Filling the region with the PANEL / plate /
// band colour the mesh already paints underneath keeps the mip blend on
// paint, and makes the whole decal quad opaque so its rim stays hard.
function fillRegion(ctx: LiveryCtx2D, R: LiveryRect | undefined, colour: OptCol): void {
  if (!R || !colour) return;
  ctx.fillStyle = css(colour);
  ctx.fillRect(R.x, R.y, R.w, R.h);
}

function drawWordmark(ctx: LiveryCtx2D, textIn: string | number | undefined, R: LiveryRect, ink: Col, opts: WordmarkOpts = {}): void {
  const pad = opts.pad != null ? opts.pad : 14;
  const spacing = opts.spacing != null ? opts.spacing : 0.06; // of font size
  const align = opts.align || "left";
  const maxW = R.w - pad * 2;
  const maxH = R.h - pad * 2;
  const text = String(textIn).toUpperCase();

  // Find a font size that fits both width (with spacing) and height.
  // Canvas text advance scales linearly with font px, so ONE reference
  // measurement gives the fitting size in closed form; the +-1 walk absorbs
  // hinting rounding and lands on exactly what a px-by-px descent would
  // choose, without its tens of thousands of measureText calls (every
  // character at every candidate size) in the first grid frame.
  const REF = 100;
  ctx.font = "900 " + REF + "px Arial, sans-serif";
  let refW = 0;
  for (let i = 0; i < text.length; i++) refW += ctx.measureText(text[i]!).width;
  const perPx = refW / REF + spacing * Math.max(0, text.length - 1);
  // Cap tracks SIZE (~0.16·SIZE was the old 160 at 1024) so a 2048 atlas
  // actually paints larger glyphs into the doubled board regions.
  const fontCap = Math.min(maxH, Math.round(SIZE * 0.16));
  let size = Math.max(8, Math.min(fontCap, Math.floor(maxW / (perPx || 1))));
  const fitsAt = (px: number) => {
    ctx.font = "900 " + px + "px Arial, sans-serif";
    let w = 0;
    for (let i = 0; i < text.length; i++) {
      w += ctx.measureText(text[i]!).width;
      if (i < text.length - 1) w += px * spacing;
    }
    return w <= maxW;
  };
  while (size > 8 && !fitsAt(size)) size--;
  while (size < fontCap && fitsAt(size + 1)) size++;
  ctx.font = "900 " + size + "px Arial, sans-serif";

  // Measure final width for alignment.
  let total = 0;
  const widths: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const cw = ctx.measureText(text[i]!).width;
    widths.push(cw);
    total += cw;
    if (i < text.length - 1) total += size * spacing;
  }
  let x = R.x + pad;
  if (align === "center") x = R.x + (R.w - total) / 2;
  else if (align === "right") x = R.x + R.w - pad - total;
  const y = R.y + R.h / 2;

  ctx.save();
  clipToRegion(ctx, R);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  // geometricPrecision keeps glyph outlines resolution-true; the default
  // "auto" hinting softens boards at garage / 3/4 distance.
  try { ctx.textRendering = "geometricPrecision"; } catch { /* older canvas */ }
  if (opts.halo) {
    // Legibility outline only — keep it thin and mitred. A round 0.13·size
    // stroke read as a soft cloud around every letter on the pale sidepod
    // board (SKYSTRIKE / NITROX BEFORE shots).
    ctx.strokeStyle = css(opts.halo);
    ctx.lineWidth = Math.max(1.25, size * 0.07);
    ctx.lineJoin = "miter";
    ctx.miterLimit = 2;
    let hx = x;
    for (let i = 0; i < text.length; i++) {
      ctx.strokeText(text[i]!, hx, y);
      hx += widths[i]! + size * spacing;
    }
  }
  ctx.fillStyle = css(ink);
  for (let i = 0; i < text.length; i++) {
    ctx.fillText(text[i]!, x, y);
    x += widths[i]! + size * spacing;
  }
  // Hairline same-ink stroke after the fill hardens the canvas AA fringe so
  // letters stay cut-vinyl crisp once the atlas is mipmapped and sampled at
  // a grazing garage angle. Skip when a contrast halo already outlined them
  // (that stroke is the rim; a second pass would fatten the glyph).
  if (!opts.halo) {
    ctx.strokeStyle = css(ink);
    ctx.lineWidth = Math.max(0.75, size * 0.035);
    ctx.lineJoin = "miter";
    ctx.miterLimit = 2;
    let sx = R.x + pad;
    if (align === "center") sx = R.x + (R.w - total) / 2;
    else if (align === "right") sx = R.x + R.w - pad - total;
    for (let i = 0; i < text.length; i++) {
      ctx.strokeText(text[i]!, sx, y);
      sx += widths[i]! + size * spacing;
    }
  }
  ctx.restore();
}

// Crest box on the number board (nose + both rear endplates). Same lockup as
// the spine / fin / garage wall, shrunk into the top of REGIONS.num so the
// digit still reads. Exported so crest-marks can assert the second-row colour
// lands here too, rather than restating the fractions.
export function numCrestBox(R?: LiveryRect): LiveryRect {
  R = R || REGIONS.num;
  const s = Math.round(Math.min(R.w, R.h) * 0.32);
  return { x: R.x + Math.round((R.w - s) / 2), y: R.y + Math.round(R.h * 0.08), w: s, h: s };
}
// Fraction of REGIONS.num reserved above the digit for numCrestBox. The box
// sits at 0.08 of the board and is 0.32 tall, plus a 2 px gutter.
const NUM_CREST_HEAD = 0.42;

function drawNumber(ctx: LiveryCtx2D, n: number | string, R: LiveryRect, ink: Col, accent: Col, bg: OptCol,
  fontId: string | null | undefined, reserveTop: number, halo?: OptCol): void {
  const recipe = NUM_FONTS[fontId as string] || NUM_FONTS.default;
  if (bg) {
    // Rounded number-board patch: base-paint fill + thin accent keyline.
    const m = 8, rad = 34;
    const x0 = R.x + m, y0 = R.y + m, w = R.w - m * 2, h = R.h - m * 2;
    ctx.beginPath();
    ctx.moveTo(x0 + rad, y0);
    ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, rad);
    ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, rad);
    ctx.arcTo(x0, y0 + h, x0, y0, rad);
    ctx.arcTo(x0, y0, x0 + w, y0, rad);
    ctx.closePath();
    ctx.fillStyle = css(bg);
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = cssA(accent, 0.9);
    ctx.stroke();
  }
  const head = reserveTop ? Math.round(R.h * reserveTop) : 0;
  const box = head ? { x: R.x, y: R.y + head, w: R.w, h: R.h - head } : R;
  const pad = 10;
  const maxH = box.h - pad * 2;
  const maxW = box.w - pad * 2;
  const text = String(n);
  const font = recipe.font;
  // Same closed-form + walk as drawWordmark: advance is linear in px.
  ctx.font = font(100);
  const refW = ctx.measureText(text).width / 100;
  let size = Math.max(8, Math.min(maxH, Math.floor(maxW / (refW || 1))));
  while (size > 8 && (ctx.font = font(size), ctx.measureText(text).width > maxW)) size--;
  while (size < maxH && (ctx.font = font(size + 1), ctx.measureText(text).width <= maxW)) size++;
  ctx.save();
  clipToRegion(ctx, box);
  ctx.font = font(size);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  // soft drop shadow (offset dark) for a painted-on depth cue
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.fillText(text, cx + size * 0.03, cy + size * 0.035);
  ctx.lineJoin = "round";
  if (halo) {
    // Legibility stroke under accent/fill — used when the digit stands on a
    // wrap sun or saddle edge the ink alone cannot clear.
    ctx.lineWidth = Math.max(8, size * 0.14);
    ctx.strokeStyle = css(halo);
    ctx.strokeText(text, cx, cy);
  }
  if (recipe.style === "outline") {
    // Hollow: a wide accent stroke with an ink core line and NO fill — the
    // base paint shows through the counters.
    ctx.lineWidth = Math.max(8, size * 0.11);
    ctx.strokeStyle = css(accent);
    ctx.strokeText(text, cx, cy);
    ctx.lineWidth = Math.max(3, size * 0.035);
    ctx.strokeStyle = css(ink);
    ctx.strokeText(text, cx, cy);
    ctx.restore();
    return;
  }
  if (recipe.style === "rounded") {
    // A soft ink halo under the fill, no hard keyline.
    ctx.lineWidth = Math.max(8, size * 0.12);
    ctx.strokeStyle = cssA(accent, 0.85);
    ctx.strokeText(text, cx, cy);
  } else {
    // bold accent outline behind the fill
    ctx.lineWidth = Math.max(6, size * 0.075);
    ctx.strokeStyle = css(accent);
    ctx.strokeText(text, cx, cy);
    // thin ink keyline hugging the accent for crisp separation
    ctx.lineWidth = Math.max(2, size * 0.02);
    ctx.strokeStyle = cssA(ink, 0.55);
    ctx.strokeText(text, cx, cy);
  }
  // main fill
  ctx.fillStyle = css(ink);
  ctx.fillText(text, cx, cy);
  if (recipe.style === "stencil") {
    // Stencil bridges: two horizontal cuts through the glyphs, back to the
    // base paint. Cut widths scale with the size so they survive the mips.
    const cut = Math.max(3, size * 0.045);
    // The cuts are only a stencil if they READ. `accent` is chosen to clear
    // the ink where it can, but its fallback is a best-effort pick that can
    // still land on the ink itself — and then the glyph is solid, not
    // stencilled. Take whichever backing actually separates; the ink's own
    // opposite is the guaranteed last resort.
    let cutC: Col = inkOn([ink]);
    if (bg && contrast(bg, ink) >= 2.0) cutC = bg;
    else if (contrast(accent, ink) >= 2.0) cutC = accent;
    ctx.fillStyle = css(cutC);
    ctx.fillRect(box.x, cy - size * 0.18 - cut / 2, box.w, cut);
    ctx.fillRect(box.x, cy + size * 0.2 - cut / 2, box.w, cut);
  }
  ctx.restore();
}

function fit(R: LiveryRect, margin?: number | null): LiveryFit {
  margin = margin != null ? margin : 0.1;
  const s = Math.min(R.w, R.h) * (1 - margin * 2);
  const ox = R.x + (R.w - s) / 2;
  const oy = R.y + (R.h - s) / 2;
  return {
    X: (u: number) => ox + u * s,
    Y: (v: number) => oy + v * s,
    S: (d: number) => d * s,
  };
}

// Clip the current path to a { x, y, w, h } region — every region painter
// below clips to its own rect before drawing so a halo or an oversized fill
// cannot bleed into the atlas gutter and the region next door.
function clipToRegion(ctx: LiveryCtx2D, R: LiveryRect): void {
  ctx.beginPath();
  ctx.rect(R.x, R.y, R.w, R.h);
  ctx.clip();
}

// ── one visual language for every mark ─────────────────────────────────────
// These four numbers are set by the SMALLEST place a crest is ever drawn, and
// that is not the shark fin at 160 px. buildAtlas downscales the whole atlas
// to 512 for the player and 256 for AI cars on the mobile tier, so the fin
// badge bottoms out at 40 px and the fit box at 34. Every floor below is that
// 34 px case expressed as a fraction of the box:
//   engine cover / garage lightbox 361-363 | cover mobile player 181
//   fin desktop 134 | cover mobile AI 90 | fin mobile player 67 | fin AI 34
export const CREST_MARGIN = 0.08;   // ONE margin for all twelve (was 0.04 .. 0.10)
// The flank mark's crest fills its box the way the parts tile's crest fills
// its tile — to 1.5 % of the edge — measured on the crest's OWN extent
// (flankEmblemBox), not on fit()'s square.
const FLANK_CREST_FILL = 1 - 0.015 * 2;
export const STROKE_MIN = 0.055;    // 1.9 px at 34: below this a limb does not get
                             // thinner, it disappears
export const TEXT_MIN = 0.22;       // 20 px at the mobile-AI cover. Lettering is
                             // banned outright when `bare`, so 34 never
                             // has to carry any

const BRAND = {
  // 0.855 -> 0.727 value, same hue. The re-trace gave Red Bull its real gold
  // SUN DISC as a `plate`, and a mark that sits on a plate is scored against
  // the plate — so the pair became red-on-yellow, which is 3.37:1 against the
  // 4.2 legibility floor every other team mark clears. Solved from the floor
  // rather than nudged: the gold's luminance is 0.6302, so 4.2 needs the mark
  // under 0.1119 and this is 0.1060, landing at 4.36. Checked across all 1514
  // team x livery palettes (0 fail), racingbulls included — it borrows this
  // red as its `alt` and is the only other consumer.
  rbRed:    [0.727, 0.037, 0.073],
  rbGold:   [1.0,   0.788, 0.024],
  rbNavy:   [0.043, 0.078, 0.239],
  ferYellow:[1.0,   0.925, 0.0],
  papaya:   [1.0,   0.525, 0.0],
  triBlue:  [0.0,   0.259, 0.639],
  triRed:   [0.937, 0.255, 0.208],
  haasRed:  [0.859, 0.098, 0.145],
  cadGold:  [0.788, 0.643, 0.353],
};

// ── the mark palette ───────────────────────────────────────────────────────
// A team's OWN mark colours. These apply on ONE livery: the team's own, which
// Liveries.forTeam synthesizes as { id: "default", c1: team.color, ... }. Pick
// any other paint job and the mark re-colours from THAT livery instead,
// because a Petronas-teal star on a Candy Flip car is not a livery, it is a
// sticker someone forgot to change. `plate` is the backing shield/disc the
// mark sits on, or null for the marks that have none.
const MARK_BRAND: Record<string, Brand> = {
  mercedes:    { mark: [0.85, 0.86, 0.88],   alt: [0.0, 0.706, 0.671],   plate: null },
  ferrari:     { mark: [0.05, 0.05, 0.06],   alt: [0.05, 0.05, 0.06],    plate: BRAND.ferYellow },
  mclaren:     { mark: BRAND.papaya,         alt: [0.06, 0.06, 0.08],    plate: null },
  redbull:     { mark: BRAND.rbRed,          alt: BRAND.rbNavy,          plate: BRAND.rbGold },
  alpine:      { mark: [0.0, 0.576, 0.8],    alt: [1.0, 0.529, 0.737],   plate: null },
  racingbulls: { mark: [0.086, 0.204, 0.796], alt: BRAND.rbRed,          plate: null },
  haas:        { mark: [0.97, 0.97, 0.98],   alt: BRAND.haasRed,         plate: null },
  williams:    { mark: [0.97, 0.97, 0.98],   alt: [0.059, 0.235, 0.788], plate: null },
  audi:        { mark: [0.93, 0.93, 0.95],   alt: [0.98, 0.28, 0.05],    plate: null },
  astonmartin: { mark: [0.718, 0.882, 0.106], alt: [0.0, 0.349, 0.31],   plate: null },
  cadillac:    { mark: BRAND.cadGold,        alt: [0.05, 0.05, 0.06],    plate: null },
};
// Authored crest geometry the TRACE could not carry, keyed by team. A traced
// layer's mask is the whole silhouette in one ink, so Red Bull's gold cluster
// came back as the UNION of the sun and both bulls — a dilated outline, not a
// disc. Painting that with the SUN DISC colour rimmed the bulls in gold and
// drew no sun, which is exactly what it looked like. The sun IS a circle, and
// the trace says so to three decimals: layer 0 spanned y 0.308..0.688 at
// x 0.5 (centre 0.498, r 0.190) and was 0.106 half-wide at dy 0.158, where a
// circle of r 0.190 is 0.105. So it is drawn as one.
//
// A disc is also the one backing that SURVIVES the fin badge. Plates are
// dropped there because a shield behind a mark at 34 px is a panel, not a
// mark — but a circle the bulls straddle reads at any size, and dropping it
// was what turned SUN DISC into an outline on that surface.
export const CREST_DISC: Readonly<Record<string, { cx: number; cy: number; r: number }>> = Object.freeze({
  redbull: { cx: 0.494, cy: 0.498, r: 0.190 },
});
// CrestPaths is a separate script-tag global (js/car/crest-paths.js); the
// typeof guard is the standalone-harness fallback (no traced mark), same
// reasoning as IS_MOBILE above.
function crestSpecFor(teamId: TeamId) {
  return CrestPaths[crestKey(teamId)];
}
// A LEGENDS car wears its legend's MARQUE crest — Senna's McLaren,
// Schumacher's Ferrari — not a monogram of its slot id: "legends" (the
// player's row) drew LGD and "legend_<id>" (a duel rival) LEG, on the car,
// the garage wall and the livery cards; only the TEAM picker tile read the
// marque. Every per-mark table here (CrestPaths, CRESTS, CREST_DISC,
// MARK_BRAND, MARK_PARTS) is read through this key; the PAINT stays the
// legend's own tribute livery. A legend whose marque is a wordmark (Lotus,
// Tyrrell, Vanwall: js/data/legends.js marque null) keeps the generic
// monogram, lettered with the team's NAME (crestGeneric), not "LGD".
function legendOf(teamId: TeamId): TexLegend | null | undefined {
  const id = String(teamId || "");
  const Legends = deps.Legends;
  if (Legends === undefined || !Legends.byId) return null;
  if (id === "legends") {
    const t = (deps.Teams !== undefined && deps.Teams.LIST || []).find((x) => x.id === "legends");
    return t && t.legend ? Legends.byId(t.legend) : null;
  }
  return id.indexOf("legend_") === 0 ? Legends.byId(id.slice(7)) : null;
}
function crestKey(teamId: TeamId): string {
  const l = legendOf(teamId);
  return l && l.marque ? l.marque : teamId as string;
}
// A plate that stays on the shark-fin badge, not only on the engine cover.
// Red Bull's sun is authored (the trace could not carry a disc). Ferrari's
// shield is a traced `plate` role. Dropping either on the fin made the tail
// a different logo than the spine / garage wall — HORSE without SHIELD.
export function crestKeepsPlate(teamId: TeamId): boolean {
  if (CREST_DISC[crestKey(teamId)]) return true;
  const spec = crestSpecFor(teamId);
  return !!(spec && spec.roles && spec.roles.includes("plate"));
}

// The floor every mark clears against whatever it lands on. 4.2 and not
// the general 3.0 ink floor because it is also the bound parts-livery-contrast.spec.js
// proves for the sponsor inks, and two legibility guards that disagree drift.
// It is always reachable: the worst field for inkOn() is luminance 0.182,
// where black and white tie at 4.25.
export const MARK_FLOOR = 4.2;
// The floor a metre-long BAND clears against the cover it lands on — 2.0,
// not the general ink floor: these are bands, not lettering, and Red Bull's bull
// measures 2.26 against its navy and reads clearly on track
// (tools/shot/shot.mjs --team). Module-scoped because
// drawSpineTop asks it too: a band UNDER it is carried by its trim.
const BAND_ON_COVER = 2.0;
// What a PLATE (a shield, a disc, a panel) must clear against the paint it
// sits on — markPalette's floor for a derived backing, and the flank's test
// for whether the brand plate comes along at all.
const PLATE_ON_PAINT = 1.6;
// 25 rungs, not 9. The windows this has to hit are narrow: a teal mark on a
// near-black field leaves only luminance 0.143..0.199 for a neutral that
// separates from both, and a coarse ramp steps straight over it.
const GREYS: number[] = [];
for (let i = 0; i < 25; i++) GREYS.push(0.02 + i * (0.96 / 24));

// PHASE 1, field-blind: what colour does this team's mark WANT to be on this
// livery? Exported because the garage lightbox has to choose its field BEFORE
// it can ask for a palette, and a logo PNG's average pixel is null the
// moment a team has no PNG.
// WHERE does a mark's second colour live? Every mark has a dominant shape and
// at most one other coloured element, but that element is a different thing
// per mark, so one editor row has to resolve to four different slots:
//   plate    redbull's sun disc, ferrari's yellow shield — a backing
//   alt      cadillac's second traced layer, haas's ring, the monogram box
//   part     a same-ink shape: racing bulls' bull, the Mercedes ring, Audi's
//            second and fourth rings. Unset it IS the mark, so the crest
//            ships pixel-identical and the slot is pure opt-in
//   outline  the four single-loop silhouettes (mclaren, williams, alpine,
//            astonmartin), which have nowhere for a second colour to GO.
//            Those marks offer no DETAIL row at all now — see markSlots — so
//            this is reached only by a livery saved before the outline had a
//            row of its own, and by the surfaces below
// Derived from the traced role data where there is any, so re-running
// tools/car/trace-logo.mjs cannot leave this table lying. The three hand-drawn
// marks have no trace to derive from and are named here instead.
const SECOND_DRAWN: Record<string, string> = { haas: "alt", mercedes: "part", audi: "part" };
function secondSlot(teamId: TeamId, bare: boolean): string {
  const spec = crestSpecFor(teamId);
  const roles = spec && spec.roles;
  let slot;
  // `part` ranks above `plate` and below `alt`: a mark that has a real
  // same-ink island to paint should spend the DETAIL row on that island
  // rather than on a shadow rim, which is all `outline` ever was.
  // CREST_DISC counts as a plate and the TRACE cannot know it: Red Bull's
  // backing is authored precisely because the traced one was not a sun, and
  // reading roles alone here sent SUN DISC straight back to the outline.
  if (!roles) slot = SECOND_DRAWN[crestKey(teamId)] || "alt";   // the monogram's box is `alt`
  else if (roles.includes("alt")) slot = "alt";
  else if (roles.includes("part")) slot = "part";
  else slot = (roles.includes("plate") || CREST_DISC[crestKey(teamId)]) ? "plate" : "outline";
  if (!bare) return slot;
  // A slot nothing paints is a dead colour picker and falls through to the
  // outline. Haas's ring and the monogram box are not in that set (no
  // !bare gate): they draw on the badge so RING / MONOGRAM BOX match the
  // spine and the wall. Cadillac's alt is traced and always painted.
  if (slot === "plate" && !crestKeepsPlate(teamId)) return "outline";
  if (slot === "alt" && !(roles && roles.includes("alt")) &&
      teamId !== "haas" && teamId !== "custom") return "outline";
  return slot;
}

// Which marks paint their `alt` INSIDE the mark rather than beside it.
// Empty today: every mark's alt scores against the field it stands on AND
// the mark itself — even Cadillac's eight detail layers, whose 99.4% of
// area sits on its crest (measured over a 900x900 sample of the traced
// paths), still score against the field: nothing in the pool cleared 2.4
// there either, so the grey ramp answers regardless. Haas's ring and the
// generic monogram's box stand on the field beside their letters, same
// scoring, same reason. An entry here would switch a team to mark-only.
export const ALT_INSIDE: Record<string, unknown> = {};

// What actually LANDS on the surface behind a crest. A backlit sign picks its
// field for contrast, and the honest question is not "what colour is the
// mark" but "what touches the wall": Ferrari's horse stands on a yellow
// shield, so asking about the HORSE chose a white lightbox, and a white field
// then rejected the shield itself (1.07, under the 1.6 plate floor) and
// painted it red. A DISC answers with the pair — Red Bull's bulls hang off
// the sun, so both land on the field.
// Only meaningful on a team's OWN livery, where the backing is brand data;
// any other paint job derives its plate INSIDE markPalette, scored against
// the very field this would be choosing.
export function markOnField(teamId: TeamId, liv?: TexLivery | null): number[][] {
  const own = !liv || liv.id === "default";
  const B = (own && MARK_BRAND[crestKey(teamId)]) || null;
  const mark = markBase(teamId, liv);
  if (!B || !B.plate) return [mark];
  return CREST_DISC[crestKey(teamId)] ? [B.plate.slice(), mark] : [B.plate.slice()];
}

export function markBase(teamId: TeamId, liv?: TexLivery | null): number[] {
  if (liv && liv.logo) return liv.logo.slice();
  const own = !liv || liv.id === "default";
  const b = own && MARK_BRAND[crestKey(teamId)];
  if (b) return b.mark.slice();
  // Bases only — BODY STRIPE / DETAIL are other rows and must not recolour
  // the mark when logo is unset.
  return ((liv && (liv.c2 || liv.c1)) || INK_LIGHT).slice();
}

// PHASE 2, field-aware: ONE source of truth for every colour a crest paints.
//   mark  the dominant shape — what a reader calls "the logo"
//   alt   counters, the second colour, keylines, lettering. Separates from
//         BOTH `mark` and whatever is behind it
//   plate the backing shield/disc/panel, or null. Never a shape that has to
//         read on its own. Always null when `bare`
//   halo  a colour to stroke UNDER the mark, or null. Non-null only for a
//         DERIVED mark (no authored logo, not the brand table) that sits
//         under INK_TARGET. Authored logo / logo2 / logo3 and brand marks
//         paint exactly as selected — no floor, no auto-halo.
// ALL FOUR ARE OPAQUE. A crest may not paint with alpha: behind the atlas is
// drawTailGraphic's gradient, so an alpha fill's effective colour is
// unprovable and no contrast guarantee survives it.
// `opts.noPlate` — the caller is going to draw this mark WITHOUT its backing,
// so resolve it that way instead of resolving it WITH a plate and deleting the
// field afterwards. That was the bug: `under` is `[plate]` when a plate
// resolves (correctly — an opaque plate is what the mark lands on), so the two
// plate-less call sites got a mark chosen to read on a backing they then threw
// away. Measured: Ferrari's `bigmark` horse came out rgb(242,245,250) on a
// #f2f5fa cover, 1.00:1, the cover's own colour, on 59 of its 69 liveries.
// `bare` is NOT this flag and cannot stand in for it — crestKeepsPlate keeps
// the shield through `bare: true` on exactly the marks that have one.
export function markPalette(teamId: TeamId, liv: TexLivery | null | undefined, field: unknown, bare: boolean,
  opts?: { noPlate?: boolean } | null): MarkPalette {
  const own = !liv || liv.id === "default";
  const B = (own && MARK_BRAND[crestKey(teamId)]) || null;
  // `field` may be ONE paint or a list of them, and the engine cover needs a
  // list: drawTailGraphic washes that region with an ALPHA gradient of
  // stripe||c2, so what the mark actually lands on runs from c1 to a c2 tint
  // across the panel. This is the same pair INKED_FOR declares in
  // parts-livery-contrast.spec.js. Score against the WORST of them.
  // An rgb triple is itself an Array, so "is the first element an Array" is
  // NOT "is this a list of paints" — it is also true of one colour. A partial
  // livery (no c1/c2) arrives as `[undefined, undefined]`; failing that test
  // would wrap the whole list as one "colour", leave `alt` null, and crash
  // `alt.slice()` the moment SPINE TOP `wrap` asks sunColour → markPalette
  // (CARVIEW.set({livery:{spineLogo:"wrap"}})).
  const isRgb = (c: unknown): c is Col => Array.isArray(c) && c.length >= 3 && typeof c[0] === "number";
  const flds = ((): Col[] => {
    if (isRgb(field)) return [field];
    if (Array.isArray(field)) {
      const paints = field.filter(isRgb);
      return paints.length ? paints : [INK_DARK];
    }
    return [INK_DARK];
  })();
  const cMin = (c: Col, list: readonly Col[]) => {
    let m = Infinity;
    for (const f of list) m = Math.min(m, contrast(c, f));
    return m;
  };
  // 1. plate first — when there is one, it is what the mark actually lands on.
  //    WHETHER there is one is a property of the MARK, not of the livery: four
  //    crests are drawn on a shield or a disc and seven are not. Deriving a
  //    plate from the livery for all of them put a lime panel behind the Aston
  //    wings, which then had to flip colour to contrast a plate it never asked
  //    for. A null brand plate means "this mark has no backing", permanently.
  const wantsPlate = !!(MARK_BRAND[crestKey(teamId)] && MARK_BRAND[crestKey(teamId)]!.plate);
  const disc = CREST_DISC[crestKey(teamId)] || null;
  const keepPlate = crestKeepsPlate(teamId);
  const slot2 = secondSlot(teamId, bare);
  let plate: number[] | null = null;
  // `noPlate` drops the DERIVED / brand shield on call sites that paint the
  // mark bare (flank logo/emblem on a saddle field) — Ferrari's yellow plate
  // was 1.09:1 on a white saddle. It must NOT swallow an authored LOGO DETAIL:
  // that row is the player's plate colour, and skipping it made TEAM LOGO /
  // LOGO DETAIL edits update the crown while the side spine mark stayed stuck.
  if (wantsPlate && (!bare || keepPlate)) {
    if (slot2 === "plate" && liv && liv.logo2) plate = liv.logo2.slice();
    else if (!(opts && opts.noPlate)) {
      // A brand DISC wins outright, contrast unscored. The 1.6 floor below asks
      // a backing to separate from the paint, which is the right question for a
      // PANEL the mark sits on and the wrong one for a sun: Red Bull's fin
      // field is the team's own yellow, gold scores 1.10 against it, and the
      // floor answered by swapping in a navy disc and bleaching the bulls white
      // to read on it. The disc is identity; legibility is the MARK's floor,
      // and `under` now holds both the disc and the paint so it is really
      // asked. Only reachable on the team's own livery — B is null on any other.
      if (keepPlate && B && B.plate) plate = B.plate.slice();
      else {
        // Bases / brand only — SIDEPOD is its own mesh row.
        const cands = [B && B.plate, liv && liv.c1, liv && liv.c2];
        // Against the PRIMARY paint only. A plate is opaque and covers whatever
        // wash is on top of the panel, so asking it to separate from the wash
        // colour too rejects the Red Bull gold disc on a gold-accented livery
        // and leaves the bulls floating with nothing behind them.
        for (const c of cands) if (c && contrast(c, flds[0]!) >= PLATE_ON_PAINT) { plate = c.slice(); break; }
      }
    }
  }
  // An opaque plate REPLACES everything behind it, so it becomes the only
  // surface that matters; without one the mark still faces the whole list.
  // A DISC is the case where both are true at once: Red Bull's bulls straddle
  // the sun, so their heads and tails land on the car paint no matter what
  // colour the disc is. Scoring them against the disc alone was survivable
  // only while the trace also painted a gold silhouette under every limb —
  // that layer is gone (it was never a sun), so the overhang is now real and
  // the field has to stay in the list.
  let under: Col[] = flds;
  if (plate) under = disc ? ([plate] as Col[]).concat(flds) : [plate];
  // 2. mark, floored against `under` — EXCEPT on a team's own brand pairing.
  //    Red Bull's red bulls on their gold disc score 3.25, so the floor threw
  //    the red away and painted the bulls navy: a legibility rule that had
  //    destroyed the one thing it was protecting. A brand mark on its own
  //    brand plate is a pairing someone designed, and the plate exists to
  //    carry it; the floor is there to defend against ARBITRARY livery paint,
  //    which is still every other case below. The plate itself must still
  //    clear the field, so the lockup can never vanish as a whole.
  let mark: number[] | null = markBase(teamId, liv);
  const brandPair = !!(B && plate && B.plate &&
    plate.join() === B.plate.join() && mark.join() === B.mark.join());
  // Mark colour is free when authored (liv.logo). Brand-table marks still
  // floor against the field so stock cars (Mercedes star on silver, etc.)
  // stay readable; brandPair (mark on its own plate) stays exempt.
  const authoredLogo = !!(liv && liv.logo);
  const brandMark = !!(B && mark.join() === B.mark.join());
  // FREE = the colour is never substituted, for an authored TEAM LOGO and
  // for a brand-table mark alike. The cost is measured and registered, not
  // hidden: a brand mark that matches its own cover (Mercedes' silver star on
  // a silver cover, McLaren's papaya speedmark on papaya) now reads 0 % of the
  // crown to cover-legibility, which scores painted AREA against the cover.
  // crest-marks scores the mark+HALO pair instead, so the two instruments
  // disagree about whether an outline counts; the gaps are entered in
  // cover-legibility's KNOWN register with that measurement, so removing the
  // disagreement (either way) makes a test fail and forces the decision.
  const freeMark = authoredLogo || brandMark;
  if (!brandPair && !freeMark && cMin(mark, under) < MARK_FLOOR) {
    const alts = [B && B.mark, liv && liv.c2, liv && liv.c1];
    mark = null;
    for (const c of alts) if (c && cMin(c, under) >= MARK_FLOOR) { mark = c.slice(); break; }
    if (!mark) mark = inkOn(under).slice();
  }
  // 3. alt, scored against `under` AND `mark` — a second colour that vanishes
  //    into either one is not a second colour. The grey ramp is the fallback
  //    that makes this total: no pair of colours is close to all nine.
  // Scored against the primary surface, which is the one alt is asserted on:
  // optimising for a worst case nobody checks just makes alt duller.
  const score = (c: Col) => Math.min(contrast(c, under[0]!), contrast(c, mark!));
  let alt: Col | null = null, best = -1;
  const pool = [B && B.alt, liv && liv.c2, liv && liv.c1, INK_LIGHT, INK_DARK];
  for (const c of pool) { if (!c) continue; const v = score(c); if (v > best) { best = v; alt = c; } }
  if (best < 2.4) for (const g of GREYS) {
    const c = [g, g, g], v = score(c);
    if (v > best) { best = v; alt = c; }
  }
  // score() is NaN when `under`/`mark` were empty or non-rgb (partial
  // livery); every candidate then loses to `best = -1` and alt stays null.
  // A second colour that cannot be chosen is still a colour the crest path
  // slices — never hand null out of markPalette.
  if (!alt) alt = haloFor(mark || INK_DARK);
  // An authored LOGO DETAIL colour, landed in whichever slot this mark's
  // second colour actually occupies. `alt` is taken as given for the same
  // reason `plate` is — it is a colour the player chose, and the shapes it
  // paints (counters, a ring, a keyline) are secondary by construction.
  let part: number[] | null = null;
  if (liv && liv.logo2) {
    if (slot2 === "alt") alt = liv.logo2;
    // A same-ink island. Null unless authored, and crestTraced falls back to
    // the mark for it, so an unset LOGO DETAIL leaves the crest exactly as it
    // ships — the same opt-in bargain `outline` makes below.
    if (slot2 === "part") part = liv.logo2.slice();
    // slot2 === "plate" was handled where the plate is resolved.
  }
  // The OUTLINE row (liv.logo3), offered on every mark now rather than only
  // on the ones with nowhere else to put a second colour — see the property
  // below for the full reasoning. `logo2` still lands here for the marks
  // whose construction drops their second shape (secondSlot's `outline`).
  let outline: number[] | null = null;
  if (liv && liv.logo3) outline = liv.logo3.slice();
  else if (liv && liv.logo2 && slot2 === "outline") outline = liv.logo2.slice();
  return {
    mark: mark.slice(), alt: alt.slice(), plate: plate, part,
    brandPair, brandMark, freeMark,
    // What the mark ACTUALLY sits on, after the plate has been resolved: the
    // one list every legibility question here is asked against. Exported
    // so the tests do not re-derive it: `plate ? [plate] : fields` is wrong
    // once a backing can be a DISC the mark hangs off the edges of.
    under: under.map((c) => c.slice()),
    // A FREE mark takes NO auto-halo: the pick is the paint, and an outline
    // nobody asked for is a second decision about their colour. (PR #120's
    // spec said "halo if weak"; this supersedes that half of it, and the
    // legibility cost is registered in cover-legibility's KNOWN list.)
    halo: freeMark || part ? null : (() => {
      if (brandPair || cMin(mark!, under) >= INK_TARGET) return null;
      return haloFor(mark!).slice();
    })(),
    // A rim is a detail in its own right: a gold-rimmed horse on a red
    // shield is a thing a player asks for, and before this row the only way
    // to get one was to own a mark that had no second shape to spend the
    // colour on. Null keeps every shipped mark pixel-identical, which is why
    // it is opt-in. Ferrari's shield stays a plate on the badge; liveries
    // saved before OUTLINE had a key of its own carry the colour in logo2,
    // and dropping that on read would blank a paint job someone saved.
    outline,
  };
}

export const { CRESTS, crestGeneric, tracePath } = LiveryCrests.create({ css, fit, drawWordmark, teamShort, crestSpecFor, crestKey, legendOf,
  CREST_DISC, CREST_MARGIN, STROKE_MIN, TEXT_MIN });

// ── the custom team's uploaded emblem ──────────────────────────────────────
// ONE entry, "custom", set by MY TEAM's file picker (js/game.js) through
// setTeamLogo. The eleven shipped teams no longer come through here: they used
// to be prefetched from assets/logos/<id>.png, and those files were traced
// auto-conversions — haas.png was a solid red disc with the H's counters
// filled in, audi.png four filled blobs, four more were near-white and one
// near-black. A mark whose shape is gone cannot be repaired by lighting, a
// field colour or a halo, so the roster draws the vector crests above, which
// scale to any size and take the livery's own colours.
export const LOGOS: Record<string, LiveryLogo> = Object.create(null) as Record<string, LiveryLogo>;
const markReady: (() => void)[] = [];
// Named for what it now means: the CUSTOM mark changed, drop your cached
// textures. It was onLogosReady, fired once when eleven prefetched PNGs
// landed together — a name that would be a lie now that only one mark can
// ever change, and only when a player picks a file.
export function onMarkChange(cb: unknown): void { if (typeof cb === "function") markReady.push(cb as () => void); }

// What each logo picker actually PAINTS on this team's mark, so the editor can
// say so. "LOGO DETAIL" is true but useless: on Racing Bulls it paints the
// bull, on Red Bull the sun disc between the bulls, on Ferrari the shield.
// A label that names the shape is the difference between a colour picker and
// a guess — and a label that names a shape the mark does not HAVE is worse
// than either, which is what "SUN DISC" was while the trace's union
// silhouette stood in for the sun.
//
// [dominant, second] — a null second means this mark is one closed loop and
// genuinely has no other element (mclaren's speedmark, williams' W, alpine's
// A, aston's wings are each a single traced contour, measured). Those marks
// offer the OUTLINE row and nothing in between, rather than a DETAIL picker
// that can only ever produce a rim.
const MARK_PARTS: Readonly<Record<string, readonly [string, string | null]>> = Object.freeze({
  redbull:     ["BULLS", "SUN DISC"],
  ferrari:     ["HORSE", "SHIELD"],
  racingbulls: ["RB LETTERS", "BULL"],
  cadillac:    ["CREST", "INNER DETAIL"],
  haas:        ["MONOGRAM", "RING"],
  mercedes:    ["STAR", "RING"],
  audi:        ["RINGS", "2ND & 4TH RING"],
  mclaren:     ["SPEEDMARK", null],
  williams:    ["W MARK", null],
  alpine:      ["A MARK", null],
  astonmartin: ["WINGS", null],
  // The custom team's mark is the generic monogram, whose second colour is
  // the box stroke around the letters. An UPLOADED emblem is arbitrary art
  // with no second element at all — its DETAIL row paints nothing and its
  // OUTLINE row rims it, which is the same bargain a single-loop crest makes.
  custom:      ["MONOGRAM", "MONOGRAM BOX"],
});
// The editor's mark rows, in order, for THIS team. Two or three of them: the
// dominant shape, the second shape when the mark has one, and the outline,
// which every mark can take. Callers must not assume a length — that
// assumption is what kept the outline sharing a row with the sun disc.
export function markSlots(teamId: TeamId): { key: string; label: string }[] {
  // An UPLOADED emblem replaces the mark entirely — buildAtlas takes the
  // drawLogoImage branch and the monogram is never drawn — and that function
  // has no parameter for a second shape: (ctx, img, R, tint, halo, outline).
  // So the second row is a picker that cannot paint, which is the whole
  // failure this table exists to prevent. It also renames the first: with an
  // emblem on the car, `logo` TINTS arbitrary art rather than colouring a
  // monogram. Keyed on LOGOS, so it follows an upload or a CLEAR — MY TEAM
  // re-asks on onMarkChange (the emblem decodes asynchronously, so the file
  // picker's own handler is too early), and the GARAGE editor re-asks
  // whenever buildSetup runs, which it does on entering that screen.
  if (LOGOS[teamId as string]) return [{ key: "logo", label: "EMBLEM TINT" },
                             { key: "logo3", label: "OUTLINE" }];
  const named: readonly (string | null)[] = MARK_PARTS[crestKey(teamId)] || [];
  const rows = [{ key: "logo", label: named[0] || "TEAM LOGO" }];
  if (named[1]) rows.push({ key: "logo2", label: named[1] });
  rows.push({ key: "logo3", label: "OUTLINE" });
  return rows;
}
function markChanged() { for (const cb of markReady) { try { cb(); } catch { /* one bad listener must not block the rest */ } } }

const logoGen: Record<string, number> = Object.create(null) as Record<string, number>;   // per team: the newest setTeamLogo call; an older decode finishing late is ignored
// An upload is redrawn to <= 384 px (custom-team.js CUSTOM_LOGO_MAX), but an
// IMPORTED customLogo is gated by byte length only: a 43 KB PNG can declare
// 16384² (1 GiB RGBA), decoded on every boot. onload has the header size and
// no pixels yet; the first drawImage is the full decode — refuse it before.
const LOGO_MAX_PX = 1024 * 1024;
export function setTeamLogo(id: string, src: string | null | undefined): void {
  const gen = logoGen[id] = (logoGen[id] || 0) + 1;
  if (!src) { delete LOGOS[id]; markChanged(); return; }
  const newImage = deps.createImage || (typeof Image !== "undefined" ? () => new Image() as unknown as LiveryImage : undefined);
  if (newImage === undefined) return;
  const img = newImage();
  img.onload = () => {
    if (logoGen[id] !== gen) return;   // CLEARed or replaced while this one decoded: never reinstall the stale emblem
    if (img.naturalWidth * img.naturalHeight > LOGO_MAX_PX) { img.onerror!(); return; }
    img._avg = avgColour(img);
    LOGOS[id] = img;
    markChanged();
  };
  // A corrupt or oversized data URL must not leave the PREVIOUS emblem in
  // place silently (the picker would look like it had done nothing). This is
  // the only image path in the file, so it is the whole failure mode of the
  // custom-emblem feature. Drop the stale mark and tell the caches.
  img.onerror = () => { if (logoGen[id] !== gen) return; delete LOGOS[id]; markChanged(); };
  img.src = src;
}

function avgColour(img: LiveryLogo): Col | null {
  try {
    const n = 32, c = makeCanvas();
    c.width = c.height = n;
    const cx = c.getContext("2d", { willReadFrequently: true })!;
    cx.drawImage(img, 0, 0, n, n);
    const d = cx.getImageData!(0, 0, n, n).data;
    let r = 0, g = 0, b = 0, w = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3]! / 255;
      if (a < 0.35) continue;
      r += d[i]! * a; g += d[i + 1]! * a; b += d[i + 2]! * a; w += a;
    }
    return w ? [r / w / 255, g / w / 255, b / w / 255] : null;
  } catch { return null; }
}
// An UPLOADED emblem is the one mark that never goes through markPalette —
// it is arbitrary art, so there is no second element to recolour. It takes
// the OUTLINE row (liv.logo3) as a rim, the same meaning a single-loop crest
// gives it. Every caller passes logo3 ALONE — LOGO DETAIL (logo2) is the
// mark's second shape and never a rim here (as a fallback it would outline
// uploaded emblems in the shield tint).
//
// Resolving the painted source FIRST gives a tinted emblem the legibility
// halo too — an early `return` from a tinted branch would skip it for
// exactly the uploads most likely to need it. One source, one set of
// passes, both cases.
export function drawLogoImage(ctx: LiveryCtx2D, img: LiveryLogo, R: LiveryRect, tint: OptCol, halo: OptCol, outline: OptCol): void {
  // CLIP FIRST. The halo below is five passes of up to 14 px blur, which
  // reaches ~5 px outside R — across the atlas gutter and into whatever
  // region is next door (finBadge bled onto the sidepod strip). Every other
  // region painter clips to its own rect; this one never did.
  ctx.save();
  clipToRegion(ctx, R);
  const pad = 0.015, bw = R.w * (1 - pad * 2), bh = R.h * (1 - pad * 2);
  const sc = Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
  const w = img.naturalWidth * sc, h = img.naturalHeight * sc;
  const x = R.x + (R.w - w) / 2, y = R.y + (R.h - h) / 2;
  let src: LiveryDrawable = img;
  if (tint) {
    const off = makeCanvas();
    off.width = Math.max(1, Math.round(w)); off.height = Math.max(1, Math.round(h));
    const oc = off.getContext("2d")!;
    oc.drawImage(img, 0, 0, off.width, off.height);
    oc.globalCompositeOperation = "source-in";
    oc.fillStyle = css(tint);
    oc.fillRect(0, 0, off.width, off.height);
    src = off;
  }
  // Halo outside, outline inside — the same order and the same reason as
  // drawCrest, so an emblem needing both reads the way a crest does.
  const pass = (col: Col, blur: number, n: number) => {
    ctx.save();
    ctx.shadowColor = css(col);
    ctx.shadowBlur = blur;
    for (let i = 0; i < n; i++) ctx.drawImage(src, x, y, w, h);
    ctx.restore();
  };
  // Same cap, same reason — more sharply, because this one is 8.5% over FIVE
  // passes: an uploaded emblem 400 px wide was wearing a 34 px halo.
  if (halo) pass(halo, Math.max(4, Math.min(w * 0.085, 14)), 5);
  if (outline) pass(outline, Math.max(2, Math.min(w * 0.030, 8)), 3);
  ctx.drawImage(src, x, y, w, h);
  ctx.restore();
}

// drawCrest(ctx, teamId, R, { liv, field, bare, palette })
//   liv     the resolved livery — needs its `id`, which is how the brand-vs-
//           livery decision is made (see markPalette)
//   field   the paint the mark lands on: c1 on the engine cover, fin||c2 on
//           the badge, the lightbox field in the garage
//   bare    shark-fin mode
//   palette pre-resolved, for the sweep tool
// This replaces an (ink, accent, bare, logo, bg) quintet that reached the
// crests through three module-level variables and a try/finally, because
// several marks painted in a baked BRAND colour that no argument could
// override. Now every colour a crest can paint comes from P, which is what
// makes the census in tests/unit/crest-marks.test.mjs possible at all.
export function drawCrest(ctx: LiveryCtx2D, teamId: TeamId, R: LiveryRect, opts?: CrestOpts | null): void {
  const o: CrestOpts = opts || {};
  const P = o.palette || markPalette(teamId, o.liv, o.field, !!o.bare);
  const fn = CRESTS[crestKey(teamId)] || crestGeneric;
  // The halo is generic on purpose: the same repeated-draw-under-shadow trick
  // drawLogoImage uses, so a mark that cannot reach INK_TARGET gets separated
  // without every crest having to grow its own outline pass.
  if (P.halo) {
    ctx.save();
    ctx.shadowColor = css(P.halo);
    // CAPPED, and the cap is what makes this an outline instead of weather.
    // A flat 5% of the box is 8 px on the 160 px fin badge — a rim — but
    // 21.5 px on the 430 px engine cover, and three accumulated shadow
    // passes at that radius spread into a soft cloud: Williams' dark W sat
    // in a white haze covering a third of the cover (rendered, not guessed).
    // McLaren never showed it only
    // because its halo resolves DARK against dark paint. 10 px leaves every
    // surface at or below the badge's 8 px untouched and halves the cover,
    // and the halo's job is unaffected: legibility here is a COLOUR
    // guarantee (mark-or-halo per background, crest-marks.test.mjs), not a
    // radius one.
    ctx.shadowBlur = Math.max(3, Math.min(Math.min(R.w, R.h) * 0.05, 10));
    for (let i = 0; i < 3; i++) fn(ctx, R, P, !!o.bare, teamId);
    ctx.restore();
  }
  // The outline sits INSIDE the halo: tighter blur, drawn second, so a mark
  // that needs both shows a legibility halo with the player's rim on top of
  // it rather than one swallowing the other. Same repeated-draw trick — a
  // crest paints fills, not strokes, and does not hand its path back, so
  // there is nothing here to stroke directly.
  if (P.outline) {
    ctx.save();
    ctx.shadowColor = css(P.outline);
    ctx.shadowBlur = Math.max(2, Math.min(R.w, R.h) * 0.022);
    for (let i = 0; i < 3; i++) fn(ctx, R, P, !!o.bare, teamId);
    ctx.restore();
  }
  fn(ctx, R, P, !!o.bare, teamId);
}

// The four motif kinds below plus `check`. "team" is the row's default: the
// per-team TAIL_STYLE. "none" paints nothing — no wash, no strokes — so the
// fin and the cover read as plain paint.
export const TAIL_STYLE_IDS: readonly string[] = ["team", "diag", "sweep", "chevron", "streak", "check", "stars", "none"];
// What sits on the shark fin. "number" is the real-F1 layout (the race number
// rides the fin, the crest stays on the spine); "none" leaves the plate to
// the tail graphic alone.
// "code" is the driver's three-letter abbreviation (LEC), which the FIA
// requires on external bodywork at 150 mm anyway (Autosport / FIA); the fin
// is where most teams put it.
export const FIN_BADGE_IDS: readonly string[] = ["logo", "number", "code", "none"];
function driverCode(teamId: TeamId, num: number | string): string {
  const t = deps.Teams !== undefined && deps.Teams.LIST && deps.Teams.LIST.find((x) => x.id === teamId);
  const d = t && t.drivers && t.drivers.find((x) => x.num === num);
  return (d && d.code) || teamShort(teamId);
}
// Whether the crest is also drawn on the engine-cover spine. With the badge
// on the fin AND the spine the same mark reads twice from a chase camera.
// SPINE TOP: what the engine-cover crown carries over its tail wash. "logo"
// (absent) is the shipped crest; "none" leaves the wash alone; the rest are
// designs for a crown that carries NO mark: a centre band, twin pinstripes,
// the title sponsor running along the spine, an exposed-carbon panel, or the
// race number. All paint into REGIONS.crest, so the strip in car-mesh drapes
// them over the rounded crown like the crest.
export const SPINE_LOGO_IDS: readonly string[] = ["logo", "none", "wrap", "bigmark", "saddle", "panel", "stripe", "streaks", "twin", "chevron", "wedge", "rungs", "tricolour", "wordmark", "carbon", "number", "cap", "ridge", "fade",
  ...LiveryDesign.PATTERNS];
// WRAP: one shape in CAR space painted into every region it crosses, so the
// paint job goes over the spine and down both flanks as a single graphic —
// the RB22's sun and bull. The car-space → region maps are car-mesh's:
//   crest      canvas x ↔ across (shoulder to shoulder, ~±0.19 m), canvas y ↔ z (-1.28 at the top → -0.62)
//   flanks     canvas x ↔ z (FLANK, through each side's frame), canvas y ↔ down the flank (0.21 → 0.68 m from the ridge)
// A disc of radius r at (zc, ridge) is an ellipse in each region's pixels;
// clipped to the region, the arcs meet at the shoulder. Each flank is
// painted in its own frame, so the wrap is symmetric by construction.
// A ONE-PATH mark on the flank, facing forward: the RB22 wears a single
// bull on each side, nose to the airbox, under the sun. The team's traced
// crest holds the two bulls as two "mark" paths facing each other; the
// second one faces canvas-left, which is the FRONT of the right flank's
// frame, and the left frame's x runs the other way, so it faces the nose
// on both sides by construction. Sized in METRES (the flank canvas is ~1.4×
// wider than tall per pixel) and as big as the CAMERA keeps — see BULL, which
// owns the station and the arithmetic behind it.
function flankBull(ctx: LiveryCtx2D, teamId: TeamId, colour: Col): boolean {
  const b = bullPath(teamId);
  if (!b) return false;
  const { d, x0, y0, x1, y1 } = b, span = wrapMarkSpan(teamId);
  // OVER THE SHOULDER: the bull is one shape in (z, metres down from the
  // ridge), so its top — standing on the ridge — also crosses the crown.
  // Each side's bull is laid on its half of the crest, down = outward, and
  // the two meet on the centreline. A linear map from path to crest pixels
  // (z along canvas y, depth across canvas x) — tracePath's per-axis f
  // cannot swap axes, so the canvas transform does it. Which half is which
  // side does not matter: the car is symmetric and so is the pair.
  const C = REGIONS.crest;
  if (C) {
    const sH = BULL.h * FLANK.sLen, sTop = FLANK.sTop + BULL.top * FLANK.sLen;
    const sPerPy = sH / (y1 - y0), uPerPx = span.uLen / (x1 - x0);
    const ks = (C.w / 2) / FLANK.sTop, kz = C.h / 0.66, cx = C.x + C.w / 2;
    for (const side of [1, -1]) {
      ctx.save();
      clipToRegion(ctx, C);
      ctx.transform(0, -kz * FLANK.zLen * uPerPx, side * ks * sPerPy, 0,
        cx + side * ks * (sTop - y0 * sPerPy),
        C.y + kz * (FLANK.zF + 1.28 - (span.u0 - x0 * uPerPx) * FLANK.zLen));
      ctx.fillStyle = css(colour);
      tracePath(ctx, { X: (u: number) => u, Y: (v: number) => v, S: (q: number) => q }, d);
      ctx.fill("evenodd");
      ctx.restore();
    }
  }
  // The path's nose is at its low-x end, set just aft of the sun (span.u0).
  eachFlank((F) => {
    const bh = BULL.h * F.R.h, top = F.R.y + F.R.h * BULL.top;
    const xA = F.fx(span.u0), xB = F.fx(span.u0 + span.uLen);
    const f = { X: (u: number) => xA + (u - x0) / (x1 - x0) * (xB - xA), Y: (v: number) => top + (v - y0) / (y1 - y0) * bh, S: (s: number) => s / (x1 - x0) * Math.abs(xB - xA) };
    ctx.save();
    clipToRegion(ctx, F.R);
    ctx.fillStyle = css(colour);
    tracePath(ctx, f, d);
    ctx.fill("evenodd");
    ctx.restore();
  });
  return true;
}
// THE SUN. Centred where the airbox meets the cover, so what the atlas
// paints is its REAR HALF: a round gold cap over the front of the crown and,
// on each flank, the arc that wraps down behind the hoop — which the bull's
// horns then cross, as on the RB22. Car3D paints the airbox and the roll
// structure ahead of it in the same colour (sunColour), so the disc reads as
// one shape over the whole hoop instead of a patch behind it.
const SUN = { r: 0.34, zc: -0.66 };
function drawSunWrap(ctx: LiveryCtx2D, acc: Col): void {
  const { r, zc } = SUN;
  const C = REGIONS.crest;
  ctx.save();
  clipToRegion(ctx, C);
  ctx.fillStyle = cssA(acc, 0.97);
  ctx.beginPath();
  // Across the crown the disc is wider than the strip; capped at 0.55 W so
  // it still reads as a disc with its sides just past the shoulders (and so
  // its outline passes through the region for the atlas probes).
  ctx.ellipse(C.x + C.w / 2, C.y + (zc + 1.28) / 0.66 * C.h, Math.min(r / 0.19 * (C.w / 2), C.w * 0.55), r / 0.66 * C.h, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  eachFlank((F) => {
    const Sf = F.R;
    ctx.save();
    clipToRegion(ctx, Sf);
    ctx.fillStyle = cssA(acc, 0.97);
    ctx.beginPath();
    ctx.ellipse(F.fx((FLANK.zF - zc) / FLANK.zLen), Sf.y - FLANK.sTop / FLANK.sLen * Sf.h,
                r / FLANK.zLen * Sf.w, r / FLANK.sLen * Sf.h, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}
// The colour the wrap's sun is painted — the mark's own backing (Red Bull's
// gold), else secondary / primary. ONE function so the atlas (crown and
// flanks) and Car3D (the airbox and roll hoop) paint the same sun.
export function sunColour(teamId: TeamId, liv: TexLivery): number[] {
  // SUN TINT (liv.sunTint) owns this surface alone. SPINE TINT used to, which
  // made one field mean two things depending on SPINE TOP: a band on most
  // designs, the sun disc on `wrap`. Choosing `wrap` then repurposed a colour
  // picked for a band. They are separate rows now — never inherit spineTint.
  // An EXPLICIT pick wins and skips the derivation below; the guard owns the
  // DEFAULT, never a pick.
  if (liv.sunTint) return liv.sunTint.slice();
  // The field is the COVER, not the body: this sun is painted on the crown,
  // the cover flanks and (Car3D) the airbox. Scoring it against c1 gave a
  // sun that reads on the chassis and disappears on a contrasting cover.
  // Fall back to a near-black when a partial liv has no cover/c1 — markPalette
  // tolerates empty fields now, but pickOn still needs a real paint to score.
  const cover = liv.cover || liv.c1 || INK_DARK;
  const P = markPalette(teamId, liv, [cover, liv.c2].filter(Boolean), false);
  // ...and then it has to CLEAR that cover, which nothing here checked. The
  // crown BAND is re-picked against the cover at SUN_FLOOR for exactly this
  // reason ("a pale accent on a pale cover painted white on white"), and the
  // sun is the biggest area on the car that any of these colours ever covers
  // — a disc across the whole crown and both flanks. Measured before this:
  // Ferrari painted #ffec00 on its #f2f2f5 cover at 1.09, Mercedes #00b4ab on
  // #c2c7d1 at 1.52 and Alpine #ff87bc on #0093cc at 1.56. Same rule as bandC,
  // deliberately: FIRST that clears, so a team keeps its own paints and only a
  // livery whose every colour vanishes falls through to the inks.
  // c1 is in the list for the reason bandC's is: on Ferrari's white cover the
  // candidates ahead of it all fail and the RIGHT answer is the team's own red
  // — the SF-26's sun — not the near-black the inks would have given.
  // Bases + mark plate only — BODY STRIPE / DETAIL / SPINE TINT do not steal
  // the sun when SUN is unset.
  const order = [(P && P.plate), liv.c2, liv.c1, INK_LIGHT, INK_DARK];
  return pickOn(order, cover, SUN_FLOOR).slice();
}
// The floor a metre-wide band or disc must clear against what it is painted
// on. These are shapes, not lettering, and Red Bull's bull reads clearly on
// track at 2.26 against its navy.
const SUN_FLOOR = 2.0;
// The colour the wrap's flank bull is painted, as ONE answer. The flank MARK
// now stands on the bull, so it has to be inked against it — and a second
// derivation of the same colour beside the painter is the phantom-surface
// mistake the flank comments are a register of, one edit away from scoring a
// mark against a colour the bull is not wearing.
const MARK_ON_BODY = 2.0;   // a metre-long silhouette, not lettering
function flankBullColour(teamId: TeamId, liv: TexLivery, sunC: Col, cover: Col, c1: Col, lockup?: MarkPalette): number[] {
  const L = lockup || markPalette(teamId, liv, [sunC, cover], false, { noPlate: true });
  // TEAM LOGO owns the bull whenever the player set one — the same markBase
  // row every other surface reads (parts tile, flank, fin, garage wall).
  if (liv && liv.logo) return L.mark.slice();
  // The BRAND colour whenever it reads at all on the body — the RB22's red
  // across gold and navy alike. Picking this design in the editor already
  // makes a custom livery, so it cannot key on "own".
  const brand = MARK_BRAND[crestKey(teamId)] && MARK_BRAND[crestKey(teamId)]!.mark;
  if (brand && contrast(brand, c1) >= MARK_ON_BODY) return brand.slice();
  return (L.mark || inkOn([sunC, c1])).slice();
}
// ONE answer to "will this colour be seen where it lands". It was written out
// by hand at each site, and the sites that forgot shipped invisible paint
// twice: the crown band on a pale cover, and the sun (Ferrari 1.09 on its own
// cover). FIRST that clears, not the highest-scoring — taking the maximum
// handed Ferrari a near-black saddle, which is the best contrast on the list
// and the wrong car — then the best available when a livery's every colour
// vanishes on that surface.
// `bg` may be a LIST: a band that crosses two paints has to clear both, and
// scoring it against one of them is how the wrap's flank band cleared the sun
// and vanished on the cover beside it (Haas 1.04).
function pickOn(cands: readonly (OptCol | false)[], bg: Col | readonly OptCol[] | null | undefined, floor: number): Col {
  // A list of paints is Array.isArray(bg[0]); a single RGB is numbers. Asking
  // only Array.isArray(bg[0]) threw when bg was null/undefined (Haas wrap
  // flank path) — require Array.isArray(bg) first, then treat a lone RGB as
  // one background.
  let bgs: Col[];
  if (Array.isArray(bg) && bg.length && Array.isArray(bg[0])) bgs = (bg as readonly OptCol[]).filter(Boolean) as Col[];
  else bgs = bg ? [bg as Col] : [];
  const worst = (c: Col) => bgs.length
    ? bgs.reduce((m, b) => Math.min(m, contrast(c, b)), Infinity)
    : 0;
  const list = cands.filter(Boolean) as Col[];
  for (const c of list) if (worst(c) >= floor) return c;
  let best = list[0] || INK_LIGHT, score = worst(best);
  for (const c of list) { const v = worst(c); if (v > score) { score = v; best = c; } }
  return best;
}
// REGIONS.crest is square in pixels but car-mesh drapes it over a strip
// ~0.34 m across and 0.66 m along the spine, so a canvas pixel is 1.9× longer
// along the car than across it — a square mark came out as a lozenge. Crown
// marks are drawn through scale(1, CROWN_SQUASH) so they land round.
const CROWN_SQUASH = 0.52;
// Likewise the flank — except the flank is not a constant-height band. It
// TAPERS (0.59 m tall at the airbox down to 0.35 m at the wing) and the whole
// band rises with `spineHeight`, so one number could only ever be right for
// one spine setting at one station. It was 0.47 m, which is roughly the
// STANDARD spine: every mark on a raised cover came out 5 % too narrow and on
// a dorsal one 14 %, which is what "the side designs look squished" was.
// FLANK_H is the band's real height in metres AT THE MARK'S STATION, measured
// from Car3D.coverProfile — fin-design.test.mjs re-measures it against the
// real geometry so it cannot drift. The squash itself is derived, so changing
// a region's pixel size cannot silently un-square the marks again.
// EVERY Car3D.SPINE_HEIGHT_IDS entry needs a row: a missing one falls back to
// `standard` below and re-creates the exact squish this table exists to fix.
// The first version shipped without `high`, whose marks came out 13.6 %
// narrow — found twice, independently. fin-design.test.mjs iterates the ID
// LIST rather than this table now, so a gap fails instead of hiding.
export const FLANK_H: Readonly<Record<string, number>> & { readonly standard: number } = { standard: 0.4537, raised: 0.4964, high: 0.5249, dorsal: 0.5463 };
const flankSquash = (spineHeight: string, R: LiveryRect) => {
  const H = FLANK_H[spineHeight] || FLANK_H.standard;
  return (R.w / FLANK.zLen) * (H / R.h);   // (px per m along) / (px per m down)
};
// The flank's car-space maps (car-mesh's band): canvas x ↔ z, canvas y ↔ the
// distance s down the skin from the ridge (the crease at s 0.21, the sidepod
// line at ~0.68).
export const FLANK = { zF: -0.66, zLen: 1.24, sTop: 0.21, sLen: 0.47 };
// WHERE THE CAR ITSELF STOPS THE FLANK. The rear tyre stands 0.5 m outboard
// of the cover at z -1.6 with a 0.38 m radius, so from a side camera — the
// one view a livery is judged in — it projects straight over the flank from
// here aft. Measured against the real mesh by tools/car/flank-occlusion.mjs,
// not guessed. Nothing that has to be READ may be pushed past it to dodge
// something else: that trade is how the shipped Red Bull ended up with 92 %
// of its sponsor names and half of every flank mark behind its own wheel.
export const FLANK_SEEN = 0.62;
// How far aft the wrap's sun reaches at a depth v down the flank. drawSunWrap
// centres its ellipse ABOVE the crease (the disc's middle is on the airbox),
// so the reach shrinks fast with depth: 0.215 of the flank at the crease,
// 0.12 a fifth of the way down. Derived from the SUN and FLANK the painter
// uses so a side design placed against it cannot drift off it.
function sunReach(v: number): number {
  const cv = -FLANK.sTop / FLANK.sLen, rv = SUN.r / FLANK.sLen;
  const t = 1 - ((v - cv) / rv) ** 2;
  return t <= 0 ? 0 : (SUN.r / FLANK.zLen) * Math.sqrt(t);
}
// How much of the flank the bull claims. Its HEIGHT is chosen and its LENGTH
// derived from the traced path's own aspect through the flank's anisotropy —
// 1.24 m over 304 px along the car against 0.47 m over 160 px down it, so a
// length picked in metres and a height picked in pixels gave a bull 113 % of
// the region tall, clipped to a white blob. Published because the SIDE
// designs have to clear it.
// It hangs from `top`, not from the crease, and the two numbers answer to
// opposite ends of the band. Hung at 0.04 it filled to 0.84 and buried the
// crease strip — the one a cover design can always use, where the real RB22
// carries its sponsor names — under a metre of bull, which pushed every side
// design aft of the whole animal and so behind the rear wheel. Standing it on
// the sidepod line instead (top 0.26, h 0.74) freed that strip and cost the
// ANIMAL: the flank's bottom corner is not on camera. From the garage side
// view the sidepod eats the band below v ~0.81 forward of u 0.2, so a bull
// reaching v 0.99 lost 19 % of its ink and 36 % of its HEAD, which is the low
// forward part of a charging silhouette — the head went and the rump stayed.
// Both ends are now inside what the camera keeps: shorter (h), hung just
// below the lettering strip (top), and its lowest hoof — at 0.96 of the bbox
// — lands at v 0.81. Measured, not eyeballed: the `(crown)` row of
// tools/car/spine-station.mjs --occlude reports 2 % of the ink hidden.
// …and then the RB22 look asked for more: a bigger bull whose TOP stands on
// the ridge, so each flank's bull runs up over the shoulder and the pair
// meet on the spine (flankBull paints the crown half). The top is the
// ridge itself (s 0), the bottom v 0.60 of the flank, which keeps the
// derived length (0.88 m at the path's 0.557 aspect) ending at z -1.60 —
// where the rear tyre starts to stand over the flank from a side camera.
const BULL = { h: (0.49) / FLANK.sLen, u0: 0.05, top: -FLANK.sTop / FLANK.sLen };
// A team with NO traced bull wears its lockup as a square badge in the
// bull's slot (v 0.30 .. 0.82): a badge cannot cross the shoulder.
const WRAP_BADGE = { h: 0.52, top: 0.30 };
// The team's ONE forward-facing traced path, with its bbox — Red Bull's crest
// is two bulls charging at each other and the second faces canvas-left, which
// every flank frame maps to the nose. Null for a crest that is not a single
// pair of marks.
function bullPath(teamId: TeamId) {
  const spec = crestSpecFor(teamId);
  if (!spec || spec.d.length !== 2 || spec.roles.some((r) => r !== "mark")) return null;
  const d = spec.d[1]!;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const m of d.matchAll(/(-?[0-9.]+)[ ,](-?[0-9.]+)/g)) {
    const x = +m[1]!, y = +m[2]!;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { d, x0, y0, x1, y1 };
}
// How much of the flank the wrap's mark claims, front-first: BULL.h of the
// skin from the crease down, and a LENGTH derived from this path's own aspect
// through the flank's anisotropy. Measured from the path, never a copied
// constant; a team with no traced bull wears its lockup at the same height,
// which is square. The SIDE designs no longer start behind this — behind the
// whole animal is behind the rear wheel — they clear the SUN and share the
// bull; see sideFrom.
function wrapMarkSpan(teamId: TeamId) {
  const b = bullPath(teamId);
  const aspect = b ? (b.y1 - b.y0) / (b.x1 - b.x0) : 1;
  return { u0: BULL.u0, uLen: ((b ? BULL.h : WRAP_BADGE.h) * FLANK.sLen / aspect) / FLANK.zLen };
}
// FLANK FRAMES. Each flank is authored in its own OUTSIDE-VIEW frame: local
// x runs 0 → 1 from the viewer's left to right standing beside that side,
// local y 0 → 1 from the crease down. Beside the RIGHT flank the nose is on
// the viewer's left, so the front is at x 0; beside the LEFT flank the nose
// is on the viewer's right, so the front is at x 1. Text drawn plainly in
// this frame reads on both sides; a forward-facing graphic is mirrored on
// the left by construction. `fx(u)` maps a distance-from-the-front fraction
// to canvas x, `box(u0,u1,v0,v1)` a front-based rectangle, `dir` is +1 when
// the rear is +x. car-mesh maps each region so that canvas x IS the
// outside view's x. WHICH END of a region is the nose is a property of the
// DRAWN car, not of car space: the model matrix is an x-REFLECTION (see
// car-mesh quad()), so the +x quad renders as the car's RIGHT flank with
// its canvas-LEFT at the REAR, and the −x quad as the LEFT flank with its
// canvas-left at the FRONT. Measured, not derived: a labelled grid painted
// into both regions and read in the real garage from the side, the rear and
// the hero view. The first calibration assumed the reflection
// away, inverted both frames, and pointed every bull at the rear wing.
const FLANKS: readonly { region: keyof Regions; frontLeft: boolean }[] = [{ region: "spineSide", frontLeft: false }, { region: "spineSideL", frontLeft: true }];
function flankFrame(side: { region: keyof Regions; frontLeft: boolean }): FlankFrame | null {
  const R = REGIONS[side.region];
  if (!R) return null;
  const fx = (u: number) => R.x + (side.frontLeft ? u : 1 - u) * R.w;
  return { R, fx, dir: side.frontLeft ? 1 : -1 };
}
const eachFlank = (fn: (F: FlankFrame) => void) => { for (const side of FLANKS) { const F = flankFrame(side); if (F) fn(F); } };
const COVER_BIND_IDS: readonly string[] = ["independent", "saddleWrap", "spineOnly"];
const FIN_HANDOFF_IDS: readonly string[] = ["match", "contrast", "hardCut"];
function coverBindOf(liv: { coverBind?: string | null | undefined } | null | undefined): string {
  const v = liv && liv.coverBind;
  return COVER_BIND_IDS.includes(v as string) ? v as string : "independent";
}
function finHandoffOf(liv: TexLivery | null | undefined): string {
  const v = liv && liv.finHandoff;
  return FIN_HANDOFF_IDS.includes(v as string) ? v as string : "match";
}
// SADDLE zone fill: saddleTint when set; else bandC under saddle / saddleWrap.
function saddleFill(liv: { saddleTint?: OptCol; spineLogo?: string | null | undefined; coverBind?: string | null | undefined } | null | undefined, bandC: Col, _coverPaint: Col): Col | null {
  if (liv && liv.saddleTint) return liv.saddleTint;
  const bind = coverBindOf(liv);
  const logo = (liv && liv.spineLogo) || "logo";
  if (logo === "saddle" || bind === "saddleWrap") return bandC;
  return null;
}
// RIDGE zone fill: always the band colour (spineTint / derived bandC).
// ridgeTint was folded into spineTint by Liveries.migratePaint.
function ridgeFill(liv: { spineTint?: OptCol } | null | undefined, bandC: Col, coverPaint: Col): Col {
  // RIDGE lost its own row (migratePaint folds it into BAND), so BAND IS the
  // ridge's colour — and an authored BAND is a pick, exactly as the sheet
  // says. Only the DERIVED band is re-picked to clear the cover.
  if (liv && liv.spineTint) return liv.spineTint;
  return pickOn(
    [bandC, INK_LIGHT, INK_DARK].filter(Boolean),
    coverPaint || bandC, SUN_FLOOR);
}
const FIN_ON_BLOCK = 2.0;
// AIRBOX mesh paint (Car3D roll hoop / snorkel / intake lips). Under WRAP the
// resolved sun wins; otherwise ENGINE COVER (airboxTint folded into cover).
export function airboxMeshColour(teamId: TeamId, liv: TexLivery, coverC: OptCol): MVec3 {
  const logo = (liv && liv.spineLogo) || "logo";
  if (logo === "wrap") return sunColour(teamId, liv).slice() as MVec3;
  return coverC ? coverC.slice() as MVec3 : [0.1, 0.1, 0.12];
}
// Crown/saddle block the fin root meets — contrast handoff scores against this.
function finContrastBlock(liv: TexLivery | null | undefined, coverPaint: Col, bandC: Col): Col {
  const saddle = saddleFill(liv, bandC, coverPaint);
  return saddle || coverPaint;
}
// Fin PLATE colour for mesh + atlas; finHandoff selects match / contrast.
// An authored TAIL FIN pick always wins — contrast mode only DERIVES when
// fin is unset (same rule as spineTint / sunTint / sideTint).
export function resolveFinPaint(_teamId: TeamId, liv: TexLivery | null | undefined, coverPaint: Col, bandC: Col, c1: Col, c2: Col): MVec3 {
  if (liv && liv.fin) return liv.fin.slice() as MVec3;
  if (finHandoffOf(liv) === "contrast") {
    const block = finContrastBlock(liv, coverPaint, bandC);
    return pickOn([c2, c1, INK_DARK, INK_LIGHT], block, FIN_ON_BLOCK).slice() as MVec3;
  }
  return c2.slice() as MVec3;
}
// The saddle's other half: from the airbox back along the crease to
// mid-cover, then a raked edge down to the sidepod line just behind the
// number (the SF-26's white cover top), on each flank in its own frame.
// Called OUTSIDE the crown clip — see the saddle branch below.
function saddleFlanks(ctx: LiveryCtx2D, acc: Col): void {
  // Crease runs farther aft (0.64) then drops on a sharper rake so the white
  // panel reads as a cut vinyl, not a soft blob into the sidepod. A thin ink
  // keyline on the rake is what sells the edge at garage distance. `acc` is
  // the resolved saddle fill (pick or derived) — never re-pick here; a pick
  // must reach the atlas as chosen.
  // A 1px diagonal fill aliased into a stair-step under cover UVs (Ferrari
  // podFloor). Same-colour round strokes along the rake anti-alias the cut
  // without shrinking the solid (lettering still sits on the saddle).
  eachFlank((F) => {
    const Sf = F.R;
    ctx.save();
    clipToRegion(ctx, Sf);
    ctx.fillStyle = cssA(acc, 0.97);
    ctx.beginPath();
    ctx.moveTo(F.fx(0), Sf.y); ctx.lineTo(F.fx(0.64), Sf.y);                 // along the crease
    ctx.lineTo(F.fx(0.38), Sf.y + Sf.h); ctx.lineTo(F.fx(0), Sf.y + Sf.h);  // raked rear edge
    ctx.closePath(); ctx.fill();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = cssA(acc, 0.55);
    ctx.lineWidth = Math.max(4, Sf.h * 0.045);
    ctx.beginPath();
    ctx.moveTo(F.fx(0.64), Sf.y); ctx.lineTo(F.fx(0.38), Sf.y + Sf.h);
    ctx.stroke();
    ctx.strokeStyle = cssA(acc, 0.97);
    ctx.lineWidth = Math.max(2, Sf.h * 0.02);
    ctx.beginPath();
    ctx.moveTo(F.fx(0.64), Sf.y); ctx.lineTo(F.fx(0.38), Sf.y + Sf.h);
    ctx.stroke();
    ctx.strokeStyle = cssA(INK_DARK, 0.28);
    ctx.lineWidth = Math.max(1.5, Sf.h * 0.014);
    ctx.beginPath();
    ctx.moveTo(F.fx(0.64), Sf.y); ctx.lineTo(F.fx(0.38), Sf.y + Sf.h);
    ctx.stroke();
    ctx.restore();
  });
}
const { drawSpineTop, drawTailTop, drawTailGraphic } = LiveryGraphics.create({
  cssA, clipToRegion, drawNumber, drawWordmark, CROWN_SQUASH, coverBindOf,
  saddleFill, ridgeFill, pickOn, INK_LIGHT, INK_DARK, SUN_FLOOR, TAIL_STYLE_IDS,
});

// SPINE SIDE: the mark on the engine-cover FLANK — where the real 2026 cars,
// fin-less with a tall dorsal cover, carry the driver number. Absent ("none")
// leaves REGIONS.spineSide unpainted, so the shipped atlas is pixel-identical.
// From the 2026 launch photos: "wordmark" is the title sponsor on the flank
// (Red Bull's ORACLE, Mercedes' PETRONAS), "plate" the SF-26's number on a
// contrasting panel, "duo" the RB22 (title aft, partner forward). `"slash"`
// is ONE raked stroke (W17 language as a single band) — restored as a real
// SIDE design. Mercedes still ships `"sash"`. Spine-zones pack adds
// `rake` / `shoulder` / `starfield` (not `stars` — that remains finStyle).
export const SPINE_SIDE_IDS: readonly string[] = ["none", "number", "logo", "code", "plate", "wordmark", "duo", "ribbon", "lockup", "title", "emblem", "band", "sash", "slash", "rake", "shoulder", "starfield"];
// FILLS sit under the wrap's bull; lettering/numbers/badges sit over it.
// `ribbon` is content (strip + number). `band`/`sash`/`rake`/`shoulder` are colour panels.
// `slash` is a stroke on bare flank — not SIDE_FILL.
const SIDE_FILL: Record<string, number> = { band: 1, sash: 1, rake: 1, shoulder: 1 };

// WHICH PAINT ROW EACH DESIGN ACTUALLY SPENDS — declared HERE, beside the
// painters that consume it, and published so the garage sheet greys a row
// nothing can paint and the shot tool can say a design flag is inert.
//
// The garage had this as two hand-written maps in setup-sheet.js, one door
// away from the painters. That is the drift this tree keeps paying for: the
// paint sheet's field list had FIVE copies that disagreed, and render-car
// carried 23 of the 33 livery fields so nine were unreachable. A design added
// to SPINE_LOGO_IDS without a row here is a colour the player cannot spend,
// and `fill-gating.test.mjs` proves every entry against the RASTERISED atlas
// rather than against this comment — declare it, and the test checks it.
//
// HEIGHT ZONES (`lower` / `upper`) are NOT atlas fills: CarShade cuts the
// chassis mesh along the sidepod board line and recolours one side. They live
// in Liveries.FIELDS + the paint-sheet colour rows, never here.
export const FILL_SURFACES: readonly FillSurface[] = Object.freeze([
  { key: "patternTint", label: "DESIGN COLOUR", why: "Choose a new spine design", tops: LiveryDesign.PATTERNS },
  { key: "patternSecond", label: "SECOND DESIGN COLOUR", why: "Choose a two-colour design", tops: LiveryDesign.SECOND_COLOR },
  { key: "spineTint", label: "BAND",
    why: "Needs a SPINE TOP that paints a band (e.g. stripe, saddle, panel)",
    tops: ["saddle", "panel", "stripe", "streaks", "twin", "chevron", "wedge",
           "rungs", "tricolour", "carbon", "cap", "ridge", "fade"] },
  { key: "saddleTint", label: "SADDLE",
    why: "Needs SADDLE top, SADDLE WRAP bind, or a shoulder side",
    // NOT `rake`: that fill reads SADDLE only under a saddleWrap bind (see
    // the rake branch), which the bind entry below already covers.
    tops: ["saddle"], sides: ["shoulder"], binds: ["saddleWrap"] },
  { key: "sideTint", label: "FLANK FILL",
    why: "Needs a SPINE SIDE colour fill (band, sash, rake, …)",
    sides: ["band", "sash", "slash", "rake", "shoulder", "starfield", "ribbon"] },
  { key: "sunTint", label: "SUN", why: "Needs SPINE TOP WRAP", tops: ["wrap"] },
  { key: "bandTint2", label: "2ND BAND", why: "Needs SPINE TOP TRICOLOUR", tops: ["tricolour"] },
  { key: "plateTint", label: "PLATE", why: "Needs SPINE SIDE PLATE or TITLE",
    sides: ["plate", "title"] },
]);
/** The fill rows a design can actually spend, as an ordered array of
 *  FILL_SURFACES entries. Callers pass a livery / draft; absent fields take
 *  the same defaults buildAtlas applies. */
function liveFills(design: TexLivery | null | undefined): FillSurface[] {
  const d = design || {};
  const top = d.spineLogo || "logo", side = d.spineSide || "none";
  const bind = coverBindOf(d);
  return FILL_SURFACES.filter((f) => (f.tops || []).includes(top)
    || (f.sides || []).includes(side) || (f.binds || []).includes(bind));
}
/** Is this livery FIELD inert on this design? Only fill rows can be. */
export function fillInert(key: string, design: TexLivery | null | undefined): boolean {
  if (!FILL_SURFACES.some((f) => f.key === key)) return false;
  return !liveFills(design).some((f) => f.key === key);
}

// Where a MARK (logo / number / code / plate) sits on the flank canvas.
// v is the centre, 0 at the shoulder crease and 1 at the sidepod line.
// Hung at 0.56 the plate sits in the sidepod (reads "a little low"); a
// 0.72-tall box at 0.42 clips the crease. The box is 0.48 tall so 0.45
// clears the crease (~0.12) and stays out of the sidepod (~0.68).
// Calibrated on the garage side preset, not the atlas.
// `uOnCrown` is the same mark when the crown design has painted the flank.
// It cannot go forward to 0.19 (the sun) and it must not go aft past
// FLANK_SEEN (the rear tyre), so it is centred between them: the box is 0.18
// of the flank each side, which puts its leading edge at 0.20 — clear of the
// sun below the first fifth — and its trailing edge at 0.56, inside the last
// of the flank a side camera can see.
// `uOnSaddle` / `vOnSaddle` centre a crest on the saddle's white shoulder
// (saddle paints flanks along the crease). v 0.28 rode the crease too high;
// v 0.40 read as bare sidepod — 0.36 splits the band. Plate keeps `v` — the
// number board is calibrated there.
export const FLANK_MARK = {
  u: 0.19, uOnCrown: 0.38, uOnSaddle: 0.26,
  v: 0.45, vOnSaddle: 0.36,
  halfW: 0.36, halfH: 0.24,
};
export function flankMarkStation(spineLogo: string, sideFrom: number, spineSide: string): { u: number; v: number } {
  if (sideFrom) return { u: FLANK_MARK.uOnCrown, v: FLANK_MARK.v };
  if (spineLogo === "saddle" && spineSide === "logo") {
    return { u: FLANK_MARK.uOnSaddle, v: FLANK_MARK.vOnSaddle };
  }
  return { u: FLANK_MARK.u, v: FLANK_MARK.v };
}
// Unit-space extent of a traced crest — M/L/Z only, so a scan of its
// numbers — with the authored disc. A hand-drawn crest (Mercedes, Haas,
// Audi) reports the whole fit box, which sizes it exactly as before.
const crestExtentCache: Record<string, { u0: number; v0: number; u1: number; v1: number }> = {};
function crestExtent(teamId: TeamId) {
  teamId = crestKey(teamId);   // a legends slot changes marque with its legend
  if (crestExtentCache[teamId]) return crestExtentCache[teamId]!;
  const spec = crestSpecFor(teamId);
  let u0 = 1, v0 = 1, u1 = 0, v1 = 0;
  if (spec) for (const d of spec.d) {
    const nums = d.match(/-?\d*\.?\d+/g) || [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const u = +nums[i]!, v = +nums[i + 1]!;
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
  }
  const disc = CREST_DISC[crestKey(teamId)];
  if (disc) {
    u0 = Math.min(u0, disc.cx - disc.r); u1 = Math.max(u1, disc.cx + disc.r);
    v0 = Math.min(v0, disc.cy - disc.r); v1 = Math.max(v1, disc.cy + disc.r);
  }
  if (!(u1 > u0 && v1 > v0)) { u0 = 0; v0 = 0; u1 = 1; v1 = 1; }
  return (crestExtentCache[teamId] = { u0, v0, u1, v1 });
}
// The box handed to drawCrest so that the crest's EXTENT fills the flank
// mark box R. fit() sizes every crest by a SQUARE on the box's SHORT side,
// so a wide mark in the wide mark box was sized by the box's HEIGHT and got
// a third of the width it was given: Aston's wings (4:1) measured 2.6 % of
// the flank when cover-legibility.test.mjs set its floor on them, 1.5 % after
// the box was lowered (0f1ff58), 1.1 % after it was shrunk (43013ce), 1.4 %
// with a flat 1.155x on the box (34837c1) — and the floor is 1.5 %. This
// scales the fit square so the extent, not the square, meets the box: a
// square crest is sized exactly as the 1.155x sized it, a wide one takes the
// width it was always given. Everything stays INSIDE R, which fin-design's
// sun / rear-tyre bounds already vet.
function flankEmblemBox(R: LiveryRect, teamId: TeamId): LiveryRect {
  const e = crestExtent(teamId);
  const s = Math.min(R.w / (e.u1 - e.u0), R.h / (e.v1 - e.v0)) * FLANK_CREST_FILL;
  const side = s / (1 - CREST_MARGIN * 2);
  const cx = R.x + R.w / 2 - ((e.u0 + e.u1) / 2 - 0.5) * s;
  const cy = R.y + R.h / 2 - ((e.v0 + e.v1) / 2 - 0.5) * s;
  return { x: cx - side / 2, y: cy - side / 2, w: side, h: side };
}
// ONE scratch canvas for the whole grid, on phones only. Setting .width
// RESETS a canvas per spec — even to the same value — so the assignments
// already clear it between cars. Preview / AI / mobile paint AT upload size
// (SIZE/div) with setTransform(1/div) so REGIONS stay in SIZE space; only
// the deferred desktop-player hi-res kick authors 2048×2560. A 2048 paint
// then bilinear downscale on the boot path was the 26.7 MB CPU spike.
let scratchCanvas: LiveryCanvas | null = null;
function scratchAtlas(): LiveryCanvas {
  if (!scratchCanvas) scratchCanvas = makeCanvas();
  return scratchCanvas;
}

// ── main ─────────────────────────────────────────────────────────────────
// hiRes: desktop player full 2048 upload. Callers that must stay off the
// boot / garage-open path pass false (or omit) and let car-draw defer true.
// Preview / AI / mobile author the canvas at the upload size.
export function buildAtlas(teamId: TeamId, colorsIn: TexLivery | null = {}, numberOverride?: number | string | null, isPlayer?: boolean, hiRes?: boolean): LiveryCanvas {
  // f1-game logs "livery <teamId>" here (dropped).
  const mobile = atlasMobile(!!isPlayer, isMobileTier(), isPhone());
  const div = atlasDiv(!!isPlayer, mobile, !!hiRes);
  // ALWAYS the element, never an OffscreenCanvas — including the deferred hi-res paint that
  // car-draw.js hands to createImageBitmap() (C-P3). An ImageBitmap made from an OffscreenCanvas
  // stalled the WebGL upload on Chromium over Mesa llvmpipe (the car group's DAILY garage-out spec
  // hung at 180 s on every attempt, PR #1494 runs 38519977495 / 38521713487); the same bitmap path
  // from this element passes the whole group (run 38524153549), as does the element with the old
  // synchronous upload. The element's bitmap is the safe source on every adapter.
  const canvas = mobile ? scratchAtlas() : makeCanvas();
  canvas.width = SIZE / div;
  canvas.height = SIZE_H / div;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  try { ctx.imageSmoothingQuality = "high"; } catch { /* Safari <15 */ }
  if (div !== 1) ctx.setTransform(1 / div, 0, 0, 1 / div, 0, 0);

  const colors: TexLivery = Object.assign({}, colorsIn || {});
  if (deps.Liveries !== undefined && deps.Liveries.migratePaint) deps.Liveries.migratePaint(colors);
  const c1 = colors.c1 || [0.1, 0.1, 0.12];
  const c2 = colors.c2 || [0.9, 0.9, 0.92];
  const stripe = colors.stripe || null;
  const finArt = colors.finArt || null;
  const logo = colors.logo || null;

  // The sidepod carries a physical sponsor BOARD — a fixed pale panel the car
  // mesh paints under the wordmark — and the ink logic never knew about it.
  // On any dark livery the ink resolves LIGHT for the paint and then lands on
  // that pale board at 1.4:1, which is the faint sidepod text. It is part of
  // the background set now, so the ink (or its halo) has to clear it too.
  const board: Col = (deps.Car3D !== undefined && deps.Car3D.PANEL_COL) || [0.82, 0.82, 0.86];
  const podBg = [board];
  const stripBg = [c2];
  const ink = inkOn([c1, c2]);             // nose / endplate number
  // The crest, the spine designs and the flank marks all sit on the ENGINE
  // COVER, so they ink against ITS colour: a white cover (the SF-26) under a
  // red car would otherwise take the red car's ink and read as nothing.
  const coverPaint = colors.cover || c1;
  // …against the cover ALONE. Scoring it against the fin as well made the
  // crown's ink a compromise with a surface the crown never touches, and on
  // Cadillac — a near-black car with a near-white fin — no ink satisfies
  // both, so it picked dark and the wordmark and number vanished into the
  // black cover: 0 % of the crown readable, measured. The fin has inkFin,
  // which is what the fin badge already uses; every shipped car now sets
  // finShape "none", so a fin that is not there was choosing the ink for a
  // mark that is.
  // Lettering auto-inks against the cover. CREST INK is retired (migratePaint
  // drops it): one key was inking the crown's glyphs AND seeding the derived
  // 2nd band, rake and shoulder FILLS, which have rows of their own.
  const inkCrest = inkOn([coverPaint]);
  const inkPod = inkOn(podBg);              // sidepod wordmarks (titleA only)
  const inkNose = inkOn([c1, c2]);          // titleB — the monocoque top
  const inkStrip = inkOn(stripBg);
  const haloIf = (i: Ink) => (i.worst < INK_TARGET ? haloFor(i) : null);

  // Trim / keyline colour: DETAIL (`colors.accent`) if set, else secondary.
  // Each optional row owns one surface — stripe stays on the spine stripe,
  // DETAIL on trim, SPINE TINT on the crown band — so BODY STRIPE must not
  // remap the working accent (it would recolour numbers, plates and the
  // crown band together).
  // An authored DETAIL pick is used as-is — the contrast guard owns the
  // derived default only (same rule as spineTint / logo / sunTint).
  let accent = colors.accent || c2;
  // Guard: the accent has to separate from BOTH the ink it sits beside and the
  // paint behind it. A raw luminance difference against a flat 0.15 passes
  // plenty of pairs that are indistinguishable in practice, and the fallback
  // needs re-checking too.
  // The guard owns the DEFAULT only. An authored DETAIL is a pick, like every
  // other row: re-scored here it would be swapped for c2 or an ink on the
  // number keylines, so the mesh trim would wear the player's colour and the
  // atlas keyline beside the number something else.
  if (!colors.accent && (contrast(accent, ink) < 2.0 || contrast(accent, c1) < 1.6)) {
    const options = [c2, c1, INK_LIGHT, INK_DARK].filter(Boolean);
    let best = accent, bestScore = -1;
    for (const cand of options) {
      const score = Math.min(contrast(cand, ink), contrast(cand, c1));
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    accent = best;
  }
  // THE BAND COLOUR. Every crown and flank design paints in one colour, and
  // it lands on the ENGINE COVER — which liv.cover can paint differently from
  // the body. Re-picked here against what the band ACTUALLY sits on, and only
  // when the natural choice fails — where the cover equals the body, which is
  // nine teams, the atlas is byte-identical to before for stock cars (none of
  // which author a BODY STRIPE).
  // The floor is BAND_ON_COVER (module scope), not the general ink floor.
  // Engine-cover panel: tail graphic + full crest (badge is fine on the flat top).
  // The three DESIGN picks. Absent = today's atlas, pixel for pixel.
  const tailStyle = colors.finStyle || "team";
  const finBadge = colors.finBadge || "logo";
  const spineLogo = colors.spineLogo || "logo";
  const coverBind = coverBindOf(colors);
  // SPINE TINT (liv.spineTint) — the crown band's OWN colour. An EXPLICIT
  // pick wins and skips the contrast re-pick. The derived default is the
  // BASE colours only (secondary, then primary, then inks) — never BODY
  // STRIPE or DETAIL. Those are other rows; Aston's dark band is authored
  // spineTint for exactly this reason, and a custom with a titanium stripe
  // + Audi-red secondary must keep a red saddle unless the player sets
  // SPINE TINT. See pickOn for why FIRST that clears, not highest-scoring.
  const BAND_ORDER = [c2, c1, INK_LIGHT, INK_DARK];
  const bandC = colors.spineTint || pickOn(BAND_ORDER, coverPaint, BAND_ON_COVER);
  // …and whether that band can be SEEN on the cover. False for every derived
  // pick by construction; true only for an authored SPINE TINT that sits
  // under the floor, which is what the band designs' trim answers to.
  const bandWeak = contrast(bandC, coverPaint) < BAND_ON_COVER;
  const finPaint = resolveFinPaint(teamId, colors, coverPaint, bandC, c1, c2);
  const inkFin = inkOn([finPaint]);
  // The cover's HEIGHT decides how tall the flank band is in metres, and so
  // how wide a mark must be drawn to come out square on it (flankSquash).
  const spineHeight = colors.spineHeight || "standard";
  // The crown carries NO gradient wash: the fin's tail motif run on over the
  // spine as an alpha gradient reads as spray-painted. Every SPINE TOP
  // stands on the bare body paint with hard edges: vinyl, not airbrush. The
  // fin keeps its motif (drawTailGraphic on REGIONS.fin below).
  const markHalo = (img: LiveryLogo | undefined, bg: Col, ink: Col) =>
    (img && img._avg && contrast(img._avg, bg) < 2.6 ? ink : null);
  const emblemRim = colors.logo3 || null;
  // ONE lockup for the engine cover and the fin badge. Resolving the badge
  // against the fin wash alone drops Ferrari's shield (and recolours the
  // horse), so top-down / the garage wall would disagree with the tail.
  // …and it is resolved against the paints it actually LANDS on. Scoring it
  // against [c1, c2] while painting it on the cover puts Ferrari's yellow-
  // plated shield on its white cover at 1.22:1 — every surface this lockup
  // reaches is either coverPaint (crown, tail, flank) or finPaint (badge).
  // …and a surface the car does not HAVE is not one of them. car3d builds no
  // blade at all when finShape is "none" (`if (!ckpt && finShape !== "none")`),
  // so REGIONS.fin and REGIONS.finBadge are texels nothing samples — and all
  // twelve shipped cars set it. Scoring the lockup against that phantom is the
  // same defect the crown ink had one variable down: markPalette floors
  // against the WORST of the list, so on Cadillac — a near-black cover with a
  // near-white fin — no mark colour clears both, the mark falls through to a
  // substitute and `alt` collapses onto the cover. Measured: the crest paints
  // 5 % of the crown and 0.9 % of it can be seen, against 5 %+ on every other
  // team. A livery that actually wears a fin still resolves ONE lockup across
  // both surfaces, which is why that list exists.
  // PARTIAL, knowingly. `finVisible` in js/car/car-mesh.js gates the fin on
  // BOTH of `fShape !== "none" && (!fRoot || clear > 0.03)` — a crown taller
  // than the regulation fin top swallows the blade, and car-mesh then maps
  // neither R.fin nor R.finBadge. This models the first half only, because
  // `clear` needs Car3D.sharkFinRoot(bodyAnchors(PARTS, ...), aeroFin, shape)
  // and buildAtlas is handed no parts. Measured on spineHeight "dorsal" —
  // which all twelve shipped teams set — a blade exists only above aero fin
  // 0.995 (standard/swept/stepped) or 0.660 (stub), and most of the shipped
  // aero column sits below that, so the phantom is still reachable this way.
  // Closing it means threading the predicate in, not widening the guess here.
  const finReal = (colors.finShape || "standard") !== "none";
  const lockup = markPalette(teamId, colors, finReal ? [coverPaint, finPaint] : [coverPaint], false);
  // Sponsor names resolve here so the spine can carry the title sponsor.
  const pack = colors.sponsors && SPONSOR_PACKS[colors.sponsors];
  const names = pack || SPONSORS[teamId as string] || ["APEXFIN", "NEXUS", "VOLTARC", "MERIDIAN", "HYPERGRID", "QUANTA"];
  const raceNum = resolveRaceNumber(numberOverride, teamId);
  // LAYER ORDER ON THE FLANK. A crown design that puts a graphic on the cover
  // side shares that side with the SIDE design, and which goes on top is not
  // a detail: a solid `split` over the wrap's bull erases its legs, and the
  // bull over a wordmark erases the sponsor. A real livery layers base bands
  // first, the brand mark over them, lettering and numbers over everything —
  // so the crown's flank graphic is deferred to sit between the two classes.
  let paintFlankBull: (() => void) | null = null;
  // New wrap art sits above the base fills and below lettering, using one shared surface map.
  const paintDesign = typeof LiveryDesign !== "undefined" && LiveryDesign.PATTERNS.includes(spineLogo)
    ? () => LiveryDesign.drawAtlas(ctx, colors, REGIONS, FLANK, eachFlank) : null;
  const spineSideRaw = colors.spineSide || "none";
  const spineSide = SPINE_SIDE_IDS.includes(spineSideRaw) ? spineSideRaw : "none";
  if (spineLogo === "logo") {
    // TOP-DOWN: upright with the nose up, so it reads from the chase camera
    // and in a plan view (the atlas is drawn front-at-the-bottom, so this is
    // a half turn). The real covers read from the side (Ferrari's HP, Red
    // Bull's lettering) but this one is drawn for the plan-view reading; the
    // wordmark alone still runs along the spine, where it has the room.
    const Rc = REGIONS.crest, sq = Rc.w * 0.92;
    ctx.save();
    ctx.translate(Rc.x + Rc.w / 2, Rc.y + Rc.h / 2); ctx.rotate(Math.PI); ctx.scale(1, CROWN_SQUASH);
    const Rr = { x: -sq / 2, y: -sq / 2, w: sq, h: sq };
    if (LOGOS[teamId as string]) {
      drawLogoImage(ctx, LOGOS[teamId as string]!, Rr, logo,
                    markHalo(LOGOS[teamId as string], coverPaint, inkCrest), emblemRim);
    } else drawCrest(ctx, teamId, Rr, { liv: colors, field: [coverPaint], bare: false, palette: lockup });
    ctx.restore();
  } else if (spineLogo === "wrap") {
    // The sun in the PLATE colour (the mark's own backing, Red Bull's gold)
    // over crown and flanks, and the plate-less mark on the crown at its
    // centre, top-down and in proportion.
    const sunC = sunColour(teamId, colors);
    drawSunWrap(ctx, sunC);
    // The crown carries the sun alone; the MARK goes on the flanks, facing
    // forward under it (the RB22: one bull a side, nose to the airbox). The
    // mark colour is resolved against both the sun and the body it lies
    // across. A crest without a single forward-facing path falls back to
    // its plate-less lockup at the flank mark's spot.
    // …and the FIELD is the sun plus the COVER beside it, not c1: this mark is
    // painted on the cover flank, and the monocoque is not a surface it touches.
    const sunLockup = markPalette(teamId, colors, [sunC, coverPaint], false, { noPlate: true });
    // The bull's colour comes from flankBullColour, which the SIDE designs
    // also read — MARK_ON_BODY's floor is DELIBERATELY below the general ink floor: this
    // is a metre-long brand silhouette that crosses the sun, not lettering,
    // and Red Bull's own red on their own navy scores 2.3. A body the mark
    // would truly vanish on (a red car) still falls through to the ink.
    const bullC = flankBullColour(teamId, colors, sunC, coverPaint, c1, sunLockup);
    paintFlankBull = () => {
    if (!flankBull(ctx, teamId, bullC) && spineSide === "none" && !colors._bareWrapFlank) {
      // No traced bull: the team's lockup at the SAME height the bull would
      // have had, on the same band. Hung at 0.72 of the flank it read as a
      // badge floating on an empty side while Red Bull's filled the cover.
      // …and ONLY when the flank is otherwise empty, which is the whole
      // reason it exists. A side design fills the flank by itself, and a
      // mark standing on a full LOCKUP is a collision a bull never is: one
      // silhouette in one colour can be inked against, five crest roles
      // cannot. Measured with the lockup left in — Haas, Williams, Audi,
      // Ferrari and Cadillac all painted a near-black number keyline onto a
      // near-black crest at 1.0:1. A team WITH a traced bull keeps it under
      // every side design: it is the livery's signature, not a filler.
      // `_bareWrapFlank` is a probe-only skip so contrast differencing can
      // ground against the sun instead of this filler (Aston wrap/code).
      const span = wrapMarkSpan(teamId);
      // …and this badge is NOT the bull, so it does not get the bull's field.
      // `sunLockup` pairs the sun with the cover because a traced bull is a
      // metre-long silhouette that genuinely straddles the disc. This one is
      // a badge spanning v WRAP_BADGE.top .. + h = 0.30 .. 0.82, and
      // the sun's flank ellipse bottoms out at v = SUN.r / FLANK.sLen −
      // sTop/sLen = 0.277 on the flank's own centreline and less either side
      // of it — so the badge never reaches the sun at ANY u and lands
      // entirely on BARE COVER. (It was v 0.10 .. 0.90 when this was first
      // measured, where the box's top-front corner could still graze the
      // disc; pulling the mark down to clear the sidepod removed even that.
      // RE-DERIVE THIS LINE IF BULL MOVES AGAIN — it is the whole argument
      // for the field below.)
      // Scoring it against both anyway asks one ink to clear a light sun AND
      // a dark cover, which is unsatisfiable, and markPalette answers an
      // unsatisfiable floor by falling back on a HALO: the mark went out
      // near-black on Cadillac's black cover (1.04) inside a white glow, and
      // white on Mercedes' silver (1.59) inside a dark one. Legible, and the
      // wrong car — what is lost is the brand colour, not the visibility.
      // Scored on the cover alone the floor is satisfiable, Cadillac wears
      // its gold at 8.43 and Mercedes its dark star at 11.39, and no halo is
      // drawn at all. (Atlas + the real garage; re-measured on the merged
      // tree after the mark moved. Nine teams were unaffected —
      // the split only opens when a team's sun and cover sit at opposite ends
      // of the luminance range.)
      const badgeLockup = markPalette(teamId, colors, [coverPaint], false, { noPlate: true });
      eachFlank((F) => {
        ctx.save();
        ctx.translate(F.fx(span.u0 + span.uLen / 2), F.R.y + F.R.h * (WRAP_BADGE.top + WRAP_BADGE.h / 2));
        ctx.scale(flankSquash(spineHeight, F.R), 1);
        const s = WRAP_BADGE.h * F.R.h;   // square through the squash, so square in metres
        const Rw = { x: -s / 2, y: -s / 2, w: s, h: s };
        if (LOGOS[teamId as string]) {
          drawLogoImage(ctx, LOGOS[teamId as string]!, Rw, logo,
                        markHalo(LOGOS[teamId as string], coverPaint, inkOn([coverPaint])), emblemRim);
        } else drawCrest(ctx, teamId, Rw, { liv: colors, field: [coverPaint], bare: true, palette: badgeLockup });
        ctx.restore();
      });
    }
    };
  } else if (spineLogo === "bigmark") {
    // BIG MARK: the mark WITHOUT its plate — Red Bull's bulls with no sun
    // disc, the way the RB22 wears the bull straight on the cover — at the
    // full crown width, top-down and in proportion like the crest above.
    // sq CANCELS the crest margin instead of being the region width. drawCrest
    // insets CREST_MARGIN (0.08) each side, so `sq = Rc.w` drew the mark at
    // 84 % of the crown and `bigmark` came out 1.087x `logo` — 8.7 % linear,
    // which measured +18 % area on ten of eleven teams and is invisible at
    // chase distance. Dividing it out puts the mark's own bbox on the crown's
    // full width (McLaren 83.7 % -> 100 %, 1.30x logo). It cannot overflow —
    // the bbox now EQUALS the width — but the clip below is the guard that the
    // atlas's neighbouring regions never pay for a mark that does.
    const Rc = REGIONS.crest, sq = Rc.w / (1 - CREST_MARGIN * 2);
    ctx.save();
    clipToRegion(ctx, Rc);
    ctx.translate(Rc.x + Rc.w / 2, Rc.y + Rc.h / 2); ctx.rotate(Math.PI); ctx.scale(1, CROWN_SQUASH);
    const Rb = { x: -sq / 2, y: -sq / 2, w: sq, h: sq };
    if (LOGOS[teamId as string]) {
      drawLogoImage(ctx, LOGOS[teamId as string]!, Rb, logo, markHalo(LOGOS[teamId as string], coverPaint, inkCrest), emblemRim);
    } else drawCrest(ctx, teamId, Rb, { liv: colors, field: [coverPaint], bare: true,
                                        palette: markPalette(teamId, colors, [coverPaint], true, { noPlate: true }) });
    ctx.restore();
  } else if (spineLogo !== "none") {
    // The tricolour's SECOND band: a colour clearing the cover it sits on AND
    // the first band beside it. The ink is tried first, so a livery whose
    // bands already separate keeps exactly what it wears today.
    // BAND TINT 2 (liv.bandTint2) — the tricolour's SECOND band. Without it the
    // design is two colours you cannot both choose: SPINE TINT owns one band
    // and the other was derived, which is how four teams ended up wearing a
    // "tricolour" of one colour repeated (1.01:1 on Mercedes).
    const bandC2 = colors.bandTint2 || pickOn(([inkCrest] as Col[]).concat(BAND_ORDER), [coverPaint, bandC], BAND_ON_COVER);
    drawSpineTop(ctx, spineLogo, REGIONS.crest, coverPaint, bandC, inkCrest, names[0] || "", raceNum, colors.numFont, bandC2, colors, bandWeak);
    if (spineLogo === "saddle" || coverBind === "saddleWrap") {
      saddleFlanks(ctx, saddleFill(colors, bandC, coverPaint) || bandC);
    }
  }
  if (REGIONS.tail && finHandoffOf(colors) !== "hardCut") {
    drawTailTop(ctx, spineLogo, REGIONS.tail, bandC, inkCrest, names[1] || "", colors, coverPaint, bandWeak);
  }
  // TAIL GRAPHIC wash: finArt if set, else the first BASE that clears the
  // fin plate. BODY STRIPE / DETAIL stay out of this chain, or they steal
  // the motif colour whenever a custom sets a stripe.
  const finWash = finArt || [c2, c1, inkFin].filter(Boolean)
    .find((c) => contrast(c, finPaint) >= 1.8) || inkFin;
  drawTailGraphic(ctx, teamId, REGIONS.fin, c1, finPaint, finWash, tailStyle);
  if (finBadge === "logo") {
    paintTeamMark(ctx, teamId, colors, REGIONS.finBadge,
      finReal ? [coverPaint, finPaint] : [coverPaint], {
        halo: LOGOS[teamId as string] ? markHalo(LOGOS[teamId as string], finPaint, inkFin) : null,
      });
  } else if (finBadge === "number" || finBadge === "code") {
    // The race number (or the driver's code) on the fin, inked for the FIN
    // paint — the badge box is wholly on the plate — with no board patch and
    // no crest head: the plate is the board. `num` is resolved below for the
    // nose; hoist its value.
    const finNum = resolveRaceNumber(numberOverride, teamId);
    const text = finBadge === "code" ? driverCode(teamId, finNum) : finNum;
    drawNumber(ctx, text, REGIONS.finBadge, inkFin, finWash, null, colors.numFont, 0);
  }
  // SPINE SIDE (SPINE_SIDE_IDS): the same three marks on the cover FLANK, inked
  // for the paint the flank actually wears — buildEngineCoverBodywork paints
  // the WHOLE cover, flank included, in `cover` — with the cover's own lockup.
  // Two SPINE TOP designs repaint that flank before the mark lands on it, and
  // then THEY are the backing: the wrap's sun and the saddle's panel both
  // cover the mark's station (f 0.19). Read BEFORE the crown chain, because
  // what the crown paints on the FLANK now depends on whether the flank has
  // a side design of its own.
  // What the flank ACTUALLY wears. The saddle's is bandC, because bandC is
  // what saddleFlanks is handed — `stripe || accent` was a guess at it, and
  // on Mercedes and Ferrari the two differ, which is why their split still
  // painted 1.00:1 after the flank band was first pointed here. The wrap's
  // sun covers only the front of the band, so under it a flank-wide graphic
  // crosses BOTH the sun and the bare cover and has to clear each.
  const saddleFlankC = saddleFill(colors, bandC, coverPaint);
  let flankBg = coverPaint;
  if (spineLogo === "wrap") flankBg = sunColour(teamId, colors);
  else if (saddleFlankC != null && (spineLogo === "saddle" || coverBind === "saddleWrap")) flankBg = saddleFlankC;
  const flankBgs = spineLogo === "wrap" ? [sunColour(teamId, colors), coverPaint] : [flankBg];
  // …and a MARK on that flank answers to the same surfaces the band does.
  // Every flank pick — the crest, the number, the code, the wordmarks, duo —
  // took inkCrest, which is resolved against the COVER, while standing on a
  // flank the crown design has repainted. That is not merely unlucky, it is
  // guaranteed the wrong polarity: bandC is CHOSEN to sit 2.0 clear of the
  // cover, so an ink picked for the cover is picked to sit close to the band.
  // Measured on the shipped defaults with SPINE TOP saddle: Mercedes' number
  // 1.02:1 on its own saddle, McLaren's crest 1.01, Cadillac's number 1.09.
  // A leftover CREST INK on a stored liv still wins for flank glyphs (legacy);
  // the sheet no longer authors it — new paint jobs auto-ink here.
  // …and under a WRAP that surface is not the sun: the mark never touches
  // it, and naming it would be the same phantom-surface mistake as the fin
  // (with a near-white sun over a near-black cover NO ink clears both, and
  // the compromise landed on Williams' sun at 1.07:1). It is the BULL, since
  // uOnCrown stands the mark on the animal rather than aft of it — one
  // silhouette and the cover showing round it, both real, both scored.
  // flankBullColour is the painter's own answer, not a second guess at it.
  // The full-width BANDS cross the sun as well, so flankBgs keeps both.
  let markBgs = flankBgs;
  if (spineLogo === "wrap") {
    markBgs = bullPath(teamId)
      ? [flankBullColour(teamId, colors, flankBg, coverPaint, c1), coverPaint]
      : [coverPaint];   // no traced bull, and then the wrap leaves the flank bare
  }
  const markBg = markBgs[0]!;
  // Lettering that SPANS the saddle's raked edge, inked for the saddle alone,
  // runs onto bare cover and vanishes (dual-bg ink ruins the gold). Clamp
  // wordmark/duo ONTO the saddle panel, and stroke a forced halo
  // when a mark still shares the rake. Recorded in the flank-clear guard —
  // KNOWN must shrink when this holds.
  const inkFlank = inkOn(spineLogo === "wrap" ? [coverPaint] : flankBgs);
  // The MARK's own ink, against the MARK's own surfaces. Identical to
  // inkFlank everywhere the two lists are (every crown but the wrap).
  const inkMark = inkOn(markBgs);
  // Force a halo on the saddle: inkFlank.worst is high against bandC, so
  // haloIf would skip — and that is exactly when the aft letters leave the
  // panel onto the cover.
  // Adjustable wraps cross both bare paint and arbitrary colours/gradients.
  // A contrasting keyline keeps lettering readable across every boundary.
  const designWrap = !!paintDesign && colors.patternPlacement === "wrap";
  const flankHalo = (ink: Ink) => spineLogo === "saddle" || designWrap ? haloFor(ink) : haloIf(ink);
  // ...and a band painted ON that flank has to clear IT, not the cover. bandC
  // is scored against coverPaint, so wherever the crown design has repainted
  // the flank — the saddle in stripe||accent, the wrap in the sun's colour —
  // split, bars and slash were painting that colour onto itself: measured
  // 1.00:1 over 44 % of both flanks, on every team, and none of the three
  // carries a keyline that would survive it. Identity check, not a colour
  // compare: where the flank IS the cover this is bandC and the atlas is
  // byte-identical to before.
  // SIDE TINT (liv.sideTint) — what the SPINE SIDE band designs (band, sash,
  // ribbon) paint, picked as picked. One field cannot serve two zones: spineTint
  // paints the flank UNDER these when the crown design is a saddle, so a band
  // taking the same value would be a no-op. This is the second zone's own
  // colour, and like spineTint it skips the re-pick entirely — the derived
  // default keeps the guard, which is where the invisible bands came from.
  // SIDE TINT owns the flank band. Never inherit spineTint/bandC — that made
  // SPINE TOP saddle / stripe recolour SPLIT/BARS/SLASH when SIDE was unset.
  const flankBandC = colors.sideTint || pickOn(BAND_ORDER, flankBgs, BAND_ON_COVER);
  // The flank canvas is the WHOLE cover side. The marks sit AT THE FRONT of
  // it — the SF-26's 16 and the W17's 12 just behind the airbox — through
  // flankSquash() so they come out in proportion. At 0.24 of the band, a
  // third of the way down the cover, they read as "really far back"; 0.19
  // is as far forward as they go without the mark's own leading
  // edge leaving the band, and the band itself cannot start further forward
  // because the airbox and roll hoop occupy the flank ahead of z -0.66.
  // Every side design is painted once per flank, in that flank's frame —
  // and inside the part of it the CROWN design has left free. `su` is the
  // side band's own 0→1 along the flank; under the wrap it starts aft of the
  // crown's graphic, everywhere else it is the whole flank.
  // …AFT OF THE SUN, NOT AFT OF THE BULL: only the SUN's reach binds (the
  // bull ends at 0.40, well short of FLANK_SEEN). Measured
  // on the SHIPPED Red Bull (crown wrap, side duo) from the garage side
  // camera by tools/car/flank-occlusion.mjs: 92 % of duo's ink behind the
  // car, 95 % of a wordmark's, 100 % of slash's, 50-54 % of every flank mark.
  // The two graphics are not the same kind of obstacle. The sun is a hard
  // gold disc that swallows whatever crosses it, so the band still clears it
  // — sunReach, derived, not a copied 0.216. The bull is a silhouette, it is
  // painted BETWEEN the fills and the lettering (paintFlankBull), and
  // the crease strip above its back is free because BULL.top dropped it onto
  // the sidepod line. Sharing the flank with the mark is what the real cover
  // does; hiding behind the rear tyre to avoid it is not.
  const sideFrom = spineLogo === "wrap" ? Math.round((sunReach(0) + 0.02) * 1000) / 1000 : 0;
  // …and a band may run to the tail of the flank, but CONTENT may not: a
  // stripe's aft end disappearing behind the wheel is a stripe, a sponsor
  // name's aft end disappearing behind the wheel is half a word. `su` is the
  // band axis, `sc` the content axis, and they differ only where a crown has
  // taken the front — every other team's lettering is where it always was.
  const sideTo = sideFrom ? FLANK_SEEN : 1;
  const su = (F: FlankFrame, u: number) => F.fx(sideFrom + u * (1 - sideFrom));
  const sc = (F: FlankFrame, u: number) => F.fx(sideFrom + u * (sideTo - sideFrom));
  const sbox = (F: FlankFrame, u0: number, u1: number, v0: number, v1: number): LiveryRect => {
    const xa = sc(F, u0), xb = sc(F, u1);
    return { x: Math.min(xa, xb), y: F.R.y + v0 * F.R.h, w: Math.abs(xb - xa), h: (v1 - v0) * F.R.h };
  };
  // A MARK is one small object and it carries its own keyline, halo or plate,
  // so it stands ON the crown's graphic rather than aft of it — centred in
  // the strip a side camera can see, its leading edge clear of the sun.
  // The mark is NOT pushed clear of the wrap's fallback badge, and that is a
  // decision, not an oversight. Their boxes do overlap on paper (mark u
  // 0.169..0.591 against a badge at 0.050..0.247), and a version of this file
  // derived markU from the badge's aft edge to separate them. It was reverted
  // on measurement: the only failures it removed were an artifact of the
  // guard taking its single WORST pixel, so one anti-aliased glyph edge
  // condemned a mark reading 7.73:1 over 286 of its 288 sampled points. With
  // the guard asking for 5 % of the mark's own ink before it calls a pair a
  // defect, nothing here is red — and the move cost about 3 % of the mark to
  // the body (flank-occlusion: 0 % at u 0.38, 5 % at 0.48) and walked toward
  // the rear wheel that c4d585b6 moved these designs forward to escape.
  // A glyph edge abutting what is beside it is not a legibility defect.
  const flankMark = (paint: (Rm: LiveryRect) => void) => eachFlank((F) => {
    const st = flankMarkStation(spineLogo, sideFrom, spineSide);
    ctx.save();
    ctx.translate(F.fx(st.u), F.R.y + F.R.h * st.v);
    ctx.scale(flankSquash(spineHeight, F.R), 1);
    paint({
      x: -F.R.h * FLANK_MARK.halfW, y: -F.R.h * FLANK_MARK.halfH,
      w: F.R.h * FLANK_MARK.halfW * 2, h: F.R.h * FLANK_MARK.halfH * 2,
    });
    ctx.restore();
  });
  // The crown's flank graphic takes its place in the stack (see the layer
  // note where paintFlankBull is declared).
  if (paintFlankBull && !SIDE_FILL[spineSide]) { paintFlankBull(); paintFlankBull = null; }
  if (paintDesign && !SIDE_FILL[spineSide]) paintDesign();
  if (spineSide === "logo" || spineSide === "emblem") {
    // logo / emblem: paintTeamMark — same logo / logo2 / logo3 routing as the
    // parts livery tiles (paintSwatch), not a separate flank palette.
    // …and the brand PLATE comes along only where it clears the flank it
    // lands on. Resolved WITH the plate, the mark is inked to read on a
    // backing that is then painted onto whatever the crown left there —
    // Ferrari's yellow shield on its white cover under the wrap, 1.09:1;
    // Red Bull's gold disc on its gold saddle, 1.10:1 — the ledger's noPlate
    // class (DEFECT-LEDGER 2026-09-09), which returns if the flank goes
    // through paintTeamMark without the flag. Under a plain crown the plate reads
    // (shield on red, disc on navy) and stays; an authored LOGO DETAIL plate
    // is a pick and stays regardless. Measured against every paint the mark
    // spans (markBgs), the same list the mark itself is floored on.
    const paintFlankLogo = (Rm: LiveryRect, scaleCrest: boolean) => {
      const img = LOGOS[teamId as string];
      paintTeamMark(ctx, teamId, colors, Rm, markBgs, {
        halo: img ? markHalo(img, markBg, inkMark) : null,
        crestScale: !!scaleCrest,
        // Brand plates (Ferrari yellow shield, Red Bull sun) win unscored in
        // markPalette — on a white saddle flank that is 1.09:1. The flank
        // field is already the contrast surface; skip the plate here.
        noPlate: true,
      });
    };
    if (spineSide === "emblem") {
      // Garage-hero crest: a touch larger than the first pass so it reads as
      // a mark, not a badge, without crossing the sidepod line (vMid stays
      // under the fin-design ceiling — measured clear at 0.40).
      eachFlank((F) => {
        ctx.save();
        ctx.translate(sc(F, sideFrom ? 0.45 : 0.22), F.R.y + F.R.h * FLANK_MARK.v);
        ctx.scale(flankSquash(spineHeight, F.R), 1);
        paintFlankLogo({
          x: -F.R.h * 0.52, y: -F.R.h * 0.36,
          w: F.R.h * 1.04, h: F.R.h * 0.72,
        }, false);
        ctx.restore();
      });
    } else {
      flankMark((Rm) => paintFlankLogo(Rm, true));
    }
  } else if (spineSide === "number" || spineSide === "code") {
    flankMark((Rm) => drawNumber(ctx, spineSide === "code" ? driverCode(teamId, raceNum) : raceNum,
                                 Rm, inkMark, accent, null, colors.numFont, 0, flankHalo(inkMark)));
  } else if (spineSide === "plate") {
    // The number on a contrasting plate (drawNumber's own rounded board),
    // inked for the PLATE: the body colour when it reads on it, else an ink.
    // The plate has to separate from the FLANK, and the saddle paints that
    // flank in stripe||accent — the plate's own first choice. Ferrari shipped
    // a number board the exact colour of the panel it sits on.
    // PLATE PANEL (liv.plateTint) is the board colour. Board lettering auto-inks.
    // PLATE PANEL is its own row. Unset = bases against the mark/flank field —
    // not BODY STRIPE or DETAIL (those are other rows). Contrast vs markBg
    // (wrap may put the plate on the bull colour, not bare cover).
    let plateC = colors.plateTint || pickOn([c2, c1, INK_DARK, INK_LIGHT], markBg, 1.6);
    if (!colors.plateTint && contrast(plateC, markBg) < 1.6) {
      for (const cand of [c2, c1, INK_DARK, INK_LIGHT].filter(Boolean)) {
        if (contrast(cand, markBg) > contrast(plateC, markBg)) plateC = cand;
      }
    }
    // Ink for the BOARD. Glyph overhang onto the flank is a halo/clip problem;
    // scoring ink against plate+flank together forced a light ink on Red Bull's
    // gold saddle (no colour clears navy board AND gold flank).
    const plateGlyph = inkOn([plateC]);
    flankMark((Rm) => drawNumber(ctx, raceNum, Rm, plateGlyph, inkMark, plateC, colors.numFont, 0,
                                 contrast(plateGlyph, markBg) < 2.0 ? haloFor(plateGlyph) : null));
  } else if (spineSide === "wordmark") {
    // The title sponsor along the UPPER half — the W17's PETRONAS, McLaren's
    // title on the papaya cover. Under a wrap it rides the CREASE STRIP that
    // BULL.top freed above the animal's back. Under a saddle it STAYS on the
    // saddle panel (aft of ~u 0.50 leaves the rake onto bare cover).
    eachFlank((F) => {
      let box = sbox(F, 0.06, 0.94, 0.12, 0.48);
      if (sideFrom) box = sbox(F, 0.02, 0.98, 0.03, 0.30);
      else if (spineLogo === "saddle") box = sbox(F, 0.04, 0.50, 0.12, 0.48);
      const ink = sideFrom ? inkMark : inkFlank;
      drawWordmark(ctx, names[0] || "", box, ink, {
        align: "center", pad: (sideFrom || spineLogo === "saddle") ? 6 : 14,
        halo: flankHalo(ink),
      });
    });
  } else if (spineSide === "duo") {
    // Title sponsor large across the rear, partner small and forward — the
    // RB22's Red Bull over Ford Racing. Both on the UPPER half so they read
    // as cover graphics, not sidepod stickers.
    // Side by side down the whole flank, but STACKED when a crown design
    // has taken the front: two names abreast in a third of the flank clipped
    // the partner to "(DRENY)". Under a wrap that stack is the crease strip,
    // in the part of it the rear tyre does not cover. Under a saddle both
    // names stay forward of the rake (u ≤ 0.50).
    eachFlank((F) => {
      if (sideFrom) {
        // The lower name overhangs the bull's back by a whisker, which is why
        // it takes the MARK's ink and the mark's surfaces: it is lettering on
        // a graphic, not lettering on bare cover. Rows any shorter than this
        // and the fit walk lands on 12 px against the 18 px the same two names
        // get on every other crown.
        drawWordmark(ctx, names[0] || "", sbox(F, 0.02, 0.98, 0.02, 0.17), inkMark, { align: "center", pad: 4, halo: haloIf(inkMark) });
        drawWordmark(ctx, names[1] || "", sbox(F, 0.12, 0.88, 0.18, 0.33), inkMark, { align: "center", pad: 4, halo: haloIf(inkMark) });
        return;
      }
      if (spineLogo === "saddle") {
        drawWordmark(ctx, names[0] || "", sbox(F, 0.04, 0.50, 0.08, 0.30), inkFlank,
          { align: "center", pad: 4, halo: flankHalo(inkFlank) });
        drawWordmark(ctx, names[1] || "", sbox(F, 0.04, 0.46, 0.32, 0.52), inkFlank,
          { align: "center", pad: 4, halo: flankHalo(inkFlank) });
        return;
      }
      drawWordmark(ctx, names[0] || "", sbox(F, 0.40, 0.96, 0.14, 0.50), inkFlank,
        { align: "center", pad: 8, halo: flankHalo(inkFlank) });
      drawWordmark(ctx, names[1] || "", sbox(F, 0.05, 0.35, 0.16, 0.46), inkFlank,
        { align: "center", pad: 6, halo: flankHalo(inkFlank) });
    });
  } else if (spineSide === "title") {
    // Title sponsor ON a contrasting board — distinct from bare wordmark / PLATE.
    let boardC = colors.plateTint || c2 || accent;
    if (!colors.plateTint && contrast(boardC, markBg) < 2.0) {
      for (const cand of [c2, c1, INK_DARK, INK_LIGHT].filter(Boolean)) {
        if (contrast(cand, markBg) > contrast(boardC, markBg)) boardC = cand;
      }
    }
    // Same board-first ink as PLATE; halo when the flank would swallow a spill.
    const boardInk = inkOn([boardC]);
    eachFlank((F) => {
      // Under a saddle stay on the panel — past u 0.50 is bare cover, and a
      // teal TITLE board on Mercedes' pale cover measured 1.53:1.
      let box = sbox(F, 0.08, 0.58, 0.14, 0.50);
      if (sideFrom) box = sbox(F, 0.06, 0.94, 0.04, 0.34);
      else if (spineLogo === "saddle") box = sbox(F, 0.04, 0.50, 0.14, 0.50);
      const r = Math.min(box.h * 0.18, box.w * 0.06);
      ctx.save();
      ctx.fillStyle = cssA(boardC, 0.98);
      ctx.beginPath();
      const x = box.x, y = box.y, w = box.w, h = box.h;
      ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath(); ctx.fill();
      // Thin ink rim so a pale TITLE board still separates from a pale cover
      // (same class as the plate keyline — without it Alpine's white board on
      // pink flash read as one slab).
      ctx.strokeStyle = cssA(INK_DARK, 0.35);
      ctx.lineWidth = Math.max(1.5, box.h * 0.04);
      ctx.stroke();
      ctx.restore();
      drawWordmark(ctx, names[0] || "", box, boardInk, {
        align: "center", pad: 6,
        halo: contrast(boardInk, markBg) < 2.0 ? haloFor(boardInk) : null,
      });
    });
  } else if (spineSide === "ribbon") {
    // A crease band the length of the flank with the number sitting in it —
    // the high station a 2026 cover actually wears (W17 PETRONAS strip, the
    // SF-26's 16 in the white saddle). The band hangs from the crease so it
    // cannot read as a sidepod sticker; the number is inked for the band.
    // Bottom ink keyline separates ribbon from bare band/sash fills.
    eachFlank((F) => {
      const Sf = F.R;
      ctx.save(); clipToRegion(ctx, Sf);
      ctx.fillStyle = cssA(flankBandC, 0.97);
      // Under a saddle clamp to the panel — a full-length ribbon in c2 on
      // Mercedes ran onto pale cover at 1.53:1.
      const uEnd = spineLogo === "saddle" ? 0.50 : 0.98;
      const x0 = su(F, 0.02), x1 = su(F, uEnd);
      const y0 = Sf.y + Sf.h * 0.04, rh = Sf.h * 0.32;
      ctx.fillRect(Math.min(x0, x1), y0, Math.abs(x1 - x0), rh);
      ctx.fillStyle = cssA(INK_DARK, 0.4);
      ctx.fillRect(Math.min(x0, x1), y0 + rh - Math.max(2, Sf.h * 0.02), Math.abs(x1 - x0), Math.max(2, Sf.h * 0.02));
      ctx.restore();
      ctx.save();
      // The band runs to the tail of the flank; the NUMBER in it may not.
      // Under a wrap sc's window is 0.385 of the flank and the digits are
      // 0.16 of it wide, so the only station that keeps the whole number in
      // both the band and the seen strip is the middle of the window.
      let numU = 0.16;
      if (sideFrom) numU = 0.45;
      else if (spineLogo === "saddle") numU = 0.22;
      ctx.translate(sc(F, numU), Sf.y + Sf.h * 0.20);
      ctx.scale(flankSquash(spineHeight, Sf), 1);
      const ribbonInk = inkOn([flankBandC]);
      drawNumber(ctx, raceNum, { x: -Sf.h * 0.30, y: -Sf.h * 0.13, w: Sf.h * 0.60, h: Sf.h * 0.26 },
                 ribbonInk, inkFlank, null, colors.numFont, 0,
                 contrast(ribbonInk, markBg) < 2.0 ? haloFor(ribbonInk) : null);
      ctx.restore();
    });
  } else if (spineSide === "lockup") {
    // Number forward and the team mark aft, both on the UPPER third — the
    // pairing a 2026 cover carries (the SF-26's 16 with HP, the W17's 12
    // with the star). The mark is BARE so its plate cannot clip the crease
    // the way the full lockup did at this station.
    // Two objects abreast need room, and under a wrap the window sc leaves is
    // 0.385 of the flank: they ride the crease strip at 0.7 scale rather than
    // one of them sliding aft into the wheel.
    const k = sideFrom ? 0.70 : 1, vMid = sideFrom ? 0.15 : 0.28;
    eachFlank((F) => {
      ctx.save();
      ctx.translate(sc(F, sideFrom ? 0.22 : 0.12), F.R.y + F.R.h * vMid);
      ctx.scale(flankSquash(spineHeight, F.R), 1);
      drawNumber(ctx, raceNum, { x: -F.R.h * 0.26 * k, y: -F.R.h * 0.20 * k, w: F.R.h * 0.52 * k, h: F.R.h * 0.40 * k },
                 inkMark, accent, null, colors.numFont, 0, flankHalo(inkMark));
      ctx.restore();
      ctx.save();
      ctx.translate(sc(F, sideFrom ? 0.74 : 0.40), F.R.y + F.R.h * vMid);
      ctx.scale(flankSquash(spineHeight, F.R), 1);
      const Rm = { x: -F.R.h * 0.20 * k, y: -F.R.h * 0.16 * k, w: F.R.h * 0.40 * k, h: F.R.h * 0.32 * k };
      const lockupBare = spineLogo === "saddle" || spineLogo === "wrap";
      if (LOGOS[teamId as string]) {
        drawLogoImage(ctx, LOGOS[teamId as string]!, Rm, logo, markHalo(LOGOS[teamId as string], markBg, inkMark), emblemRim);
      } else {
        drawCrest(ctx, teamId, Rm, {
          liv: colors, field: markBgs, bare: true,
          palette: markPalette(teamId, colors, markBgs, false, lockupBare ? { noPlate: true } : undefined),
        });
      }
      ctx.restore();
    });
  } else if (spineSide === "band") {
    // Crease colour PANEL with a raked aft edge — not a flat UI rectangle.
    // Distinct from sash (diagonal racing stripe). SIDE_FILL under wrap bull.
    eachFlank((F) => {
      const Sf = F.R;
      ctx.save(); clipToRegion(ctx, Sf);
      ctx.fillStyle = cssA(flankBandC, 0.97);
      const uEnd = sideFrom ? 0.98 : 0.70;
      const y0 = Sf.y + Sf.h * 0.05, y1 = Sf.y + Sf.h * 0.56;
      ctx.beginPath();
      ctx.moveTo(su(F, 0.02), y0);
      ctx.lineTo(su(F, uEnd), y0);
      ctx.lineTo(su(F, uEnd * 0.88), y1);
      ctx.lineTo(su(F, 0.02), y1);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = cssA(INK_DARK, 0.38); ctx.lineWidth = Math.max(2, Sf.h * 0.016);
      ctx.beginPath();
      ctx.moveTo(su(F, 0.02), y1); ctx.lineTo(su(F, uEnd * 0.88), y1);
      ctx.stroke();
      ctx.restore();
    });
  } else if (spineSide === "sash") {
    // Constant-width diagonal racing sash — parallel edges, not a free
    // trapezoid. Reads as a sash; band stays the rectangular crease panel.
    eachFlank((F) => {
      const Sf = F.R;
      ctx.save(); clipToRegion(ctx, Sf);
      ctx.fillStyle = cssA(flankBandC, 0.97);
      const uEnd = sideFrom ? 0.98 : 0.68;
      const top = Sf.y + Sf.h * 0.04, bot = Sf.y + Sf.h * 0.62;
      // Forward edge deeper than aft so the stripe sweeps nose → tail.
      ctx.beginPath();
      ctx.moveTo(su(F, 0.02), top);
      ctx.lineTo(su(F, uEnd * 0.92), top);
      ctx.lineTo(su(F, uEnd), bot);
      ctx.lineTo(su(F, 0.14), bot);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = cssA(INK_DARK, 0.4); ctx.lineWidth = Math.max(2, Sf.h * 0.016);
      ctx.beginPath();
      ctx.moveTo(su(F, 0.14), bot); ctx.lineTo(su(F, uEnd), bot);
      ctx.stroke();
      ctx.restore();
    });
  } else if (spineSide === "rake") {
    // One hard diagonal colour cut — not the parallel-edge sash. An explicit
    // sideTint is a pick and is never re-derived. Under saddleWrap without a
    // sideTint, prefer saddleFill when it clears flankBgs; otherwise derive.
    let rakeC: Col;
    if (colors.sideTint) {
      rakeC = colors.sideTint;
    } else {
      const rakePref = coverBind === "saddleWrap" ? (saddleFlankC || flankBandC) : flankBandC;
      // flankBgs is a LIST — contrast() is pairwise; score the worst pair.
      const bgs = (Array.isArray(flankBgs) && Array.isArray(flankBgs[0])) ? flankBgs : [flankBgs as unknown as Col];
      const keep = rakePref && bgs.every((b) => b && contrast(rakePref, b) >= BAND_ON_COVER);
      rakeC = keep ? rakePref : pickOn(
        [flankBandC, inkCrest, c1, c2, INK_DARK, INK_LIGHT].filter(Boolean),
        flankBgs, BAND_ON_COVER);
    }
    eachFlank((F) => {
      const Sf = F.R;
      ctx.save(); clipToRegion(ctx, Sf);
      ctx.fillStyle = cssA(rakeC, 0.97);
      const u0 = sideFrom || 0.02;
      const uEnd = sideFrom ? sideTo : FLANK_SEEN;
      const vTop = Sf.y + Sf.h * 0.04, vBot = Sf.y + Sf.h * 0.58;
      ctx.beginPath();
      ctx.moveTo(su(F, u0), vBot);
      ctx.lineTo(su(F, uEnd), vTop);
      ctx.lineTo(su(F, uEnd), vBot);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = cssA(INK_DARK, 0.38); ctx.lineWidth = Math.max(2, Sf.h * 0.016);
      ctx.beginPath();
      ctx.moveTo(su(F, u0), vBot); ctx.lineTo(su(F, uEnd), vTop);
      ctx.stroke();
      ctx.restore();
    });
  } else if (spineSide === "shoulder") {
    // Upper-third shelf only; lower flank stays cover/body. Explicit sideTint
    // is a pick and is never re-derived. saddleTint is a pick too, EXCEPT
    // where the flank under the shelf is itself painted saddleFlankC (saddle
    // top or saddleWrap): then a saddleTint that does not clear it is the
    // shelf on its own colour (Ferrari/Audi, 1.00:1) and re-picks, like band.
    const onSaddleFlank = spineLogo !== "wrap" && saddleFlankC != null &&
      (spineLogo === "saddle" || coverBind === "saddleWrap");
    let shoulderC: Col;
    if (colors.sideTint) {
      shoulderC = colors.sideTint;
    } else if (colors.saddleTint && !(onSaddleFlank && contrast(colors.saddleTint, flankBg) < BAND_ON_COVER)) {
      shoulderC = colors.saddleTint;
    } else {
      shoulderC = pickOn(
        [flankBandC, inkCrest, c1, c2, INK_DARK, INK_LIGHT].filter(Boolean),
        flankBgs, BAND_ON_COVER);
    }
    eachFlank((F) => {
      const Sf = F.R;
      ctx.save(); clipToRegion(ctx, Sf);
      ctx.fillStyle = cssA(shoulderC, 0.97);
      const u0 = sideFrom || 0.02;
      const uEnd = sideFrom ? sideTo : FLANK_SEEN;
      const y0 = Sf.y + Sf.h * 0.04, y1 = Sf.y + Sf.h * 0.33;
      ctx.fillRect(Math.min(su(F, u0), su(F, uEnd)), y0, Math.abs(su(F, uEnd) - su(F, u0)), y1 - y0);
      ctx.strokeStyle = cssA(INK_DARK, 0.35); ctx.lineWidth = Math.max(2, Sf.h * 0.014);
      ctx.beginPath();
      ctx.moveTo(su(F, u0), y1); ctx.lineTo(su(F, uEnd), y1);
      ctx.stroke();
      ctx.restore();
    });
  } else if (spineSide === "starfield") {
    // Ordered halftone on the flank — not finStyle "stars". Same recipe as
    // crown `fade`: regular grid, radius ramps front→rear, no hash-skip
    // clumps. The previous 0.28 density skip read as broken-text clusters
    // at garage close-up (Mercedes cover, 1024/2048 atlas).
    // sideTint owns starfield ink; never crestInk (that row is gone from the
    // sheet and was never a flank graphic colour).
    const dotInk = colors.sideTint
      || pickOn(BAND_ORDER, flankBgs, BAND_ON_COVER);
    eachFlank((F) => {
      const Sf = F.R;
      ctx.save(); clipToRegion(ctx, Sf);
      const u0 = sideFrom || 0.02;
      const uEnd = sideFrom ? sideTo : FLANK_SEEN;
      const x0 = su(F, u0), x1 = su(F, uEnd);
      const y0 = Sf.y + Sf.h * 0.06, y1 = Sf.y + Sf.h * 0.58;
      const w = Math.abs(x1 - x0), h = y1 - y0;
      const cols = Math.max(8, Math.round(w / Math.max(4, w * 0.032)));
      const rows = Math.max(6, Math.round(h / Math.max(4, w * 0.032)));
      const cellW = w / cols, cellH = h / rows;
      const rMax = Math.min(cellW, cellH) * 0.38;
      const xMin = Math.min(x0, x1);
      const xFront = F.fx(u0), xRear = F.fx(uEnd);
      const span = xRear - xFront;
      ctx.fillStyle = cssA(dotInk, 0.97);
      for (let j = 0; j < rows; j++) {
        const cy = y0 + (j + 0.5) * cellH;
        for (let i = 0; i < cols; i++) {
          const cx = xMin + (i + 0.5) * cellW;
          const along = span !== 0 ? (cx - xFront) / span : 0; // 0 front, 1 rear
          const t = 1 - Math.max(0, Math.min(1, along));
          const r = rMax * (0.38 + 0.62 * t * t);
          if (r < 0.4) continue;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    });
  } else if (spineSide === "slash") {
    // ONE bold diagonal band from the crease — W17 rake as a single stroke,
    // not three pasted pinstripes. Not SIDE_FILL (wrap bull sits under sash/
    // band panels only).
    eachFlank((F) => {
      const Sf = F.R;
      const crease = Sf.y + Sf.h * 0.08;
      const skew = Sf.h * 0.28 * F.dir;
      const hh = Sf.h * 0.58;
      const bw = Sf.w * (1 - sideFrom) * 0.14 * F.dir;
      ctx.save(); clipToRegion(ctx, Sf);
      ctx.fillStyle = cssA(flankBandC, 0.97);
      const x0 = su(F, 0.12);
      ctx.beginPath();
      ctx.moveTo(x0 + skew, crease);
      ctx.lineTo(x0 + skew + bw, crease);
      ctx.lineTo(x0 + skew * (1 - hh / Sf.h) + bw, crease + hh);
      ctx.lineTo(x0 + skew * (1 - hh / Sf.h), crease + hh);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    });
  }
  if (paintFlankBull) { paintFlankBull(); paintFlankBull = null; }
  if (paintDesign && SIDE_FILL[spineSide]) paintDesign();

  // Sponsor wordmarks (names resolved above, by the spine).
  if (names.length) {   // `clean` leaves every wordmark region as paint
    // Opaque substrates UNDER every board wordmark. The mesh already paints
    // these panels; baking the same colour into the atlas stops mip/AA soft
    // fringes on SKYSTRIKE / NITROX / wing / strip letters at garage distance.
    // titleB stays unfilled: it drapes over curved nose paint, and a flat
    // patch would read as a sticker rectangle on the monocoque.
    fillRegion(ctx, REGIONS.titleA, board);
    fillRegion(ctx, REGIONS.fwEnd, c2);
    fillRegion(ctx, REGIONS.wing, colors.wing || c2);
    fillRegion(ctx, REGIONS.strip, c2);
    drawWordmark(ctx, names[0], REGIONS.titleA, inkPod,
      { align: "center", halo: haloIf(inkPod) });
    // titleB rides the NOSE, not the sidepod board: car-mesh drapes it over
    // the monocoque top at z 1.16..1.66, body paint with the c2 nose accent
    // reaching under its front edge. Inking it for the board resolved DARK
    // against a pale panel it never touches — 1.02:1 on a near-black c1, and
    // no halo, because the halo test scored the board too.
    drawWordmark(ctx, names[1], REGIONS.titleB, inkNose,
      { align: "center", halo: haloIf(inkNose) });
    // The FRONT-WING ENDPLATE carries a partner mark, as every 2026 car does.
    // The plate is drawn in c2 (see car3d's front-plate span), so it inks for
    // c2 — not for the flap colour, which is a different part.
    drawWordmark(ctx, names[4] || names[0], REGIONS.fwEnd, inkOn([c2]),
      { align: "center", spacing: 0.06, halo: haloIf(inkOn([c2])) });
    const inkWing = inkOn([colors.wing || c2]);
    drawWordmark(ctx, names[2], REGIONS.wing, inkWing,
      { align: "center", spacing: 0.1, halo: haloIf(inkWing) });
    // Long thin strip: chain a couple of names.
    drawWordmark(ctx, names[3] + "   " + names[4] + "   " + names[5],
      REGIONS.strip, inkStrip, { align: "center", spacing: 0.04, halo: haloIf(inkStrip) });
  }

  const num = resolveRaceNumber(numberOverride, teamId);
  drawNumber(ctx, num, REGIONS.num, ink, accent, c1, colors.numFont, NUM_CREST_HEAD);
  // Same lockup as the spine / fin, on the nose and both rear endplates.
  const numBadge = numCrestBox(REGIONS.num);
  if (LOGOS[teamId as string]) {
    drawLogoImage(ctx, LOGOS[teamId as string]!, numBadge, logo,
                  markHalo(LOGOS[teamId as string], c1, ink), emblemRim);
  } else drawCrest(ctx, teamId, numBadge, { liv: colors, field: [c1, c2], bare: true, palette: lockup });

  // Painted in SIZE space via setTransform(1/div); the canvas IS the upload.
  return canvas;
}

// ONE mark draw for every picker tile and every flank emblem — uploaded tint
// plus outline rows, traced crest via markPalette (logo / logo2 / logo3).
export function paintTeamMark(ctx: LiveryCtx2D, teamId: TeamId, liv: TexLivery | null | undefined, R: LiveryRect, field: unknown, opts?: TeamMarkOpts | null): void {
  const o: TeamMarkOpts = opts || {};
  const logo = liv && liv.logo;
  // Outline is logo3 only. logo2 is often the PLATE slot (Ferrari shield,
  // Red Bull disc) — feeding it here as a rim stole the plate colour from
  // the crest path and outlined uploaded emblems in the shield tint.
  const outline = (liv && liv.logo3) || null;
  let bgs: Col[] = [];
  if (field && (field as readonly unknown[]).length) bgs = ((Array.isArray((field as readonly unknown[])[0]) ? field : [field]) as readonly OptCol[]).filter(Boolean) as Col[];
  if (LOGOS[teamId as string]) {
    // Authored TEAM LOGO tint is the colour selected — no contrast re-pick,
    // no auto-halo. Untinted art on a pale field still gets a derived ink so
    // a white horse on a white saddle does not vanish.
    let tint: OptCol = logo || null;
    let halo = o.halo || null;
    if (!tint && bgs.length && bgs.some((b) => lum(b) > 0.55)) {
      tint = pickOn(
        [liv && liv.c1, liv && liv.c2, INK_DARK, INK_LIGHT].filter(Boolean),
        bgs, 2.0);
    }
    drawLogoImage(ctx, LOGOS[teamId as string]!, R, tint, halo, outline);
    return;
  }
  const crestR = o.crestScale ? flankEmblemBox(R, teamId) : R;
  // `noPlate` resolves the mark for a plate-less draw (see markPalette): the
  // flank passes it where the brand plate cannot clear the flank paint.
  drawCrest(ctx, teamId, crestR, {
    liv, field, bare: !o.fullLockup,
    palette: markPalette(teamId, liv, field, false, { noPlate: !!o.noPlate }),
  });
}

// Mini lockup for the LIVERY cards and TEAM picker tiles: paint + stripe +
// the same crest buildAtlas puts on the car. One function so the two pickers
// cannot drift from each other or from the atlas.
export function paintSwatch(ctx: LiveryCtx2D, teamId: TeamId, liv: TexLivery | null | undefined, w: number, h: number): void {
  const c1 = (liv && liv.c1) || [0.20, 0.20, 0.22];
  const c2 = (liv && liv.c2) || c1;
  ctx.fillStyle = css(c1);
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = css(c2);
  ctx.fillRect(Math.round(w * 0.56), 0, w, h);
  if (liv && liv.stripe) {
    const sw = Math.max(4, Math.round(w * 0.08));
    ctx.fillStyle = css(liv.stripe);
    ctx.fillRect(Math.round(w * 0.5 - sw / 2), 0, sw, h);
  }
  const pad = Math.round(Math.min(w, h) * 0.08);
  const R = { x: pad, y: pad, w: w - pad * 2, h: Math.round(h * 0.78) };
  paintTeamMark(ctx, teamId, liv, R, [c1, c2], {});
}

// drawLogoImage is exported for the GARAGE back-wall crest (js/garage/scene.js):
// aspect-fit + tint + halo is exactly the same job there, and reimplementing
// the fit maths in a second place is how the two drift apart.
// contrast/inkOn are exported for the GARAGE crest wall (js/garage/scene.js),
// which has to make the same "is this mark legible on this field, and if not
// what ink separates it" decision buildAtlas makes for the car.
/** f1-game's `LiveryTex` global (liverytex.js:2585-2593). Satisfies car3d.ts's
 *  LiveryTexHooks, so `configureCar3D({ liveryTex: LiveryTex })` wires it in.
 *  IS_MOBILE / IS_PHONE are getters over the configured GLX. */
export const LiveryTex = Object.freeze({
  SIZE, SIZE_H, atlasDiv, playerHiResDeferred,
  get IS_MOBILE(): boolean { return isMobileTier(); },
  get IS_PHONE(): boolean { return isPhone(); },
  atlasMobile, REGIONS, SPONSORS, SPONSOR_PACKS, buildAtlas, drawCrest, markBase, markPalette,
  MARK_FLOOR, numCrestBox, paintTeamMark, paintSwatch,
  drawLogoImage, contrast, inkOn, onMarkChange, markSlots, setTeamLogo, LOGOS,
  markOnField, ALT_INSIDE, sunColour, FLANK, FLANK_H, FLANK_MARK, flankMarkStation, FLANK_SEEN,
  CRESTS, CREST_DISC, crestKeepsPlate, CREST_MARGIN, STROKE_MIN, TEXT_MIN,
  NUM_FONT_IDS, SPONSOR_PACK_IDS, TAIL_STYLE_IDS, FIN_BADGE_IDS, SPINE_LOGO_IDS, SPINE_SIDE_IDS,
  FILL_SURFACES, fillInert,
  airboxMeshColour, resolveFinPaint,
  hasFlankBull: (teamId: TeamId): boolean => !!bullPath(teamId),
});
export type LiveryTexApi = typeof LiveryTex;

/** Exported for tests: the pure helpers the atlas is built from (not on f1-game's record). */
export const _internals = Object.freeze({
  to255, css, cssA, lin, lum, haloFor, fit, secondSlot, crestKey, legendOf, crestSpecFor, pickOn, saddleFill,
  ridgeFill, coverBindOf, finHandoffOf, finContrastBlock, flankBullColour, sunReach, bullPath, wrapMarkSpan,
  crestExtent, flankEmblemBox, flankSquash, resolveRaceNumber, teamShort, driverCode, liveFills,
  /** Drop the phone-tier scratch canvas (module state), so a test can start from a fresh one. */
  resetScratch(): void { scratchCanvas = null; },
});
