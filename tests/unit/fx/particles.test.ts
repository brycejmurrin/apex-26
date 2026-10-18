// src/fx/particles.ts vs f1-game js/fx/particles.js.
//   1. Parity: both driven with one seeded random stream through a few hundred frames of
//      every emitter, flares, the spray gate, rain seeding / shedding / show-hide and
//      draw(); the pool arrays, the rain offsets and every drawn batch compare bit for
//      bit (Object.is). Skipped where /home/f1-game is absent.
//   2. Ported assertions from f1-game tests/unit/car-fx.test.mjs, droplets-spray.test.mjs
//      (spray), particles-dirty.test.mjs and skidmarks-cadence.test.mjs (rain field).
//   3. Hand-derived spot values with a constant random (always run).
import { describe, expect, it } from "vitest";
import { createParticles, type ParticlePool, type ParticleSink, type ParticleStats, type Particles, type RainScale } from "../../../src/fx/particles";
import type { FxTune } from "../../../src/fx/env";
import { f1Get, firstDiff, hasF1Fx, loadF1Fx, seeded } from "./f1-fx-vm";

const DT = 1 / 60;

interface Draw { data: number[]; floats: number; additive: boolean; dirty: boolean }

/** The method surface both implementations share. */
interface PApi {
  init(gfx: ParticleSink): void;
  clear(): void;
  count(): number;
  capacity(): number;
  update(dt: number): void;
  draw(): void;
  tyreSmoke(x: number, y: number, z: number, bvx: number, bvz: number, inten: number, count?: number): void;
  sparks(x: number, y: number, z: number, dirx: number, dirz: number, speed: number, count: number): void;
  scrape(x: number, y: number, z: number, vx: number, vz: number, count: number): void;
  kickup(x: number, y: number, z: number, bvx: number, bvz: number, r: number, g: number, b: number, count?: number): void;
  spray(x: number, y: number, z: number, bvx: number, bvz: number, strength: number, count?: number): void;
  sprayStr(vs: number, k: number, wetness: number): number;
  sprayRate(str: number): number;
  sprayAdmit(d2: number): boolean;
  sprayCars(): number;
  flare(x: number, y: number, z: number, size: number, r: number, g: number, b: number, alpha: number, lamp?: boolean): boolean;
  flareCount(): number;
  rainShow(on: boolean): void;
  rainSeed(drizzle: boolean): void;
  rainUpdate(dt: number, eye: ArrayLike<number>, raining: boolean): void;
  rainActive(): boolean;
  rainIntensity(k: RainScale | null): number;
  stats(): ParticleStats;
  resetStats(): void;
}

interface Rig<T extends PApi = PApi> { P: T; draws: Draw[]; shed: { v: number }; pool: () => ParticlePool }

function sink(draws: Draw[], mobileTier: boolean): ParticleSink {
  return {
    mobileTier,
    drawParticles: (data, floats, additive, dirty) =>
      draws.push({ data: Array.from(data.subarray(0, floats)), floats, additive: !!additive, dirty: dirty !== false }),
  };
}

function portRig(seed: number, LT: FxTune | null, mobile = false): Rig {
  const shed = { v: 0 };
  const P = createParticles({ random: seeded(seed), tune: () => LT, autoShed: () => shed.v });
  const draws: Draw[] = [];
  P.init(sink(draws, mobile));
  return { P, draws, shed, pool: () => P.pool() };
}

function f1Rig(seed: number, LT: FxTune | null, mobile = false): Rig {
  const shed = { v: 0 };
  const ctx = loadF1Fx(["js/fx/particles.js"], {
    random: seeded(seed),
    ...(LT ? { LightTune: { LT } } : {}),
    PerfGov: { autoShed: () => shed.v },
  });
  const P = f1Get<PApi & { _pool(): ParticlePool }>(ctx, "Particles");
  const draws: Draw[] = [];
  P.init(sink(draws, mobile));
  return { P, draws, shed, pool: () => P._pool() };
}

/** A few hundred frames of everything; `A` (args) is its own stream, separate from the
 *  module's random. Returns a per-frame log of the scalar outputs. */
