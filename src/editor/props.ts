/**
 * TrackDesignerProps: capped place/remove scenery props for custom tracks
 * (slice H). Ported verbatim from f1-game js/editor/props.js
 * (TrackDesignerProps IIFE, :1-345).
 *
 * Themes stay primary; this is a small authored list the designer palette
 * writes into design.props and track-themes sceneryFor dresses through the
 * existing scenery api (grandstandEx, gantry, forestEdge, waterSurface,
 * floodMast, billboard, palm, hedge): no second scenery system. Caps keep
 * custom circuits cheap.
 *
 * Port notes:
 * - f1-game's `Log.warn` in dress() (:213) is dropped; the try/catch stays, so a
 *   prop that throws is still skipped silently.
 * - `Object.freeze(TrackDesignerProps)` (:345): an ES module namespace is
 *   already immutable.
 * - `!` non-null assertions and `as` casts are type-only; no runtime change.
 */
import type { RVec3, SceneryApi, SceneryTrack } from "../contracts/scenery";

// Order is the codec kind index: never reorder; append only.
/** props.js:11 */
export const KINDS = Object.freeze(["stand", "gantry", "trees", "water", "flood", "billboard", "palms", "hedge", "pines", "bushes", "marshal", "camera", "pond", "lake", "river", "mountain", "snowpeak", "hill", "dune", "rocks", "lagoon", "canal", "blossom", "wheel", "cottage"] as const);

/** One kind of authored prop. props.js:11 */
export type PropKind = (typeof KINDS)[number];

/** One authored prop, as sanitize() stores it. props.js:113 */
export interface DesignerProp {
  kind: PropKind;
  /** Lap fraction 0..1 (16-bit quantised). */
  s: number;
  side: -1 | 1;
  /** Metres beyond the road edge, 0..GAP_MAX. */
  gap: number;
}

/** Per-kind counts plus the total, from counts(). props.js:90 */
export type PropCounts = { [K in PropKind]: number } & { total: number };

/** The survey fields dress() reads (track-themes survey()). */
export interface PropsSurvey {
  readonly n: number;
  readonly total: number;
}

