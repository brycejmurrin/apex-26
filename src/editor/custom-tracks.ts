/**
 * CustomTracks: the registry of the player's OWN circuits. Ported verbatim from
 * f1-game js/editor/custom-tracks.js (CustomTracks, :1-621).
 *
 * A design saved by the track designer is a small record under `customTracks`
 * (stored as `a26.customTracks` by ./store localStore): a closed control-point
 * loop on a 0.25 m lattice plus a theme id and a few zone lists. sync() turns
 * every stored record into a LIST entry through the same factory the shipped
 * circuits use (fromRaw), with `custom: true`.
 *
 * Differences from f1-game:
 * - The pure half (LIMITS, KERB_STYLES, sanitize*, canonical, idOf, toRaw,
 *   arcToIndexFrac, isCustom) is top-level named exports; the store-backed half
 *   is `createCustomTracks(store, deps)`, which replaces the module-level
 *   `GameStore.store` and returns the API under f1-game's member names.
 * - The game wiring (Tracks.LIST mutation, UiLayers, Ghost / InputGhost,
 *   ApexRoster, TrackDesigner, TrackCodec, GameAudio, location / history /
 *   document / window) arrives through the optional `deps` hooks
 *   (`CustomTracksDeps`). Each hook reproduces the f1-game global it replaces;
 *   an absent hook behaves like f1-game's `typeof X === "undefined"` branch.
 * - `Log.*` calls are dropped (the try/catch around each stays).
 * - The `typeof TrackDesignerProps` guard (custom-tracks.js:224) is gone: ./props
 *   is a static import.
 * - `customDef(design)` is added: f1-game tools/track/verify-track.cjs:257.
 */
import type * as Codec from "./codec";
import { fnv1a } from "./hash32";
import * as TrackDesignerProps from "./props";
import type { EditorStore, WriteResult } from "./store";
import * as TrackThemes from "./track-themes";
import { fromRaw } from "../track/core/def";
import type { BuiltDef, RawDef } from "../track/core/def";
import { LIST } from "../track/core/tracks";

/** custom-tracks.js:19 */
export const KEY = "customTracks", DRAFT_KEY = "customTrackDraft", DRAFT_PREV_KEY = "customTrackDraftPrev";
const V = 1;

/**
 * A STORED DESIGN IS PLAYER INPUT (and, via a share code, someone else's): every
 * field is rebuilt to these limits on load. spacing / loopMin: the engine must
 * be able to build the loop; loopMax: the control polygon under 2x validate.js's
 * 7 km lap cap (loopMaxLoose for a red work-in-progress draft). custom-tracks.js:22
 */
export const LIMITS = Object.freeze({
  items: 24, name: 24, country: 32, ptsMin: 8, ptsMax: 200, coord: 10000,
  hwMin: 5, hwMax: 8, zones: 24, halfM: 2000, rise: 60, angleDeg: 30,
  spacing: 8, loopMin: 1000,
  loopMax: 14000, loopMaxLoose: 20000,
});
/** Road-edge styles the designer authors (mesh.js buildKerbs). custom-tracks.js:41 */
export const KERB_STYLES = Object.freeze(["flat", "sausage", "rumble"] as const);
export type KerbStyle = (typeof KERB_STYLES)[number];

export type Look = NonNullable<ReturnType<typeof TrackThemes.sanitizeLook>>;
export type Prop = NonNullable<ReturnType<typeof TrackDesignerProps.sanitize>>[number];
export interface HwZoneRec { s0: number; s1: number; hw: number; ease: number }
export interface BankZoneRec { frac: number; angleDeg: number; widthM: number }
export interface BumpRec { s: number; halfM: number; rise: number }

/** A sanitised design record (sanitize's output, what storage holds). */
export interface CustomDesign {
  name: string;
  seed: number;
  theme: string;
  baseHW: number;
  pts: [number, number][];
  heights: number[];
  hwZones: HwZoneRec[] | null;
  bankZones: BankZoneRec[] | null;
  elevations: BumpRec[] | null;
  bridges: BumpRec[] | null;
  turns: number[];
  lengthM: number;
  created: number;
  updated: number;
  look?: Look;
  country?: string;
  kerbStyle?: Exclude<KerbStyle, "flat">;
  berms?: false;
  props?: Prop[];
  id: string;
}

/** An unsanitised design: anything off disk, a file or a share code. */
type RawDesign = { readonly [k: string]: unknown };

// ONE LATTICE for storage and the share code (./codec): points on 0.25 m, lap
// fractions on 1/65535, widths and ease on 0.1 / 0.001, angles and rises on
// 0.25, lengths on 1 m, so a design's content id is the same on both ends.
const q = (v: number) => Math.round(v * 4) / 4;
function num(v: unknown, lo: number, hi: number, dflt: number): number;
function num(v: unknown, lo: number, hi: number, dflt: null): number | null;
function num(v: unknown, lo: number, hi: number, dflt: number | null): number | null {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v as number)) : dflt;
}
// A fraction that rounds up to 1.0 wraps to 0 (the loop is closed), so a stored
// design's id is the same after upsert() and after the next load().
const frac = (v: unknown): number | null => (Number.isFinite(v) ? (Math.round(((v as number) - Math.floor(v as number)) * 65535) % 65535) / 65535 : null);
const dm = (v: number) => Math.round(v * 10) / 10, mil = (v: number) => Math.round(v * 1000) / 1000;