function scenario(r: Rig, frames: number): unknown[] {
  const { P, shed } = r;
  const A = seeded(0xa26);
  const log: unknown[] = [];
  P.rainIntensity({ count: 1.2, speed: 1.1, len: 1.3, alpha: 0.9 });
  P.rainSeed(false);
  P.rainShow(true);
  const eye = [100, 5, -30];
  for (let f = 0; f < frames; f++) {
    const dt = f % 97 === 50 ? 0.25 : f % 53 === 7 ? 0 : DT + A() * 0.01;
    shed.v = f > 200 && f < 260 ? 1 : f >= 260 && f < 280 ? 2 : 0;
    P.update(dt);
    const x = A() * 40 - 20, z = A() * 40 - 20, bvx = A() * 60 - 30, bvz = A() * 60 - 30;
    switch (f % 6) {
      case 0: P.tyreSmoke(x, 0.1, z, bvx, bvz, A(), f % 12 === 0 ? undefined : A() * 6); break;
      case 1: P.sparks(x, 0.3, z, A() - 0.5, A() - 0.5, A() * 40, Math.floor(A() * 12)); break;
      case 2: P.scrape(x, 0.02, z, bvx, bvz, A() * 4); break;
      case 3: P.kickup(x, 0, z, bvx, bvz, 0.4, 0.3, 0.2, f % 18 === 3 ? undefined : A() * 5); break;
      case 4: if (P.sprayAdmit(A() * 1e4)) P.spray(x, 0.3, z, bvx, bvz, A() * 1.6, A() * 3); break;
      default: P.spray(x, 0.3, z, bvx, bvz, A() * 1.6); break;
    }
    if (f % 3 === 0) log.push(P.flare(x, 1, z, 0.2, 2.4, 0.85, 0.22, A(), f % 9 === 0));
    if (f === 150) P.rainSeed(true);
    if (f === 300) P.rainShow(false);
    if (f === 320) { P.rainIntensity(null); P.rainSeed(false); P.rainShow(true); }
    eye[0]! += A() * 2; eye[2]! += A() * 0.5;
    if (f === 340) eye[0]! += 100;   // a camera cut
    if (f % 5 !== 4) P.rainUpdate(dt, eye, f % 2 === 0);
    if (f === 380) P.clear();
    P.draw();
    log.push(P.count(), P.flareCount(), P.rainActive(), JSON.stringify(P.stats()));
  }
  log.push(P.sprayStr(40, 1.35, 0.6), P.sprayRate(0.7), P.sprayCars(), P.capacity());
  return log;
}

function expectSamePool(a: ParticlePool, b: ParticlePool): void {
  expect(a.n).toBe(b.n);
  expect(a.flN).toBe(b.flN);
  expect(a.rainN).toBe(b.rainN);
  for (const k of ["px", "py", "pz", "vx", "vy", "vz", "age", "life", "sz", "grw", "cr", "cg", "cb", "a0", "drg", "grv", "add", "fl", "rox", "roy", "roz"] as const) {
    expect(firstDiff(a[k], b[k]), k).toBeNull();
  }
  expect(a.px).toBeInstanceOf(Float32Array);
}

describe.skipIf(!hasF1Fx)("particles parity with f1-game js/fx/particles.js (VM, seeded)", () => {
  const LT: FxTune = { particleMul: 1.5, rainCount: 40, rainStreak: 1.1, rainWind: 0.2, windDir: 20, rainSpeed: 1.05, rainOpacity: 0.9 };
  for (const [name, lt, mobile] of [["desktop, tuned", LT, false], ["mobile, no tuner", null, true]] as const) {
    it(`${name}: pools, rain field and every batch match bit for bit over 400 frames`, () => {
      const a = portRig(0x5eed, lt, mobile), b = f1Rig(0x5eed, lt, mobile);
      const la = scenario(a, 400), lb = scenario(b, 400);
      expect(la).toEqual(lb);
      expectSamePool(a.pool(), b.pool());
      expect(a.draws.length).toBe(b.draws.length);
      expect(a.draws.length).toBeGreaterThan(300);
      for (let i = 0; i < a.draws.length; i++) {
        const da = a.draws[i]!, db = b.draws[i]!;
        expect([da.floats, da.additive, da.dirty], `draw ${i}`).toEqual([db.floats, db.additive, db.dirty]);
        expect(firstDiff(da.data, db.data), `draw ${i}`).toBeNull();
      }
    });
  }

  it("the pool matches mid-run too (every 25 frames)", () => {
    const a = portRig(7, LT), b = f1Rig(7, LT);
    for (let k = 0; k < 12; k++) {
      expect(scenario(a, 25)).toEqual(scenario(b, 25));
      expectSamePool(a.pool(), b.pool());
    }
  });
});

