#!/usr/bin/env node
// Module fixtures for the T1.5 physics ports: run f1-game's REAL physics
// modules (js/physics/{consts,tyre-model,grip-steer,player-forces,
// contact-geometry,wall-end-face,wall-clamp,collide,ai-drive}.js and
// js/garage/setup-tune.js) in a Node VM on seeded random inputs, and write the
// inputs with f1-game's exact outputs to tests/goldens/physics-modules.json.
// tests/unit/physics-modules.test.ts replays every case through the TS port
// and requires Object.is equality on every number.
//
// Run: node tools/oracle/modules.mjs        (F1_GAME=/path/to/f1-game to override ../f1-game)
import {
  FAKE_TOTAL, fakePostLimits, fakeSample, fakeWallAt, fakeWorldFromTrack, fakeWrapS, makeFakeTrack, newSample,
} from "../../tests/goldens/fake-track.ts";
import { f1Sha, loadF1, rng, writeGolden } from "./lib.mjs";

const DT = 1 / 60;
const rand = rng(0x5eed26);
const U = (lo, hi) => lo + (hi - lo) * rand();
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;

// ── one VM with every module, real dependencies, stubbed side effects ──────
const fx = [];   // side-effect log: the TS side does not replay these, it only proves they never feed back
const ctx = loadF1([
  "js/core/mat4.js",
  "js/physics/consts.js",
  "js/physics/tyre-model.js",
  "js/physics/grip-steer.js",
  "js/physics/ai-drive.js",
  "js/physics/contact-geometry.js",
  "js/physics/wall-end-face.js",
  "js/physics/player-forces.js",
  "js/physics/wall-clamp.js",
  "js/physics/collide.js",
], {
  GameStore: { store: { get: (k, d) => d, set() {} } },
  Input: { rumble: () => fx.push("rumble"), vibrate: () => fx.push("vibrate") },
  DebrisWorld: { active: () => false },
  GameAudio: { collision: () => fx.push("collision"), fieldContact: () => fx.push("fieldContact") },
  IncidentSim: { owns: () => false, notifyCar() {}, notifyWall() {} },
  TrackPit: { EXIT_WALL_W: 0.75 },
  Teams: { LIST: [{ id: "redbull" }, { id: "mclaren" }, { id: "ferrari" }] },
});
// SetupTune needs GameStore + PhysicsConsts at eval; load it after them.
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const vm = await import("node:vm");
  const { F1 } = await import("./lib.mjs");
  const src = fs.readFileSync(path.join(F1, "js/garage/setup-tune.js"), "utf8").replace(/^const\b/gm, "var");
  vm.runInContext(src, ctx, { filename: "js/garage/setup-tune.js" });
}
const { TyreModel, GripSteer, PlayerForces, ContactGeometry, WallClamp, WallEndFace, Collide, SetupTune } = ctx;
void WallEndFace;

// The fake track, as f1-game's Tracks façade over a raw track object.
const fakeTracks = { plain: makeFakeTrack(false, false), pit: makeFakeTrack(true, false), street: makeFakeTrack(true, true) };
ctx.Tracks = {
  sample: (track, s, out) => fakeSample(s, out || newSample()),
  wallAt: (track, s, side) => fakeWallAt(s, side),
  postLimits: (track, s, x, out) => fakePostLimits(track, s, x, out),
};
const _wf = { x: 0, z: 0 };
const worldFromTrack = (s, x, out) => fakeWorldFromTrack(s, x, out || newSample(), _wf);

const golden = { meta: { f1Sha: f1Sha(), generator: "tools/oracle/modules.mjs", total: FAKE_TOTAL }, fns: [] };
const fn = (name, args, out) => golden.fns.push({ fn: name, args, out });