/** props.js:12 */
export const LABELS: Readonly<Record<PropKind, string>> = Object.freeze({
  stand: "STAND", gantry: "GANTRY", trees: "TREES",
  water: "WATER", flood: "FLOOD", billboard: "BOARD", palms: "PALMS", hedge: "HEDGE",
  pines: "PINES", bushes: "BUSHES", marshal: "MARSHAL", camera: "CAMERA", pond: "POND", lake: "LAKE", river: "RIVER",
  mountain: "MOUNTAIN", snowpeak: "SNOW PEAK", hill: "GRASS HILL", dune: "SAND DUNE", rocks: "ROCK OUTCROP",
  lagoon: "LAGOON", canal: "CANAL", blossom: "BLOSSOM GROVE", wheel: "FERRIS WHEEL", cottage: "COTTAGE",
});
// Per-kind and total caps: custom tracks stay under the fleet prop budget.
/** props.js:20 */
export const CAPS: Readonly<Record<PropKind, number>> = Object.freeze({ stand: 4, gantry: 4, trees: 6, water: 4, flood: 2, billboard: 8, palms: 6, hedge: 6, pines: 6, bushes: 6, marshal: 4, camera: 4, pond: 4, lake: 4, river: 4, mountain: 3, snowpeak: 3, hill: 6, dune: 6, rocks: 6, lagoon: 4, canal: 4, blossom: 6, wheel: 2, cottage: 6 });
/** props.js:21 */
export const TOTAL = 16;
/** props.js:22 */
export const DEFAULT_GAP: Readonly<Record<PropKind, number>> = Object.freeze({
  stand: 18, gantry: 0, trees: 34, water: 40, flood: 28, billboard: 9, palms: 24, hedge: 12, pines: 28, bushes: 16, marshal: 14, camera: 20, pond: 28, lake: 50, river: 24,
  mountain: 60, snowpeak: 70, hill: 30, dune: 28, rocks: 16, lagoon: 40, canal: 22, blossom: 30, wheel: 36, cottage: 22,
});
/** props.js:26 */
export const MIN_GAP: Readonly<Record<PropKind, number>> = Object.freeze({ stand: 14, gantry: 0, trees: 20, water: 24, flood: 18, billboard: 6, palms: 16, hedge: 8, pines: 20, bushes: 10, marshal: 10, camera: 14, pond: 16, lake: 30, river: 14, mountain: 40, snowpeak: 50, hill: 20, dune: 18, rocks: 10, lagoon: 24, canal: 14, blossom: 20, wheel: 28, cottage: 16 });
/** props.js:27 */
export const DESCRIPTIONS: Readonly<Record<PropKind, string>> = Object.freeze({
  stand: "A 70 m grandstand for spectators.", gantry: "An overhead gantry spanning the road.",
  trees: "A short belt of mixed woodland.", water: "A large trackside pond; allow plenty of space.",
  flood: "A 24 m floodlight mast for night circuits.", billboard: "A colourful trackside sponsor board.",
  palms: "Three palms, spaced 12 m apart.", hedge: "A 48 m clipped hedge along the track.",
  pines: "Three tall pines, spaced 14 m apart.", bushes: "Five low shrubs, spaced 6 m apart.",
  marshal: "A marshal shelter with a track-facing signal panel.", camera: "A 12 m broadcast camera tower.",
  pond: "A compact 60 × 80 m pond for infields and gardens.",
  lake: "A broad 320 × 380 m lake; allow a large open area.",
  river: "A narrow 28 × 360 m straight river section; its direction stays fixed on the map.",
  mountain: "A rugged 160 m wide, 110 m high mountain with a rocky summit.",
  snowpeak: "A 200 m wide, 160 m high peak with a snowy crown.",
  hill: "A rounded 100 m wide grass hill, 24 m above its surroundings.",
  dune: "A low 90 m wide golden sand dune, 18 m high.",
  rocks: "A craggy 28 m wide rock outcrop, 14 m high.",
  lagoon: "A turquoise 180 × 140 m lagoon for tropical scenery.",
  canal: "A slim 16 × 240 m canal; its direction stays fixed on the map.",
  blossom: "A short grove of pink flowering trees.",
  wheel: "A 44 m tall Ferris wheel for a trackside festival.",
  cottage: "A small cottage with a terracotta gabled roof.",
});
interface Landscape { w: number; h: number; col: RVec3; rough: number; snowline?: number; rounded?: boolean }
const LANDSCAPES: Readonly<Partial<Record<PropKind, Landscape>>> = Object.freeze({
  mountain: { w: 160, h: 110, col: [0.36, 0.38, 0.40], rough: 0.3 },
  snowpeak: { w: 200, h: 160, col: [0.40, 0.44, 0.48], rough: 0.3, snowline: 0.55 },
  hill: { w: 100, h: 24, col: [0.28, 0.42, 0.20], rough: 0.12, rounded: true },
  dune: { w: 90, h: 18, col: [0.74, 0.60, 0.36], rough: 0.16, rounded: true },
  rocks: { w: 28, h: 14, col: [0.42, 0.42, 0.40], rough: 0.4 },
});
interface WaterSpec { size: RVec3; color: RVec3 }
const WATER: Readonly<Partial<Record<PropKind, WaterSpec>>> = Object.freeze({
  water: { size: [220, 0.25, 280], color: [0.14, 0.36, 0.48] },
  pond: { size: [60, 0.25, 80], color: [0.18, 0.42, 0.38] },
  lake: { size: [320, 0.25, 380], color: [0.10, 0.30, 0.46] },
  river: { size: [28, 0.25, 360], color: [0.16, 0.40, 0.50] },
  lagoon: { size: [180, 0.25, 140], color: [0.12, 0.54, 0.58] },
  canal: { size: [16, 0.25, 240], color: [0.18, 0.36, 0.42] },
});
/** props.js:63 */
export const CATEGORIES: Readonly<{ nature: string[]; terrain: string[]; water: string[]; venue: string[] }> = Object.freeze({
  nature: ["trees", "palms", "hedge", "pines", "bushes", "blossom"],
  terrain: Object.keys(LANDSCAPES), water: Object.keys(WATER),
  venue: ["stand", "gantry", "flood", "billboard", "marshal", "camera", "wheel", "cottage"],
});
const GAP_MAX = 120;
const BOARD_COLS: readonly RVec3[] = Object.freeze([
  [0.86, 0.12, 0.10], [0.10, 0.28, 0.66], [0.96, 0.78, 0.10],
  [0.10, 0.52, 0.30], [0.92, 0.92, 0.92],
] as RVec3[]);

