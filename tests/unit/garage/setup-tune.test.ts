/* The SETUP sheet's contract. Assertions ported from f1-game
 * tests/unit/setup-tune.test.mjs and tests/unit/mechanics-coherence.test.mjs:42-49,
 * plus a bit-exact comparison against f1-game's own js/garage/setup-tune.js. */
import { describe, expect, it } from "vitest";
import { LIST as TEAMS } from "../../../src/data/teams";
import { BB_REF as PHYS_BB_REF, axleGrip as physAxleGrip, bbScales as physBbScales } from "../../../src/physics/setup-axle";
import {
  BB_REF, FIELDS, RANGE, SetupTune, axleGrip, bbScales, clampField, createSetupTune, defaults, experiment, playerSetup,
  type SetupTuneApi, type Tune, type TuneField,
} from "../../../src/garage/setup-tune";
import { createGarageStore, memoryStorage } from "../../../src/garage/store";
import { f1Load, hasF1Garage, mapStore, plain } from "./f1-garage-vm";

const load = (shipped: Record<string, unknown> = {}) => {
  const store = mapStore(shipped);
  return { S: createSetupTune(store), stored: store.stored };
};

describe("SetupTune (f1-game js/garage/setup-tune.js)", () => {
  it("re-exports the physics lane's axleGrip / bbScales / BB_REF instead of duplicating them", () => {
    expect(axleGrip).toBe(physAxleGrip);
    expect(bbScales).toBe(physBbScales);
    expect(BB_REF).toBe(PHYS_BB_REF);
    expect(SetupTune.axleGrip).toBe(physAxleGrip);
    expect(SetupTune.BB_REF).toBe(0.56);
  });

  it("the works sheet is identity for every team: mods 1.0, rake 0, brake-bias split 1/1", () => {
    const { S } = load();
    for (const t of TEAMS) {
      expect(S.mods(t.id), t.id).toEqual({ speed: 1, accel: 1, cornering: 1, braking: 1 });
      expect(S.rake(t.id), t.id).toBe(0);
      expect(S.balance(t.id), t.id).toBe(0);
      expect(S.isDefault(t.id), t.id).toBe(true);
    }
    expect(S.bbScales(S.BB_REF)).toEqual({ f: 1, r: 1 });
    expect(S.bbScales(undefined)).toEqual({ f: 1, r: 1 });
  });

  it("bars move the four channels the way the sheet says, inside the ±5 % clamp", () => {
    const { S } = load();
    S.set("mclaren", { arbF: 11, arbR: 11 });
    let m = S.mods("mclaren");
    expect(m.cornering > 1 && m.accel < 1).toBe(true);
    expect(m.cornering <= 1.05 && m.accel >= 0.95).toBe(true);
    S.set("mclaren", { arbF: 11, arbR: 1 });
    m = S.mods("mclaren");
    expect(m.braking).toBeGreaterThan(1);
    S.reset("mclaren");
    expect(S.mods("mclaren")).toEqual({ speed: 1, accel: 1, cornering: 1, braking: 1 });
  });

  it("brake bias: forward spends the front's circle, rearward the rear's; the wheel's range is 50–62 in halves", () => {
    const { S } = load();
    const fwd = S.bbScales(0.60), rear = S.bbScales(0.52);
    expect(fwd.f > 1 && fwd.r < 1).toBe(true);
    expect(rear.f < 1 && rear.r > 1).toBe(true);
    S.set("ferrari", { brakeBias: 61.3 });
    expect(S.get("ferrari").brakeBias).toBe(61.5);
    S.set("ferrari", { brakeBias: 99 });
    expect(S.get("ferrari").brakeBias).toBe(62);
    expect(S.brakeBias("ferrari")).toBe(0.62);
  });

  it("a damaged sheet falls back per field, and reset restores the works numbers", () => {
    const { S, stored } = load();
    stored.set("setup.haas", { arbF: "x", arbR: 3, rideF: null, brakeBias: 54 });
    const t = S.get("haas");
    expect(t.arbF).toBe(S.defaults("haas").arbF);
    expect(t.arbR).toBe(3);
    expect(t.rideF).toBe(S.defaults("haas").rideF);
    expect(t.brakeBias).toBe(54);
    expect(S.isDefault("haas")).toBe(false);
    S.reset("haas");
    expect(S.get("haas")).toEqual(S.defaults("haas"));
  });

  it("reset returns to the SHIPPED sheet a fresh install gets, not the works default", () => {
    const designer = { arbF: 9, arbR: 4, rideF: 20, rideR: 70, brakeBias: 58 };
    const { S } = load({ "setup.mercedes": designer });
    const fresh = S.get("mercedes");
    expect(fresh).toEqual(designer);
    S.set("mercedes", { arbF: 2, rideR: 45 });
    expect(S.get("mercedes")).not.toEqual(fresh);
    expect(S.reset("mercedes")).toEqual(fresh);
    expect(S.get("mercedes")).toEqual(fresh);
    const { S: bare } = load();
    bare.set("mclaren", { arbF: 11 });
    expect(bare.reset("mclaren").arbF).toBe(6);
  });

  it("over the real a26. store the shipped garage-defaults sheet is the miss path, and reset lands on it", () => {
    const disk = memoryStorage(), S = createSetupTune(createGarageStore(disk));
    const shipped = S.get("mercedes");
    expect(shipped).toEqual({ arbF: 6, arbR: 5, rideF: 24, rideR: 60, brakeBias: 56 });
    S.set("mercedes", { arbF: 10 });
    expect(JSON.parse(disk.data.get("a26.setup.mercedes") as string).arbF).toBe(10);
    expect(S.reset("mercedes")).toEqual(shipped);
    expect(disk.data.has("a26.setup.mercedes")).toBe(false);
  });

  it("clampField: typeof, not Number() — null/''/false are damage, a numeric string is a slider", () => {
    for (const bad of [null, "", "  ", false, true, undefined, NaN, Infinity, {}, []]) expect(clampField("arbF", bad)).toBeNull();
    expect(clampField("arbF", "7")).toBe(7);
    expect(clampField("brakeBias", 55.26)).toBe(55.5);
    expect(clampField("rideF", -100)).toBe(15);
  });

  it("experiments are one bounded step and refuse at a range limit (garage-followups.test.mjs:44-56)", () => {
    const { S } = load(), team = "haas", before = S.get(team);
    expect(experiment("traction", before)).toEqual({ arbF: before.arbF - 1, arbR: before.arbR - 1 });
    expect(S.experiment("traction", { ...before, arbF: 1 })).toBeNull();
    expect(S.experiment("entry", { ...before, brakeBias: 62 })).toBeNull();
    expect(S.experiment("wide", { ...before, arbF: 1 })).toBeNull();
    expect(S.experiment("nonsense", before)).toBeNull();
    S.set(team, S.experiment("traction", before));
    expect(S.balance(team)).toBe(0);
    expect(S.mods(team).accel).toBeGreaterThan(1);
    expect(S.mods(team).cornering).toBeLessThan(1);
    S.set(team, before);
    const front = S.experiment("wide", before);
    S.set(team, front);
    expect(S.balance(team)).toBeLessThan(0);
  });

  it("roll stiffness shifts grip between axles while works settings stay identical (mechanics-coherence.test.mjs:42-49)", () => {
    const S = load().S;
    expect(S.axleGrip(0, 22).f).toBe(1);
    expect(S.axleGrip(0.3, 0).f).toBe(1);
    const front = { ...S.axleGrip(0.3, 22) }, rear = { ...S.axleGrip(-0.3, 22) };
    expect(front.f < 1 && front.r > 1 && rear.f > 1 && rear.r < 1).toBe(true);
    for (const x of [front, rear]) expect(x.f > 0.8 && x.r > 0.8 && x.f < 1.2 && x.r < 1.2).toBe(true);
  });
});

