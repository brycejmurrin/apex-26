// src/fx/car-fx.ts vs f1-game js/fx/car-fx.js: a seeded parity run of a field (plank
// sparks into the real particle pool, AI lock-up marks into the real skid ring, the
// heat-haze anchor), and the assertions of f1-game tests/unit/car-fx.test.mjs.
import { describe, expect, it } from "vitest";
import { createCarFx, HAZE_RANGE, heatHaze, LOCK_MIN, SPARK_V0, SPARK_V1, type FxCar } from "../../../src/fx/car-fx";
import { createParticles, type ParticlePool } from "../../../src/fx/particles";
import { createSkidMarks } from "../../../src/fx/skidmarks";
import { PhysicsConsts } from "../../../src/physics/consts";
import { f1Get, firstDiff, hasF1Fx, loadF1Fx, seeded } from "./f1-fx-vm";

const DT = 1 / 60;
const VMAX = 72;

/** A grounded basis at (x, 0, z) facing +z (column-major: R, U, F, origin). */
function ground(x = 10, z = 20): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1; m[12] = x; m[14] = z;
  return m;
}

interface Car extends FxCar { s: number; speed: number; rpm: number; wasOnThrottle: boolean; deploying: boolean; baScrape: number; baPitch: number; wheelLock: number; offroad: boolean; isPlayer: boolean; retired: boolean }

interface FxApi {
  emit(c: Car, g: ArrayLike<number>, dt: number, state: string): void;
  status(): { sparks: number; marks: number };
  haze: {
    pick(cars: readonly Car[], player: Car, onboard: boolean, total: number, dt: number): Car | null;
    mark(c: Car, m: ArrayLike<number>): void;
    at(m: ArrayLike<number>): { u: number; v: number; str: number } | null;
    state(): { anchor: Car | null; str: number; marked: boolean };
  };
}

interface World { fx: FxApi; pool: () => ParticlePool; skidBatch: () => number[] }

function portWorld(seed: number, vTop: number): World {
  const P = createParticles({ random: seeded(seed), tune: () => null, autoShed: () => 0 });
  P.init({ mobileTier: false });
  const skids = createSkidMarks();
  const fx = createCarFx<Car>({ vTop: () => vTop, skids, particles: P });
  return {
    fx, pool: () => P.pool(),
    skidBatch: () => { let out: number[] = []; skids.draw({ drawSkidBatch: (v, n) => { out = Array.from(v.subarray(0, n * 5)); return true; } }); return out; },
  };
}

function f1World(seed: number, vTop: number): World {
  const ctx = loadF1Fx(["js/physics/consts.js", "js/fx/skidmarks.js", "js/fx/particles.js", "js/fx/car-fx.js"], { random: seeded(seed) });
  const P = f1Get<{ init(g: object): void; _pool(): ParticlePool }>(ctx, "Particles");
  P.init({ mobileTier: false });
  const skids = f1Get<{ create(): { draw(g: object): void } }>(ctx, "SkidMarks").create();
  const fx = f1Get<{ create(G: object, d: object): FxApi }>(ctx, "CarFx").create({ vTop: () => vTop }, { skids, Particles: P });
  return {
    fx, pool: () => P._pool(),
    skidBatch: () => { let out: number[] = []; skids.draw({ drawSkidBatch: (v: Float32Array, n: number) => { out = Array.from(v.subarray(0, n * 5)); return true; } }); return out; },
  };
}

function field(A: () => number, n: number): Car[] {
  return Array.from({ length: n }, (_, i) => ({
    s: A() * 5000, speed: A() * 90 - 5, rpm: 4000 + A() * 12000, wasOnThrottle: A() < 0.7, deploying: A() < 0.3,
    baScrape: A() < 0.5 ? 0 : A(), baPitch: (A() - 0.5) * 0.02, wheelLock: A(), offroad: A() < 0.1, isPlayer: i === 0, retired: A() < 0.05,
  }));
}