/** A raw (unsanitized) prop row as stored or decoded. */
type RawProp = { readonly kind?: unknown; readonly s?: unknown; readonly side?: unknown; readonly gap?: unknown };

/** props.js:74 */
export const has = (k: unknown): k is PropKind => KINDS.indexOf(k as PropKind) >= 0;
const frac = (v: unknown): number | null => {
  if (!Number.isFinite(v)) return null;
  let f = (v as number) - Math.floor(v as number);
  if (f < 0) f += 1;
  return Math.round(f * 65535) % 65535 / 65535;
};
const sideOf = (v: unknown): -1 | 1 => ((v as number) < 0 ? -1 : 1);
const gapOf = (kind: string, v: unknown): number => {
  const d = (DEFAULT_GAP as { readonly [k: string]: number | undefined })[kind] != null ? (DEFAULT_GAP as { readonly [k: string]: number })[kind]! : 20;
  const n = Number.isFinite(+(v as number)) ? +(v as number) : d;
  return Math.min(GAP_MAX, Math.max(0, Math.round(n)));
};

/** The clearance a prop is dressed at: gantry 0, else ≥ MIN_GAP. props.js:89 */
export const effectiveGap = (kind: unknown, gap: unknown): number | null => has(kind) ? (kind === "gantry" ? 0 : Math.max(MIN_GAP[kind], gapOf(kind, gap))) : null;
/** Count placed props by kind (and total). props.js:90 */
export function counts(list: unknown): PropCounts {
  const out = { total: 0 } as PropCounts;
  for (const k of KINDS) out[k] = 0;
  if (!Array.isArray(list)) return out;
  for (const p of list as readonly (RawProp | null | undefined)[]) {
    if (!p || !has(p.kind)) continue;
    out[p.kind]++; out.total++;
  }
  return out;
}

/** Repair rather than discard; null / empty → null (absent like look defaults). props.js:102 */
export function sanitize(list: unknown): DesignerProp[] | null {
  if (!Array.isArray(list) || !list.length) return null;
  const out: DesignerProp[] = [];
  const n = counts([]);
  for (const raw of list as readonly unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as RawProp;
    const kind = String(r.kind || "");
    if (!has(kind)) continue;
    if (n[kind] >= CAPS[kind] || n.total >= TOTAL) continue;
    const s = frac(r.s);
    if (s == null) continue;
    out.push({ kind, s, side: sideOf(r.side), gap: gapOf(kind, r.gap) });
    n[kind]++; n.total++;
  }
  return out.length ? out : null;
}

/** Can we add one more of this kind under the caps? props.js:120 */
export function canPlace(list: unknown, kind: unknown): boolean {
  if (!has(kind)) return false;
  const c = counts(list);
  return c[kind] < CAPS[kind] && c.total < TOTAL;
}

/** Control-polygon arc fraction at index i (0…1). props.js:127 */
export function pointFrac(pts: ReadonlyArray<readonly number[]> | null | undefined, i: number): number {
  if (!Array.isArray(pts) || !pts.length) return 0;
  const N = pts.length;
  const idx = ((i % N) + N) % N;
  let L = 0, at = 0;
  for (let k = 0; k < N; k++) {
    const a = pts[k]!, b = pts[(k + 1) % N]!;
    const d = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);
    if (k < idx) at += d;
    L += d;
  }
  return L > 0 ? at / L : 0;
}

