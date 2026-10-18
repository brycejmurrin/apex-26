#!/usr/bin/env node
// Writes tests/fixtures/race/*.json: scenario inputs and f1-game's outputs for
// the race rules, so the Vitest suite replays the same inputs through the
// TypeScript port without f1-game present.
//   node tools/race-fixtures/gen.cjs        (F1_GAME=/path/to/f1-game to override)
// Every scenario comes from a fixed mulberry32 seed: re-runs are byte-identical
// for the same f1-game revision.
"use strict";
const vm = require("vm");
const { context, load, rng, write } = require("./vm.cjs");

const pick = (r, a) => a[Math.floor(r() * a.length)];
const clone = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (v === Infinity ? 1e308 : v)));
const read = (ctx, name) => vm.runInContext(name, ctx);
const round3 = (x) => Math.round(x * 1000) / 1000;

// ─── hash32 ────────────────────────────────────────────────────────────────
{
  const ctx = context(); load(ctx, "js/core/hash32.js");
  const H = read(ctx, "Hash32"), r = rng(1);
  const cases = [];
  for (let i = 0; i < 200; i++) {
    const seed = Math.floor(r() * 2 ** 32), parts = [pick(r, ["dnf", "dnfAt", "q"]), Math.floor(r() * 30), "d" + Math.floor(r() * 40)];
    cases.push({ seed, parts, unit: H.unit(seed, ...parts), fnv: H.fnv1a(parts.join("|")) });
  }
  write("hash32", cases);
}

// ─── race-control: line crossing ───────────────────────────────────────────
function rcModule(debris) {
  const ctx = context({ DebrisWorld: debris || { active: () => true, hazards: () => ({ total: 0, sectors: [0, 0, 0], worst: { count: 0, sector: -1, frac: 0 } }) } });
  load(ctx, "js/race/race-control.js");
  return ctx;
}
{
  const R = read(rcModule(), "RaceControl"), r = rng(2);
  const out = [];
  for (let k = 0; k < 40; k++) {
    const total = 3000 + Math.floor(r() * 4000);
    const lapsTarget = 1 + Math.floor(r() * 5);
    const init = { lap: Math.floor(r() * 3), lapTime: r() * 5, finished: false, retired: false, fuelRestartLaps: r() < 0.2 ? 1 : 0 };
    const other = { finished: r() < 0.3, retired: false, finishT: round3(r() * 200) };
    const car = clone(init), cars = [car, other];
    const steps = [];
    let s = total - r() * 50, raceT = round3(r() * 100);
    for (let i = 0; i < 60; i++) {
      const dt = pick(r, [1 / 60, 1 / 30, 0]);
      const ds = (r() < 0.15 ? -1 : 1) * r() * 40;
      const oldS = s; let ns = (s + ds) % total; if (ns < 0) ns += total; s = ns;
      car.lapTime += dt; raceT += dt;
      const cross = R.lineTransition(car, oldS, ns, ds, total, lapsTarget, cars, raceT, dt);
      steps.push({ oldS, newS: ns, ds, raceT, dt, cross, car: clone(car) });
    }
    out.push({ total, lapsTarget, init, other, steps });
  }
  // The deferred step: two cars crossing in one physics step settle in clock order.
  const defer = [];
  for (let k = 0; k < 20; k++) {
    const total = 5000, lapsTarget = 3;
    const a = { lap: 3, lapTime: 80, finished: false, retired: false };
    const b = { lap: pick(r, [2, 3]), lapTime: 81, finished: false, retired: false };
    const init = clone([a, b]);
    const cars = [a, b];
    const oa = 4990 + r() * 9, ob = 4990 + r() * 9, raceT = 300, dt = 1 / 60;
    const order = r() < 0.5 ? [0, 1] : [1, 0];
    R.beginLineStep(cars);
    const crosses = [];
    const calls = [];
    for (const i of order) {
      const c = cars[i], o = i === 0 ? oa : ob;
      const cross = R.lineTransition(c, o, 5, 15, total, lapsTarget, cars, raceT, dt);
      crosses[i] = cross;
      R.deferLine(c, cross, 5, () => calls.push(i));
    }
    R.endLineStep();
    defer.push({ total, lapsTarget, init, oa, ob, raceT, dt, order, crosses, cars: clone(cars), calls });
  }
  write("line-transition", { line: out, defer });
}

