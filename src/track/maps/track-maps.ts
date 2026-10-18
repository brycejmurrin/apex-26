/**
 * TrackMaps: offline 2D circuit outlines for the track picker. Builds each
 * circuit's centreline from the game's own spline engine (no race, no network),
 * then caches the outline, the corner list (with turn classes), the direction,
 * the elevation range, the activation zones and the sector splits. Ported
 * verbatim from f1-game js/ui/track-maps.js (TrackMaps, :1-675).
 *
 * Differences from f1-game, none of which change a number:
 * - The IIFE's return object (track-maps.js:669) is this module's named exports;
 *   an ES module namespace is already frozen like `Object.freeze(TrackMaps)` (:675).
 * - `Tracks.*` are imports from ../core/tracks; def types are ../core/def BuiltDef.
 * - `Log.info` / `Log.warn` are dropped (logging only).
 * - `AeroZones` (js/physics/aero-zones.js `zonesFor`) is not ported yet, so it is
 *   an injected dependency (`setAeroZones`, new), absent by default. Absent takes
 *   f1-game's own "AeroZones unavailable" branch: no activation zones (:378-381).
 * - DOM access (document, getComputedStyle, canvases) happens only inside
 *   functions, so importing this module in Node does not touch the DOM.
 */
import type { BuiltDef } from "../core/def";
import * as Tracks from "../core/tracks";
import type { Track } from "../core/types";

// ── types ─────────────────────────────────────────────────────────────────

/** classifyCorner's turn classes (track-maps.js:49). */
export type CornerClass = "HAIRPIN" | "FAST" | "SLOW" | "MEDIUM";
/** measureApex's result (track-maps.js:127). */
export interface Apex { v: number; r: number; ang: number; cls: CornerClass; fPeak: number }
/** One corner (track-maps.js:140): its number, minimap position, apex lap fraction `f`,
 *  peak |curvature| `v`, apex radius `r` (m), heading sweep `ang` (deg) and class. */
export interface Corner { n: number; x: number; y: number; f: number; v: number; r: number; ang: number; cls: CornerClass }
/** An activation zone as lap fractions; `b` may pass 1 when it crosses the line (track-maps.js:388). */
export interface DrsZone { a: number; b: number; wrap: boolean }
/** The cached per-circuit data (track-maps.js:5, :192). */
export interface MapData {
  pts: [number, number][];
  py: Float32Array;
  corners: Corner[];
  dir: "CW" | "CCW";
  elevRange: number;
  drsZones: DrsZone[];
  sectors: number[] | null;
}
/** What assignCornerClasses reads and writes. */
export interface ClassedCorner { r: number; ang: number; cls: CornerClass }
/** The circuit fields themeColor reads. */
export interface ThemedDef { theme?: string | undefined }
/** The track a corner is measured on: a built centreline (Tracks.buildCenterline). */
type ApexTrack = Pick<Track, "n" | "total" | "tx" | "tz" | "curv" | "map">;

/** The part of AeroZones (js/physics/aero-zones.js) activationZones reads. */
export interface AeroZonesLike {
  zonesFor?(tr: Track): readonly { start: number; end: number }[];
}
let AeroZones: AeroZonesLike | null = null;
/** New (no f1-game counterpart): inject (or clear, with null) AeroZones. Absent by default. */
export function setAeroZones(impl: AeroZonesLike | null): void { AeroZones = impl; }

/** planPreview's measured card geometry (track-maps.js:243). Every length is LOCAL CSS px. */
export interface PreviewMeasure {
  aspect?: number | string | null | undefined;
  cardInnerW?: number | string | null | undefined;
  gap?: number | string | null | undefined;
  padY?: number | string | null | undefined;
  infoH?: number | string | null | undefined;
  labelH?: number | string | null | undefined;
  sectionH?: number | string | null | undefined;
  noScroll?: boolean | null | undefined;
}
/** planPreview's plan (track-maps.js:274). */
export interface PreviewPlan { shape: "beside" | "stacked"; slotW: number; slotH: number }

/** The canvas fitCanvas sizes (an HTMLCanvasElement). */
export interface FitTarget {
  width: number;
  height: number;
  style: Pick<CSSStyleDeclaration, "aspectRatio" | "width" | "height" | "maxWidth" | "maxHeight">;
}
/** fitCanvas's result (track-maps.js:312). */
export interface FitResult { w: number; h: number; aspect: number }