// ── Ported from f1-game tests/unit/car-fx.test.mjs ───────────────────────────
function rig(opts: { mobile?: boolean; autoShed?: number; random?: () => number; LT?: FxTune | null } = {}): Rig<Particles> {
  const shed = { v: opts.autoShed ?? 0 };
  const LT = opts.LT ?? null;
  const P = createParticles({ random: opts.random ?? seeded(0xca7f), tune: () => LT, autoShed: () => shed.v });
  const draws: Draw[] = [];
  P.init(sink(draws, !!opts.mobile));
  return { P, draws, shed, pool: () => P.pool() };
}

describe("particles: pool discipline, flares, shedding (car-fx.test.mjs)", () => {
  it("embers and spray leave pool headroom; the plume lingers; a flare is drawn exactly one frame", () => {
    const { P, draws } = rig();
    const MAX = P.capacity();
    expect(MAX).toBe(256);
    for (let i = 0; i < 200; i++) P.scrape(0, 0, 0, 0, 70, 4);
    expect(P.count()).toBeGreaterThanOrEqual(MAX * 0.6);
    expect(P.count()).toBeLessThanOrEqual(MAX * 0.6 + 4);
    const n0 = P.count();
    P.sparks(0, 0, 0, 0, 1, 10, 20);
    expect(P.count(), "a collision still finds room").toBe(n0 + 20);
    P.clear();
    for (let i = 0; i < 200; i++) P.spray(0, 0.3, 0, 0, -20, 1, 4);
    expect(P.count()).toBeGreaterThanOrEqual(MAX * 0.75);
    expect(P.count()).toBeLessThanOrEqual(MAX * 0.75 + 4);
    const n1 = P.count();
    for (let i = 0; i < 60; i++) P.update(DT);
    expect(P.count(), "most spray clouds live past one second").toBeGreaterThanOrEqual(n1 * 0.7);
    for (let i = 0; i < 70; i++) P.update(DT);
    expect(P.count(), "the mist still hangs at ~2.2 s").toBeGreaterThan(0);
    for (let i = 0; i < 145; i++) P.update(DT);
    expect(P.count(), "…and is gone by ~4.6 s").toBe(0);
    P.clear();
    draws.length = 0;
    expect(P.flare(1, 2, 3, 0.2, 2.4, 0.85, 0.22, 0.9)).toBe(true);
    expect(P.count(), "a flare is not a pool particle").toBe(0);
    P.update(DT);
    P.draw();
    expect(draws.length).toBe(1);
    expect(draws[0]!.additive).toBe(true);
    expect(draws[0]!.floats, "one quad in the additive batch").toBe(60);
    expect(draws[0]!.data.slice(2, 5)).toEqual([1, 2, 3]);
    expect(Math.abs(draws[0]!.data[9]! - 0.9)).toBeLessThan(1e-6);
    draws.length = 0;
    P.update(DT);
    P.draw();
    expect(draws.length, "not drawn again: no trail of copies").toBe(0);
    let ok = 0;
    for (let i = 0; i < 100; i++) if (P.flare(0, 0, 0, 0.2, 1, 1, 1, 1)) ok++;
    expect(ok, "the desktop frame holds 48 flares").toBe(48);
    expect(P.flare(0, 0, 0, 0.2, 1, 1, 1, 0), "an invisible flare is refused").toBe(false);
    expect(P.flare(0, 0, 0, 0.2, 1, 1, 1, 1, true), "a lamp draws on the reserve").toBe(true);
    P.clear();
    expect(P.flareCount(), "clear() drops pending flares").toBe(0);
  });

  it("the mobile tier keeps a smaller pool, a shorter plume and fewer flares", () => {
    const { P } = rig({ mobile: true });
    expect(P.capacity()).toBe(96);
    for (let i = 0; i < 6; i++) P.spray(0, 0.3, 0, 0, -20, 1, 4);
    expect(P.count()).toBeGreaterThan(0);
    for (let i = 0; i < 191; i++) P.update(DT);
    expect(P.count(), "mobile spray clouds live ×0.7").toBe(0);
    let ok = 0;
    for (let i = 0; i < 40; i++) if (P.flare(0, 0, 0, 0.2, 1, 1, 1, 1)) ok++;
    expect(ok).toBe(24);
  });

  it("a full pool recycles its oldest particle: the newest emission is never the one dropped", () => {
    const { P, draws } = rig();
    const MAX = P.capacity();
    for (let i = 0; i < MAX / 8; i++) P.tyreSmoke(-100, 0, 0, 0, 0, 0.5, 4);
    P.update(0.3);
    for (let i = 0; i < MAX / 8; i++) P.tyreSmoke(100, 0, 0, 0, 0, 0.5, 4);
    P.update(0.05);
    expect(P.count()).toBe(MAX);
    P.sparks(500, 0, 0, 0, 1, 10, 5);
    expect(P.count(), "still full: recycled, not grown").toBe(MAX);
    P.update(0.02);
    draws.length = 0;
    P.draw();
    const near = (x0: number, additive: boolean): number => draws.filter((d) => d.additive === additive)
      .reduce((n, d) => { for (let o = 0; o < d.floats; o += 60) if (Math.abs(d.data[o + 2]! - x0) < 5) n++; return n; }, 0);
    expect(near(500, true), "the five new embers are drawn").toBe(5);
    expect(near(-100, false), "the slots came from the OLDEST plume").toBe(MAX / 2 - 5);
    expect(near(100, false), "the young plume is untouched").toBe(MAX / 2);
  });

  it("emission follows the requested rate at any frame rate: plank embers at 10, 20 and 60 fps", () => {
    for (const hz of [10, 20, 60]) {
      const { P } = rig();
      const dt = 1 / hz, frames = 20 * hz;
      let spawned = 0;
      for (let f = 0; f < frames; f++) {
        const n0 = P.count();
        P.scrape(0, 0, 0, 0, 70, dt * 110);
        spawned += P.count() - n0;
        P.clear();
      }
      expect(Math.abs(spawned / 20 / 110 - 1), `${hz} fps`).toBeLessThanOrEqual(0.03);
    }
  });

  it("tyreSmoke/sparks/kickup/scrape/spray shed with the governor (autoShed)", () => {
    const full = rig({ autoShed: 0, random: () => 0 }).P;
    const half = rig({ autoShed: 1, random: () => 0 }).P;
    const third = rig({ autoShed: 2, random: () => 0 }).P;
    const ask = 6;
    full.tyreSmoke(0, 0, 0, 0, 0, 0.5, ask);
    half.tyreSmoke(0, 0, 0, 0, 0, 0.5, ask);
    third.tyreSmoke(0, 0, 0, 0, 0, 0.5, ask);
    expect([full.count(), half.count(), third.count()]).toEqual([ask, ask / 2, ask / 3]);
    for (const P of [full, half, third]) P.clear();
    full.sparks(0, 0, 0, 0, 1, 10, ask);
    half.sparks(0, 0, 0, 0, 1, 10, ask);
    expect([full.count(), half.count()]).toEqual([ask, ask / 2]);
    for (const P of [full, half]) P.clear();
    full.kickup(0, 0, 0, 0, 0, 0.4, 0.3, 0.2, ask);
    half.kickup(0, 0, 0, 0, 0, 0.4, 0.3, 0.2, ask);
    expect([full.count(), half.count()], "random=0 always spawns the dust twin").toEqual([ask * 2, ask]);
    for (const P of [full, half]) P.clear();
    full.scrape(0, 0, 0, 0, 70, ask);
    half.scrape(0, 0, 0, 0, 70, ask);
    expect([full.count(), half.count()]).toEqual([ask, ask / 2]);
    for (const P of [full, half]) P.clear();
    full.spray(0, 0, 0, 0, 0, 1, ask);
    half.spray(0, 0, 0, 0, 0, 1, ask);
    expect([full.count(), half.count()]).toEqual([ask, ask / 2]);
  });

  it("particleMul 0 turns the effects off; a flare (a lamp) ignores it", () => {
    const { P } = rig({ LT: { particleMul: 0 } });
    P.tyreSmoke(0, 0, 0, 0, 0, 1, 4); P.sparks(0, 0, 0, 0, 1, 10, 4); P.spray(0, 0, 0, 0, 0, 1, 4);
    expect(P.count()).toBe(0);
    expect(P.flare(0, 0, 0, 0.2, 1, 1, 1, 1)).toBe(true);
  });
});