// ─── race-control: classification, finish, short run ───────────────────────
function randomField(r, n, lapsTarget) {
  const cars = [];
  for (let i = 0; i < n; i++) {
    const retired = r() < 0.15, finished = !retired && r() < 0.5;
    const lap = finished ? lapsTarget + 1 - (r() < 0.2 ? 1 : 0) : Math.floor(r() * (lapsTarget + 1));
    const c = { id: "c" + i, lap, finished, retired, prog: round3(lap * 5000 + r() * 5000), human: i === 0 || (r() < 0.05) };
    if (finished) c.finishT = r() < 0.05 ? null : round3(300 + r() * 30);
    if (r() < 0.3) c.penalty = pick(r, [0, 5, 10]);
    if (r() < 0.05) c.dsq = "compound";
    cars.push(c);
  }
  return cars;
}
{
  const R = read(rcModule(), "RaceControl"), r = rng(3);
  const cases = [];
  for (let k = 0; k < 150; k++) {
    const lapsTarget = 1 + Math.floor(r() * 20), n = 2 + Math.floor(r() * 21);
    const cars = randomField(r, n, lapsTarget), init = clone(cars);
    const vTop = 80, raceT = round3(100 + r() * 1000);
    // js/game.js:2929-2949 verbatim (dsq = the cars the field already carries)
    const dsq = cars.filter((c) => c.dsq);
    const fin = cars.filter((c) => c.finished && !c.retired && !c.dsq).sort(R.finishOrder);
    const run = cars.filter((c) => !c.finished && !c.retired && !c.dsq);
    const leadProg = Math.max(0, ...fin.concat(run).map((c) => c.prog || 0));
    run.sort(R.runOrder(Math.max(0.25 * vTop, leadProg / Math.max(1, raceT))));
    const out = cars.filter((c) => c.retired).sort((a, b) => b.prog - a.prog);
    const order = R.classify(cars, fin, run, out).concat(dsq);
    order.forEach((c, i) => { c.finPos = i + 1; });
    const raceT0 = r() < 0.2 ? round3(r() * 50) : 0;
    const post = r() < 0.4 ? { solo: r() < 0.7, since: r() < 0.5 ? -1 : round3(raceT - r() * 100) } : null;
    const post0 = post ? clone(post) : null;
    const delay = R.finishDelay(init.map((c) => clone(c)), raceT, lapsTarget, raceT0, post);
    cases.push({
      lapsTarget, vTop, raceT, init, order: order.map((c) => c.id),
      classified: cars.map((c) => c.classified), finPos: cars.map((c) => c.finPos),
      shortRun: R.shortRun(init.map((c) => clone(c)), lapsTarget),
      flagOut: R.flagOut(init, 320),
      raceT0, post0, post, delay,
    });
  }
  write("classification", cases);
}

// ─── race-control: SC queue and hold cap ───────────────────────────────────
{
  const R = read(rcModule(), "RaceControl"), r = rng(4);
  const cases = [];
  for (let k = 0; k < 100; k++) {
    const total = 5000, n = 2 + Math.floor(r() * 10);
    const cars = [];
    for (let i = 0; i < n; i++) {
      const c = { prog: round3(r() * 20000), speed: round3(r() * 80), finished: r() < 0.05, retired: r() < 0.05 };
      if (r() < 0.3) c._snapProg = round3(c.prog + r() * 10);
      if (r() < 0.3) c._snapSpeed = round3(r() * 80);
      cars.push(c);
    }
    const ranked = cars.slice().sort((a, b) => b.prog - a.prog);
    const ci = Math.floor(r() * n), li = Math.floor(r() * n);
    cases.push({
      total, cars, ci, li, vTop: 80,
      frac: R.scQueueFrac(cars[ci], cars, total, cars[li], 80),
      hold: ranked.map((c) => R.holdCap(c, ranked)),
      rankedIdx: ranked.map((c) => cars.indexOf(c)),
    });
  }
  write("sc-queue", cases);
}