// ── pure functions ─────────────────────────────────────────────────────────
for (let i = 0; i < 300; i++) {
  const x = i < 20 ? [0, 1, -1, Math.PI / 2, -Math.PI / 2, 1.27, 2.6, -2.6, 2.61, 9, -9, 1e-9, -0, 3, 5, -5, 1.2706, 0.5, 20, -20][i] : U(-9, 9);
  fn("lateralCurve", [x], TyreModel.lateralCurve(x));
  fn("lateralCurveR", [x], TyreModel.lateralCurve(x, TyreModel.CURVE_FLOOR_R, TyreModel.CURVE_FALL_W_R, TyreModel.CURVE_HOLD_R));
  const cs = pick([130, 175, 105]), a = U(-0.6, 0.6), mu = U(0.5, 60);
  fn("tyreSat", [cs, a, mu], PlayerForces.tyreSat(cs, a, mu));
}
for (let i = 0; i < 200; i++) {
  const prev = chance(0.2) ? null : U(0.1, 1), ru = chance(0.1) ? undefined : U(0, 1.6), dt = pick([DT, DT / 4, 0.05]);
  fn("brakeBeta", [prev, ru, dt], TyreModel.brakeBeta(prev, ru, dt));
  const b = U(0.2, 1), lf = U(0.3, 0.7), lr = 1 - lf;
  fn("brakeFront", [b, lf, lr], TyreModel.brakeFront(b, lf, lr));
  const w = chance(0.1) ? undefined : U(0, 2.5);
  fn("gripFor", [w], TyreModel.gripFor(w));
  fn("longFor", [w], TyreModel.longFor(w));
  const corner = chance(0.1) ? "x" : U(0.85, 1.4);
  fn("deriveLife", [corner], TyreModel.deriveLife(corner));
  const ts = chance(0.1) ? null : U(20, 180), life = chance(0.2) ? null : U(0.3, 1.2);
  fn("tempGrip", [ts, life], TyreModel.tempGrip(ts, life));
  fn("optTemp", [life], TyreModel.optTemp(life));
  fn("coolFor", [life], TyreModel.coolFor(life));
  fn("warmRate", [life], TyreModel.warmRate(life));
  const g = U(0, 1.2), bl = U(-0.1, 1.1);
  fn("defectGrip", [g, bl], TyreModel.defectGrip(g, bl));
  const tread = pick([0, 1, 2, 3, null, 1.5]), wet = U(-0.2, 1.2);
  fn("weatherGrip", [tread, wet], TyreModel.weatherGrip(tread, wet));
  const spd = U(-10, 100);
  fn("aquaplane", [spd, wet, tread], TyreModel.aquaplane(spd, wet, tread));
  fn("aquaplaneSafeV", [wet, tread], TyreModel.aquaplaneSafeV(wet, tread));
  const load = U(0, 3), vF = U(-0.2, 1.3), amb = U(10, 35), trk = chance(0.2) ? null : U(10, 55), sl = U(0, 1.2);
  const ts0 = U(20, 140), tb0 = U(20, 140);
  fn("stepTemp", [ts0, tb0, load, vF, amb, trk, life, sl], TyreModel.stepTemp(ts0, tb0, { load, vFrac: vF, amb, track: trk, life, slide: sl, dt: DT }));
  const c = { human: chance(0.5), speed: U(-5, 90), yawRateCur: U(-1, 1), axFrac: U(0, 1.1), skidIntensity: U(0, 1.1),
    onKerb: chance(0.3), offroad: chance(0.2), consistency: U(0, 1), corridorAccel: chance(0.5) ? U(-30, 10) : undefined,
    accSm: U(0, 8), axEstSm: U(-25, 8), brakeBias: chance(0.3) ? null : U(0.5, 0.62), lap: Math.floor(U(0, 30)), fuelLap: chance(0.5) ? null : Math.floor(U(0, 30)) };
  fn("humanLoad", [c, 22], TyreModel.humanLoad(c, 22));
  fn("aiLoad", [c, 7.5], TyreModel.aiLoad(c, 7.5));
  fn("longSigned", [c, 7.5], TyreModel.longSigned(c, 7.5));
  fn("axleShare", [c, 7.5], TyreModel.axleShare(c, 7.5));
  const lt = Math.floor(U(0, 60));
  fn("fuelFrac", [c, lt], TyreModel.fuelFrac(c, lt));
  const bias = chance(0.2) ? 0 : U(-0.3, 0.3), lat = U(-40, 40), fl = chance(0.5) ? undefined : U(0.4, 0.55);
  const ag = SetupTune.axleGrip(bias, lat, fl);
  fn("axleGrip", [bias, lat, fl], { f: ag.f, r: ag.r });
  const bb = chance(0.2) ? null : U(0.4, 0.7);
  fn("bbScales", [bb], SetupTune.bbScales(bb));
}
// GripSteer.apply: pure over numbers, strength passed explicitly.
for (let i = 0; i < 300; i++) {
  const dd = U(-0.7, 0.7);
  const st = { vLat: U(-6, 6), yawRate: U(-1.5, 1.5), speed: chance(0.1) ? U(-5, 3) : U(0, 85), muF: U(0, 40), csFront: pick([130, 0, 90]),
    af: pick([1.3, 0, 1.6]), ar: pick([1.9, 0, 1.4]), braking: chance(0.3), shaped: U(-1, 1), capSm: chance(0.3) ? 0 : U(0, 0.2), dt: pick([DT, 0, 0.05]) };
  const k = pick([0, 1 / 9, 0.5, 1, U(0, 1)]);
  const out = GripSteer.apply(dd, Object.assign({}, st), k);
  fn("gripSteerApply", [dd, st, k], { delta: out.delta, capSm: out.capSm });
}
// ContactGeometry: overlap, sweep, impulse.
for (let i = 0; i < 300; i++) {
  const dx = U(-6, 6), dy = U(-3, 3), aA = chance(0.3) ? 0 : U(-1.6, 1.6), aB = chance(0.3) ? 0 : U(-1.6, 1.6);
  const o = ContactGeometry.overlap(dx, dy, aA, aB, {});
  fn("overlap", [dx, dy, aA, aB], o ? { depth: o.depth, nx: o.nx, ny: o.ny } : null);
  const x0 = U(-8, 8), y0 = U(-4, 4), x1 = x0 + U(-6, 6), y1 = y0 + U(-3, 3);
  const sw = ContactGeometry.sweep(x0, y0, x1, y1, aA, aB, {});
  fn("sweep", [x0, y0, x1, y1, aA, aB], sw ? { time: sw.time, nx: sw.nx, ny: sw.ny, depth: sw.depth } : null);
  const body = () => ({ angle: chance(0.4) ? 0 : U(-1, 1), vx: U(-5, 60), vy: U(-5, 5), omega: U(-1, 1), invMass: pick([0, 0.5, 1, 0.42]), invInertia: pick([0, 0.2, 0.37]) });
  const A = body(), B = body(), n = U(0, 2 * Math.PI), contact = { nx: Math.cos(n), ny: Math.sin(n) };
  const ddx = U(-5, 5), ddy = U(-2, 2);
  const j = ContactGeometry.impulse(A, B, ddx, ddy, contact, {});
  fn("impulse", [A, B, ddx, ddy, contact], Object.assign({}, j));
}
// wallLimits over the fake track (pit wall, exit road, posts, previous pose).
for (let i = 0; i < 400; i++) {
  const which = pick(["plain", "pit", "street"]);
  const track = fakeTracks[which];
  const s = chance(0.6) ? U(100, 450) : U(0, FAKE_TOTAL), x = U(-14, 16);
  const previous = chance(0.25) ? { s: s - U(0, 3), x: U(-14, 16) } : null;
  const out = { r: 0, l: 0, laneMin: 0, side: 0 }, post = { r: 0, l: 0, minOut: 0, side: 0 };
  ContactGeometry.wallLimits(track, s, x, out, post, previous);
  fn("wallLimits", [which, s, x, previous], { r: out.r, l: out.l, laneMin: out.laneMin, side: out.side });
}