/** The canvas draw paints (an HTMLCanvasElement). */
export interface DrawTarget {
  width: number;
  height: number;
  getContext(contextId: "2d"): CanvasRenderingContext2D | null;
}
/** draw's options (track-maps.js:435-665). */
export interface DrawOpts {
  pad?: number | null | undefined;
  width?: number | undefined;
  sectors?: boolean | undefined;
  casing?: string | undefined;
  color?: string | undefined;
  drs?: boolean | undefined;
  start?: boolean | undefined;
  startColor?: string | undefined;
  mark?: number | null | undefined;
  markColor?: string | undefined;
  markFont?: number | null | undefined;
  corners?: boolean | undefined;
  cornerR?: number | undefined;
  cornerFont?: number | undefined;
  cornerColor?: string | undefined;
  legend?: boolean | undefined;
}

// ── the module ────────────────────────────────────────────────────────────

const cache: Record<string, MapData | null> = {};   // id -> { pts, py, corners, dir, elevRange, drsZones, sectors } | null

// theme accent colour for a circuit (used to tint its outline)
const THEME: Readonly<Record<string, string>> = {
  green: "#5ec269",
  modern: "#39b7f0",
  desert: "#f0b429",
  street_night: "#a78bfa",
  street_day: "#fb923c"
};
/** track-maps.js:15 */
export function themeColor(def: ThemedDef | null | undefined): string {
  return (def && THEME[def.theme!]) || "#cfd2d8";
}

// SECTOR IDENTITY: the podium metals in rank order, S1 gold, S2 silver, S3 bronze
// (--gold / --silver / --bronze, tokens.css), read by sectorColors() so CIRCUIT
// DETAIL and the in-race minimap name a sector alike. The literals are only the
// fallback for a context with no computed style.
/** track-maps.js:27 */
export const SECTOR_TOKENS: readonly string[] = ["--gold", "--silver", "--bronze"];
/** track-maps.js:28 */
export const SECTOR_COLORS: readonly string[] = ["#ffd700", "#c0c0c0", "#cd9b5a"];
/** track-maps.js:29 */
export function sectorColors(): string[] {
  const root = typeof document !== "undefined" && document.documentElement;
  const cs = root && typeof getComputedStyle === "function" ? getComputedStyle(root) : null;
  return SECTOR_TOKENS.map((k, i) => (cs && String(cs.getPropertyValue(k) || "").trim()) || SECTOR_COLORS[i]!);
}

/** track-maps.js:35 */
export const CLASS_COLORS: { readonly HAIRPIN: string; readonly SLOW: string; readonly MEDIUM: string; readonly FAST: string; readonly [cls: string]: string } = {
  HAIRPIN: "#f87171",
  SLOW: "#fb923c",
  MEDIUM: "#facc15",
  FAST: "#4ade80"
};

/**
 * Classify from approximate apex radius (m) + heading sweep (deg). Real hairpins
 * are very tight AND reverse heading; absolute bands (R≥70 FAST, R<40 SLOW) match
 * Monza/Spa guides on our centreline. track-maps.js:49
 */
export function classifyCorner(rM: number, angDeg: number): CornerClass {
  if (rM < 28 && angDeg >= 110) return "HAIRPIN";
  if (rM >= 70) return "FAST";
  if (rM < 40) return "SLOW";
  return "MEDIUM";
}

/**
 * Classify each corner, then tertile-spread the non-hairpins by radius when one
 * class dominates (≥ 70 %) or only one class shows, so the popup never paints
 * every chip the same colour. track-maps.js:56
 */
export function assignCornerClasses<T extends ClassedCorner>(crns: T[] | null | undefined): T[] | null | undefined {
  if (!crns || !crns.length) return crns;
  for (let i = 0; i < crns.length; i++) {
    crns[i]!.cls = classifyCorner(crns[i]!.r, crns[i]!.ang);
  }
  const rest: T[] = [];
  for (let i = 0; i < crns.length; i++) {
    if (crns[i]!.cls !== "HAIRPIN") rest.push(crns[i]!);
  }
  if (rest.length < 4) return crns;
  let nSlow = 0, nMed = 0, nFast = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i]!.cls === "SLOW") nSlow++;
    else if (rest[i]!.cls === "MEDIUM") nMed++;
    else nFast++;
  }
  const kinds = (nSlow > 0 ? 1 : 0) + (nMed > 0 ? 1 : 0) + (nFast > 0 ? 1 : 0);
  const dominant = Math.max(nSlow, nMed, nFast);
  if (kinds >= 2 && dominant / rest.length < 0.7) return crns;
  rest.sort(function (a, b) { return a.r - b.r; });
  const n = rest.length;
  for (let i = 0; i < n; i++) {
    const q = n === 1 ? 0.5 : i / (n - 1);
    rest[i]!.cls = q <= 1 / 3 ? "SLOW" : q >= 2 / 3 ? "FAST" : "MEDIUM";
  }
  return crns;
}

