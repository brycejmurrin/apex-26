/**
 * EXTRA player camera rigs (RIVAL LOCK, PIT WALL, DRONE FOLLOW): append-only
 * CAM_MODES solvers kept out of vantage for file-size headroom.
 * Broadcast-only framing; never touches car state.
 *
 * Ported verbatim from f1-game js/camera/extra-rigs.js:1-328 (`ExtraRigs`).
 *
 * Port notes: the IIFE's module state (scratch samples, the drone's smoothed
 * pose, the pit auto-cut bookkeeping, the latched vScale and the store/mode
 * memos) lives in an instance made by `createExtraRigs(deps)`. Its globals are
 * injected:
 *   Tracks.sample / curvature / pitLaneAt → deps.tracks (default src/track/core)
 *   FlybySeq.insideProp                   → deps.flyby (a ./flyby-seq.ts instance)
 *   CamFeel.follow                        → deps.feel (./feel.ts)
 *   CamTune.cornerHang / cornerLead       → deps.camTune (./offsets.ts)
 *   Broadcast.battles                     → deps.battles (absent → localBattles,
 *       numerically identical: js/race/broadcast.js:194-210).
 *       TODO(lane-race): Broadcast is not ported (src/overlay/feed.ts has a copy).
 *   CamModes.CAM_MODES                    → deps.camModes(). TODO(lane-shell):
 *       js/camera/mode-switch.js is not ported.
 *   GameStore.store                       → deps.store (./store.ts, a26.pitCamAuto)
 *   PhysicsConsts.VMAX                    → deps.vmax (absent: the vScale latch is
 *       skipped, as f1-game does without PhysicsConsts).
 *
 * THE ARC RULE: `droneFollow` reads track curvature for a broadcast-only sway.
 * It moves a camera; nothing here feeds PlayerInput or CarState, and the cars
 * handed to pickRival / tickPitAuto are read, never written.
 */
import { clamp, lerp } from "../physics/math";   // f1-game js/core/mat4.js:5-6 (M4.clamp / M4.lerp)
import { curvature as coreCurvature, pitLaneAt as corePitLaneAt, sample as coreSample } from "../track/core/tracks";
import type { PitLaneAt } from "../track/core/pit";
import type { Sample } from "../track/core/types";
import type { FlybyTrack, PropRec, Vec3 } from "./flyby-seq";
import type { CamStore } from "./store";

export const BATTLE_S = 1.0;          // match Broadcast's battle window (seconds of gap)
export const FALLBACK_S = 2.5;        // nearest-rival search when no battle is live
export const DRONE_BACK = 11;         // m behind the car along heading
export const DRONE_UP = 7.2;          // m above the road
const DRONE_LEAD = 18;                // m of look-ahead along the centreline
const DRONE_SMOOTH = 0.14;            // per-frame blend toward ideal (snap resets)
const DRONE_SMOOTH_COMFORT = 0.05;
const PIT_EYE_OUT = 5.5;              // m past the half-width onto the pit wall
const PIT_EYE_UP = 3.4;
const PIT_BACK = 8;                   // m of arc behind the car
const PIT_EYE_IN = 1.0;               // m past the half-width: the innermost re-site (the wall's kerb face)
const PIT_CLEAR = 0.5;                // m of facade the re-sited eye keeps
const PIT_SCAN = 0.25;                // m per inward re-site step

/** A car as the rigs read it (the sim's car record, read-only). */
export interface RigCar {
  readonly s?: number; readonly x?: number;
  readonly prog?: number; readonly speed?: number; readonly rank?: number;
  readonly retired?: boolean; readonly finished?: boolean;
  readonly pitState?: string | null;
  /** WATCH's puppets carry the trace's real m/s (RealReplay.pose sets it). */
  readonly replayRate?: number | null;
}
/** One running-car row handed to battles(). */
export interface RigRow<K> { key: K; prog: number; speed: number; pos: number }
export interface RigFight<K> { key: K; ahead: K; gapS: number; score: number }

/** The extra solve inputs vantage passes (bankDy, the rival, car pose, comfort, dt, snap). */
export interface RigExtra {
  readonly bankDy?: number;
  readonly rival?: RigCar | null;
  readonly playerProg?: number;
  readonly reduceMotion?: boolean;
  readonly carPos?: readonly [number, number] | null;
  readonly carHead?: number | null;
  readonly dt?: number;
  readonly snap?: boolean;
}

