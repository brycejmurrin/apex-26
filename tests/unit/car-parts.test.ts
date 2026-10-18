import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build, buildComplete } from "../../src/car/car3d";
import { buildPartsCar, defaultLivery, partsBuild, resolvePartsSetup, type PartsCarTeam } from "../../src/car/part-meshes";
import * as P from "../../src/car/parts";
import { Parts, type PartOption } from "../../src/car/parts";
import { Teams } from "../../src/car/teams";
import type { MeshOut } from "../../src/car/types";
import { haveF1, loadF1Car } from "../helpers/f1-car-vm";
import { fnvString, summary, type MeshSummary } from "../helpers/mesh-summary";

// src/car/parts.ts and src/car/part-meshes.ts vs f1-game js/car/parts.js and the
// car-draw.js:137-154 buildCarData path, run in a Node VM. One driver runs the same
// calls against either implementation and returns { case -> canonical string }, where
// every number is written as its Float64 bits, so equal strings mean bit-exact values.
// CI (no f1-game) checks per-group digests and build summaries recorded from the VM:
// UPDATE_PARTS_FIXTURES=1 npx vitest run tests/unit/car-parts.test.ts (needs f1-game).
const FILE = path.resolve(import.meta.dirname, "../fixtures/car/parts.json");

type Fn = (...a: never[]) => unknown;
interface Impl {
  Parts: Record<string, unknown> & typeof Parts;
  /** buildCarData (car-draw.js:137-154) without the GLTF override: Car3D.build args. */
  buildArgs(team: PartsCarTeam, setup: P.PartSetup | undefined): { c1: unknown; c2: unknown; opts: Record<string, unknown> };
  build(c1: unknown, c2: unknown, opts: unknown): MeshOut;
}

const dv = new DataView(new ArrayBuffer(8));
function bits(n: number): string {
  dv.setFloat64(0, n);
  return "n:" + dv.getUint32(0).toString(16) + ":" + dv.getUint32(4).toString(16);
}
/** Canonical, realm-independent string; numbers as Float64 bits. Functions by name only. */
function canon(v: unknown): string {
  return JSON.stringify(v, function (_k, x: unknown) {
    if (typeof x === "number") return bits(x);
    if (typeof x === "function") return "fn:" + (x as Fn).name;
    return x;
  }) ?? "undefined";
}

const TEAMS: PartsCarTeam[] = Teams.LIST.map((t) => JSON.parse(JSON.stringify(t)) as PartsCarTeam);
const LEGEND: PartsCarTeam = { id: "legends", engine: "Mercedes", color: [0.9, 0.9, 0.9], color2: [0.1, 0.1, 0.1],
  factory: { suspension: "torsion_bar", aero: "high" }, drivers: [{ num: 7 }] };
const EXTRA_TEAMS: P.PartsTeam[] = ["Ferrari", "Honda", "Red Bull Ford", "", null, undefined, { id: "nobody" }, { engine: "Audi" }, LEGEND];
const TUNES: (P.PartsTune | undefined)[] = [
  undefined, {}, { speed: 1.02, accel: 0.98, cornering: 1.013, braking: 0.991 },
  { speed: NaN, accel: Infinity, cornering: -0.5, braking: 1 / 3, rake: 0.5 }, { rake: -3 }, { rake: 2 }, { rake: 0.1234567 },
];

function setupsFor(p: typeof Parts): (P.PartSetup | null | undefined)[] {
  const out: (P.PartSetup | null | undefined)[] = [undefined, null, {}, p.DEFAULTS, { engine: "bogus" }, { tyres: undefined }];
  for (const id of Object.keys(p.FACTORY_PRESETS)) out.push(p.FACTORY_PRESETS[id]);
  for (const cat of p.CATALOG) for (const o of cat.options) out.push({ [cat.id]: o.id });
  return out;
}
const signatures = (p: typeof Parts) =>
  p.CATALOG.flatMap((cat) => cat.options.filter((o) => o.tag === "SIGNATURE").map((o) => ({ cat: cat.id, o })));