// ── stateful: a tyre-model instance driven for a stint ─────────────────────
{
  const G = { raceTyreWear: "real", track: { total: 5793, def: { id: "monza", tyreSeverity: 0.8 } }, weatherArc: null,
    raceWeather: "dry", lapsTarget: 10, session: "race", LAT_MAX: 22, aTop: () => 7.3, vTop: () => 75.2 };
  const tyres = TyreModel.create(G);
  const cars = [
    { human: true, speed: 0, yawRateCur: 0, lap: 1, prog: 0, s: 0, tread: 0 },
    { human: false, speed: 0, consistency: 0.6, lap: 1, prog: 0, s: 0, tread: null, tyreClass: "soft" },
  ];
  tyres.fit(cars[0], TyreModel.optionRecord({ id: "soft_tyre", cornering: 1.12, speed: 1.01, wetTread: 0 }));
  const steps = [];
  const r2 = rng(77);
  for (let i = 0; i < 400; i++) {
    for (const c of cars) {
      c.speed = 30 + 50 * r2(); c.yawRateCur = r2() - 0.5; c.axFrac = r2(); c.skidIntensity = r2() * 0.4;
      c.axEstSm = r2() * 30 - 22; c.onKerb = r2() < 0.1; c.offroad = r2() < 0.05; c.corridorAccel = r2() * 20 - 15;
      c.prog += c.speed * DT * 60; c.lap = 1 + Math.floor(c.prog / 5793);
    }
    if (i === 200) G.weatherArc = { from: "dry", to: "rain", t: 10, dur: 60, cell: null };
    const row = { inputs: cars.map((c) => ({ speed: c.speed, yawRateCur: c.yawRateCur, axFrac: c.axFrac, skidIntensity: c.skidIntensity,
      axEstSm: c.axEstSm, onKerb: c.onKerb, offroad: c.offroad, corridorAccel: c.corridorAccel, prog: c.prog, lap: c.lap })),
      arc: G.weatherArc ? Object.assign({}, G.weatherArc) : null, out: [] };
    for (const c of cars) {
      tyres.update(c, DT);
      const ax = tyres.axleSplit(c);
      row.out.push({ tyreWear: c.tyreWear, tyreWearF: c.tyreWearF, tyreWearR: c.tyreWearR, tyreTs: c.tyreTs, tyreTb: c.tyreTb,
        tyreGrain: c.tyreGrain, tyreBlister: c.tyreBlister, load: c._tyreLoad, grip: tyres.gripMul(c), traction: tyres.tractionMul(c),
        axF: ax.f, axR: ax.r, fuelA: tyres.fuelAccelMul(c), fuelV: tyres.fuelVmaxMul(c), lapsOn: tyres.lapsOn(c), lapsLeft: tyres.lapsLeft(c),
        ambient: tyres.ambient(), trackTemp: tyres.trackTemp() });
    }
    steps.push(row);
  }
  golden.tyreStint = { G: { ...G, aTop: 7.3, vTop: 75.2, weatherArc: null }, fit: { id: "soft_tyre", cornering: 1.12, speed: 1.01, wetTread: 0 }, steps };
}

