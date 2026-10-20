/**
 * PerfGov: the adaptive-performance governor + mobile crash sentinel. Ported
 * verbatim from f1-game js/perf/governor.js:1-993 (decision logic, float
 * operation order and the comments that explain WHY). The IIFE singleton
 * became `createPerfGov(deps)`; `perfGov` is the shared instance.
 *
 * Two-stage: (1) scale the 3D render resolution to hold 60 fps; (2) when the
 * scale floor is hit, shed features one tier at a time (render gates on
 * PerfGov.tier()). The crash sentinel detects a jetsam/OOM kill (the in-race
 * flag persisted at race start still set at the NEXT boot) and pre-degrades
 * the governor with "strikes" that cleanly finished races pay back down.
 * Renderer handle injected once via init(gfx).
 *
 * WHAT CHANGED FROM f1-game, AND WHY
 * - The renderer is the injected `PerfGfx` interface, not GLX/WGX/TLX. f1-game's
 *   governor only ever called five members of its backend facade
 *   (js/render/gfx.js:38 "setRenderScale(s)->bool"): isMobile,
 *   get/setRenderScale, capDpr and backendState().softwareGL/softAdapter.
 *   apex-26 renders with one three.js WebGPURenderer, so `createScaleGfx()`
 *   below implements that contract over `renderer.setPixelRatio` with TLX's
 *   exact clamp and 0.02 dead zone (f1-game js/render/three/tlx.js:4251-4261).
 *   TODO(lane-render): the TrackRenderer (src/render/renderer.ts) should own
 *   the scale and hand `perfGov.init()` a PerfGfx; until then the shell builds
 *   one with createScaleGfx({ apply: (pr) => trackRenderer.resize(w, h, pr) }).
 * - Storage keys are `a26.*` (f1-game `apex26.*`), through a `RawStore`.
 *   `window.__APEX_BUILD` became `deps.build` (default: src/net/handshake.ts
 *   metaBuild(), the stamped meta or the content-hashed entry URL).
 * - Before init() f1-game's tick() would throw on a null `_gfx` at its first
 *   evaluation; here an un-init'ed governor evaluates against a no-op gfx
 *   (scale 1, refuses every step), which cannot change a decision after init.
 *
 * WHAT THE SHELL CALLS (src/sim/loop.ts, src/app/): `init(gfx)` once the renderer
 * is up; `tick(dtMs)` every race/count frame while not paused; `sentinelArm(true)`
 * at race start, `cleanRace()` at a finished race, `sentinelArm(false)` on quit,
 * `sentinelResume()` on a tab return; `recordSimulation(steps, dropped)` per
 * frame. The render lane reads `tier()`, `autoTier()`, `autoShed()`.
 *
 * renderer-picker.js is NOT ported: see src/perf/README-port.md.
 */
import { metaBuild } from "../net/handshake";
import { localRawStore, perfLog, type RawStore } from "./env";
import { drift as thermalDrift, type Drift, type DriftState } from "./thermal-drift";

/** The renderer slice the governor drives (f1-game js/render/gfx.js:38 contract). */
export interface PerfGfx {
  /** Device class (a phone), not a quality tier: gates the crash sentinel. */
  readonly isMobile: boolean;
  /** Clamp to 0.5..1; refuse (false) a change under 0.02; true when the scale moved. */
  setRenderScale(s: number): boolean;
  getRenderScale?(): number;
  /** Lower the backing-store DPR cap (two crash strikes, #1641). */
  capDpr?(n: number): boolean | void;
  /** Software rasteriser / context-loss flags (SwiftShader, llvmpipe). */
  backendState?(): PerfBackendState | null;
}

export interface PerfBackendState {
  softwareGL?: boolean;
  softAdapter?: boolean;
  ctxLost?: boolean;
}

export interface PerfGovDeps {
  store?: RawStore;
  /** The build the crash strikes are keyed to (f1-game window.__APEX_BUILD). */
  build?: string;
}

export interface FrameStats {
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
  droppedSimS: number;
  physicsSteps: number;
  windowFrames: number;
}

export interface PerfGov {
  init(gfx: PerfGfx | null): void;
  tick(dtMs: number): void;
  setThermalDrift(on: boolean): void;
  thermalDrift(): DriftState | null;
  frameStats(): FrameStats;
  recordSimulation(steps: number, dropped: number): void;
  resetFrameStats(): void;
  sentinelArm(on: boolean): void;
  sentinelResume(): void;
  cleanRace(): void;
  clearStrikes(): void;
  tier(): number;
  autoTier(): number;
  autoShed(): number;
  tierFloor(): number;
  userTier(): number;
  setUserTier(n: number): void;
  strikes(): number;
  crashSeen(): { seen: number; lastBuild: string | null };
  openWindow(): { frames: number; maxMs: number; slow: number };
  fpsEMA(): number;
  floorMs(): number;
  scaleFutile(): boolean;
  tierFutile(): boolean;
  autoRes(): boolean;
  setAutoRes(on: boolean): void;
  tierHold(): boolean;
  setTierHold(on: boolean): void;
  softwareRaster(): boolean;
}

export const SENT_ACTIVE = "a26.raceActive";
export const SENT_TICKED = "a26.raceTicked";
export const SENT_STRIKES = "a26.crashStrikes";
export const SENT_BUILD = "a26.crashStrikesBuild";
export const SENT_SEEN = "a26.crashSeen";
export const SENT_SEEN_BUILD = "a26.crashSeenBuild";
export const THERMAL_DRIFT_KEY = "a26.thermalDrift";

type PendingVerify =
  | { kind: "scale"; prev: number; ema: number; next?: number; up?: boolean }
  | { kind: "tier"; prev: number; shed: number; ema: number; up?: boolean };

const NO_GFX: PerfGfx = { isMobile: false, setRenderScale: () => false };

/** The running build (the net lane's meta / hashed-entry read), "0" when unknown. */
function defaultBuild(): string {
  return String(metaBuild() ?? 0);
}