/** Options for place(). */
export interface PlaceOpts { s?: unknown; side?: unknown; gap?: unknown }
/** Append one prop; returns the new list or null when refused. props.js:142 */
export function place(list: unknown, kind: unknown, opts?: PlaceOpts | null): DesignerProp[] | null {
  opts = opts || {};
  if (!canPlace(list, kind)) return null;
  const s = frac(opts.s != null ? opts.s : 0);
  if (s == null) return null;
  const next: unknown[] = Array.isArray(list) ? (list as unknown[]).slice() : [];
  next.push({ kind, s, side: sideOf(opts.side), gap: gapOf(kind as string, opts.gap) });
  return sanitize(next) || next as DesignerProp[];
}

/** Options for placeBatch(): `side` 0 places both sides. */
export interface PlaceBatchOpts { start?: number; end?: number; count?: number; side?: number; gap?: unknown }
/** An entire placement operation succeeds or refuses; no half-filled rows. props.js:153 */
export function placeBatch(list: unknown, kind: unknown, opts?: PlaceBatchOpts | null): DesignerProp[] | null {
  if (!has(kind) || !opts || !Number.isFinite(opts.start)) return null;
  const count = opts.count == null ? 1 : opts.count;
  if (!Number.isInteger(count) || count < 1 || count > 8) return null;
  const sides = kind === "gantry" ? [1] : opts.side === 0 ? [-1, 1] : [sideOf(opts.side)];
  const c = counts(list), size = count * sides.length;
  if (c.total + size > TOTAL || c[kind] + size > CAPS[kind]) return null;
  let distance = 0;
  if (count > 1) {
    if (!Number.isFinite(opts.end)) return null;
    distance = ((opts.end! - opts.start!) % 1 + 1) % 1;
    if (distance < 1e-6) return null;
  }
  const next: unknown[] = Array.isArray(list) ? (list as unknown[]).slice() : [];
  for (let i = 0; i < count; i++) for (const side of sides) {
    next.push({ kind, s: opts.start! + (count > 1 ? distance * i / (count - 1) : 0), side, gap: Math.max(MIN_GAP[kind], gapOf(kind, opts.gap)) });
  }
  return sanitize(next);
}

/** A patch for updateAt(); absent fields keep the prop's own. */
export interface PropPatch { s?: unknown; side?: unknown; gap?: unknown }
/** Replace prop i with the patch applied; null when invalid or unchanged. props.js:173 */
export function updateAt(list: DesignerProp[] | null | undefined, i: number, patch?: PropPatch | null): DesignerProp[] | null {
  if (!Array.isArray(list) || !Number.isInteger(i) || !list[i] || !patch) return null;
  const old = list[i]!, s = patch.s == null ? old.s : frac(patch.s);
  if (s == null || (patch.gap != null && !Number.isFinite(patch.gap))) return null;
  const prop: DesignerProp = { kind: old.kind, s, side: patch.side == null ? old.side : sideOf(patch.side), gap: Math.max(MIN_GAP[old.kind], gapOf(old.kind, patch.gap == null ? old.gap : patch.gap)) };
  if (old.kind === "gantry") { prop.side = 1; prop.gap = 0; }
  if (JSON.stringify(prop) === JSON.stringify(old)) return null;
  const next = list.slice(); next[i] = prop; return next;
}

/** Remove by index; returns the new list (possibly empty → []). props.js:184 */
export function removeAt(list: DesignerProp[] | null | undefined, i: number): DesignerProp[] {
  if (!Array.isArray(list) || i < 0 || i >= list.length) return list ? list.slice() : [];
  const next = list.slice();
  next.splice(i, 1);
  return next;
}