// ─── race-control: the caution machine ─────────────────────────────────────
function machineRun(seed, net, script) {
  const r = rng(seed);
  let hz = { total: 0, redTotal: null, sectors: [0, 0, 0], worst: { count: 0, sector: -1, frac: 0 } }, debrisOn = true;
  const ctx = rcModule({ active: () => debrisOn, hazards: () => hz });
  let storm = false, lowGrip = false;
  ctx.Storm = { is: (w) => w === "storm", SC_START_S: 90, SC_ROLL_S: 150 };
  ctx.TyreModel = { treadFor: () => (lowGrip ? 1 : 0) };
  const R = read(ctx, "RaceControl");
  const published = [], announced = [];
  const leader = { lap: 1 };
  const saved = new Map([["caution", true]]);
  const G = {
    state: "race", session: "race", timeTrial: false, raceT: 0, raceWeather: "dry",
    ranked: [leader],
    netPlay: { active: () => net, ownsRaceControl: () => true, reportCaution: (d) => published.push(clone(d)) },
    store: { get: (k, d) => (saved.has(k) ? saved.get(k) : d), set: (k, v) => saved.set(k, v) },
    announce: (t) => { announced.push(t); return true; },
    trackWetness: () => 0,
  };
  const rc = R.create(G);
  const steps = [];
  let lastInfo = "", lastRow = "";
  const levels = [0, 2, 4, 7, 11, 17];
  // A script is [[ticks, total, worstCount, events]...]: each segment sets the picture and fires its events once.
  const plan = [];
  if (script) for (const [n, tot, worst, evs] of script) for (let j = 0; j < n; j++) plan.push(j === 0 ? { tot, worst, evs: evs || [] } : null);
  const N = script ? plan.length : 2400;
  for (let i = 0; i < N; i++) {
    const ev = [];
    if (script) {
      const seg = plan[i];
      if (seg) {
        hz = { total: seg.tot, redTotal: null, sectors: [0, seg.worst, 0], worst: { count: seg.worst, sector: 1, frac: 0.5 } };
        ev.push(...seg.evs);
      }
    }
    const fresh = script ? !!plan[i] : i % 40 === 0 && (i === 0 || r() < 0.35);
    if (fresh && !script) {
      const tot = pick(r, levels), worst = Math.min(tot, Math.floor(r() * 5));
      hz = { total: tot, redTotal: r() < 0.3 ? Math.floor(tot / 2) : null, sectors: [Math.floor(r() * 3), worst, 0], worst: { count: worst, sector: Math.floor(r() * 3), frac: round3(r()) } };
    }
    const roll = script ? 1 : r();
    if (roll < 0.004) ev.push(["hold", Math.floor(r() * 4), pick(r, ["", "SCRIPT"])]);
    else if (roll < 0.006) ev.push(["enable", r() < 0.6]);
    else if (roll < 0.008) ev.push(["apply", { level: Math.floor(r() * 5), sector: 1, frac: 0.5, cause: "HOST", total: 3, sectors: [1, 2, 0], sinceT: 2, phase: "", replay: r() < 0.2 }]);
    else if (roll < 0.010) ev.push(["takeRestart"]);
    else if (roll < 0.011) ev.push(["clearHold"]);
    else if (roll < 0.012) ev.push(["rewound"]);
    else if (roll < 0.016) ev.push(["storm", !storm]);
    else if (roll < 0.018) ev.push(["lowGrip", !lowGrip]);
    else if (roll < 0.020) ev.push(["debris", !debrisOn]);
    else if (roll < 0.022) ev.push(["phase", pick(r, ["race", "race", "count", "results"])]);
    if (i % 300 === 299) ev.push(["lap"]);
    const out = {};
    for (const e of ev) {
      if (e[0] === "hold") out.hold = rc.hold(e[1], e[2]);
      else if (e[0] === "enable") out.enable = rc.setEnabled(e[1]);
      else if (e[0] === "apply") out.apply = rc.apply(e[1]);
      else if (e[0] === "takeRestart") out.takeRestart = rc.takeRestart();
      else if (e[0] === "clearHold") rc.clearHold();
      else if (e[0] === "rewound") rc.rewound();
      else if (e[0] === "storm") { storm = e[1]; G.raceWeather = storm ? "storm" : "dry"; }
      else if (e[0] === "lowGrip") lowGrip = e[1];
      else if (e[0] === "debris") debrisOn = e[1];
      else if (e[0] === "phase") G.state = e[1];
      else if (e[0] === "lap") leader.lap++;
    }
    const dt = 1 / 60;
    G.raceT += dt;
    rc.update(dt);
    const info = rc.info();
    // Compact: a field equal to the previous tick's is left out (the replay carries it forward).
    const row = { ot: rc.otEnabled(), otDetect: rc.otDetectOpen(), pub: published.length, ann: announced.length };
    const st = {};
    if (ev.length) st.ev = ev;
    if (fresh) st.hz = clone(hz);
    if (Object.keys(out).length) st.out = out;
    if (JSON.stringify(info) !== lastInfo) { st.info = info; lastInfo = JSON.stringify(info); }
    if (JSON.stringify(row) !== lastRow) { st.row = row; lastRow = JSON.stringify(row); }
    steps.push(st);
  }
  return { net, steps, published, announced };
}
const S60 = 60;   // ticks per second
write("caution-machine", [machineRun(5, false), machineRun(6, true), machineRun(7, false),
  // red: stopping, held, one restart request, the re-arm hold, then a lap-1 pile-up after clearHold
  machineRun(0, false, [[20 * S60, 17, 4], [S60, 17, 4, [["takeRestart"]]], [10 * S60, 0, 0], [S60, 0, 0, [["clearHold"], ["lap"]]], [5 * S60, 11, 2], [10 * S60, 0, 0, [["lap"]]], [5 * S60, 0, 0, [["lap"]]]]),
  // the hysteresis and the caps: VSC lowering at MIN_HOLD, a stale yellow at YELLOW_MAX, a stale SC at SC_MAX, the cap re-arm
  machineRun(0, false, [[3 * S60, 7, 1], [10 * S60, 3, 3], [40 * S60, 4, 3], [100 * S60, 12, 0], [60 * S60, 12, 0], [5 * S60, 0, 0]]),
  // scripted holds over the hazard loop, CAUTIONS off with a held flag, and a networked red that flies as a SC
  machineRun(0, true, [[2 * S60, 0, 0, [["hold", 3, "REAL SC"]]], [5 * S60, 17, 0], [3 * S60, 0, 0, [["hold", 1]]], [8 * S60, 0, 0, [["hold", 0]]],
    [3 * S60, 0, 0, [["enable", false], ["hold", 2]]], [100 * S60, 0, 0, [["hold", 0]]], [5 * S60, 0, 0, [["enable", true]]], [20 * S60, 17, 0]]),
]);