export function createPerfGov(deps: PerfGovDeps = {}): PerfGov {
const store = deps.store ?? localRawStore();
const buildId = deps.build;   // resolved at init(), when the shell's meta exists

let _gfx: PerfGfx | null = null;
const gfx = (): PerfGfx => _gfx ?? NO_GFX;

// Holds framerate by scaling the 3D render resolution (gfx.setRenderScale) when
// frames run slow, restoring sharpness when there's headroom. Conservative:
// only downscales when clearly missing THIS DEVICE'S OWN observed budget (see
// _floorMs below — ~19 ms EMA at the 60 fps default) so a healthy vsync-capped
// display never degrades; upscales slowly to avoid oscillation.
//
// SETTLE, don't HUNT: every scale change reallocates all HDR/bloom targets
// (setRenderScale -> resize -> createTargets) — a visible hitch. The old
// governor bounced around the budget edge (down at >19 ms, straight back up at
// <14 ms, with a coarse 0.1 down-step that easily overshot the up threshold),
// so a phone on GRAPHICS: HIGH — which sits right at that edge (DPR 2.0 + the
// haze/lamp-volumetric passes STANDARD keeps off) — oscillated ~once a second
// and each realloc read as a "jump". Now: snap down promptly, then HOLD the
// lower scale (_downHold) and only creep back up under clear, sustained
// headroom (<12.5 ms below the derived budget — see _floorMs). Desktop /
// STANDARD-tier sit at scale 1 and never enter these branches, so their
// (already smooth) behaviour is unchanged.
let _frameEMA = 16.7;
// TWO CLOCKS. `_frameEMA` settles per FRAME (alpha 0.1 a frame), so the
// windows that exist only to let it settle before a verdict — the 45-frame
// evaluation cadence and the short post-step verify windows in `_govCool` —
// stay frame-counted: they are the same number of samples at any refresh
// rate. The waits this file PROMISES IN SECONDS — the recovery hold, the
// refused-climb backoff, the restore and verify-fail cooldowns — were frame
// counts too, and every comment translated them at 60 fps: a 120/144 Hz
// display ran each ~2x faster than designed, weakening exactly the settling
// guarantees described below on the devices most likely to run the game.
// Those now run on `_govCoolMs` / `_downHold` in ms of the dtMs tick() gets.
let _govT = 0;            // frames since the last evaluation
let _govCool = 0;         // frames left in a post-step verify window
let _govCoolMs = 0;       // ms left before the governor may act again (wall clock)
let _autoRes = true;
let _downHold = 0;        // ms left on the recovery hold after a cut / refused climb
// Consecutive frames over SPIKE_MS. Reset by any in-budget frame and by
// sentinelArm(), so a fresh race never inherits a previous session's run.
let _slowRun = 0;
// A COOLDOWN ONLY MEANS SOMETHING WHILE FRAMES ARE BEING MEASURED. Boot arms
// two of them before the first race tick — the resolution setting's
// setAutoRes(true) on every load, ./quality-preset.ts applyLive() -> setUserTier(2)
// on every phone — and tick() only counts them down in a race, so the first
// 300 race frames were spent inside a cooldown that protected nothing. That
// window is the ONLY one in which a device slow from frame 1 is catchable:
// `_frameEMA` (alpha 0.1) outruns `_floorMs` (0.02 upward) over roughly frames
// 10–95, then the floor arrives at the same number and the device reads as
// externally capped for the rest of the session. A phone steady at 33 ms from
// lights-out was never degraded at all. So: arm a cooldown only while live
// (menu-time changes are settled by the race-start reset in sentinelArm
// anyway), and re-open the window at every race start.
let _live = false;
// ms: 10 s … 2 min
const UP_BACKOFF_MIN = 10000;
const UP_BACKOFF_MAX = 120000;
// The most one frame may pay into a wall-clock counter: a 400 ms stall or a
// 60 s tab resume is one slow FRAME, not a spent cooldown.
const COOL_STEP_MAX_MS = 100;
let _upBackoff = UP_BACKOFF_MIN;   // wait before the next restore attempt after a refused climb
// A CLIMB IS NOT PROVED BY SURVIVING ONE EVALUATION — IT IS PROVED BY SURVIVING
// THE LOAD. `_pendingVerify` reverts a climb that was wrong within one
// evaluation window; it cannot see a climb that the next heavy corner undoes
// eight seconds later. Both are the same mistake — the headroom was A GAP IN
// THE LOAD, not the device getting faster — but only the first one cost the
// governor any patience, and `_upBackoff` was then reset by every climb that
// merely passed its verify. So on a circuit with one heavy section per lap,
// which is every circuit, the governor cut in the heavy part, climbed back
// through the light part, and did the same again next lap, for the whole race.
// Each end of that cycle reallocates every HDR/bloom/SSAO/god-ray target
// (setRenderScale -> resize -> createTargets) — what this file's header already
// calls "a visible hitch". Measured against this same tick() (a 26 ms section
// for 8 s of a 35 s lap, 13 ms elsewhere): 30 reallocations in a 300 s race, a
// median 8.1 s apart, clustering at 4.7 s, and the scale ends back at 1.0 —
// every one of them bought nothing, which is the whole complaint. A cut that
// lands while a climb is still on probation is therefore charged exactly like a
// verify-refused climb, and patience is restored only by a climb that OUTLIVES
// the window. The governor then settles on the scale that holds through the
// heavy section instead of chasing the track layout around the lap.
// One lap's worth of load variance: shorter, and the next lap's heavy section
// still reads as a fresh, uncharged cut, which is the bug.
const CLIMB_SURVIVE_MS = 30000;
// A CUT IS EVIDENCE ABOUT THE SCALE IT CUT FROM, and nothing kept it.
// `_scaleFutile` records that the scale LEVER bought nothing; no state recorded
// that a particular scale VALUE did not hold. So one hold later the restore
// ladder climbed straight back toward the resolution the governor had just
// measured as too expensive, the next heavy section proved it too expensive
// again, and the pair repeated for the whole race. Patience alone cannot fix
// that — it only spaces the same wrong climb further apart. Keeping the
// ceiling ends it: never climb to within one down-step of a scale that missed.
// THE SENTINEL MUST NOT BE A VALUE THE MEASUREMENT CAN PRODUCE. This was
// initialised to 1 and compared with `>= 1`, which made "nothing refused yet"
// and "scale 1.0 missed the budget" the same state — and 1.0 is the scale a
// cut most often comes FROM. So on the single most common shape, a device
// that holds the budget at 0.9 and misses only at full resolution (this
// file's own header example: "a phone on GRAPHICS: HIGH... sits right at that
// edge"), the ceiling stayed 1, the ladder climbed straight back into the
// resolution that had just missed, and the cap contributed nothing. Verified
// against the unfixed code: byte-identical reallocation timestamps. Infinity
// is unreachable by any cut or refused climb, so `> 1` now means exactly
// "no measurement yet".
let _scaleCap = Infinity;
// The ceiling EXPIRES, or a device that was slower for one stretch — a weather
// effect, a full field on lap one, a thermal excursion that passed — could
// never have its resolution back. UNBROKEN headroom is the whole
// discriminator, and it is the SAME question the survival window above asks
// from the other side: a climb is believed once it has outlived a lap's load
// variance, so a ceiling is forgotten once it has gone that long unchallenged.
// One constant, both directions. It lifts the ceiling ALL THE WAY rather than
// a step at a time — a genuine recovery should not buy its resolution back one
// reallocation per minute — and a ceiling that was right is simply re-measured
// by the one climb that follows, at the doubling patience every refusal earns.
let _capProbeMs = CLIMB_SURVIVE_MS;
// Re-measuring the same ceiling is itself a hitch, so the probe is never more
// frequent than the backoff those refusals have already bought.
function _armCapProbe(): void { _capProbeMs = Math.max(CLIMB_SURVIVE_MS, _upBackoff); }
let _sinceUp = -1;   // ms since the last accepted up-step; -1 when none is on probation
// The hold a cut earns. 10 s normally — enough for the EMA to settle before the
// restore gate can reopen. When the cut UNDOES a climb still on probation the
// two are one oscillation, not two independent readings, so it costs the same
// doubling patience a refused climb does (10 s, 20 s, 40 s … 2 min).
function _chargeCut(): number {
  if (_sinceUp < 0) return 10000;
  _sinceUp = -1;
  _upBackoff = Math.min(_upBackoff * 2, UP_BACKOFF_MAX);
  return _upBackoff;
}
// THE OTHER SIDE OF THE SAME LOOP, from PR #190. The state above damps the
// RESTORE side — a climb must outlive the load, and a scale that missed is
// remembered so the ladder stops walking back into it. This damps the DEGRADE
// side: a repeat cut must be confirmed before it is paid for. They are
// independent and both are kept; between them the cut and the climb each have
// to mean something before a reallocation is spent on it.
// Consecutive evaluations over the degrade threshold before the governor spends
// a render-target reallocation. Two is one confirmation, ~0.75 s apart at 60 fps
// (tick() evaluates every 45 frames) — long enough that a transient cannot move
// the scale, short enough that real overload is still caught promptly.
const DEGRADE_CONFIRM = 2;
let _degradeArm = 0;
// Scale changes the governor has spent since race start — the first is prompt.
let _scaleMoves = 0;
// The scale lever is INEFFECTIVE on this device right now — set when a
// scale-down step was reverted for buying nothing, cleared once a tier has been
// shed (the next rung may change that) or once headroom returns.
//
// Without it the ladder cannot be reached on a CPU-bound frame. The degrade
// branch sheds a tier only in the `else` of "did setRenderScale move?", and
// setRenderScale only refuses at the 0.5 clamp or its 0.02 dead zone — so while
// the scale can still nominally step, `stepped` is true every time and the
// tier branch is never evaluated. On a frame whose cost is not fill-bound,
// every one of those steps is then reverted by the verify below for failing to
// improve the EMA, and the governor loops forever on the one lever that cannot
// help while shedding nothing. Measured on an iPhone at Bahrain/night, build
// 1284, 25 s per backend: WebGL2 sat at scale 0.80 / tier 0 / 23 fps, while
// WebGPU and three.js — where the scale lever did bite — reached tier 2 and ran
// at 60 and 40 fps. The slowest backend was shedding the least work.
//
// "Reverted for buying nothing" is the honest signal that the lever is wrong,
// and it is already computed; this just stops throwing it away.
let _scaleFutile = false;
// Same idea for the FEATURE ladder, after ALL remaining rungs were tested.
// A failed rung alone says nothing about later, independent features. Without
// a latch after exhaustion, the same ineffective ladder is retried forever —
// on LOW that step is the whole post stack (bloom, SSAO, god-rays, contact,
// lamp volumetrics), so a CPU-bound device saw them strobe on and off every
// ~8 s. Latched on a reverted DOWN step; released when headroom returns or the
// player changes preset (either changes what a step means).
let _tierFutile = false;

// THE BUDGET IS DERIVED, NOT HARDCODED. "> 19 ms" only ever meant "slower than
// a 60 Hz display can go" — it silently assumed the frame INTERVAL is a proxy
// for frame COST, which is true only while the display is what you are
// competing with. Under an external cap (iOS Low Power Mode throttles rAF to
// 30 fps, a 30 Hz panel, a browser background throttle) the two decouple: every
// frame lands at ~33.3 ms no matter how cheap it is to draw, an interval-driven
// governor downscales to the floor and sheds every optional feature within ~27 s,
// and NONE of it can help — the clock is capped externally and has nothing to
// do with how long the frame takes to draw. `_floorMs` tracks the FLOOR of
// observed frame intervals (a low percentile, not the mean — the fastest this
// display has actually gone) and the thresholds below are relative to it, so a
// 60 Hz panel keeps the plain numbers (floor settles near 16.7 ms) while
// a capped device is correctly judged to be MEETING its budget instead of
// chasing a number it cannot move. Pulled toward a faster observed frame
// quickly (that is direct evidence the device can go there); crept toward a
// slower one slowly, so a single stray heavy frame can't redefine the budget —
// only a SUSTAINED absence of fast frames (exactly what a hard rAF cap looks
// like) moves it.
let _floorMs = 16.7;
const FLOOR_DOWN_A = 0.3;
const FLOOR_UP_A = 0.02;
// DEGRADE_OVER sits ABOVE the floor; RESTORE_WITHIN also sits above it, just
// barely. That asymmetry is what lets the governor go both ways: a restore
// threshold 4.2 ms BELOW the floor, `_frameEMA < _floorMs - 4.2`, is
// UNSATISFIABLE: `_floorMs` chases dt down at alpha 0.3 and
// up at 0.02 while `_frameEMA` moves at 0.1 in both directions, so from their
// shared 16.7 start `_floorMs <= _frameEMA` is an invariant and the EMA can
// never get 4.2 ms below a floor that is already at or under it. Simulated
// over 60 million frames across constant 8.3/16.7/33.3, bimodal, uniform
// 1-96 ms and load-then-recover sequences: the predicate fired ZERO times and
// its closest approach was exactly 4.2000 ms — the threshold itself, at every
// steady state. Any device that degraded once would stay degraded for the
// whole session, and the crash sentinel's pre-drop could never climb back
// either.
//
// The reason no statistic over dt could have worked: the frame INTERVAL is
// clamped from below by vsync. A frame costing 4 ms and one costing 15 ms both
// report 16.7 ms on a 60 Hz panel, so headroom is invisible in the interval by
// construction. Degrade works because slowness genuinely stretches the
// interval; restore cannot be the mirror of it. What IS observable is the EMA
// settling back ONTO the floor — that means frames have stopped missing — so
// restore asks for exactly that, and the up-step is verified like the down-step.
// SPIKE_MS is the "this frame is not evidence" cap; SPIKE_RUN is how many
// consecutive over-cap frames stop being a spike and start being the device.
// 3 at <10 fps is ~0.3-0.6 s — long enough that a resume or a GC pause never
// reaches it, short enough that a genuinely slow device is seen almost at once.
// SLOW_CAP is the ceiling on a sample from inside such a run. It is NOT
// SPIKE_MS: clamping a run to 100 would make every sub-10-fps state read as
// exactly 100 ms, and `_pendingVerify` judges a step by whether the EMA MOVED —
// so the governor could see that it was slow but never whether a cut helped,
// and would revert every step it took. 1 s keeps real magnitude across the
// whole 10-fps-to-1-fps range while still bounding a pathological hitch; a tab
// resume never reaches it at all, because one frame is not a run.
const SPIKE_MS = 100;
const SPIKE_RUN = 3;
const SLOW_CAP = 1000;
const DEGRADE_OVER = 2.3;      // degrade at floor+2.3
const RESTORE_WITHIN = 0.6;    // restore once the EMA is back within 0.6 of the floor

// MAKE THE DEGRADE CAUSAL. The derived budget above is the right model but
// takes a couple of seconds to settle; this is the net for while it does, and
// for any cause of capping the model does not anticipate. Every downscale/
// feature-shed step is provisional until the NEXT evaluation: if the EMA did
// not improve by a meaningful margin, the step bought nothing, so fill rate
// was not the bottleneck — revert it and hold off rather than immediately
// repeating the same failed step, which is what turned one bad guess into
// "runs to the bottom of the ladder and stays there for the session".
// VERIFY_MARGIN is deliberately SMALL, not "how much better should this look":
// a genuinely GPU-bound step (fill rate really was the cost) still shows a
// real, if partial, improvement — a 0.1 scale cut rarely halves the frame,
// because plenty of per-frame cost does not shrink with the render target —
// so a margin sized for "meaningfully better" discarded real, working steps
// and re-tried them every cycle, which is a slower version of the exact
// oscillation _downHold exists to prevent (measured while tuning this: at
// margin 2 a genuinely slow device cycled its scale down and back up every
// ~7 s forever instead of settling). A capped clock, by contrast, shows
// ~zero improvement — the frame time was never coupled to the render target
// at all — so even a small margin still tells the two apart.
let _pendingVerify: PendingVerify | null = null;   // the last unverified step
const VERIFY_MARGIN = 0.5;
const VERIFY_COOL = 5000;   // ms: the wait after a step that made things worse

// Feature-shedding tiers: the governor's SECOND stage.
// Resolution scaling can't rescue costs that don't shrink with the render
// target: the per-frame car/lamp shadow depth passes, the env-probe world
// re-render, SSAO's three passes, the god-ray march, the SSR march. When the
// scale has already bottomed out and frames are STILL slow, shed features one
// tier at a time — cheapest visual loss first — and restore them only under
// clear sustained headroom at FULL resolution, so the ladder can't oscillate:
//   1  env probe off        (car paint falls back to the analytic sky mirror)
//   2  lamp spot shadow + SSR march off (dry sheens + car-paint; wet-road SSR survives)
//   3  car sun-shadow map off (the blob contact shadow remains) + wet-road SSR off
//   4  SSAO + god rays + bloom off

// Crash sentinel.
// A jetsam/OOM kill leaves NO signal — no pagehide, no contextlost, no error.
// The only detectable trace is the in-race flag persisted at race start still
// being set at the NEXT boot. Mobile tier only: desktop tabs don't get
// jetsam-killed, and the desktop test suite must never enter safe mode. The
// flag is disarmed whenever the tab is hidden (a background kill is normal iOS
// housekeeping, not our crash) and re-armed on return. Strikes pre-degrade the
// governor at boot so a phone that died mid-race last session starts
// conservative instead of dying the same way again; each cleanly FINISHED race
// pays one strike back down, so a recovered device climbs back to full quality.
//   SENT_ACTIVE  armed at race start.
//   SENT_TICKED  set from tick(), which the shell only calls in race/count. A
//     menu world build arms SENT_ACTIVE too (a reload during SCENE LOADING
//     after Quali left the flag set). Without this, that reload counted as a
//     jetsam kill and two of them pin tier 4 — shader warm then sits on the
//     30 s ceiling. A flag with no tick never entered a session.
//   SENT_BUILD   the build those strikes were earned against. A strike is
//     evidence that THIS CODE killed this device — and the moment the code is
//     replaced that evidence expires. Without this the safe mode is a one-way
//     door: a build that ran the phone out of memory leaves two strikes
//     behind, the floor pins at tier 4 with the render scale pre-dropped to
//     0.7, and the ONLY way back is finishing whole races on a game that now
//     looks broken enough that nobody wants to.
//   SENT_SEEN / SENT_SEEN_BUILD  DIAGNOSTIC ONLY, and deliberately NOT
//     build-keyed: a lifetime count of races that ended without a clean
//     finish, plus the build the last one died on. The strike ledger expires
//     with the code because it drives the quality floor; this one has to
//     outlive a deploy or it cannot answer "is this thing being killed at
//     all", which is the first question any field report asks.
let _crashStrikes = 0;
let _raceTicked = false;   // this document already stamped SENT_TICKED
// Safe-mode floor the governor's restore path can't climb below (per session —
// only strikes paying off across boots lift it): one strike starts with
// lamp-shadow/SSR-class features shed (tier 2), two or more shed the whole
// heavy post stack too (tier 4).
let _perfTierFloor = 0;
let _perfTier = 0;
// How many rungs the GOVERNOR has shed on its own measurements, net of what it
// has restored. This is NOT _perfTier, and the difference is a bug that shipped:
// the degrade branch steps from `_floorTier()`, so on a device whose player had
// chosen GRAPHICS: MEDIUM (_userTier 2) the first measured shed wrote
// `_perfTier = 3` — the governor ADOPTED the preset as its own evidence — and
// the restore branch walks back down only as far as `_floorTier()`, i.e. 2. So
// `autoTier()`, which reads _perfTier, was pinned at >= 2 for the rest of the
// session however completely the device recovered, and every gate spelled
// `autoTier() >= 1` (PER-CHUNK LAMPS and the PER-CHUNK ROAD rider on it) stayed
// off for good.
//
// autoTier() cannot simply be redefined as floor + this count: the degrade
// branch stops once the EFFECTIVE tier reaches 4, so the count saturates at
// `4 - _userTier` and the tier-4 post consumers (bloom, SSAO, god rays) would
// become UNSHEDDABLE on exactly the low presets that most need them shed — the
// post-mortem recorded above autoTier(). So the two answers stay two accessors:
// autoTier() is WHERE THE LADDER STANDS (still _perfTier, still reaches 4), and
// autoShed() is HOW MUCH THE GOVERNOR SHED BY EVIDENCE, which is what a feature
// held off "because this device is missing frames" has to ask.
let _autoShed = 0;
// HOLD THE LADDER. A measurement that compares two captures of the same scene
// (the image-grade tonal tests, lighting-ab's fog glow) is only a measurement of
// the thing it changed if the tier is the same at both captures. On the Metal
// runner it was not: at 26-38 fps the governor stepped 0 -> 2 -> 4 between a
// baseline and its "changed" frame (run 3469). Pinning the scale made it WORSE
// — with the scale lever gone the ladder is the only lever left (see the
// degrade branch). setUserTier() is a floor, so it cannot hold a tier at 0;
// this is the missing pin. Held: no shed, no restore; the scale lever and every
// accessor keep working. Never set by the game itself.
let _tierHold = false;
// THE OPENING WINDOW, recorded so a player's own device can answer a question
// this repo's containers cannot. "WebGPU lags for the first few seconds and
// then runs fine" is a report about frames that have already gone by the time
// anyone can read `perf()`, and every EMA in this file is designed to forget
// them — `_frameEMA` at alpha 0.1 has lost a 400 ms frame within a second.
// So: over the first OPEN_FRAMES after a race starts, keep the single worst
// frame and a count of how many ran over twice the derived budget. Two
// numbers, no allocation, and they survive into perf() for as long as the
// race does.
const OPEN_FRAMES = 600;   // ~10 s at 60 fps, ~20 s at 30
let _openN = 0;
let _openMax = 0;
let _openSlow = 0;
// The USER's floor, from the GRAPHICS preset (./quality-preset.ts). It is a
// third term in tier()'s max(), and that is the whole interaction rule:
//
//   a manual choice sets the FLOOR of degradation, never the ceiling.
//
// The player may always ask for LESS than the governor would run, and never for
// MORE than the device has measurably earned. `_perfTier` is evidence about
// THIS device THIS session (the derived _floorMs budget); `_userTier` is a
// prior, and a prior may narrow the search downward but may not assert the
// device is faster than it measured — GRAPHICS: ULTRA on a thermally throttled
// laptop must not re-enable the god-ray march the governor just proved
// unaffordable. Folding it in HERE rather than at every tier() call site means
// the render path needs no edit at all, and it makes the crash-sentinel floor
// undefeatable by CONSTRUCTION — it is a term in the same max(), so no caller
// can forget to check it.
let _userTier = 0;
// The combined floor nothing may restore below. Both terms are "shed AT LEAST
// this much": one because the device has been crashing, one because the player
// asked for it.
function _floorTier(): number { return Math.max(_perfTierFloor, _userTier); }

function init(g: PerfGfx | null): void {
  perfLog.info("game", "PerfGov.init");
  _gfx = g;
  try { setThermalDrift(store.raw(THERMAL_DRIFT_KEY) === "1"); } catch { /* storage blocked: off */ }
  // Any phone (isMobile), NOT just the memory-safe STANDARD tier (mobileTier):
  // a device that opted into GRAPHICS: HIGH is the one MOST likely to get
  // jetsam-killed, so it needs the crash sentinel + conservative restart too.
  // Desktop stays isMobile=false, so the test suite never enters safe mode.
  if (g && g.isMobile) {
    const st = store;   // raw lane: bare strings, read live, never throws
    const build = String(buildId ?? defaultBuild());
    if (st.raw(SENT_ACTIVE) === "1" && st.raw(SENT_TICKED) === "1") {
      st.rawSet(SENT_SEEN, String((parseInt(st.raw(SENT_SEEN) ?? "", 10) || 0) + 1));
      st.rawSet(SENT_SEEN_BUILD, st.raw(SENT_BUILD) || "?");
    }
    if (st.raw(SENT_BUILD) !== build) {
      // New code, clean slate for the LADDER: a strike is evidence about code
      // that no longer exists, so the safe-mode floor must not outlive it.
      //
      // The ticked-session evidence was recorded first. SENT_ACTIVE is the trace a
      // jetsam kill leaves, and a busy day ships a fresh build every few minutes,
      // so dropping it here wipes the record between a crash and the next launch
      // and `crashStrikes: 0` reads as "no OOM kill has happened", which the
      // field cannot say either way. This counter is DIAGNOSTIC ONLY —
      // it feeds no tier, no floor, nothing the player can feel — so it can
      // survive a deploy without the safe-mode one-way door SENT_BUILD prevents.
      st.rawSet(SENT_BUILD, build);
      st.rawSet(SENT_STRIKES, "0");
      st.rawDel(SENT_ACTIVE);
      st.rawDel(SENT_TICKED);
    }
    _crashStrikes = Math.min(4, parseInt(st.raw(SENT_STRIKES) ?? "", 10) || 0);
    if (st.raw(SENT_ACTIVE) === "1") {
      // Only a session that presented a race/count frame is a crash. A menu
      // world build (Home circuit after Quali, race-settings flyby) arms the
      // same flag and a reload mid-build must not spend a strike.
      if (st.raw(SENT_TICKED) === "1") {
        _crashStrikes = Math.min(4, _crashStrikes + 1);
        st.rawSet(SENT_STRIKES, String(_crashStrikes));
      }
      st.rawDel(SENT_ACTIVE);
    }
    st.rawDel(SENT_TICKED);
  }
  _perfTierFloor = _floorFromStrikes(_crashStrikes);
  _perfTier = _perfTierFloor;
  _autoShed = 0;
  // Two strikes: the phone was killed twice, so boot with the smallest backing store too.
  if (_crashStrikes >= 2 && g && g.isMobile && typeof g.capDpr === "function") g.capDpr(1);
}

// ONE owner for the strikes -> floor mapping, shared by init and cleanRace(), so
// paying a strike down moves the floor with the counter (see cleanRace()).
function _floorFromStrikes(n: number): number { return n >= 2 ? 4 : (n >= 1 ? 2 : 0); }

// RE-ARM WITHOUT THE RESET. A tab RETURN is not a race start: dragging the
// boot-window reset along snapped _frameEMA and _floorMs back to 16.7 on a
// device whose budget the governor had already derived. On a 30 Hz capped
// display (Low Power Mode) that re-armed the exact "degrade a capped clock" bug
// _floorMs exists to prevent — one scale step down, a revert 45 frames later,
// two visible target re-allocs per app switch — and it made openWindow()
// describe the last un-hide instead of the race start. This only re-arms the
// sentinel.
function sentinelResume(): void {
  // A CLIMB CANNOT BE ON PROBATION ACROSS TIME NOBODY MEASURED. `_sinceUp`
  // ages only inside tick(), which never runs while the tab is hidden, so a
  // climb accepted before a ten-minute background stint came back reading as
  // seconds old — and the first cut after the resume then charged it the full
  // doubling penalty for load the climb was never tested against. That is the
  // same reasoning that keeps this function from resetting the EMAs: a tab
  // return is not evidence. Drop the probation instead of charging it.
  _sinceUp = -1;
  if (!_gfx || !_gfx.isMobile) return;
  store.rawSet(SENT_ACTIVE, "1");
}
function sentinelArm(on: boolean): void {
  // Race start / return to a live session: re-open the boot window described
  // at `_live` — both averages restart from their shared 16.7 so the EMA can
  // outrun the floor once more. Desktop too (above the mobile-only guard):
  // the governor runs everywhere, only the sentinel is mobile.
  // _scaleMoves resets with the race so every race gets one prompt cut; the
  // confirmation gate then applies to the repeats within it. The ceiling and
  // the probation reset with it for the same reason: a new race is a fresh
  // device, and neither half may carry a verdict into it.
  if (on) { _frameEMA = _floorMs = 16.7; _slowRun = 0; _openN = 0; _openMax = 0; _openSlow = 0;
            // Evaluation and verification state is race-local too. A quality
            // change late in the previous race can leave a five-second
            // cooldown behind; carrying it across the menu spends the next
            // race's only opening window while the derived floor catches the
            // slow frame cost. A provisional verdict from the previous circuit is
            // equally invalid against the new race's reset averages.
            _govT = 0; _govCool = 0; _govCoolMs = 0; _pendingVerify = null;
            _sinceUp = -1; _scaleCap = Infinity; _capProbeMs = CLIMB_SURVIVE_MS;
            _scaleMoves = 0; _degradeArm = 0;
            // A futile ladder measured in a DRY race must not block the next (wet) race's shed.
            _tierFutile = false; _scaleFutile = false; } else _live = false;
  if (!_gfx || !_gfx.isMobile) return;
  if (on) {
    _raceTicked = false;
    store.rawDel(SENT_TICKED);
    store.rawSet(SENT_ACTIVE, "1");
  } else {
    _raceTicked = false;
    store.rawDel(SENT_ACTIVE);
    store.rawDel(SENT_TICKED);
  }
}
function cleanRace(): void {
  sentinelArm(false);
  if (_crashStrikes > 0) {
    _crashStrikes--;
    store.rawSet(SENT_STRIKES, String(_crashStrikes));
    // RECOMPUTE THE FLOOR. Paying a strike down must move the floor, not just
    // the counter, or _perfTierFloor stays at whatever init() derived for the
    // WHOLE session. One strike floors the tier at 2, and tier() >= 2 is exactly
    // the gate that sheds SSR (the dry sheens; the WET MIRROR at 3) and lamp shadows,
    // while tier() >= 1 sheds PER-CHUNK LAMPS and the env probe — so a single
    // crash (or one sentinel trip that was never a crash) would pin those
    // features off until a reload, whatever GRAPHICS says.
    // clearStrikes() recomputes the floor the same way; both paths then release
    // `_perfTier` to the new floor so they cannot drift apart.
    _perfTierFloor = _floorFromStrikes(_crashStrikes);
    // The floor just dropped. _perfTier may be sitting on the OLD one (the
    // degrade branch steps from _floorTier(), so it absorbs whatever floor was
    // live when it fired). Release it to the new floor and let the governor
    // re-earn any shed from its own measurements.
    if (_perfTier > _floorTier()) { _perfTier = _floorTier(); _autoShed = 0; }
  }
}

// Bounded raw-frame history supplements the EMA: occasional hitches must not
// disappear from diagnostics just because the next second was smooth.
const frameHistory = new Float64Array(2048);
let frameCursor = 0, frameCount = 0, droppedSimS = 0, physicsSteps = 0;
function resetFrameStats(): void { if (_drift) _drift.reset(); frameCursor = 0; frameCount = 0; droppedSimS = 0; physicsSteps = 0; }
function recordSimulation(steps: number, dropped: number): void {
  physicsSteps += Math.max(0, steps || 0); droppedSimS += Math.max(0, dropped || 0);
}
function frameStats(): FrameStats {
  const a = Array.from(frameHistory.subarray(0, frameCount)).sort((x, y) => x - y);
  const q = (p: number): number => a.length ? a[Math.ceil((a.length - 1) * p)] as number : 0;
  return { frames: a.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), maxMs: q(1),
    droppedSimS, physicsSteps, windowFrames: frameHistory.length };
}