// ── Ported from f1-game tests/unit/droplets-spray.test.mjs (spray) ───────────
describe("particles: spray strength, headroom and the nearest-N gate (droplets-spray.test.mjs)", () => {
  const LT: FxTune = { particleMul: 1, rainCount: 8, rainStreak: 1, rainWind: 0, windDir: 0, rainSpeed: 1, rainOpacity: 1 };
  it("strength scales with speed, wetness and the storm tier", () => {
    const { P } = rig({ LT });
    expect(P.sprayStr(10, 1, 1), "below ~21 % of the envelope: none").toBe(0);
    expect(P.sprayStr(40, 1, 1)).toBeLessThan(P.sprayStr(60, 1, 1));
    expect(P.sprayStr(60, 1, 0.3)).toBeLessThan(P.sprayStr(60, 1, 0.9));
    expect(Math.abs(P.sprayStr(60, 1.35, 1) / P.sprayStr(60, 1, 1) - 1.35)).toBeLessThan(1e-9);
    expect(P.sprayRate(1.35)).toBeGreaterThan(P.sprayRate(1));
    expect(P.sprayRate(1)).toBeGreaterThan(9 + 21);
  });

  it("never takes the pool's last quarter, and leaves mist hanging past the old 1.9 s plume", () => {
    const { P } = rig({ LT, random: seeded(0x5b7a) });
    for (let i = 0; i < 240; i++) { P.spray(0, 0.3, 0, 0, -20, 1.35, 20); P.update(1 / 60); }
    expect(P.count()).toBeLessThanOrEqual(P.capacity() * 0.75 + 1);
    for (let i = 0; i < 150; i++) P.update(1 / 60);
    expect(P.count(), "mist clouds (3-4.5 s) still hang in the air").toBeGreaterThan(0);
  });

  it("only the nearest N cars emit (desktop 6, phone 3)", () => {
    for (const [mobile, N] of [[false, 6], [true, 3]] as const) {
      const { P } = rig({ LT, mobile });
      expect(P.sprayCars()).toBe(N);
      const d2 = Array.from({ length: 12 }, (_, i) => (10 + i * 10) ** 2);
      d2.forEach((d) => P.sprayAdmit(d));
      P.update(1 / 60);
      const ok = d2.map((d) => P.sprayAdmit(d));
      expect(ok.filter(Boolean).length).toBe(N);
      expect(ok.slice(0, N)).toEqual(Array(N).fill(true));
    }
  });
});