/**
 * The apex near lap fraction `frac`: the |curvature| peak within ±50 m, the band
 * around it where |k| ≥ max(0.0035, 0.3·kPeak), and the heading swept across that
 * band. track-maps.js:84
 */
export function measureApex(tr: ApexTrack, frac: number): Apex {
  const total = tr.total, n = tr.n, ds = total / n;
  const f = (((frac % 1) + 1) % 1);
  const s0 = f * total;
  let kPeak = Math.abs(Tracks.curvature(tr, s0)), sPeak = s0;
  for (let d = -50; d <= 50; d += 2) {
    const s = ((s0 + d) % total + total) % total;
    const k = Math.abs(Tracks.curvature(tr, s));
    if (k > kPeak) { kPeak = k; sPeak = s; }
  }
  const thr = Math.max(0.0035, kPeak * 0.3);
  let a = sPeak, b = sPeak;
  for (let step = 0; step < 100; step++) {
    const s = ((sPeak - (step + 1) * ds) % total + total) % total;
    if (Math.abs(Tracks.curvature(tr, s)) < thr) break;
    a = s;
  }
  for (let step = 0; step < 100; step++) {
    const s = ((sPeak + (step + 1) * ds) % total + total) % total;
    if (Math.abs(Tracks.curvature(tr, s)) < thr) break;
    b = s;
  }
  let len = (b - a + total) % total;
  if (len < ds) len = ds;
  const steps = Math.max(10, Math.round(len / ds));
  let dHead = 0, prev: number | null = null;
  for (let j = 0; j <= steps; j++) {
    const s = (a + (len * j / steps)) % total;
    const fi = s / total * n;
    const i = Math.floor(fi) % n, jj = (i + 1) % n, ff = fi - Math.floor(fi);
    const tx = tr.tx[i]! + (tr.tx[jj]! - tr.tx[i]!) * ff;
    const tz = tr.tz[i]! + (tr.tz[jj]! - tr.tz[i]!) * ff;
    const h = Math.atan2(tz, tx);
    if (prev != null) {
      let dh = h - prev;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      dHead += dh;
    }
    prev = h;
  }
  const ang = Math.abs(dHead) * 180 / Math.PI;
  const r = kPeak > 1e-6 ? 1 / kPeak : 999;
  return { v: kPeak, r: r, ang: ang, cls: classifyCorner(r, ang), fPeak: ((sPeak / total) % 1 + 1) % 1 };
}

/** track-maps.js:130 */
function cornerAt(tr: ApexTrack, frac: number, n: number): Corner {
  const m = tr.map!.length;
  const f = (((frac % 1) + 1) % 1);
  const idx = Math.floor(f * m) % m;
  const mp = tr.map![idx]!;
  const mes = measureApex(tr, f);
  // `f` is the apex's LAP FRACTION, the only field here in track space rather
  // than minimap space: the flyby sequencer anchors shots on `s = f * track.total`.
  return { n: n, x: mp[0], y: mp[1], f: mes.fPeak, v: mes.v, r: mes.r, ang: mes.ang, cls: mes.cls };
}

/** Drop a cached outline (one id, or every one with null) after LAZY_CIRCUIT hydrate. track-maps.js:144 */
export function invalidate(id?: string | null): void {
  if (id == null) {
    for (const k of Object.keys(cache)) delete cache[k];
    return;
  }
  delete cache[id];
}

