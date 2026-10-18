/* Apex 26 — PER-CAMERA-MODE framing offsets (the CAMERA TUNER's data layer): the knob registry (CAM_TUNE_DEFS), the per-mode override store (localStorage a26.camTune), a GLOBAL baseline layered under every mode, COMFORT multipliers independent of reduce-motion, built-in presets, and JSON / APXC1 share-code import.
 *
 * Ported verbatim from f1-game js/camera/offsets.js:1-678 (CamTune). The IIFE
 * singleton becomes `createCamTune(deps)`; its ambient globals are injected:
 *   GameStore.store  → deps.store (src/camera/store.ts)          offsets.js:6, :154-169, :178-183
 *   Teams.LIST       → deps.teamId (default: src/car/teams.ts)     offsets.js:180-183
 *   CamModes         → deps.modeIds  TODO(lane-shell): mode-switch.js CAM_MODES   offsets.js:470-472
 *   Log.info         → src/data/log.ts
 * Keys keep f1-game's names (`camTune`, …); the store prefixes them `a26.`.
 *
 * Camera only: every value here moves where the camera looks, never the car.
 */
import { Teams } from "../car/teams";
import type { Vec3 } from "../contracts/track";
import { log } from "../data/log";
import { clamp } from "../physics/math";   // shared scalar helper (f1-game js/core/mat4.js:5)
import type { CamStore } from "./store";

const KEY = "camTune";
const KEY_GLOBAL = "camTuneGlobal";
const KEY_COMFORT = "camComfort";
const KEY_TRACK = "camTuneTrack";
const KEY_CAR = "camTuneCar";
const DEG = Math.PI / 180;
const GLOBAL_MODE = "_global";               // reserved id — never a real CAM_MODES entry

export interface TuneDef {
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly def: number;
  readonly unit: string;
  readonly help: string;
  /** Only these cameras show the knob (panel) / read it (rig). */
  readonly modes?: readonly string[];
}

// The knobs, in panel order. `def` is what the mode ships with, and set() stores
// explicit per-mode values, including defaults, until RESET; an untouched
// install carries nothing. For the six GEOMETRIC offsets below that def is 0,
// because each is a DELTA on the rig js/camera/vantage.js solved: zero means
// "shipped framing". CORNER LEAD is the exception and its def is the shipped
// amount itself (0.54), because it is an ABSOLUTE blend, not a delta — see the
// note above it for what defaulting it to 0 cost.
export const CAM_TUNE_DEFS: readonly TuneDef[] = Object.freeze([
  { id: "height", label: "HEIGHT",   min: -6,  max: 10, step: 0.025, def: 0, unit: "m",
    help: "Raise or lower the camera eye. The aim stays on the car, so raising it looks further down over the nose." },
  { id: "dist",   label: "DISTANCE", min: -12, max: 24, step: 0.025, def: 0, unit: "m",
    help: "Pull the eye back (+) or push it in (−) along the view direction. On the onboard cams this slides the seat fore/aft." },
  { id: "side",   label: "SIDE",     min: -12, max: 12, step: 0.025, def: 0, unit: "m",
    help: "Offset the eye right (+) or left (−) of the view axis for a three-quarter angle on the car." },
  { id: "pitch",  label: "PITCH",    min: -45, max: 45, step: 0.25, def: 0, unit: "°",
    help: "Tilt the aim up (+) or down (−). Positive shows more sky and horizon, negative more road." },
  { id: "yaw",    label: "YAW",      min: -90, max: 90, step: 0.25, def: 0, unit: "°",
    help: "Pan the aim right (+) or left (−) without moving the eye." },
  { id: "fov",    label: "FOV",      min: -35, max: 35, step: 0.25, def: 0, unit: "°",
    help: "Widen (+) or tighten (−) the field of view on top of the mode's own speed-scaled FOV. Solved FOV is clamped 20–110°: a tight onboard (~36°) clips the last −16° of this slider, and a wide chase (~81°) clips the last few + degrees." },
  // CORNER LEAD is not a geometric offset like the six above — CamTune.apply()
  // never touches it. js/camera/vantage.js reads it directly in the chase/far
  // branch and blends the rig toward the classic road-frame chase (eye back
  // along the road, aim at the curved centreline ahead), so the camera leads
  // and swings INTO turns. 0 = locked to the car (the shipped free-world rig);
  // 1 = the full corner-following chase. Only chase/far read it — `modes` gates
  // which cameras show the slider.
  // def MUST equal CHASE_CORNER_LEAD_DEFAULT in js/camera/vantage.js (0.54), and
  // tests/unit/camera-defaults.test.mjs holds the two together. This is not cosmetic:
  // an unstored cornerLead
  // means "use the shipped default". With def 0 the two readings of zero
  // collided — dragging the slider to 0 deleted the key, so the rig fell back to
  // 0.54 and the ONE END OF THE RANGE THE HELP TEXT PROMISES ("0 locks flat
  // behind the car") was the one value unreachable. Defaulting to the shipped
  // amount also stops the panel opening on a lying 0 while 0.54 is live.
  { id: "cornerLead", label: "CORNER LEAD", min: 0, max: 1, step: 0.02, def: 0.54, unit: "", modes: ["chase", "far", "drone"],
    help: "Let the chase/drone camera lead and swing INTO corners. Chase/far ship at 0.54; drone ships its own look-ahead (~0.55) when unset. 0 locks flat behind the car; 1 is the full corner-following aim. Purely visual — never affects the car." },
  // CORNER HANG is the live outside-of-the-bend move (chase, drift, reverse,
  // overhead, and the broadcast cams). Like CORNER LEAD it is a scale on the
  // shipped amount, not a metre offset, so def is 1 and 0 has to stay stored.
  // CamTune.apply() does not read it. vantage.js multiplies that camera's hang.
  { id: "cornerHang", label: "CORNER HANG", min: 0, max: 2, step: 0.05, def: 1, unit: "",
    modes: ["chase", "drift", "reverse", "overhead", "heli", "side", "cinematic", "drone"],
    help: "How far this camera steps to the outside of a bend. 1 is the shipped hang. 0 holds the line with no extra swing. 2 is twice the shipped move. The pit wall does not have it. Purely visual — never affects the car." },
]);
const DEF_BY_ID = new Map<string, TuneDef>();
for (const d of CAM_TUNE_DEFS) DEF_BY_ID.set(d.id, d);