// ─── overtake mode ─────────────────────────────────────────────────────────
{
  const ctx = context(); load(ctx, "js/race/overtake-mode.js");
  const O = read(ctx, "OvertakeMode"), r = rng(8);
  const runs = [];
  for (let k = 0; k < 8; k++) {
    const track = { total: 4000 + Math.floor(r() * 2000), def: {} };
    const car = { s: track.total * 0.85, lap: 0, human: r() < 0.5, code: "TST", brakeDemand: 0 };
    O.reset(car);
    const steps = [];
    for (let i = 0; i < 800; i++) {
      const dt = 1 / 60;
      const prevS = car.s;
      car.s = (car.s + 60 * dt * (0.5 + r())) % track.total;
      if (car.s < prevS) car.lap++;
      const gap = round3(r() * 2), open = r() < 0.85, gate = r() < 0.8, speedOK = r() < 0.9, fire = r() < 0.05, thrust = r() < 0.8;
      const pushS = pick(r, [3.2, 4, 5.2, undefined]);
      O.lines(car, track, gap, open);
      O.arm(car, gate, speedOK);
      const started = O.prepare(car, fire, gate, speedOK, pushS);
      const frac = O.consume(car, dt, thrust, pushS);
      steps.push({ s: car.s, lap: car.lap, gap, open, gate, speedOK, fire, thrust, pushS, started, frac,
        car: { otE: car.otE, otOn: car.otOn, otEarned: car.otEarned, otArmed: car.otArmed, otT: car.otT, _otS: car._otS, _otLap: car._otLap, _otHold: car._otHold } });
    }
    runs.push({ track, human: car.human, steps });
  }
  const crossed = [];
  for (let i = 0; i < 300; i++) {
    const L = 5000, a = r() * L * 1.2 - 100, b = r() * L, at = r() * L;
    crossed.push({ a, b, at, L, v: O.crossed(a, b, at, L) });
  }
  write("overtake-mode", { runs, crossed, energy: O.energy() });
}