/** Build the outline + corner list once from the spline engine, then cache. track-maps.js:153 */
function compute(def: BuiltDef | null | undefined): MapData | null {
  if (!def || !def.id) return null;
  if (Object.prototype.hasOwnProperty.call(cache, def.id)) return cache[def.id] as MapData | null;
  // Title boots meta-only stubs: do not cache a null miss; ensureCircuit
  // hydrates path and the next paint recomputes.
  if (def._metaOnly || !(def.path && def.path.pts && def.path.pts.length)) return null;
  // A custom circuit's id is its content hash: keep only what Tracks.LIST still
  // lists (CustomTracks.sync replaces the custom rows), plus this one.
  if (def.custom) {
    const listed = new Set(Tracks.LIST.map((d) => d.id));
    for (const id of Object.keys(cache)) if (!listed.has(id)) delete cache[id];
  }
  let out: MapData | null = null;
  try {
    // Centreline-only build ({ line: false }): the minimap needs the spline but
    // not the 3D meshes, GPU upload or the racing line.
    const tr = Tracks.buildCenterline(def, { line: false });
    if (tr && tr.map && tr.map.length > 2) {
      const pts = tr.map.map((p): [number, number] => [p[0], p[1]]);
      let crns: Corner[];
      if (def.turns && def.turns.length) {
        crns = def.turns.map((frac, i) => cornerAt(tr, frac, i + 1));
      } else {
        crns = detectCorners(tr);
      }
      assignCornerClasses(crns);
      const dir = circuitDirection(tr);
      const elevRange = elevationRange(tr);
      const drsZones = activationZones(tr);
      const sectors = (def.sectors && def.sectors.length === 2) ? def.sectors.slice() : null;
      out = { pts: pts, py: tr.py, corners: crns, dir: dir, elevRange: elevRange, drsZones: drsZones, sectors: sectors };
    }
  } catch {
    out = null;
  }
  cache[def.id] = out;
  return out;
}

/** The minimap outline points, or null. track-maps.js:201 */
export function outline(def: BuiltDef | null | undefined): [number, number][] | null {
  const c = def && compute(def);
  return c ? c.pts : null;
}

/** World-space outline aspect (x/z span), clamped to [0.5, 2.5]; 520/300 without one. track-maps.js:209 */
export function aspect(def: BuiltDef | null | undefined): number {
  const pts = outline(def);
  if (!pts || pts.length < 2) return 520 / 300;
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i]![0] < minx) minx = pts[i]![0]; if (pts[i]![0] > maxx) maxx = pts[i]![0];
    if (pts[i]![1] < miny) miny = pts[i]![1]; if (pts[i]![1] > maxy) maxy = pts[i]![1];
  }
  return Math.max(0.5, Math.min(2.5, (maxx - minx) / ((maxy - miny) || 1)));
}

// How a circuit-preview card should spend its space, as pure arithmetic over ONE
// card's measured geometry (testable without a browser). The knobs, and the
// failure each one holds shut:
const CAPTION_MIN = 185;        // caption keeps its facts on one or two lines
const BESIDE_MIN_W = 340;       // below this a card cannot seat both columns
const BESIDE_ASPECT_MAX = 1.1;  // only a circuit TALLER than wide is helped by turning sideways
const BESIDE_DEAD_FRAC = 0.34;  // a third of the card empty beside the map: stacking is wasting it
const FLOOR_MAX_H = 240;        // never trade the map away at a big UI SIZE; let the column scroll
const MIN_SLOT_W = 120;
const SLACK = 10;               // breathing room so the card cannot cause its own scroller
// Every length is LOCAL (pre-zoom) CSS px: the caller owes offsetHeight/clientWidth, not visual px.
/** track-maps.js:243 */
export function planPreview(m?: PreviewMeasure | null): PreviewPlan {
  m = m || {};
  const a = Math.max(0.05, +m.aspect! || 1);
  const cardInnerW = Math.max(80, +m.cardInnerW! || 0);
  const gap = Math.max(0, +m.gap! || 0);
  const padY = Math.max(0, +m.padY! || 0);
  const infoH = Math.max(0, +m.infoH! || 0);
  const labelH = Math.max(0, +m.labelH! || 0);
  const sectionH = +m.sectionH! > 0 ? +m.sectionH! : 0;
  // With no measured column to spend, fall back to the width and let the
  // aspect pick the height (the pre-layout first paint).
  const ceilFor = (stacked: boolean) => {
    if (!sectionH) return Math.max(72, Math.round(cardInnerW / a));
    return sectionH - labelH - padY - (stacked ? infoH + gap : 0) - SLACK;
  };
  const stackedH = Math.min(Math.round(cardInnerW / a), ceilFor(true));
  const stackedW = Math.min(cardInnerW, Math.round(stackedH * a));
  const beside = a < BESIDE_ASPECT_MAX && cardInnerW >= BESIDE_MIN_W &&
    (cardInnerW - stackedW) / cardInnerW > BESIDE_DEAD_FRAC;
  const widthCap = Math.floor(beside ? cardInnerW - gap - CAPTION_MIN : cardInnerW);
  const floorH = Math.min(FLOOR_MAX_H, Math.round(widthCap / a));
  // The floor belongs to a SCROLLING column. A pair-on section clips, so there
  // (noScroll) the slot gets the measured ceiling, floored only at 40px.
  const ceil = Math.floor(ceilFor(!beside));
  const slotH = (m.noScroll && sectionH) ? Math.max(40, ceil) : Math.max(floorH, ceil);
  const slotW = Math.max(MIN_SLOT_W, Math.min(widthCap, Math.round(slotH * a)));
  return { shape: beside ? "beside" : "stacked", slotW: slotW, slotH: slotH };
}

