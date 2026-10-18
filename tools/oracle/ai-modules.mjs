#!/usr/bin/env node
// Module fixtures for the AI ports (src/sim/ai/): run f1-game's REAL
// js/physics/{ai-drive,ai-band,ai-corridor}.js in a Node VM on seeded random
// inputs and write inputs + exact outputs to tests/goldens/ai-modules.json.
// tests/unit/ai-modules.test.ts replays every case with Object.is.
//
// Run: node tools/oracle/ai-modules.mjs     (F1_GAME=/path to override ../f1-game)
import { f1Sha, loadF1, rng, writeGolden } from "./lib.mjs";

const rand = rng(0xa1d71e);
const U = (lo, hi) => lo + (hi - lo) * rand();
const pick = (a) => a[Math.floor(rand() * a.length)];
const chance = (p) => rand() < p;
const ctx = loadF1(["js/core/mat4.js", "js/physics/consts.js", "js/physics/tyre-model.js", "js/physics/ai-drive.js", "js/physics/ai-band.js", "js/physics/ai-corridor.js"]);
const { AiDrive: A, AiBand, AiCorridor } = ctx;

const golden = { meta: { f1Sha: f1Sha(), generator: "tools/oracle/ai-modules.mjs" }, fns: [] };
const fn = (name, args, out) => golden.fns.push({ fn: name, args, out: out === undefined ? null : out });
const snapT = (t) => ({ ...t });
const randTraits = () => ({ craft: U(0, 1), awareness: U(0, 1), experience: U(0, 1), skill: U(0.9, 1), consistency: U(0.4, 1),
  aggression: chance(0.3) ? 0 : U(-1, 1), optimism: chance(0.3) ? 0 : U(-1, 1) });
const TEAMS = [null, { id: "ferrari", stats: { speed: 92, accel: 88, cornering: 90, braking: 86 } }, { id: "haas", stats: { speed: 80, accel: 79, cornering: 82, braking: 81 } }, { id: "mclaren" }];
const randTeam = () => pick(TEAMS);
const randOther = () => (chance(0.3) ? null : { team: randTeam(), seat: pick([0, 1, null]), human: chance(0.2), _snapX: chance(0.8) ? U(-6, 6) : undefined, x: U(-6, 6) });
const house = () => ({ team: randTeam(), seat: pick([0, 1, undefined]), stats: chance(0.2) ? { speed: U(70, 100), accel: U(70, 100), cornering: U(70, 100), braking: U(70, 100) } : null });

