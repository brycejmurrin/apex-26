#!/usr/bin/env node
// Physics goldens for the T1.6 player-step gate: boot the REAL f1-game
// (../f1-game/tools/lib/game-vm.cjs) on Monza, pin the world, replay the four
// physics-characterization recipes for 600 steps each, and write per trace:
//
//   - the player's full primitive state after reset (so the port starts from
//     the identical car), and the world scalars the step reads;
//   - per step: the input, the player state after the step (raw doubles), and
//     the TRACK TAPE: every track query the game made during that step, in
//     call order, with its arguments and its exact result.
//
// The tape is what makes the T1.6 replay independent of the track lane: the
// port's TrackQuery is served from it, and any query whose arguments differ
// from f1-game's is itself the first divergence.
//
// Pinned world, after f1-game tools/check/physics-oracle.mjs (branch
// cursor/physics-oracle-7c3e, PINNED_STORAGE / bootPinned / retireField):
// factory seat, tyre wear / wind / reliability / cautions off, every assist
// off, dry with zero wetness, TrackScenery resident, every AI car retired
// after each reset.
//
// Run: node tools/oracle/physics.mjs [--steps 600]      (F1_GAME=/path to override ../f1-game)
import { createRequire } from "node:module";
import path from "node:path";
import { F1, f1Sha, writeGolden } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { createGame, settle } = require(path.join(F1, "tools", "lib", "game-vm.cjs"));

const argSteps = process.argv.indexOf("--steps");
const STEPS = argSteps > 0 ? Number(process.argv[argSteps + 1]) : 600;
const TRACK = "monza";

// physics-oracle.mjs PINNED_STORAGE (game-vm adds tyreWear/wind off itself).
const PINNED_STORAGE = Object.freeze({
  tyreWear: "off", wind: "off", reliability: "off", caution: false,
  drivingHelp: 1, gripSteer: 1, raceLine: 0, autoThrottle: false, throttleLatch: false, manual: false,
});

// Verbatim from f1-game tests/unit/physics-characterization-vm.test.mjs (and
// tests/specs/physics-characterization.spec.js SCENARIOS). The last stage's
// input is held until STEPS.
const RECIPES = [
  { id: "straight-line-accel", name: "straight-line accel", seed: 7, frac: 0.05, speed: 20,
    steps: [{ n: 120, in: { throttle: true, steer: 0 } }] },
  { id: "steady-corner-load", name: "steady corner load", seed: 7, frac: 0.28, speed: 55,
    steps: [{ n: 90, in: { throttle: true, steer: 0.6 } }] },
  { id: "trail-brake-into-rotation", name: "trail brake into rotation", seed: 11, frac: 0.28, speed: 70,
    steps: [{ n: 45, in: { brake: true, steer: 0.5 } }, { n: 45, in: { throttle: true, steer: 0.3 } }] },
  { id: "off-track-recovery", name: "off-track recovery", seed: 3, frac: 0.5, speed: 45, x: 11,
    steps: [{ n: 90, in: { throttle: true, steer: -0.4 } }] },
];

// Recorded every step: the plan's list plus the drivetrain and surface state
// the step carries forward.
const STATE = ["s", "x", "px", "pz", "head", "speed", "vLat", "yawRateCur", "prog", "lap", "gear", "rpm", "shiftT",
  "steerSm", "steerAngle", "kerbGripSm", "slipFront", "slipRear", "slipDeg", "axEstSm", "axFrac", "rearUtil", "frontUtil",
  "brakeStab", "lateralAccel", "vertLoad", "energy", "aeroX", "onKerb", "offroad", "inPitLane", "wallT", "wasOnWall", "collideT",
  "skidIntensity", "wheelLock", "yawVis", "xVis", "_prevS", "lapTime"];

const g = await createGame({ track: TRACK, wx: "dry", storage: PINNED_STORAGE });
const S = g.sandbox, G = g.G, a = g.apex;
if (!(await settle(() => !!(S.TrackScenery && S.TrackScenery[TRACK]), 4000))) throw new Error(`TrackScenery[${TRACK}] never loaded — refusing a bare build`);
if (!G.track || G.track.def.id !== TRACK) throw new Error(`built ${G.track && G.track.def.id}, wanted ${TRACK}`);
a.weather("dry");
a.step(0, 1);
if (G.ROAD_FOLLOW !== 0) throw new Error("ROAD_FOLLOW is " + G.ROAD_FOLLOW + ", want 0");

