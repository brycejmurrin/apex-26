/**
 * A toy kinematic body for the shell to drive until the physics lane's player
 * step (PLAN T1.6) is wired in. Not f1-game physics: a bicycle-ish car in
 * track coordinates with a speed cap, drag and a steer-to-yaw rate, so the
 * loop, input, camera, HUD and debug API have something that moves.
 *
 * It writes the `CarState` fields the shell reads (s, x, prog, lap, px, pz,
 * head, speed, yawRateCur, gear, rpm; lap timing is the app's) and nothing from the arc
 * reaches its controls: steering only turns the body's own heading.
 */
import type { CarState, PlayerInput } from "../contracts/sim";
import type { TrackQuery, TrackSample } from "../contracts/track";

const VMAX = 80;          // m/s
const ACCEL = 11;         // m/s^2
const BRAKE = 30;         // m/s^2
const DRAG = 0.0009;      // per m of speed^2
const YAW_MAX = 1.6;      // rad/s at full lock, low speed
const WALL_SCRUB = 25;    // m/s^2 lost while sliding on the barrier

export function makePlaceholderCar(): CarState {
  return {
    human: true, local: true, isPlayer: true,
    s: 0, x: 0, prog: 0, lap: 0,
    px: 0, pz: 0, head: 0, speed: 0, vLat: 0, yawRateCur: 0,
    steerSm: undefined, kerbGripSm: 1, braking: false,
    gear: 1, rpm: 0, shiftT: 0,
    energy: 1, boostOn: false, deploying: false, xOn: false, aeroX: 0,
    onKerb: undefined, inPitLane: undefined, offroad: false,
    slipFront: undefined, slipRear: undefined, steerAngle: undefined, lateralAccel: undefined,
    lapTime: 0, best: Infinity, tyreWear: 0, retired: false, finished: false,
  };
}

const sc: TrackSample = { p: [0, 0, 0], t: [0, 0, 1], r: [1, 0, 0], hw: 7 };

/** Heading of the track tangent at `s`. */
function trackHead(track: TrackQuery, s: number): number {
  track.sample(s, sc);
  return Math.atan2(sc.t[0], sc.t[2]);
}

/** Place the car on the grid at arc `s`, centred, facing down the track. */
export function placeCar(c: CarState, track: TrackQuery, s: number): void {
  c.s = track.wrapS(s); c.x = 0; c.prog = 0; c.lap = 0; c.speed = 0; c.yawRateCur = 0;
  c.head = trackHead(track, c.s);
  track.sample(c.s, sc);
  c.px = sc.p[0]; c.pz = sc.p[2];
}

/** Advance the toy body one step. Returns true when it crossed the start line. */
export function stepPlaceholder(c: CarState, inp: PlayerInput, track: TrackQuery, dt: number): boolean {
  const thr = inp.throttle ? inp.throttleLevel : 0;
  const brk = inp.brake ? inp.brakeLevel : 0;
  c.speed += (thr * ACCEL * (1 - c.speed / VMAX) - brk * BRAKE * Math.sign(c.speed) - DRAG * c.speed * c.speed) * dt;
  if (c.speed < 0) c.speed = 0;
  const grip = 1 / (1 + c.speed / 40);
  // +steer is right; a right turn lowers `head` (forward = (sin h, cos h), right = (-cos h, sin h)).
  c.yawRateCur = -inp.steer * YAW_MAX * grip * Math.min(1, c.speed / 5);
  c.head += c.yawRateCur * dt;
  // Integrate in the world, then project back onto the track frame.
  c.px += Math.sin(c.head) * c.speed * dt;
  c.pz += Math.cos(c.head) * c.speed * dt;
  track.sample(c.s, sc);
  const dx = c.px - sc.p[0], dz = c.pz - sc.p[2];
  const ds = dx * sc.t[0] + dz * sc.t[2];
  c.x = dx * sc.r[0] + dz * sc.r[2];
  const wall = track.wallAt(c.s, c.x);
  if (Math.abs(c.x) > wall) {
    // Slide along the barrier: clamp, scrub speed, point down the road.
    c.x = Math.sign(c.x) * wall;
    c.speed = Math.max(0, c.speed - WALL_SCRUB * dt);
    c.head = trackHead(track, c.s);
  }
  const prevS = c.s;
  c.s = track.wrapS(c.s + ds);
  c.prog += ds;
  track.sample(c.s, sc);
  c.px = sc.p[0] + sc.r[0] * c.x; c.pz = sc.p[2] + sc.r[2] * c.x;
  c.gear = Math.max(1, Math.min(8, 1 + Math.floor(c.speed / VMAX * 8)));
  c.rpm = 4000 + 8000 * ((c.speed / VMAX * 8) % 1);
  return ds > 0 && c.s < prevS && prevS - c.s > track.length / 2;
}
