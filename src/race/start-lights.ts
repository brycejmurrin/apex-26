/**
 * START LIGHTS: the five-lamp countdown, the random hold, lights-out, and the
 * lamp positions on the start gantry.
 *
 * Ported from f1-game (main @ 2026-10-18): the countdown in js/game.js:4366-4413
 * (`COUNTDOWN_S` :956), the wall-clock top-up and lamp geometry in
 * js/race/start-lights.js:27-118. The DOM lamps, audio and camera are the
 * caller's: `stepCountdown` reports what happened as events.
 */
import type { Countdown } from "../contracts/race";

/** game.js:956. */
export const COUNTDOWN_S = 5;
/** start-lights.js:27-36. */
export const LAMPS = 5;
export const SPACING = 0.9;
export const DROP = 0.62;
export const FACE = 0.30;
export const GAIN = 2.84;
export const NEAR = 0.03;
export const CATCHUP_S = 1;

/** A sequence at rest (game.js:2624, :1718). */
export function freshCountdown(restart = false): Countdown {
  return { countT: 0, lightsLit: 0, startHold: 0, restartPending: restart };
}

/** The countdown's wall-clock top-up for one frame, #1882 (start-lights.js:47-50). */
export function countCredit(wallS: number, dtS: number, droppedS: number): number {
  const wall = Math.min(CATCHUP_S, wallS > 0 ? wallS : 0);
  return Math.max(0, wall - (dtS > 0 ? dtS : 0)) + (droppedS > 0 ? droppedS : 0);
}

/** What one countdown step did. */
export interface CountdownStep {
  /** Lamps newly lit this step (indices), in order. */
  lit: number[];
  /** Lights out: the race starts this step. */
  green: boolean;
  /** The green ends a red-flag restart (the clock resumes; game.js:4414-4415). */
  restart: boolean;
}

/** A networked start pinned to a shared instant (game.js:4372-4374). */
export interface NetStart {
  readonly hold: number;
  /** Seconds until the shared green instant (netStart.at - now) / 1000. */
  readonly untilS: number;
}

/**
 * One step of the count (game.js:4366-4413). `rnd` draws the hold (simRnd);
 * `awaiting` is a networked race that has not named its start instant yet.
 */
export function stepCountdown(cd: Countdown, dt: number, rnd: () => number, net?: NetStart | null, awaiting = false): CountdownStep {
  const out: CountdownStep = { lit: [], green: false, restart: false };
  if (net) {
    cd.startHold = net.hold;
    cd.countT = (COUNTDOWN_S + cd.startHold) - net.untilS;
  } else if (!awaiting) {
    cd.countT += dt;
  }
  const lit = Math.min(COUNTDOWN_S, Math.floor(cd.countT));
  if (lit > cd.lightsLit) {
    for (let i = cd.lightsLit; i < lit; i++) out.lit.push(i);
    cd.lightsLit = lit;
    if (lit === COUNTDOWN_S && !net) cd.startHold = 0.2 + rnd() * 1.8;
  }
  if (cd.lightsLit === COUNTDOWN_S && cd.countT > COUNTDOWN_S + cd.startHold) {
    out.green = true;
    out.restart = cd.restartPending;
    cd.restartPending = false;
  }
  return out;
}

type V3 = readonly [number, number, number];

/** A scenery prop record as the gantry search reads it (start-lights.js:60-75). */
export interface GantryProp {
  readonly kind: string;
  readonly side: number;
  readonly k: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly h: number;
  readonly lamp?: V3;
  readonly face?: number;
  readonly startLights?: boolean;
}

/** The track fields the lamp search reads. */
export interface LampTrack {
  readonly n: number;
  readonly px?: ArrayLike<number>;
  readonly pz?: ArrayLike<number>;
  readonly props?: { readonly list?: readonly GantryProp[] } | null;
  readonly startGate?: { readonly c: V3; readonly t: V3; readonly face?: number } | null;
}

interface Anchor { c: V3; tx: number; tz: number; face: number }

function anchorFor(track: LampTrack): Anchor | null {
  const list = track.props && track.props.list, n = track.n;
  if (list && track.px && track.pz && n > 2) {
    let best: GantryProp | null = null, bestD = Infinity;
    for (const r of list) {
      if (r.kind !== "gantry" || r.side !== 0 || !(r.k >= 0)) continue;
      const d = Math.min(r.k, n - r.k);
      if (d < bestD || (d === bestD && r.startLights && !(best as GantryProp).startLights)) { bestD = d; best = r; }
    }
    if (best && bestD <= n * NEAR) {
      const k = best.k, k0 = (k + n - 1) % n, k1 = (k + 1) % n;
      return { c: best.lamp || [best.x, best.y + best.h / 2 - DROP, best.z],
        tx: (track.px[k1] as number) - (track.px[k0] as number), tz: (track.pz[k1] as number) - (track.pz[k0] as number),
        face: (best.face as number) > 0 ? best.face as number : FACE };
    }
  }
  const g = track.startGate;
  if (g && g.c && g.t) return { c: g.c, tx: g.t[0], tz: g.t[2], face: (g.face as number) > 0 ? g.face as number : FACE };
  return null;
}

const lampsBy = new WeakMap<LampTrack, [number, number, number][] | null>();

/** World positions of the five lamps, memoised per track (start-lights.js:84-102). */
export function lampsFor(track: LampTrack | null | undefined): [number, number, number][] | null {
  if (!track) return null;
  if (lampsBy.has(track)) return lampsBy.get(track) ?? null;
  const a = anchorFor(track);
  if (!a) { if (track.props && track.props.list) lampsBy.set(track, null); return null; }
  const tl = Math.hypot(a.tx, a.tz) || 1, tx = a.tx / tl, tz = a.tz / tl;
  const rx = -tz, rz = tx;
  const lamps: [number, number, number][] = [];
  for (let i = 0; i < LAMPS; i++) {
    const lat = (i - (LAMPS - 1) / 2) * SPACING;
    lamps.push([a.c[0] + rx * lat - tx * a.face, a.c[1], a.c[2] + rz * lat - tz * a.face]);
  }
  lampsBy.set(track, lamps);
  return lamps;
}