/** Every exported function over a spread of inputs. Fresh module state expected (no legality). */
function driveFunctions(impl: Impl): Map<string, string> {
  const p = impl.Parts, out = new Map<string, string>();
  const put = (k: string, v: unknown) => out.set(k, canon(v));
  put("keys", Object.keys(p));
  for (const k of ["CATALOG", "DEFAULTS", "FACTORY_PRESETS", "VISUAL_FIELD_REGISTRY", "BUDGET", "STAT_KEYS", "RH_GAIN"]) put("const." + k, p[k]);
  put("frozen", [Object.isFrozen(p), Object.isFrozen(p.CATALOG), Object.isFrozen(p.VISUAL_FIELD_REGISTRY), Object.isFrozen(p.STAT_KEYS)]);
  const stats: number[] = [];
  for (let s = -20; s <= 140; s += 0.25) stats.push(s);
  stats.push(1 / 3, 99.999, 100.0000001, 1e-9, -0, NaN, Infinity);
  put("statMult", stats.map((s) => p.statMult(s)));
  const raws: number[] = [];
  for (let r = -10; r <= 420; r += 0.37) raws.push(r);
  raws.push(100, 100 + 1e-12, 126, 1e6, -0, NaN, Infinity);
  put("displayStat", raws.map((r) => p.displayStat(r)));

  const teams: P.PartsTeam[] = [...TEAMS, ...EXTRA_TEAMS];
  const setups = setupsFor(p);
  teams.forEach((team, ti) => {
    const t = "t" + ti;
    put("factory." + t, [p.getFactorySetup(team), p.factoryKey(team)]);
    setups.forEach((setup, si) => {
      const c = t + ".s" + si;
      put("resolve." + c, p.resolveSetup(setup, team));
      put("cost." + c, p.getCost(setup, team));
      put("tread." + c, p.tread(setup, team));
      put("ers." + c, p.ersProfile(setup, team));
      put("visual." + c, p.getVisualTiers(setup, team));
      put("mods." + c, TUNES.map((tune) => p.getMods(setup, team, tune)));
      put("aero." + c, TUNES.map((tune) => p.aeroLoad(setup, team, tune)));
    });
    put("avail." + t, p.CATALOG.map((cat) => cat.options.map((o) =>
      [p.isOptionAvailable(o, team), p.isOptionAvailable(o, team, new Set([o.id])), p.isOptionAvailable(o, team, new Set())])));
  });
  put("resolve.tuned", TUNES.map((tune) => p.resolveSetup(p.FACTORY_PRESETS["ferrari"], TEAMS[1], tune)));
  return out;
}

/** The regulation hook: install, observe, clear. Leaves legality cleared. */
function driveLegality(impl: Impl): Map<string, string> {
  const p = impl.Parts, out = new Map<string, string>();
  const put = (k: string, v: unknown) => out.set(k, canon(v));
  const era = (o: PartOption) => o.tag !== "SIGNATURE" && o.cost < 120;
  put("before", [p.legalityKey(), p.legality()]);
  for (const t of TEAMS) p.factoryKey(t); // warm the cache: the key must still move
  p.setLegality(era, "era1");
  put("on", [p.legalityKey(), p.legality() === era]);
  for (const [i, t] of [...TEAMS, LEGEND].entries()) put("factory." + i, [p.getFactorySetup(t), p.factoryKey(t), p.getMods(p.FACTORY_PRESETS[t.id], t), p.getVisualTiers(undefined, t)]);
  put("avail", p.CATALOG.map((c) => c.options.map((o) => p.isOptionAvailable(o, TEAMS[0]))));
  p.setLegality(() => 0, "");
  put("falsyKey", [p.legalityKey(), p.getFactorySetup(TEAMS[2])]);
  p.setLegality("not a function", "x");
  put("cleared", [p.legalityKey(), p.legality(), p.factoryKey(TEAMS[3])]);
  p.setLegality(null);
  return out;
}

interface BuildCase { name: string; team: PartsCarTeam; setup?: P.PartSetup }
function buildCases(p: typeof Parts): BuildCase[] {
  const byId = new Map(TEAMS.map((t) => [t.id, t]));
  const cases: BuildCase[] = [];
  for (const id of Object.keys(p.FACTORY_PRESETS)) cases.push({ name: "preset-" + id, team: byId.get(id)! });
  for (const { cat, o } of signatures(p)) {
    const team = byId.get(o.teams![0]!)!;
    cases.push({ name: "sig-" + o.id, team, setup: { [cat]: o.id } });
  }
  // Locked signatures resolve to their `equivalent` (parts.js:678-696).
  cases.push({ name: "locked-sig_rb_street@mercedes", team: byId.get("mercedes")!, setup: { tyres: "sig_rb_street" } });
  cases.push({ name: "locked-presets-ferrari@haas", team: byId.get("haas")!, setup: p.FACTORY_PRESETS["ferrari"]! });
  cases.push({ name: "custom-defaults", team: byId.get("custom") ?? TEAMS[0]!, setup: {} });
  cases.push({ name: "legend-factory", team: LEGEND });
  return cases;
}

