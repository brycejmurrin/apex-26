/**
 * SoakRun: the hands-free half of PhoneRecorder (AUTO SOAK). Ported from
 * f1-game js/perf/soak-run.js:1-166; the IIFE over the god object `G` became
 * `createSoakRun(host)` over an explicit `SoakHost`.
 *
 * One tap on SETTINGS > METRICS > PHONE TEST > AUTO SOAK starts a wet race on a
 * fixed circuit with the full grid and the chase camera, drives the PLAYER car
 * itself, records for SOAK_MIN minutes with PhoneRecorder, then stops, parks
 * the car under the pause menu and leaves SHARE ready. Nothing here runs until
 * start(): no listener, timer or rAF exists while idle.
 *
 * HOW THE CAR IS DRIVEN. The player car is NOT switched to AI physics. This
 * module only synthesises the INPUT, through the same seam tests use (the
 * debug API's setInput override, src/debug/api.ts), so the human physics path,
 * the assists and the settings the player chose are exactly what a real race
 * runs. The law is f1-game tests/specs/autopilot.spec.js's closed loop: a
 * braking envelope over look-ahead curvature plus pure pursuit.
 *
 * THE ARC RULE (AGENTS.md §The arc rule). That law reads track curvature to
 * steer the player, which the arc rule forbids in a real race. So curvature is
 * NOT read from `TrackQuery` (which has none, by design) but from
 * `SoakHost.curvature`, a separate soak-only channel the shell must wire
 * explicitly; the output is an ordinary `PlayerInput` via the debug override.
 * It is reachable ONLY through start() (a deliberate soak, never a default,
 * never a setting that persists) and clears the override the moment it stops,
 * so a normal race and every assist-off rule are untouched. f1-game classifies
 * it in docs/PHYSICS.md §Curvature channels as assist-gated (soak-only input
 * synthesiser, gated by start()).
 *
 * THE PAGE MUST STAY IN THE FOREGROUND. iOS Safari pauses a hidden or locked
 * page (the shell pauses on document.hidden), so a soak that is backgrounded
 * just stops.
 */
import { nowMs, perfLog } from "./env";
import type { TrackSample } from "../contracts/track";

export const SOAK_MIN = 15;
export const TRACK_ID = "monza";
const LAPS = 40;                     // far more than 15 min of racing: the flag never ends the soak
const DISTS: number[] = []; for (let d = 5; d <= 160; d += 6) DISTS.push(d);
const VMAX = 94, KP = 2.4;
const A_LAT_WET = 9, A_BRAKE_WET = 16;   // the autopilot spec's 13/24 are dry numbers

/** The synthesised input: the debug API's `setInput(Partial<PlayerInput>)` shape. */
export interface SoakInput { steer: number; throttle: boolean; brake: boolean }

export interface SoakPlayer { readonly s: number; readonly x: number; readonly head?: number | null; readonly speed: number }

/**
 * Everything SoakRun touches. TODO(lane-shell): build this from the App
 * (`state`, `player`, `track`, the debug `setInput`, pause, startRace,
 * camera). `curvature` is the soak-only arc channel (see the header) —
 * TODO(lane-track): expose it from the track build, never through TrackQuery.
 */
export interface SoakHost {
  state(): string;
  player(): SoakPlayer | null;
  track(): { sample(s: number, out: TrackSample): TrackSample; wrapS(s: number): number } | null;
  curvature(s: number): number;
  setTestInput(input: SoakInput | null): void;
  rescuePlayer?(): void;
  paused(): boolean;
  /** The game's own PAUSE (f1-game clicks #pausebtn; the pause menu then shows SHARE). */
  pause(): void;
  startRace(opts: { track: string; laps: number; weather: "wet" }): Promise<unknown> | unknown;
  setChaseCamera?(): void;
  closeSettings?(): void;
  /** Recorder hooks (./phone-recorder.ts). */
  recorder?: { start(): unknown; stop(): unknown; isOn(): boolean };
}

export interface SoakState { hold: number; stalled: number; lastS: number | null }

export interface SoakStatus {
  state: string;
  reason?: string;
  minutes?: number;
  elapsedMin?: number;
}

function wrapPi(a: number): number { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

export interface SoakProbe { x: number; angle: number; k: number; hw: number; speed: number; s: number }

// The road under the player, as probe()/scan() in f1-game js/agent/apex.js read it.
export function probe(host: SoakHost, smp: TrackSample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 }): SoakProbe | null {
  const P = host.player(), T = host.track();
  if (!P || !T) return null;
  T.sample(P.s, smp);
  const angle = P.head != null ? wrapPi(Math.atan2(smp.t[0], smp.t[2]) - P.head) : 0;
  return { x: P.x, angle, k: host.curvature(P.s), hw: smp.hw, speed: P.speed, s: P.s };
}

