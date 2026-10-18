#!/usr/bin/env node
// Race goldens for the AI step: 3-car runs on Monza through f1-game's REAL
// game.js (../f1-game/tools/lib/game-vm.cjs), in the pinned world of
// tools/oracle/physics.mjs, 600 steps each:
//
//   race-player-2ai   the player (scripted input) with two AI cars placed just
//                     ahead and just behind it — traffic scans, the pass latch,
//                     slipstream and car-to-car contact all in play;
//   race-3ai-start    three AI cars from a standing grid start (the player
//                     retired): the launch model, follow gaps, the brake planner.
//
// Recorded: every car's primitive state after reset/placement (all 22, the
// retired ones included), the world scalars and the sim RNG state; per step the
// player input, each active car's state as raw doubles, and the TRACK TAPE:
// every top-level track query the step made, in call order — the Tracks façade,
// ContactGeometry.wallLimits, the racing line (TrackLine.at / pathK / attackAt)
// and element reads of track.attackQ.
//
// Run: node tools/oracle/race.mjs      (F1_GAME=/path to override ../f1-game)
import { createRequire } from "node:module";
import path from "node:path";
import { F1, f1Sha, writeGolden } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { createGame, settle } = require(path.join(F1, "tools", "lib", "game-vm.cjs"));
const STEPS = 600;
const TRACK = "monza";
const PINNED_STORAGE = Object.freeze({
  tyreWear: "off", wind: "off", reliability: "off", caution: false,
  drivingHelp: 1, gripSteer: 1, raceLine: 0, autoThrottle: false, throttleLatch: false, manual: false,
});
const STATE = ["s", "x", "px", "pz", "head", "speed", "vLat", "yawRateCur", "prog", "lap", "gear", "rpm", "steerSm", "kerbGripSm",
  "axEstSm", "energy", "aeroX", "onKerb", "offroad", "wallT", "wasOnWall", "collideT", "contactT", "yawVis", "_prevS", "lapTime",
  "aiHead", "aiBias", "aiFam", "lane", "kTurn", "queueT", "stuckT", "passT", "passCool", "passFailT", "sbsT", "hYieldT", "pressT",
  "errT", "accSm", "corridorAccel", "towing", "wake", "launchOn", "calm", "runT", "atkWant", "atkOn", "_pushD", "paceF", "rank"];
const REFS = ["passOf", "passFailOf", "_qOf", "_alPrev"];

const g = await createGame({ track: TRACK, wx: "dry", storage: PINNED_STORAGE });
const S = g.sandbox, G = g.G, a = g.apex;
if (!(await settle(() => !!(S.TrackScenery && S.TrackScenery[TRACK]), 4000))) throw new Error("TrackScenery never loaded");
a.weather("dry");
a.step(0, 1);
if (G.ROAD_FOLLOW !== 0) throw new Error("ROAD_FOLLOW is not 0");

