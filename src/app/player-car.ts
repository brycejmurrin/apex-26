/**
 * A fresh human player car for a solo session, placed on grid slot 0.
 *
 * Field values: src/sim/player-step-car.ts `newPlayerCar` (the sim lane owns
 * the car defaults). Placement: mesh.js:1193 `gridSlot(track, 0)`
 * (s = total - 14, x on the left of the box), heading along the tangent,
 * `prog = -14`.
 */
import type { TrackSample } from "../contracts/track";
import type { PhysicsTrack } from "../physics/track";
import type { PlayerCar } from "../sim/player-step";
import { newPlayerCar } from "../sim/player-step-car";

export function makePlayerCar(code = "YOU"): PlayerCar {
  return newPlayerCar(code);
}

const _smp: TrackSample = { p: [0, 0, 0], t: [0, 0, 1], r: [1, 0, 0], hw: 7 };

/** Put `c` on grid slot `i` (mesh.js:1193-1198, game.js:1757-1772). */
export function gridCar(c: PlayerCar, track: PhysicsTrack, i = 0): void {
  let s = track.length - 14 - i * 8;
  s %= track.length; if (s < 0) s += track.length;
  track.sample(s, _smp);
  const x = (i % 2 === 0 ? -1 : 1) * Math.min(_smp.hw * 0.4, 3);
  c.s = s; c.x = x; c.xVis = x;
  c.px = _smp.p[0] + _smp.r[0] * x; c.pz = _smp.p[2] + _smp.r[2] * x;
  c.head = Math.atan2(_smp.t[0], _smp.t[2]);
  c.rPrevPx = c.px; c.rPrevPz = c.pz; c.rPrevS = c.s; c.rPrevX = c.x; c.rPrevHead = c.head;
  c._prevS = c.s;
  c.speed = 0; c.prog = -(14 + i * 8); c.lap = 0; c.lapTime = 0; c.best = Infinity; c.totalT = 0;
  c.energy = 1; c.xOn = false; c.aeroX = 0; c.xArmed = false; c.finished = false; c.finishT = 0;
  c.vLat = 0; c.yawRateCur = 0;
}
