// CarFx: per-car motion effects the render loop asks for once a car's grounded basis is
// built — the PLANK SPARKS a car throws when its floor bottoms out, an AI car's LOCK-UP
// MARKS, and the EXHAUST HEAT HAZE anchor for the post chain.
//
// Port of f1-game js/fx/car-fx.js:1-154, verbatim. `CarFx.create(G, {skids, Particles})`
// is `createCarFx({vTop, skids, particles})`: G was read only for `G.vTop()`, and the
// Particles global fallback is gone (pass the instance). `PhysicsConsts` is the physics
// lane's ../physics/consts.ts. `Log.info` dropped.
//
// The split with physics: physics DECIDES (body-attitude writes c.baScrape / c.baPitch,
// AI driving writes c.wheelLock, the drivetrain c.rpm / c.deploying / c.wasOnThrottle);
// this module only READS those fields and emits. It writes no car field.
//
// f1-game header (car-fx.js:1-24): Visual only: it READS car state and writes none of
// it. The plank's input is c.baScrape — js/physics/body-attitude.js's measure of how far
// dive, heave compression and the aero ride-height drop pushed the floor past the point
// where the skid blocks rub — gated on the car's speed as a fraction of its envelope
// (vStd: PACE scales ground speed, so "fast enough to spark" is a share of top speed,
// not a raw m/s). The embers come out where the floor is lowest: the nose on a brake
// dive, the tail on a squat, the middle in a compression (Particles.scrape, which
// refuses past 60 % of the pool).
//
// The lock-up marks: until 2026-10-02 only the player stamped tyre marks, so an AI's
// lock-up (c.wheelLock, AiDrive's mistake phase) smoked and froze its fronts but left
// the road clean. Each AI car gets its own stamp cadence (SkidMarks.stampFor, the
// player's 5/60 s), and other cars may hold at most SkidMarks.AI_CAP slots of the
// shared ring.
//
// The embers scatter on Math.random (inside Particles): fine, no physics path reads it
// (the sim is seeded). Pitch sign: c.baPitch > 0 is a dive.
import { PhysicsConsts } from "../physics/consts";
import type { Particles } from "./particles";
import type { SkidMarks, StampTimer } from "./skidmarks";

/** The car fields CarFx reads (all optional, each `|| 0`-guarded as in f1-game).
 *  TODO(lane-physics): body-attitude (baScrape, baPitch) and the drivetrain fields
 *  (rpm, deploying, wasOnThrottle) are not on PhysCar yet; the shell passes the car
 *  object that carries them. */
export interface FxCar {
  readonly speed?: number;
  readonly s?: number;
  readonly baScrape?: number;
  readonly baPitch?: number;
  readonly offroad?: boolean;
  readonly wheelLock?: number;
  readonly isPlayer?: boolean;
  readonly wasOnThrottle?: boolean;
  readonly retired?: boolean;
  readonly rpm?: number;
  readonly deploying?: boolean;
}

export const SPARK_V0 = 35;        // vStd m/s: no sparks below ~49 % of top speed…
export const SPARK_V1 = 60;        // …full shower from ~83 %
const SPARK_RATE = 110;            // embers per second at a full scrape
const PITCH_END = 0.004;           // rad: past this the floor's END is its lowest point
export const LOCK_MIN = 0.3;       // c.wheelLock that reads as a locked front (game.js's smoke gate)
const LOCK_V = 8;                  // vStd m/s floor for a mark (the lock-up smoke's)
export const HAZE_RANGE = 40;      // m of track ahead an onboard eye looks for a car on power
export const HAZE_TAU = 0.1;       // s: attack and release, 95 % of the way in ~0.3 s
const HAZE_V = 8;                  // vStd m/s: slower is parked or crawling, not on power
const HAZE_MIN = 0.02;             // below this the plume is off (and the anchor may move)

/** The post chain's one plume anchor (f1-game `opts.haze`). */
export interface HazeAnchor { u: number; v: number; str: number }