/** 300 frames of a 12-car field; returns the scalar trace. */
function drive(w: World, frames: number): unknown[] {
  const A = seeded(0xf1e1d);
  const cars = field(A, 12);
  const VP = (() => { const m = new Float32Array(16); m[0] = 1; m[5] = 1; m[11] = 1; return m; })();
  const trace: unknown[] = [];
  for (let f = 0; f < frames; f++) {
    const dt = f % 37 === 0 ? 0 : DT + A() * 0.01;
    for (const c of cars) {
      c.s = (c.s + c.speed * DT) % 5000; c.speed += (A() - 0.5) * 4; c.baScrape = A() < 0.6 ? 0 : A();
      c.baPitch = (A() - 0.5) * 0.02; c.wheelLock = A(); c.wasOnThrottle = A() < 0.8; c.rpm = 5000 + A() * 10000;
    }
    const anchor = w.fx.haze.pick(cars, cars[0]!, f % 100 < 60, 5000, dt);
    trace.push(anchor ? cars.indexOf(anchor) : -1);
    for (const c of cars) {
      const g = ground(A() * 50, c.s);
      w.fx.emit(c, g, dt, f % 50 === 49 ? "count" : "race");
      w.fx.haze.mark(c, ground(0, 20 + A() * 30));
    }
    const at = w.fx.haze.at(VP);
    trace.push(at ? [at.u, at.v, at.str] : null, w.fx.haze.state().str, w.fx.haze.state().marked);
  }
  trace.push(w.fx.status());
  return trace;
}

describe.skipIf(!hasF1Fx)("car-fx parity with f1-game js/fx/car-fx.js (VM, seeded)", () => {
  for (const vTop of [VMAX, VMAX * 0.6]) {
    it(`vTop ${vTop}: sparks, marks and the haze anchor match bit for bit over 300 frames`, () => {
      const a = portWorld(0xb0a7, vTop), b = f1World(0xb0a7, vTop);
      expect(drive(a, 300)).toEqual(drive(b, 300));
      const pa = a.pool(), pb = b.pool();
      expect(pa.n).toBe(pb.n);
      expect(pa.n).toBeGreaterThan(0);
      for (const k of ["px", "py", "pz", "vx", "vy", "vz", "age", "life", "sz"] as const) expect(firstDiff(pa[k], pb[k]), k).toBeNull();
      const sa = a.skidBatch(), sb = b.skidBatch();
      expect(sa.length).toBeGreaterThan(0);
      expect(firstDiff(sa, sb)).toBeNull();
    });
  }
  it("the physics constants the gates read are f1-game's", () => {
    const ctx = loadF1Fx(["js/physics/consts.js", "js/fx/car-fx.js"]);
    const K = f1Get<{ VMAX: number; IDLE_RPM: number; MAX_RPM: number }>(ctx, "PhysicsConsts");
    expect([PhysicsConsts.VMAX, PhysicsConsts.IDLE_RPM, PhysicsConsts.MAX_RPM]).toEqual([K.VMAX, K.IDLE_RPM, K.MAX_RPM]);
    const C = f1Get<Record<string, number>>(ctx, "CarFx");
    expect([C["SPARK_V0"], C["SPARK_V1"], C["LOCK_MIN"], C["HAZE_RANGE"]]).toEqual([SPARK_V0, SPARK_V1, LOCK_MIN, HAZE_RANGE]);
  });
});

// ── Ported from f1-game tests/unit/car-fx.test.mjs ───────────────────────────
type ScrapeCall = [number, number, number, number, number, number];
function load(opts: { vTop?: number; stub?: { scrape: (...a: ScrapeCall) => void } } = {}) {
  const P = createParticles({ random: seeded(0xca7f), tune: () => null, autoShed: () => 0 });
  P.init({ mobileTier: false });
  const skids = createSkidMarks();
  const fx = createCarFx<FxCar>({ vTop: () => opts.vTop ?? VMAX, skids, particles: opts.stub ?? P });
  return { P, skids, fx };
}