/** Remove the last prop of `kind`, or the last prop when kind is null. props.js:192 */
export function removeLast(list: DesignerProp[] | null | undefined, kind?: string | null): DesignerProp[] {
  if (!Array.isArray(list) || !list.length) return [];
  let i = list.length - 1;
  if (kind) {
    while (i >= 0 && list[i]!.kind !== kind) i--;
    if (i < 0) return list.slice();
  }
  return removeAt(list, i);
}

/** Dress authored props through the live scenery api (sceneryFor call site);
 *  returns how many were placed. props.js:203 */
export function dress(api: SceneryApi, sv: PropsSurvey, props: unknown): number {
  const list = sanitize(props);
  if (!list || !list.length || !api || !sv) return 0;
  let placed = 0;
  const K = api.K || ((f: number) => Math.round((((f % 1) + 1) % 1) * sv.n) % sv.n);
  for (let i = 0; i < list.length; i++) {
    const p = list[i]!;
    try {
      if (placeOne(api, sv, K, p, i)) placed++;
    } catch {
      // f1-game: Log.warn("track", "custom prop <kind> failed: ...") (dropped).
    }
  }
  return placed;
}

// Native waterSurface emits a WORLD-axis box. Test every road segment against
// its full footprint, expanded conservatively by road half-width + clearance.
// The native centre-radius guard alone misses a long river's distant ends.
/** props.js:222 */
function waterOverlapsRoad(tr: SceneryTrack, k: number, side: number, gap: number, size: RVec3): boolean {
  if (!tr || !tr.n || !tr.px || !tr.pz || !tr.rx || !tr.rz || !tr.hw) return false;
  const offset = side * (tr.hw[k]! + gap + size[0] / 2);
  const cx = tr.px[k]! + tr.rx[k]! * offset, cz = tr.pz[k]! + tr.rz[k]! * offset;
  if (!Number.isFinite(cx) || !Number.isFinite(cz)) return true;
  for (let i = 0; i < tr.n; i++) {
    const j = (i + 1) % tr.n, margin = Math.max(tr.hw[i]!, tr.hw[j]!) + 4;
    const axes: [number, number, number][] = [[tr.px[i]! - cx, tr.px[j]! - tr.px[i]!, size[0] / 2 + margin],
      [tr.pz[i]! - cz, tr.pz[j]! - tr.pz[i]!, size[2] / 2 + margin]];
    let enter = 0, exit = 1;
    for (const [start, delta, half] of axes) {
      if (![start, delta, half].every(Number.isFinite)) return true;
      if (Math.abs(delta) < 1e-9) { if (Math.abs(start) > half) { exit = -1; break; } }
      else {
        const a = (-half - start) / delta, b = (half - start) / delta;
        enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
      }
    }
    if (enter <= exit) return true;
  }
  return false;
}