describe("playerSetup (f1-game js/game.js:1406-1419, :1545-1550)", () => {
  it("a standard-class car takes no sheet: BB_REF, no roll balance, no mods, no aero", () => {
    const { S } = load();
    S.set("ferrari", { arbF: 11, rideR: 80, brakeBias: 60 });
    expect(playerSetup("ferrari", true, S)).toEqual({ brakeBias: BB_REF, rollBalance: 0, mods: undefined, aero: undefined });
  });

  it("otherwise the sheet's brake bias, balance, mods and rake", () => {
    const { S } = load();
    S.set("ferrari", { arbF: 11, rideR: 80, brakeBias: 60 });
    const p = playerSetup("ferrari", false, S);
    expect(p.brakeBias).toBe(S.brakeBias("ferrari"));
    expect(p.brakeBias).toBe(0.6);
    expect(p.rollBalance).toBe(S.balance("ferrari"));
    expect(p.mods).toEqual(S.mods("ferrari"));
    expect(p.aero).toEqual(S.aero("ferrari"));
    expect(p.aero?.rake).toBeGreaterThan(0);
  });

  it("the works sheet is identity through the bridge too", () => {
    const { S } = load();
    expect(playerSetup("haas", false, S)).toEqual({ brakeBias: 0.56, rollBalance: 0,
      mods: { speed: 1, accel: 1, cornering: 1, braking: 1 }, aero: { rake: 0 } });
  });
});

