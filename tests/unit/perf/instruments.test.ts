/**
 * The pure perf instruments vs f1-game: thermal-drift.js, render-rate.js,
 * loop-health.js and spans.js. Each is fed the same scripted frame-time
 * sequences in f1-game's real source (Node VM) and in the port, and every
 * returned value / state is compared with Object.is. The behavioural pins are
 * ported from f1-game tests/unit/thermal-drift.test.mjs, render-rate.test.mjs,
 * loop-health.test.mjs and perf-spans.test.mjs and run without f1-game.
 */
import { describe, expect, it } from "vitest";
import { drift, type Drift } from "../../../src/perf/thermal-drift";
import { createRenderRate, type RenderRate } from "../../../src/perf/render-rate";
import { createLoopHealth, type LoopHealth } from "../../../src/perf/loop-health";
import { createPerfSpans, type PerfSpans } from "../../../src/perf/spans";
import { memoryRawStore, setPerfLog, type PerfLog } from "../../../src/perf/env";
import { f1Perf, hasF1Perf } from "./perf-vm";

const jitter = (i: number): number => ((i * 7919) % 13) / 13 - 0.5;   // deterministic +-0.5

// ─── ThermalDrift ──────────────────────────────────────────────────────────

/** Feed `seconds` of frames whose interval is f(tSec); returns the frame at which feed first said due, or -1. */
function runDrift(d: Drift, f: (t: number) => number, seconds: number, t0 = 0) {
  let t = t0, firstDue = -1, n = 0;
  while (t < t0 + seconds) {
    const ms = f(t);
    if (d.feed(ms) && firstDue < 0) firstDue = n;
    t += ms / 1000; n++;
  }
  return { firstDue, t };
}

const DRIFT_SERIES: Record<string, (i: () => number) => (t: number) => number> = {
  steady: (i) => () => 16.7 + 0.3 * jitter(i()),
  "slow upward drift": (i) => (t) => 16.7 + 0.3 * jitter(i()) + (t < 90 ? 0 : Math.min(7.3, (t - 90) / 360 * 7.3)),
  "one hitch window": (i) => (t) => 16.7 + 0.3 * jitter(i()) + (t > 100 && t < 110 ? 9 : 0),
  "step then recover": (i) => (t) => 16.7 + 0.3 * jitter(i()) + (t < 90 ? 0 : t < 400 ? 5 : 0),
  "stutter + junk samples": (i) => (t) => { const k = i(); return k % 97 === 0 ? 0 : k % 211 === 0 ? -3 : 16.7 + (t > 200 ? 4 : 0) + (k % 50 === 0 ? 80 : 0); },
};

describe.skipIf(!hasF1Perf)("ThermalDrift: bit-exact against f1-game", () => {
  for (const [name, mk] of Object.entries(DRIFT_SERIES)) {
    it(name, () => {
      const ref = f1Perf<{ drift(): Drift }>(["js/perf/thermal-drift.js"], "ThermalDrift").drift();
      const port = drift();
      let ia = 0, ib = 0;
      const fa = mk(() => ia++), fb = mk(() => ib++);
      let t = 0, n = 0;
      while (t < 1200) {
        const ms = fa(t), ms2 = fb(t);
        expect(Object.is(ms, ms2)).toBe(true);
        const a = port.feed(ms), b = ref.feed(ms2);
        if (a !== b) expect.fail(`frame ${n}: due ${a} vs ${b}`);
        // Ack every due, as the governor would, so stepped() and the cooldown run too.
        if (a) { port.stepped(); ref.stepped(); }
        const sa = port.state(), sb = ref.state();
        for (const k of Object.keys(sa) as (keyof typeof sa)[]) {
          if (!Object.is(sa[k], sb[k])) expect.fail(`frame ${n} ${k}: ${String(sa[k])} vs ${String(sb[k])}`);
        }
        t += ms > 0 ? ms / 1000 : 0.0167; n++;
        if (n === 40000) { port.reset(); ref.reset(); }
      }
    });
  }
});