// ── the tape ────────────────────────────────────────────────────────────────
// Top-level calls only: a query made INSIDE another query (wallLimits →
// wallAt / postLimits) belongs to that query's result.
let tape = null, depth = 0;
const T = S.Tracks;
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
wrap(T, "sample", ([, s, out], r) => ["sample", s, v3(r.p), v3(r.t), v3(r.r), r.hw]);
wrap(T, "banking", ([, s, x, , smooth], r) => ["banking", s, x, smooth === undefined ? null : !!smooth, r ? [r.dy, r.roll] : null]);
wrap(T, "onKerb", ([, s, x], r) => ["onKerb", s, x, r]);
wrap(T, "inPitLane", ([, s, x], r) => ["inPitLane", s, x, !!r]);
wrap(T, "wallAt", ([, s, side], r) => ["wallAt", s, side, r]);
wrap(T, "postLimits", ([, s, x], r) => ["postLimits", s, x, [r.r, r.l, r.minOut, r.side]]);
// Arc reads are taped too, so the replay can prove the player path never needs them.
wrap(T, "curvature", ([, s], r) => ["curvature", s, r]);
wrap(T, "bankAngle", ([, s], r) => ["bankAngle", s, r]);
// ContactGeometry is frozen; replace the global binding with a thawed copy.
S.ContactGeometry = Object.assign({}, S.ContactGeometry);
wrap(S.ContactGeometry, "wallLimits", ([, s, x, , , prev], r) =>
  ["wallLimits", s, x, prev ? [prev.s, prev.x] : null, [r.r, r.l, r.laneMin, r.side]]);
// Anything else on the façade a step calls must show up, not hide.
const KNOWN = new Set(["sample", "banking", "onKerb", "inPitLane", "wallAt", "postLimits", "curvature", "bankAngle"]);
for (const k of Object.keys(T)) if (typeof T[k] === "function" && !KNOWN.has(k)) wrap(T, k, (args) => ["UNTAPED:" + k, ...args.slice(1).filter((v) => typeof v === "number")]);

// ── helpers ─────────────────────────────────────────────────────────────────
const prim = (v) => v === null || typeof v === "number" || typeof v === "boolean" || typeof v === "string";
function fullState(c) {
  const o = {};
  for (const k of Object.keys(c)) {
    const v = c[k];
    if (v === undefined) o[k] = { $undef: true };
    else if (prim(v)) o[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "number")) o[k] = v.slice();
    else if (v && typeof v === "object" && Object.values(v).every(prim)) o[k] = { $obj: Object.assign({}, v) };
  }
  return o;
}
const pick = (c) => Object.fromEntries(STATE.map((k) => [k, c[k] === undefined ? null : c[k]]));
const world = () => ({
  raceT: G.raceT, state: G.state, seed: G.seed, PACE: G.PACE, vTop: G.vTop(), aTop: G.aTop(), LAT_MAX: G.LAT_MAX,
  PLAYER_GRIP: G.PLAYER_GRIP, FRONT_GRIP: G.FRONT_GRIP, DRIFT: G.DRIFT, YAW_INERTIA: G.YAW_INERTIA, YAW_DAMP: G.YAW_DAMP,
  ROAD_FOLLOW: G.ROAD_FOLLOW, raceWeather: G.raceWeather, session: G.session, lapsTarget: G.lapsTarget,
  trackTotal: G.track.total, street: !!G.track.street, difficulty: G.difficulty,
});

function runRecipe(rec) {
  const flat = [];
  for (const st of rec.steps) for (let i = 0; i < st.n; i++) flat.push(st.in);
  const last = flat[flat.length - 1];
  a.weather("dry");
  a.step(0, 1);
  a.seed(rec.seed);
  a.reset(rec.frac, rec.speed, rec.x || 0);
  G.cars.forEach((c, i) => { if (c !== G.player && !c.retired) a.retire(i, "oracle"); });
  if (G.raceWeather !== "dry" || G.trackWetness() !== 0) throw new Error("weather is not dry");
  if (G.cars.some((c) => c !== G.player && !c.retired)) throw new Error("AI cars still racing");
  const P = G.player;
  const initial = { car: fullState(P), world: world() };
  const dt = S.PhysicsConsts.FIXED_DT;
  const steps = [];
  const untaped = new Set();
  for (let i = 0; i < STEPS; i++) {
    const inp = Object.assign({}, i < flat.length ? flat[i] : last);
    a.setInput(inp);
    tape = [];
    a.step(dt, 1);
    const t = tape;
    tape = null;
    for (const e of t) if (String(e[0]).startsWith("UNTAPED:")) untaped.add(e[0]);
    steps.push({ input: inp, state: pick(P), raceT: G.raceT, tape: t });
  }
  a.clearInput();
  if (untaped.size) console.warn(`${rec.id}: untaped track calls ${[...untaped].join(", ")}`);
  return { initial, steps };
}

const sha = f1Sha();
for (const rec of RECIPES) {
  const t = runRecipe(rec);
  writeGolden(`physics-tape-${rec.id}.json.gz`, {
    header: { schema: "apex-26-physics-golden/1", f1Sha: sha, REVISION: S.PhysicsConsts.REVISION, track: TRACK, trace: rec.id,
      recipe: rec, steps: STEPS, FIXED_DT: S.PhysicsConsts.FIXED_DT, storage: PINNED_STORAGE, seat: g.seat && g.seat.name,
      generator: "tools/oracle/physics.mjs" },
    ...t,
  });
}
g.close();