// ── the tape (as tools/oracle/physics.mjs, plus the racing line) ─────────────
let tape = null, depth = 0;
function wrap(obj, name, record) {
  const f = obj[name];
  obj[name] = function (...args) {
    if (depth > 0 || !tape) { depth++; try { return f.apply(this, args); } finally { depth--; } }
    depth++;
    let r;
    try { r = f.apply(this, args); } finally { depth--; }
    tape.push(record(args, r));
    return r;
  };
}
const v3 = (v) => [v[0], v[1], v[2]];
const T = S.Tracks;
wrap(T, "sample", ([, s], r) => ["sample", s, v3(r.p), v3(r.t), v3(r.r), r.hw]);
wrap(T, "banking", ([, s, x, , smooth], r) => ["banking", s, x, smooth === undefined ? null : !!smooth, r ? [r.dy, r.roll] : null]);
wrap(T, "onKerb", ([, s, x], r) => ["onKerb", s, x, r]);
wrap(T, "inPitLane", ([, s, x], r) => ["inPitLane", s, x, !!r]);
wrap(T, "wallAt", ([, s, side], r) => ["wallAt", s, side, r]);
wrap(T, "postLimits", ([, s, x], r) => ["postLimits", s, x, [r.r, r.l, r.minOut, r.side]]);
wrap(T, "curvature", ([, s], r) => ["curvature", s, r]);
wrap(T, "bankAngle", ([, s], r) => ["bankAngle", s, r]);
S.ContactGeometry = Object.assign({}, S.ContactGeometry);
wrap(S.ContactGeometry, "wallLimits", ([, s, x, , , prev], r) => ["wallLimits", s, x, prev ? [prev.s, prev.x] : null, [r.r, r.l, r.laneMin, r.side]]);
S.TrackLine = Object.assign({}, S.TrackLine);
wrap(S.TrackLine, "at", ([, s, fam], r) => ["lineAt", s, fam === undefined ? null : fam, [r.x, r.w]]);
wrap(S.TrackLine, "pathK", ([, s], r) => ["pathK", s, r]);
wrap(S.TrackLine, "attackAt", ([, s], r) => ["attackAt", s, [r.q, r.toTurnIn]]);
const KNOWN = new Set(["sample", "banking", "onKerb", "inPitLane", "wallAt", "postLimits", "curvature", "bankAngle"]);
for (const k of Object.keys(T)) if (typeof T[k] === "function" && !KNOWN.has(k)) wrap(T, k, (args) => ["UNTAPED:" + k, ...args.slice(1).filter((v) => typeof v === "number")]);
if (G.track.attackQ) {
  const raw = G.track.attackQ;
  G.track.attackQ = new Proxy(raw, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (typeof v === "function") return v.bind(t);
      if (depth === 0 && tape && typeof k === "string" && /^\d+$/.test(k)) tape.push(["attackQ", +k, v === undefined ? null : v]);
      return v;
    },
  });
}

// game.js's paceRef() (pace-math.js:62) is private and persists across resets:
// snapshot it at the first paceSample call of each trace, before it mutates.
let paceRefStart = null, wantPaceRef = false;
{
  const ps = S.AiDrive.paceSample;
  S.AiDrive.paceSample = function (ref, ...rest) {
    if (wantPaceRef) { paceRefStart = Array.from(ref); wantPaceRef = false; }
    return ps.call(this, ref, ...rest);
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────
const prim = (v) => v === null || typeof v === "number" || typeof v === "boolean" || typeof v === "string";
function fullState(c) {
  const o = {};
  for (const k of Object.keys(c)) {
    const v = c[k];
    if (v === undefined) o[k] = { $undef: true };
    else if (prim(v)) o[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "number")) o[k] = v.slice();
    else if (REFS.includes(k) && v && typeof v === "object") o[k] = { $car: G.cars.indexOf(v) };
    else if (k === "team" && v && typeof v === "object") o[k] = { $obj: { id: v.id, ...(v.stats ? { stats: { ...v.stats } } : {}) } };
    else if (v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => prim(x) || (x && typeof x === "object" && Object.values(x).every(prim)))) o[k] = { $obj: JSON.parse(JSON.stringify(v)) };
  }
  return o;
}
function pick(c) {
  const o = {};
  for (const k of STATE) o[k] = c[k] === undefined ? null : c[k];
  for (const k of REFS) o[k] = c[k] ? G.cars.indexOf(c[k]) : -1;
  return o;
}
const world = () => ({
  raceT: G.raceT, state: G.state, seed: G.seed, simSeed: G.simSeed(), rngState: G.simSeed(undefined, true),
  raceRound: G.raceRound, difficulty: G.difficulty, aiPace: S.AiBand.mode(),
  PACE: G.PACE, vTop: G.vTop(), aTop: G.aTop(), LAT_MAX: G.LAT_MAX,
  PLAYER_GRIP: G.PLAYER_GRIP, FRONT_GRIP: G.FRONT_GRIP, DRIFT: G.DRIFT, YAW_INERTIA: G.YAW_INERTIA, YAW_DAMP: G.YAW_DAMP,
  WHEELBASE: G.WHEELBASE, STEER_EXPO: G.STEER_EXPO, STEER_MAX_SLIP: G.STEER_MAX_SLIP, STEER_SPEED_REF: G.STEER_SPEED_REF,
  raceAeroMode: G.raceAeroMode, raceDirtyAir: G.raceDirtyAir, ROAD_FOLLOW: G.ROAD_FOLLOW, soundOn: !!G.soundOn, aeroZones: G.aeroZones.map((z) => [z.start, z.end]),
  raceWeather: G.raceWeather, session: G.session, lapsTarget: G.lapsTarget,
  trackTotal: G.track.total, trackN: G.track.n, street: !!G.track.street,
});