/**
 * Size `canvas` to the circuit's aspect inside maxW × maxH (each floored at 40 px,
 * so a transient zero slot never commits a 1x1 canvas). `pinCss` pins the CSS
 * width/height; max-* are never pinned (they would replace the stylesheet's caps).
 * track-maps.js:277
 */
export function fitCanvas(canvas: FitTarget, maxW: number | null | undefined, maxH: number | null | undefined, def: BuiltDef | null | undefined, pinCss?: boolean): FitResult {
  const a = aspect(def);
  let boxW = Math.max(40, Math.floor(maxW || 1));
  let boxH = Math.max(40, Math.floor(maxH || 1));
  let w = boxW, h = Math.round(w / a);
  if (h > boxH) { h = boxH; w = Math.round(h * a); }
  w = Math.max(1, w); h = Math.max(1, h);
  canvas.width = w;
  canvas.height = h;
  canvas.style.aspectRatio = String(a);
  if (pinCss) {
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.style.maxWidth = "";
    canvas.style.maxHeight = "";
  } else {
    canvas.style.width = "";
    canvas.style.height = "";
    canvas.style.maxWidth = "";
    canvas.style.maxHeight = "";
  }
  return { w: w, h: h, aspect: a };
}
/** track-maps.js:314 */
export function corners(def: BuiltDef | null | undefined): Corner[] {
  const c = def && compute(def);
  return c ? c.corners : [];
}
/** track-maps.js:318 */
export function direction(def: BuiltDef | null | undefined): "CW" | "CCW" | null {
  const c = def && compute(def);
  return c ? c.dir : null;
}
/** track-maps.js:322 */
function elevationRange(tr: Pick<Track, "py">): number {
  const py = tr.py;
  if (!py || !py.length) return 0;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < py.length; i++) {
    if (py[i]! < mn) mn = py[i]!;
    if (py[i]! > mx) mx = py[i]!;
  }
  return Math.round(mx - mn);
}
/** track-maps.js:332 */
export function drsZones(def: BuiltDef | null | undefined): DrsZone[] {
  const c = def && compute(def);
  return c ? c.drsZones : [];
}
/** track-maps.js:336 */
export function elevRange(def: BuiltDef | null | undefined): number {
  const c = def && compute(def);
  return c ? c.elevRange : 0;
}
/** track-maps.js:340 */
export function elevProfile(def: BuiltDef | null | undefined): Float32Array | null {
  const c = def && compute(def);
  return c ? c.py : null;
}

/** track-maps.js:345 */
function circuitDirection(tr: Pick<Track, "px" | "pz" | "n">): "CW" | "CCW" {
  const px = tr.px, pz = tr.pz, n = tr.n;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += px[i]! * pz[j]! - px[j]! * pz[i]!;
  }
  return area > 0 ? "CW" : "CCW";
}

/**
 * THE ZONES THE RACE WILL ACTUALLY OPEN, asked of the module that decides them
 * (AeroZones.zonesFor), never re-derived here, and read at CALL time. Zones come
 * back in arc metres; the map speaks fractions. No fallback to a local scan: with
 * AeroZones missing the honest answer is "no zones". track-maps.js:377
 */
function activationZones(tr: Track): DrsZone[] {
  if (!AeroZones || !AeroZones.zonesFor) {
    return [];
  }
  const total = tr.total;
  if (!total) return [];
  // `b` is NOT clamped to 1: the zone down the main straight runs past the line
  // (end > total). Drawers walk floor(a*n)..floor(b*n) and index `% n`.
  return AeroZones.zonesFor(tr).map((z) => ({
    a: z.start / total,
    b: z.end / total,
    wrap: z.end > total
  }));
}

/**
 * Local maxima of |curvature| above 0.0075, merged within ~2 % of the lap (and
 * across the start/finish seam), numbered in driving order. track-maps.js:397
 */