describe("car-fx: plank sparks and lock-up marks (car-fx.test.mjs)", () => {
  it("a bottoming floor at speed throws embers from its lowest point, carried with the car", () => {
    const calls: ScrapeCall[] = [];
    const { fx } = load({ stub: { scrape: (...a) => calls.push(a) } });
    const g = ground();
    fx.emit({ speed: 70, baScrape: 0.8, baPitch: 0.02 }, g, DT, "race");
    expect(calls.length).toBe(1);
    const [x, y, z, vx, vz, n] = calls[0]!;
    expect(x).toBe(10);
    expect(Math.abs(z - 21)).toBeLessThan(1e-6);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(0.05);
    expect(vx).toBe(0);
    expect(vz).toBe(70);
    expect(Math.abs(n - DT * 110 * 0.8)).toBeLessThan(1e-9);
    calls.length = 0;
    fx.emit({ speed: 70, baScrape: 0.5, baPitch: -0.01 }, g, DT, "race");
    fx.emit({ speed: 70, baScrape: 0.5, baPitch: 0 }, g, DT, "race");
    expect(Math.abs(calls[0]![2] - (20 - 1.6))).toBeLessThan(1e-6);
    expect(Math.abs(calls[1]![2] - (20 - 0.3))).toBeLessThan(1e-6);
    calls.length = 0;
    fx.emit({ speed: 70, baScrape: 0, baPitch: 0.02 }, g, DT, "race");
    fx.emit({ speed: SPARK_V0 - 1, baScrape: 1, baPitch: 0.02 }, g, DT, "race");
    fx.emit({ speed: -70, baScrape: 1, baPitch: 0.02 }, g, DT, "race");
    expect(calls.length).toBe(0);
    fx.emit({ speed: (SPARK_V0 + SPARK_V1) / 2, baScrape: 1, baPitch: 0 }, g, DT, "race");
    expect(Math.abs(calls[0]![5] - DT * 110 * 0.5)).toBeLessThan(1e-9);
  });

  it("the spark gate is a share of the car's envelope: same fraction of top speed, same shower, at any PACE", () => {
    const rate = (vTop: number, speed: number): number => {
      const calls: ScrapeCall[] = [];
      const { fx } = load({ vTop, stub: { scrape: (...a) => calls.push(a) } });
      fx.emit({ speed, baScrape: 1, baPitch: 0 }, ground(), DT, "race");
      return calls.length ? calls[0]![5] : 0;
    };
    const full = rate(VMAX, 0.65 * VMAX), half = rate(VMAX * 0.5, 0.65 * VMAX * 0.5);
    expect(full).toBeGreaterThan(0);
    expect(Math.abs(full - half)).toBeLessThan(1e-12);
  });

  it("an AI lock-up lays marks on its own cadence — race only, never the player, never off the road", () => {
    const { fx, skids } = load();
    const g = ground();
    const ai = { speed: 50, wheelLock: 1, isPlayer: false };
    const ai2 = { speed: 50, wheelLock: 1, isPlayer: false };
    for (let i = 0; i < 60; i++) { fx.emit(ai, g, DT, "race"); fx.emit(ai2, g, DT, "race"); }
    expect(skids.otherCount).toBe(24);
    const before = skids.count;
    for (let i = 0; i < 30; i++) {
      fx.emit({ speed: 50, wheelLock: 1, isPlayer: true }, g, DT, "race");
      fx.emit({ speed: 50, wheelLock: 1, isPlayer: false }, g, DT, "count");
      fx.emit({ speed: 50, wheelLock: 1, isPlayer: false, offroad: true }, g, DT, "race");
      fx.emit({ speed: 4, wheelLock: 1, isPlayer: false }, g, DT, "race");
      fx.emit({ speed: 50, wheelLock: 0.2, isPlayer: false }, g, DT, "race");
    }
    expect(skids.count).toBe(before);
    expect(fx.status()).toEqual({ sparks: 0, marks: 24 });
  });
});

