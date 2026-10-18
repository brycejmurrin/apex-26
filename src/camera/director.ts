/* Apex 26 — LIVE TV DIRECTOR (createDirector(host)): a broadcast-style camera
 * brain for the race the player is driving. Reuses Broadcast's pure cut policy
 * (battles / shotFor / dwell). When CAM_MODES id "tv" is on — or after the
 * player finishes/retires in solo — it picks a subject (battle / leader) and a
 * shot (side/heli/tcam/chase/cinematic/low), solves the vantage into
 * host.dbgCam, and never touches car forces or sim RNG. Curvature reaches it
 * only through host.camVantage (broadcast-only). Netplay: auto-spectate and TV
 * cuts stay off while netPlay.active() — pause does not own the shared sim.
 *
 * Ported verbatim from f1-game js/camera/director.js:1-260 (Director). The IIFE
 * becomes `directorPolicy(broadcast)` (the pure cut rules) + `createDirector`.
 * Ambient globals are injected:
 *   Broadcast.{SHOTS,SHOT_MIN_S,SHOT_MAX_S,battles,shotFor} → deps.broadcast
 *       TODO(lane-race): js/race/broadcast.js. f1-game ships with Broadcast
 *       loaded, so the GAME's director must be handed it; without it the
 *       director's own fallbacks run (director.js:13-39), as in a bare VM.
 *   CamModes.CAM_MODES  → deps.modes (src/camera/modes.ts registry `.modes`)  director.js:91-99
 *   CamFeel.scoped      → deps.feel  (src/camera/feel.ts; "tv:" scope)        director.js:154
 *   Tracks.banking      → deps.banking (default src/track/core/mesh.ts banking) director.js:151
 *   PhysicsConsts.VMAX  → src/physics/consts.ts                                director.js:216
 *   G                   → host (DirectorHost), read live every tick.
 * THE ARC RULE: this reads cars and the world; it writes only host.dbgCam
 * (and host.setCamMode for auto-spectate), never a car or PlayerInput. */
import type { Track } from "../track/core/types";
import { banking as trackBanking } from "../track/core/mesh";
import { PhysicsConsts } from "../physics/consts";
import type { CamVantage, VantageExtra } from "./modes";

/** A car as the director reads it (director.js:102-117, :138-162). */
export interface DirectorCar {
  code?: string;
  s?: number;
  x?: number;
  speed?: number;
  prog?: number;
  px?: number | null;
  pz?: number | null;
  head?: number;
  retired?: boolean;
  finished?: boolean;
}

/** One Broadcast.battles input row: progress-ordered running cars. */
export interface RunRow<K = unknown> { key: K; prog: number; speed: number }
/** One Broadcast.battles output row. */
export interface Fight<K = unknown> { key: K; ahead: K; gapS: number; score: number }

/** TODO(lane-race): the slice of js/race/broadcast.js the director reuses (broadcast.js:194-240, :481). */
export interface BroadcastPolicy {
  readonly SHOTS?: readonly string[];
  readonly SHOT_MIN_S?: number;
  readonly SHOT_MAX_S?: number;
  battles?<K>(cars: ReadonlyArray<RunRow<K>>, vScale?: number): ReadonlyArray<Fight<K>>;
  shotFor?(kind: string | null, onAir: string | null, n: number): string | null;
}

/** The decideCut state (director.js:41-46). */
export interface CutState<K = unknown> {
  wall: number;
  lastCut: number;
  cuts?: number;
  onAirShot?: string | null;
  subject?: K | null;
  vScale?: number;
  running?: ReadonlyArray<RunRow<K>>;
}
export interface Cut<K = unknown> { subject: K; kind: string | null; shot: string | null }

export interface WantOnState {
  net?: boolean;
  modeId?: string;
  autoSpectate?: boolean;
  finished?: boolean;
  retired?: boolean;
}

