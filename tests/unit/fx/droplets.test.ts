// src/fx/droplets.ts vs f1-game js/fx/droplets.js: the same stub DOM and seeded random on
// both sides, the drop pool and every Canvas2D call compared bit for bit; then the
// droplet assertions of f1-game tests/unit/droplets-spray.test.mjs and spot values.
import { describe, expect, it } from "vitest";
import { cap, createDroplets, DropletSim, rate, RAIN_MIN, type Droplets } from "../../../src/fx/droplets";
import { f1Get, firstDiff, hasF1Fx, loadF1Fx, seeded } from "./f1-fx-vm";

interface Calls { clear: number; draw: number; rotate: number; log: unknown[]; inserted?: { id: string } }

function ctx2d(calls: Calls) {
  const grad = { addColorStop() {} };
  const g = {
    _a: 1,
    get globalAlpha() { return this._a; },
    set globalAlpha(v: number) { this._a = v; calls.log.push(["alpha", v]); },
    fillStyle: "" as unknown,
    clearRect: (...a: number[]) => { calls.clear++; calls.log.push(["clear", ...a]); },
    drawImage: (_img: unknown, ...a: number[]) => { calls.draw++; calls.log.push(["img", ...a]); },
    save() {}, restore() {},
    translate: (...a: number[]) => { calls.log.push(["tr", ...a]); },
    rotate: (a: number) => { calls.rotate++; calls.log.push(["rot", a]); },
    beginPath() {}, arc: (...a: number[]) => { calls.log.push(["arc", ...a]); }, fill() {},
    createRadialGradient: () => grad, createLinearGradient: () => grad,
  };
  return g;
}

interface DomOpts { mobile?: boolean; preset?: string; staticEl?: boolean }
function dom({ staticEl = true }: DomOpts, calls: Calls) {
  const el = { id: "fx-droplets", hidden: true, width: 0, height: 0, getContext: () => ctx2d(calls), setAttribute() {} };
  const game = { parentNode: { insertBefore: (n: { id: string }) => { calls.inserted = n; } } };
  const document = {
    getElementById: (id: string) => (id === "fx-droplets" ? (staticEl ? el : null) : id === "game" ? game : null),
    createElement: () => ({ id: "", width: 0, height: 0, hidden: false, setAttribute() {}, getContext: () => ctx2d(calls) }),
  };
  const window = { innerWidth: 844, innerHeight: 390, devicePixelRatio: 3 };
  return { el, document, window };
}

function makePort(opts: DomOpts = {}, random: () => number = seeded(0xd809)) {
  const calls: Calls = { clear: 0, draw: 0, rotate: 0, log: [] };
  const { el, document, window } = dom(opts, calls);
  const D = createDroplets({
    doc: document as unknown as Document, win: window,
    isMobile: () => !!opts.mobile, graphicsLow: () => opts.preset === "low", random,
  });
  return { D, el, calls };
}

interface F1Pool { n: number; acc: number; x: Float32Array; y: Float32Array; r: Float32Array; age: Float32Array; life: Float32Array; vx: Float32Array; vy: Float32Array; a: Float32Array }
function makeF1(opts: DomOpts = {}, random: () => number = seeded(0xd809)) {
  const calls: Calls = { clear: 0, draw: 0, rotate: 0, log: [] };
  const { el, document, window } = dom(opts, calls);
  const ctx = loadF1Fx(["js/fx/droplets.js"], {
    random, document, window, GLX: { isMobile: !!opts.mobile }, GfxQuality: { current: () => opts.preset ?? "high" },
  });
  const D = f1Get<Pick<Droplets, "tick" | "stats"> & { _pool(): F1Pool }>(ctx, "Droplets");
  return { D, el, calls };
}

function run(D: Pick<Droplets, "tick">, s: number, on: boolean, rain: number, storm: boolean, vs: number, reduced: boolean): void {
  for (let i = 0; i < s * 60; i++) D.tick(1 / 60, on, rain, storm, vs, reduced);
}

describe.skipIf(!hasF1Fx)("droplets parity with f1-game js/fx/droplets.js (VM, seeded, stub canvas)", () => {
  for (const [name, opts, reduced] of [["desktop", {}, false], ["phone, reduced motion", { mobile: true }, true]] as const) {
    it(`${name}: the drop pool and every canvas call match over 600 frames of changing rain and speed`, () => {
      const a = makePort(opts), b = makeF1(opts);
      const A1 = seeded(99), A2 = seeded(99);
      const drive = (D: Pick<Droplets, "tick">, A: () => number): void => {
        for (let f = 0; f < 600; f++) {
          const dt = f % 71 === 3 ? 0 : f % 89 === 5 ? 0.3 : 1 / 60 + A() * 0.01;
          const on = !(f > 400 && f < 420);
          const rain = f < 300 ? 0.4 + f / 300 : 1 - (f - 300) / 600;
          D.tick(dt, on, rain, f % 200 > 100, A() * 90, reduced);
        }
      };
      drive(a.D, A1); drive(b.D, A2);
      const pa = a.D.sim, pb = b.D._pool();
      expect([pa.n, pa.acc]).toEqual([pb.n, pb.acc]);
      for (const k of ["x", "y", "r", "age", "life", "vx", "vy", "a"] as const) expect(firstDiff(pa[k], pb[k]), k).toBeNull();
      expect(a.calls.log.length).toBe(b.calls.log.length);
      expect(a.calls.log).toEqual(b.calls.log);
      expect(a.D.stats()).toEqual(b.D.stats());
      expect([a.el.width, a.el.height, a.el.hidden]).toEqual([b.el.width, b.el.height, b.el.hidden]);
    });
  }
});