export function detectCorners(tr: ApexTrack): Corner[] {
  const n = tr.n, total = tr.total, m = tr.map!.length;
  const kv: number[] = new Array(n);
  for (let k = 0; k < n; k++) kv[k] = Math.abs(Tracks.curvature(tr, (k / n) * total));
  const THRESH = 0.0075;
  const peaks: { k: number; v: number }[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k - 1 + n) % n, b = (k + 1) % n;
    if (kv[k]! > THRESH && kv[k]! >= kv[a]! && kv[k]! > kv[b]!) peaks.push({ k: k, v: kv[k]! });
  }
  // merge peaks within ~2% of the lap, keeping the sharper one
  const gap = Math.max(2, Math.round(0.02 * n));
  const merged: { k: number; v: number }[] = [];
  peaks.sort((p, q) => p.k - q.k);
  for (let i = 0; i < peaks.length; i++) {
    const last = merged[merged.length - 1];
    if (last && peaks[i]!.k - last.k < gap) {
      if (peaks[i]!.v > last.v) merged[merged.length - 1] = peaks[i]!;
    } else {
      merged.push(peaks[i]!);
    }
  }
  // The lap is a loop: a peak just before the seam and one just after it are
  // the same corner. Merge across the seam like any other pair.
  if (merged.length > 1) {
    const first = merged[0]!, last = merged[merged.length - 1]!;
    if (n - last.k + first.k < gap) {
      if (last.v > first.v) merged[0] = last;
      merged.pop();
    }
  }
  return merged.map((p, i) => {
    const frac = p.k / n;
    return cornerAt(tr, frac, i + 1);
  });
}

/**
 * Paint the circuit outline into `canvas`: casing + theme colour (or three sector
 * colours), activation zones, the start dot, one marked corner (`mark`), numbered
 * corner labels with a class legend. False when there is no outline. track-maps.js:435
 */