function driveBuilds(impl: Impl, cases: BuildCase[]): Map<string, { parts: string; build: MeshSummary }> {
  const out = new Map<string, { parts: string; build: MeshSummary }>();
  for (const c of cases) {
    const a = impl.buildArgs(c.team, c.setup);
    out.set(c.name, { parts: canon(a.opts["parts"]), build: summary(impl.build(a.c1, a.c2, a.opts)) });
  }
  return out;
}

const mine: Impl = {
  Parts,
  buildArgs(team, setup) {
    const b = partsBuild(team, { setup });
    return { c1: b.color, c2: b.color2, opts: b.opts as Record<string, unknown> };
  },
  build: (c1, c2, o) => build(c1 as never, c2 as never, o as never),
};

function vmImpl(): Impl {
  const g = loadF1Car({ extra: ["js/car/parts.js", "js/car/liveries.js", "js/car/custom-liveries.js"], globals: ["Parts", "CustomLiveries"] });
  const VP = g["Parts"] as Impl["Parts"];
  const Car3D = g["Car3D"] as { build(c1: unknown, c2: unknown, o: unknown): MeshOut };
  const store = { get: <T>(_k: string, f: T): T => f, set: () => false, rev: 0 };
  const CL = (g["CustomLiveries"] as { create(d: unknown): { resolveLivery(t: unknown): Record<string, unknown> } }).create({ store });
  return {
    Parts: VP,
    // car-draw.js:137-154 verbatim (extra = { setup }; no GLTF model; legendLid undefined).
    buildArgs(team, setup) {
      const liv = CL.resolveLivery(team);
      const s = setup || VP.getFactorySetup(team);
      const extra: { num?: number } = {};
      return { c1: liv["c1"], c2: liv["c2"], opts: {
        livery: liv, teamId: team.id,
        num: (extra && extra.num != null) ? extra.num : (team.drivers && team.drivers[0] && team.drivers[0].num),
        helmetKey: undefined, parts: VP.getVisualTiers(s, team),
        noWheels: false, field: false, silhouette: false,
      } };
    },
    build: (c1, c2, o) => Car3D.build(c1, c2, o),
  };
}

interface Fixture { functions: Record<string, string>; legality: Record<string, string>; builds: Record<string, { parts: string; build: MeshSummary }> }
/** Group digests: one FNV over every case string sharing a key prefix. */
function digest(m: Map<string, string>): Record<string, string> {
  const groups = new Map<string, string[]>();
  for (const [k, v] of m) {
    const g = k.split(".")[0]!;
    let arr = groups.get(g);
    if (!arr) groups.set(g, arr = []);
    arr.push(k + "=" + v);
  }
  return Object.fromEntries([...groups].map(([g, a]) => [g, fnvString(a.join("\n"))]));
}
function fixtureOf(impl: Impl): Fixture {
  const builds = driveBuilds(impl, buildCases(impl.Parts));
  return {
    functions: digest(driveFunctions(impl)),
    legality: digest(driveLegality(impl)),
    builds: Object.fromEntries([...builds].map(([k, v]) => [k, { parts: fnvString(v.parts), build: v.build }])),
  };
}

function expectSameMaps(a: Map<string, string>, b: Map<string, string>): void {
  expect([...a.keys()]).toEqual([...b.keys()]);
  const bad = [...a.keys()].filter((k) => a.get(k) !== b.get(k));
  expect(bad.slice(0, 5)).toEqual([]);
}

describe.skipIf(!haveF1)("Parts vs f1-game js/car/parts.js (VM)", () => {
  afterEach(() => Parts.setLegality(null));
  it("every export and function bit-exact", () => {
    const ref = vmImpl();
    expectSameMaps(driveFunctions(mine), driveFunctions(ref));
  }, 60_000);
  it("the regulation hook", () => {
    expectSameMaps(driveLegality(mine), driveLegality(vmImpl()));
  });
  it("each FACTORY_PRESET / SIGNATURE: opts.parts and Car3D.build bit-exact", () => {
    const ref = vmImpl();
    const cases = buildCases(Parts);
    expect(cases.length).toBeGreaterThan(100);
    const a = driveBuilds(mine, cases), b = driveBuilds(ref, cases);
    const bad = cases.map((c) => c.name).filter((n) => {
      const x = a.get(n)!, y = b.get(n)!;
      return x.parts !== y.parts || JSON.stringify(x.build) !== JSON.stringify(y.build);
    });
    expect(bad).toEqual([]);
  }, 180_000);
});