/** custom-tracks.js:53 */
export function sanitizeName(s: unknown): string {
  let t = String(s == null ? "" : s);
  try { t = t.normalize("NFC"); } catch (_) { /* no ICU */ }
  t = t.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, LIMITS.name);
  return t || "MY CIRCUIT";
}

/** The circuit's country: a LABEL kept out of the content id. "" when unset. custom-tracks.js:64 */
export function sanitizeCountry(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.normalize("NFC").replace(/[^\p{L}\p{N} .'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, LIMITS.country);
}
function sanitizePts(pts: unknown): [number, number][] | null {
  if (!Array.isArray(pts) || pts.length < LIMITS.ptsMin || pts.length > LIMITS.ptsMax) return null;
  const out: [number, number][] = [];
  for (const p of pts as unknown[]) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const x = +(p[0] as number), z = +(p[1] as number);
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > LIMITS.coord || Math.abs(z) > LIMITS.coord) return null;
    out.push([q(x), q(z)]);
  }
  return out;
}
/**
 * Parallel node heights (metres). Missing / short → zeros (old saves load flat).
 * Same ±rise lattice as a cosine bump's rise. Always length === pts.length. custom-tracks.js:81
 */
export function sanitizeHeights(pts: readonly unknown[], heights: unknown): number[] {
  const n = pts.length, out = new Array<number>(n);
  const src = Array.isArray(heights) ? (heights as unknown[]) : null;
  for (let i = 0; i < n; i++) {
    const h = src && i < src.length && Number.isFinite(+(src[i] as number)) ? +(src[i] as number) : 0;
    out[i] = q(Math.min(LIMITS.rise, Math.max(-LIMITS.rise, h))) || 0;
  }
  return out;
}
const heightsFlat = (h: readonly number[]) => { for (let i = 0; i < h.length; i++) if (h[i]) return false; return true; };

function sanitizeZones<T>(list: unknown, shape: (z: RawDesign) => T | null): T[] | null {
  if (!Array.isArray(list)) return null;
  const out: T[] = [];
  for (const z of (list as unknown[]).slice(0, LIMITS.zones)) {
    if (!z || typeof z !== "object") continue;
    const row = shape(z as RawDesign);
    if (row) out.push(row);
  }
  return out.length ? out : null;
}
// A cosine bump's steepest grade is π·rise / (2·halfM): hold it under 8 %
// (halfM ≥ 19.6·|rise|) by shrinking the rise. Cap on the STORED length.
const BUMP = (z: RawDesign): BumpRec | null => {
  const s = frac(z.s), halfM = num(z.halfM, 20, LIMITS.halfM, null);
  let rise = num(z.rise, -LIMITS.rise, LIMITS.rise, null);
  if (s == null || halfM == null || rise == null) return null;
  const length = Math.round(halfM), cap = length / 19.6;
  if (Math.abs(rise) > cap) rise = Math.sign(rise) * cap;
  return { s, halfM: length, rise: q(rise) };
};
// A narrowing never goes under the width floor, and `ease` is ALWAYS stored
// (the engine's 0.025 default when absent), floored above 0.
const HWZ = (z: RawDesign): HwZoneRec | null => {
  const s0 = frac(z.s0), s1 = frac(z.s1), hw = num(z.hw, LIMITS.hwMin, LIMITS.hwMax, null);
  if (s0 == null || s1 == null || hw == null) return null;
  return { s0, s1, hw: dm(hw), ease: mil(num(z.ease, 0.005, 0.2, 0.025)) };
};
// mesh.js reads `(angleDeg || 18)` and takes the camber SIDE from curvature, so [1, 30] only.
const BANK = (z: RawDesign): BankZoneRec | null => {
  const f = frac(z.frac), angleDeg = num(z.angleDeg, 1, LIMITS.angleDeg, null), widthM = num(z.widthM, 20, 600, null);
  return f == null || angleDeg == null || widthM == null ? null : { frac: f, angleDeg: q(angleDeg), widthM: Math.round(widthM) };
};

/** custom-tracks.js:134 */
export function sanitizeKerbStyle(v: unknown): KerbStyle {
  return (KERB_STYLES as readonly unknown[]).includes(v) ? (v as KerbStyle) : "flat";
}
/** Default ON: berms dress banked corners (surface.js). Explicit false opts out. custom-tracks.js:137 */
export function sanitizeBerms(v: unknown): boolean {
  return v === false ? false : true;
}

/** What canonical / idOf read: a sanitised record, with or without its id. */
export type CanonInput = Omit<CustomDesign, "id" | "kerbStyle" | "berms"> & { kerbStyle?: string; berms?: boolean };

/**
 * The content id's canon: everything that shapes the built circuit, nothing that
 * only labels it. The theme is in it on purpose (a theme change must rebuild).
 * custom-tracks.js:142
 */