/** The camera the director publishes (director.js:158). */
export interface DbgCam {
  eye: number[];
  target: number[];
  fov: number;
  far: number;
  roll?: number;
  _resultsCam?: boolean;
}

/** The subject's interpolated render pose (game.js camPoseOf). TODO(lane-shell). */
export interface CamPose {
  readonly s: number;
  readonly x: number;
  readonly carPos?: readonly number[] | null;
  readonly carHead?: number;
}

/** The G members the director reads and writes (director.js:83-237). TODO(lane-shell): the app binds it. */
export interface DirectorHost<C extends DirectorCar = DirectorCar> {
  state: string;
  paused?: boolean;
  photoMode?: boolean;
  /** The override camera; whoever set it owns it. Unknown owners (Photo, tools) are compared by identity. */
  dbgCam: object | null;
  cars?: ReadonlyArray<C | null | undefined> | null;
  player?: C | null;
  track?: Track | null;
  camMode: number;
  setCamMode?(i: number, opts: { persist: boolean }): unknown;
  camVantage?: CamVantage | null;
  camPoseOf?(car: C): CamPose | null | undefined;
  snapGameCam?(): void;
  netPlay?: { active?(): boolean } | null;
  vTop?(): number;
}

export type BankingFn = (track: Track, s: number, x: number, out: { dy: number; roll: number }, smooth: boolean) => { dy: number } | null;

export interface DirectorDeps {
  readonly broadcast?: BroadcastPolicy | null;
  /** The mode list (CamModes.CAM_MODES): the registry's live `.modes`. */
  readonly modes?: ReadonlyArray<{ readonly id: string }> | null;
  readonly feel?: { scoped<T>(prefix: string, fn: () => T): T } | null;
  /** Tracks.banking; undefined = src/track/core banking, null = none (unbanked). */
  readonly banking?: BankingFn | null;
}

const BATTLE_S = 1.0;
// Establish the followed car before widening out; no onboard shot that hides it.
export const FINISH_SHOTS: readonly string[] = Object.freeze(["chase", "side", "heli", "cinematic"]);