export interface HeatHaze<C extends FxCar = FxCar> {
  pick(cars: readonly C[], player: C | null | undefined, onboard: boolean, total: number, dt: number): C | null;
  mark(c: C, m: ArrayLike<number>): void;
  at(m: ArrayLike<number>): HazeAnchor | null;
  heat(c: C | null | undefined): number;
  state(): { anchor: C | null; str: number; marked: boolean };
}

// EXHAUST HEAT HAZE. It read c.exhaustPop, the ~0.2 s after-fire pulse on a
// throttle LIFT, so it flickered at each lift-off and never showed under
// power; and in an onboard camera (cockpit, the default) the player's
// tailpipe is behind the eye. Now: a SUSTAINED on-power signal (wasOnThrottle
// — every car's; an AI's is "not braking"), scaled by revs and ERS deploy,
// eased in and out; from an onboard eye the anchor is the nearest car AHEAD
// on power within HAZE_RANGE. One anchor, so the post shaders are unchanged,
// and a new car takes it only once the old plume has faded (no jump).
// Visual only: reads car state, writes none (no physics path reads this).
export function heatHaze<C extends FxCar = FxCar>(vStd: (v: number) => number): HeatHaze<C> {
  const world = [0, 0, 0], out: HazeAnchor = { u: 0, v: 0, str: 0 };
  let anchor: C | null = null, str = 0, marked = false;
  // The plume this car would raise: 0 off power, 0.45 x revs on it, 1 x revs deploying.
  function heat(c: C | null | undefined): number {
    if (!c || !c.wasOnThrottle || c.retired || !(vStd(c.speed || 0) > HAZE_V)) return 0;
    const K = PhysicsConsts, rev = Math.min(1, Math.max(0, ((c.rpm || 0) - K.IDLE_RPM) / (K.MAX_RPM - K.IDLE_RPM)));
    return (c.deploying ? 1 : 0.45) * (0.5 + 0.5 * rev);
  }
  // Before the draw loop, once a frame: choose the anchor and ease its strength.
  // `onboard`: the eye rides the player's car; `total`: the lap's arc length.
  function pick(cars: readonly C[], player: C | null | undefined, onboard: boolean, total: number, dt: number): C | null {
    marked = false;
    let want: C | null = player || null;
    if (onboard && player) {
      want = null;
      let best = HAZE_RANGE;
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i]!;
        if (c === player || !(heat(c) > 0)) continue;
        let ds = (c.s as number) - (player.s as number);
        if (ds < 0) ds += total;   // the lap wraps: a car just past the line is still ahead
        if (ds > 0 && ds <= best) { best = ds; want = c; }
      }
    }
    if (want !== anchor && (!anchor || str < HAZE_MIN)) anchor = want;
    const target = anchor && anchor === want ? heat(anchor) : 0;
    if (dt > 0) str += (target - str) * (1 - Math.exp(-dt / HAZE_TAU));
    if (target === 0 && str < HAZE_MIN) str = 0;   // faded: at() draws nothing below it anyway
    return anchor;
  }
  // In the draw loop: the anchor's body matrix (column-major R, U, F, origin).
  // Up 0.85, back 3.5 m: the plume hangs in the wake, not on the rear wing.
  function mark(c: C, m: ArrayLike<number>): void {
    if (c !== anchor || !(str > HAZE_MIN)) return;
    for (let i = 0; i < 3; i++) world[i] = m[12 + i]! + m[4 + i]! * 0.85 - m[8 + i]! * 3.5;
    marked = true;
  }
  // Before present: the frame's view-proj -> {u, v, str} for opts.haze, or null.
  // Near-field only: fades out past ~45 m so TV/orbit long shots stay clean.
  function at(m: ArrayLike<number>): HazeAnchor | null {
    if (!marked || !(str > HAZE_MIN)) return null;
    const hx = world[0]!, hy = world[1]!, hz = world[2]!;
    const cw = m[3]! * hx + m[7]! * hy + m[11]! * hz + m[15]!;
    if (!(cw > 0.1)) return null;
    const u = (m[0]! * hx + m[4]! * hy + m[8]! * hz + m[12]!) / cw * 0.5 + 0.5;
    const v = (m[1]! * hx + m[5]! * hy + m[9]! * hz + m[13]!) / cw * 0.5 + 0.5;
    if (!(u > -0.2 && u < 1.2 && v > -0.2 && v < 1.2)) return null;
    out.u = u; out.v = v; out.str = str * Math.min(1, Math.max(0, 1.4 - cw / 40));
    return out.str > HAZE_MIN ? out : null;
  }
  return { pick, mark, at, heat, state: () => ({ anchor, str, marked }) };
}