// ── PlayerForces.step on random cars and contexts ──────────────────────────
const CAR_OUT = ["speed", "vLat", "yawRateCur", "head", "axFrac", "axFracF", "axFracR", "brakeStab", "rearUtil", "frontUtil",
  "wheelLock", "flatSpot", "slipFactor", "lateralAccel", "slipFront", "slipRear", "steerAngle", "gripFront", "gripRear",
  "forceFront", "forceRear", "_aeroGrip", "_dirtyAirMul", "_coachAssisted", "_cueConditionGrip", "_cueCornering", "_cueBraking",
  "lockHapT", "uslipDwell", "uslipHapT", "oslipHapT", "gripSteerCapSm"];
const snap = (c, keys) => Object.fromEntries(keys.map((k) => [k, c[k] === undefined ? null : c[k]]));
golden.playerForces = [];
{
  const wearG = { raceTyreWear: "real", track: { total: 5793, def: { id: "monza" } }, weatherArc: null, raceWeather: "dry",
    lapsTarget: 10, session: "race", LAT_MAX: 22, aTop: () => 7.3, vTop: () => 75.2 };
  for (let i = 0; i < 400; i++) {
    const G = { PLAYER_GRIP: pick([1.15, 1.0]), FRONT_GRIP: pick([0.94, 1.0]), DRIFT: pick([0, 0, 0.4]), YAW_INERTIA: pick([0.58, 0.4]), YAW_DAMP: pick([1.0, 1.3]) };
    const pf = PlayerForces.create(G);
    const level = chance(0.75) ? 1 : pick([2, 5, 10]);
    GripSteer.setLevel(level);
    const wear = chance(0.3);
    const tyres = TyreModel.create(wear ? wearG : { ...wearG, raceTyreWear: "off" });
    const lowSpeed = chance(0.25);
    const car = {
      human: true, isPlayer: chance(0.8), offroad: chance(0.1), speed: lowSpeed ? U(-6, 9) : U(8, 85), vLat: chance(0.1) ? undefined : U(-5, 5),
      yawRateCur: chance(0.1) ? undefined : U(-1.2, 1.2), head: U(-3, 3), axEstSm: chance(0.15) ? undefined : U(-30, 8), aeroX: chance(0.7) ? 0 : U(0, 1),
      mods: chance(0.3) ? undefined : { braking: pick([1, 1.1, 0.95]), cornering: 1 }, brakeStab: chance(0.2) ? undefined : U(0.2, 1),
      rearUtil: chance(0.2) ? undefined : U(0, 1.6), brakeBias: chance(0.4) ? null : pick([0.56, U(0.5, 0.62)]),
      rollBalance: chance(0.5) ? undefined : U(-0.3, 0.3), lateralAccel: chance(0.2) ? undefined : U(-40, 40),
      flatSpot: chance(0.5) ? undefined : U(0, 0.5), lockHapT: chance(0.5) ? undefined : U(-0.1, 0.2),
      uslipDwell: chance(0.5) ? undefined : Math.floor(U(0, 4)), uslipHapT: chance(0.5) ? undefined : U(-0.1, 0.2),
      oslipHapT: chance(0.5) ? undefined : U(-0.1, 0.2), gripSteerCapSm: chance(0.5) ? undefined : U(0, 0.2),
    };
    if (wear) { tyres.fit(car, TyreModel.classRecord(pick(["soft", "medium", "hard"]))); car.tyreWear = U(0, 1.4); car.tyreWearF = car.tyreWear * U(0.8, 1.2); car.tyreWearR = car.tyreWear * U(0.8, 1.2); car.tyreTs = U(50, 140); }
    const cx = {
      dt: chance(0.03) ? pick([0, NaN]) : DT, driverDelta: chance(0.03) ? NaN : U(-0.7, 0.7), assistDelta: chance(0.8) ? 0 : U(-0.05, 0.05),
      lineDelta: chance(0.8) ? undefined : U(-0.05, 0.05), onThrottle: chance(0.5), throttleLvl: U(0, 1), gearMult: U(0.6, 1.1), deploy: chance(0.5) ? 0 : U(-1, 3),
      braking: chance(0.35), surfaceMu: pick([1, 0.42, U(0.4, 1)]), kerbGrip: pick([1, U(0.8, 1)]), bankMu: pick([1, U(0.95, 1.1)]),
      modsCornering: pick([1, U(0.9, 1.3)]), modsBraking: chance(0.5) ? undefined : U(0.8, 1.2), loadF: U(0.38, 0.58), vertLoad: pick([0, U(-0.1, 0.2)]),
      af: 1.6, ar: 1.6, sp: chance(0.8) ? 1 : U(0, 1), steer: U(-1, 1), weatherGrip: pick([1, U(0.7, 1)]), aeroDf: pick([1, U(0.3, 1)]),
      dirtyMul: pick([1, U(0.8, 1)]), coastCut: pick([0.28, U(0.2, 0.6)]), vTopNow: pick([75.2, U(50, 95)]),
    };
    cx.loadR = 1 - cx.loadF;
    const carIn = structuredClone(car);
    pf.step(car, { ...cx, tyres });
    golden.playerForces.push({ G, level, wear, carIn, ctx: cx, out: snap(car, CAR_OUT) });
  }
  GripSteer.setLevel(1);
}