describe("ThermalDrift behaviour (f1-game thermal-drift.test.mjs)", () => {
  it("steady frames never ask for a step, however long", () => {
    const d = drift();
    let i = 0;
    const { firstDue } = runDrift(d, () => 16.7 + 0.3 * jitter(i++), 1800);
    expect(firstDue).toBe(-1);
    expect(d.state().steps).toBe(0);
    expect(d.state().baseline).toBeGreaterThan(16);
    expect(d.state().baseline).toBeLessThan(17.5);
  });

  it("a slow upward drift is flagged after the baseline minute, before any hitch", () => {
    const d = drift();
    let i = 0;
    const f = (t: number): number => 16.7 + 0.3 * jitter(i++) + (t < 90 ? 0 : Math.min(7.3, (t - 90) / 360 * 7.3));
    const { firstDue, t } = runDrift(d, f, 600);
    expect(firstDue).toBeGreaterThan(0);
    expect(d.state().ema).toBeGreaterThan(d.state().baseline * 1.12);
    expect(t).toBeGreaterThan(90);
  });

  it("a single 10 s hitch window is not drift", () => {
    const d = drift();
    let i = 0;
    expect(runDrift(d, (t) => 16.7 + 0.3 * jitter(i++) + (t > 100 && t < 110 ? 9 : 0), 600).firstDue).toBe(-1);
  });

  it("stepped() re-baselines and waits a cooldown; recovery stays quiet", () => {
    const d = drift();
    let i = 0;
    const r = runDrift(d, (t) => 16.7 + 0.3 * jitter(i++) + (t < 90 ? 0 : 5), 300);
    expect(r.firstDue).toBeGreaterThan(0);
    d.stepped();
    expect(d.state().due).toBe(false);
    expect(d.state().steps).toBe(1);
    expect(runDrift(d, () => 16.7 + 0.3 * jitter(i++), 900, r.t).firstDue).toBe(-1);
    expect(d.state().steps).toBe(1);
  });

  it("a step budget caps the detector (the ladder is finite)", () => {
    const d = drift();
    let steps = 0, t = 0;
    for (let k = 0; k < 20; k++) {
      const r = runDrift(d, (u) => 16.7 + (u - t < 90 ? 0 : 6), 400, t);
      t = r.t;
      if (r.firstDue >= 0) { d.stepped(); steps++; }
    }
    expect(steps).toBe(4);
  });
});

// ─── RenderRate ────────────────────────────────────────────────────────────

function rr(mobile: boolean, mode: string | null = null): RenderRate {
  const R = createRenderRate();
  R.init({ isMobile: mobile, store: memoryRawStore(mode == null ? {} : { "a26.renderRate": mode }) });
  return R;
}
function f1rr(mobile: boolean, mode: string | null = null): RenderRate {
  const store = new Map<string, string>(mode == null ? [] : [["apex26.renderRate", mode]]);
  const R = f1Perf<RenderRate>(["js/perf/render-rate.js"], "RenderRate", { store });
  R.init({ isMobile: mobile });
  return R;
}

/** Drive `n` rAF ticks at `ms` apart; returns { drawn, dtSum, drawnDt, msSum, drawnMs }. */
function runRR(R: RenderRate, n: number, ms: number, presenting = false) {
  const r = { ticks: n, drawn: 0, dtSum: 0, drawnDt: 0, msSum: 0, drawnMs: 0 };
  for (let i = 0; i < n; i++) {
    const dt = ms / 1000;
    R.observe(ms);
    r.dtSum += dt; r.msSum += ms;
    if (R.gate(dt, ms, presenting)) { r.drawn++; r.drawnDt += R.dt(); r.drawnMs += R.ms(); }
  }
  return r;
}

type RRStep = [ms: number, presenting: boolean, racing: boolean] | ["mode", string];
function* rrScript(): Generator<RRStep> {
  for (let i = 0; i < 300; i++) yield [1000 / 120, false, false];
  for (let i = 0; i < 200; i++) yield [1000 / 120 + jitter(i), i % 50 === 0, true];
  yield [5000, false, true];
  for (let i = 0; i < 200; i++) yield [1000 / 60, false, true];
  for (let i = 0; i < 300; i++) yield [1000 / 144, false, i > 100];
  yield ["mode", "45"];
  for (let i = 0; i < 400; i++) yield [1000 / 120, i > 350, i < 300];
  yield ["mode", "30"];
  for (let i = 0; i < 400; i++) yield [1000 / 60, false, true];
  yield ["mode", "half"];
  for (let i = 0; i < 100; i++) yield [1000 / 60, false, true];
  yield ["mode", "banana"];
  yield ["mode", "off"];
  for (let i = 0; i < 100; i++) yield [1000 / 120, false, true];
}