export function canonical(it: CanonInput): string {
  const parts = [it.theme, it.baseHW, it.seed, it.pts.map((p) => p[0] + "," + p[1]).join(";"),
    JSON.stringify([it.hwZones, it.bankZones, it.elevations, it.bridges])];
  // Per-node heights rebuild the centreline; omitted when flat so older flat ids hold.
  if (it.heights && !heightsFlat(it.heights)) parts.push("h:" + it.heights.join(","));
  // The scenery options rebuild the circuit too; absent at their defaults.
  if (it.look) parts.push("look:" + it.look.time + "," + it.look.trees + "," + it.look.crowd);
  // Kerb / berm surface opts rebuild the mesh; omitted at defaults.
  const kerb = sanitizeKerbStyle(it.kerbStyle);
  if (kerb !== "flat") parts.push("kerb:" + kerb);
  if (it.berms === false) parts.push("berms:0");
  // Authored props rebuild scenery; absent when empty.
  if (it.props && it.props.length) {
    parts.push("props:" + it.props.map((p) => p.kind + "@" + p.s + ":" + p.side + ":" + p.gap).join(","));
  }
  return parts.join("|");
}
/** custom-tracks.js:159 */
export function idOf(it: CanonInput): string { return "custom-" + ("00000000" + fnv1a(canonical(it)).toString(16)).slice(-8); }

/** Control-polygon perimeter (m, the closing chord included). O(points). */
function polyLength(pts: readonly (readonly [number, number])[]): number {
  let C = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i]!, b = pts[(i + 1) % pts.length]!; C += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  return C;
}
const lengthOf = (claimed: unknown, perimeter: number) => (Number.isFinite(claimed) && (claimed as number) >= 0.75 * perimeter && (claimed as number) <= 1.25 * perimeter ? Math.round(claimed as number) : Math.round(perimeter));
/** Control-polygon perimeter, or -1 when two consecutive points sit closer than LIMITS.spacing. */
function loopLength(pts: readonly (readonly [number, number])[]): number {
  let L = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!, d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d < LIMITS.spacing) return -1;
    L += d;
  }
  return L;
}

/**
 * Repair rather than discard where the geometry is sound; null when it is not.
 * opts.loose: a WORK IN PROGRESS (the autosaved draft, the validator's preview)
 * may have two points too close or a loop too small. Never for storage or a
 * share code. custom-tracks.js:186
 */
export function sanitize(raw: unknown, opts?: { loose?: boolean } | null): CustomDesign | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawDesign;
  const pts = sanitizePts(r.pts);
  if (!pts) return null;
  const loose = !!(opts && opts.loose);
  const L = loopLength(pts), perimeter = polyLength(pts);
  if (!loose && L < LIMITS.loopMin) return null;
  // Before anything walks this design: a loop thousands of km long is refused here.
  if (perimeter > (loose ? LIMITS.loopMaxLoose : LIMITS.loopMax)) return null;
  const heights = sanitizeHeights(pts, r.heights);
  const it: Omit<CustomDesign, "id"> & { id?: string } = {
    name: sanitizeName(r.name),
    seed: Number.isFinite(r.seed) ? (Math.floor(r.seed as number) >>> 0) : 1,
    theme: TrackThemes.has(r.theme as string) ? (r.theme as string) : TrackThemes.ORDER[0]!,
    baseHW: Math.round(num(r.baseHW, LIMITS.hwMin, LIMITS.hwMax, 7) * 10) / 10,
    pts,
    heights,
    hwZones: sanitizeZones(r.hwZones, HWZ),
    bankZones: sanitizeZones(r.bankZones, BANK),
    elevations: sanitizeZones(r.elevations, BUMP),
    bridges: sanitizeZones(r.bridges, BUMP),
    turns: Array.isArray(r.turns) ? (r.turns as unknown[]).map(frac).filter((v): v is number => v != null).slice(0, 40) : [],
    // lengthM is the designer's BUILT lap: kept while plausible, else the polygon's perimeter.
    lengthM: lengthOf(r.lengthM, perimeter),
    created: num(r.created, 0, 8.64e15, Date.now()),
    updated: num(r.updated, 0, 8.64e15, Date.now()),
  };
  const look = TrackThemes.sanitizeLook(r.look);
  if (look) it.look = look;
  const country = sanitizeCountry(r.country);
  if (country) it.country = country;
  const kerb = sanitizeKerbStyle(r.kerbStyle);
  if (kerb !== "flat") it.kerbStyle = kerb;
  if (sanitizeBerms(r.berms) === false) it.berms = false;
  // Authored scenery props: absent when empty / all invalid.
  {
    const props = TrackDesignerProps.sanitize(r.props);
    if (props) it.props = props;
  }
  it.id = idOf(it);
  return it as CustomDesign;
}

/**
 * A lap fraction along the CONTROL POLYGON's arc → the control INDEX fraction
 * ((i + t) / N) at the same place. applyHwZones keys its windows on i / N.
 * custom-tracks.js:267
 */