// ── bit-exact against f1-game's own setup-tune.js ─────────────────────────
describe.skipIf(!hasF1Garage)("SetupTune matches f1-game's setup-tune.js bit for bit", () => {
  const vmTune = (store: ReturnType<typeof mapStore>): SetupTuneApi => {
    const get = f1Load(["js/core/mat4.js", "js/physics/consts.js", "js/garage/setup-tune.js"], { GameStore: { store } });
    return get("SetupTune") as SetupTuneApi;
  };
  const same = (a: unknown, b: unknown, at: string): void => {
    if (typeof a === "number" || typeof b === "number") {
      if (!Object.is(a, b)) throw new Error(at + ": " + String(a) + " !== " + String(b));
      return;
    }
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") { expect(a, at).toBe(b); return; }
    expect(Object.keys(a), at).toEqual(Object.keys(b));
    for (const k of Object.keys(a)) same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], at + "." + k);
  };
  const ids = [...TEAMS.map((t) => t.id), "nosuchteam"];

  it("constants and defaults agree", () => {
    const S = vmTune(mapStore());
    same(plain(S.RANGE), RANGE, "RANGE");
    same(plain(S.FIELDS), FIELDS, "FIELDS");
    same(plain(S.BASE), plain(SetupTune.BASE), "BASE");
    same(plain(S.DEFAULTS), plain(SetupTune.DEFAULTS), "DEFAULTS");
    expect(S.BB_REF).toBe(BB_REF);
    for (const id of ids) same(plain(S.defaults(id)), defaults(id), id);
  });

  it("clampField over every field and a spread of good and damaged values", () => {
    const S = vmTune(mapStore());
    const vals: unknown[] = [null, undefined, "", " ", "7", "61.3", "x", false, true, NaN, Infinity, -Infinity, -1e9, 1e9, {}, [],
      0, 0.25, 1, 1.4999, 1.5, 5.5, 11, 12, 14.5, 15, 22.7, 35.5, 39.999, 40, 59.75, 80.5, 49.74, 50, 50.25, 55.26, 61.3, 61.75, 62, 62.3];
    for (const k of FIELDS) for (const v of vals) same(S.clampField(k, v), clampField(k, v), k + "=" + String(v));
  });

  it("get/mods/balance/rake/aero/brakeBias/isDefault over a grid of sheets for every team", () => {
    const vm = mapStore(), ts = mapStore();
    const A = vmTune(vm), B = createSetupTune(ts);
    const sheets: Record<string, unknown>[] = [];
    for (const arbF of [1, 4, 6, 9, 11]) for (const arbR of [1, 5, 7, 11]) for (const [rideF, rideR] of [[15, 80], [25, 60], [35, 40], [22, 71]])
      for (const brakeBias of [50, 55.5, 56, 61.3, 62]) sheets.push({ arbF, arbR, rideF, rideR, brakeBias });
    sheets.push({ arbF: "x", arbR: 3, rideF: null, brakeBias: 54 }, { arbF: "8", rideR: "", brakeBias: 99 }, {}, { arbF: 0.4, arbR: 11.6 });
    for (const id of ids) {
      for (const sheet of [null, ...sheets]) {
        for (const s of [vm, ts]) { if (sheet === null) s.stored.delete("setup." + id); else s.stored.set("setup." + id, sheet); }
        const at = id + " " + JSON.stringify(sheet);
        same(A.get(id), B.get(id), at + " get");
        same(A.mods(id), B.mods(id), at + " mods");
        same(A.balance(id), B.balance(id), at + " balance");
        same(A.rake(id), B.rake(id), at + " rake");
        same(A.aero(id), B.aero(id), at + " aero");
        same(A.brakeBias(id), B.brakeBias(id), at + " brakeBias");
        expect(A.isDefault(id), at).toBe(B.isDefault(id));
      }
    }
  });

  it("set/reset write the same stored sheets", () => {
    const vm = mapStore(), ts = mapStore();
    const A = vmTune(vm), B = createSetupTune(ts);
    const patches: unknown[] = [{ arbF: 11 }, { arbR: "3" }, { rideF: null, rideR: 79.6 }, { brakeBias: 57.24 }, null, { arbF: undefined }, { nope: 1 }];
    for (const id of ids) for (const p of patches) {
      same(A.set(id, p as never), B.set(id, p as never), id + " set " + JSON.stringify(p));
      same(plain(vm.stored.get("setup." + id)), ts.stored.get("setup." + id), id + " stored");
    }
    for (const id of ids) { same(A.reset(id), B.reset(id), id + " reset"); expect(ts.stored.has("setup." + id)).toBe(vm.stored.has("setup." + id)); }
  });

  it("experiment over every symptom and a grid of sheets", () => {
    const A = vmTune(mapStore());
    for (const symptom of ["wide", "traction", "entry", "other", ""]) {
      for (const arbF of [1, 2, 6, 11]) for (const arbR of [1, 2, 11]) for (const brakeBias of [50, 61.5, 62, 61.75]) {
        const t: Tune = { arbF, arbR, rideF: 25, rideR: 60, brakeBias };
        same(A.experiment(symptom, t), experiment(symptom, t), symptom + " " + JSON.stringify(t));
      }
    }
  });

  it("axleGrip and bbScales are f1-game's", () => {
    const A = vmTune(mapStore());
    for (const bias of [0, 0.05, -0.1, 0.3, -0.3, NaN]) for (const lat of [0, 3, -11, 22, 40]) for (const fl of [undefined, 0.47, 0.4]) {
      const a = plain(fl === undefined ? A.axleGrip(bias, lat) : A.axleGrip(bias, lat, fl));
      const b = { ...(fl === undefined ? axleGrip(bias, lat) : axleGrip(bias, lat, fl)) };
      same(a, b, `axleGrip ${bias} ${lat} ${fl}`);
    }
    for (const bb of [0.5, 0.52, 0.56, 0.6, 0.62, NaN, undefined, 0.1, 0.99]) same(A.bbScales(bb), bbScales(bb), "bbScales " + bb);
  });

  it("the port's tune feeds f1-game's Parts exactly as its own: works sheet is identity for every team", () => {
    const store = mapStore();
    const get = f1Load(["js/core/mat4.js", "js/physics/consts.js", "js/data/teams.js", "js/car/parts.js", "js/garage/setup-tune.js"],
      { GameStore: { store }, Log: { info() {}, warn() {}, error() {} }, console });
    const Parts = get("Parts") as {
      getFactorySetup(t: unknown): unknown;
      aeroLoad(s: unknown, t: unknown, tune?: unknown): number;
      getMods(s: unknown, t: unknown, tune?: unknown): unknown;
    };
    const vmTeams = (get("Teams") as { LIST: { id: string }[] }).LIST;
    const S = createSetupTune(mapStore());
    for (const t of vmTeams) {
      const setup = Parts.getFactorySetup(t);
      expect(Parts.aeroLoad(setup, t, S.aero(t.id)), t.id).toBe(Parts.aeroLoad(setup, t));
      expect(plain(Parts.getMods(setup, t, S.mods(t.id))), t.id).toEqual(plain(Parts.getMods(setup, t)));
    }
  });
});