for (let i = 0; i < 250; i++) {
  const car = chance(0.2) ? {} : randTraits();
  fn("traits", [car], snapT(A.traits(car)));
  const h = house();
  fn("houseStyle", [h.team, h.seat, h.stats], snapT(A.houseStyle(h.team, h.seat, h.stats)));
  const o = randOther(), kind = pick(["ot", "defend", "follow"]);
  fn("ordersMul", [h.team, h.seat, o, kind], A.ordersMul(h.team, h.seat, o, kind));
  const t = randTraits(), street = chance(0.3);
  fn("followGap", [t, street, U(0, 90), U(-0.5, 1.5), h.team, h.seat, o, h.stats, chance(0.5) ? 0 : U(0, 0.5)], null);
  golden.fns[golden.fns.length - 1].out = A.followGap(...golden.fns[golden.fns.length - 1].args);
  fn("towGain", [street, chance(0.3) ? undefined : U(0.5, 2.5)], null);
  golden.fns[golden.fns.length - 1].out = A.towGain(...golden.fns[golden.fns.length - 1].args);
  const hc = { street, traits: chance(0.2) ? null : t, vTop: U(40, 90), queueT: U(0, 15), blockerVmax: U(50, 80), ourVmax: U(50, 80), blockerPace: chance(0.5) ? U(0.9, 1) : 0, ourPace: chance(0.5) ? U(0.9, 1) : 0 };
  fn("passHunger", [hc], A.passHunger(hc));
  const cc = { street, other: randOther(), traits: chance(0.2) ? {} : t, vTop: U(40, 90), chaserVmax: U(50, 80), ourVmax: U(50, 80), chaserPace: U(0.9, 1), ourPace: U(0.9, 1) };
  fn("coverConcede", [cc], A.coverConcede(cc));
  const qb = [U(0, 80), U(0, 80), street, chance(0.2) ? null : U(0, 40), chance(0.2) ? null : U(5, 30), pick([22, 18]), pick([1, 0.84, 0])];
  fn("queueBrake", qb, A.queueBrake(...qb));
  const qr = [U(10, 40), U(0, 80), U(0, 80), pick([22, 0]), pick([1, 0.84])];
  fn("queueReach", qr, A.queueReach(...qr));
  const d1 = [pick([0, U(-2, 2)]), pick([0, 1, -1])];
  fn("defendOnce", d1, snapT(A.defendOnce(d1[0], d1[1], {})));
  const cg = [chance(0.5), t, street];
  fn("contactGive", cg, A.contactGive(...cg));
  const fc = { ...house(), traits: t, blockerGap: chance(0.3) ? null : U(0, 20), gapAhead: U(0, 3), roomL: U(0, 5), roomR: U(0, 5), speed: U(0, 80),
    aheadSpeed: chance(0.3) ? null : U(0, 80), vTop: U(40, 90), kAhead: U(-0.03, 0.03), street, other: randOther() };
  fn("otFireRate", [fc], A.otFireRate(fc));
  const bc = { ...house(), traits: t, energy: U(0, 1), otActive: chance(0.2), kAhead60: U(-0.01, 0.01), towCar: chance(0.5), towGap: U(0, 40), towSpeed: U(0, 80),
    speed: U(0, 80), chaser: chance(0.5), chaserGap: U(0, 30), chaserSpeed: U(0, 80), ersDeploy: chance(0.3) ? null : U(0, 1), ersRegen: chance(0.3) ? null : U(0, 1),
    vTop: U(40, 90), street, towVmax: U(50, 80), ourVmax: U(50, 80), ourPace: U(0.9, 1), towPace: U(0.9, 1) };
  fn("wantBoost", [bc], A.wantBoost(bc));
  const xc = { ...house(), armed: pick([true, false, undefined]), catching: chance(0.3), otActive: chance(0.2), energy: chance(0.2) ? null : U(0, 1) };
  fn("wantX", [xc], A.wantX(xc));
  const ls = [U(-90, 90), U(0, 1), U(0.5, 1.3), pick([1, 0.84]), 72, pick([1, U(0.3, 1)])];
  fn("lateralScale", ls, A.lateralScale(...ls));
  fn("yawScale", ls.slice(0, 5), A.yawScale(...ls.slice(0, 5)));
  const cs = [U(-0.001, 0.05), U(0, 40), pick([1, 0.84]), 72];
  fn("cornerSpeed", cs, A.cornerSpeed(...cs));
  // brake planner: samples built through pushLook so the pooled path is exercised.
  A.beginLook();
  const samples = [];
  for (let k = 0, n = Math.floor(U(0, 30)); k < n; k++) {
    const s = [U(-5, 160), U(-0.04, 0.04), U(-0.2, 0.2), chance(0.5) ? undefined : U(0.9, 1.2)];
    A.pushLook(...s); samples.push(s);
  }
  const brc = { ...house(), traits: t, latMax: 22, diffCorner: U(0.9, 1), aeroLoad: chance(0.3) ? null : U(0, 1), brake: U(15, 25), pace: pick([1, 0.84]), vmax: 72,
    grip: U(0.7, 1.1), speed: U(0, 90), blocker: chance(0.4), blockerGap: U(0, 30), blockerSpeed: U(0, 80), roomL: U(0, 4), roomR: U(0, 4), errMul: pick([1, 1.05, undefined]) };
  const br = A.brakeDecision({ ...brc, samples: A.endLook() });
  fn("brakeDecision", [brc, samples], { ...br });
  const lc = { traits: t, nearby: Math.floor(U(0, 5)), roomL: U(0, 5), roomR: U(0, 5), street, baseLane: chance(0.3) ? null : U(-0.8, 0.8), queueT: U(0, 10) };
  fn("adaptLane", [U(-0.8, 0.8), lc, 1 / 60], null);
  golden.fns[golden.fns.length - 1].out = A.adaptLane(...golden.fns[golden.fns.length - 1].args);
  const pc = { ...house(), street, traits: t, speed: U(0, 80), blockerSpeed: U(0, 80), blockerGap: U(0, 20), roomL: U(0, 5), roomR: U(0, 5), roadL: U(0, 6), roadR: U(0, 6),
    other: randOther(), kAhead: U(-0.02, 0.02), lane: U(-0.8, 0.8), freeSpeed: U(0, 80), blockerVmax: chance(0.2) ? 0 : U(40, 80), vTop: U(40, 90), blockerAccel: U(-5, 5),
    attackQ: U(0, 1), toTurnIn: chance(0.1) ? undefined : U(0, 600), kTurn: U(-0.02, 0.02), calm: U(0, 1), roll: chance(0.2) ? null : U(0, 1), queueT: U(0, 12),
    ourVmax: U(50, 80), ourPace: U(0.9, 1), blockerPace: U(0.9, 1) };
  for (const f of ["otPull", "otWant", "latchLate", "attackOK", "passReach", "otSide"]) fn(f, [pc], A[f](pc));
  fn("passSideBonus", [pc, pick([1, -1])], null);
  golden.fns[golden.fns.length - 1].out = A.passSideBonus(...golden.fns[golden.fns.length - 1].args);
  const lp = [t, U(0, 1)];
  fn("launchPlan", lp, A.launchPlan(...lp));
  const plan = chance(0.2) ? null : { react: U(0, 0.8), grip: U(0.7, 1.1) };
  fn("launchMul", [U(-1, 5), plan], null); golden.fns[golden.fns.length - 1].out = A.launchMul(...golden.fns[golden.fns.length - 1].args);
  fn("launchDone", [U(-1, 5), plan], null); golden.fns[golden.fns.length - 1].out = A.launchDone(...golden.fns[golden.fns.length - 1].args);
  fn("startCalm", [chance(0.3), chance(0.3) ? undefined : U(0, 60), U(0, 60)], null); golden.fns[golden.fns.length - 1].out = A.startCalm(...golden.fns[golden.fns.length - 1].args);
  fn("pacePhase", [U(0, 300), chance(0.2) ? null : U(0, 1), chance(0.2) ? null : U(0, 1)], null); golden.fns[golden.fns.length - 1].out = A.pacePhase(...golden.fns[golden.fns.length - 1].args);
  fn("passTarget", [U(-6, 6), pick([1, -1]), U(2, 3), pick([U(4, 8), 0])], null); golden.fns[golden.fns.length - 1].out = A.passTarget(...golden.fns[golden.fns.length - 1].args);
  fn("passSideClosed", [U(0, 4), U(-1, 4), pick([2, 0])], null); golden.fns[golden.fns.length - 1].out = A.passSideClosed(...golden.fns[golden.fns.length - 1].args);
  fn("passHold", [t], A.passHold(t));
  fn("repassLock", [t, U(-0.05, 0.1)], null); golden.fns[golden.fns.length - 1].out = A.repassLock(...golden.fns[golden.fns.length - 1].args);
  fn("attemptRoll", [Math.floor(U(-2e9, 2e9)), Math.floor(U(0, 60)), Math.floor(U(0, 6000))], null); golden.fns[golden.fns.length - 1].out = A.attemptRoll(...golden.fns[golden.fns.length - 1].args);
  fn("runExtra", [U(-0.02, 0.02), U(0, 1), chance(0.7), street, U(0.5, 2.5)], null); golden.fns[golden.fns.length - 1].out = A.runExtra(...golden.fns[golden.fns.length - 1].args);
  fn("cornerK", [U(-0.02, 0.02), U(-0.02, 0.02), U(-0.02, 0.02)], null); golden.fns[golden.fns.length - 1].out = A.cornerK(...golden.fns[golden.fns.length - 1].args);
  const sc = { street, traits: t, vTop: U(40, 90), other: randOther(), ourVmax: U(50, 80), ourPace: U(0.9, 1), otherVmax: U(50, 80), otherPace: U(0.9, 1) };
  fn("sbsCommitT", [sc], A.sbsCommitT(sc));
  fn("sbsEase", [sc], A.sbsEase(sc));
  fn("queueTime", [chance(0.2) ? undefined : U(0, 10), chance(0.5), 1 / 60], null); golden.fns[golden.fns.length - 1].out = A.queueTime(...golden.fns[golden.fns.length - 1].args);
  fn("mistakeChance", [chance(0.1) ? null : t, U(-0.2, 1.2), pick([1, 1.8, 3.5, 0])], null); golden.fns[golden.fns.length - 1].out = A.mistakeChance(...golden.fns[golden.fns.length - 1].args);
  fn("mistakePhase", [pick([0, undefined, U(0, 3)])], null); golden.fns[golden.fns.length - 1].out = A.mistakePhase(...golden.fns[golden.fns.length - 1].args);
  fn("tyreClass", [U(0, 1), Math.floor(U(1, 60))], null); golden.fns[golden.fns.length - 1].out = A.tyreClass(...golden.fns[golden.fns.length - 1].args);
  fn("tyrePace", [pick(["soft", "medium", "hard", "x"]), U(-2, 40)], null); golden.fns[golden.fns.length - 1].out = A.tyrePace(...golden.fns[golden.fns.length - 1].args);
  fn("humanYieldT", [U(0, 1), chance(0.7), chance(0.3), chance(0.6), chance(0.5), 1 / 60, chance(0.5)], null); golden.fns[golden.fns.length - 1].out = A.humanYieldT(...golden.fns[golden.fns.length - 1].args);
  const ref = new Float32Array(4); ref[1] = U(0, 1);
  const psc = { speed: U(-5, 80), human: chance(0.5), paceF: chance(0.5) ? undefined : U(0.6, 1.2) };
  const pscIn = { ...psc, ref: Array.from(ref) };
  A.paceSample(ref, 1, psc, pick([0.5, U(40, 80)]), chance(0.5), 1 / 60);
  fn("paceSample", [pscIn], { ref: Array.from(ref), paceF: psc.paceF === undefined ? null : psc.paceF });
  fn("aimIntrudes", [U(-6, 6), U(-6, 6), U(-6, 6), U(2, 3)], null); golden.fns[golden.fns.length - 1].out = A.aimIntrudes(...golden.fns[golden.fns.length - 1].args);
  fn("mirrorReach", [chance(0.2) ? null : t, U(0, 90)], null); golden.fns[golden.fns.length - 1].out = A.mirrorReach(...golden.fns[golden.fns.length - 1].args);
  const dc = { ...house(), street, traits: t, speed: U(0, 80), chaser: chance(0.8), chaserGap: chance(0.1) ? null : U(0, 40), chaserSpeed: U(0, 80), kA: pick([0, U(-0.02, 0.02)]),
    roomL: U(0, 5), roomR: U(0, 5), other: randOther(), blocker: chance(0.4) ? {} : null, blockerGap: U(0, 40), kTurn: U(-0.02, 0.02), toTurnIn: U(0, 400),
    roadL: chance(0.2) ? null : U(0, 6), roadR: chance(0.2) ? null : U(0, 6), x: U(-6, 6), vTop: U(40, 90), chaserVmax: U(50, 80), ourVmax: U(50, 80), chaserPace: U(0.9, 1), ourPace: U(0.9, 1) };
  fn("defendPull", [dc], A.defendPull(dc));
  const bx = { contactT: chance(0.5) ? 0 : U(0, 0.3), roomL: U(0, 3), roomR: U(0, 3), blocker: chance(0.5) ? {} : null, blockerGap: U(0, 12), street };
  fn("isBoxed", [bx], A.isBoxed(bx));
  fn("digOutEscalated", [U(0, 8), t, street], null); golden.fns[golden.fns.length - 1].out = A.digOutEscalated(...golden.fns[golden.fns.length - 1].args);
  fn("letPassCase", [chance(0.9), chance(0.3) ? {} : null, chance(0.8) ? {} : null, U(0, 15), U(0, 80), U(0, 80), pick([1, 0.84]), chance(0.7)], null);
  golden.fns[golden.fns.length - 1].out = A.letPassCase(...golden.fns[golden.fns.length - 1].args);
  fn("minLatGap", [U(0, 8), street], null); golden.fns[golden.fns.length - 1].out = A.minLatGap(...golden.fns[golden.fns.length - 1].args);
  fn("lineFollow", [street, pick([0, U(-1, 1)])], null); golden.fns[golden.fns.length - 1].out = A.lineFollow(...golden.fns[golden.fns.length - 1].args);
  const band = { mode: pick(["scripted", "catchup", "x"]), leadProg: U(0, 6000), carProg: U(0, 6000), trackTotal: pick([5793, 0]), raceT: U(0, 30), launchT0: U(0, 5), bandAuth: pick([0.02, 0.08, 0.18, NaN]) };
  fn("bandFactor", [band], AiBand.factor(band));
  fn("bandApply", [U(40, 80), U(-0.1, 0.2), U(0.8, 1.05), pick([1, NaN])], null); golden.fns[golden.fns.length - 1].out = AiBand.applyVmax(...golden.fns[golden.fns.length - 1].args);
}
// AiCorridor.choose on random small fields.
for (let i = 0; i < 300; i++) {
  const mk = () => ({ x: U(-6, 6), prog: 1000 + U(-40, 40), speed: U(0, 80), retired: chance(0.05), finished: chance(0.05), corridorAccel: chance(0.3) ? undefined : U(-50, 30),
    _snapX: chance(0.8) ? U(-6, 6) : undefined, _snapProg: chance(0.8) ? 1000 + U(-40, 40) : undefined, _snapSpeed: chance(0.8) ? U(0, 80) : undefined });
  const car = mk(), blocker = mk();
  const cars = [car, blocker];
  for (let k = 0, n = Math.floor(U(0, 6)); k < n; k++) cars.push(mk());
  const cc = { street: chance(0.3), traits: randTraits(), roomL: U(0, 6), roomR: U(0, 6), roadL: U(0, 7), roadR: U(0, 7), blockerGap: U(0, 20), freeSpeed: chance(0.2) ? 0 : U(0, 80),
    blockerVmax: chance(0.2) ? 0 : U(40, 80), vTop: chance(0.2) ? 0 : U(40, 90), kTurn: U(-0.02, 0.02), kAhead: U(-0.02, 0.02), toTurnIn: U(0, 400), lane: U(-0.8, 0.8) };
  const clear = U(2, 3);
  const out = AiCorridor.choose(cc, car, blocker, cars, 5793, clear);
  fn("corridor", [cc, cars, clear], structuredClone(out));
}
// The wear-on strategy planner (ai-drive.js:1031-1380), on its own seed so the
// cases above keep their draws. `lifeLaps` travels as a { soft, medium, hard } table.
{
  const r2 = rng(0x57a7);
  const V = (lo, hi) => lo + (hi - lo) * r2();
  const P = (a) => a[Math.floor(r2() * a.length)];
  const C = (p) => r2() < p;
  const lifeTable = () => ({ soft: V(0.5, 30), medium: V(0.5, 45), hard: V(0.5, 60) });
  const tr = () => ({ craft: V(0, 1), awareness: V(0, 1), experience: V(0, 1), skill: V(0.9, 1), consistency: V(0.4, 1), aggression: 0, optimism: 0 });
  for (let i = 0; i < 400; i++) {
    const laps = P([1, 2, 3, 5, 6, 8, 10, 12, 15, 20, 25, 30, 44, 57, 70]) + (C(0.2) ? V(-0.6, 0.6) : 0);
    const life = C(0.15) ? null : lifeTable();
    const sp = {};
    if (C(0.9)) sp.laps = laps;
    if (life) sp.life = life;
    if (C(0.7)) sp.pitLossLaps = C(0.1) ? 0 : V(0.05, 0.6);
    if (C(0.9)) sp.roll = V(-0.1, 1.1);
    if (C(0.3)) sp.stops = P([-1, 0, 1, 2, 3, 1.7]);
    if (C(0.25)) sp.start = P(["soft", "medium", "hard", "wet", "inter"]);
    if (C(0.25)) sp.firstLife = P([0, V(0.5, 30)]);
    if (C(0.5)) sp.twoCompound = C(0.7);
    if (C(0.25)) sp.used = P([[], ["soft"], ["hard"], ["soft", "medium"], ["wet"]]);
    const { life: lt, ...rest } = sp;
    const ctxIn = lt ? { ...rest, lifeLaps: (cls) => lt[cls] } : rest;
    let out;
    try { out = structuredClone(A.stintPlan(ctxIn)); } catch (e) { out = { $throws: String(e && e.name) }; }
    fn("stintPlan", [sp], out);
    const lives = Array.from({ length: P([1, 2, 3]) }, () => V(0.2, 40));
    fn("splitStints", [Math.max(1, Math.floor(V(1, 70))), lives, P([undefined, 0, 0.22, V(0, 0.5)])], null);
    golden.fns[golden.fns.length - 1].out = A.splitStints(...golden.fns[golden.fns.length - 1].args);
    fn("degCost", [V(0, 40), V(-1, 40)], null);
    golden.fns[golden.fns.length - 1].out = A.degCost(...golden.fns[golden.fns.length - 1].args);
    const ct = lifeTable();
    const left = V(-3, 50);
    fn("compoundFor", [left, ct], A.compoundFor(left, (cls) => ct[cls]));
    const car = C(0.2) ? {} : tr();
    fn("strategyTemper", [car], { ...A.strategyTemper(car) });
    fn("tasteRoll", [V(-0.2, 1.2), car], null);
    golden.fns[golden.fns.length - 1].out = A.tasteRoll(...golden.fns[golden.fns.length - 1].args);
    const wc = {};
    if (C(0.85)) wc.lapsLeft = V(0, 30);
    if (C(0.9)) wc.wear = V(0, 2);
    if (C(0.7)) wc.pitLossLaps = P([0, -1, V(0.05, 0.6)]);
    fn("wornPays", [wc], A.wornPays(wc));
    const pc = { ...wc, stopsLeft: P([0, 1, 2]), lapsToStop: Math.floor(V(-2, 8)), wear: V(0.2, 1.15) };
    if (C(0.1)) pc.wrongTread = true;
    if (C(0.1)) pc.scripted = true;
    if (C(0.5)) pc.cautionLevel = P([0, 1, 2, 3, 4]);
    if (C(0.5)) pc.fits = C(0.7);
    if (C(0.5)) pc.rivalUsed = C(0.5);
    if (C(0.5)) pc.rivalBehindBoxed = C(0.5);
    if (C(0.5)) pc.stuckBehind = C(0.5);
    if (C(0.7)) pc.react = V(0.4, 1);
    if (C(0.7)) pc.attack = V(0.6, 1);
    fn("pitNow", [C(0.03) ? null : pc], null);
    golden.fns[golden.fns.length - 1].out = A.pitNow(golden.fns[golden.fns.length - 1].args[0]);
  }
  golden.strat = structuredClone(A.STRAT);
}
writeGolden("ai-modules.json.gz", golden);
