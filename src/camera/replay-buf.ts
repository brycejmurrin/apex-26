/* Apex 26 — INSTANT REPLAY RING (createReplayBuf(host)): a solo-only 20 s /
 * 30 Hz Float32 ring of the live field (~0.5 MB / 24 cars, under a 0.7 MB cap). Pause-card scrub
 * restores captured pose fields bit-exactly and never touches netplay authority
 * or career settlement. RAM only — never writes the Ghost best-lap store
 * (512 KiB budget). Sampling mirrors Ghost's cadence; tags come from car
 * status edges and RaceInsights-shaped pushTag calls. A scrub never blends
 * across a timeline BREAK (breakTimeline(), e.g. a red-flag re-grid) or across
 * one car's teleport (> JUMP_M beyond what its speed covers): it snaps to the
 * nearer real sample instead.
 *
 * Ported verbatim from f1-game js/camera/replay-buf.js:1-554 (ReplayBuf),
 * typed-array rings unchanged (Float64Array times, Float32Array poses,
 * Uint8Array status + break lanes). The IIFE becomes module functions +
 * `createReplayBuf(host, eligible, deps)`. Ambient globals are injected:
 *   G                         → host (ReplayHost), read live
 *   GameAudio.syncReplayRpms  → deps.audio TODO(lane-audio)            replay-buf.js:259
 *   CamFeel.reset*            → deps.feel (src/camera/feel.ts)          :314, :384
 *   GameCams.resetSmoothing   → deps.gameCams TODO(lane-shell): vantage.js  :315, :385
 *   PhotoStudio               → deps.photo TODO(lane-shell): js/ui/photo-studio.js  :359-397
 *   document                  → deps.doc (pause-card REPLAY door + scrub dock) :401-528
 *   Log.warn                  → src/data/log.ts
 * The module-level audioStatus WeakMap stays module state (audioRetired is
 * read by the audio lane per car), as replay-buf.js:13-18 keeps it. */
import { log } from "../data/log";

// Audio presentation only: live retirement/classification remains authoritative.
interface AudioOwner { valid(): boolean; release(): void }
const audioStatus = new WeakMap<object, { owner: AudioOwner; retired: boolean }>();
/** The retirement the audio should voice for `car`: the replayed one while a scrub poses it. */
export function audioRetired(car: object & { retired?: boolean }): boolean {
  let entry = audioStatus.get(car);
  if (entry && !entry.owner.valid()) { entry.owner.release(); entry = audioStatus.get(car); }
  return entry ? entry.retired : !!car.retired;
}
export const HZ = 30;
export const WINDOW_S = 20;
export const MAX_FRAMES = HZ * WINDOW_S;           // 600
export const FLOATS = 9;                           // s, x, yaw, speed, px, py, pz, steer, yawVis
export const MAX_CARS = 24;                        // MY TEAM / LEGENDS grids run 23-24 cars
export const MAX_BYTES = 720 * 1024;               // 0.7 MB hard cap
export const TAG_CAP = 64;
export const JUMP_M = 50;                          // pose jump past speed*dt that no car drives: a teleport
export const RATES: readonly number[] = Object.freeze([0.25, 0.5, 1]);
export const POSE_FIELDS = Object.freeze(["s", "x", "head", "speed", "px", "py", "pz", "steer", "yawVis",
  "rPrevS", "rPrevX", "rPrevPx", "rPrevPz", "rPrevHead", "rPrevYawVis"] as const);
export type PoseField = typeof POSE_FIELDS[number];

export function frameBytes(nCars: number): number {
  return nCars * FLOATS * 4 + nCars + 1;    // floats + Uint8 status lane + segment-break flag
}
export function budgetOk(nCars: number, frames: number): boolean {
  return frameBytes(nCars) * frames <= MAX_BYTES;
}
/** Largest frame count that fits under MAX_BYTES for nCars (≤ MAX_FRAMES). */
export function capacityFor(nCars: number): number {
  const n = Math.max(1, Math.min(MAX_CARS, nCars | 0));
  let frames = MAX_FRAMES;
  while (frames > 8 && !budgetOk(n, frames)) frames = (frames * 3 / 4) | 0;
  return frames;
}

type FloatLane = Float32Array | number[];