// ── Ported from f1-game tests/unit/particles-dirty.test.mjs ──────────────────
describe("particles: the dirty latch (particles-dirty.test.mjs)", () => {
  const LT: FxTune = { rainCount: 8, rainStreak: 1, rainWind: 0, windDir: 0, rainSpeed: 1, rainOpacity: 1 };
  const make = () => rig({ LT, random: seeded(0xd117) });

  it("parked rain expands ~30x/s (not every frame, not frozen) until the eye leaves the cell", () => {
    const { P, draws } = make();
    P.rainSeed(false);
    P.rainShow(true);
    P.resetStats();
    const eye = [100, 5, -30];
    P.rainUpdate(0.016, eye, true);
    P.draw();
    expect(P.stats().expands).toBe(1);
    expect(P.stats().uploadFloats).toBeGreaterThan(0);
    const firstFloats = draws[0]!.floats;
    expect(draws[0]!.dirty).toBe(true);
    draws.length = 0;
    for (let i = 0; i < 30; i++) { P.rainUpdate(0.016, eye, true); P.draw(); }
    const st = P.stats();
    expect(st.skips).toBeGreaterThanOrEqual(15);
    expect(st.expands).toBeGreaterThanOrEqual(8);
    expect(st.expands).toBeLessThanOrEqual(16);
    expect(draws.some((u) => !u.dirty)).toBe(true);
    expect(draws.every((u) => u.floats === firstFloats)).toBe(true);
    draws.length = 0;
    P.resetStats();
    P.rainUpdate(0.016, [eye[0]! + 3, eye[1]!, eye[2]!], true);
    P.draw();
    expect(P.stats().expands, "eye cell change expands again").toBe(1);
    expect(draws[0]!.dirty).toBe(true);
  });

  it("pool update dirties so moving smoke keeps uploading", () => {
    const { P, draws } = make();
    P.tyreSmoke(0, 0, 0, 1, 0, 1, 4);
    P.resetStats();
    P.update(0.016); P.draw();
    expect(P.stats().expands).toBe(1);
    P.update(0.016); P.draw();
    expect(P.stats().expands).toBe(2);
    expect(draws.every((u) => u.dirty)).toBe(true);
  });

  it("one-frame flares refresh additive data while clean rain reuses alpha", () => {
    const { P, draws } = make();
    const eye = [100, 5, -30];
    P.rainSeed(false); P.rainShow(true); P.rainUpdate(0.001, eye, true); P.draw();
    const floats = draws[0]!.floats;
    P.resetStats(); draws.length = 0;
    P.flare(100, 5, -30, 1, 1, 0, 0, 1, true);
    P.rainUpdate(0.001, eye, true); P.draw();
    expect(draws.find((u) => !u.additive)!.dirty).toBe(false);
    expect(draws.find((u) => u.additive)!.dirty).toBe(true);
    expect(P.stats()).toMatchObject({ uploadFloats: 60, alphaExpands: 0, additiveExpands: 1 });
    draws.length = 0; P.rainUpdate(0.001, eye, true); P.draw();
    expect(draws.length, "removed flare is absent from the next frame").toBe(1);
    expect([draws[0]!.floats, draws[0]!.dirty]).toEqual([floats, false]);
  });

  it("rain offsets wrap across several widths in either camera direction", () => {
    const { P, draws } = make();
    P.rainSeed(false); P.rainShow(true);
    let eye = [0, 0, 0]; P.rainUpdate(0.01, eye, true); P.draw();
    for (const next of [[30, 0, 0], [0, 30, 0], [-30, 0, 0], [-30, -30, 0], [-30, -30, 30]]) {
      draws.length = 0; eye = next; P.rainUpdate(0.01, eye, true); P.draw();
      const u = draws[0]!;
      for (let i = 0; i < u.floats; i += 60) {
        const center = (k: number): number => (u.data[i + k]! + u.data[i + 20 + k]!) / 2 - eye[k - 2]!;
        expect(Math.abs(center(2))).toBeLessThanOrEqual(9.0001);
        expect(Math.abs(center(4))).toBeLessThanOrEqual(9.0001);
        expect(center(3)).toBeGreaterThanOrEqual(-3.0001);
        expect(center(3)).toBeLessThanOrEqual(5.0001);
      }
    }
  });
});