function run(id, setup, inputAt) {
  a.weather("dry");
  a.step(0, 1);
  const active = setup();
  if (G.raceWeather !== "dry" || G.trackWetness() !== 0) throw new Error("weather is not dry");
  const live = G.cars.map((c, i) => (!c.retired ? i : -1)).filter((i) => i >= 0);
  if (live.join() !== active.filter((i) => !G.cars[i].retired).join()) throw new Error(`live cars ${live} != active ${active}`);
  const initial = { cars: G.cars.map(fullState), world: world(), active, playerIdx: G.cars.indexOf(G.player) };
  const dt = S.PhysicsConsts.FIXED_DT;
  const steps = [];
  const untaped = new Set();
  wantPaceRef = true;
  paceRefStart = null;
  for (let i = 0; i < STEPS; i++) {
    const inp = inputAt ? Object.assign({}, inputAt(i)) : null;
    if (inp) a.setInput(inp);
    tape = [];
    a.step(dt, 1);
    const t = tape;
    tape = null;
    for (const e of t) if (String(e[0]).startsWith("UNTAPED:")) untaped.add(e[0]);
    steps.push({ input: inp, cars: active.map((ci) => pick(G.cars[ci])), raceT: G.raceT, rngState: G.simSeed(undefined, true), tape: t });
  }
  a.clearInput();
  if (untaped.size) console.warn(`${id}: untaped track calls ${[...untaped].join(", ")}`);
  writeGolden(`race-${id}.json.gz`, {
    header: { schema: "apex-26-race-golden/1", f1Sha: sha, REVISION: S.PhysicsConsts.REVISION, track: TRACK, trace: id, steps: STEPS,
      FIXED_DT: dt, storage: PINNED_STORAGE, generator: "tools/oracle/race.mjs" },
    initial: { ...initial, paceRef: paceRefStart }, steps,
  });
}

const sha = f1Sha();
const L = () => G.track.total;
const others = () => G.cars.map((c, i) => i).filter((i) => G.cars[i] !== G.player);

// 1. player + two placed AI cars.
run("player-2ai", () => {
  a.seed(7);
  a.reset(0.12, 50, 0);
  const pi = G.cars.indexOf(G.player);
  const [ia, ib] = others().slice(0, 2);
  a.aiPlace(ia, (0.12 * L() + 16) / L(), 28, 0.3);
  a.aiPlace(ib, (0.12 * L() - 14) / L(), 56, -1.0);
  G.cars.forEach((c, i) => { if (i !== pi && i !== ia && i !== ib && !c.retired) a.retire(i, "oracle"); });
  return [pi, ia, ib].sort((x, y) => x - y);
}, (i) => (i < 300 ? { throttle: true, steer: 0.02 } : { throttle: true, steer: -0.03 }));

// 2. three AI cars from the standing grid start, the player retired.
run("3ai-start", () => {
  a.seed(11);
  a.reset(0.5, 0, 0);
  const byGrid = others().sort((x, y) => (G.cars[x].gridPos | 0) - (G.cars[y].gridPos | 0));
  const keep = byGrid.slice(0, 3);
  g.aiOnly();
  G.cars.forEach((c, i) => { if (!keep.includes(i) && !c.retired) a.retire(i, "oracle"); });
  return keep.sort((x, y) => x - y);
}, null);


g.close();