export function arcToIndexFrac(pts: readonly (readonly [number, number])[], f: number): number {
  const N = pts.length, cum = [0];
  for (let i = 0; i < N; i++) { const a = pts[i]!, b = pts[(i + 1) % N]!; cum.push(cum[i]! + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const L = cum[N]!;
  if (!(L > 0)) return f;
  const x = Math.min(1, Math.max(0, f)) * L;
  let i = 0;
  while (i < N - 1 && cum[i + 1]! < x) i++;
  const seg = cum[i + 1]! - cum[i]!;
  return (i + (seg > 0 ? (x - cum[i]!) / seg : 0)) / N;
}

type ThemeFields = ReturnType<typeof TrackThemes.defFields>;
/**
 * toRaw's output. It is not a full CircuitDef: `sectors` is null, `turns` may
 * be null and `kit` is absent; def.ts fromRaw reads each through `|| null`.
 */
export type CustomRawDef = {
  id: string; custom: true; name: string; gp: string; country: string;
  lengthKm: number; classic: false;
  sceneryCoordinates: "racing"; startFrac: 0; undulate: true;
  baseHW: number;
  path: { len: number; pts: ([number, number] | [number, number, number])[] };
  turns: number[] | null; sectors: null;
  bankZones: BankZoneRec[] | null; elevations: BumpRec[] | null; bridges: BumpRec[] | null;
  hwZones?: HwZoneRec[];
  kerbStyle?: Exclude<KerbStyle, "flat">;
  berms?: boolean;
  scenery?: ReturnType<typeof TrackThemes.sceneryFor>;
} & ThemeFields;

/** Design record → the raw def shape a circuit authors, ready for fromRaw. custom-tracks.js:280 */
export function toRaw(it: CustomDesign): CustomRawDef {
  const theme = TrackThemes.defFields(it.theme, it);   // the design: the street presets thin their city past cityM of lap
  const hs = Array.isArray(it.heights) ? it.heights : null;
  // path.pts stay [x, z]; [x, z, y] when any node height is non-zero (def.ts realPoints reads p[2]).
  const pathPts = it.pts.map((p, i): [number, number] | [number, number, number] => {
    const y = hs && Number.isFinite(+hs[i]!) ? +hs[i]! : 0;
    return y ? [p[0], p[1], y] : [p[0], p[1]];
  });
  const raw: CustomRawDef = Object.assign({
    id: it.id, custom: true as const, name: it.name, gp: it.name + " GP", country: it.country || "",
    lengthKm: Math.round(it.lengthM / 100) / 10 || 0.1, classic: false as const,
    sceneryCoordinates: "racing" as const, startFrac: 0 as const, undulate: true as const,
    baseHW: it.baseHW,
    path: { len: it.lengthM, pts: pathPts },
    turns: it.turns && it.turns.length ? it.turns.slice() : null, sectors: null,
    bankZones: it.bankZones, elevations: it.elevations, bridges: it.bridges,
  }, theme);
  // applyHwZones keys its windows on the CONTROL INDEX fraction (i / N); the
  // designer authors arc fractions, so map each end through the polygon.
  if (it.hwZones) raw.hwZones = it.hwZones.map((z) => Object.assign({}, z, { s0: arcToIndexFrac(it.pts, z.s0), s1: arcToIndexFrac(it.pts, z.s1) }));
  const kerb = sanitizeKerbStyle(it.kerbStyle);
  if (kerb !== "flat") raw.kerbStyle = kerb;
  // Berms: explicit false opts out; default ON when any bankZones exist.
  if (it.berms === false) raw.berms = false;
  else if (it.bankZones && it.bankZones.length) raw.berms = true;
  raw.scenery = TrackThemes.sceneryFor(it);
  return raw;
}

/** custom-tracks.js:312 */
export const isCustom = (def: { custom?: boolean } | null | undefined): boolean => !!(def && def.custom);

/** toRaw → fromRaw. The cast: see CustomRawDef (fromRaw tolerates its nulls). */
const buildDef = (it: CustomDesign): BuiltDef => fromRaw(toRaw(it) as unknown as RawDef);

/**
 * A design (the stored record, or a decoded share code) → the LIST-shaped def
 * buildTrack takes. f1-game tools/track/verify-track.cjs:257 customDef: the
 * same sanitize → toRaw → fromRaw, minus the VM context (customContext, :235),
 * which there only loads hash32 / track-themes / props / custom-tracks / codec
 * into the vm over a stub store; here they are ES imports.
 */
export function customDef(design: unknown): BuiltDef {
  const it = sanitize(design);
  if (!it) throw new Error("custom design rejected by CustomTracks.sanitize (geometry)");
  return buildDef(it);
}

/** custom-tracks.js:398 */
export const COLLECTION_FORMAT = "apex26.tracks";

// ── the game wiring: injected hooks ──────────────────────────────────────

/** The façade game.js hands create() (f1-game `G`). */
export interface GameFacade {
  trackIdx?: number;
  soundOn?: boolean;
}
/** The DOM event the door's cancel listener reads. */
export interface DoorEvent { type: string; key?: string; target: unknown }
/** The TRACK DESIGNER title door (game.js `$()`). */
export interface DoorElement {
  onclick: (() => unknown) | null;
  contains?(node: unknown): boolean;
}
/** create()'s hooks (f1-game custom-tracks.js:579). */
export interface CreateHooks {
  door?: DoorElement | null;
  /** The lazy loader (f1-game's script injector). */
  load?(files: readonly string[], edges: readonly unknown[], opts: { strict: boolean; loaded: Set<string> }): Promise<boolean>;
}
/** f1-game's TrackDesigner, as this file calls it. */
export interface TrackDesignerHooks {
  init?(G: GameFacade | null, opts: { custom: CustomTracksApi | null }): void;
  open(opts?: { resume?: TestReturn; design?: CustomDesign; shared?: boolean }): void;
  placeTest?(r: TestReturn): void;
}
/** TEST HERE's way back: { id, sel, span, s } of the design the test drive left from. */
export interface TestReturn { id: string; [k: string]: unknown }
/** A capture-phase listener target (document). */
export interface ListenerTarget {
  addEventListener?(type: string, fn: (e: DoorEvent) => void, capture: boolean): void;
  removeEventListener?(type: string, fn: (e: DoorEvent) => void, capture: boolean): void;
}

/**
 * Everything custom-tracks.js reached through globals. All optional: an absent
 * hook takes f1-game's `typeof X === "undefined"` branch.
 */
export interface CustomTracksDeps {
  /** UiLayers (inRace, top). TODO(lane-shell) */
  layers?: { inRace?(): boolean; top?(): unknown } | null;
  /** Tracks.LIST as the game sees it, custom tail included. Default: the shipped LIST. TODO(lane-shell) */
  trackList?(): readonly { id: string; custom?: boolean }[];
  /**
   * Replace Tracks.LIST's custom tail with `defs` (custom-tracks.js:318 splice +
   * :325 push). sync() calls it once per sync with every def that built. TODO(lane-shell)
   */
  setCustomTail?(defs: BuiltDef[]): void;
  /** Ghost and InputGhost (each optional): clear(id) drops a circuit's recorded runs. TODO(lane-shell) */
  ghosts?: readonly ({ clear?(id: string): void } | null | undefined)[];
  /** ApexRoster.LAZY_EDITOR / LAZY_EDITOR_EDGES: the designer bundle. TODO(lane-shell) */
  roster?: { LAZY_EDITOR?: readonly string[] | null; LAZY_EDITOR_EDGES?: readonly unknown[] | null } | null;
  /** TrackDesigner, looked up at call time (it loads lazily). TODO(lane-shell) */
  designer?(): TrackDesignerHooks | null | undefined;
  /** TrackCodec (./codec), looked up at call time (LAZY_EDITOR in f1-game). TODO(lane-shell) */
  codec?(): Pick<typeof Codec, "fromHash" | "decode" | "withoutTrack"> | null | undefined;
  /** GameAudio. TODO(lane-shell) */
  audio?: { uiSelect(): void } | null;
  /** `location` (hash, pathname, search). TODO(lane-shell) */
  location?(): { hash: string; pathname: string; search: string } | null | undefined;
  /** history.replaceState(history.state, "", url). TODO(lane-shell) */
  replaceState?(url: string): void;
  /** `document`, for the door's capture-phase cancel listeners. TODO(lane-shell) */
  document?(): ListenerTarget | null | undefined;
  /** window.addEventListener("hashchange", fn). Its presence stands for `window`. TODO(lane-shell) */
  onHashChange?(fn: () => void): void;
}

type CollectionRecord = { index: number; name: string; status: "error" | "duplicate" | "add"; reason: string | null };
export interface PreflightSummary {
  ok: boolean; added: number; skipped: number; records: CollectionRecord[];
  reason?: string; index?: number;
}
export interface PreflightOptions {
  valid?(): boolean;
  yieldTask?(): Promise<unknown>;
  onProgress?(p: { done: number; total: number; added: number; skipped: number; records: CollectionRecord[] }): void;
}
type Validate = (it: CustomDesign) => { ok: boolean };

/** The store-backed registry: f1-game's CustomTracks object (custom-tracks.js:619). */
export type CustomTracksApi = ReturnType<typeof createCustomTracks>;

/**
 * The registry over `store` (f1-game's module-level GameStore.store). Runs
 * sync() once on creation, as f1-game does at eval (custom-tracks.js:617).
 */
export function createCustomTracks(store: EditorStore, deps: CustomTracksDeps = {}) {
  const inRace = () => !!(deps.layers && deps.layers.inRace && deps.layers.inRace());
  const trackList = () => (deps.trackList ? deps.trackList() : LIST);

  /** custom-tracks.js:232 */
  function load(): { v: number; items: CustomDesign[] } {
    const v = store.get<unknown>(KEY, null);
    const items: CustomDesign[] = [];
    const seen = new Set<string>();
    if (v && typeof v === "object" && Array.isArray((v as { items?: unknown }).items)) {
      for (const raw of ((v as { items: unknown[] }).items).slice(0, LIMITS.items)) {
        let it: CustomDesign | null = null;
        try { it = sanitize(raw); } catch (_) { /* unreadable design skipped */ }
        if (!it) continue;
        // Two records with one content id: the newer edit wins.
        const rec = it;
        if (seen.has(rec.id)) { const i = items.findIndex((x) => x.id === rec.id); if (items[i]!.updated < rec.updated) items[i] = rec; continue; }
        seen.add(rec.id); items.push(rec);
      }
    }
    return { v: V, items };
  }
  // Circuits whose board and ghosts wait on a durable write (#2192): a refused
  // write (quota) leaves the old design on disk, so its runs must outlive it.
  const pendingDrops = new Set<string>();
  function write(items: CustomDesign[]): WriteResult {
    const r = store.write(KEY, { v: V, items });
    if (r && r.durable && pendingDrops.size) {
      for (const id of pendingDrops) if (!items.some((x) => x.id === id)) dropRuns(id);
      pendingDrops.clear();
    }
    return r;
  }
  function dropRunsOnceDurable(r: WriteResult, id: string) { if (r && r.durable) dropRuns(id); else pendingDrops.add(id); }

  /** Rebuild the custom tail of Tracks.LIST from storage. Never mid-race. custom-tracks.js:316 */
  function sync(): number {
    if (inRace()) return -1;
    const items = load().items;
    // Per record: one stored design that throws must not take boot down with it.
    const defs: BuiltDef[] = [];
    let n = 0;
    for (const it of items) {
      try { defs.push(buildDef(it)); n++; }
      catch (_) { /* skipped; the record stays in storage */ }
    }
    if (deps.setCustomTail) deps.setCustomTail(defs);
    return n;
  }

  /** custom-tracks.js:331 */
  function list(): CustomDesign[] { return load().items; }
  /** custom-tracks.js:332 */
  function get(id: string): CustomDesign | null { return load().items.find((x) => x.id === id) || null; }

  /** The selected circuit's id: the façade's trackIdx, else the stored stable id. */
  function selectedId(): string | null {
    const t = _G && Number.isInteger(_G.trackIdx) ? trackList()[_G.trackIdx!] : null;
    const id = t ? t.id : store.get<unknown>("trackId", null);
    // Only a CUSTOM selection can move: the shipped circuits sit ahead of the tail.
    return typeof id === "string" && id.startsWith("custom-") ? id : null;
  }
  /** After the custom tail changed: put the selection back on `id` (or 0) and rewrite both stored keys. */
  function reselect(id: string | null): number {
    const L = trackList();
    let idx = id ? L.findIndex((t) => t.id === id) : -1;
    if (idx < 0) idx = 0;
    if (_G) _G.trackIdx = idx;
    const t = L[idx];
    if (t) { store.set("trackId", t.id); store.set("track", idx); }
    return idx;
  }

  /** A circuit's time-trial board and recorded runs go with it. A failed clear never blocks. */
  function dropRuns(id: string) {
    try { store.rawDel("ttlb." + id); } catch (_) { /* never had one */ }
    for (const M of deps.ghosts || []) {
      try { if (M && typeof M.clear === "function") M.clear(id); } catch (_) { /* ghost not cleared */ }
    }
  }

  /**
   * Save (new id = new entry; same content id = refresh the label).
   * opts.replace: the id this design was opened from (EDIT); a geometry change
   * REPLACES it in place. custom-tracks.js:369
   */
  function upsert(design: unknown, opts?: { replace?: string | null } | null) {
    const it = sanitize(design);
    if (!it) return { ok: false as const, reason: "geometry" };
    const sel = selectedId();
    const items = load().items;
    const origin = opts && typeof opts.replace === "string" && opts.replace !== it.id ? items.findIndex((x) => x.id === opts.replace) : -1;
    const i = items.findIndex((x) => x.id === it.id);
    if (i >= 0) { it.created = items[i]!.created; items[i] = it; if (origin >= 0) items.splice(origin, 1); }
    else if (origin >= 0) { it.created = items[origin]!.created; items[origin] = it; }
    else { if (items.length >= LIMITS.items) return { ok: false as const, reason: "full", limit: LIMITS.items }; items.push(it); }
    it.updated = Date.now();
    const r = write(items);
    if (origin >= 0) dropRunsOnceDurable(r, opts!.replace!);
    if (sync() >= 0 && sel) reselect(sel === (opts && opts.replace) ? it.id : sel);
    return { ok: true as const, id: it.id, replaced: origin >= 0 ? opts!.replace! : null, durable: !!(r && r.durable), reason: r && r.reason };
  }

  /** custom-tracks.js:386 */
  function remove(id: string) {
    const sel = selectedId();
    const items = load().items.filter((x) => x.id !== id);
    const r = write(items);
    // Its time-trial board and ghosts go with it.
    dropRunsOnceDurable(r, id);
    // Re-resolve by id: the removed circuit's index now names its successor.
    if (sync() >= 0 && sel) reselect(sel === id ? null : sel);
    return { ok: true, durable: !!(r && r.durable) };
  }

  /** custom-tracks.js:399 */
  function exportCollection() { return { format: COLLECTION_FORMAT, v: 1, items: list() }; }
  /**
   * Preflight the entire collection before one write. Existing content wins
   * duplicates; a hash collision refuses the import. custom-tracks.js:403
   */
  function importCollection(raw: unknown, validate?: Validate | null) {
    const c = raw as { format?: unknown; v?: unknown; items?: unknown } | null | undefined;
    if (!c || c.format !== COLLECTION_FORMAT || c.v !== 1 || !Array.isArray(c.items)) return { ok: false as const, reason: "format" };
    const rows = c.items as unknown[];
    if (rows.length > LIMITS.items) return { ok: false as const, reason: "full", limit: LIMITS.items };
    const items = list(), known = new Map(items.map((it) => [it.id, it]));
    let added = 0, skipped = 0;
    for (const [index, row] of rows.entries()) {
      let it: CustomDesign | null;
      try {
        it = sanitize(row);
        // Bound engine work before validation, even with hostile coordinates.
        if (!it || loopLength(it.pts) > 14000 || (validate && !validate(it).ok)) return { ok: false as const, reason: "invalid", index };
        buildDef(it);
      } catch (_) { return { ok: false as const, reason: "invalid", index }; }
      const existing = known.get(it.id);
      if (existing) {
        if (canonical(existing) !== canonical(it)) return { ok: false as const, reason: "collision", index };
        skipped++; continue;
      }
      known.set(it.id, it); items.push(it); added++;
    }
    if (items.length > LIMITS.items) return { ok: false as const, reason: "full", limit: LIMITS.items, needed: items.length };
    if (!added) return { ok: true as const, added, skipped, durable: true };
    const selected = selectedId(), result = write(items);
    if (!result || !result.ok) return { ok: false as const, reason: "write" };
    if (sync() >= 0 && selected) reselect(selected);
    return { ok: true as const, added, skipped, durable: !!result.durable };
  }

  // Prepared imports own private sanitized data. An exact library snapshot
  // catches local and cross-tab changes.
  const collectionPlans = new WeakMap<PreflightSummary, { items: CustomDesign[]; revision: string; added: number; skipped: number }>();
  const collectionRevision = () => JSON.stringify(store.get<unknown>(KEY, null));
  /** custom-tracks.js:436 */
  async function preflightCollection(raw: unknown, validate?: Validate | null, options?: PreflightOptions | null): Promise<PreflightSummary> {
    const opt = options || {}, valid = () => !opt.valid || opt.valid();
    const records: CollectionRecord[] = [], summary: PreflightSummary = { ok: false, added: 0, skipped: 0, records };
    const c = raw as { format?: unknown; v?: unknown; items?: unknown } | null | undefined;
    if (!c || c.format !== COLLECTION_FORMAT || c.v !== 1 || !Array.isArray(c.items)) return Object.assign(summary, { reason: "format" });
    if ((c.items as unknown[]).length > LIMITS.items) return Object.assign(summary, { reason: "full" });
    // Snapshot input too: a caller mutating its file object mid-preflight must not change what is approved.
    const incoming = JSON.parse(JSON.stringify(c.items)) as unknown[], revision = collectionRevision();
    const items = list(), known = new Map(items.map((it) => [it.id, it]));
    const pause = opt.yieldTask || (() => new Promise((resolve) => setTimeout(resolve, 0)));
    for (const [index, row] of incoming.entries()) {
      if (!valid()) return Object.assign(summary, { reason: "canceled" });
      await pause();
      if (!valid()) return Object.assign(summary, { reason: "canceled" });
      let it: CustomDesign | null | undefined, reason: string | null = null;
      try {
        it = sanitize(row);
        if (!it || loopLength(it.pts) > 14000 || (validate && !validate(it).ok)) reason = "invalid";
        else buildDef(it);
      } catch (_) { reason = "invalid"; }
      const existing = it && known.get(it.id);
      if (!reason && existing && canonical(existing) !== canonical(it!)) reason = "collision";
      const status = reason ? "error" : existing ? "duplicate" : "add";
      records.push({ index, name: it ? it.name : sanitizeName(row && (row as { name?: unknown }).name), status, reason });
      if (!reason) {
        if (existing) summary.skipped++;
        else { known.set(it!.id, it!); items.push(it!); summary.added++; }
      }
      if (opt.onProgress) opt.onProgress({ done: index + 1, total: incoming.length, added: summary.added, skipped: summary.skipped, records: records.map((r) => Object.assign({}, r)) });
    }
    if (!valid()) return Object.assign(summary, { reason: "canceled" });
    const bad = records.find((r) => r.status === "error");
    if (bad) return Object.assign(summary, { reason: bad.reason!, index: bad.index });
    if (items.length > LIMITS.items) return Object.assign(summary, { reason: "full" });
    if (revision !== collectionRevision()) return Object.assign(summary, { reason: "changed" });
    summary.ok = true;
    collectionPlans.set(summary, { items, revision, added: summary.added, skipped: summary.skipped });
    return summary;
  }
  /** custom-tracks.js:475 */
  function cancelCollectionPreflight(plan: PreflightSummary | null | undefined) { if (plan) collectionPlans.delete(plan); }
  /** custom-tracks.js:476 */
  function commitCollectionPreflight(plan: PreflightSummary) {
    const prepared = collectionPlans.get(plan);
    if (!prepared) return { ok: false as const, reason: "canceled" };
    collectionPlans.delete(plan);   // one explicit approval can write at most once
    if (prepared.revision !== collectionRevision()) return { ok: false as const, reason: "changed" };
    if (!prepared.added) return { ok: true as const, added: 0, skipped: prepared.skipped, durable: true };
    const selected = selectedId(), result = write(prepared.items);
    if (!result || !result.ok) return { ok: false as const, reason: "write" };
    if (sync() >= 0 && selected) reselect(selected);
    return { ok: true as const, added: prepared.added, skipped: prepared.skipped, durable: !!result.durable };
  }

  /** Make a custom circuit the current selection (what the picker click does). custom-tracks.js:489 */
  function select(id: string): number {
    const idx = trackList().findIndex((t) => t.id === id);
    if (idx < 0) return -1;
    store.set("trackId", id); store.set("track", idx);
    return idx;
  }

  /** custom-tracks.js:496 */
  function draft(): unknown { return store.get<unknown>(DRAFT_KEY, null); }
  /** custom-tracks.js:497 */
  function setDraft(d: unknown) { if (d == null) store.rawDel(DRAFT_KEY); else store.set(DRAFT_KEY, d); }
  /** custom-tracks.js:498 */
  function draftPrev(): unknown { return store.get<unknown>(DRAFT_PREV_KEY, null); }
  /** custom-tracks.js:499 */
  function setDraftPrev(d: unknown) { if (d == null) store.rawDel(DRAFT_PREV_KEY); else store.set(DRAFT_PREV_KEY, d); }

  // game.js hands the façade + the lazy loader; the designer screen and the
  // #track= share link hang off this. Idempotent, DOM-optional.
  let _editorLoad: Promise<boolean> | null = null, _G: GameFacade | null = null, _hooks: CreateHooks | null = null;
  // Files that evaluated on an earlier (failed) attempt: never re-injected.
  const _editorLoaded = new Set<string>();
  /** custom-tracks.js:508 */
  function ensureEditor(): Promise<boolean> {
    if (_editorLoad) return _editorLoad;
    const R = deps.roster;
    const files = R && R.LAZY_EDITOR, edges = (R && R.LAZY_EDITOR_EDGES) || [];
    if (!files || !_hooks || typeof _hooks.load !== "function") return Promise.resolve(false);
    _editorLoad = _hooks.load(files, edges, { strict: true, loaded: _editorLoaded }).then((ok) => {
      if (!ok) { _editorLoad = null; return false; }
      const D = deps.designer && deps.designer();
      if (D && D.init) D.init(_G, { custom: api });
      return true;
    });
    return _editorLoad;
  }
  // TEST HERE's way back. MEMORY ONLY: a reload must not reopen the designer.
  let _ret: TestReturn | null = null;
  /** Arm the return the next consumeTrackHash() outside a race takes. custom-tracks.js:524 */
  function armReturn(r: unknown) { _ret = r && typeof r === "object" ? (r as TestReturn) : null; }
  /** A start just reached its countdown: while a return is armed, go back onto the test point. custom-tracks.js:527 */
  function afterStart() {
    const D = deps.designer && deps.designer();
    if (_ret && D && D.placeTest) D.placeTest(_ret);
  }
  /**
   * A #track=<code> link: load the designer and open the shared design, then
   * strip the fragment. Mid-race it waits, fragment intact. Resolves true when
   * a design opened, false when refused or absent, null when deferred.
   * custom-tracks.js:536
   */
  let hashGeneration = 0;
  function consumeTrackHash(): Promise<boolean | null> {
    const generation = ++hashGeneration;
    // An armed test-drive return goes first.
    if (_ret) {
      if (inRace()) return Promise.resolve(null);
      const r = _ret; _ret = null;
      return ensureEditor().then((ok) => {
        // Mid-race after the await: re-arm and wait.
        if (inRace()) {
          _ret = r;
          return null;
        }
        const D = deps.designer && deps.designer();
        if (!ok || !D) return false;
        D.open({ resume: r });
        return true;
      }).catch(() => false);
    }
    const loc = () => (deps.location && deps.location()) || null;
    const L0 = loc();
    const hash = L0 ? String(L0.hash || "") : "";
    if (!/[#&]track=/.test(hash)) return Promise.resolve(false);
    if (inRace()) return Promise.resolve(null);
    return ensureEditor().then(async (ok) => {
      const C = deps.codec && deps.codec(), D = deps.designer && deps.designer();
      if (!ok || !C || !D) return false;
      // A malformed fragment must not throw past here.
      let code: string | null = null;
      try { code = C.fromHash(hash); } catch (_) { code = null; }
      const r = code ? await C.decode(code) : { ok: false as const, reason: "malformed" };
      // A race that started while we awaited keeps the fragment.
      if (inRace()) return null;
      const L = loc();
      if (generation !== hashGeneration || !L || L.hash !== hash) return false;
      try { if (deps.replaceState) deps.replaceState(L.pathname + L.search + C.withoutTrack(hash)); } catch (_) { /* a sandboxed page */ }
      if (!r.ok) return false;
      D.open({ design: r.design, shared: true });
      return true;
    }).catch(() => false);   // f1-game :577 returns false on both of its branches (one also logs)
  }
  /** custom-tracks.js:579 */
  function create(G: GameFacade, hooks?: CreateHooks | null) {
    _G = G; _hooks = hooks || {};
    // The TRACK DESIGNER title door is handed in as an element.
    const door = _hooks.door || null;
    let doorGeneration = 0;
    if (door) door.onclick = () => {
      if (G.soundOn && deps.audio) deps.audio.uiSelect();
      const generation = ++doorGeneration;
      const layers = deps.layers || null;
      const owner = layers && layers.top ? layers.top() : null;
      let cancelled = false;
      // Loading is only preparation: another navigation owns the next screen.
      const cancel = (event: DoorEvent) => {
        if (event.type === "keydown" ? event.key === "Escape" : event.target !== door && !(door.contains && door.contains(event.target))) cancelled = true;
      };
      const doc = (deps.document && deps.document()) || null;
      if (doc && doc.addEventListener) {
        doc.addEventListener("click", cancel, true);
        doc.addEventListener("keydown", cancel, true);
      }
      return ensureEditor().then((ok) => {
        const D = deps.designer && deps.designer();
        if (!ok || cancelled || generation !== doorGeneration || !D) return;
        if (layers && ((layers.inRace && layers.inRace()) || (layers.top && layers.top() !== owner))) return;
        D.open();
      }).finally(() => {
        if (doc && doc.removeEventListener) {
          doc.removeEventListener("click", cancel, true);
          doc.removeEventListener("keydown", cancel, true);
        }
      });
    };
    if (deps.onHashChange) { void consumeTrackHash(); deps.onHashChange(consumeTrackHash); }
    return { ensureEditor, consumeTrackHash };
  }

  const api = {
    COLLECTION_FORMAT, exportCollection, importCollection, preflightCollection, commitCollectionPreflight, cancelCollectionPreflight,
    KEY, DRAFT_KEY, DRAFT_PREV_KEY, LIMITS, KERB_STYLES, sanitize, sanitizeName, sanitizeCountry, sanitizeHeights, sanitizeKerbStyle, sanitizeBerms,
    idOf, canonical, toRaw, arcToIndexFrac, sync, list, get, upsert, remove, select, isCustom, draft, setDraft, draftPrev, setDraftPrev,
    ensureEditor, consumeTrackHash, create, armReturn, afterStart,
  };
  sync();   // at creation: f1-game runs it at EVAL, before game.js resolves the stored trackId
  return Object.freeze(api);
}