// ── Ported from f1-game tests/unit/skidmarks-cadence.test.mjs (the rain field test) ──
describe("particles: the rain streak field (skidmarks-cadence.test.mjs)", () => {
  it("re-seeds only newly visible drops when the governor sheds less; streaks rake with the camera", () => {
    const r = rig({ LT: { rainCount: 4, rainStreak: 1, rainWind: 0, windDir: 0 }, random: seeded(0x5eed7a1), autoShed: 1 });
    const { P, draws } = r;
    P.rainSeed(false);
    P.rainShow(true);
    expect(P.rainActive()).toBe(true);
    const eye = [100, 5, -30];
    P.rainUpdate(0.01, eye, true);
    P.draw();
    expect(draws.length, "one alpha batch, no additive batch").toBe(1);
    expect(draws[0]!.floats, "shed level 1 draws half the seeded rain").toBe(2 * 6 * 10);
    const drops = (c: Draw): number[][] => { const out: number[][] = []; for (let i = 0; i < c.floats; i += 60) out.push(c.data.slice(i, i + 60)); return out; };
    for (const d of drops(draws[0]!)) {
      for (let v = 0; v < 6; v++) {
        const o = v * 10;
        expect(d[o + 8], "size 0").toBe(0);
        expect(d[o + 9]).toBeGreaterThan(0);
        expect(d[o + 9]).toBeLessThanOrEqual(1);
        expect(Math.abs(d[o + 2]! - eye[0]!)).toBeLessThanOrEqual(10);
        expect(Math.abs(d[o + 4]! - eye[2]!)).toBeLessThanOrEqual(10);
        for (let k = 0; k < 10; k++) expect(Number.isFinite(d[o + k])).toBe(true);
      }
    }
    for (let i = 0; i < 200; i++) P.rainUpdate(0.05, eye, true);
    draws.length = 0;
    r.shed.v = 0;
    P.rainUpdate(0.01, eye, true);
    P.draw();
    expect(draws[0]!.floats, "density returns when the governor recovers").toBe(4 * 6 * 10);
    for (const d of drops(draws[0]!)) {
      expect(d[3]! - eye[1]!).toBeGreaterThan(-4);
      expect(d[3]! - eye[1]!).toBeLessThan(6);
    }
    draws.length = 0;
    P.rainUpdate(0.02, [eye[0]! + 1.2, eye[1]!, eye[2]!], true);   // 60 m/s along +x
    P.draw();
    let raked = 0;
    for (const d of drops(draws[0]!)) {
      const dx = Math.abs(d[2 + 20]! - d[2]!), dy = Math.abs(d[3 + 20]! - d[3]!);
      if (dx > dy * 2) raked++;
    }
    expect(raked, "at 60 m/s most streaks lie nearly horizontal").toBeGreaterThanOrEqual(3);
    P.rainShow(false);
    draws.length = 0;
    P.draw();
    expect(draws.length, "hidden: nothing drawn").toBe(0);
  });
});