function tick(dtMs: number): void {
  // First race/count sample: the session existed. A menu world build arms
  // SENT_ACTIVE but never reaches here (the shell gates tick on race/count).
  if (!_raceTicked && _gfx && _gfx.isMobile) {
    _raceTicked = true;
    try { store.rawSet(SENT_TICKED, "1"); } catch { /* storage blocked: next boot will not count this session */ }
  }
  if (Number.isFinite(dtMs) && dtMs > 0) {
    frameHistory[frameCursor] = dtMs; frameCursor = (frameCursor + 1) % frameHistory.length;
    frameCount = Math.min(frameHistory.length, frameCount + 1);
  }
  // `_autoRes` gates the RESOLUTION stage ONLY — it must not return early here,
  // or a user-facing control silently disables a safety system: RESOLUTION:
  // LOW/MED/HIGH calls setAutoRes(false) to stop the governor fighting the
  // pinned scale, and an early return takes stage 2 down with it. A player who
  // pins the resolution — a control shown to EVERYONE, desktop included —
  // would get no feature shedding at all for the session: `_perfTier` frozen at
  // whatever init() left it, and a pre-degraded crash floor never paid back
  // down (cleanRace() alone does not move `_perfTier`).
  // Pinning the resolution is a statement about SHARPNESS, not a request to
  // stop adapting; it makes stage 2 MORE important, not less, because the
  // cheaper lever is now unavailable. So the EMA and the derived floor are
  // tracked unconditionally (stage 2 judges against the same budget and needs
  // the data), and `_autoRes` is consulted only at the two places that actually
  // move the scale.
  // Ignore huge spikes (tab resume, GC): they'd yank the scale. But a SPIKE is
  // one frame: a bare `if (dtMs < SPIKE_MS)` that drops every sample above the
  // cap makes the governor BLIND ON EXACTLY THE DEVICES IT EXISTS FOR. Below
  // ~10 fps every frame is over the cap, nothing reaches the EMA, and
  // `_frameEMA` sits at the 16.7 that sentinelArm() left it: the governor reads
  // 59.9 fps, `degradeAt` is never crossed, and the whole ladder stays parked
  // at tier 0 during a slideshow. Measured 2026-09-02 in a live browser
  // (bahrain, GLX): 2 rAF frames in 17.5 s — 0.11 fps real — while
  // perf() reported `{fps: 59.9, floorMs: 16.7, tier: 0, scale: 1}`.
  //
  // A backgrounded tab cannot fake a run: the shell pauses on hide and the
  // tick call site is gated on `!paused`, so Chrome's ~1 Hz background rAF
  // throttle never reaches the governor at all.
  // So: keep discarding an ISOLATED over-cap frame (tab resume, a GC pause),
  // and stop discarding a RUN of them. SPIKE_RUN consecutive slow frames is not
  // a spike, it is the device's actual speed, and from there the sample is fed
  // clamped to SLOW_CAP — enough for the EMA to outrun the floor and trip
  // `degradeAt`, and to still MOVE when a step helps, without letting a
  // pathological hitch enter at its full value.
  _live = true;
  // A zero / negative / NaN interval is a stamp artefact (pause -> resume: lastFrame is set in a handler, so the next rAF stamp can be earlier), not a frame: fed to the EMA and the derived floor it drags the floor under every healthy frame and trips a spurious step-down (then a revert). The history above already skips it.
  if (!(dtMs > 0)) return;
  if (_drift && dtMs < SPIKE_MS && _drift.feed(dtMs) && driftStep()) _drift.stepped();
  // Before any smoothing: the opening window wants the raw frame, spikes and
  // all, because a spike in the first seconds IS the thing being reported.
  if (_openN < OPEN_FRAMES) {
    _openN++;
    if (dtMs > _openMax) _openMax = dtMs;
    if (dtMs > _floorMs * 2) _openSlow++;
  }
  if (dtMs < SPIKE_MS) {
    _slowRun = 0;
    _frameEMA += (dtMs - _frameEMA) * 0.1;
    _floorMs += (dtMs - _floorMs) * (dtMs < _floorMs ? FLOOR_DOWN_A : FLOOR_UP_A);
  } else if (++_slowRun >= SPIKE_RUN) {
    const s = Math.min(dtMs, SLOW_CAP);
    _frameEMA += (s - _frameEMA) * 0.1;
    _floorMs += (s - _floorMs) * (s < _floorMs ? FLOOR_DOWN_A : FLOOR_UP_A);
  }
  const stepMs = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, COOL_STEP_MAX_MS) : 16.7;
  // Clamped at 0: the restore gate below tests `_downHold === 0`, and a ms
  // decrement overshoots where a frame count landed exactly.
  if (_downHold > 0) _downHold = Math.max(0, _downHold - stepMs);   // recovery hold runs down in wall time
  // The survival clock runs on the same wall time as the holds, and for the
  // same reason: a promise made in seconds must not run twice as fast on a
  // 120 Hz display. Before the cooldown returns below, so a climb keeps ageing
  // while the governor is not evaluating. Reaching the window means the climb
  // was real — release the patience the refusals bought and stop watching it.
  if (_sinceUp >= 0 && (_sinceUp += stepMs) >= CLIMB_SURVIVE_MS) { _sinceUp = -1; _upBackoff = UP_BACKOFF_MIN; }
  // Headroom has to be UNBROKEN to age the ceiling: any frame back over the
  // restore threshold restarts the two minutes, so a device that is merely
  // between heavy sections never probes its way back up.
  if (_scaleCap <= 1) {
    if (_frameEMA < _floorMs + RESTORE_WITHIN) {
      if ((_capProbeMs -= stepMs) <= 0) { _scaleCap = Infinity; _armCapProbe(); }
    } else _armCapProbe();
  }
  if (_govCoolMs > 0) { _govCoolMs = Math.max(0, _govCoolMs - stepMs); return; }
  if (_govCool > 0) { _govCool--; return; }   // a verify window: frames, so the EMA has its samples
  if (++_govT < 45) return;   // evaluate ~every 45 frames (an EMA settling span, not a clock)
  _govT = 0;

  // Verify the last step before taking a new one.
  if (_pendingVerify) {
    const v = _pendingVerify; _pendingVerify = null;
    // A DOWN step is a bet that frames get cheaper: revert unless the EMA fell
    // by at least VERIFY_MARGIN. An UP step is the opposite bet — that the
    // headroom was real — so it is judged the other way round: revert if the
    // EMA got WORSE by that margin. Same instrument, mirrored, because a step
    // that made things worse should be undone whichever direction it went.
    const failed = v.up ? (_frameEMA > v.ema + VERIFY_MARGIN)
                        : (_frameEMA > v.ema - VERIFY_MARGIN);
    if (failed) {
      // Env may already be off while bloom is still expensive. Test the next
      // rung before declaring the whole ladder futile. Keep the original
      // baseline and rollback state: small cumulative gains must count, and
      // a capped clock must get ALL its quality back if no rung helps.
      // Continue this bounded probe even if the floor adapted during verify;
      // otherwise a slow steady frame closes the gate before later rungs run.
      if (v.kind === "tier" && !v.up && _perfTier < 4) {
        _perfTier++; _autoShed++; _pendingVerify = v; _govCool = 90;
        return;
      }
      if (v.kind === "scale") {
        gfx().setRenderScale(v.prev);
        // The rung it just refused is a measured ceiling, not only a reason to wait.
        if (v.up && v.next) { _scaleCap = Math.min(_scaleCap, v.next); _armCapProbe(); }
        // A DOWN step that bought nothing means this frame is not fill-bound,
        // so stepping the scale again would revert again. Fall through to the
        // feature ladder on the next evaluation instead of re-testing a lever
        // this device has just answered for. (An UP step failing says the
        // opposite — there was no headroom — and implies nothing about fill.)
        if (!v.up) _scaleFutile = true;
      } else { _perfTier = v.prev; _autoShed = v.shed; if (!v.up) _tierFutile = true; }
      _govCoolMs = VERIFY_COOL;
      // A failed UP step is the device saying "no headroom". Without a hold
      // the restore gate (EMA under the floor, _downHold 0) was true again
      // one cooldown later, so restore → verify-fail → revert cycled every
      // ~10 s for the whole race — with the scale lever that is a full
      // render-target reallocation each time. Back off: each refused climb
      // doubles the wait before the next try (10 s, 20 s, 40 s, … 2 min).
      if (v.up) { _sinceUp = -1; _downHold = _upBackoff; _upBackoff = Math.min(_upBackoff * 2, UP_BACKOFF_MAX); }
      return;
    }
    // A climb that passed its verify is still ON PROBATION: the survival clock
    // above, not this one evaluation, is what restores the backoff.
  }

  const degradeAt = _floorMs + DEGRADE_OVER, restoreAt = _floorMs + RESTORE_WITHIN;
  const g = gfx();
  const cur = g.getRenderScale ? g.getRenderScale() : 1;
  // ONE SPIKE IS NOT A TREND. Every scale change reallocates all HDR/bloom
  // targets, and three.js disposes each post texture and the depth texture
  // before reallocating, so the node renderer rebuilds the post chain's bind
  // groups too — a visible hitch either way. Acting on a single evaluation
  // therefore spends a hitch on any load spike, and a race is made of them: a
  // restart with the field bunched, rain arriving, a pile-up spawning debris.
  //
  // MEASURED against the real tick() over ten simulated minutes. Steady load
  // never degrades at all, and neither does a smooth swing of up to 12 ms
  // (_floorMs is derived, so it rises to meet sustained cost — the EMA came
  // within 1.1 ms of the threshold and never crossed). But load that STEPS
  // faster than the floor estimator adapts produced 35-83 reallocations per ten
  // minutes, gaps of 1-5 s: exactly "a lag spike every few seconds". Requiring
  // the condition twice took the same six cases from 424 reallocations to 126,
  // and to ZERO wherever the step was 10 ms or less, while still degrading on
  // genuinely sustained overload. A doubling backoff on held climbs was also
  // measured and is noise (424 -> 383), so it is not here.
  // THE FIRST CUT OF A RACE STAYS PROMPT. A device that is slow from lights-out
  // is catchable only for about frames 10-95 — the EMA (alpha 0.1) outruns the
  // derived floor (0.02 upward) for that long and then the floor catches up and
  // a steady cost reads as an external cap for good. That window is barely two
  // evaluations wide, so confirming inside it means never degrading such a
  // device at all; tests/unit/perf/governor.test.ts pins exactly that case.
  // Confirmation is therefore only asked of REPEAT cuts, which is where the
  // oscillation lives: one spike costs at most one reallocation per race
  // instead of dozens.
  if (_frameEMA <= degradeAt) _degradeArm = 0;
  else if (_scaleMoves > 0 && ++_degradeArm < DEGRADE_CONFIRM) return;
  if (_frameEMA > degradeAt) {                 // meaningfully slower than THIS device's own floor: degrade PROMPTLY
    // With the scale PINNED (_autoRes false) the ladder is the only lever left,
    // so fall straight through to shedding instead of skipping the evaluation.
    // THE RENDERER'S BOOLEAN IS THE "SCALE LEVER EXHAUSTED" SIGNAL — ask it,
    // don't predict it from `cur > 0.5`. Traced in floats: stepping 1.0 by -0.1
    // gives 1 -> 0.9 -> 0.8 -> 0.7000000000000001 -> 0.6000000000000001 ->
    // 0.5000000000000001. That last value is one ULP ABOVE 0.5, so `cur > 0.5`
    // is true forever; setRenderScale then clamps the request to 0.5 and
    // rejects it as a 1.1e-16 change against its own 0.02 dead zone; and if
    // the shed were an `else if` of that outer test it would never be
    // evaluated — no tier would ever be shed by evidence.
    // Using the return value removes the epsilon dependency entirely rather than
    // chasing the constant; the governor test pins that boolean as the gfx
    // contract tick() relies on.
    let stepped = false;
    if (_autoRes && cur > 0.5 && !_scaleFutile) stepped = !!g.setRenderScale(cur - 0.1);
    if (stepped) {
      _pendingVerify = { kind: "scale", prev: cur, ema: _frameEMA };
      _scaleCap = cur; _armCapProbe();   // this resolution missed the budget
      // _chargeCut() returns the plain 10 s hold unless this cut is undoing a
      // climb still on probation, so it subsumes the constant it replaces.
      _govCool = 30; _downHold = _chargeCut(); _scaleMoves++; _degradeArm = 0;
    } else if (!_tierHold && _perfTier < 4 && _perfTierFloor < 4 && !_tierFutile) {   // scale lever exhausted — shed a feature (a crash floor of 4 has already shed everything this ladder can)
      // Step from the EFFECTIVE tier, not from _perfTier alone. A rung at or
      // below the floor (crash sentinel, or the player's GRAPHICS preset) is
      // already shed, so incrementing onto it changes nothing the EMA can see:
      // the causal check would read "this step bought nothing", revert it, and
      // re-try the same dead rung every cycle while frames keep missing —
      // _pendingVerify's own failure mode, reached from a direction it cannot
      // distinguish, because the step genuinely did not help and the reason
      // (redundant, not mis-targeted) is invisible to a frame-time delta.
      // Skipping to floor+1 guarantees every step is one that can be felt.
      //
      // THE GUARD READS _perfTier, NOT THE EFFECTIVE TIER, and that is the
      // whole point. Gating on `Math.max(_perfTier, _floorTier()) < 4` made
      // GRAPHICS: LOW (_userTier 4, so _floorTier() 4) false on its very first
      // evaluation: _perfTier and _autoShed could never leave 0, so autoTier()
      // and autoShed() — which exclude the user floor ON PURPOSE — returned 0
      // for the whole session and bloom, SSAO, god-rays, contact shadows and
      // per-chunk lamps were UNSHEDDABLE on the preset that exists to make the
      // game cheap. Stepping still starts from the floor, so LOW takes one felt
      // 0 -> 4 step and every other preset behaves exactly as before.
      _pendingVerify = { kind: "tier", prev: _perfTier, shed: _autoShed, ema: _frameEMA };
      _perfTier = Math.min(4, Math.max(_perfTier, _floorTier()) + 1); _autoShed++; _govCool = 90; _downHold = _chargeCut();
      // A shed rung changes what the frame is bound BY, so let the scale lever
      // prove itself again from the new baseline rather than staying latched
      // off for the session on one old measurement. The measured ceiling was
      // taken against the OLD feature set and stops meaning anything here too.
      _scaleFutile = false;
      _scaleCap = Infinity; _armCapProbe();
    }
  } else if (_frameEMA < restoreAt && _downHold === 0) {   // clear, SETTLED headroom (~10 s since the last cut): restore slowly
    _scaleFutile = false;   // headroom is back — nothing about the old verdict still applies
    _tierFutile = false;
    // The up-step is VERIFIED like the down-step. Restoring is a guess that the
    // headroom is real, and the same _pendingVerify machinery that reverts a
    // useless cut reverts a premature restore one evaluation later — without
    // it, a governor that can finally go up could climb straight back into the
    // frame misses it just escaped, which is the oscillation the header warns
    // about arriving from the other side.
    // SAME SHAPE AS THE DEGRADE BRANCH, and for the same reason. Climbing from
    // the floor at +0.06 reaches 0.9800000000000004, and the next request —
    // Math.min(1, cur + 0.06) === 1 — is a delta of 0.019999999999999574, just
    // under setRenderScale's 0.02 dead zone, so it is rejected and the scale
    // pins at 0.98 for the session. Falling through on a rejected step lets the
    // ladder restore.
    // THE SNAP HAS TO HAPPEN A STEP EARLY, not at the end. The last 0.02 of the
    // range is unreachable by any step that starts inside it. So snap when the
    // remaining gap is under one and a half steps and take it in one move,
    // which clears the zone (the recovery test asserts it lands on exactly 1).
    let stepped = false;
    // One down-step below the lowest scale MEASURED as missing: climbing into
    // that gap only hands the next heavy section something to take back. The
    // margin belongs to a measurement, never to the default — subtracting it
    // from an untouched ceiling would pin every healthy device at 0.9.
    const ceil = _scaleCap > 1 ? 1 : Math.max(0.5, _scaleCap - 0.1);
    if (_autoRes && cur < ceil - 1e-9) {
      // HALVE THE GAP, don't crawl it. A fixed +0.06 needs eight steps to get
      // from the 0.5 floor back to full — eight target reallocations, eight
      // hitches, to undo one cut — and the crawl was the only thing protecting
      // the climb from overshooting, because nothing remembered a scale that
      // had already missed. `_scaleCap` is that memory now, so a bigger step is
      // the SAFER one: it converges on the ceiling in four, and a step that
      // does overshoot is reverted by the same verify and lowers the ceiling
      // onto the rung it refused, which a crawl never learned to do.
      // SNAP FROM ONE DOWN-STEP OUT, not from 0.09. The threshold has to clear
      // the width of a CUT (0.1) or the commonest climb there is — undoing a
      // single cut, 0.9 back to 1.0 — costs two reallocations instead of one.
      // Every snap delta this admits is at least 0.03, still far outside
      // setRenderScale's 0.02 dead zone.
      const gap = ceil - cur;
      const next = gap < 0.12 ? ceil : Math.min(ceil, cur + Math.max(0.06, gap / 2));
      stepped = !!g.setRenderScale(next);
      if (stepped) {
        _pendingVerify = { kind: "scale", prev: cur, next, ema: _frameEMA, up: true };
        _govCoolMs = 4000; _sinceUp = 0;
      }
    }
    // Features come back only at full res under the same sustained headroom,
    // one per ~4 s. tier() retains both floors even when a measured post cut
    // taken AT the user's floor is released; the crash floor is never lifted.
    if (!stepped && !_tierHold && (_perfTier > _floorTier() || (_autoShed > 0 && _perfTier > _perfTierFloor))) {
      _pendingVerify = { kind: "tier", prev: _perfTier, shed: _autoShed, ema: _frameEMA, up: true };
      // LOW starts at its preset floor: its measured post/lamp cut still
      // needs recovery. tier() keeps the preset and crash floors intact.
      if (_perfTier > _floorTier()) {
        _perfTier--; if (_autoShed > 0) _autoShed--;
      } else { _perfTier = _perfTierFloor; _autoShed = 0; }
      _govCoolMs = 4000; _sinceUp = 0;
    }
  }
}