// ─── reliability ───────────────────────────────────────────────────────────
{
  const ctx = context({ M4: { clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v) } });
  load(ctx, "js/core/hash32.js");
  const H = read(ctx, "Hash32");
  const dev = {};
  ctx.Career = { hash: H.unit, TDEV_MAX: 8, TDEV_TO_PACE: 0.0025, paceMult: (id) => Math.min(1.1, Math.max(0.9, 1 + (dev[id] || 0) * 0.0025)) };
  load(ctx, "js/race/reliability.js");
  const Rel = read(ctx, "Reliability"), r = rng(9);
  const teams = ["merc", "ferrari", "mclaren", "rb", "aston", "alpine", "haas", "williams", "audi", "cadillac", "racingbulls"];
  const cases = [];
  for (let k = 0; k < 120; k++) {
    for (const t of teams) dev[t] = Math.round(r() * 16 - 8);
    const cars = [];
    for (let i = 0; i < 22; i++) {
      const t = teams[i >> 1];
      cars.push({ code: "D" + i, driverId: r() < 0.9 ? t + ":" + (i & 1) : "", tier: Math.floor(i / 5), team: { id: t, tier: 0 }, isPlayer: i === 21 });
    }
    const opts = { level: pick(r, ["off", "low", "real", "real", "bogus"]), seed: Math.floor(r() * 2 ** 32), round: Math.floor(r() * 24), build: pick(r, [0, 0.5, 1]), networked: r() < 0.2 };
    const init = clone(cars);
    Rel.arm(cars, opts);
    cases.push({ dev: clone(dev), opts, init, plan: Rel.plan(cars), cars: cars.map((c) => ({ dnfAt: c.dnfAt, dnfWhy: c.dnfWhy })) });
  }
  write("reliability", cases);
}

// ─── season-cal scoring ────────────────────────────────────────────────────
{
  const saved = new Map();
  const ids = ["bahrain", "monaco", "silverstone", "spa", "monza", "suzuka", "singapore", "cota", "imola", "estoril"];
  const LIST = ids.map((id, i) => ({ id, gp: id + " GP", classic: i >= 8 }));
  const ctx = context({
    GameStore: { store: { get: (k, d) => (saved.has(k) ? saved.get(k) : d), set: (k, v) => { saved.set(k, v); return true; } } },
    Tracks: { LIST, SEASON: LIST.filter((t) => !t.classic) },
    Teams: { POINTS: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], LIST: [{ id: "a", tier: 0 }, { id: "b", tier: 1 }, { id: "c", tier: 2 }, { id: "d", tier: 2 }] },
  });
  load(ctx, "js/career/save-migrate.js");
  load(ctx, "js/career/season-cal.js");
  const S = read(ctx, "SeasonCal"), r = rng(10);
  const pay = [];
  for (const table of [S.SPRINT_POINTS, S.CLASSIC_POINTS, [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]]) {
    for (const scoring of ["race", "sprint"]) {
      for (let laps = 0; laps <= 12; laps++) pay.push({ table, scoring, run: laps === 12 ? null : { laps, of: 10 }, out: S.payTable(table, scoring, laps === 12 ? null : { laps, of: 10 }) });
    }
  }
  const seasons = [];
  S.engage("season");
  for (let k = 0; k < 12; k++) {
    const cfg = {
      trackIds: ids.slice(0, 3 + Math.floor(r() * 6)), quali: true,
      sprint: pick(r, [false, true, "rounds"]), sprintIds: [ids[1], ids[3]],
      laps: 3, points: pick(r, ["modern", "classic"]), flPoint: r() < 0.5, drop: pick(r, [0, 0, 2, 3]),
    };
    S.setConfig(cfg);
    const season = S.restart();
    const drivers = [];
    for (let i = 0; i < 12; i++) drivers.push({ driverId: "abcd"[i % 4] + ":" + (i >> 2), code: "D" + i, team: { id: "abcd"[i % 4] } });
    const awards = [];
    let guard = 0;
    while (S.canRace(season) && guard++ < 40) {
      const order = drivers.slice().sort(() => r() - 0.5).map((d) => Object.assign({}, d, { retired: r() < 0.1, classified: r() < 0.1 ? false : undefined }));
      order.forEach((c) => { if (c.classified === undefined) delete c.classified; });
      const fastest = r() < 0.9 ? pick(r, drivers).driverId : null;
      const run = r() < 0.2 ? { laps: Math.floor(r() * 10), of: 10 } : null;
      const stage = S.stage(season);
      const table = S.pointsTable();
      const scored = S.award(season, order, fastest, run);
      awards.push({ stage, table, order, fastest, run, scored, season: clone(season) });
    }
    const idList = drivers.map((d) => d.driverId);
    seasons.push({
      cfg: clone(S.config()), awards,
      standings: idList.slice().sort((a, b) => S.rank(season, a, b)),
      net: Object.fromEntries(idList.map((id) => [id, S.netPts(season, id)])),
      teams: ["a", "b", "c", "d"].sort((a, b) => S.rankTeams(season, a, b)),
    });
  }
  write("season-points", { pay, seasons });
}