// ── Hand-derived spot values (always run) ────────────────────────────────────
describe("particles: spot values with random() = 0.5 (rnd(k) = 0)", () => {
  it("a tyre-smoke puff spawns, integrates and draws as particles.js:143-157 / :307-334 / :336-405 say", () => {
    const { P, draws } = rig({ random: () => 0.5 });
    P.tyreSmoke(1, 2, 3, 4, 5, 0.5);   // count undefined → 1; nOf: 0.5 < 0 false → 1
    const p = P.pool();
    expect(p.n).toBe(1);
    const f = Math.fround;
    // s = 0.7 + 0.5*0.6 = 1; w = 0.52 + 0.15 = 0.67
    expect([p.px[0], p.py[0], p.pz[0]]).toEqual([f(1), f(2 + 0.06), f(3)]);
    expect([p.vx[0], p.vy[0], p.vz[0]]).toEqual([f(4), f(1.0 + 0.5 * 1.1), f(5)]);
    expect([p.life[0], p.sz[0], p.grw[0]]).toEqual([f(0.55 + 0.5 * 0.45), f(0.34 * (0.7 + 0.5 * 0.6)), f(1.9 * (0.7 + 0.5 * 0.6))]);
    expect([p.cr[0], p.cb[0], p.a0[0], p.drg[0], p.grv[0], p.add[0]]).toEqual([f(0.52 + 0.3 * 0.5), f(0.52 + 0.3 * 0.5 + 0.02), f(0.15 + 0.25 * 0.5), f(1.7), f(-1.1), 0]);
    P.update(0.25);   // clamped to 0.1
    const d = Math.exp(-f(1.7) * 0.1);
    expect(p.age[0]).toBe(f(0.1));
    expect(p.vx[0]).toBe(f(f(4) * d));
    expect(p.vy[0]).toBe(f((f(1.55) - f(-1.1) * 0.1) * d));
    expect(p.px[0]).toBe(f(f(1) + f(f(4) * d) * 0.1));
    P.draw();
    expect(draws.length).toBe(1);
    const t = f(0.1) / f(0.775);
    expect(draws[0]!.data.slice(0, 10)).toEqual([
      -1, -1, p.px[0], p.py[0], p.pz[0], p.cr[0], p.cg[0], p.cb[0],
      f(f(0.34) + f(1.9) * f(0.1)), f(f(0.275) * (1 - (t - 0.12) / 0.88)),
    ]);
  });

  it("sprayStr / sprayRate / the flare budget", () => {
    const { P } = rig();
    expect(P.sprayStr(60, 1, 0.8)).toBe(1);
    expect(P.sprayStr(37.5, 1, 0.25)).toBe(0.5 * 0.55);
    expect(P.sprayRate(1)).toBe(36);
    expect(P.capacity()).toBe(256);
  });
});