// ── EXHAUST HEAT HAZE ───────────────────────────────────────────────────────
const LAP = 5000;
const onPower = (s: number, over: Partial<FxCar> = {}): FxCar & { s: number } =>
  ({ s, speed: 60, rpm: 12000, wasOnThrottle: true, deploying: false, ...over });
const VP = (() => { const m = new Float32Array(16); m[0] = 1; m[5] = 1; m[11] = 1; return m; })();
const run = (haze: ReturnType<typeof load>["fx"]["haze"], cars: FxCar[], player: FxCar, onboard: boolean, seconds: number): number[] => {
  const trace: number[] = [];
  for (let i = 0, n = Math.round(seconds / DT); i < n; i++) { haze.pick(cars, player, onboard, LAP, DT); trace.push(haze.state().str); }
  return trace;
};

describe("car-fx: heat haze (car-fx.test.mjs)", () => {
  it("from an onboard eye the anchor is the nearest car AHEAD on power within 40 m; else the player", () => {
    const { fx } = load();
    expect(HAZE_RANGE).toBe(40);
    const me = onPower(1000);
    const behind = onPower(990), braking = onPower(1020, { wasOnThrottle: false }), near = onPower(1030), far = onPower(1036),
      gone = onPower(1050), parked = onPower(1010, { speed: 0, rpm: 5000 }), out = onPower(1012, { retired: true });
    const fieldCars = [far, gone, behind, me, braking, near, parked, out];
    expect(fx.haze.pick(fieldCars, me, true, LAP, DT)).toBe(near);
    expect(load().fx.haze.pick(fieldCars, me, false, LAP, DT)).toBe(me);
    const last = onPower(LAP - 10), first = onPower(15);
    expect(load().fx.haze.pick([first, last], last, true, LAP, DT)).toBe(first);
  });

  it("strength eases in under power (ERS deploy and revs scale it) and decays smoothly on a lift", () => {
    const { fx } = load();
    const haze = fx.haze, me = onPower(1000), ahead = onPower(1025, { rpm: 15000 });
    const target = haze.heat(ahead);
    expect(Math.abs(target - 0.45)).toBeLessThan(1e-9);
    expect(Math.abs(haze.heat(onPower(0, { rpm: 5000 })) - 0.225)).toBeLessThan(1e-9);
    expect(Math.abs(haze.heat(onPower(0, { rpm: 15000, deploying: true })) - 1)).toBeLessThan(1e-9);
    const up = run(haze, [me, ahead], me, true, 0.5);
    expect(up[0]).toBeGreaterThan(0);
    expect(up[0]).toBeLessThan(target * 0.25);
    for (let i = 1; i < up.length; i++) expect(up[i]).toBeGreaterThanOrEqual(up[i - 1]!);
    expect(up[Math.round(0.3 / DT) - 1]).toBeGreaterThan(target * 0.93);
    // The same car lifts (f1-game mutates it in place; FxCar's fields are readonly to CarFx).
    Object.assign(ahead, { wasOnThrottle: false });
    let prev = up[up.length - 1]!;
    const down: number[] = [];
    for (let i = 0; i < 30; i++) {
      haze.pick([me, ahead], me, true, LAP, DT);
      const { anchor, str } = haze.state();
      if (str > 0) expect(anchor).toBe(ahead);
      expect(str).toBeLessThanOrEqual(prev);
      expect(str >= prev * 0.8 || (str === 0 && prev < 0.03)).toBe(true);
      down.push(prev = str);
    }
    expect(down[Math.round(0.1 / DT) - 1]).toBeGreaterThan(0.1);
    expect(down[Math.round(0.35 / DT) - 1]).toBe(0);
  });

  it("nobody on power — no anchor, no plume; and nothing stale reaches the post", () => {
    const { fx } = load();
    const haze = fx.haze, me = onPower(1000, { speed: 0, rpm: 5000 });
    const grid = [me, onPower(1008, { speed: 0, rpm: 5000 }), onPower(1016, { wasOnThrottle: false })];
    run(haze, grid, me, true, 1);
    expect(haze.state().anchor).toBe(null);
    expect(haze.state().str).toBe(0);
    haze.mark(grid[1]!, ground(0, 30));
    expect(haze.at(VP)).toBe(null);
    run(haze, grid, me, false, 1);
    expect(haze.state().anchor).toBe(me);
    expect(haze.state().str).toBe(0);
    haze.mark(me, ground(0, 30));
    expect(haze.at(VP)).toBe(null);
    const live = load().fx.haze, ahead = onPower(1020);
    run(live, [me, ahead], me, true, 0.5);
    live.mark(ahead, ground(0, 23.5));
    expect(live.at(VP)).not.toBe(null);
    live.pick([me, ahead], me, true, LAP, DT);
    expect(live.at(VP), "not re-marked: nothing").toBe(null);
  });

  it("at() projects the anchor's wake — up 0.85, back 3.5 m — and fades with depth", () => {
    const { fx } = load();
    const haze = fx.haze, me = onPower(1000), ahead = onPower(1020);
    run(haze, [me, ahead], me, true, 1);
    const str = haze.state().str;
    haze.mark(me, ground(0, 50));
    expect(haze.at(VP)).toBe(null);
    haze.mark(ahead, ground(0, 23.5));
    const o = haze.at(VP)!;
    expect(o).not.toBe(null);
    expect(Math.abs(o.u - 0.5)).toBeLessThan(1e-6);
    expect(Math.abs(o.v - (0.5 + 0.85 / 20 * 0.5))).toBeLessThan(1e-6);
    expect(Math.abs(o.str - str * 0.9)).toBeLessThan(1e-6);
    haze.mark(ahead, ground(0, 60.5));
    expect(haze.at(VP)).toBe(null);
    haze.mark(ahead, ground(0, 2));
    expect(haze.at(VP)).toBe(null);
  });

  it("one anchor — a new car takes it only once the old plume has faded, never a jump", () => {
    const { fx } = load();
    const haze = fx.haze, me = onPower(1000), a = onPower(1015), b = onPower(1035);
    run(haze, [me, a, b], me, true, 0.6);
    expect(haze.state().anchor).toBe(a);
    Object.assign(a, { wasOnThrottle: false });
    const trace: [FxCar | null, number][] = [];
    for (let i = 0; i < 60; i++) { haze.pick([me, a, b], me, true, LAP, DT); trace.push([haze.state().anchor, haze.state().str]); }
    const sw = trace.findIndex(([anc]) => anc === b);
    expect(sw).toBeGreaterThan(5);
    expect(trace[sw - 1]![1]).toBeLessThan(0.02);
    expect(trace[59]![1]).toBeGreaterThan(0.3);
  });

  it("the on-power gate is a share of the car's envelope (vStd), like the other emitters", () => {
    const slow = onPower(0, { speed: 5 });
    expect(load({ vTop: VMAX }).fx.haze.heat(slow)).toBe(0);
    expect(load({ vTop: VMAX * 0.5 }).fx.haze.heat(slow)).toBeGreaterThan(0);
  });

  it("standalone heatHaze(vStd) reads car state and writes none", () => {
    const h = heatHaze((v) => v);
    const c = Object.freeze(onPower(10));
    expect(() => h.pick([c], c, false, LAP, DT)).not.toThrow();
    expect(h.heat(c)).toBeCloseTo(0.45 * (0.5 + 0.5 * 0.7), 12);
  });
});
