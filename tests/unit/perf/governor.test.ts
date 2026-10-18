/**
 * PerfGov port vs f1-game js/perf/governor.js. The governor's decisions are a
 * pure function of the frame-time history (plus the fake renderer's scale), so
 * f1-game's PerfGov (Node VM) and the port are fed the same scripted sequences
 * and every state bit is compared with Object.is after EVERY tick. Behavioural
 * pins ported from f1-game tests/unit/perf-governor.test.mjs, perf-sentinel and
 * thermal-drift.test.mjs run on the port alone (no f1-game needed).
 */
import { describe, expect, it } from "vitest";
import { createPerfGov, createScaleGfx, renderScaleReport, type PerfGfx, type PerfGov } from "../../../src/perf/governor";
import { memoryRawStore } from "../../../src/perf/env";
import { f1Perf, hasF1Perf } from "./perf-vm";

// A fake renderer mirroring GLX.setRenderScale EXACTLY, dead zone and all
// (f1-game perf-governor.test.mjs:39-70: "Do not simplify this back").
const SCALE_EPS = 0.02;
function fakeGfx(isMobile = true): PerfGfx & { scale: () => number; moves: number[] } {
  let scale = 1;
  const moves: number[] = [];
  return {
    isMobile,
    getRenderScale: () => scale,
    setRenderScale: (s: number) => {
      s = Math.max(0.5, Math.min(1, s));
      if (Math.abs(s - scale) < SCALE_EPS) return false;
      scale = s; moves.push(s); return true;
    },
    scale: () => scale,
    moves,
  };
}

function makeGov(opts: { mobile?: boolean; seed?: Record<string, string>; drift?: boolean } = {}) {
  const store = memoryRawStore(opts.seed ?? {});
  const gov = createPerfGov({ store, build: "1" });
  const gfx = fakeGfx(opts.mobile ?? true);
  gov.init(gfx);
  if (opts.drift != null) gov.setThermalDrift(opts.drift);
  return { gov, gfx, store, scale: gfx.scale };
}

function feed(gov: PerfGov, dt: (i: number) => number, n: number): void {
  for (let i = 0; i < n; i++) gov.tick(dt(i));
}

/** f1-game's PerfGov surface, as loose as the VM hands it back. */
type F1Gov = Omit<PerfGov, "init"> & { init(g: PerfGfx): void };

function makeF1(opts: { mobile?: boolean; seed?: Record<string, string>; drift?: boolean } = {}) {
  const store = new Map(Object.entries(opts.seed ?? {}).map(([k, v]) => [k.replace(/^a26\./, "apex26."), v]));
  const gov = f1Perf<F1Gov>(["js/perf/thermal-drift.js", "js/perf/governor.js"], "PerfGov", { store, build: 1 });
  const gfx = fakeGfx(opts.mobile ?? true);
  gov.init(gfx);
  if (opts.drift != null) gov.setThermalDrift(opts.drift);
  return { gov, gfx, store };
}

function state(g: Omit<PerfGov, "init">, scale: number) {
  const d = g.thermalDrift();
  return [
    g.fpsEMA(), g.floorMs(), g.tier(), g.autoTier(), g.autoShed(), g.tierFloor(), g.userTier(), g.strikes(),
    scale, g.scaleFutile(), g.tierFutile(), g.autoRes(), g.tierHold(),
    g.openWindow().frames, g.openWindow().maxMs, g.openWindow().slow,
    d ? d.baseline : -1, d ? d.ema : -1, d ? d.due : -1, d ? d.steps : -1,
  ];
}

const jitter = (i: number): number => ((i * 7919) % 13) / 13 - 0.5;   // deterministic +-0.5

type Step = { dt: number } | { act: (g: Omit<PerfGov, "init">) => void };
type Script = (scale: () => number) => Generator<Step>;