// ─── start lights ──────────────────────────────────────────────────────────
{
  const ctx = context(); load(ctx, "js/race/start-lights.js");
  const SL = read(ctx, "StartLights"), r = rng(11);
  const credit = [];
  for (let i = 0; i < 100; i++) {
    const w = pick(r, [-1, 0, r() * 2]), d = pick(r, [0, 1 / 60, r() * 0.3]), dr = pick(r, [0, -1, r() * 0.1]);
    credit.push({ w, d, dr, v: SL.countCredit(w, d, dr) });
  }
  const sl = SL.create({ state: "menu" }, { Particles: null });
  const lamps = [];
  for (let k = 0; k < 20; k++) {
    const n = 200, px = [], pz = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; px.push(Math.cos(a) * 500); pz.push(Math.sin(a) * 300); }
    const list = [];
    for (let j = 0; j < 4; j++) list.push({ kind: pick(r, ["gantry", "gantry", "bridge"]), side: pick(r, [0, 0, 1]), k: Math.floor(r() * n), x: r() * 10, y: 5, z: r() * 10, h: 4, startLights: r() < 0.3, face: pick(r, [undefined, 0.5]), lamp: r() < 0.3 ? [1, 7, 2] : undefined });
    const track = { n, px, pz, props: { list }, startGate: { c: [0, 6, 0], t: [1, 0, 0] } };
    lamps.push({ track: clone(track), lamps: sl.lampsFor(track) });
  }
  write("start-lights", { credit, lamps });
}

// ─── weather arc (lap-wide) ────────────────────────────────────────────────
{
  const ctx = context({ Particles: { rainShow() {}, rainSeed() {} }, GameAudio: { startRain() {}, stopRain() {} } });
  load(ctx, "js/core/hash32.js");
  ctx.Career = { hash: read(ctx, "Hash32").unit };
  load(ctx, "js/race/weather-arc.js");
  const W = read(ctx, "WeatherArc"), r = rng(12);
  const runs = [];
  for (let k = 0; k < 24; k++) {
    const announced = [];
    const G = {
      raceWeather: "dry", raceT: 0, state: "race", track: null, soundOn: false, headlessMode: false,
      isWetRoad: () => false, isRaining: () => false, initRainDrops() {}, applyRaceSettings() {},
      announce: (t) => announced.push(t), netPlay: { active: () => false }, simSeed: () => 1, raceRound: 0,
    };
    const wa = W.create(G, { isTimeTrial: () => false, isQuali: () => false });
    const from = pick(r, W.VALID), to = pick(r, W.VALID), dur = 30 + Math.floor(r() * 300);
    G.raceWeather = pick(r, W.VALID);
    const w0 = G.raceWeather;
    const start = wa.startArc(from, to, dur);
    const steps = [];
    let retarget = null;
    for (let i = 0; i < 900; i++) {
      G.raceT += 1;
      if (i === 120 && r() < 0.4) { retarget = { to: pick(r, W.VALID), dur: 20 + Math.floor(r() * 200) }; wa.startArc(G.raceWeather, retarget.to, retarget.dur); }
      wa.tick(1);
      steps.push([G.raceWeather, wa.wetness(), wa.arc ? wa.arc.wetIn : -1]);
    }
    runs.push({ w0, from, to, dur, armed: !!start, wetIn: start ? start.wetIn : null, retarget, steps, announced });
  }
  const plans = [];
  for (let i = 0; i < 200; i++) {
    const seed = Math.floor(r() * 2 ** 32), round = Math.floor(r() * 30), from = pick(r, W.VALID), laps = pick(r, [0, 3, 5, 25, 57]), len = pick(r, [0, 3337, 5793, 7004]);
    const G = { raceWeather: from, simSeed: () => seed, raceRound: round, seasonMode: false, track: { total: len }, state: "race", lapsTarget: laps, raceLaps: laps };
    const wa = W.create(G, { isTimeTrial: () => false, isQuali: () => false });
    plans.push({ seed, round, from, laps, len, plan: wa.previewPlan({ laps, len, from }) });
  }
  const seqs = [];
  for (const a of W.VALID) for (const b of W.VALID) seqs.push({ a, b, seq: W.arcSeq(a, b) });
  write("weather-arc", { runs, plans, seqs });
}