/** The pure cut rules (director.js:11-78), bound to `bc` (Broadcast) when given. */
export function directorPolicy(bc?: BroadcastPolicy | null) {
  // Prefer Broadcast's shipped shot list and dwell when the module is loaded;
  // fall back to the same literals so a bare VM unit test still runs.
  const SHOTS: readonly string[] = Object.freeze(bc && bc.SHOTS
    ? bc.SHOTS.slice()
    : ["side", "heli", "tcam", "chase", "cinematic", "low"]);
  const SHOT_MIN_S = (bc && bc.SHOT_MIN_S) || 5;
  const SHOT_MAX_S = (bc && bc.SHOT_MAX_S) || 14;

  /** Progress-ordered running cars → Broadcast.battles shape. vScale: vTop()/VMAX — the director
   *  only cuts the SIM's race (eligible() keeps WATCH out), whose speeds are PACE-scaled. */
  function battles<K>(cars: ReadonlyArray<RunRow<K>>, vScale?: number): ReadonlyArray<Fight<K>> {
    if (bc && bc.battles) return bc.battles(cars, vScale);
    const out: Fight<K>[] = [];
    for (let i = 1; i < cars.length; i++) {
      const a = cars[i - 1] as RunRow<K>, b = cars[i] as RunRow<K>;
      const v = Math.max(b.speed || 0, 20 * ((vScale as number) > 0 ? (vScale as number) : 1));
      const g = (a.prog - b.prog) / v;
      if (g >= 0 && g < BATTLE_S) out.push({ key: b.key, ahead: a.key, gapS: g, score: g + i * 0.08 });
    }
    return out.sort((x, y) => x.score - y.score);
  }
  function shotFor(kind: string | null, onAir: string | null, n: number): string | null {
    if (bc && bc.shotFor) return bc.shotFor(kind, onAir, n);
    const pool = SHOTS.filter((s) => s !== onAir);
    return pool.length ? (pool[(n | 0) % pool.length] as string) : onAir;
  }

  /**
   * Pure cut decision. Mirrors Broadcast.direct: no cut before SHOT_MIN_S;
   * a battle (or leader rotate) only after SHOT_MAX_S unless an explicit
   * event kind is supplied. Returns null to hold, or { subject, kind, shot }.
   * st.vScale: battles()' speed scale (vTop()/VMAX); omitted = 1.
   */
  function decideCut<K>(st: CutState<K>): Cut<K> | null {
    const age = st.wall - st.lastCut;
    if (age < SHOT_MIN_S) return null;
    const running = st.running || [];
    if (!running.length) return null;
    const fight = battles(running, st.vScale)[0];
    // Under SHOT_MAX_S: only cut when a battle appears and we are not already
    // on its chaser (Broadcast cuts events early; live director treats a new
    // battle the same way once the min dwell has passed).
    if (age < SHOT_MAX_S) {
      if (!fight) return null;
      if (st.subject && fight.key === st.subject) return null;
      const shot = shotFor("pass", st.onAirShot ?? null, st.cuts || 0);
      return { subject: fight.key, kind: "pass", shot };
    }
    let subject: K | null = fight ? fight.key : null;
    const kind = fight ? "pass" : null;
    if (!subject) {
      const n = Math.min(3, running.length);
      subject = (running[(st.cuts || 0) % n] as RunRow<K>).key;
    }
    const shot = shotFor(kind, st.onAirShot ?? null, st.cuts || 0);
    return { subject, kind, shot };
  }

  /** Should the live director be driving the picture right now? */
  function wantOn(st: WantOnState): boolean {
    if (st.net) return false;
    if (st.modeId === "tv") return true;
    if (st.autoSpectate && (st.finished || st.retired)) return true;
    return false;
  }

  return Object.freeze({ SHOTS, SHOT_MIN_S, SHOT_MAX_S, battles, shotFor, decideCut, wantOn });
}

export type DirectorPolicy = ReturnType<typeof directorPolicy>;

/** The policy with no Broadcast (director.js fallbacks), as a bare f1-game VM runs it. */
export const Director = directorPolicy(null);

export interface DirectorStatus {
  on: boolean;
  shot: string | null;
  cuts: number;
  subject: string | null;
  autoSpectate: boolean;
  wall: number;
}

export type DirectorApi = ReturnType<typeof createDirector>;