// #2652 thermal drift (opt-in, a26.thermalDrift=1): a phone that heats up gets
// slower minutes before frames MISS, so ThermalDrift's slow-drift detector may take
// ONE existing rung early. It is the degrade branch minus the verify: the step is
// a bet on the future, not on the next EMA, so a verify would revert it at once.
// _scaleCap = cur keeps the restore gate from climbing straight back; the cap
// ages out on unbroken headroom exactly as for a measured miss.
let _drift: Drift | null = null;
function setThermalDrift(on: boolean): void {
  _drift = on ? thermalDrift() : null;
}
function driftStep(): boolean {
  if (_pendingVerify || _govCoolMs > 0 || _govCool > 0) return false;   // mid-verify or cooling: ask again next window
  const g = gfx();
  const cur = g.getRenderScale ? g.getRenderScale() : 1;
  if (_autoRes && cur > 0.5 && !_scaleFutile && g.setRenderScale(cur - 0.1)) {
    _scaleCap = cur; _armCapProbe(); _govCool = 30; _downHold = _chargeCut(); _scaleMoves++;
    return true;
  }
  if (!_tierHold && _perfTier < 4 && _perfTierFloor < 4 && !_tierFutile) {
    _perfTier = Math.min(4, Math.max(_perfTier, _floorTier()) + 1); _autoShed++; _govCool = 90; _downHold = _chargeCut();
    _scaleCap = Infinity; _armCapProbe();
    return true;
  }
  return false;
}