// ─── qualifying model ──────────────────────────────────────────────────────
{
  const ctx = context();
  load(ctx, "js/core/hash32.js");
  const H = read(ctx, "Hash32");
  let cons = {};
  ctx.Career = { inCareer: () => false, hash: H.unit, devFor: () => 0 };
  ctx.PhysicsConsts = { VMAX: 72, DIFF: { easy: { ai: 0.851 }, normal: { ai: 0.911 }, hard: { ai: 1.030 } } };
  ctx.DriverRatings = { get: (code) => ({ consistency: cons[code] }) };
  ctx.Teams = { TIER_V: [0.9695, 0.9674, 0.9648, 0.9622, 0.9594] };
  let curv = null;
  ctx.Tracks = { curvature: (t, s) => curv(s) };
  load(ctx, "js/race/quali-model.js");
  const Q = read(ctx, "Quali"), r = rng(13);
  const cases = [];
  for (let k = 0; k < 24; k++) {
    const total = 3300 + Math.floor(r() * 3700), n = 400 + Math.floor(r() * 1200);
    const kp = { a: 0.002 + r() * 0.03, f1: 3 + Math.floor(r() * 9), b: r() * 0.02, f2: 7 + Math.floor(r() * 13) };
    curv = (s) => kp.a * Math.sin(2 * Math.PI * kp.f1 * s / total) + kp.b * Math.cos(2 * Math.PI * kp.f2 * s / total);
    const pace = pick(r, [1, 1, 0.44, 0.7, 1.34]);
    const env = { latMax: 30 + r() * 10, aTop: 9 * pace, brake: 40, vTop: 72 * pace, difficulty: pick(r, ["easy", "normal", "hard", "bogus"]) };
    const cars = [];
    cons = {};
    for (let i = 0; i < 12; i++) {
      const code = "C" + i;
      cons[code] = Math.round(r() * 100);
      cars.push({ driverId: "t" + (i >> 1) + ":" + (i & 1), code, name: "N" + i, team: { id: "t" + (i >> 1) }, isPlayer: i === 5, tierV: 0.96 + r() * 0.01, skill: 0.9 + r() * 0.1, grip: pick(r, [1, 1, 0.8]) });
    }
    const round = Math.floor(r() * 24), seed = Math.floor(r() * 2 ** 32);
    const G = {
      LAT_MAX: env.latMax, aTop: () => env.aTop, BRAKE: env.brake, vTop: () => env.vTop, difficulty: env.difficulty,
      track: { n, total, def: { id: "trk" + k } }, cars, seasonMode: true, seasonRound: round, simSeed: () => seed,
      gripMult: (c) => (c ? c.grip : 1), flow: "gp",
    };
    const q = Q.create(G);
    const driven = pick(r, [0, 0, 80 + r() * 20, Infinity, { "t0:0": 85, "t3:1": 90 }]);
    const rows = q.preview(driven);
    cases.push({ total, n, kp, env, cars, cons: clone(cons), round, seed, driven: driven === Infinity ? "Inf" : driven, rows, pole: q.referencePole(), lap0: q.carLap(cars[0], G.track, 1) });
  }
  const medals = [];
  for (let i = 0; i < 100; i++) { const t = pick(r, [0, -1, 80 + r() * 20]), pole = pick(r, [0, 85]); medals.push({ t, pole, m: Q.medalFor(t, pole) }); }
  write("quali-model", { cases, medals });
}