describe("Parts fixtures (recorded from f1-game)", () => {
  if (haveF1 && process.env["UPDATE_PARTS_FIXTURES"]) fs.writeFileSync(FILE, JSON.stringify(fixtureOf(vmImpl()), null, 1) + "\n");
  const fixture = JSON.parse(fs.readFileSync(FILE, "utf8")) as Fixture;
  afterEach(() => Parts.setLegality(null));
  it("functions and legality digests", () => {
    expect(digest(driveFunctions(mine))).toEqual(fixture.functions);
    expect(digest(driveLegality(mine))).toEqual(fixture.legality);
  }, 30_000);
  it("preset / signature builds", () => {
    const got = driveBuilds(mine, buildCases(Parts));
    expect(Object.keys(fixture.builds).sort()).toEqual([...got.keys()].sort());
    for (const [k, v] of got) expect({ k, parts: fnvString(v.parts), build: JSON.parse(JSON.stringify(v.build)) as MeshSummary }).toEqual({ k, ...fixture.builds[k] });
  }, 60_000);
});

describe("Parts sanity", () => {
  afterEach(() => Parts.setLegality(null));
  it("twelve categories, DEFAULTS and every preset id exist", () => {
    expect(P.CATALOG.map((c) => c.id)).toEqual(["engine", "aero", "suspension", "brakes", "tyres", "ers", "gearbox", "fuel", "exhaust", "floor", "cockpit", "wheels"]);
    for (const cat of P.CATALOG) {
      const ids = new Set(cat.options.map((o) => o.id));
      expect(ids.size).toBe(cat.options.length);
      expect(ids.has(P.DEFAULTS[cat.id])).toBe(true);
      for (const preset of Object.values(P.FACTORY_PRESETS)) expect(ids.has(preset[cat.id])).toBe(true);
    }
    expect(Object.isFrozen(Parts)).toBe(true);
  });
  it("SIGNATURE options clone their equivalent's cost and stats", () => {
    for (const { cat, o } of signatures(Parts)) {
      const eq = P.CATALOG.find((c) => c.id === cat)!.options.find((x) => x.id === o.equivalent);
      expect(eq, o.id).toBeDefined();
      for (const k of ["cost", "speed", "accel", "cornering", "braking"] as const) expect([o.id, o[k] ?? 1]).toEqual([o.id, eq![k] ?? 1]);
    }
  });
  it("lock fallback, costs and stat curve", () => {
    const merc = TEAMS.find((t) => t.id === "mercedes")!;
    expect(P.resolveSetup({ tyres: "sig_rb_street" }, merc).setup.tyres).toBe("supersoft");
    expect(P.resolveSetup({ engine: "manu_ferrari" }, merc).setup.engine).toBe(P.DEFAULTS.engine);
    expect(P.getCost(P.DEFAULTS)).toBe(0);
    expect(P.getMods(P.DEFAULTS)).toEqual({ speed: 1, accel: 1, cornering: 1, braking: 1 });
    expect(P.statMult(0)).toBe(0.85);
    expect(P.statMult(100)).toBe(1);
    expect(P.displayStat(80)).toBe(80);
    expect(P.displayStat(1e9)).toBeCloseTo(120);
    expect(P.getFactorySetup(merc)).toBe(P.getFactorySetup(merc)); // cached
    P.setLegality((o: PartOption) => o.tag !== "SIGNATURE", "noSig");
    expect(P.legalityKey()).toBe("noSig");
    expect(P.getFactorySetup(merc).tyres).toBe("medium");
  });
  it("part-meshes resolves the works build and builds a three.js car", () => {
    for (const team of TEAMS.filter((t) => t.id in P.FACTORY_PRESETS)) {
      const b = partsBuild(team);
      expect(b.parts._ids).toEqual(P.FACTORY_PRESETS[team.id]);
      expect(b.opts.parts).toBe(b.parts);
      expect(b.opts.teamId).toBe(team.id);
    }
    const ferrari = TEAMS.find((t) => t.id === "ferrari")!;
    expect(resolvePartsSetup(ferrari, { aero: "high" })).toEqual({ aero: "high" });
    expect(defaultLivery(ferrari)["c1"]).toEqual(ferrari.color);
    const car = buildPartsCar(ferrari, { setup: { tyres: "sig_ferrari_tyre" } });
    const ref = buildComplete(car.build.color, car.build.color2, { ...car.build.opts, noWheels: true });
    expect(car.body.geometry.getAttribute("position").count).toBe(ref.pos.length / 3);
    expect(car.wheels).not.toBeNull();
    car.dispose();
  });
});