// Pure: interpolate one car's floats between two frames (Ghost.at shape).
// `L` (the lap length, track.total) makes arc `s` wrap-aware: a car
// crossing the line goes L-1.3 -> 1.37, and a plain lerp swept it (and the
// camera on it) through the whole lap the other way in one sample. Without L
// (or L <= 0) `s` lerps plainly, as before.
export function lerpCar<O extends FloatLane>(out: O, a: ArrayLike<number>, b: ArrayLike<number>, u: number, L?: number): O {
  for (let i = 0; i < FLOATS; i++) out[i] = (a[i] as number) + ((b[i] as number) - (a[i] as number)) * u;
  if ((L as number) > 0) {
    const Lv = L as number;
    let ds = (b[0] as number) - (a[0] as number);
    if (ds > Lv * 0.5) ds -= Lv; else if (ds < -Lv * 0.5) ds += Lv;   // M4.wrapDelta, inlined: the ring is dependency-free
    let s = (a[0] as number) + ds * u;
    if (s < 0) s += Lv; else if (s >= Lv) s -= Lv;
    out[0] = s;
  }
  // Heading (2) and mesh yaw (8), without allocating per sampled car.
  for (let i = 2; i <= 8; i += 6) {
    let delta = (b[i] as number) - (a[i] as number);
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    out[i] = (a[i] as number) + delta * u;
  }
  return out;
}

/** A car's recorded pose fields (replay-buf.js:126-138, :246-258). */
export interface ReplayCar {
  s?: number; x?: number; head?: number; speed?: number;
  px?: number; py?: number; pz?: number; steer?: number; yawVis?: number;
  rPrevS?: number; rPrevX?: number; rPrevPx?: number; rPrevPz?: number; rPrevHead?: number; rPrevYawVis?: number;
  retired?: boolean;
  finished?: boolean;
}

/** One replayed car (replay-buf.js:223-227). `status`: bit 1 retired, bit 2 finished. */
export interface ReplayPose {
  s: number; x: number; head: number; speed: number;
  px: number; py: number; pz: number; steer: number; yawVis: number;
  status: number;
}
export interface ReplayTag { kind: string; t: number; car: number }
export interface ReplayWindow { t0: number; t1: number; frames: number; bytes: number; cars: number }
export interface ReplayStatus extends ReplayWindow {
  scrubbing: boolean; scrubT: number; scrubRate: number; scrubPlaying: boolean; tags: number;
}

/** The G members the ring reads (replay-buf.js:70-545). TODO(lane-shell): the app binds it. */
export interface ReplayHost<C extends ReplayCar = ReplayCar> {
  cars?: C[] | null;
  netPlay?: { active?(): boolean } | null;
  track?: { readonly total?: number } | null;
  raceT?: number;
  paused?: boolean;
  photoMode?: boolean;
  dbgCam?: unknown;
  snapGameCam?(): void;
  camMode?: number;
  player?: unknown;
  photoCam?: { pos: unknown; yaw: unknown; pitch: unknown; fov: unknown } | null;
}

/** TODO(lane-shell): js/ui/photo-studio.js, the contact-sheet renderer. */
export interface PhotoStudioLike {
  contactSheet(times: number[], seek: (t: number) => void, cancelled: () => boolean): Promise<boolean>;
  state?(): { open: unknown; generation: unknown };
}

export interface ReplayDeps {
  /** GameAudio.syncReplayRpms (replay-buf.js:259). TODO(lane-audio). */
  readonly audio?: { syncReplayRpms?(cars: ReplayCar[]): void } | null;
  readonly feel?: { resetFollow(): void; resetFreeLook?(): void; resetLatch?(): void } | null;
  /** GameCams.resetSmoothing (replay-buf.js:315, :385). TODO(lane-shell). */
  readonly gameCams?: { resetSmoothing(): void } | null;
  readonly photo?: PhotoStudioLike | null;
  /** Where the REPLAY door and dock live; null = no DOM. Default: the global document. */
  readonly doc?: Document | null;
}

export type ReplayBuf = ReturnType<typeof createReplayBuf>;