function* frames(n: number, dt: (i: number) => number): Generator<Step> {
  for (let i = 0; i < n; i++) yield { dt: dt(i) };
}

const SCRIPTS: Record<string, { script: Script; mobile?: boolean; seed?: Record<string, string>; drift?: boolean }> = {
  "steady 60": { script: function* () { yield* frames(3000, (i) => 16.7 + 0.3 * jitter(i)); } },
  "30 fps dip then back": {
    script: function* () {
      yield* frames(600, () => 16.7);
      yield* frames(900, () => 33.3);
      yield* frames(4000, () => 16.7);
    },
  },
  "GPU-bound, scale helps, then recovery": {
    script: function* (scale) {
      yield* frames(2400, (i) => (i % 20 === 0 ? 10 : 30 * scale()));
      yield* frames(6000, () => 15);
    },
  },
  "capped 30 Hz from frame 1": { script: function* () { yield* frames(1500, () => 33.3); } },
  "slow from frame 1 (26 ms)": { script: function* () { yield* frames(2000, () => 26); } },
  "stutter bursts": {
    script: function* () {
      for (let k = 0; k < 12; k++) {
        yield* frames(200, (i) => 16.7 + 0.2 * jitter(i));
        yield* frames(k % 3 === 0 ? 1 : 5, () => 140 + k);   // a lone spike, then runs
        yield* frames(30, () => 45);
      }
    },
  },
  "below 10 fps": { script: function* (scale) { yield* frames(600, () => 140 * scale()); } },
  "heavy section once per lap": {
    script: function* () {
      let t = 0;
      for (let n = 0; n < 40000; n++) { const dt = (t % 35000) < 8000 ? 26 : 13; t += dt; yield { dt }; }
    },
  },
  "thermal drift on": {
    drift: true,
    script: function* () {
      let t = 0;
      while (t < 700000) { const s = t / 1000; const dt = 16.7 + (s < 90 ? 0 : Math.min(6, (s - 90) / 240 * 6)); t += dt; yield { dt }; }
    },
  },
  "pause stamps (zero / negative / NaN)": {
    script: function* () {
      yield* frames(300, () => 16.7);
      yield { dt: 0 }; yield { dt: -4 }; yield { dt: Number.NaN };
      yield* frames(600, () => 16.7);
    },
  },
  "user tier + pinned resolution + hold": {
    script: function* (scale) {
      yield { act: (g) => g.setUserTier(2) };
      yield* frames(400, () => 30 * scale());
      yield { act: (g) => g.setAutoRes(false) };
      yield* frames(800, () => 30);
      yield { act: (g) => g.setUserTier(0) };
      yield { act: (g) => g.setTierHold(true) };
      yield* frames(500, () => 30);
      yield { act: (g) => g.setTierHold(false) };
      yield { act: (g) => g.setAutoRes(true) };
      yield* frames(4000, () => 15);
      yield { act: (g) => g.setUserTier(4) };
      yield* frames(1500, () => 30);
      yield { act: (g) => g.setUserTier(7) };
      yield* frames(3000, () => 14);
    },
  },
  "race restarts (sentinelArm / resume / cleanRace)": {
    seed: { "a26.raceActive": "1", "a26.raceTicked": "1", "a26.crashStrikes": "1", "a26.crashStrikesBuild": "1" },
    script: function* (scale) {
      yield { act: (g) => g.sentinelArm(true) };
      yield* frames(900, () => 28 * scale());
      yield { act: (g) => g.sentinelResume() };
      yield* frames(300, () => 16.7);
      yield { act: (g) => g.cleanRace() };
      yield { act: (g) => g.sentinelArm(true) };
      yield* frames(2000, () => 33.3);
      yield { act: (g) => g.clearStrikes() };
      yield* frames(2000, () => 15);
    },
  },
  "two strikes on a phone": {
    seed: { "a26.raceActive": "1", "a26.raceTicked": "1", "a26.crashStrikes": "1", "a26.crashStrikesBuild": "1" },
    script: function* () { yield* frames(2000, () => 18); },
  },
  "desktop (no sentinel)": {
    mobile: false,
    seed: { "a26.raceActive": "1", "a26.raceTicked": "1", "a26.crashStrikes": "3", "a26.crashStrikesBuild": "1" },
    script: function* (scale) { yield* frames(3000, (i) => (i < 1500 ? 24 * scale() : 15)); },
  },
};

