/**
 * DesignerSceneryPreview: the designer's live overhead illustration. Ported verbatim
 * from f1-game js/editor/scenery-preview.js (DesignerSceneryPreview IIFE, :1-147).
 *
 * Replays the theme's own scenery recipe (TrackThemes.sceneryFor) into bounded 2D
 * footprints, without allocating a race, GPU resources or a second 3D renderer. The
 * engine centreline and authored lap fractions remain authoritative; small furniture
 * and terrain relief are simplified at this scale. plan() is pure; draw() paints a
 * plan onto a 2D canvas context (DOM types only, so the module imports in Node).
 *
 * Differs from f1-game:
 * - TrackThemes, Hash32, TrackPit and Tracks are imports; plan's
 *   `typeof TrackPit !== "undefined"` guard (scenery-preview.js:99) takes the loaded
 *   branch and is gone.
 * - The preview `api` implements only the SceneryApi members the theme recipes reach
 *   (as f1-game's does); it is handed to sceneryFor through an
 *   `as unknown as SceneryApi` cast (scenery-preview.js:86). Type-only.
 * - `!` non-null assertions and `as` casts are type-only; no runtime change.
 */
import type { SceneryApi } from "../contracts/scenery";
import * as Hash32 from "./hash32";
import * as TrackThemes from "./track-themes";
import type { ThemeDefFields, ThemeDesign } from "./track-themes";
import * as TrackPit from "../track/core/pit";
import type { PitDefLike } from "../track/core/pit";
import * as Tracks from "../track/core/tracks";
import type { Track } from "../track/core/types";

/** Footprint budget (items + ground). scenery-preview.js:7 */
export const LIMIT = 1800;
const TAU = Math.PI * 2;
const wrap = (f: number) => ((f % 1) + 1) % 1;
const color = (c: readonly number[], gain = 1) => "rgb(" + c.map((v) => Math.round(Math.max(0, Math.min(1, v * gain)) * 255)).join(",") + ")";

/** An RGB colour 0..1. */
type Col = readonly number[];
/** One 2D footprint: centre, heading of its width axis, width × depth (m), colour. */
export interface PreviewItem {
  kind: string; x: number; z: number; angle: number; w: number; d: number; col: Col;
  crowd?: string; snow?: boolean;
}
/** plan()'s scene. */
export interface PreviewScene {
  items: PreviewItem[]; ground: PreviewItem[]; def: PreviewDef; theme: string | undefined;
  night: boolean; dusk: boolean; bounds: { cx: number; cz: number; radius: number }; seed: number;
}
/** The preview's def: the theme's def fields under a fixed id. */
export type PreviewDef = ThemeDefFields & { id: string };
/** The design fields plan() reads. */
export type PreviewDesign = ThemeDesign;
/** draw()'s view: map scale (px/m), the world point at the canvas centre, canvas size (px). */
export interface PreviewView { scale: number; cx: number; cz: number; w: number; h: number }

interface Anchor { c: readonly number[]; r: readonly number[]; u?: readonly number[]; t?: readonly number[] }
type Extra = { angle?: number; crowd?: string; snow?: boolean };