export interface CarFxDeps {
  /** f1-game `G.vTop()`: the envelope's top ground speed (PACE-scaled). */
  readonly vTop: () => number;
  readonly skids?: SkidMarks | null;
  /** Only `scrape` is called (f1-game `deps.Particles || Particles`). */
  readonly particles?: Pick<Particles, "scrape"> | null;
}

export interface CarFx<C extends FxCar = FxCar> {
  /** Per car per frame, after its grounded basis exists. `state` is the game state
   *  ("race" lays AI lock-up marks). */
  emit(c: C | null | undefined, g: ArrayLike<number> | null | undefined, dt: number, state: string): void;
  status(): { sparks: number; marks: number };
  readonly haze: HeatHaze<C>;
}

export function createCarFx<C extends FxCar = FxCar>(deps: CarFxDeps): CarFx<C> {
  const skids = deps.skids || null;
  const P = deps.particles || null;
  const timers = new WeakMap<C, StampTimer>();   // car → { t } stamp cadence (SkidMarks.stampFor)
  const stats = { sparks: 0, marks: 0 };
  const vStd = (v: number): number => v * PhysicsConsts.VMAX / deps.vTop();
  const haze = heatHaze<C>(vStd);   // game.js: pick() before the car loop, mark() per car, at() before present

  // Embers from the plank: `g` is the car's grounded basis (column-major:
  // right 0-2, up 4-6, forward 8-10, origin 12-14 on the road).
  function plank(c: C, g: ArrayLike<number>, dt: number): void {
    const scrape = c.baScrape || 0;
    if (!(scrape > 0) || !P || !P.scrape) return;
    const v = vStd(c.speed || 0);
    if (!(v > SPARK_V0)) return;
    const k = scrape * Math.min(1, (v - SPARK_V0) / (SPARK_V1 - SPARK_V0));
    const p = c.baPitch || 0;
    const z = p > PITCH_END ? 1.0 : p < -PITCH_END ? -1.6 : -0.3;   // c.baPitch > 0 is a dive
    const sp = c.speed as number;
    P.scrape(g[12]! + g[8]! * z, g[13]! + g[9]! * z + 0.02, g[14]! + g[10]! * z,
      g[8]! * sp, g[10]! * sp, dt * SPARK_RATE * k);
    stats.sparks++;
  }

  // An AI car's locked front lays marks on its own cadence.
  function aiMarks(sk: SkidMarks, c: C, g: ArrayLike<number>, dt: number): void {
    const laying = !c.offroad && (c.wheelLock || 0) > LOCK_MIN && vStd(c.speed || 0) > LOCK_V;
    let t = timers.get(c);
    if (!t) {
      if (!laying) return;
      t = { t: 0 };
      timers.set(c, t);
    }
    if (sk.stampFor(t, g, laying, dt)) stats.marks++;
  }

  // Per car per frame, after its grounded basis exists and before the cockpit
  // view's `continue` (world state, not a draw). `state` is game.js's state.
  function emit(c: C | null | undefined, g: ArrayLike<number> | null | undefined, dt: number, state: string): void {
    if (!c || !g || !(dt > 0)) return;
    plank(c, g, dt);
    // f1-game also tests `skids.stampFor` (car-fx.js:359); the type guarantees it.
    if (state === "race" && !c.isPlayer && skids) aiMarks(skids, c, g, dt);
  }

  function status(): { sparks: number; marks: number } { return { sparks: stats.sparks, marks: stats.marks }; }

  return { emit, status, haze };
}