export const FOV_MIN = 20, FOV_MAX = 110;

// COMFORT — independent of OS prefers-reduced-motion / MOTION: REDUCED.
// camComfort() in game.js still hard-gates shake / buzz / roll when motion is
// reduced; these knobs scale the same effects when motion is allowed, and the
// FOV bias always applies (FOV was never part of the reduce-motion gate).
export const COMFORT_DEFS: readonly TuneDef[] = Object.freeze([
  { id: "fovBias",   label: "FOV BIAS",      min: -15, max: 15, step: 0.5, def: 0, unit: "°",
    help: "Widen (+) or tighten (−) every camera's field of view. Independent of MOTION: REDUCED — a comfort FOV without muting camera motion." },
  { id: "speedFov",  label: "SPEED FOV",     min: 0, max: 1, step: 0.05, def: 1, unit: "",
    help: "How strongly FOV widens with speed. 0 keeps the standing FOV at any pace; 1 is the shipped speed-FOV. Does not touch reduce-motion." },
  { id: "bob",       label: "HEAD BOB",      min: 0, max: 1, step: 0.05, def: 1, unit: "",
    help: "Strength of onboard speed buzz and collision shake. 0 is still; 1 is shipped. MOTION: REDUCED still zeroes these entirely." },
  { id: "rollLean",  label: "ROLL LEAN",     min: 0, max: 1, step: 0.05, def: 1, unit: "",
    help: "How far the horizon leans with bank and slip. 0 stays level; 1 is shipped. MOTION: REDUCED still forces a level horizon." },
]);
const COMFORT_BY_ID = new Map<string, TuneDef>();
for (const d of COMFORT_DEFS) COMFORT_BY_ID.set(d.id, d);

/** A knob map: id → value. */
export type Prof = Record<string, number>;
export type ModesMap = Record<string, Prof>;
export interface ScopeEntry { modes: ModesMap; comfort: Prof }
export type ScopeMap = Record<string, ScopeEntry>;
export type Scope = "track" | "car";
export type PersistWhich = "modes" | "global" | "comfort" | "track" | "car";

export interface Preset {
  readonly label: string;
  readonly help: string;
  readonly modes: Readonly<Record<string, Readonly<Prof>>> | null;
  readonly global: Readonly<Prof> | null;
  readonly comfort: Readonly<Prof> | null;
}

// Built-in framing packs. Modes keyed like camTune; `global` is the baseline
// layered under every mode; `comfort` is optional. STOCK clears everything.
export const PRESETS: Readonly<Record<string, Preset>> = Object.freeze({
  stock: Object.freeze({
    label: "STOCK",
    help: "Shipped framing on every camera — clears per-mode edits, the global baseline and comfort knobs.",
    modes: null, global: null, comfort: null,
  }),
  close: Object.freeze({
    label: "CLOSE UP",
    help: "Pull chase/far/hood in and drop the eye slightly for a tighter race.",
    modes: {
      chase: { dist: -2.5, height: -0.35, fov: -4 },
      far: { dist: -3, height: -0.25, fov: -3 },
      hood: { dist: 0.35, height: -0.08, fov: -2 },
      cockpit: { dist: 0.12, height: -0.04 },
    },
    global: null, comfort: null,
  }),
  wide: Object.freeze({
    label: "WIDE FOV",
    help: "A global FOV bias so every camera opens up without rewriting each mode.",
    modes: null,
    global: { fov: 8 },
    comfort: { fovBias: 2, speedFov: 0.85 },
  }),
  flat: Object.freeze({
    label: "FLAT CHASE",
    help: "Lock chase/far flat behind the car (corner lead 0) — no swing into bends.",
    modes: { chase: { cornerLead: 0, cornerHang: 0 }, far: { cornerLead: 0 } },
    global: null, comfort: null,
  }),
  calm: Object.freeze({
    label: "CALM",
    help: "Dial back speed-FOV, head bob and roll lean without enabling MOTION: REDUCED.",
    modes: null, global: null,
    comfort: { speedFov: 0.35, bob: 0.2, rollLean: 0.25, fovBias: 0 },
  }),
});