// One control frame: returns the input to hold until the next frame.
export function control(host: SoakHost, st: SoakState, dt: number, smp?: TrackSample): SoakInput | null {
  const p = probe(host, smp);
  const T = host.track(), P = host.player();
  if (!p || !T || !P) return null;
  let kSteer = p.k;
  const steerLook = Math.max(9, p.speed * 0.4);
  let vT = Math.abs(p.k) > 1e-4 ? Math.sqrt(A_LAT_WET / Math.abs(p.k)) : VMAX;
  for (let j = 0; j < DISTS.length; j++) {
    const d = DISTS[j] as number;
    const k = host.curvature(T.wrapS(P.s + d));
    if (d <= steerLook) kSteer = k;
    const vCorner = Math.abs(k) > 1e-4 ? Math.sqrt(A_LAT_WET / Math.abs(k)) : VMAX;
    const vAllow = Math.sqrt(vCorner * vCorner + 2 * A_BRAKE_WET * d);
    if (vAllow < vT) vT = vAllow;
  }
  vT = Math.max(11, Math.min(VMAX, vT));
  st.hold = Math.min(vT, st.hold + 30 * dt); vT = st.hold;   // ease the target up from a standstill
  const L = Math.max(8, Math.min(38, p.speed * 0.6));
  const latTarget = kSteer * L * L * 0.5;
  let steer = clamp(KP * (Math.atan2(latTarget - p.x, L) - p.angle), -1, 1);
  const offRoad = Math.abs(p.x) - p.hw > 0.4;
  if (st.lastS != null && p.s - st.lastS < 0.05) st.stalled++; else st.stalled = 0;   // no progress along the arc (a standing start counts, harmlessly)
  st.lastS = p.s;
  let throttle = p.speed < vT, brake = p.speed > vT * 1.04;
  if (st.stalled > 10) { steer = clamp(steer, -0.4, 0.4); throttle = true; brake = false; }
  else if (offRoad) throttle = false;
  if (st.stalled > 420 && host.rescuePlayer) { st.stalled = 0; try { host.rescuePlayer(); } catch { /* no rescue: keep trying */ } }
  return { steer, throttle, brake };
}

interface Run { raf: number; t0: number; tRace: number; prev: number; started: boolean; minutes: number; st: SoakState }

export function createSoakRun(host: SoakHost, now: () => number = nowMs) {
  let _run: Run | null = null;
  let _last: SoakStatus = { state: "idle", reason: "" };
  const smp: TrackSample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };

  function log(msg: string): void { perfLog.info("game", "SoakRun " + msg); }

  // A hidden or locked page is paused by the shell and cannot soak: end the run rather than leave input held.
  function onHidden(): void { if (typeof document !== "undefined" && document.hidden) finish("hidden"); }

  function finish(reason: string): boolean {
    const r = _run;
    if (!r) return false;
    _run = null;
    try { document.removeEventListener("visibilitychange", onHidden); } catch { /* no document */ }
    if (r.raf) cancelAnimationFrame(r.raf);
    host.setTestInput(null);     // the real Input owns the car again the instant the soak ends
    try { if (!host.paused()) host.pause(); } catch { /* pause is a courtesy */ }
    try { if (host.recorder && host.recorder.isOn()) host.recorder.stop(); } catch { /* recorder gone */ }
    _last = { state: "done", reason, minutes: +((now() - r.t0) / 60000).toFixed(2) };
    log("end " + reason);
    return true;
  }

  function tick(ts: number): void {
    const r = _run;
    if (!r) return;
    r.raf = requestAnimationFrame(tick);
    const dt = r.prev ? Math.min(0.1, Math.max(0.001, (ts - r.prev) / 1000)) : 1 / 60;
    r.prev = ts;
    const state = host.state();
    if (state === "race") {
      if (!r.started) {
        r.started = true; r.tRace = now();
        try { host.recorder?.start(); } catch { /* recorder missing: the drive still runs */ }
        log("racing");
      }
      const inp = control(host, r.st, dt, smp);
      if (inp) host.setTestInput(inp);
      if (now() - r.tRace >= r.minutes * 60000) finish("complete");
    } else if (r.started && state !== "count") {
      finish("left-race");     // the player quit, or the session ended under us
    } else if (now() - r.t0 > 5 * 60000) {
      finish("never-started"); // a build that never reached the lights
    }
  }

  function start(opts: { track?: string; minutes?: number } = {}): Promise<boolean> {
    if (_run) return Promise.resolve(false);
    const track = opts.track || TRACK_ID;
    try { host.closeSettings?.(); } catch (e) {
      perfLog.warn("game", "SoakRun start refused: " + (e instanceof Error ? e.message : String(e)));
      return Promise.resolve(false);
    }
    const run: Run = { raf: 0, t0: now(), tRace: 0, prev: 0, started: false, minutes: opts.minutes != null && opts.minutes > 0 ? opts.minutes : SOAK_MIN,
      st: { hold: 30, stalled: 0, lastS: null } };
    _run = run;
    _last = { state: "starting", reason: "" };
    try { document.addEventListener("visibilitychange", onHidden); } catch { /* no document */ }
    log("start " + track + " wet " + run.minutes + " min");
    return Promise.resolve(host.startRace({ track, laps: LAPS, weather: "wet" })).then(() => {
      if (!_run) return false;
      try { host.setChaseCamera?.(); } catch { /* camera stays as the player had it */ }
      _run.raf = requestAnimationFrame(tick);
      return true;
    }, () => { finish("start-failed"); return false; });
  }

  return {
    SOAK_MIN, TRACK_ID,
    start, stop: (why?: string) => finish(why || "stopped"),
    active: () => !!_run,
    status: (): SoakStatus => Object.assign({}, _last, _run ? { state: _run.started ? "racing" : "starting",
      elapsedMin: _run.started ? +((now() - _run.tRace) / 60000).toFixed(2) : 0, minutes: _run.minutes } : null),
  };
}

export type SoakRun = ReturnType<typeof createSoakRun>;