/** props.js:245 */
function placeOne(api: SceneryApi, sv: PropsSurvey, K: (f: number) => number, p: DesignerProp, i: number): boolean {
  const side = p.side || 1;
  const gap = effectiveGap(p.kind, p.gap)!;
  const k = K(p.s);
  if (p.kind === "stand") {
    if (!api.grandstandEx) return false;
    api.grandstandEx(p.s, side, gap, 70, null, null, { tiers: 1, h: 11 });
    return true;
  }
  if (p.kind === "gantry") {
    if (!api.gantry) return false;
    api.gantry(p.s, 5.5, [0.72, 0.74, 0.78], {});
    return true;
  }
  if (p.kind === "trees" || p.kind === "blossom") {
    if (!api.forestEdge) return false;
    const half = 0.01, blossom = p.kind === "blossom";
    api.forestEdge(p.s - half, p.s + half, side, gap, {
      hMin: 9, hMax: 15, density: 0.35, pineFrac: blossom ? 0 : 0.35,
      col: blossom ? [0.76, 0.42, 0.54] : [0.18, 0.36, 0.16], col2: blossom ? [0.88, 0.62, 0.70] : [0.24, 0.40, 0.18],
    });
    return true;
  }
  if (WATER[p.kind]) {
    if (!api.waterSurface) return false;
    const water = WATER[p.kind]!, clearance = Math.max(MIN_GAP[p.kind], gap), id = "custom-prop-" + p.kind + "-" + i;
    if (waterOverlapsRoad(api.track, k, side, clearance, water.size)) {
      if (api.modelDiagnostics && api.modelDiagnostics.suppressed) api.modelDiagnostics.suppressed.push({ id, reason: "water footprint overlaps road" });
      return false;
    }
    return api.waterSurface(k, side, clearance, water.size, water.color, { id }) !== false;
  }
  if (LANDSCAPES[p.kind]) {
    const o = LANDSCAPES[p.kind]!, reach = o.w * 0.75 + 12;
    if (!api.anchor || !(o.rounded ? api.ridge : api.mountain)) return false;
    // Guard the full skirt against every segment, including another part of
    // the lap. The same guard runs in the map preview and the race build.
    if (waterOverlapsRoad(api.track, k, side, gap, [reach * 2, 0, reach * 2])) return false;
    const a = api.anchor(k, side, gap + reach), base = Number.isFinite(api.pyMin) ? api.pyMin - 1 : a.c[1] - 1;
    const h = o.h + Math.max(0, a.c[1] - base);
    if (o.rounded) api.ridge(a.c[0], a.c[2], base, 0, o.w, o.w, h, o.col, { profile: "massif", rough: o.rough, crest: 0.25 });
    else api.mountain(a.c[0], a.c[2], base, o.w, h, { seg: 12, seed: 31 + i * 17, rough: o.rough, rock: o.col, forest: o.col, snowline: o.snowline || 2, snow: [0.95, 0.97, 1] });
    return true;
  }
  if (p.kind === "wheel") {
    if (!api.ferrisWheel) return false;
    api.ferrisWheel(k, side, gap, 22); return true;
  }
  if (p.kind === "cottage") {
    if (!api.house) return false;
    api.house(k, side, gap, 14, 9, 20, { wall: [0.82, 0.76, 0.62], roof: [0.54, 0.26, 0.18], roofType: "gable" }); return true;
  }
  if (p.kind === "flood") {
    if (!api.floodMast) return false;
    api.floodMast(k, side, gap, { h: 24, cool: true, pool: true });
    return true;
  }
  if (p.kind === "billboard") {
    if (!api.billboard) return false;
    const col = BOARD_COLS[i % BOARD_COLS.length]!;
    api.billboard(k, side, gap, 10, 4.2, col);
    return true;
  }
  if (p.kind === "palms") {
    if (!api.palm) return false;
    const step = 12 / Math.max(1, sv.total || 5000);
    for (const offset of [-1, 0, 1]) api.palm(K(p.s + offset * step), side, gap, 11, [0.18, 0.42, 0.20]);
    return true;
  }
  if (p.kind === "hedge") {
    if (!api.hedge) return false;
    const half = 24 / Math.max(1, sv.total || 5000);
    api.hedge(p.s - half, p.s + half, side, gap, 1.8, [0.22, 0.38, 0.18]);
    return true;
  }
  if (p.kind === "pines" || p.kind === "bushes") {
    const pines = p.kind === "pines", emit = pines ? api.pine : api.bush;
    if (!emit) return false;
    const step = (pines ? 14 : 6) / Math.max(1, sv.total || 5000), radius = pines ? 1 : 2;
    for (let j = -radius; j <= radius; j++) {
      const at = K(p.s + j * step), dist = gap;
      // pine and bush differ in arity; each call is typed to its own emitter.
      if (pines) (emit as SceneryApi["pine"])(at, side, dist, 14, [0.16, 0.30, 0.20]);
      else (emit as SceneryApi["bush"])(at, side, dist, [0.28, 0.42, 0.20]);
    }
    return true;
  }
  if (p.kind === "marshal" || p.kind === "camera") {
    const emit = p.kind === "marshal" ? api.marshalPost : api.cameraTower;
    if (!emit) return false;
    emit(k, side, gap, p.kind === "marshal" ? { style: "hut" } : { h: 12, style: "scaffold" });
    return true;
  }
  return false;
}