/** The scene for a design over its built centreline, or null. scenery-preview.js:11 */
export function plan(design: PreviewDesign | null | undefined, tr: Track | null | undefined): PreviewScene | null {
  if (!design || !tr || !tr.n) return null;
  const def: PreviewDef = Object.assign({ id: "designer-preview" }, TrackThemes.defFields(design.theme, design));
  const look = TrackThemes.lookOf(design), n = tr.n, items: PreviewItem[] = [], ground: PreviewItem[] = [];
  const hash = (i: number) => Hash32.unit(design.seed || 1, design.theme, "preview", i);
  const K = (s: number) => Math.round(wrap(s) * n) % n;
  const anchor = (raw: number, side: number, gap: number) => {
    const k = (Math.round(raw) % n + n) % n, d = side * (tr.hw[k]! + gap);
    return { c: [tr.px[k]! + tr.rx[k]! * d, tr.py[k]!, tr.pz[k]! + tr.rz[k]! * d], r: [tr.rx[k]!, 0, tr.rz[k]!], u: [0, 1, 0], t: [tr.tx[k]!, 0, tr.tz[k]!] };
  };
  const bounds = { cx: 0, cz: 0, radius: 0 };
  for (let i = 0; i < n; i++) { bounds.cx += tr.px[i]! / n; bounds.cz += tr.pz[i]! / n; }
  for (let i = 0; i < n; i++) bounds.radius = Math.max(bounds.radius, Math.hypot(tr.px[i]! - bounds.cx, tr.pz[i]! - bounds.cz));
  // A sampled road clearance check keeps illustrative footprints out of bends.
  const onTrack = (x: number, z: number, r = 0) => {
    for (let i = 0; i < n; i += 3) if (Math.hypot(x - tr.px[i]!, z - tr.pz[i]!) < tr.hw[i]! + r + 6) return true;
    return false;
  };
  const add = (kind: string, a: Anchor, w: number, d: number, col: Col, layer = items, extra: Extra = {}) => {
    if (items.length + ground.length >= LIMIT) return false;
    layer.push(Object.assign({ kind, x: a.c[0]!, z: a.c[2]!, angle: Math.atan2(a.r[2]!, a.r[0]!), w, d, col }, extra));
    return true;
  };
  const box = (kind: string, k: number, side: number, gap: number, w: number, d: number, col: Col, extra?: Extra) => {
    const a = anchor(k, side, gap + w / 2);
    if (onTrack(a.c[0]!, a.c[2]!, Math.min(w, d) * 0.45)) return false;
    return add(kind, a, w, d, col, items, extra);
  };
  const tree = (kind: string, k: number, side: number, gap: number, h: number, col?: Col) => {
    const a = anchor(k, side, gap), r = kind === "bush" ? 3 : Math.max(4, h * 0.45);
    if (onTrack(a.c[0]!, a.c[2]!, r)) return false;
    return add(kind, a, r * 2, r * 2, col || def.furniture.fol || [0.2, 0.38, 0.18]);
  };
  const along = (s0: number, s1: number, step: number, fn: (k: number, i: number) => void) => {
    const count = Math.min(300, Math.max(1, Math.ceil(wrap(s1 - s0) * tr.total / step)));
    for (let i = 0; i < count; i++) fn(K(s0 + wrap(s1 - s0) * i / count), i);
  };
  type ForestOpts = { density?: number; hMin?: number; hMax?: number; pineFrac?: number; col?: Col; col2?: Col };
  const api = {
    track: tr, def, n, px: tr.px, pz: tr.pz, curv: tr.curv, pyMin: Math.min(...tr.py),
    K, anchor, onTrack, lapBounds: () => bounds, out: {}, MAT: {},
    forestEdge(s0: number, s1: number, side: number, gap: number, o: ForestOpts = {}): void {
      along(s0, s1, Math.max(10, 5 / (o.density || 0.35)), (k, i) => {
        const h = (o.hMin || 9) + hash(k + i) * ((o.hMax || 17) - (o.hMin || 9));
        tree(hash(k) < (o.pineFrac || 0) ? "pine" : "tree", k, side, gap + hash(k + 1) * 20, h, i % 2 ? o.col : o.col2);
      });
    },
    pine: (k: number, s: number, g: number, h: number, c?: Col) => tree("pine", k, s, g, h, c),
    palm: (k: number, s: number, g: number, h: number, c?: Col) => tree("palm", k, s, g, h, c),
    bush: (k: number, s: number, g: number, c?: Col) => tree("bush", k, s, g, 4, c),
    hedge: (a: number, b: number, s: number, g: number, h: number, c?: Col) => along(a, b, 5, (k) => tree("bush", k, s, g, h, c)),
    grandstandEx: (f: number, s: number, g: number, len: number, shell?: Col | null, crowd?: unknown, o: { tiers?: number } = {}) => box("stand", K(f), s, g, 12 + (o.tiers || 1) * 5, len, shell || [0.63, 0.67, 0.70], { crowd: look.crowd }),
    spectatorHill: (a: number, b: number, s: number, g: number, o: { grass?: Col } = {}) => along(a, b, 18, (k) => box("crowd", k, s, g, 12, 12, o.grass || [0.35, 0.45, 0.24])),
    waterSurface(k: number, s: number, g: number, size: readonly number[], c: Col): boolean {
      const a = anchor(k, s, g + size[0]! / 2);
      if (onTrack(a.c[0]!, a.c[2]!, size[0]! / 2 + 4)) return false;
      return add("water", a, size[0]!, size[2]!, c, ground, { angle: 0 });
    },
    ridge: (x: number, z: number, y: number, a: number, len: number, w: number, h: number, c: Col) => add("hill", { c: [x, y, z], r: [Math.cos(a), 0, Math.sin(a)] }, len, w * 2, c, ground),
    mountain: (x: number, z: number, y: number, w: number, h: number, o: { rock?: Col; snowline?: number } = {}) => add("hill", { c: [x, y, z], r: [1, 0, 0] }, w, w * 0.7, o.rock || [0.4, 0.42, 0.4], ground, { snow: (o.snowline as number) < 1 }),
    house: (k: number, s: number, g: number, w: number, h: number, d: number, o: { roof?: Col; wall?: Col } = {}) => box("building", k, s, g, w, d, o.roof || o.wall || [0.60, 0.42, 0.32]),
    building: (k: number, s: number, g: number, w: number, h: number, d: number) => box("building", k, s, g, w, d, [0.58, 0.62, 0.66]),
    motorhome: (k: number, s: number, g: number, w: number, h: number, d: number, o: { wall?: Col } = {}) => box("building", k, s, g, w, d, o.wall || [0.8, 0.82, 0.84]),
    cameraTower: (k: number, s: number, g: number) => box("camera", k, s, g, 7, 7, [0.63, 0.68, 0.70]),
    marshalPost: (k: number, s: number, g: number) => box("marshal", k, s, g, 6, 8, [0.95, 0.46, 0.14]),
    billboard: (k: number, s: number, g: number, w: number, h: number, c: Col) => box("board", k, s, g, 3, w, c),
    sponsorHoarding: (a: number, b: number, s: number, g: number) => along(a, b, 14, (k) => box("board", k, s, g, 2, 12, [0.78, 0.16, 0.14])),
    broadcastCompound: (k: number, s: number, g: number) => box("building", k, s, g, 30, 24, [0.68, 0.71, 0.72]),
    ferrisWheel: (k: number, s: number, g: number, r: number) => box("wheel", k, s, g, r * 2, r * 2, [0.86, 0.87, 0.82]),
    floodMast: (k: number, s: number, g: number) => add("light", anchor(k, s, g), 5, 5, [1, 0.87, 0.54]),
    floodMastRing: (step: number, o: { dist?: number } = {}): void => { for (let i = 0; i < tr.total; i += step) for (const s of [-1, 1]) api.floodMast(K(i / tr.total), s, o.dist || 28); },
    gantry: (f: number) => add("gantry", anchor(K(f), 0, 0), tr.hw[K(f)]! * 2 + 8, 4, [0.85, 0.86, 0.82]),
    addBox: (out: unknown, c: readonly number[], size: readonly number[], col: Col, basis?: readonly (readonly number[])[] | null) => add("building", { c, r: basis ? basis[0]! : [1, 0, 0] }, size[0]!, size[2]!, col),
    addPrism: (out: unknown, c: readonly number[], size: readonly number[], col: Col, basis?: readonly (readonly number[])[] | null) => add("building", { c, r: basis ? basis[0]! : [1, 0, 0] }, size[0]!, size[2]!, col),
    addFrustum: (out: unknown, c: readonly number[], r0: number, r1: number, h: number, col: Col) => add("hill", { c, r: [1, 0, 0] }, r0 * 2, r0 * 2, col, ground),
  };
  TrackThemes.sceneryFor(design)(api as unknown as SceneryApi);
  // The generic roadside pass: retain the theme's foliage/city family and density.
  // Individual 3D tree meshes and furniture remain illustrative.
  const step = look.trees === "few" ? 64 : look.trees === "many" ? 18 : def.furniture.sparse ? 52 : 32;
  for (let m = 100; m < tr.total; m += step) for (const s of [-1, 1]) {
    const k = K(m / tr.total);
    if (def.street || def.theme === "modern") {
      if (m % (step * 3) < step) box("building", k, s, 38 + hash(k) * 30, 24 + hash(k + 1) * 18, 24, [0.46, 0.49, 0.51]);
    } else if (def.furniture.tree !== "none") {
      const rows = def.furniture.sparse ? 1 : look.trees === "many" ? 5 : 3;
      for (let row = 0; row < rows; row++) tree(def.furniture.tree === "fir" ? "pine" : def.furniture.tree === "palm" ? "palm" : "tree", k, s, 24 + row * 18 + hash(k + s + row) * 16, 14 + hash(k + row) * 10);
    }
  }
  const pit = TrackPit.build(tr, def as PitDefLike, Tracks.curvature);
  if (pit && pit.hasBays) for (let i = 0; i < 10; i++) box("garage", K(0.985 + i * 12 / tr.total), TrackPit.resolve(def as PitDefLike).side, 26, 18, 10, [0.62, 0.65, 0.67]);
  return { items, ground, def, theme: design.theme, night: def.night, dusk: look.time === "dusk", bounds, seed: design.seed || 1 };
}