// ── WallClamp.apply (with WallEndFace) on the fake track ───────────────────
const WALL_OUT = ["s", "x", "speed", "head", "vLat", "wallT", "wasOnWall", "wallHits", "collideT", "px", "pz"];
golden.wallClamp = [];
for (let i = 0; i < 400; i++) {
  const which = i % 8 === 0 ? "pit" : pick(["plain", "pit", "street"]);
  const track = fakeTracks[which];
  const human = chance(0.75);
  const s = chance(0.6) ? U(100, 450) : U(0, FAKE_TOTAL);
  const car = {
    human, isPlayer: human && chance(0.8), s, x: U(-13, 15), speed: U(-4, 70), head: U(-Math.PI, Math.PI), vLat: chance(0.3) ? 0 : U(-4, 4),
    wasOnWall: chance(0.3), wallT: chance(0.5) ? undefined : U(0, 0.4), wallHits: chance(0.5) ? undefined : Math.floor(U(0, 5)),
    collideT: chance(0.5) ? 0 : U(-0.1, 0.4), px: U(-200, 200), pz: U(-200, 200), _prevS: chance(0.3) ? undefined : s - pick([U(0, 1.5), U(0, 25), -1]),
    team: { id: pick(["redbull", "mclaren", "haas"]) }, seat: pick([0, 1]), _wireId: chance(0.8) ? undefined : 7,
  };
  if (chance(0.15)) { car.px = undefined; car.pz = undefined; }
  if (i % 8 === 0) {   // aim at the fake pit wall's leading edge (node 40): the end-face case
    car.human = true; car.isPlayer = true; car.s = U(157.5, 166); car._prevS = U(149, 157); car.x = U(4.3, 5.7);
  }
  const carIn = structuredClone(car);
  const cx = { dt: pick([DT, DT, 0.1]), steer: U(-1, 1), soundOn: chance(0.7) };
  const smp = newSample(), postLim = { r: 0, l: 0, minOut: 0, side: 0 };
  fx.length = 0;
  WallClamp.apply(car, { track, dt: cx.dt, steer: cx.steer, postLim, smp, wrapS: fakeWrapS, worldFromTrack, soundOn: cx.soundOn,
    incidentSim: ctx.IncidentSim, addShake: () => fx.push("shake") });
  golden.wallClamp.push({ which, carIn, ctx: cx, out: snap(car, WALL_OUT), smp, fx: fx.slice() });
}