/** The track ops the rigs read. */
export interface RigTrackOps {
  sample(track: FlybyTrack, s: number, out: Sample): unknown;
  curvature?: ((track: FlybyTrack, s: number) => number) | null;
  pitLaneAt?: ((track: FlybyTrack, s: number) => Pick<PitLaneAt, "centre"> & { readonly outer?: number | null } | null) | null;
}
export const CORE_RIG_TRACK_OPS: RigTrackOps = {
  sample: (track, s, out) => coreSample(track, s, out),
  curvature: (track, s) => coreCurvature(track, s),
  pitLaneAt: (track, s) => corePitLaneAt(track, s),
};

/** tickPitAuto's game context (G.vTop, G.player, G.store, G.camMode, G.setCamMode). */
export interface PitAutoCtx {
  vTop?(): number;
  readonly player?: RigCar | null;
  readonly store?: CamStore | null;
  camMode: number;
  setCamMode?(index: number, opts: { persist: boolean }): unknown;
}

export interface ExtraRigsDeps {
  readonly tracks?: RigTrackOps;
  readonly flyby?: { insideProp?(track: FlybyTrack, p: Readonly<Vec3>, margin?: number | null): PropRec | null } | null;
  readonly feel?: { follow(key: string, target: number, lambda: number, dt: number): number } | null;
  readonly camTune?: { cornerHang?(mode: string): number | null; cornerLead?(mode: string): number | null } | null;
  readonly battles?: (<K>(rows: RigRow<K>[], vScale: number) => readonly RigFight<K>[]) | null;
  readonly camModes?: (() => readonly { readonly id: string }[] | null | undefined) | null;
  readonly store?: CamStore | null;
  readonly vmax?: number | null;
}

/** The fallback battle finder (extra-rigs.js:82-91). */
export function localBattles<K>(cars: readonly { key: K; prog: number; speed: number }[], vScale: number): RigFight<K>[] {
  const out: RigFight<K>[] = [];
  for (let i = 1; i < cars.length; i++) {
    const a = cars[i - 1]!, b = cars[i]!;
    const v = Math.max(b.speed || 0, 20 * (vScale > 0 ? vScale : 1));
    const g = (a.prog - b.prog) / v;
    if (g >= 0 && g < BATTLE_S) out.push({ key: b.key, ahead: a.key, gapS: g, score: g + i * 0.08 });
  }
  return out.sort((x, y) => x.score - y.score);
}

type RigTrack = FlybyTrack & { pit?: { readonly side?: number } | null; def?: unknown };