describe.skipIf(!hasF1Perf)("RenderRate: bit-exact against f1-game", () => {
  for (const [mobile, mode] of [[true, null], [false, null], [true, "half"], [true, "45"], [false, "30"], [true, "off"]] as const) {
    it(`mobile=${mobile} mode=${mode ?? "unset"}`, () => {
      const a = rr(mobile, mode), b = f1rr(mobile, mode);
      let n = 0;
      for (const s of rrScript()) {
        if (s[0] === "mode") { expect(a.setMode(s[1])).toBe(b.setMode(s[1])); continue; }
        const [ms, presenting, racing] = s;
        a.observe(ms); b.observe(ms);
        const ga = a.gate(ms / 1000, ms, presenting, racing), gb = b.gate(ms / 1000, ms, presenting, racing);
        if (ga !== gb || !Object.is(a.dt(), b.dt()) || !Object.is(a.ms(), b.ms())) expect.fail(`tick ${n}: ${ga}/${a.dt()}/${a.ms()} vs ${gb}/${b.dt()}/${b.ms()}`);
        n++;
      }
      expect(a.state()).toEqual({ ...b.state() });
    });
  }
});

describe("RenderRate behaviour (f1-game render-rate.test.mjs)", () => {
  it("a desktop draws every frame even at 144 Hz", () => {
    const R = rr(false);
    const r = runRR(R, 600, 1000 / 144);
    expect(r.drawn).toBe(r.ticks);
    expect(R.active()).toBe(false);
  });

  it("a phone at 60 Hz, 90 Hz or 30 Hz draws every frame", () => {
    for (const ms of [1000 / 60, 1000 / 90, 1000 / 30]) {
      const R = rr(true);
      const r = runRR(R, 600, ms);
      expect(r.drawn).toBe(r.ticks);
      expect(R.active()).toBe(false);
    }
  });

  it("a phone at 120 Hz trips after a sustained fast cadence, then draws every second rAF", () => {
    const R = rr(true);
    runRR(R, 60, 1000 / 120);
    expect(R.active()).toBe(false);
    runRR(R, 60, 1000 / 120);
    expect(R.active()).toBe(true);
    expect(runRR(R, 240, 1000 / 120).drawn).toBe(120);
  });

  it("no time is lost: the skipped frame's dt and ms are paid into the next drawn frame", () => {
    const R = rr(true);
    runRR(R, 200, 1000 / 120);
    const r = runRR(R, 240, 1000 / 120);
    expect(Math.abs(r.drawnDt - r.dtSum)).toBeLessThan(1e-9);
    expect(Math.abs(r.drawnMs - r.msSum)).toBeLessThan(1e-9);
  });

  it("it leaves when the cadence slows; a stall is not a cadence sample", () => {
    const R = rr(true);
    runRR(R, 200, 1000 / 120);
    runRR(R, 1, 1000 / 120);
    const r = runRR(R, 120, 1000 / 60);
    expect(R.active()).toBe(false);
    expect(r.drawnDt).toBeGreaterThanOrEqual(r.dtSum - 1e-9);
    const S = rr(true);
    runRR(S, 60, 1000 / 120);
    S.observe(5000);
    expect(S.state().emaMs).toBeLessThan(11);
  });

  it("an immersive session is never gated", () => {
    const R = rr(true);
    runRR(R, 200, 1000 / 120);
    const r = runRR(R, 100, 1000 / 120, true);
    expect(r.drawn).toBe(r.ticks);
  });

  it("a26.renderRate overrides the device class", () => {
    const off = rr(true, "off");
    runRR(off, 400, 1000 / 120);
    expect(off.active()).toBe(false);
    expect(runRR(rr(false, "half"), 100, 1000 / 60).drawn).toBe(50);
    expect(rr(false, "banana").state().mode).toBe("auto");
  });

  it("tier: draws per 60 physics ticks are exactly 60 / 45 / 30, and the dt clamp holds", () => {
    const drawsPer = (R: RenderRate, dt: number, n: number, racing = true) => {
      let d = 0, max = 0;
      for (let i = 0; i < n; i++) if (R.gate(dt, dt * 1000, false, racing)) { d++; max = Math.max(max, R.dt()); }
      return { d, max };
    };
    for (const [mode, want] of [["off", 60], ["45", 45], ["30", 30]] as const) {
      const R = rr(true, mode);
      drawsPer(R, 1 / 60, 90);
      const { d, max } = drawsPer(R, 1 / 60, 60);
      expect(d).toBe(want);
      expect(max).toBeLessThanOrEqual(1 / 20 + 1e-9);
    }
    const R = rr(true, "45");
    drawsPer(R, 1 / 120, 90);
    expect(Math.abs(drawsPer(R, 1 / 120, 1200).d - 450)).toBeLessThanOrEqual(1);
    expect(drawsPer(rr(true, "30"), 1 / 60, 200, false).d).toBe(200);
  });

  it("setMode switches at run time and refuses an unknown mode", () => {
    const R = rr(true, "");
    expect(R.setMode("45")).toBe(true);
    expect(R.state().tier).toBe(45);
    expect(R.setMode("25")).toBe(false);
    expect(R.setMode("auto")).toBe(true);
    expect(R.state().tier).toBe(60);
  });
});