// ── Collide.resolveCollisions: small fields packed close on the fake track ──
const COL_OUT = ["s", "x", "prog", "speed", "vLat", "yawRateCur", "px", "pz", "contactT", "_pushD", "_preColS", "_preColX", "_preColSpd"];
golden.collide = [];
for (let i = 0; i < 200; i++) {
  const which = pick(["plain", "pit", "street"]);
  const n = pick([2, 3, 4, 14]);
  const base = U(50, 900);
  const cars = [];
  for (let k = 0; k < n; k++) {
    const human = k === 0 && chance(0.7);
    const sp = U(0, 70);
    const s = fakeWrapS(base + U(-6, 6) + (n > 4 ? k * 3 : 0));
    cars.push({ human, isPlayer: human, retired: chance(0.08), finished: chance(0.05), s, prog: s + 5000, x: U(-7, 7), speed: human && chance(0.1) ? U(-4, 0) : sp,
      vLat: human ? U(-3, 3) : 0, yawRateCur: human ? U(-1, 1) : 0, yawVis: human ? (chance(0.5) ? U(-0.2, 0.2) : U(-1.6, 1.6)) : U(-0.5, 0.5),
      px: 0, pz: 0, kTurn: chance(0.5) ? undefined : U(-0.02, 0.02), contactT: 0 });
  }
  const steps = pick([1, 3]);
  const G = { wrapS: fakeWrapS, track: fakeTracks[which], player: cars.find((c) => c.isPlayer) || null, netPlay: { owns: () => false },
    raceT: 0, PACE: pick([1, 0.84]), worldFromTrack: (s, x) => worldFromTrack(s, x) };
  const carsIn = structuredClone(cars);
  const fxCount = [0];
  const col = Collide.create(G, () => fxCount[0]++, () => false);
  const outs = [];
  for (let st = 0; st < steps; st++) {
    G.raceT = st * DT;
    if (st > 0) for (const c of cars) { c.s = fakeWrapS(c.s + c.speed * DT); c.prog += c.speed * DT; }
    col.resolveCollisions(cars, DT);
    outs.push(cars.map((c) => snap(c, COL_OUT)));
  }
  golden.collide.push({ which, PACE: G.PACE, carsIn, steps, outs, fx: fxCount[0] });
}

writeGolden("physics-modules.json", golden);