describe.skipIf(!hasF1Perf)("PerfGov: bit-exact against f1-game js/perf/governor.js", () => {
  for (const [name, spec] of Object.entries(SCRIPTS)) {
    it(name, () => {
      const opt = { ...(spec.mobile != null ? { mobile: spec.mobile } : {}), ...(spec.seed ? { seed: spec.seed } : {}), ...(spec.drift != null ? { drift: spec.drift } : {}) };
      const port = makeGov(opt);
      const ref = makeF1(opt);
      const a = spec.script(port.scale);
      const b = spec.script(ref.gfx.scale);
      let n = 0;
      for (;;) {
        const x = a.next(), y = b.next();
        expect(x.done).toBe(y.done);
        if (x.done || y.done) break;
        const sx = x.value, sy = y.value;
        if ("dt" in sx && "dt" in sy) {
          expect(Object.is(sx.dt, sy.dt), `frame ${n}: inputs diverged (${sx.dt} vs ${sy.dt})`).toBe(true);
          port.gov.tick(sx.dt); ref.gov.tick(sy.dt);
        } else if ("act" in sx && "act" in sy) {
          sx.act(port.gov); sy.act(ref.gov);
        }
        const p = state(port.gov, port.scale()), r = state(ref.gov, ref.gfx.scale());
        for (let i = 0; i < p.length; i++) {
          if (!Object.is(p[i], r[i])) expect.fail(`step ${n} field ${i}: port ${String(p[i])} vs f1-game ${String(r[i])}`);
        }
        n++;
      }
      expect(port.gfx.moves).toEqual(ref.gfx.moves);
      expect(JSON.stringify(port.gov.frameStats())).toBe(JSON.stringify(ref.gov.frameStats()));
      expect(port.gov.crashSeen()).toEqual({ ...ref.gov.crashSeen() });
      // The sentinel ledger, key for key (a26.* vs apex26.*).
      const ledger = (m: Map<string, string>, pre: string) => [...m].filter(([k]) => k.startsWith(pre)).map(([k, v]) => [k.slice(pre.length), v]).sort();
      expect(ledger(port.store.data, "a26.")).toEqual(ledger(ref.store, "apex26."));
    });
  }
});