// ─── LoopHealth ────────────────────────────────────────────────────────────

function quietLog(errors: string[] = []): () => void {
  const prev = setPerfLog({ info: () => {}, warn: () => {}, error: (_ns, msg) => { errors.push(msg); } } satisfies PerfLog);
  return () => { setPerfLog(prev); };
}

describe.skipIf(!hasF1Perf)("LoopHealth: bit-exact against f1-game", () => {
  it("a scripted fault / clean / quiet sequence", () => {
    const restore = quietLog();
    try {
      const clock = { t: 1000 };
      const a = createLoopHealth(() => clock.t);
      const b = f1Perf<LoopHealth>(["js/perf/loop-health.js"], "LoopHealth", { now: () => clock.t });
      const script: (string | number)[] = [];
      for (let i = 0; i < 400; i++) script.push(i % 7 === 0 ? "f" : "c", 16);
      script.push(5000, "c");
      for (let i = 0; i < 300; i++) script.push("f", "c", 3);
      for (let i = 0; i < 10; i++) script.push("f");
      script.push(9000, "c");
      for (const s of script) {
        if (typeof s === "number") { clock.t += s; continue; }
        if (s === "f") expect(a.fault(new Error("x"))).toBe(b.fault(new Error("x")));
        else { a.clean(); b.clean(); }
        expect(a.state()).toEqual({ ...b.state() });
      }
    } finally { restore(); }
  });
});

describe("LoopHealth behaviour (f1-game loop-health.test.mjs)", () => {
  it("state() exposes the shipped caps and a null heartbeat before any clean frame", () => {
    const s = createLoopHealth(() => 0).state();
    expect(s).toMatchObject({ cap: 8, totalCap: 240, frames: 0, faults: 0, run: 0, stopped: false, staleMs: null });
  });

  it("RUN_CAP: seven consecutive faults survive; the eighth stops the loop", () => {
    const errors: string[] = [];
    const restore = quietLog(errors);
    try {
      const L = createLoopHealth(() => 0);
      for (let i = 1; i <= 7; i++) expect(L.fault(new Error(`f${i}`))).toBe(true);
      expect(L.fault(new Error("f8"))).toBe(false);
      expect(L.state()).toMatchObject({ run: 8, faults: 8, stopped: true, lastFault: "f8" });
      expect(errors.at(-1)).toMatch(/CAP REACHED/);
    } finally { restore(); }
  });

  it("TOTAL_CAP: alternating clean/fault still stops at 240 total faults", () => {
    const restore = quietLog();
    try {
      const L = createLoopHealth(() => 0);
      for (let i = 1; i <= 239; i++) { expect(L.fault(new Error("t"))).toBe(true); L.clean(); }
      expect(L.fault(new Error("t240"))).toBe(false);
      expect(L.state().stopped).toBe(true);
    } finally { restore(); }
  });

  it("a quiet stretch longer than QUIET_RESET_MS forgets the tally; a stopped loop does not", () => {
    const restore = quietLog();
    try {
      const clock = { t: 1000 };
      const L = createLoopHealth(() => clock.t);
      for (let i = 0; i < 10; i++) { L.fault(new Error("heal")); L.clean(); }
      expect(L.state().faults).toBe(10);
      clock.t = 1000 + 4000 + 1;
      L.clean();
      expect(L.state().faults).toBe(0);
      const S = createLoopHealth(() => clock.t);
      for (let i = 0; i < 8; i++) S.fault(new Error("fatal"));
      clock.t += 10_000;
      S.clean();
      expect(S.state().faults).toBe(8);
      expect(S.state().stopped).toBe(true);
    } finally { restore(); }
  });
});