// Forget the crash history and lift the floor NOW, without waiting for whole
// finished races to pay it down one at a time. The escape hatch behind the
// debug API's safeMode(false).
function clearStrikes(): void {
  _crashStrikes = 0;
  _perfTierFloor = _floorFromStrikes(_crashStrikes);
  // Same latch release as cleanRace(): lifting the floor alone leaves
  // `_perfTier` on evidence earned under the old floor, so tier() stays high
  // after safeMode(false) until a reload. Drop to the new floor so the device
  // can prove itself again (governor may re-shed if frames still miss).
  if (_perfTier > _floorTier()) { _perfTier = _floorTier(); _autoShed = 0; }
  store.rawSet(SENT_STRIKES, "0"); store.rawDel(SENT_ACTIVE);
  store.rawDel(SENT_TICKED);
}

return {
  init, tick, setThermalDrift, thermalDrift: () => _drift && _drift.state(), frameStats, recordSimulation, resetFrameStats, sentinelArm, sentinelResume, cleanRace, clearStrikes,
  tier: () => Math.max(_perfTierFloor, _userTier, _perfTier),
  // Crash + measured only — no GRAPHICS user floor. Look-defining post
  // (bloom / SSAO / god-rays / contact / lamp volumetrics) reads this so
  // GRAPHICS: LOW still sheds env/SSR/shadows via tier() but the lighting
  // tuner stays live unless the device proved it cannot afford the pass.
  // READS _perfTier ON PURPOSE: a draft that derived the governor tier as
  // (floor + its own shed count) capped the count at 4 - _userTier, so this
  // returned 2 on MEDIUM and 0 on LOW and the tier-4 post became UNSHEDABLE
  // however badly the device was missing frames. _perfTier is the effective
  // tier and can always climb to 4, so the tier-4 consumers stay reachable on
  // every preset.
  autoTier: () => Math.max(_perfTierFloor, _perfTier),
  // What the GOVERNOR shed on its own measurements, plus the crash floor, and
  // nothing the player asked for. The gate for anything held off "because this
  // device is actually missing frames" — see _autoShed for why this is a second
  // accessor rather than a redefinition of autoTier().
  autoShed: () => Math.max(_perfTierFloor, _autoShed),
  tierFloor: () => _perfTierFloor,
  userTier: () => _userTier,
  // Clamped to the ladder's own range so a bad preset id can't invent a tier 7
  // that every `tier() >= N` gate would satisfy. Drops a pending TIER verify for
  // the same reason setAutoRes drops a pending SCALE one: _pendingVerify
  // attributes the next EMA delta to the governor's own last provisional step,
  // so a user changing quality one evaluation later would make the governor
  // revert a step that was actually working.
  setUserTier: (n: number) => {
    const t = Math.max(0, Math.min(4, n | 0));
    if (t === _userTier) return;
    const prev = _userTier;
    _userTier = t;
    _tierFutile = false;   // a new preset changes what a step means
    _scaleCap = Infinity; _armCapProbe();   // ...and what the frame costs, so the measured ceiling expires with it
    // RAISING QUALITY MUST RELEASE WHAT THE OLD PRESET CAUSED. The degrade
    // branch steps from _floorTier(), which folds in _userTier, so a shed taken
    // while the player sits on MEDIUM writes _perfTier = 3 — the governor
    // adopting the preset as its own evidence, exactly what the note below
    // forbids. Without this, GRAPHICS is one-way on a phone (default MEDIUM):
    // raising to HIGH leaves tier() at 3, so SSR, per-chunk lamps and both
    // shadow maps stay off until a reload. Dropping to the new floor on a
    // RAISE gives the device a clean chance to prove itself; if it still cannot
    // hold the budget the governor re-sheds within a couple of evaluations, on
    // its own measurements.
    if (t < prev && _perfTier > _floorTier()) { _perfTier = _floorTier(); _autoShed = 0; }
    // _perfTier is deliberately NOT touched otherwise. It is the governor's OWN
    // evidence-based tier; the floors are applied at READ time in tier(). An
    // earlier draft pulled _perfTier up to the new floor, which conflated "shed
    // because the device struggled" with "shed because the player asked" — and
    // then lowering the preset could not release what the preset itself had
    // caused. The redundant-step problem that motivated the pull-up is solved
    // where it actually lives, in the degrade branch, which skips rungs the
    // floor already covers.
    if (_pendingVerify && _pendingVerify.kind === "tier") _pendingVerify = null;
    if (_live) _govCoolMs = Math.max(_govCoolMs, VERIFY_COOL);   // see _live: never before the first race tick
  },
  strikes: () => _crashStrikes,
  // The lifetime, NOT build-keyed, kill count — see SENT_SEEN. `strikes` can be
  // 0 on a device that has been killed repeatedly, because a deploy resets it;
  // this cannot.
  crashSeen: () => {
    try {
      return { seen: parseInt(store.raw(SENT_SEEN) ?? "", 10) || 0, lastBuild: store.raw(SENT_SEEN_BUILD) || null };
    } catch { return { seen: 0, lastBuild: null }; }
  },
  // {frames, maxMs, slow} for the first OPEN_FRAMES of the current race — the
  // instrument for a "laggy at first, fine afterwards" report. See _openN.
  openWindow: () => ({ frames: _openN, maxMs: +_openMax.toFixed(1), slow: _openSlow }),
  fpsEMA: () => _frameEMA,
  floorMs: () => _floorMs,
  // THE TWO LATCHES THAT CAN DISABLE A LEVER FOR THE REST OF THE SESSION,
  // exported rather than left private so "why did this device shed nothing?"
  // is answerable from a hook, not by re-deriving this file's state by hand.
  // A latch is not a fault on its own: the restore branch clears both the
  // moment headroom returns, so reading them TRUE means a lever is currently
  // parked, not that it is broken. Read them beside floorMs and autoShed.
  scaleFutile: () => _scaleFutile,
  tierFutile: () => _tierFutile,
  autoRes: () => _autoRes,
  // Drop any unverified SCALE step on the way in or out of manual resolution.
  // _pendingVerify holds {kind:"scale", prev} and the next evaluation would
  // "revert" it by calling setRenderScale(prev) — writing over the scale the
  // user just pinned, one evaluation after they pinned it. The tier half of a
  // pending verify is still valid (the ladder keeps running either way), so
  // only the scale kind is dropped. The cooldown gives the EMA time to settle
  // at the new scale before stage 2 judges anything against it.
  setAutoRes: (on: boolean) => {
    _autoRes = !!on;
    if (_pendingVerify && _pendingVerify.kind === "scale") _pendingVerify = null;
    if (_live) _govCoolMs = Math.max(_govCoolMs, VERIFY_COOL);   // see _live: never before the first race tick
  },
  // The ladder pin described at _tierHold. Same pending-verify hygiene as
  // setAutoRes, for the TIER kind: a provisional step must not be "reverted"
  // by the evaluation after the hold lands, and releasing the hold must not
  // let a stale verdict from before it revert a rung either.
  tierHold: () => _tierHold,
  setTierHold: (on: boolean) => {
    _tierHold = !!on;
    if (_pendingVerify && _pendingVerify.kind === "tier") _pendingVerify = null;
    if (_live) _govCoolMs = Math.max(_govCoolMs, VERIFY_COOL);
  },
  // SwiftShader / llvmpipe / soft-blit paths: intro shortcuts and one shared
  // race-entry budget (./race-entry-profile.ts) read this instead of guessing from tier.
  softwareRaster() {
    try {
      const s = _gfx && _gfx.backendState && _gfx.backendState();
      return !!(s && (s.softwareGL || s.softAdapter));
    } catch { return false; }
  },
};
}