export function draw(canvas: DrawTarget, def: BuiltDef | null | undefined, opts?: DrawOpts | null): boolean {
  opts = opts || {};
  const g = canvas.getContext("2d")!;
  const W = canvas.width, H = canvas.height, pad = opts.pad != null ? opts.pad : 14;
  g.clearRect(0, 0, W, H);
  const data = compute(def);
  if (!data || data.pts.length < 3) return false;
  const pts = data.pts;

  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0];
    if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1];
  }
  const spanx = (maxx - minx) || 1, spany = (maxy - miny) || 1;
  const sc = Math.min((W - 2 * pad) / spanx, (H - 2 * pad) / spany);
  const ox = (W - spanx * sc) / 2, oy = (H - spany * sc) / 2;
  function PX(x: number) { return ox + (x - minx) * sc; }
  function PY(y: number) { return oy + (y - miny) * sc; }
  const cx = PX((minx + maxx) / 2), cy = PY((miny + maxy) / 2);

  const width = opts.width || 3;
  g.lineJoin = "round"; g.lineCap = "round";

  if (opts.sectors) {
    // Draw the full casing first so sectors don't have gaps in the outline
    g.strokeStyle = opts.casing || "rgba(0,0,0,0.55)";
    g.lineWidth = width + 2.5;
    g.beginPath();
    for (let i = 0; i <= pts.length; i++) {
      const p = pts[i % pts.length]!;
      i === 0 ? g.moveTo(PX(p[0]), PY(p[1])) : g.lineTo(PX(p[0]), PY(p[1]));
    }
    g.closePath();
    g.stroke();
    // Draw three coloured sectors on top (curated splits when available)
    const m = pts.length, SC = sectorColors();
    const splits = (data.sectors && data.sectors.length === 2)
      ? [0, data.sectors[0]!, data.sectors[1]!, 1]
      : [0, 1 / 3, 2 / 3, 1];
    for (let s = 0; s < 3; s++) {
      const from = Math.floor(splits[s]! * m);
      const to = s === 2 ? m - 1 : Math.max(from, Math.floor(splits[s + 1]! * m));
      g.strokeStyle = SC[s]!;
      g.lineWidth = width;
      g.beginPath();
      for (let i = from; i <= to; i++) {
        const p = pts[i]!;
        i === from ? g.moveTo(PX(p[0]), PY(p[1])) : g.lineTo(PX(p[0]), PY(p[1]));
      }
      // close S3 back to start
      if (s === 2) {
        const p0 = pts[0]!;
        g.lineTo(PX(p0[0]), PY(p0[1]));
      }
      g.stroke();
    }
  } else {
    // Single-color outline
    g.beginPath();
    for (let i = 0; i <= pts.length; i++) {
      const p = pts[i % pts.length]!;
      i === 0 ? g.moveTo(PX(p[0]), PY(p[1])) : g.lineTo(PX(p[0]), PY(p[1]));
    }
    g.closePath();
    g.strokeStyle = opts.casing || "rgba(0,0,0,0.55)"; g.lineWidth = width + 2.5; g.stroke();
    g.strokeStyle = opts.color || themeColor(def); g.lineWidth = width; g.stroke();
  }

  // DRS zones: bright cyan overlay on straight segments
  if (opts.drs && data.drsZones && data.drsZones.length) {
    const m = pts.length;
    g.lineWidth = width + 2;
    g.lineCap = "round";
    for (let z = 0; z < data.drsZones.length; z++) {
      const zone = data.drsZones[z]!;
      const from = Math.floor(zone.a * m);
      const to = Math.floor(zone.b * m);   // past m when the zone crosses the line
      g.strokeStyle = "rgba(0,220,180,0.85)";
      g.beginPath();
      for (let i = from; i <= to; i++) {
        const p = pts[i % m]!;
        i === from ? g.moveTo(PX(p[0]), PY(p[1])) : g.lineTo(PX(p[0]), PY(p[1]));
      }
      g.stroke();
    }
  }

  if (opts.start !== false) {
    const s = pts[0]!;
    g.fillStyle = opts.startColor || "#e10600";
    g.strokeStyle = "rgba(0,0,0,0.6)"; g.lineWidth = 1.5;
    g.beginPath(); g.arc(PX(s[0]), PY(s[1]), width + 1.5, 0, Math.PI * 2); g.fill(); g.stroke();
  }

  // ONE CORNER, CALLED OUT: `mark` is a turn number. A ring on the apex and a
  // "T4" tag pushed away from the circuit's middle; `markFont` is the tag's size
  // in BUFFER px. An unknown number draws nothing.
  const mk = opts.mark! > 0 ? data.corners[(opts.mark! | 0) - 1] : null;
  if (mk) {
    const x = PX(mk.x), y = PY(mk.y), col = opts.markColor || "#e10600";
    const fpx = opts.markFont! > 0 ? opts.markFont! : Math.max(10, Math.round(width * 2.6)), txt = "T" + (opts.mark! | 0);
    g.lineWidth = Math.max(1.5, width * 0.6);
    g.strokeStyle = col; g.fillStyle = "rgba(10,10,16,0.85)";
    g.beginPath(); g.arc(x, y, width * 1.8, 0, Math.PI * 2); g.fill(); g.stroke();
    const dx = x - cx, dy = y - cy, len = Math.hypot(dx, dy) || 1, off = width * 1.8 + fpx * 1.1;
    g.font = "800 " + fpx + "px system-ui, sans-serif";
    const hw = g.measureText(txt).width / 2 + fpx * 0.4, hh = fpx * 0.7;
    const lx = Math.min(W - hw, Math.max(hw, x + dx / len * off));
    const ly = Math.min(H - hh, Math.max(hh, y + dy / len * off));
    g.fillStyle = col;
    g.beginPath(); g.rect(lx - hw, ly - hh, hw * 2, hh * 2); g.fill();
    g.fillStyle = "#ffffff"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(txt, lx, ly + 0.5);
    g.textAlign = "left";
  }

  if (opts.corners) {
    const cs = data.corners;
    const rDot = opts.cornerR || 7;
    const fontPx = opts.cornerFont || 12;
    // Below this a numbered label per corner cannot fit without overlapping into
    // noise: a plain coloured dot per apex still reads as "corners are here".
    if (W < 200 || H < 140) {
      for (let i = 0; i < cs.length; i++) {
        const x = PX(cs[i]!.x), y = PY(cs[i]!.y);
        const cls = cs[i]!.cls || classifyCorner(cs[i]!.r || (cs[i]!.v > 1e-6 ? 1 / cs[i]!.v : 999), 0);
        const col = CLASS_COLORS[cls] || (opts.cornerColor || "#fff");
        g.fillStyle = col;
        g.beginPath(); g.arc(x, y, Math.max(1.5, rDot * 0.4), 0, Math.PI * 2); g.fill();
      }
      return true;
    }
    const labelR0 = Math.max(20, rDot + 14);
    const labels: { i: number; x: number; y: number; dx: number; dy: number; lx: number; ly: number; col: string; n: number }[] = [];
    for (let i = 0; i < cs.length; i++) {
      const x = PX(cs[i]!.x), y = PY(cs[i]!.y);
      const cls = cs[i]!.cls || classifyCorner(cs[i]!.r || (cs[i]!.v > 1e-6 ? 1 / cs[i]!.v : 999), 0);
      const col = CLASS_COLORS[cls] || (opts.cornerColor || "#fff");
      let dx = x - cx, dy = y - cy;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      // Alternate radial distance for neighbours so T1/T2 chicanes don't stack.
      const labelR = labelR0 + (i % 2) * 8;
      labels.push({ i: i, x: x, y: y, dx: dx, dy: dy, lx: x + dx * labelR, ly: y + dy * labelR, col: col, n: cs[i]!.n });
    }
    // Separate colliding labels (min 16 px centre distance).
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          const a = labels[i]!, b = labels[j]!;
          let vx = b.lx - a.lx, vy = b.ly - a.ly;
          let d = Math.hypot(vx, vy);
          if (d < 16 && d > 1e-3) {
            const push = (16 - d) / 2;
            vx /= d; vy /= d;
            a.lx -= vx * push; a.ly -= vy * push;
            b.lx += vx * push; b.ly += vy * push;
          } else if (d <= 1e-3) {
            a.lx -= 8; b.lx += 8;
          }
        }
      }
    }
    // Clamp into the canvas bounds: the one place that guarantees every label
    // stays visible regardless of circuit shape, cornerR or canvas size.
    const bubbleR = fontPx * 0.78;
    for (let i = 0; i < labels.length; i++) {
      const L = labels[i]!;
      L.lx = Math.min(W - bubbleR, Math.max(bubbleR, L.lx));
      L.ly = Math.min(H - bubbleR, Math.max(bubbleR, L.ly));
    }
    g.font = `700 ${fontPx}px system-ui, sans-serif`;
    g.textAlign = "center"; g.textBaseline = "middle";
    for (let i = 0; i < labels.length; i++) {
      const L = labels[i]!;
      g.strokeStyle = "rgba(255,255,255,0.35)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(L.x + L.dx * (rDot + 1), L.y + L.dy * (rDot + 1));
      g.lineTo(L.lx, L.ly);
      g.stroke();
      g.fillStyle = "rgba(10,10,16,0.92)";
      g.strokeStyle = L.col; g.lineWidth = 2.25;
      g.beginPath(); g.arc(L.x, L.y, rDot, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = "rgba(10,10,16,0.88)";
      g.beginPath(); g.arc(L.lx, L.ly, fontPx * 0.78, 0, Math.PI * 2); g.fill();
      g.strokeStyle = L.col; g.lineWidth = 1.25;
      g.stroke();
      g.fillStyle = L.col;
      g.fillText(String(L.n), L.lx, L.ly + 0.5);
    }
    // Compact class legend (large preview only; CIRCUIT DETAIL passes legend:false
    // and paints the key in the DOM). Silver S2 is the grey sector stroke.
    if (opts.legend !== false && W >= 280 && H >= 200) {
      const legend: [string, string][] = [
        ["HAIRPIN", CLASS_COLORS.HAIRPIN],
        ["SLOW", CLASS_COLORS.SLOW],
        ["MEDIUM", CLASS_COLORS.MEDIUM],
        ["FAST", CLASS_COLORS.FAST],
        ["S2", sectorColors()[1]!]
      ];
      const fontPx = Math.max(12, Math.round(Math.min(W, H) / 36));
      g.font = "600 " + fontPx + "px system-ui, sans-serif";
      g.textAlign = "left"; g.textBaseline = "middle";
      let lx = 8, ly = H - Math.max(12, fontPx);
      for (let i = legend.length - 1; i >= 0; i--) {
        const name = legend[i]![0], col = legend[i]![1];
        const tw = g.measureText(name).width;
        g.fillStyle = col;
        g.beginPath(); g.arc(lx + 4, ly, Math.max(4, fontPx * 0.32), 0, Math.PI * 2); g.fill();
        g.fillStyle = "rgba(220,220,230,0.92)";
        g.fillText(name, lx + 12, ly);
        lx += tw + 24;
      }
    }
    g.textAlign = "left";
  }
  return true;
}

/** The ids the outline cache holds. track-maps.js:672 */
export const cachedIds = (): string[] => Object.keys(cache);