// ─── PerfSpans ─────────────────────────────────────────────────────────────

function fakeSpans(make: (clock: () => number) => PerfSpans) {
  let t = 0;
  return { ps: make(() => t), tick: (d: number) => { t += d; } };
}

describe.skipIf(!hasF1Perf)("PerfSpans: bit-exact against f1-game", () => {
  it("nested spans over a wrapped ring report identical stats", () => {
    const f1 = f1Perf<PerfSpans>(["js/perf/spans.js"], "PerfSpans");
    const a = fakeSpans((c) => createPerfSpans(c)), b = fakeSpans((c) => f1.create(c));
    for (const { ps } of [a, b]) ps.on(true);
    for (let i = 0; i < 700; i++) {
      for (const { ps, tick } of [a, b]) {
        ps.begin("frame"); tick(0.1 + jitter(i) * 0.05);
        ps.begin("physics"); tick(1.3 + (i % 17) * 0.11);
        ps.begin("ai"); tick(0.7 + (i % 5) * 0.013); ps.end("ai");
        ps.end("physics"); ps.end("ghost");
        ps.begin("render"); tick(i % 97 === 0 ? 40 : 6 + jitter(i)); ps.end("render");
        ps.end("frame");
      }
    }
    expect(a.ps.stats()).toEqual(JSON.parse(JSON.stringify(b.ps.stats())));
    expect(a.ps.report().loaf).toEqual({ ...b.ps.report().loaf, entries: [] });
  });
});

describe("PerfSpans behaviour (f1-game perf-spans.test.mjs)", () => {
  it("off by default: begin/end record nothing", () => {
    const { ps, tick } = fakeSpans((c) => createPerfSpans(c));
    ps.begin("a"); tick(5); ps.end("a");
    expect(ps.isOn()).toBe(false);
    expect(Object.keys(ps.stats())).toHaveLength(0);
  });

  it("on: durations land in p50/p95/p99/max", () => {
    const { ps, tick } = fakeSpans((c) => createPerfSpans(c));
    ps.on(true);
    for (let i = 1; i <= 100; i++) { ps.begin("physics"); tick(i); ps.end("physics"); }
    expect(ps.stats()["physics"]).toEqual({ n: 100, window: 100, p50: 50, p95: 95, p99: 99, max: 100, mean: 50.5 });
  });

  it("nested spans are independent; end without begin is ignored", () => {
    const { ps, tick } = fakeSpans((c) => createPerfSpans(c));
    ps.on(true);
    ps.end("ghost");
    ps.begin("outer"); tick(2); ps.begin("inner"); tick(3); ps.end("inner"); tick(1); ps.end("outer");
    const s = ps.stats();
    expect(s["inner"]?.p50).toBe(3);
    expect(s["outer"]?.p50).toBe(6);
    expect(s["ghost"]).toBeUndefined();
  });

  it("ring wraps: window caps at 512 while n keeps counting; reset clears; LoAF is feature-detected", () => {
    const { ps, tick } = fakeSpans((c) => createPerfSpans(c));
    ps.on(true);
    for (let i = 0; i < 600; i++) { ps.begin("x"); tick(1); ps.end("x"); }
    expect(ps.stats()["x"]).toMatchObject({ n: 600, window: 512 });
    expect(() => JSON.stringify(ps.report())).not.toThrow();
    expect(ps.loaf().supported).toBe(false);
    ps.reset();
    expect(Object.keys(ps.stats())).toHaveLength(0);
  });
});