// ── Ported from f1-game tests/unit/droplets-spray.test.mjs ───────────────────
describe("droplets (droplets-spray.test.mjs)", () => {
  it("spawn rate follows rain — none below falling rain, storm heavier", () => {
    const { D } = makePort();
    expect(D.rate(0, false, false)).toBe(0);
    expect(D.rate(0.35, false, false), "drizzle tier wets the road, not the lens").toBe(0);
    const half = D.rate(0.75, false, false), full = D.rate(1, false, false), storm = D.rate(1, true, false);
    expect(half).toBeGreaterThan(0);
    expect(full).toBeGreaterThan(half);
    expect(storm).toBeGreaterThan(full * 1.5);
    expect(D.rate(1, false, true)).toBeLessThan(full);
  });

  it("onboard-only — any other camera hides the overlay and drops every drop", () => {
    const { D, el } = makePort();
    run(D, 2, true, 1, false, 10, false);
    expect(D.stats().n).toBeGreaterThan(0);
    expect(el.hidden).toBe(false);
    D.tick(1 / 60, false, 1, false, 10, false);
    expect(D.stats().n).toBe(0);
    expect(el.hidden).toBe(true);
    D.tick(1 / 60, true, 0, false, 10, false);
    expect(el.hidden, "dry onboard stays hidden").toBe(true);
  });

  it("capped — ≤ 40 on phones, ≤ 90 desktop, half under reduced motion", () => {
    for (const [mobile, capN] of [[true, 40], [false, 90]] as const) {
      const { D } = makePort({ mobile });
      let peak = 0;
      for (let i = 0; i < 20 * 60; i++) { D.tick(1 / 60, true, 1, true, 0, false); peak = Math.max(peak, D.stats().n); }
      expect(peak).toBeLessThanOrEqual(capN);
      expect(peak).toBeGreaterThanOrEqual(capN * 0.6);
      expect(D.cap(mobile, true)).toBe(capN >> 1);
    }
  });

  it("blown off at speed — fewer live drops at 80 m/s than parked", () => {
    const a = makePort(), b = makePort();
    run(a.D, 6, true, 1, false, 0, false);
    run(b.D, 6, true, 1, false, 80, false);
    expect(b.D.stats().n).toBeLessThan(a.D.stats().n);
    expect(b.calls.rotate, "moving drops are drawn as rotated streaks").toBeGreaterThan(0);
  });

  it("reduced motion — drops never move or streak", () => {
    const { D, calls } = makePort();
    run(D, 3, true, 1, true, 80, true);
    expect(D.stats().n).toBeGreaterThan(0);
    expect(calls.rotate).toBe(0);
  });

  it("GRAPHICS LOW is off; pause freezes; a missing static element is built after #game", () => {
    const low = makePort({ preset: "low" });
    run(low.D, 2, true, 1, true, 30, false);
    expect(low.D.stats().n).toBe(0);
    expect(low.el.hidden).toBe(true);
    const p = makePort();
    run(p.D, 2, true, 1, false, 0, false);
    const n = p.D.stats().n, draws = p.calls.draw;
    for (let i = 0; i < 60; i++) p.D.tick(0, true, 1, false, 0, false);
    expect(p.D.stats().n).toBe(n);
    expect(p.calls.draw).toBe(draws);
    const dyn = makePort({ staticEl: false });
    dyn.D.tick(1 / 60, true, 1, false, 0, false);
    expect(dyn.calls.inserted?.id).toBe("fx-droplets");
  });

  it("DPR capped (phones 1, desktop 1.5) and the canvas tracks the viewport", () => {
    const ph = makePort({ mobile: true });
    ph.D.tick(1 / 60, true, 1, false, 0, false);
    expect([ph.el.width, ph.el.height]).toEqual([844, 390]);
    const dk = makePort();
    dk.D.tick(1 / 60, true, 1, false, 0, false);
    expect([dk.el.width, dk.el.height]).toEqual([1266, 585]);
  });

  it("no document: tick is a no-op, never a throw", () => {
    const D = createDroplets({ doc: null, win: null });
    expect(() => D.tick(1 / 60, true, 1, false, 0, false)).not.toThrow();
    expect(D.stats().n).toBe(0);
  });
});

describe("droplets spot values", () => {
  it("rate / cap / RAIN_MIN (droplets.js:22-57)", () => {
    expect(RAIN_MIN).toBe(0.5);
    expect(rate(1, false, false)).toBe(18);
    expect(rate(1, true, true)).toBe(34 * 0.4);
    expect(rate(0.75, false, false)).toBe(18 * (0.3 + 0.7 * 0.5));
    expect([cap(true, false), cap(false, false), cap(false, true)]).toEqual([40, 90, 45]);
  });

  it("DropletSim: a spawn at random() = 0.5 and one parked step (droplets.js:121-161)", () => {
    const sim = new DropletSim(() => 0.5);
    sim.emit(60, 1 / 60, 90, false);   // acc 1 → one drop
    expect(sim.n).toBe(1);
    const f = Math.fround;
    expect([sim.x[0], sim.y[0], sim.r[0], sim.life[0], sim.a[0]]).toEqual([f(0.04 + 0.46), f(0.04 + 0.4), f(0.006 + 0.25 * 0.02), f(2.5 + 1.75), f(0.55 + 0.225)]);
    sim.step(0.1, 0, false);   // parked: air 0 → a slow sag
    const stick = Math.min(1, f(0.011) / 0.02), ty = 0 + (1 - 0) * 0.015 * stick;
    expect(sim.vy[0]).toBe(f(0 + (ty - 0) * Math.min(1, 0.1 * 6)));
    expect(sim.vx[0]).toBe(0);
  });
});