/** Paint one layer ("ground": backdrop, flecks and ground footprints; anything else:
 *  the item footprints) of a scene onto a 2D context. scenery-preview.js:104 */
export function draw(g: CanvasRenderingContext2D, scene: PreviewScene | null | undefined, view: PreviewView, layer?: string): void {
  if (!scene) return;
  const { scale: s, cx, cz, w, h } = view, gain = scene.night ? 0.5 : 1;
  const x = (v: number) => (v - cx) * s + w / 2, z = (v: number) => (v - cz) * s + h / 2;
  if (layer === "ground") {
    g.fillStyle = color((scene.def.pal.grass || [0.24, 0.38, 0.20]).map(v => v * 0.58 + (scene.night ? 0 : 0.045))); g.fillRect(0, 0, w, h);
    // Stable terrain flecks move with the map; no animation or idle RAF loop.
    const b = scene.bounds, reach = b.radius * 1.5;
    for (let i = 0; i < 180; i++) {
      const a = Hash32.unit(scene.seed, "ground-x", i), c = Hash32.unit(scene.seed, "ground-z", i);
      g.fillStyle = i % 2 ? "rgba(0,0,0,0.035)" : "rgba(255,255,220,0.025)";
      g.beginPath(); g.ellipse(x(b.cx + (a - 0.5) * reach * 2), z(b.cz + (c - 0.5) * reach * 2), (30 + a * 100) * s, (20 + c * 70) * s, a * TAU, 0, TAU); g.fill();
    }
    if (scene.dusk) { g.fillStyle = "rgba(233,143,67,0.16)"; g.fillRect(0, 0, w, h); }
  }
  for (const p of layer === "ground" ? scene.ground : scene.items) {
    const px = x(p.x), pz = z(p.z), pw = p.w * s, pd = p.d * s, r = Math.max(pw, pd);
    if (px + r < 0 || pz + r < 0 || px - r > w || pz - r > h) continue;
    g.save(); g.translate(px, pz); g.rotate(p.angle); g.fillStyle = color(p.col, gain);
    const oval = (ww: number, dd: number) => { g.beginPath(); g.ellipse(0, 0, Math.max(0.5, ww / 2), Math.max(0.5, dd / 2), 0, 0, TAU); g.fill(); };
    if (p.kind === "water" || p.kind === "hill") {
      oval(pw, pd); g.fillStyle = p.kind === "water" ? "rgba(255,255,255,0.08)" : p.snow ? "rgba(235,241,245,0.8)" : "rgba(255,255,230,0.1)"; oval(pw * 0.8, pd * 0.65);
    } else if (["tree", "pine", "palm", "bush"].includes(p.kind)) {
      g.fillStyle = "rgba(0,0,0,0.25)"; g.translate(pw * 0.3, pd * 0.25); oval(pw * 1.2, pd); g.translate(-pw * 0.3, -pd * 0.25);
      g.fillStyle = color(p.col, gain * 0.7); oval(pw, pd);
      g.fillStyle = color(p.col, gain * 1.15); g.translate(-pw * 0.12, -pd * 0.12); oval(pw * 0.72, pd * 0.72);
      if (p.kind === "pine" || p.kind === "palm") { g.strokeStyle = color(p.col, gain * 1.5); g.lineWidth = 0.8; for (let j = 0; j < 5; j++) { g.rotate(TAU / 5); g.beginPath(); g.moveTo(0, 0); g.lineTo(pw * 0.45, 0); g.stroke(); } }
    } else if (p.kind === "light") {
      if (scene.night) { g.fillStyle = "rgba(255,221,135,0.10)"; oval(70 * s, 70 * s); }
      g.fillStyle = scene.night ? "#ffeab0" : "#bac0c5"; g.fillRect(-1.5, -1.5, 3, 3);
    } else {
      g.fillStyle = "rgba(0,0,0,0.3)"; g.fillRect(-pw / 2 + 2, -pd / 2 + 2, pw, pd);
      g.fillStyle = color(p.col, gain); g.fillRect(-pw / 2, -pd / 2, Math.max(2, pw), Math.max(2, pd));
      g.strokeStyle = "rgba(255,255,255,0.3)"; g.lineWidth = 0.7; g.strokeRect(-pw / 2, -pd / 2, Math.max(2, pw), Math.max(2, pd));
      if (p.kind === "stand" || p.kind === "garage" || p.kind === "building") {
        g.strokeStyle = "rgba(0,0,0,0.35)"; for (let yy = -pd / 2 + 3; yy < pd / 2; yy += 4) { g.beginPath(); g.moveTo(-pw / 2, yy); g.lineTo(pw / 2, yy); g.stroke(); }
      }
    }
    g.restore();
  }
}