export function createDirector<C extends DirectorCar>(G: DirectorHost<C>, eligible: () => boolean = () => true, deps: DirectorDeps = {}) {
  const P = directorPolicy(deps.broadcast);
  const { SHOT_MIN_S, decideCut, wantOn, shotFor } = P;
  const banking: BankingFn | null = deps.banking !== undefined ? deps.banking : trackBanking;
  const feel = deps.feel ?? null;
  let wall = 0, lastCut = -1e9, cuts = 0, onAirShot: string | null = null, subject: C | null = null;
  let ownCamera: DbgCam | null = null, autoSpectate = true, forcedTv = false, prevMode = -1;
  let spectating = false;
  const scratchEye = [0, 0, 0], scratchTgt = [0, 0, 0];
  const bankScratch = { dy: 0, roll: 0 };

  function camIdx(id: string): number {
    const modes = deps.modes || [];
    return modes.findIndex((m) => m.id === id);
  }
  function modeId(): string {
    const modes = deps.modes || [];
    const m = modes[G.camMode];
    return m ? m.id : "";
  }
  // Pooled rows + array (as Broadcast.battles pools its fights): the list is
  // rebuilt on every cut-eligible tick and used only inside it.
  const runRows: Array<RunRow<C>> = [], runOut: Array<RunRow<C>> = [];
  function runningList(): Array<RunRow<C>> {
    const cars = G.cars || [];
    let n = 0;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c || c.retired || c.finished) continue;
      let r = runRows[n];
      if (!r) { r = { key: c, prog: 0, speed: 0 }; runRows[n] = r; }
      r.key = c; r.prog = c.prog || 0; r.speed = c.speed || 0;
      runOut[n++] = r;
    }
    runOut.length = n;
    runOut.sort((a, b) => b.prog - a.prog);
    return runOut;
  }
  function clearDbg(snap?: boolean): void {
    const released = ownCamera && G.dbgCam === ownCamera;
    if (released) G.dbgCam = null;
    ownCamera = null;
    // A manual handoff returns to the player's car, possibly far from this shot.
    if (released && snap && G.snapGameCam) G.snapGameCam();
  }
  /* A CUT SOLVES ONE-SHOT; HOLDING A SHOT SOLVES WITH THE FRAME'S dt.
     vantage.js eases the corner side of heli/side/cinematic through
     CamFeel.follow ("a hard sign flip teleported the eye ~36 m") — but only
     when the solve carries a dt, and this one never did, so mid-shot every
     curvature sign flip jumped the HELI eye ~24-36 m and TV SIDE ~28-50 m in
     one frame. dt 0 on a cut keeps the cut whole (every follow lands on its
     target); `snap` lets the speed-open terms start where they belong.
     The subject pose is the INTERPOLATED one the car body is drawn at
     (G.camPoseOf, read after the physics step — the loop ticks this after it):
     the raw 60 Hz car.s/px/head held-then-jumped on a 90/120 Hz display.
     The follows run under CamFeel.scoped("tv:"): the player's own rig keeps
     solving (TV falls to the chase branch) and shared keys like "chaseBend"
     would otherwise be damped toward two different cars on alternate calls. */
  function applyShot(car: C | null, shot: string, dt: number, cut: boolean): boolean {
    if (!car || !G.track || !G.camVantage) return false;
    const extra: VantageExtra = { att: car, noLook: true, frameSubject: true, dt: cut ? 0 : (dt > 0 ? dt : 0), snap: !!cut };   // noLook: the PLAYER's look-back / glance never steers a TV shot
    const pose = G.camPoseOf ? G.camPoseOf(car) : null;
    let s = car.s || 0, x = car.x || 0;
    if (pose) {
      s = pose.s; x = pose.x;
      if (pose.carPos) { extra.carPos = [pose.carPos[0] as number, pose.carPos[1] as number]; extra.carHead = pose.carHead; }
    } else if (car.px != null && car.pz != null) {
      extra.carPos = [car.px, car.pz];
      extra.carHead = car.head || 0;
    }
    // Match the normal camera's smooth bank lift at the final rendered pose.
    const bank = banking ? banking(G.track, s, x, bankScratch, true) : null;
    extra.bankDy = bank ? bank.dy : 0;
    const vant = G.camVantage;
    const solve = () => vant(shot, s, x, car.speed || 0, 0, extra);
    const v = feel && feel.scoped ? feel.scoped("tv:", solve) : solve();
    const vt = v ? v.tgt : undefined;
    if (!v || !v.eye || !vt) return false;
    scratchEye[0] = v.eye[0] as number; scratchEye[1] = v.eye[1] as number; scratchEye[2] = v.eye[2] as number;
    scratchTgt[0] = vt[0] as number; scratchTgt[1] = vt[1] as number; scratchTgt[2] = vt[2] as number;
    ownCamera = { eye: scratchEye, target: scratchTgt, fov: v.fov || 55, far: 6000 };
    G.dbgCam = ownCamera;
    onAirShot = shot;
    subject = car;
    return true;
  }
  function ensureTvMode(): void {
    if (modeId() === "tv") return;
    const i = camIdx("tv");
    if (i < 0 || !G.setCamMode) return;
    prevMode = G.camMode;   // reset() hands the player's own camera back
    G.setCamMode(i, { persist: false });
    forcedTv = true;
  }
  function tick(dt: number): void {
    const st = G.state;
    if (st !== "race" && st !== "count") { clearDbg(); return; }
    // WATCH and instant replay own the picture; Photo/tools may replace our
    // camera too. Release only our own object, before any auto-spectate cut.
    if (!eligible() || G.photoMode) { clearDbg(); return; }
    if (G.dbgCam && G.dbgCam !== ownCamera) { ownCamera = null; return; }
    if (G.paused) {
      if (modeId() !== "tv") clearDbg(true);   // a paused camera selection still takes effect
      return;   // hold the paused shot and dwell clock
    }
    const net = !!(G.netPlay && G.netPlay.active && G.netPlay.active());
    const player = G.player;
    const finished = !!(player && player.finished);
    const retired = !!(player && player.retired);
    if (!wantOn({ net, modeId: modeId(), autoSpectate, finished, retired })) {
      clearDbg(!net && modeId() !== "tv");
      return;
    }
    if (autoSpectate && (finished || retired) && !net && !spectating) {
      spectating = true; ensureTvMode();
      subject = null; onAirShot = null; cuts = 0; lastCut = -1e9;
    }
    if (modeId() !== "tv") { clearDbg(true); return; }

    // Resuming after a manual/photo camera is a cut, never a stale damping path.
    if (!ownCamera) { subject = null; onAirShot = null; lastCut = -1e9; }

    wall += dt > 0 ? dt : 0;
    // Dwell: decideCut is null before SHOT_MIN_S, so a live subject on a held
    // shot only needs its pose refreshed — skip the field scan + sort.
    if (subject && onAirShot && !subject.retired && !subject.finished && wall - lastCut < SHOT_MIN_S) {
      applyShot(subject, onAirShot, dt, false);
      return;
    }
    const running = runningList();
    // A subject that retired or took the flag leaves the shot now, not after SHOT_MAX_S.
    if (subject && (subject.retired || subject.finished) && running.length) {
      subject = null; onAirShot = null; lastCut = -1e9;
    }
    // After the player is done, include them as a spectate subject via follow
    // of the field only — still no force path.
    const decision = decideCut<C>({
      wall, lastCut, cuts, onAirShot, subject,
      vScale: G.vTop ? G.vTop() / PhysicsConsts.VMAX : 1,   // sim speeds (never WATCH, above)
      running: running.length ? running : (player && !player.retired ? [{ key: player, prog: player.prog || 0, speed: player.speed || 0 }] : []),
    });
    if (decision) {
      if (spectating) decision.shot = FINISH_SHOTS[cuts % FINISH_SHOTS.length] as string;
      lastCut = wall; cuts++;
      applyShot(decision.subject, decision.shot as string, dt, true);
    } else if (subject && onAirShot) {
      applyShot(subject, onAirShot, dt, false);   // keep dbgCam fresh as the car moves
    } else if (running[0]) {
      lastCut = wall; cuts++;
      applyShot(running[0].key, shotFor(null, null, 0) as string, dt, true);
    }
  }
  function reset(): void {
    wall = 0; lastCut = -1e9; cuts = 0; onAirShot = null; subject = null;
    // Auto-spectate forced "tv" non-persistently; the next race starts on the player's mode.
    if (forcedTv && prevMode >= 0 && modeId() === "tv" && G.setCamMode) G.setCamMode(prevMode, { persist: false });
    forcedTv = false; spectating = false; prevMode = -1; clearDbg();
  }
  function status(): DirectorStatus {
    return {
      on: modeId() === "tv" && !!ownCamera && G.dbgCam === ownCamera,
      shot: onAirShot,
      cuts,
      subject: subject && subject.code ? subject.code : null,
      autoSpectate,
      wall: +wall.toFixed(2),
    };
  }
  function setAutoSpectate(v: unknown): boolean { autoSpectate = !!v; return autoSpectate; }

  return { tick, reset, status, setAutoSpectate, decideCut, wantOn, policy: P };
}
