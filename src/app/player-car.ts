/**
 * A fresh human player car for a solo session, placed on grid slot 0.
 *
 * Field values: f1-game js/game.js makeCars (:1706-1803) and the grid reset
 * (:1757-1772), as recorded for the player seat in the physics goldens
 * (tests/goldens/physics-tape-*.json.gz `initial.car`), minus the AI-only and
 * team fields. Neutral parts (`mods` absent), the time-trial setup.
 * Placement: mesh.js:1193 `gridSlot(track, 0)` (s = total - 14, x on the
 * left of the box), heading along the tangent, `prog = -14`.
 *
 * `collideT` is 0 rather than f1-game's `undefined`: it only gates the wall
 * sound (wall-clamp.js:118), where undefined reads as NaN and never re-arms.
 */
import type { TrackSample } from "../contracts/track";
import type { PhysicsTrack } from "../physics/track";
import type { PlayerCar } from "../sim/player-step";

export function makePlayerCar(code = "YOU"): PlayerCar {
  return {
    code, human: true, local: true, isPlayer: true,
    s: 0, x: 0, prog: 0, lap: 0, px: 0, pz: 0, head: 0,
    speed: 0, vLat: 0, yawRateCur: 0,
    steerSm: 0, kerbGripSm: 1, kerbCueT: 0, braking: false,
    gear: 1, rpm: 5000, shiftT: 0,
    energy: 1, boostOn: false, deploying: false, xOn: false, aeroX: 0, xArmed: false,
    otT: 0, otE: 0, otOn: false, otEarned: false, otArmed: false, _otS: null, _otLap: null, _otHold: false,
    onKerb: undefined, inPitLane: undefined, offroad: false,
    slipFront: undefined, slipRear: undefined, steerAngle: undefined, lateralAccel: undefined,
    lapTime: 0, best: Infinity, totalT: 0, finished: false, finishT: 0, retired: false,
    tyreWear: 0, tread: 0, tyreWearF: 0, tyreWearR: 0, tyreTs: 70, tyreTb: 70,
    offT: 0, cuts: 0, cutWarn: 0, penalty: 0, qualiCut: false,
    wrongT: 0, wrongWay: false, rescueT: 0, rescueLastT: null,
    wallT: 0, wasOnWall: false, wallHits: 0, collideT: 0,
    brakeBias: 0.56, brakeHeat: 0, wasOnThrottle: false, axEstSm: 0, corridorAccel: 0,
    fuelLap: 0, fuelRestartLaps: 0, _progGift: 0,
    yawVis: 0, steerVis: 0, xVis: 0, seat: 0, pitState: "none",
    // makeCars' neutral setup (golden car: aeroLoad/ersDeploy/ersRegen are the team's; neutral here)
    rollBalance: 0, aeroLoad: null, ersDeploy: null, ersRegen: null,
  };
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