// ─── sporting regs ─────────────────────────────────────────────────────────
{
  const ctx = context(); load(ctx, "js/race/sporting-regs.js");
  const S = read(ctx, "SportingRegs"), r = rng(14);
  const comp = [];
  for (let i = 0; i < 150; i++) {
    const log = []; const n = Math.floor(r() * 4);
    for (let j = 0; j < n; j++) log.push({ code: pick(r, ["S", "M", "H", "I", "W", "?"]) });
    const cars = [{ code: "A", tyreLog: log, retired: r() < 0.1, dsq: r() < 0.1 ? "old" : undefined, penalty: pick(r, [undefined, 5]) }];
    const o = { applies: r() < 0.8, suspended: r() < 0.3 };
    const init = clone(cars);
    const out = S.applyCompoundRule(cars, o);
    comp.push({ init, o, run: S.compoundsRun(log), out: out.length, cars: clone(cars) });
  }
  // A field circulating under random cautions; the player passes and is passed.
  // fieldSim() is replayed verbatim by tests/unit/race/sporting-regs.test.ts from the same seed,
  // so only the watchers' outputs are stored (each row only when it changed).
  const pass = [];
  for (let k = 0; k < 40; k++) {
    const rr = rng(1400 + k);
    const n = 8, field = [];
    for (let i = 0; i < n; i++) field.push({ code: "K" + i, prog: 1000 - i * 30 + rr() * 10, speed: 60, retired: false, finished: false, lap: 1, pitState: "none" });
    field[0].prog = 1210 + rr() * 10;   // most of a lap up on the player: it comes up behind to lap them (blue flags)
    const p = field[4];
    const troubledIdx = Math.floor(rr() * n);
    const win = pick(rr, [5, 3, undefined]);
    const w = S.createPassWatch(win, (o) => o === field[troubledIdx] && o.prog > 1500);
    const b = S.createBlueFlagWatch((q) => q.prog < 0);
    const steps = [];
    let level = 0, last = "";
    for (let t = 0; t < 1200; t++) {
      if (t % 60 === 0) level = pick(rr, [0, 0, 0, 1, 2, 3]);
      for (const c of field) {
        if (c.retired || c.finished) continue;
        c.prog += (c === p ? 1 + rr() * 0.9 : 0.9 + rr() * 0.7) + (c === field[0] ? 0.3 : 0);
        if (rr() < 0.0005) c.retired = true;
        if (rr() < 0.002) c.pitState = c.pitState === "none" ? "lane" : "none";
        if (t > 1100 && rr() < 0.02) { c.finished = true; c.finishT = t + rr(); }
      }
      const ev = w.tick(p, field, level, 1 / 60);
      const be = b.tick(p, field, { total: 400, vRef: 80, caution: level, race: true }, 1 / 60);
      const row = JSON.stringify([w.info(), b.info()]);
      if (ev || be || row !== last) { steps.push({ t, ev, be, info: w.info(), binfo: b.info() }); last = row; }
    }
    pass.push({ steps, final: field.map((c) => c.prog) });
  }
  const jumps = [];
  for (let i = 0; i < 100; i++) {
    const th = pick(r, [0, 0.1, 0.13, 1, NaN, "x"]), auto = r() < 0.2, t = pick(r, [-1, 0.1, 0.19, 0.2, 1]), v = pick(r, [0, 3, 3.3, 10]), vRef = pick(r, [0, 80]);
    jumps.push({ th: typeof th === "number" && Number.isNaN(th) ? "NaN" : th, auto, t, v, vRef, early: S.jumpStartEarlyThrottle(th, auto), fast: S.jumpStartFastLaunch(t, v, vRef) });
  }
  write("sporting-regs", { comp, pass, jumps, pens: [0, 1, 2, 3, 4].map(S.passPenaltyS) });
}
