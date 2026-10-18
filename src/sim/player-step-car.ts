/**
 * A fresh human player car with every `PlayerCar` field set: the one place
 * the sim's car defaults live, so a field the step makes required is filled
 * here and every caller (the shell's makePlayerCar, tests) picks it up.
 *
 * Field values: f1-game js/game.js makeCars (:1706-1803) and the grid reset
 * (:1757-1772), as recorded for the player seat in the physics goldens
 * (tests/goldens/physics-tape-*.json.gz `initial.car`), minus the AI-only and
 * team fields. Neutral parts (`mods` absent), the time-trial setup. Not placed:
 * the caller puts it on the grid.
 *
 * `collideT` is 0 rather than f1-game's `undefined`: it only gates the wall
 * sound (wall-clamp.js:118), where undefined reads as NaN and never re-arms.
 */
import type { PlayerCar } from "./player-step";

export function newPlayerCar(code = "YOU"): PlayerCar {
  return {
    code, human: true, local: true, isPlayer: true,
    s: 0, x: 0, prog: 0, lap: 0, px: 0, pz: 0, head: 0,
    speed: 0, vLat: 0, yawRateCur: 0,
    steerSm: 0, kerbGripSm: 1, kerbCueT: 0, braking: false,
    lane: 0, // AI lane-preference state (f1-game game.js:1684 c.lane = c.lanePref); unused on the human path
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