export function createExtraRigs(deps: ExtraRigsDeps = {}) {
  const Tracks = deps.tracks || CORE_RIG_TRACK_OPS;
  const _smpA: Sample = { p: [0, 0, 0], t: [0, 0, 1], r: [1, 0, 0], hw: 7 };
  const _smpB: Sample = { p: [0, 0, 0], t: [0, 0, 1], r: [1, 0, 0], hw: 7 };
  const _idealEye: Vec3 = [0, 0, 0], _idealTgt: Vec3 = [0, 0, 0];
  const _droneEye: Vec3 = [0, 0, 0], _droneTgt: Vec3 = [0, 0, 0];
  let _droneLive = false;
  let _droneSideSign = 0;
  let _autoPrev = -1;            // camMode restored after a pit auto-cut (-1 = idle)
  let _autoOn = false;           // we currently hold an ephemeral pitwall cut
  let _wasInPit = false;
  let _vScale = 1;               // vTop()/VMAX, latched by tickPitAuto(G) for pickRival's crawl floor

  function wrapS(track: FlybyTrack, s: number): number {
    const L = track.total;
    const v = s % L;
    return v < 0 ? v + L : v;
  }

  const _rvRows: RigRow<RigCar>[] = [], _rvOut: RigRow<RigCar>[] = [];

  /** Closest battle partner for the player, reusing Broadcast.battles when present. The 20 m/s crawl
   *  floor rides _vScale (vTop()/VMAX, latched by tickPitAuto(G) each frame before the game calls this)
   *  for the sim's PACE-scaled speeds; WATCH's puppets (c.replayRate set by RealReplay.pose) carry the
   *  trace's real m/s, so they keep the bare floor. extra-rigs.js:43-80 */
  function pickRival(cars: readonly (RigCar | null | undefined)[] | null | undefined, player: RigCar | null | undefined): RigCar | null {
    if (!cars || !player || cars.length < 2) return null;
    // Pooled rows + array (Broadcast.battles pools its fights the same way):
    // rival mode calls this every rendered frame, and the rows never escape.
    const running = _rvOut;
    let n = 0;
    let vScale = _vScale;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c && c.replayRate != null) vScale = 1;
      if (!c || c.retired || c.finished) continue;
      if (c.pitState && c.pitState !== "none") continue;
      let r = _rvRows[n];
      if (!r) { r = { key: c, prog: 0, speed: 0, pos: 0 }; _rvRows[n] = r; }
      r.key = c; r.prog = c.prog || 0; r.speed = c.speed || 0; r.pos = c.rank || 0;
      running[n++] = r;
    }
    running.length = n;
    running.sort((a, b) => b.prog - a.prog);
    const fights = deps.battles
      ? deps.battles(running, vScale)
      : localBattles(running, vScale);
    for (let i = 0; i < fights.length; i++) {
      const f = fights[i]!;
      if (f.key === player) return f.ahead;
      if (f.ahead === player) return f.key;
    }
    // No live battle — nearest car within FALLBACK_S by arc gap.
    let best: RigCar | null = null, bestG = FALLBACK_S;
    for (let i = 0; i < running.length; i++) {
      const o = running[i]!.key;
      if (o === player) continue;
      const v = Math.max(player.speed || 0, o.speed || 0, 20 * vScale);
      const g = Math.abs((o.prog || 0) - (player.prog || 0)) / v;
      if (g < bestG) { bestG = g; best = o; }
    }
    return best;
  }

  function carSample(track: FlybyTrack, car: RigCar, out: Sample) {
    const s = wrapS(track, car.s || 0), x = car.x || 0;
    Tracks.sample(track, s, out);
    return { s, x, p: out.p, t: out.t, r: out.r, hw: out.hw };
  }

  /** Frame the car ahead or behind in a battle — both cars stay in shot. extra-rigs.js:100-129 */
  function rivalLock(track: FlybyTrack, s: number, x: number, spd: number, extra: RigExtra | null | undefined, eye: Vec3, tgt: Vec3): number {
    const spN = clamp(spd / 72, 0, 1);
    Tracks.sample(track, wrapS(track, s), _smpA);
    const p = _smpA.p, t = _smpA.t, r = _smpA.r;
    const bankDy = (extra && extra.bankDy) || 0;
    const rival = extra && extra.rival;
    if (!rival) {
      // Solo fallback: a pulled-back three-quarter chase so the mode still frames.
      eye[0] = p[0] - t[0] * 9 + r[0] * 3.5;
      eye[1] = p[1] + 4.2 + bankDy;
      eye[2] = p[2] - t[2] * 9 + r[2] * 3.5;
      tgt[0] = p[0] + t[0] * 6; tgt[1] = p[1] + 0.9; tgt[2] = p[2] + t[2] * 6;
      return lerp(48, 56, spN);
    }
    const rv = carSample(track, rival, _smpB);
    // Midpoint of the two cars' world positions (lateral applied).
    const px = p[0] + r[0] * x, pz = p[2] + r[2] * x;
    const rx = rv.p[0] + rv.r[0] * rv.x, rz = rv.p[2] + rv.r[2] * rv.x;
    const midX = (px + rx) * 0.5, midZ = (pz + rz) * 0.5;
    const midY = (p[1] + rv.p[1]) * 0.5 + bankDy + 0.7;
    // Along-track back from the trailing car, raised, slight outside offset.
    const trailS = ((rival.prog || 0) < (extra!.playerProg || 0)) ? (rival.s || s) : s;
    Tracks.sample(track, wrapS(track, trailS - 10), _smpB);
    const side = 6.5;
    eye[0] = _smpB.p[0] + _smpB.r[0] * side;
    eye[1] = _smpB.p[1] + 5.5 + bankDy;
    eye[2] = _smpB.p[2] + _smpB.r[2] * side;
    tgt[0] = midX; tgt[1] = midY; tgt[2] = midZ;
    return lerp(42, 50, spN);
  }

  /** Pit-wall / pit-lane camera — sits on the pit side looking across the car. extra-rigs.js:132-164 */
  function pitWall(track: RigTrack, s: number, x: number, spd: number, extra: RigExtra, eye: Vec3, tgt: Vec3): number {
    const spN = clamp(spd / 72, 0, 1);
    const def = track.def as { pitZone?: { side?: number } } | null | undefined;
    const side = (track.pit && track.pit.side) || (def && def.pitZone && def.pitZone.side) || 1;
    Tracks.sample(track, wrapS(track, s - PIT_BACK), _smpA);
    const hw = _smpA.hw || 7;
    let lat = side * (hw + PIT_EYE_OUT);
    // In the pit complex, stand on the garage side of the working lane.
    const rib = Tracks.pitLaneAt ? Tracks.pitLaneAt(track, s) : null;
    if (rib) {
      const outer = rib.outer != null ? rib.outer : rib.centre + side * 4;
      lat = outer + side * 2.5;
    }
    eye[1] = _smpA.p[1] + PIT_EYE_UP + (extra.bankDy || 0) + (rib ? 1.2 : 0);
    // RE-SITE, NEVER LIFT. The pit side is where the stands and pit buildings
    // are: at a fixed hw + 5.5 m the eye was inside one on 44 of 51 circuits
    // (15.6 % of Mexico's lap, track gallery 2026-10-15). Walk it in toward the
    // kerb until it is clear of every solid prop (FlybySeq's set); a lift, as
    // CamAvoid does for the crane modes, threw it 25–250 m up a street
    // circuit's towers. The clear edge moves with s, so the eye does too.
    const inner = side * (hw + PIT_EYE_IN);
    const flyby = deps.flyby;
    const n = (flyby && flyby.insideProp) ? Math.ceil(Math.abs(lat - inner) / PIT_SCAN) : 0;
    for (let i = 0; ; i++) {
      const l = n ? lat + (inner - lat) * i / n : lat;
      eye[0] = _smpA.p[0] + _smpA.r[0] * l;
      eye[2] = _smpA.p[2] + _smpA.r[2] * l;
      if (i >= n || !flyby!.insideProp!(track, eye, PIT_CLEAR)) break;
    }
    Tracks.sample(track, wrapS(track, s), _smpB);
    const cx = _smpB.p[0] + _smpB.r[0] * x;
    const cz = _smpB.p[2] + _smpB.r[2] * x;
    tgt[0] = cx; tgt[1] = _smpB.p[1] + 0.85 + (extra.bankDy || 0); tgt[2] = cz;
    return lerp(44, 52, spN);
  }

  /** Smoothed tether drone — higher than chase, calmer than heli, corner look-ahead. extra-rigs.js:167-235 */
  function droneFollow(track: FlybyTrack, s: number, x: number, spd: number, now: number, extra: RigExtra | null | undefined, eye: Vec3, tgt: Vec3): number {
    const spN = clamp(spd / 72, 0, 1);
    const comfort = !!(extra && extra.reduceMotion);
    Tracks.sample(track, wrapS(track, s), _smpA);
    const p = _smpA.p, t = _smpA.t, r = _smpA.r;
    const bankDy = (extra && extra.bankDy) || 0;
    // Ideal eye: tether behind the car (car heading when known, else road tangent).
    let hx = t[0], hz = t[2];
    if (extra && extra.carPos && extra.carHead != null) {
      hx = Math.sin(extra.carHead); hz = Math.cos(extra.carHead);
    }
    const cx = (extra && extra.carPos) ? extra.carPos[0] : (p[0] + r[0] * x);
    const cz = (extra && extra.carPos) ? extra.carPos[1] : (p[2] + r[2] * x);
    const cy = p[1] + bankDy;
    // Mild sway on the outside of the next bend — broadcast-only curvature read.
    let side = 1.8;
    if (!comfort && typeof Tracks.curvature === "function") {
      const kHere = Tracks.curvature(track, wrapS(track, s));
      const kAhead = Tracks.curvature(track, wrapS(track, s + lerp(20, 50, spN)));
      const kA = Math.abs(kHere) >= Math.abs(kAhead) ? kHere : kAhead;
      const mag = Math.abs(kA) > 0.001 ? 3.2 : 1.8;
      const sgn = Math.abs(kA) > 0.001 ? (kA > 0 ? 1 : -1) : 1;
      const flipping = _droneSideSign !== 0 && _droneSideSign !== sgn;
      _droneSideSign = sgn;
      const lam = flipping ? 6.2 : 2.4;
      side = deps.feel
        ? deps.feel.follow("droneSide", sgn * mag, lam, (extra && extra.dt) || 0)
        : sgn * mag;
    }
    if (deps.camTune && typeof deps.camTune.cornerHang === "function") {
      const hang = deps.camTune.cornerHang("drone");
      if (hang != null) side *= hang;
    }
    _idealEye[0] = cx - hx * DRONE_BACK + (-hz) * side;
    _idealEye[1] = cy + DRONE_UP;
    _idealEye[2] = cz - hz * DRONE_BACK + hx * side;
    // Aim: blend car nose with centreline look-ahead so the tether swings into corners.
    Tracks.sample(track, wrapS(track, s + DRONE_LEAD), _smpB);
    const leadAmt = comfort ? 0.25 : 0.54;
    const leadStored = (deps.camTune && deps.camTune.cornerLead)
      ? deps.camTune.cornerLead("drone") : null;
    const lead = clamp(leadStored != null ? leadStored : leadAmt, 0, 1);
    const aimCarX = cx + hx * 8, aimCarZ = cz + hz * 8;
    _idealTgt[0] = lerp(aimCarX, _smpB.p[0] + _smpB.r[0] * x * 0.3, lead);
    _idealTgt[1] = lerp(cy + 0.8, _smpB.p[1] + 0.9 + bankDy, lead);
    _idealTgt[2] = lerp(aimCarZ, _smpB.p[2] + _smpB.r[2] * x * 0.3, lead);
    const dt = (extra && extra.dt) || 0;
    // Backward-Euler blend lam*dt/(1+lam*dt), not 1-exp(-lam*dt): the filter runs on per-frame
    // samples of a moving ideal, and this form keeps its steady-state lag at v/lam at ANY frame
    // rate (the exp form lags v*dt*(1-a)/a, ~0.75 m shorter at 144 Hz than at 30 Hz at 60 m/s).
    const lamD = (comfort ? 3.2 : 9) * dt;
    const a = dt > 0
      ? lamD / (1 + lamD)
      : (comfort ? DRONE_SMOOTH_COMFORT : DRONE_SMOOTH);
    if (!_droneLive || (extra && extra.snap)) {
      _droneEye[0] = _idealEye[0]; _droneEye[1] = _idealEye[1]; _droneEye[2] = _idealEye[2];
      _droneTgt[0] = _idealTgt[0]; _droneTgt[1] = _idealTgt[1]; _droneTgt[2] = _idealTgt[2];
      _droneLive = true;
    } else {
      for (let i = 0; i < 3; i++) {
        _droneEye[i] = lerp(_droneEye[i]!, _idealEye[i]!, a);
        _droneTgt[i] = lerp(_droneTgt[i]!, _idealTgt[i]!, a);
      }
    }
    eye[0] = _droneEye[0]; eye[1] = _droneEye[1]; eye[2] = _droneEye[2];
    tgt[0] = _droneTgt[0]; tgt[1] = _droneTgt[1]; tgt[2] = _droneTgt[2];
    void now;
    return lerp(40, 48, spN);
  }

  /** extra-rigs.js:237 */
  function solve(mode: string, track: FlybyTrack, s: number, x: number, spd: number, now: number, extra: RigExtra | null | undefined, eye: Vec3, tgt: Vec3): number | null {
    if (mode === "rival") return rivalLock(track, s, x, spd, extra, eye, tgt);
    if (mode === "pitwall") return pitWall(track, s, x, spd, extra as RigExtra, eye, tgt);
    if (mode === "drone") return droneFollow(track, s, x, spd, now, extra, eye, tgt);
    return null;
  }

  function reset(mode?: string | null): void {
    if (!mode || mode === "drone") _droneLive = false;
  }

  /** A new session: drop the pit auto-cut bookkeeping (quitting mid auto-cut left it armed). */
  function resetAuto(): void { _autoOn = false; _autoPrev = -1; _wasInPit = false; }

  function inPit(c: RigCar | null | undefined): boolean {
    return !!(c && c.pitState && c.pitState !== "none");
  }

  /** Optional auto-cut onto PIT WALL around pit entry/exit. Returns the mode
   *  id it switched to, or null. Reads a26.pitCamAuto — OFF unless the
   *  player opts in: taking the camera away on every pit entry (and handing it
   *  back on exit) was reported as unwanted on 2026-10-02, so the player's own
   *  camera stays put; PIT WALL is still one press of the camera button away.
   *  extra-rigs.js:255-313 */
  let _pcStore: CamStore | null = null, _pcRev = -1, _pcRaw = -1, _pcEnabled = false;
  let _pitModes: readonly { readonly id: string }[] | null = null, _pitIdx = -1;
  const _isPitwall = (m: { readonly id: string }): boolean => m.id === "pitwall";
  function tickPitAuto(G: PitAutoCtx | null | undefined): string | null {
    if (G && G.vTop && deps.vmax) _vScale = G.vTop() / deps.vmax;
    const modes = deps.camModes ? deps.camModes() : null;
    if (!G || !G.player || !modes) return null;
    const store = G.store || deps.store || null;
    // Both read once per change, not per frame (perf hunt 2 F10): the opt-in on
    // the store's revisions (set(), a foreign write and a restore bump `rev`;
    // rawSet / rawDel, e.g. a settings import, bump `rawRev`), the PIT WALL
    // index on the mode list's identity. A store without revisions reads each call.
    if (!store || store !== _pcStore || typeof store.rev !== "number" || store.rev !== _pcRev || store.rawRev !== _pcRaw) {
      _pcEnabled = !!store && store.get("pitCamAuto", false) === true;
      _pcStore = store; _pcRev = store ? (store.rev as number) : -1; _pcRaw = store ? (store.rawRev as number) : -1;
    }
    const enabled = _pcEnabled;
    const nowIn = inPit(G.player);
    if (modes !== _pitModes) { _pitModes = modes; _pitIdx = modes.findIndex(_isPitwall); }
    const pitIdx = _pitIdx;
    if (pitIdx < 0) { _wasInPit = nowIn; return null; }
    if (!enabled) {
      if (_autoOn) { _autoOn = false; _autoPrev = -1; }
      _wasInPit = nowIn;
      return null;
    }
    if (nowIn && !_wasInPit) {
      // Entering the pits — ephemeral cut to pitwall unless already there.
      if (G.camMode !== pitIdx) {
        _autoPrev = G.camMode;
        if (typeof G.setCamMode === "function") G.setCamMode(pitIdx, { persist: false });
        else G.camMode = pitIdx;
        _autoOn = true;
        _wasInPit = nowIn;
        return "pitwall";
      }
      _autoOn = false; _autoPrev = -1;
    } else if (!nowIn && _wasInPit && _autoOn && _autoPrev >= 0) {
      const restore = _autoPrev;
      _autoPrev = -1; _autoOn = false;
      if (G.camMode === pitIdx) {
        if (typeof G.setCamMode === "function") G.setCamMode(restore, { persist: false });
        else G.camMode = restore;
        _wasInPit = nowIn;
        return (modes[restore] || { id: null }).id || null;
      }
    } else if (!nowIn) {
      _autoOn = false; _autoPrev = -1;
    } else if (_autoOn && G.camMode !== pitIdx) {
      // Player manually left pitwall while still in the pits — release the hold.
      _autoOn = false; _autoPrev = -1;
    }
    _wasInPit = nowIn;
    return null;
  }

  /** extra-rigs.js:315-321 */
  function pitCamAuto(store: CamStore | null | undefined, v?: boolean | null): boolean {
    const st = store || deps.store || null;
    if (!st) return false;
    if (v == null) return st.get("pitCamAuto", false) === true;
    st.set("pitCamAuto", !!v);
    return !!v;
  }

  return {
    solve, reset, resetAuto, pickRival, tickPitAuto, pitCamAuto, localBattles,
    BATTLE_S, FALLBACK_S, DRONE_BACK, DRONE_UP,
  };
}

export type ExtraRigs = ReturnType<typeof createExtraRigs>;