// The caller can reserve pose ownership (for example, a recorded WATCH).
export function createReplayBuf<C extends ReplayCar>(G: ReplayHost<C>, eligible?: (() => boolean) | null, deps: ReplayDeps = {}) {
  const doc: Document | null = deps.doc !== undefined ? deps.doc : (typeof document !== "undefined" ? document : null);
  let audioCars: C[] | null = null;
  const audioOwner: AudioOwner = {
    valid: () => !!audioCars && !!G.cars && G.cars.length === audioCars.length && audioCars.every((c, i) => G.cars![i] === c),
    release: () => {
      if (audioCars) for (const c of audioCars) {
        const entry = audioStatus.get(c);
        if (entry && entry.owner === audioOwner) audioStatus.delete(c);
      }
      audioCars = null;
    },
  };
  const allowed = (): boolean => (!eligible || eligible()) && !(G.netPlay && G.netPlay.active && G.netPlay.active());
  let nCars = 0, cap = 0, head = 0, count = 0, lastSlot = -1;
  let times: Float64Array | null = null, data: Float32Array | null = null, status: Uint8Array | null = null, brk: Uint8Array | null = null, breakPending = false;
  let tags: ReplayTag[] = [], tagPicker: HTMLSelectElement | null = null, tagOptionsKey: string | null = null;
  let scrubbing = false, liveSnap: Array<Partial<Record<PoseField, unknown>>> | null = null;
  let scrubT = 0, scrubRate = 1, scrubPlaying = true;
  let prevStatus: Uint8Array | null = null, sheetBusy = false, sheetGeneration = 0, sheetCancelled = false;

  function alloc(n: number): void {
    nCars = Math.max(1, Math.min(MAX_CARS, n | 0));
    cap = capacityFor(nCars);
    times = new Float64Array(cap);
    data = new Float32Array(cap * nCars * FLOATS);
    status = new Uint8Array(cap * nCars);
    brk = new Uint8Array(cap);   // brk[f] = 1: frame f opens a new segment, never blended from the one before
    head = 0; count = 0; lastSlot = -1; tags = [];
    prevStatus = new Uint8Array(nCars);
  }
  function clear(): void {
    sheetGeneration++; sheetBusy = false;
    head = 0; count = 0; lastSlot = -1; tags = []; breakPending = false;
    scrubbing = false; liveSnap = null; scrubPlaying = true; scrubRate = 1;
    // prevStatus survives: a car already out when the timeline is discarded is not a fresh retirement (alloc() zeroes it).
    audioOwner.release();
    hideDock();
  }
  function reset(cars?: ReadonlyArray<C> | null): void {
    alloc((cars && cars.length) || (G.cars && G.cars.length) || 1);
    clear();
  }
  function discardTimeline(time: number | undefined): void {
    if (!count || !Number.isFinite(time)) return;
    const newest = times![(head + count - 1) % cap] as number;
    if ((time as number) < newest || (time as number) - newest > WINDOW_S) clear();
  }
  /** Explicit timeline break that keeps the history: the next recorded frame
   *  opens a new segment and at() never interpolates into it. For a re-grid
   *  with the clock unchanged (red-flag restart), which the time heuristics
   *  above cannot see. Deliberately untagged: every tag becomes a results
   *  highlight clip, and one straddling the break would show the cut. */
  function breakTimeline(): void {
    if (count) breakPending = true;
  }
  function writeCar(frame: number, i: number, c: C): void {
    const d = data!;
    const o = (frame * nCars + i) * FLOATS;
    d[o] = c.s || 0;
    d[o + 1] = c.x || 0;
    d[o + 2] = c.head || 0;
    d[o + 3] = c.speed || 0;
    d[o + 4] = c.px || 0;
    d[o + 5] = c.py || 0;
    d[o + 6] = c.pz || 0;
    d[o + 7] = c.steer || 0;
    d[o + 8] = c.yawVis || 0;
    status![frame * nCars + i] = (c.retired ? 1 : 0) | (c.finished ? 2 : 0);
  }
  function readCar(out: Float32Array, frame: number, i: number): Float32Array {
    const d = data!;
    const o = (frame * nCars + i) * FLOATS;
    for (let k = 0; k < FLOATS; k++) out[k] = d[o + k] as number;
    return out;
  }
  function sample(raceT: number, cars: ReadonlyArray<C> | null | undefined): boolean {
    if (scrubbing || !allowed()) return false;
    if (!cars || !cars.length) return false;
    if (!data || Math.min(MAX_CARS, cars.length) !== nCars) reset(cars);   // >MAX_CARS must not reset every sample
    discardTimeline(raceT);   // Practice rewind or a mid-race JUMP IN starts a new timeline.
    // Slot gate (not wall-delta): FP-safe at exact 1/HZ spacing.
    const slot = Math.floor((+raceT || 0) * HZ);
    if (slot === lastSlot) return false;
    lastSlot = slot;
    const frame = count < cap ? count : head;
    times![frame] = raceT;
    brk![frame] = breakPending ? 1 : 0;
    breakPending = false;
    const n = Math.min(nCars, cars.length);
    for (let i = 0; i < n; i++) {
      writeCar(frame, i, cars[i] as C);
      const st = status![frame * nCars + i] as number;
      const prev = prevStatus![i] as number;
      if ((st & 1) && !(prev & 1)) pushTag("retirement", raceT, i);
      else if ((st & 2) && !(prev & 2)) pushTag("chequered", raceT, i);
      prevStatus![i] = st;
    }
    if (count < cap) count++;
    else head = (head + 1) % cap;
    return true;
  }
  function pushTag(kind: unknown, t: unknown, carIdx: unknown): void {
    if (tags.length >= TAG_CAP) tags.shift();
    tags.push({ kind: String(kind || ""), t: +(t as number) || 0, car: (carIdx as number) | 0 });
  }
  function windowInfo(): ReplayWindow {
    if (!count) return { t0: 0, t1: 0, frames: 0, bytes: 0, cars: nCars };
    const oldest = times![head] as number;
    const newest = times![(head + count - 1) % cap] as number;
    return {
      t0: oldest, t1: newest, frames: count, cars: nCars,
      bytes: frameBytes(nCars) * count,
    };
  }
  function frameIndexAt(t: number): number {
    let best = -1, bestT = -Infinity;
    for (let k = 0; k < count; k++) {
      const i = (head + k) % cap;
      const ti = times![i] as number;
      if (ti <= t && ti >= bestT) { bestT = ti; best = i; }
    }
    return best;
  }
  const _a = new Float32Array(FLOATS), _b = new Float32Array(FLOATS), _o = new Float32Array(FLOATS);
  function at(t: number): { t: number; cars: ReplayPose[] } | null {
    if (!count) return null;
    const w = windowInfo();
    const tt = Math.max(w.t0, Math.min(w.t1, t));
    let i0 = frameIndexAt(tt);
    if (i0 < 0) i0 = head;
    let i1 = i0, u = 0;
    for (let k = 0; k < count - 1; k++) {
      const i = (head + k) % cap;
      if (i === i0) { i1 = (head + k + 1) % cap; break; }
    }
    const t0 = times![i0] as number, t1 = times![i1] as number;
    if (i1 !== i0 && t1 > t0) u = (tt - t0) / (t1 - t0);
    // Across a break or a teleport there is no motion to blend: snap to the
    // nearer real sample (ties keep the earlier one).
    const snapU = u > 0.5 ? 1 : 0, cut = i1 !== i0 && brk![i1] === 1;
    const cars: ReplayPose[] = [], L = (G.track && G.track.total) || 0;
    for (let c = 0; c < nCars; c++) {
      readCar(_a, i0, c);
      readCar(_b, i1, c);
      let snap = cut;
      if (!cut && i1 !== i0) {
        // Per-car teleport (RECOVER, an AI rescue, a debug jump): a world-space
        // step past anything its recorded speed covers in the gap. Never
        // clears the ring — the crash that led to a RECOVER stays watchable.
        const reach = JUMP_M + Math.max(Math.abs(_a[3] as number), Math.abs(_b[3] as number)) * Math.max(0, t1 - t0);
        snap = Math.hypot((_b[4] as number) - (_a[4] as number), (_b[6] as number) - (_a[6] as number)) > reach;
      }
      if (snap) _o.set(snapU ? _b : _a);   // the recorded floats, bit-exact
      else lerpCar(_o, _a, _b, u, L);
      cars.push({
        s: _o[0] as number, x: _o[1] as number, head: _o[2] as number, speed: _o[3] as number,
        px: _o[4] as number, py: _o[5] as number, pz: _o[6] as number, steer: _o[7] as number, yawVis: _o[8] as number,
        status: status![(snap && snapU ? i1 : i0) * nCars + c] as number,
      });
    }
    return { t: tt, cars };
  }
  const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
  function snapLive(cars: ReadonlyArray<C> | null | undefined): Array<Partial<Record<PoseField, unknown>>> {
    return (cars || []).map((c) => {
      const p: Partial<Record<PoseField, unknown>> = {};
      for (const k of POSE_FIELDS) if (own(c, k)) p[k] = (c as Record<PoseField, unknown>)[k];
      return p;
    });
  }
  function restoreLive(cars: C[], poses: ReadonlyArray<Partial<Record<PoseField, unknown>>>): void {
    for (let i = 0; i < Math.min(cars.length, poses.length); i++) {
      const c = cars[i] as Record<PoseField, unknown>, p = poses[i] as Partial<Record<PoseField, unknown>>;
      for (const k of POSE_FIELDS) {
        if (own(p, k)) c[k] = p[k];
        else delete (c as Partial<Record<PoseField, unknown>>)[k];
      }
    }
  }
  function applyPose(cars: C[], poses: ReadonlyArray<ReplayPose>): void {
    const n = Math.min(cars.length, poses.length);
    for (let i = 0; i < n; i++) {
      const c = cars[i] as C, p = poses[i] as ReplayPose;
      c.s = p.s; c.x = p.x; c.head = p.head; c.speed = p.speed;
      c.px = p.px; c.py = p.py; c.pz = p.pz; c.steer = p.steer;
      // Paused frames retain renderAlpha: both interpolation endpoints must
      // belong to this recorded pose, never the live frame we paused from.
      c.yawVis = p.yawVis;
      c.rPrevS = p.s; c.rPrevX = p.x; c.rPrevPx = p.px; c.rPrevPz = p.pz;
      c.rPrevHead = p.head; c.rPrevYawVis = p.yawVis;
      audioStatus.set(c, { owner: audioOwner, retired: !!(p.status & 1) });
    }
    if (deps.audio && deps.audio.syncReplayRpms) deps.audio.syncReplayRpms(cars);   // revs follow the replayed speed
  }
  function beginScrub(showControls = true): boolean {
    if (!allowed()) return false;
    if (!scrubbing) discardTimeline(G.raceT);   // a paused clock jump can precede the next sample
    if (scrubbing || count < 2) return false;
    liveSnap = snapLive(G.cars);
    audioCars = G.cars!.slice();
    scrubbing = true;
    scrubPlaying = true;
    scrubRate = 1;
    const w = windowInfo();
    const last = lastTag();
    scrubT = (last && last.t >= w.t0 && last.t <= w.t1) ? last.t : Math.max(w.t0, w.t1 - 5);
    apply(scrubT);
    if (showControls) { showDock(); paintDock(); }
    return true;
  }
  function snapCamera(): void {
    // Photo/tools and results/director shots own dbgCam; a scrub must not
    // reseed their camera or clear their look state. The live rig uses the
    // same complete reset as WATCH seeks (including its outer anchor).
    if (!G.photoMode && !G.dbgCam && G.snapGameCam) G.snapGameCam();
  }
  function apply(t: number, continuous = false): boolean {
    if (!scrubbing) return false;
    // Indexed footage belongs to the captured field, never replacement cars.
    if (!audioOwner.valid()) { audioOwner.release(); return false; }
    const snap = at(t);
    if (!snap || !G.cars) return false;
    scrubT = snap.t;
    applyPose(G.cars, snap.cars);
    if (!continuous) snapCamera();   // public apply / slider / LAST are seeks
    return true;
  }
  // Pick recorded timestamps, not +/-1/HZ: a slow frame may skip samples.
  function adjacentFrame(t: number, direction: number): number | null {
    if (!count || (direction !== -1 && direction !== 1)) return null;
    let found: number | null = null;
    for (let k = 0; k < count; k++) {
      const time = times![(head + k) % cap] as number;
      if (direction < 0 ? time < t - 1e-9 : time > t + 1e-9) {
        if (found === null || (direction < 0 ? time > found : time < found)) found = time;
      }
    }
    return found;
  }
  function stepFrame(direction: number): boolean {
    if (!scrubbing || sheetBusy || !allowed() || (direction !== -1 && direction !== 1)) return false;
    scrubPlaying = false;
    const t = adjacentFrame(scrubT, direction);
    if (t === null) { paintDock(); return false; }
    const ok = apply(t);
    if (ok) {
      // A seek is a cut; never ease from the unrelated pre-step framing.
      if (deps.feel) deps.feel.resetFollow();
      if (deps.gameCams) deps.gameCams.resetSmoothing();
    }
    paintDock();
    return ok;
  }
  function endScrub(): boolean {
    sheetGeneration++; sheetBusy = false;
    if (!scrubbing) return false;
    audioOwner.release();
    if (liveSnap && G.cars) restoreLive(G.cars, liveSnap);
    scrubbing = false; liveSnap = null; scrubPlaying = true;
    snapCamera();   // restore the live timeline before the next rendered frame
    hideDock();
    return true;
  }
  function isScrubbing(): boolean { return scrubbing; }
  function lastTag(): ReplayTag | null {
    return tags.length ? tags[tags.length - 1] as ReplayTag : null;
  }
  function tagsOf(): ReplayTag[] {
    return tags.map((g) => ({ kind: g.kind, t: g.t, car: g.car }));
  }
  function jumpLastTag(): boolean {
    const tag = lastTag();
    if (!tag || !scrubbing) return false;
    return apply(tag.t);
  }
  function tickScrub(dt: number): boolean {
    if (!scrubbing) return false;
    if (!sheetBusy && scrubPlaying && dt > 0) {
      const w = windowInfo();
      scrubT = Math.min(w.t1, scrubT + dt * scrubRate);
      apply(scrubT, true);   // playback retains normal rig damping
      if (scrubT >= w.t1) scrubPlaying = false;
    }
    paintDock();
    return true;
  }
  function statusOf(): ReplayStatus {
    return Object.assign({
      scrubbing, scrubT, scrubRate, scrubPlaying, tags: tags.length,
    }, windowInfo());
  }

  async function contactSheet(tagIndex: number): Promise<boolean> {
    const photo = deps.photo;
    if (sheetBusy || !allowed() || !G.paused || !scrubbing || !photo) return false;
    const tag = tags[tagIndex], w = windowInfo();
    if (!tag || tag.t < w.t0 || tag.t > w.t1 || w.t1 - w.t0 < 2 / HZ) return false;
    const moment = Math.max(w.t0, Math.min(w.t1, tag.t));
    const shots = [Math.max(w.t0, moment - 1), moment, Math.min(w.t1, moment + 1)];
    const photoPose = (): string | null => G.photoCam ? JSON.stringify([G.photoCam.pos, G.photoCam.yaw, G.photoCam.pitch, G.photoCam.fov]) : null;
    const debugPose = (): string | null => {
      const d = G.dbgCam as { eye?: unknown; target?: unknown; fov?: unknown; roll?: unknown } | null | undefined;
      return d ? JSON.stringify([d.eye, d.target, d.fov, d.roll]) : null;
    };
    const studioOwner = (): string | null => { if (typeof photo.state !== "function") return null; const state = photo.state(); return JSON.stringify([state.open, state.generation]); };
    const saved = { t: scrubT, playing: scrubPlaying, rate: scrubRate, paused: G.paused, mode: G.camMode,
      dbg: G.dbgCam, player: G.player, photo: G.photoCam, photoMode: G.photoMode,
      photoPose: photoPose(), dbgPose: debugPose(), studio: studioOwner() };
    let ownedT = scrubT;
    const generation = ++sheetGeneration; sheetBusy = true; sheetCancelled = false; scrubPlaying = false; paintDock();
    // Check camera INPUTS/identities, not rendered eye/FOV damping outputs.
    // A user acquiring a camera or moving the scrub owns the newer state.
    const owns = (): boolean => generation === sheetGeneration && scrubbing && allowed() && G.paused === saved.paused &&
      G.camMode === saved.mode && (G.dbgCam === saved.dbg || !!saved.photoMode && debugPose() === saved.dbgPose) && G.player === saved.player && G.photoMode === saved.photoMode &&
      G.photoCam === saved.photo && photoPose() === saved.photoPose && debugPose() === saved.dbgPose && studioOwner() === saved.studio &&
      scrubT === ownedT && !scrubPlaying && scrubRate === saved.rate;
    const cancelled = (): boolean => sheetCancelled || !owns();
    const seek = (t: number): void => {
      if (!owns()) throw new Error("Contact sheet ownership changed");
      if (!apply(t)) throw new Error("Replay frame unavailable");
      ownedT = scrubT;
      if (deps.feel) { deps.feel.resetFollow(); deps.feel.resetFreeLook?.(); deps.feel.resetLatch?.(); }
      if (deps.gameCams) deps.gameCams.resetSmoothing();
    };
    const say = (text: string): void => { if (generation === sheetGeneration && doc) { const el = doc.getElementById("pm-replay-sheet-status"); if (el) el.textContent = text; } };
    say("Capturing before, moment and after…");
    try { const ok = await photo.contactSheet(shots, seek, cancelled); if (cancelled()) return false; say("Contact sheet PNG download requested."); return ok; }
    catch (e) { say(sheetCancelled ? "Capture cancelled." : "Contact sheet unavailable. Try again."); log.warn("Contact sheet failed", e); return false; }
    finally {
      if (owns()) {
        seek(saved.t); scrubPlaying = saved.playing; scrubRate = saved.rate;
      }
      if (generation === sheetGeneration) { sheetBusy = false; paintDock(); }
    }
  }

  function cancelContactSheet(): void { sheetCancelled = true; }

  // Pause-card REPLAY + scrub dock (JS-built — no shell-node growth).
  function ensureButton(): void {
    if (!doc) return;
    if (doc.getElementById("pm-replay")) return;
    const resume = doc.getElementById("pm-resume");
    if (!resume || !resume.parentNode) return;
    const b = doc.createElement("button");
    b.id = "pm-replay";
    b.type = "button";
    b.textContent = "REPLAY";
    b.hidden = true;
    b.onclick = () => {
      if (!beginScrub()) return;
      const menu = doc.getElementById("pausemenu");
      if (menu) menu.hidden = true;
      log.info("ReplayBuf.scrub t=" + scrubT.toFixed(2));
    };
    // First tile of the pause card's RACE TOOLS tray when it exists.
    const tray = doc.getElementById("pm-quick-doors");
    if (tray) tray.insertBefore(b, tray.firstChild);
    else resume.parentNode.insertBefore(b, resume.nextSibling);
  }
  function ensureDock(): HTMLElement | null {
    if (!doc) return null;
    let dock = doc.getElementById("pm-replay-dock");
    if (dock) return dock;
    dock = doc.createElement("div");
    dock.id = "pm-replay-dock";
    dock.hidden = true;
    // Styled by `#pm-replay-dock` in the dialogs CSS (safe-area, wrap, tokens). TODO(lane-shell): port css/dialogs.css.
    dock.setAttribute("role", "group");
    dock.setAttribute("aria-label", "Instant replay");
    dock.innerHTML =
      '<button type="button" id="pm-replay-exit">EXIT</button>' +
      '<button type="button" id="pm-replay-play">PAUSE</button>' +
      '<button type="button" id="pm-replay-last">LAST</button>' +
      '<button type="button" id="pm-replay-prev" aria-label="Previous recorded frame">← FRAME</button>' +
      '<button type="button" id="pm-replay-next" aria-label="Next recorded frame">FRAME →</button>' +
      '<button type="button" id="pm-replay-rate">1×</button>' +
      '<input id="pm-replay-scrub" type="range" min="0" max="1000" value="1000" aria-label="Replay position">' +
      '<span id="pm-replay-label">0.0</span>' +
      '<select id="pm-replay-tag" aria-label="Contact sheet moment"></select>' +
      '<button type="button" id="pm-replay-sheet">CONTACT SHEET PNG</button>' +
      '<button type="button" id="pm-replay-sheet-cancel" hidden>CANCEL CAPTURE</button>' +
      '<span id="pm-replay-sheet-status" role="status"></span>';
    (doc.body || doc.documentElement).appendChild(dock);
    const q = <E extends HTMLElement>(sel: string): E => dock!.querySelector(sel) as E;
    q("#pm-replay-sheet-cancel").onclick = cancelContactSheet;
    q("#pm-replay-sheet").onclick = () => { void contactSheet(+q<HTMLSelectElement>("#pm-replay-tag").value); };
    q("#pm-replay-exit").onclick = () => {
      endScrub();
      const menu = doc.getElementById("pausemenu");
      if (menu && G.paused) menu.hidden = false;
    };
    q("#pm-replay-play").onclick = () => {
      if (sheetBusy) return;
      scrubPlaying = !scrubPlaying;
      paintDock();
    };
    q("#pm-replay-prev").onclick = () => stepFrame(-1);
    q("#pm-replay-next").onclick = () => stepFrame(1);
    q("#pm-replay-last").onclick = () => { if (!sheetBusy) { jumpLastTag(); paintDock(); } };
    q("#pm-replay-rate").onclick = () => {
      if (sheetBusy) return;
      const i = RATES.indexOf(scrubRate);
      scrubRate = RATES[(i + 1) % RATES.length] as number;
      paintDock();
    };
    q<HTMLInputElement>("#pm-replay-scrub").oninput = (ev) => {
      if (sheetBusy) return;
      const w = windowInfo();
      const u = (+(ev.target as HTMLInputElement).value || 0) / 1000;
      scrubPlaying = false;
      apply(w.t0 + (w.t1 - w.t0) * u);
      paintDock();
    };
    return dock;
  }
  function showDock(): void {
    const d = ensureDock();
    if (d) d.hidden = false;
  }
  function hideDock(): void {
    if (!doc) return;
    const d = doc.getElementById("pm-replay-dock");
    if (d) d.hidden = true;
  }
  function paintDock(): void {
    if (!doc || !scrubbing) return;
    const w = windowInfo();
    const play = doc.getElementById("pm-replay-play");
    const rate = doc.getElementById("pm-replay-rate");
    const scrub = doc.getElementById("pm-replay-scrub") as HTMLInputElement | null;
    const label = doc.getElementById("pm-replay-label");
    if (play) play.textContent = scrubPlaying ? "PAUSE" : "PLAY";
    if (rate) rate.textContent = scrubRate + "×";
    if (scrub && w.t1 > w.t0) {
      const u = (scrubT - w.t0) / (w.t1 - w.t0);
      scrub.value = String(Math.round(Math.max(0, Math.min(1, u)) * 1000));
    }
    if (label) label.textContent = scrubT.toFixed(3) + "s";
    const prevFrame = doc.getElementById("pm-replay-prev") as HTMLButtonElement | null, nextFrame = doc.getElementById("pm-replay-next") as HTMLButtonElement | null;
    if (prevFrame) prevFrame.disabled = sheetBusy || adjacentFrame(scrubT, -1) === null;
    if (nextFrame) nextFrame.disabled = sheetBusy || adjacentFrame(scrubT, 1) === null;
    const picker = doc.getElementById("pm-replay-tag") as HTMLSelectElement | null, sheet = doc.getElementById("pm-replay-sheet") as HTMLButtonElement | null;
    if (picker && !sheetBusy) {
      const visible = tags.map((tag, i) => [i, tag] as const).filter(([, tag]) => tag.t >= w.t0 && tag.t <= w.t1);
      const key = JSON.stringify(visible.map(([i, tag]) => [i, tag.kind, tag.t]));
      if (picker !== tagPicker || key !== tagOptionsKey) {
        const selected = picker.value; picker.replaceChildren();
        visible.forEach(([i, tag]) => {
          const option = doc.createElement("option"); option.value = String(i); option.textContent = tag.kind + " · " + tag.t.toFixed(1) + "s"; picker.appendChild(option); });
        if (Array.from(picker.options || picker.children).some((o) => (o as HTMLOptionElement).value === selected)) picker.value = selected;
        tagPicker = picker; tagOptionsKey = key;
      }
    }
    const cancel = doc.getElementById("pm-replay-sheet-cancel"); if (cancel) cancel.hidden = !sheetBusy;
    if (picker) picker.disabled = sheetBusy;
    if (sheet) { sheet.disabled = sheetBusy || !allowed() || !G.paused || !picker || !picker.children.length || w.t1 - w.t0 < 2 / HZ; sheet.textContent = sheetBusy ? "CAPTURING…" : "CONTACT SHEET PNG"; }
    for (const id of ["pm-replay-play", "pm-replay-last", "pm-replay-rate", "pm-replay-scrub"]) { const el = doc.getElementById(id) as HTMLButtonElement | null; if (el) el.disabled = sheetBusy; }
  }
  function refreshButton(): void {
    if (!scrubbing) discardTimeline(G.raceT);
    ensureButton();
    const b = doc ? doc.getElementById("pm-replay") : null;
    if (!b) return;
    const w = windowInfo();
    b.hidden = !allowed() || w.frames < HZ * 3;   // need ~3 s before offering
  }
  /** The loop's call-site helpers — keep the entry thin. */
  function onRaceStart(cars?: ReadonlyArray<C> | null): void { reset(cars); }
  function onTick(raceT: number, cars: ReadonlyArray<C> | null | undefined, st: string): void {
    if (st !== "race" && st !== "count") return;
    sample(raceT, cars);
  }
  function onPause(p: boolean): void {
    if (p) { endScrub(); refreshButton(); }
    else endScrub();
  }

  return {
    sample, clear, breakTimeline, reset, pushTag, window: windowInfo, at,
    beginScrub, apply, endScrub, contactSheet, cancelContactSheet, isScrubbing, lastTag, jumpLastTag, tags: tagsOf,
    tickScrub, stepFrame, adjacentFrame, status: statusOf,
    refreshButton, ensureButton,
    onRaceStart, onTick, onPause,
  };
}

export const ReplayBufConsts = Object.freeze({
  HZ, WINDOW_S, FLOATS, MAX_CARS, MAX_FRAMES, MAX_BYTES,
  frameBytes, budgetOk, capacityFor, lerpCar, audioRetired,
});