describe("PerfGov behaviour (ported from f1-game perf-governor.test.mjs)", () => {
  it("a device capped at 30 fps (Low Power Mode) settles at full quality, not the floor", () => {
    const { gov, scale } = makeGov();
    feed(gov, () => 33.3, 1200);
    expect(scale()).toBe(1);
    expect(gov.tier()).toBe(0);
    expect(Math.abs(gov.floorMs() - 33.3)).toBeLessThan(0.5);
  });

  it("a healthy 60 Hz device never enters the degrade branches", () => {
    const { gov, scale } = makeGov();
    feed(gov, (i) => 15 + (i % 3), 1200);
    expect(scale()).toBe(1);
    expect(gov.tier()).toBe(0);
  });

  it("genuine GPU-bound slowness settles at a lower scale and stays there", () => {
    const { gov, scale } = makeGov();
    feed(gov, (i) => (i % 20 === 0 ? 10 : 30 * scale()), 1200);
    expect(scale()).toBeLessThan(1);
    expect(gov.tier()).toBe(0);
  });

  it("a reverted downscale does not repeat forever (the causal check actually halts)", () => {
    const { gov, scale } = makeGov();
    let minScale = 1;
    for (let i = 0; i < 200; i++) { gov.tick(33.3); minScale = Math.min(minScale, scale()); }
    expect(minScale).toBeLessThan(1);
    expect(scale()).toBe(1);
  });

  it("a device that degraded RECOVERS once the frames come good again, landing on exactly 1", () => {
    const { gov, scale } = makeGov();
    feed(gov, (i) => (i % 20 === 0 ? 10 : 30 * scale()), 1200);
    expect(scale()).toBeLessThan(1);
    feed(gov, () => 15, 6000);
    expect(scale()).toBe(1);
    expect(gov.tier()).toBe(0);
  });

  it("a device below 10 fps is SEEN by the governor, not filtered out of existence", () => {
    const { gov } = makeGov();
    feed(gov, () => 500, 60);
    expect(1000 / gov.fpsEMA()).toBeLessThan(30);
  });

  it("one huge frame is still a spike, not evidence about the device", () => {
    const { gov } = makeGov();
    feed(gov, () => 16.7, 100);
    const before = gov.fpsEMA();
    gov.tick(60000);
    expect(gov.fpsEMA()).toBe(before);
  });

  it("a run of slow frames feeds CLAMPED, so a 60 s gap can never enter as 60 000 ms", () => {
    const { gov } = makeGov();
    feed(gov, () => 60000, 3);
    expect(gov.fpsEMA()).toBeLessThanOrEqual(16.7 + (1000 - 16.7) * 0.1 + 1e-9);
  });

  it("one short or negative sample does not collapse the floor into a spurious step-down", () => {
    const { gov, scale } = makeGov();
    feed(gov, () => 16.7, 300);
    const floor = gov.floorMs();
    gov.tick(0); gov.tick(-5); gov.tick(Number.NaN);
    expect(gov.floorMs()).toBe(floor);
    feed(gov, () => 16.7, 300);
    expect(scale()).toBe(1);
  });

  it("a user tier is a FLOOR: tier() >= it, autoTier() ignores it, a bad preset is clamped", () => {
    const { gov } = makeGov();
    gov.setUserTier(2);
    expect(gov.tier()).toBe(2);
    expect(gov.autoTier()).toBe(0);
    gov.setUserTier(99);
    expect(gov.tier()).toBe(4);
    gov.setUserTier(-3);
    expect(gov.tier()).toBe(0);
  });

  // makeGovPinned / makeGovAtFloor, perf-governor.test.mjs:127-137 and :339-352.
  function pinned(at: number) {
    const gov = createPerfGov({ store: memoryRawStore(), build: "1" });
    let scale = at;
    gov.init({ isMobile: true, getRenderScale: () => scale,
      setRenderScale: (s: number) => { s = Math.max(0.5, Math.min(1, s)); if (s === scale) return false; scale = s; return true; } });
    gov.setAutoRes(false);
    return { gov, scale: () => scale };
  }
  function atFloor(): PerfGov {
    const gov = createPerfGov({ store: memoryRawStore(), build: "1" });
    gov.init({ isMobile: true, getRenderScale: () => 0.5000000000000001, setRenderScale: () => false });
    return gov;
  }
  const overloaded = (g: PerfGov) => (i: number): number => (i % 20 === 0 ? 12 : 30 - g.tier() * 4);

  it("feature tiers are shed only when they actually help, same as resolution", () => {
    const helped = atFloor();
    feed(helped, overloaded(helped), 2000);
    expect(helped.tier()).toBe(4);
  });

  it("a PINNED resolution still sheds features, and never moves the scale the user chose", () => {
    const { gov, scale } = pinned(1);
    feed(gov, overloaded(gov), 3000);
    expect(gov.tier()).toBeGreaterThan(0);
    expect(scale()).toBe(1);
    const low = pinned(0.5);
    feed(low.gov, () => 16.7, 9000);
    expect(low.scale()).toBe(0.5);
  });

  it("setTierHold(true) pins the ladder on an overloaded pinned box, and releases cleanly", () => {
    const { gov } = pinned(1);
    gov.setTierHold(true);
    expect(gov.tierHold()).toBe(true);
    feed(gov, overloaded(gov), 3000);
    expect(gov.tier()).toBe(0);
    expect(gov.autoShed()).toBe(0);
    gov.setTierHold(false);
    feed(gov, overloaded(gov), 3000);
    expect(gov.tier()).toBeGreaterThan(0);
    const held = gov.tier();
    gov.setTierHold(true);
    feed(gov, () => 12, 3000);
    expect(gov.tier()).toBe(held);
  });

  it("GRAPHICS: LOW can still shed by evidence — autoTier reaches 4", () => {
    const gov = atFloor();
    gov.setUserTier(4);
    expect(gov.autoShed()).toBe(0);
    expect(gov.autoTier()).toBe(0);
    feed(gov, () => 34 - gov.autoShed() * 6, 3000);
    expect(gov.autoShed()).toBeGreaterThanOrEqual(1);
    expect(gov.autoTier()).toBe(4);
    expect(gov.tier()).toBeLessThanOrEqual(4);
  });

  it("the opening window keeps the frames every EMA forgets", () => {
    const { gov } = makeGov();
    gov.sentinelArm(true);
    feed(gov, (i) => (i === 10 ? 400 : 16.7), 100);
    expect(gov.openWindow()).toEqual({ frames: 100, maxMs: 400, slow: 1 });
  });

  it("raw frame percentiles retain hitches and report discarded simulation time", () => {
    const { gov } = makeGov();
    feed(gov, (i) => (i === 50 ? 250 : 16), 100);
    gov.recordSimulation(3, 0.25);
    const fs = gov.frameStats();
    expect(fs.frames).toBe(100);
    expect(fs.maxMs).toBe(250);
    expect(fs.p50).toBe(16);
    expect(fs.droppedSimS).toBe(0.25);
    expect(fs.physicsSteps).toBe(3);
  });

  it("drift on takes an EXISTING rung early on a slow drift; drift off does not move a steady device", () => {
    const series = (t: number): number => 16.7 + (t < 90 ? 0 : Math.min(6, (t - 90) / 240 * 6));
    const on = makeGov({ drift: true }), off = makeGov({ drift: false });
    for (const g of [on, off]) { let t = 0; while (t < 700) { const ms = series(t); g.gov.tick(ms); t += ms / 1000; } }
    expect(on.gfx.moves.length).toBeGreaterThanOrEqual(1);
    expect(on.gfx.moves.every((s) => s >= 0.5 && s <= 1)).toBe(true);
    expect(on.gov.thermalDrift()?.steps).toBeGreaterThanOrEqual(1);
    const steady = makeGov({ drift: false });
    let i = 0, t = 0; while (t < 900) { const ms = 16.7 + 0.2 * jitter(i++); steady.gov.tick(ms); t += ms / 1000; }
    expect(steady.gfx.moves.length).toBe(0);
    expect(steady.gov.thermalDrift()).toBeNull();
  });

  it("hard-coded spot values from f1-game (GPU-bound, 1200 frames)", () => {
    const { gov, gfx } = makeGov();
    feed(gov, (i) => (i % 20 === 0 ? 10 : 30 * gfx.scale()), 1200);
    expect(gfx.moves).toEqual(SPOT.moves);
    expect(gov.fpsEMA()).toBe(SPOT.ema);
    expect(gov.floorMs()).toBe(SPOT.floor);
  });
});