/** The shared governor (f1-game's global `PerfGov`). */
export const perfGov: PerfGov = createPerfGov();

export interface ScaleGfxOptions {
  isMobile: boolean;
  /** Apply a backing-store pixel ratio: renderer.setPixelRatio + setSize (TrackRenderer.resize). */
  apply(pixelRatio: number): void;
  /** The device pixel ratio (default window.devicePixelRatio). */
  dpr?: () => number;
  /** The starting DPR cap (f1-game tlx.js:1103: 1.5 on the mobile memory tier, else 2). */
  dprCap?: number;
  backendState?: () => PerfBackendState | null;
}

/**
 * A `PerfGfx` over a three.js renderer's pixel ratio: f1-game's TLX
 * setRenderScale / capDpr contract verbatim (js/render/three/tlx.js:4251-4261),
 * clamp 0.5..1, a 0.02 dead zone the governor's float chain relies on, and a
 * DPR cap that only ever lowers. Backing-store ratio = min(dpr, cap) * scale.
 */
export function createScaleGfx(opts: ScaleGfxOptions): PerfGfx & { pixelRatio(): number } {
  let renderScale = 1;
  let DPR_CAP = opts.dprCap ?? 2;
  const dpr = opts.dpr ?? (() => (typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1));
  const pixelRatio = (): number => Math.min(dpr(), DPR_CAP) * renderScale;
  const resizeNow = (): void => { opts.apply(pixelRatio()); };
  const out: PerfGfx & { pixelRatio(): number } = {
    isMobile: opts.isMobile,
    setRenderScale(s) {
      const v = Math.min(1, Math.max(0.5, +s || 0));
      if (Math.abs(v - renderScale) < 0.02) return false;   // PerfGov contract
      renderScale = v; resizeNow(); return true;
    },
    getRenderScale: () => renderScale,
    // Only ever lowers (#1641): the scene targets shrink with dpr^2.
    capDpr(n) {
      if (!(n >= 1) || n >= DPR_CAP) return false;
      DPR_CAP = n; resizeNow(); return true;
    },
    pixelRatio,
  };
  if (opts.backendState) out.backendState = opts.backendState;
  return out;
}

/**
 * The debug API's perf()/renderScale() reading (f1-game js/agent/apex.js:1623),
 * the shape ./metrics-overlay.ts `sources.perf` and ./phone-recorder.ts read.
 */
export function renderScaleReport(gov: PerfGov, g: Pick<PerfGfx, "getRenderScale"> | null) {
  return {
    scale: g && g.getRenderScale ? g.getRenderScale() : 1,
    fps: +(1000 / Math.max(1, gov.fpsEMA())).toFixed(1), floorMs: +gov.floorMs().toFixed(1), auto: gov.autoRes(),
    tier: gov.tier(), autoTier: gov.autoTier(), autoShed: gov.autoShed(), open: gov.openWindow(), frameTimes: gov.frameStats(),
    userTier: gov.userTier(), tierFloor: gov.tierFloor(), crashStrikes: gov.strikes(), scaleFutile: gov.scaleFutile(),
    tierFutile: gov.tierFutile(), tierHold: gov.tierHold(),
  };
}