export interface CamPack {
  v: 1;
  modes?: ModesMap;
  global?: Prof;
  comfort?: Prof;
  tracks?: ScopeMap;
  cars?: ScopeMap;
}

export type ImportResult =
  | { ok: false; reason: string }
  | { ok: true; modes: number; global: number; comfort: number; tracks: number; cars: number };
export type DecodeResult =
  | { ok: false; reason: string }
  | { ok: true; pack: unknown; kind: "share" | "edits" | "json" };
export type ImportTextResult =
  | { ok: false; reason: string }
  | { ok: true; kind: "share" | "edits" | "json"; modes: number; global: number; comfort: number; tracks: number; cars: number };

export interface CamTuneDeps {
  readonly store: CamStore;
  /** Teams.LIST[idx].id, or null for no such team (offsets.js:180-183). */
  readonly teamId?: (idx: number) => string | null | undefined;
  /** CamModes.CAM_MODES ids (offsets.js:470-472). TODO(lane-shell): wire mode-switch's list. */
  readonly modeIds?: () => readonly string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object";
const keys = (o: object): string[] => Object.keys(o);
const num = (o: Obj | Prof | null | undefined, id: string): number | undefined => {
  const v = o ? o[id] : undefined;
  return typeof v === "number" ? v : undefined;
};

function sanitizeProf(src: unknown, keepDefaults = false): Prof {
  const prof: Prof = {};
  if (!isObj(src)) return prof;
  for (const d of CAM_TUNE_DEFS) {
    const v = src[d.id];
    if (typeof v === "number" && isFinite(v) && (keepDefaults || v !== d.def)) prof[d.id] = clamp(v, d.min, d.max);
  }
  return prof;
}
function sanitize(raw: unknown): ModesMap {
  const out: ModesMap = {};
  if (!isObj(raw)) return out;
  for (const mode of keys(raw)) {
    if (mode === GLOBAL_MODE) continue;   // global lives in its own store key
    const prof = sanitizeProf(raw[mode], true);
    if (keys(prof).length) out[mode] = prof;
  }
  return out;
}
function sanitizeComfort(raw: unknown, keepDefaults = false): Prof {
  const out: Prof = {};
  if (!isObj(raw)) return out;
  for (const d of COMFORT_DEFS) {
    const v = raw[d.id];
    if (typeof v === "number" && isFinite(v) && (keepDefaults || v !== d.def)) out[d.id] = clamp(v, d.min, d.max);
  }
  return out;
}
function sanitizeScopes(raw: unknown): ScopeMap {
  const out: ScopeMap = {};
  if (!isObj(raw) || Array.isArray(raw)) return out;
  for (const key of keys(raw)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
    const src = raw[key];
    if (!isObj(src) || Array.isArray(src)) continue;
    const modes = sanitize(src["modes"]);
    const comfort = sanitizeComfort(src["comfort"], true);
    if (keys(modes).length || keys(comfort).length) out[key] = { modes, comfort };
  }
  return out;
}

// Compact share code: APXC1 + base64url(JSON). No compression — packs stay small.
export const SHARE_MAGIC = "APXC1";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const b64At = (i: number): string => B64.charAt(i);
function bytesToB64(bytes: readonly number[]): string {
  let out = "", i = 0;
  const at = (k: number): number => bytes[k] ?? 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (at(i) << 16) | (at(i + 1) << 8) | at(i + 2);
    out += b64At((n >> 18) & 63) + b64At((n >> 12) & 63) + b64At((n >> 6) & 63) + b64At(n & 63);
  }
  if (i < bytes.length) {
    const a = at(i), b = i + 1 < bytes.length ? at(i + 1) : 0;
    out += b64At(a >> 2) + b64At(((a & 3) << 4) | (b >> 4));
    out += i + 1 < bytes.length ? b64At(((b & 15) << 2)) : "=";
    out += "=";
  }
  return out;
}
function b64ToBytes(b64: string): number[] {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const len = clean.length;
  const bytes: number[] = [];
  // f1-game indexes past the end as `undefined`, and B64.indexOf(undefined) is -1.
  const ch = (k: number): string | undefined => (k < len ? clean.charAt(k) : undefined);
  const idx = (c: string | undefined): number => (c === undefined ? -1 : B64.indexOf(c));
  for (let i = 0; i < len; i += 4) {
    const n = (idx(ch(i)) << 18) | (idx(ch(i + 1)) << 12) |
      ((ch(i + 2) === "=" ? 0 : idx(ch(i + 2))) << 6) |
      (ch(i + 3) === "=" ? 0 : idx(ch(i + 3)));
    bytes.push((n >> 16) & 255);
    if (ch(i + 2) !== "=") bytes.push((n >> 8) & 255);
    if (ch(i + 3) !== "=") bytes.push(n & 255);
  }
  return bytes;
}
function utf8Bytes(str: string): number[] {
  if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(str));
  const a: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 128) a.push(c);
    else if (c < 2048) a.push(192 | (c >> 6), 128 | (c & 63));
    else a.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  return a;
}
function utf8String(bytes: number[]): string {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(Uint8Array.from(bytes));
  let out = "";
  const at = (k: number): number => bytes[k] ?? 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = at(i);
    if (b < 128) out += String.fromCharCode(b);
    else if (b >= 192 && b < 224 && i + 1 < bytes.length) {
      out += String.fromCharCode(((b & 31) << 6) | (at(++i) & 63));
    } else if (i + 2 < bytes.length) {
      out += String.fromCharCode(((b & 15) << 12) | ((at(++i) & 63) << 6) | (at(++i) & 63));
    }
  }
  return out;
}
function b64urlEncode(str: string): string {
  return bytesToB64(utf8Bytes(str)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return utf8String(b64ToBytes(b64));
}

export type CamTune = ReturnType<typeof createCamTune>;

/** One CamTune instance: the f1-game singleton's state, loaded from `deps.store` (offsets.js:154-158). */
export function createCamTune(deps: CamTuneDeps) {
  const { store } = deps;
  const teamId = deps.teamId ?? ((idx: number): string | null => Teams.LIST[idx]?.id ?? null);

  let _store: ModesMap = {};
  let _global: Prof = {};
  let _comfort: Prof = {};
  let _tracks: ScopeMap = {};
  let _cars: ScopeMap = {};
  let _context: { track: string | null; car: string | null } = { track: null, car: null };

  function load(raw: unknown): ModesMap { _store = sanitize(raw); return _store; }
  function loadGlobal(raw: unknown): Prof { _global = sanitizeProf(raw); return _global; }
  function loadComfort(raw: unknown): Prof { _comfort = sanitizeComfort(raw); return _comfort; }
  function loadTrack(raw: unknown): ScopeMap { _tracks = sanitizeScopes(raw); return _tracks; }
  function loadCar(raw: unknown): ScopeMap { _cars = sanitizeScopes(raw); return _cars; }
  load(store.get(KEY, null));
  loadGlobal(store.get(KEY_GLOBAL, null));
  loadComfort(store.get(KEY_COMFORT, null));
  loadTrack(store.get(KEY_TRACK, null));
  loadCar(store.get(KEY_CAR, null));

  // `which` = "modes" | "global" | "comfort" | "track" | "car" writes only that
  // store (the sliders fire on every input event). No argument retains the
  // original three-store contract; scoped callers persist track/car explicitly.
  function persist(which?: PersistWhich): void {
    if (!which || which === "modes") store.set(KEY, _store);
    if (!which || which === "global") store.set(KEY_GLOBAL, _global);
    if (!which || which === "comfort") store.set(KEY_COMFORT, _comfort);
    if (which === "track") store.set(KEY_TRACK, _tracks);
    if (which === "car") store.set(KEY_CAR, _cars);
  }

  function setContext(trackId: unknown, carId: unknown): { track: string | null; car: string | null } {
    _context = {
      track: typeof trackId === "string" && trackId ? trackId : null,
      car: typeof carId === "string" && carId ? carId : null,
    };
    return { ..._context };
  }
  function context(): { track: string | null; car: string | null } { return { ..._context }; }
  function scopeMap(scope: string): ScopeMap | null { return scope === "track" ? _tracks : scope === "car" ? _cars : null; }
  function refreshStoredContext(): void {
    const trackId = store.get("trackId", null);
    if (typeof trackId === "string" && trackId) _context.track = trackId;
    const team = store.get("team", 2);
    if (Number.isInteger(team)) {
      const id = teamId(team as number);
      if (id) _context.car = id;
    }
  }
  function scopeKey(scope: string): string | null {
    refreshStoredContext();
    return scope === "track" ? _context.track : scope === "car" ? _context.car : null;
  }
  function scopeEntry(scope: string, create: boolean): ScopeEntry | null {
    const map = scopeMap(scope), key = scopeKey(scope);
    if (!map || !key) return null;
    if (!map[key] && create) map[key] = { modes: {}, comfort: {} };
    return map[key] || null;
  }
  function scopedMode(scope: string, mode: string): Prof | null {
    const entry = scopeEntry(scope, false);
    return entry && entry.modes && entry.modes[mode] || null;
  }
  function pruneScope(scope: string): void {
    const map = scopeMap(scope), key = scopeKey(scope), entry = map && key && map[key];
    if (!entry || !map || !key) return;
    if (!keys(entry.modes || {}).length && !keys(entry.comfort || {}).length) delete map[key];
  }

  function mergedProf(mode: string): Prof | null {
    // Global baseline < per-mode < car < track.
    const layers = [_global, _store[mode], scopedMode("car", mode), scopedMode("track", mode)];
    const out: Prof = {};
    for (const layer of layers) if (layer) for (const d of CAM_TUNE_DEFS) {
      const v = num(layer, d.id);
      if (v !== undefined) out[d.id] = v;
    }
    return keys(out).length ? out : null;
  }

  // Resolved knob values for one mode — every id present, defaults filled in.
  // Includes the global baseline (mode overrides win).
  function values(mode: string): Prof {
    const prof = mergedProf(mode);
    const out: Prof = {};
    for (const d of CAM_TUNE_DEFS) out[d.id] = num(prof, d.id) ?? d.def;
    return out;
  }
  function get(mode: string, id: string): number {
    const d = DEF_BY_ID.get(id);
    if (!d) return 0;
    const layers = [scopedMode("track", mode), scopedMode("car", mode), _store[mode], _global];
    for (const layer of layers) { const v = num(layer, id); if (layer && v !== undefined) return v; }
    return d.def;
  }
  function getModeOnly(mode: string, id: string): number {
    const d = DEF_BY_ID.get(id);
    if (!d) return 0;
    return num(_store[mode], id) ?? d.def;
  }
  function getGlobal(id: string): number {
    const d = DEF_BY_ID.get(id);
    if (!d) return 0;
    return num(_global, id) ?? d.def;
  }
  function stored(mode: string, id: string): boolean {
    return num(_store[mode], id) !== undefined;
  }
  function storedGlobal(id: string): boolean { return num(_global, id) !== undefined; }
  function getScoped(scope: Scope, mode: string, id: string): number {
    const d = DEF_BY_ID.get(id), prof = scopedMode(scope, mode);
    if (!d) return 0;
    return num(prof, id) ?? d.def;
  }
  function storedScoped(scope: Scope, mode: string, id: string): boolean {
    return num(scopedMode(scope, mode), id) !== undefined;
  }

  // Resolved chase/far/drone corner lead: null = use the rig's shipped default.
  function cornerLead(mode: string): number | null {
    if (mode !== "chase" && mode !== "far" && mode !== "drone") return null;
    if (storedScoped("track", mode, "cornerLead") || storedScoped("car", mode, "cornerLead")
        || stored(mode, "cornerLead") || storedGlobal("cornerLead")) return clamp(get(mode, "cornerLead"), 0, 1);
    return null;
  }

  // null = shipped hang (1). 0 is a real "don't swing" and must not collapse
  // back to 1 the way an unstored key does.
  function cornerHang(mode: string): number | null {
    const d = DEF_BY_ID.get("cornerHang");
    if (!d || !d.modes || d.modes.indexOf(mode) < 0) return null;
    if (storedScoped("track", mode, "cornerHang") || storedScoped("car", mode, "cornerHang")
        || stored(mode, "cornerHang") || storedGlobal("cornerHang")) return clamp(get(mode, "cornerHang"), d.min, d.max);
    return null;
  }

  function exportEdits(): ModesMap {
    const out: ModesMap = {};
    for (const mode of keys(_store)) {
      const prof = _store[mode];
      if (prof && keys(prof).length) out[mode] = { ...prof };
    }
    return out;
  }
  function exportGlobal(): Prof {
    return keys(_global).length ? { ..._global } : {};
  }
  function exportScopes(src: ScopeMap): ScopeMap {
    const out: ScopeMap = {};
    for (const key of keys(src)) {
      const entry = src[key];
      if (!entry) continue;
      const modes: ModesMap = {};
      for (const mode of keys(entry.modes || {})) modes[mode] = { ...entry.modes[mode] };
      const comfort = { ...(entry.comfort || {}) };
      if (keys(modes).length || keys(comfort).length) out[key] = { modes, comfort };
    }
    return out;
  }
  function exportPack(): CamPack {
    const modes = exportEdits();
    const global = exportGlobal();
    const comfort = sanitizeComfort(_comfort);   // only non-defaults
    const tracks = exportScopes(_tracks);
    const cars = exportScopes(_cars);
    const pack: CamPack = { v: 1 };
    if (keys(modes).length) pack.modes = modes;
    if (keys(global).length) pack.global = global;
    if (keys(comfort).length) pack.comfort = comfort;
    if (keys(tracks).length) pack.tracks = tracks;
    if (keys(cars).length) pack.cars = cars;
    return pack;
  }

  // How many knobs this mode has moved off default (drives the panel's "(3 tuned)").
  function count(mode: string): number { const p = _store[mode]; return p ? keys(p).length : 0; }
  function countGlobal(): number { return keys(_global).length; }
  function countScoped(scope: Scope, mode?: string | null): number {
    const entry = scopeEntry(scope, false);
    if (!entry) return 0;
    return mode ? keys(entry.modes[mode] || {}).length : keys(entry.comfort || {}).length;
  }
  function tunedModes(): string[] { return keys(_store).filter((m) => count(m) > 0); }

  function set(mode: string, id: string, v: unknown): boolean {
    const d = DEF_BY_ID.get(id);
    if (!d || !mode || mode === GLOBAL_MODE || typeof v !== "number" || !isFinite(v)) return false;
    const c = clamp(v, d.min, d.max);
    const prof = _store[mode] || (_store[mode] = {});
    prof[id] = c;
    if (!keys(prof).length) delete _store[mode];
    return true;
  }
  function setGlobal(id: string, v: unknown): boolean {
    const d = DEF_BY_ID.get(id);
    if (!d || typeof v !== "number" || !isFinite(v)) return false;
    const c = clamp(v, d.min, d.max);
    if (c === d.def) delete _global[id]; else _global[id] = c;
    return true;
  }
  function setScoped(scope: Scope, mode: string, id: string, v: unknown): boolean {
    const d = DEF_BY_ID.get(id);
    if (!d || !mode || typeof v !== "number" || !isFinite(v) || !scopeMap(scope) || !scopeKey(scope)) return false;
    const entry = scopeEntry(scope, true);
    if (!entry) return false;
    const prof = entry.modes[mode] || (entry.modes[mode] = {});
    prof[id] = clamp(v, d.min, d.max);   // explicit defaults override a lower layer
    return true;
  }
  function reset(mode: string): void { log.info("CamTune.reset " + mode); delete _store[mode]; }
  function resetGlobal(): void { log.info("CamTune.resetGlobal"); _global = {}; }
  function resetScoped(scope: Scope, mode?: string | null): void {
    const entry = scopeEntry(scope, false);
    if (!entry) return;
    if (mode) delete entry.modes[mode];
    else { entry.modes = {}; entry.comfort = {}; }
    pruneScope(scope);
  }
  function resetAll(): void {
    log.info("CamTune.resetAll");
    _store = {}; _global = {}; _comfort = {}; _tracks = {}; _cars = {};
  }

  function comfortGet(id: string): number {
    const d = COMFORT_BY_ID.get(id);
    if (!d) return 0;
    const track = scopeEntry("track", false), car = scopeEntry("car", false);
    const t = num(track?.comfort, id);
    if (track && t !== undefined) return t;
    const c = num(car?.comfort, id);
    if (car && c !== undefined) return c;
    return num(_comfort, id) ?? d.def;
  }
  function comfortGetGlobal(id: string): number {
    const d = COMFORT_BY_ID.get(id);
    if (!d) return 0;
    return num(_comfort, id) ?? d.def;
  }
  function comfortSet(id: string, v: unknown): boolean {
    const d = COMFORT_BY_ID.get(id);
    if (!d || typeof v !== "number" || !isFinite(v)) return false;
    const c = clamp(v, d.min, d.max);
    if (c === d.def) delete _comfort[id]; else _comfort[id] = c;
    return true;
  }
  function comfortGetScoped(scope: Scope, id: string): number {
    const d = COMFORT_BY_ID.get(id), entry = scopeEntry(scope, false);
    if (!d) return 0;
    return num(entry?.comfort, id) ?? d.def;
  }
  function comfortSetScoped(scope: Scope, id: string, v: unknown): boolean {
    const d = COMFORT_BY_ID.get(id);
    if (!d || typeof v !== "number" || !isFinite(v) || !scopeMap(scope) || !scopeKey(scope)) return false;
    const entry = scopeEntry(scope, true);
    if (!entry) return false;
    entry.comfort[id] = clamp(v, d.min, d.max);   // explicit defaults override a lower layer
    return true;
  }
  function fovBias(): number { return comfortGet("fovBias"); }
  function speedFov(): number { return comfortGet("speedFov"); }
  function bob(): number { return comfortGet("bob"); }
  function rollLean(): number { return comfortGet("rollLean"); }

  // Thin helpers game.js calls — keep camComfort() as the hard reduce-motion gate.
  function shakeOffset(shake: number, reduceMotion: boolean): number {
    if (reduceMotion) return 0;
    return shake * shake * 0.9 * bob();
  }
  function buzzAmp(spV: number, deploying: boolean, reduceMotion: boolean, wet: number): number {
    if (reduceMotion) return 0;
    return (spV * spV * 0.022 + (deploying ? 0.008 : 0)) * wet * bob();
  }
  function rollTarget(roadCamRoll: number, slipSm: number, baRoll: number, reduceMotion: boolean): number {
    if (reduceMotion) return 0;
    return (roadCamRoll + slipSm * 0.16 + baRoll) * rollLean();
  }

  function copyFrom(srcMode: string, dstMode: string): boolean {
    if (!srcMode || !dstMode || srcMode === dstMode) return false;
    const src = _store[srcMode];
    if (!src || !keys(src).length) {
      delete _store[dstMode];
      return true;
    }
    _store[dstMode] = { ...src };
    return true;
  }
  function applyToAllModes(srcMode: string): number {
    if (!srcMode) return 0;
    const cur = _store[srcMode];
    const src = cur ? { ...cur } : null;
    let n = 0;
    const modes = deps.modeIds ? deps.modeIds() : keys(_store);
    for (const m of modes) {
      if (m === srcMode || m === GLOBAL_MODE) continue;
      if (!src) delete _store[m];
      else _store[m] = { ...src };
      n++;
    }
    return n;
  }

  function applyPreset(id: string): boolean {
    const p = Object.prototype.hasOwnProperty.call(PRESETS, id) ? PRESETS[id] : undefined;
    if (!p) return false;
    log.info("CamTune.applyPreset " + id);
    if (p.modes === null) _store = {};
    else if (p.modes) {
      _store = {};
      for (const m of keys(p.modes)) {
        const prof = sanitizeProf(p.modes[m], true);
        if (keys(prof).length) _store[m] = prof;
      }
    }
    if (p.global === null) _global = {};
    else if (p.global) _global = sanitizeProf(p.global);
    if (p.comfort === null) _comfort = {};
    else if (p.comfort) _comfort = sanitizeComfort(p.comfort);
    if (id === "stock") { _tracks = {}; _cars = {}; }
    return true;
  }

  function importModes(raw: unknown): number {
    const next = sanitize(raw);
    _store = next;
    return keys(next).length;
  }
  function importGlobal(raw: unknown): number {
    _global = sanitizeProf(raw);
    return keys(_global).length;
  }
  function importComfort(raw: unknown): number {
    _comfort = sanitizeComfort(raw);
    return keys(_comfort).length;
  }
  function importTracks(raw: unknown): number {
    _tracks = sanitizeScopes(raw);
    return keys(_tracks).length;
  }
  function importCars(raw: unknown): number {
    _cars = sanitizeScopes(raw);
    return keys(_cars).length;
  }

  // Accept a pack, a legacy CameraEdits object, or a bare modes map.
  function importPack(raw: unknown): ImportResult {
    if (!isObj(raw)) return { ok: false, reason: "not an object" };
    if (raw["v"] === 1 || raw["v"] === 2 || raw["modes"] || raw["global"] || raw["comfort"] || raw["tracks"] || raw["cars"]) {
      // A pack is authoritative for every camera-tuner store.
      return { ok: true, modes: importModes(raw["modes"] || {}), global: importGlobal(raw["global"] || {}),
        comfort: importComfort(raw["comfort"] || {}), tracks: importTracks(raw["tracks"] || {}), cars: importCars(raw["cars"] || {}) };
    }
    // Legacy window.CameraEdits = { chase: {...}, ... } or a modes-only map: it says
    // nothing about the GLOBAL baseline or the COMFORT (accessibility) knobs, so it
    // must not wipe them.
    return { ok: true, modes: importModes(raw), global: countGlobal(), comfort: keys(_comfort).length,
      tracks: keys(_tracks).length, cars: keys(_cars).length };
  }

  function encodeShare(pack?: unknown): string {
    const body = JSON.stringify(pack && typeof pack === "object" ? pack : exportPack());
    return SHARE_MAGIC + "." + b64urlEncode(body);
  }
  function decodeShare(text: unknown): DecodeResult {
    if (typeof text !== "string") return { ok: false, reason: "not a string" };
    const t = text.trim();
    if (!t) return { ok: false, reason: "empty" };
    // Share code: bare, or the last line of the COPY VALUES block (CameraEdits +
    // comments + pack JSON + code), so the token is looked for anywhere in the paste.
    const sc = /(?:^|\s)APXC1\.([A-Za-z0-9_-]+)/.exec(t);
    if (sc) {
      try {
        const json = b64urlDecode(sc[1] ?? "");
        const obj: unknown = JSON.parse(json);
        return { ok: true, pack: obj, kind: "share" };
      } catch {
        return { ok: false, reason: "bad share code" };
      }
    }
    // window.CameraEdits = {...};  or bare JSON
    let json = t;
    const m = /CameraEdits\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(t);
    if (m) json = m[1] ?? "";
    try {
      const obj: unknown = JSON.parse(json);
      return { ok: true, pack: obj, kind: m ? "edits" : "json" };
    } catch {
      return { ok: false, reason: "not JSON or APXC1 share code" };
    }
  }
  function importText(text: unknown): ImportTextResult {
    const dec = decodeShare(text);
    if (!dec.ok) return dec;
    const r = importPack(dec.pack);
    if (!r.ok) return r;
    return { ok: true, kind: dec.kind, modes: r.modes, global: r.global, comfort: r.comfort,
      tracks: r.tracks, cars: r.cars };
  }

  /** Offsets the solved rig in place (eye/tgt mutated) and returns the tuned FOV in degrees (offsets.js:625-666). */
  function apply(mode: string, eye: Vec3, tgt: Vec3, fov: number): number {
    const prof = mergedProf(mode);
    const bias = fovBias();
    if (!prof && !bias) return fov;
    const h = (prof && prof["height"]) || 0, d = (prof && prof["dist"]) || 0, sd = (prof && prof["side"]) || 0;
    const pi = (prof && prof["pitch"]) || 0, ya = (prof && prof["yaw"]) || 0;
    const fo = ((prof && prof["fov"]) || 0) + bias;
    // Horizontal view direction, and the right vector perpendicular to it.
    // RIGHT of forward (fx, fz) in this Y-up world is (-fz, fx) — measured:
    // (fz, -fx) dotted against the track's own right vector reads -0.99, i.e.
    // it is the LEFT vector. This code shipped with (fz, -fx) copied from a
    // mislabelled physics comment, so the SIDE knob moved the eye LEFT while
    // its help text said right (and YAW panned left, below).
    if (h || d || sd || ya || pi) {
      let fx = tgt[0] - eye[0], fz = tgt[2] - eye[2];
      let fl = Math.hypot(fx, fz);
      if (fl < 1e-4) { fx = 0; fz = 1; fl = 1; }   // straight-down aim (overhead): fall back to +Z
      fx /= fl; fz /= fl;
      const rx = -fz, rz = fx;
      if (h || d || sd) {
        eye[0] += -fx * d + rx * sd;
        eye[1] += h;
        eye[2] += -fz * d + rz * sd;
      }
      if (ya || pi) {
        let dx = tgt[0] - eye[0], dy = tgt[1] - eye[1], dz = tgt[2] - eye[2];
        if (ya) {
          const c = Math.cos(ya * DEG), s = Math.sin(ya * DEG);
          const nx = dx * c - dz * s, nz = dz * c + dx * s;
          dx = nx; dz = nz;
        }
        if (pi) {
          const L = Math.hypot(dx, dz), len = Math.hypot(L, dy) || 1;
          const el = clamp(Math.atan2(dy, L) + pi * DEG, -1.45, 1.45);
          const nl = Math.cos(el) * len;
          dy = Math.sin(el) * len;
          if (L > 1e-6) { const k = nl / L; dx *= k; dz *= k; }
          else { dx = fx * nl; dz = fz * nl; }   // was aiming straight up/down — re-seat on the view axis
        }
        tgt[0] = eye[0] + dx; tgt[1] = eye[1] + dy; tgt[2] = eye[2] + dz;
      }
    }
    return fo ? clamp(fov + fo, FOV_MIN, FOV_MAX) : fov;
  }

  return Object.freeze({ CAM_TUNE_DEFS, COMFORT_DEFS, PRESETS, FOV_MIN, FOV_MAX, GLOBAL_MODE, SHARE_MAGIC,
    KEY, KEY_GLOBAL, KEY_COMFORT, KEY_TRACK, KEY_CAR,
    apply, values, get, getModeOnly, getGlobal, getScoped, stored, storedGlobal, storedScoped, cornerLead, cornerHang,
    exportEdits, exportGlobal, exportPack,
    set, setGlobal, setScoped, reset, resetGlobal, resetScoped, resetAll,
    count, countGlobal, countScoped, tunedModes, load, loadGlobal, loadComfort, loadTrack, loadCar, persist,
    setContext, context, comfortGet, comfortGetGlobal, comfortSet, comfortGetScoped, comfortSetScoped, fovBias, speedFov, bob, rollLean,
    shakeOffset, buzzAmp, rollTarget,
    copyFrom, applyToAllModes, applyPreset,
    importModes, importGlobal, importComfort, importTracks, importCars, importPack, importText,
    encodeShare, decodeShare,
    defs: (): readonly TuneDef[] => CAM_TUNE_DEFS, comfortDefs: (): readonly TuneDef[] => COMFORT_DEFS,
    presets: (): Readonly<Record<string, Preset>> => PRESETS });
}

export { KEY, KEY_GLOBAL, KEY_COMFORT, KEY_TRACK, KEY_CAR, GLOBAL_MODE };