// Pinned from f1-game's governor on the "GPU-bound" sequence (1200 frames).
const SPOT = { moves: [0.9, 0.8, 0.7000000000000001, 0.6000000000000001, 0.5000000000000001], ema: 14.923109300046933, floor: 13.046690220928317 };

describe("crash sentinel (ported from f1-game perf-sentinel / perf-governor)", () => {
  it("an un-ticked in-race flag is not a strike; a ticked one is, and builds reset the ledger", () => {
    const menu = makeGov({ seed: { "a26.raceActive": "1", "a26.crashStrikesBuild": "1" } });
    expect(menu.gov.strikes()).toBe(0);
    const crash = makeGov({ seed: { "a26.raceActive": "1", "a26.raceTicked": "1", "a26.crashStrikesBuild": "1" } });
    expect(crash.gov.strikes()).toBe(1);
    expect(crash.gov.tier()).toBe(2);
    expect(crash.store.data.get("a26.raceActive")).toBeUndefined();
    const deploy = makeGov({ seed: { "a26.crashStrikes": "2", "a26.crashStrikesBuild": "0" } });
    expect(deploy.gov.strikes()).toBe(0);
    expect(deploy.store.data.get("a26.crashStrikesBuild")).toBe("1");
  });

  it("two strikes floor the tier at 4 and cap the DPR at 1; a desktop never enters safe mode", () => {
    const store = memoryRawStore({ "a26.crashStrikes": "2", "a26.crashStrikesBuild": "1" });
    const gov = createPerfGov({ store, build: "1" });
    const capped: number[] = [];
    gov.init({ ...fakeGfx(true), capDpr: (n: number) => { capped.push(n); } });
    expect(gov.tier()).toBe(4);
    expect(capped).toEqual([1]);
    const desk = makeGov({ mobile: false, seed: { "a26.crashStrikes": "2", "a26.crashStrikesBuild": "1" } });
    expect(desk.gov.tier()).toBe(0);
  });

  it("cleanRace pays a strike down and moves the floor; clearStrikes lifts it now", () => {
    const { gov, store } = makeGov({ seed: { "a26.crashStrikes": "2", "a26.crashStrikesBuild": "1" } });
    expect(gov.tierFloor()).toBe(4);
    gov.cleanRace();
    expect(gov.strikes()).toBe(1);
    expect(gov.tierFloor()).toBe(2);
    expect(gov.tier()).toBe(2);
    gov.clearStrikes();
    expect(gov.tier()).toBe(0);
    expect(store.data.get("a26.crashStrikes")).toBe("0");
  });

  it("sentinelArm(true) arms a26.raceActive and the first tick stamps a26.raceTicked", () => {
    const { gov, store } = makeGov();
    gov.sentinelArm(true);
    expect(store.data.get("a26.raceActive")).toBe("1");
    expect(store.data.has("a26.raceTicked")).toBe(false);
    gov.tick(16.7);
    expect(store.data.get("a26.raceTicked")).toBe("1");
    gov.sentinelArm(false);
    expect(store.data.has("a26.raceActive")).toBe(false);
  });
});

describe("createScaleGfx (TLX setRenderScale / capDpr contract)", () => {
  it("clamps 0.5..1, refuses the 0.02 dead zone, and applies min(dpr, cap) * scale", () => {
    const applied: number[] = [];
    const g = createScaleGfx({ isMobile: true, dpr: () => 3, apply: (pr) => applied.push(pr) });
    expect(g.setRenderScale(0.99)).toBe(false);
    expect(g.setRenderScale(0.2)).toBe(true);
    expect(g.getRenderScale?.()).toBe(0.5);
    expect(applied).toEqual([1]);
    expect(g.capDpr?.(1)).toBe(true);
    expect(g.capDpr?.(1.5)).toBe(false);
    expect(g.pixelRatio()).toBe(0.5);
  });

  it("renderScaleReport is the debug perf() shape", () => {
    const { gov, gfx } = makeGov();
    const r = renderScaleReport(gov, gfx);
    expect(r).toMatchObject({ scale: 1, fps: 59.9, floorMs: 16.7, auto: true, tier: 0, crashStrikes: 0, tierHold: false });
  });
});
