// @vitest-environment happy-dom
/**
 * The DOM-facing perf modules under happy-dom: the GRAPHICS preset control
 * (quality-preset), the METRICS overlay, the gfx-debug overlay, the phone
 * recorder panel and the three.js Inspector toggle. The overlay's painted text
 * is compared line for line with f1-game's GameMetrics run in a Node VM over
 * the same sources (all four pages, narrow and wide). Behavioural pins are
 * ported from f1-game tests/unit/metrics.test.mjs, perf-governor.test.mjs
 * (presets), gfx-debug-overlay.test.mjs, phone-recorder.test.mjs and
 * three-inspector.test.mjs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryRawStore, setPerfLog } from "../../../src/perf/env";
import { createGfxQuality, mount as mountQuality } from "../../../src/perf/quality-preset";
import { createGameMetrics, mount as mountMetrics, type MetricsLog, type MetricsSources } from "../../../src/perf/metrics-overlay";
import { createGfxDebug, loopStatus } from "../../../src/perf/gfx-debug-overlay";
import { create as createRecorder, fileName, HOWTO, mount as mountRecorder, numericLeaves, type RecorderEnv, share, copy } from "../../../src/perf/phone-recorder";
import { createThreeInspector } from "../../../src/perf/three-inspector";
import { f1Perf, hasF1Perf } from "./perf-vm";

setPerfLog({ info: () => {}, warn: () => {}, error: () => {} });
afterEach(() => { document.body.replaceChildren(); });

// ─── GRAPHICS presets ──────────────────────────────────────────────────────

describe("GfxQuality (f1-game quality-preset.js)", () => {
  it("a fresh phone defaults to MEDIUM while legacy HIGH remains ULTRA; desktop stays HIGH", () => {
    const store = memoryRawStore();
    const q = createGfxQuality({ store });
    expect(q.defaultId(true)).toBe("medium");
    store.rawSet("a26.gfxHigh", "1");
    expect(q.defaultId(true)).toBe("ultra");
    store.rawDel("a26.gfxHigh");
    expect(q.defaultId(false)).toBe("high");
  });

  it("init() reconciles the boot tier with the resolved preset, and is stable for ULTRA", () => {
    const store = memoryRawStore({ "a26.gfxPreset": "medium", "a26.gfxHigh": "1" });
    createGfxQuality({ store, isMobile: true }).init();
    expect(store.data.get("a26.gfxHigh")).toBe("0");
    const legacy = memoryRawStore({ "a26.gfxHigh": "1" });
    createGfxQuality({ store: legacy, isMobile: true }).init();
    expect(legacy.data.get("a26.gfxHigh")).toBe("1");
  });

  it("the preset is a tier FLOOR on the governor, applied live", () => {
    const tiers: number[] = [];
    const q = createGfxQuality({ store: memoryRawStore(), gov: { setUserTier: (n) => tiers.push(n), sentinelArm: () => {} } });
    q.init();
    expect(q.current()).toBe("high");
    q.set("low", { noReload: true });
    q.set("medium", { noReload: true });
    expect(tiers).toEqual([0, 4, 2]);
    expect(q.set("nope")).toBe(false);
  });

  it("the button cycles LOW → MEDIUM → HIGH → ULTRA; crossing ULTRA reloads on desktop (out of a race)", () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      const armed: boolean[] = [];
      const btn = document.createElement("button");
      btn.id = "pm-gfx"; btn.hidden = true;
      document.body.appendChild(btn);
      const q = mountQuality(btn, { store: memoryRawStore({ "a26.gfxPreset": "high" }), reload, inRace: () => false,
        gov: { setUserTier: () => {}, sentinelArm: (on) => armed.push(on) } });
      expect(btn.hidden).toBe(false);
      expect(btn.textContent).toBe("GRAPHICS: HIGH");
      btn.click();
      expect(q.current()).toBe("ultra");
      expect(btn.textContent).toBe("GRAPHICS: ULTRA — RELOADING…");
      vi.advanceTimersByTime(300);
      expect(reload).toHaveBeenCalledOnce();
      expect(armed).toEqual([false]);
      const inRace = mountQuality(document.createElement("button"), { store: memoryRawStore({ "a26.gfxPreset": "high" }), reload, inRace: () => true });
      inRace.set("ultra");
      vi.advanceTimersByTime(300);
      expect(reload).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

// ─── METRICS overlay ───────────────────────────────────────────────────────

/** A tiny f1-game js/core/log.js stand-in: levels, a ring and filters. */
function fakeLog(): MetricsLog & { push(level: string, ns: string, msg: string): void } {
  const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
  let buffer = "info";
  const bufferNs: Record<string, string> = {};
  const recs: { level: string; ns: string; msg: string }[] = [];
  return {
    LEVELS, DEBUG: 3,
    level(spec?: string) {
      if (spec) {
        const parts = spec.split(":");
        if (parts.length === 2) buffer = parts[1] as string;
        else if (parts.length === 3) bufferNs[parts[1] as string] = parts[2] as string;
      }
      return { console: "warn", buffer, bufferNs: { ...bufferNs } };
    },
    records(f) {
      let r = recs.slice();
      if (f?.ns) r = r.filter((x) => x.ns === f.ns);
      if (f?.level) r = r.filter((x) => (LEVELS[x.level] ?? 0) <= (LEVELS[f.level as string] ?? 0));
      if (f?.limit) r = r.slice(-f.limit);
      return r;
    },
    push(level, ns, msg) { recs.push({ level, ns, msg }); },
  };
}

function metrics(opts: { store?: Record<string, string>; search?: string; sources?: MetricsSources; log?: MetricsLog } = {}) {
  const store = memoryRawStore(opts.store ?? {});
  const host = document.createElement("div");
  document.body.appendChild(host);
  const M = createGameMetrics({ store, search: () => opts.search ?? "", panelHost: host, sources: opts.sources ?? {}, log: opts.log ?? null });
  return { M, store, host };
}

describe("GameMetrics (f1-game metrics.test.mjs)", () => {
  it("METRICS defaults off and persists on toggle; ?metrics=1 overrides for the session", () => {
    const { M, store } = metrics();
    expect(M.on()).toBe(false);
    expect(M.KEY).toBe("a26.metrics");
    expect(M.set(true)).toBe(true);
    expect(store.data.get("a26.metrics")).toBe("1");
    expect(M.toggle()).toBe(false);
    expect(store.data.get("a26.metrics")).toBe("0");
    const url = metrics({ store: { "a26.metrics": "0" }, search: "?metrics=1" });
    expect(url.M.on()).toBe(true);
    url.M.set(false);
    expect(url.store.data.get("a26.metrics")).toBe("0");
  });

  it("snapshot() is a plain object and never throws without sources", () => {
    const s = metrics().M.snapshot();
    expect(s.on).toBe(false);
    expect(Array.isArray(s.logs)).toBe(true);
    expect(s.loopStopped).toBeNull();
  });

  it("turning metrics on raises the log buffer and keeps per-namespace overrides", () => {
    const log = fakeLog();
    log.level("buffer:scenery:trace");
    const { M } = metrics({ log });
    M.set(true);
    expect(log.level().buffer).toBe("debug");
    expect(log.level().console).toBe("warn");
    expect(log.level().bufferNs?.["scenery"]).toBe("trace");
    M.set(false);
    expect(log.level().buffer).toBe("info");
  });

  it("snapshot keeps frame EMA off the governor budget", () => {
    const store = memoryRawStore();
    const M = createGameMetrics({ store, search: () => "", gov: { fpsEMA: () => 16.7, floorMs: () => 22.2, tier: () => 2, frameStats: () => ({ frames: 0, p50: 0, p95: 0, p99: 0, maxMs: 0, droppedSimS: 0, physicsSteps: 0, windowFrames: 2048 }), resetFrameStats: () => {} } });
    const s = M.snapshot();
    expect([s.ms, s.budget, s.fps, s.tier]).toEqual([16.7, 22.2, 59.9, 2]);
  });

  it("SIDE / SIZE / PAGE persist; URL forms are session-only; AUTO docks left on a short viewport", () => {
    const { M, store } = metrics();
    expect(M.POSITIONS.join(",")).toBe("auto,left,right");
    expect(M.setPos("left")).toBe("left");
    expect(store.data.get("a26.metricsPos")).toBe("left");
    expect(M.nextPos(1)).toBe("right");
    expect(M.size()).toBe("s");
    expect(M.setSize("m")).toBe("m");
    expect(M.nextSize(1)).toBe("l");
    expect(M.nextSize(1)).toBe("s");
    expect(M.page()).toBe("gov");
    expect(M.setPage("phys")).toBe("phys");
    expect(M.nextPage(1)).toBe("log");
    expect(M.nextPage(1)).toBe("gov");
    const pinned = metrics({ store: { "a26.metricsPage": "car" }, search: "?metricsPage=log" });
    expect(pinned.M.page()).toBe("log");
    pinned.M.setPage("gov");
    expect(pinned.store.data.get("a26.metricsPage")).toBe("car");
    const auto = metrics();
    window.innerHeight = 393; window.innerWidth = 852;
    expect(auto.M.resolvePos()).toBe("left");
    window.innerHeight = 900; window.innerWidth = 1280;
    expect(metrics().M.resolvePos()).toBe("right");
  });

  it("a painted HUD 0 does not wipe probe ground speed; GOV skips probe() and physState()", () => {
    let probe = 0, phys = 0;
    const { M } = metrics({ sources: { dashKph: () => 0, probe: () => { probe++; return { speed: 60, s: 10, x: 0 }; }, physState: () => { phys++; return { slipDeg: 1 }; } } });
    M.snapshot();
    expect([probe, phys]).toEqual([0, 0]);
    M.setPage("car");
    const s = M.snapshot();
    expect([s.dashKph, s.speedKph, s.speedIsDash, s.gndKph]).toEqual([0, 0, true, 216]);
    M.setPage("phys");
    expect(M.snapshot().slipDeg).toBe(1);
  });

  it("log page filters the tail by namespace and level", () => {
    const log = fakeLog();
    log.push("info", "car", "livery ferrari");
    log.push("warn", "scenery", "backdrop SUPPRESSED");
    log.push("info", "track", "build done monza total=1 n=1 night=false");
    const { M } = metrics({ log });
    M.setPage("log"); M.setLogNs("*"); M.setLogLvl("warn");
    const warn = M.snapshot();
    expect(warn.logs.some((l) => l.startsWith("w scenery"))).toBe(true);
    expect(warn.logs.some((l) => l.includes("livery"))).toBe(false);
    M.setLogNs("track"); M.setLogLvl("info");
    expect(M.snapshot().logs).toEqual(["i track build done monza total=1 n=1 night=false"]);
  });

  it("GOV reports an explicit stopped loop and frame progress", () => {
    let stopped = false, frames = 12;
    const M = createGameMetrics({ store: memoryRawStore(), search: () => "", loop: { state: () => ({ stopped, frames, faults: 0, run: 0, cap: 8, totalCap: 240, lastFault: "", staleMs: null }) } });
    expect([M.snapshot().loopStopped, M.snapshot().loopFrames]).toEqual([false, 12]);
    stopped = true; frames = 13;
    expect([M.snapshot().loopStopped, M.snapshot().loopFrames]).toEqual([true, 13]);
  });

  it("mount() builds the METRICS fold with six rows, keys toggle the panel, LOG rows hide off LOG", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = memoryRawStore();
    const M = mountMetrics(host, { store, search: () => "" });
    const ids = [...host.querySelectorAll("#pm-metrics-details button")].map((b) => b.id);
    expect(ids).toEqual(["pm-metrics", "pm-metrics-page", "pm-metrics-pos", "pm-metrics-size", "pm-metrics-logns", "pm-metrics-loglvl"]);
    expect(host.querySelector("summary")?.textContent).toBe("METRICS · OFF");
    expect((host.querySelector("#pm-metrics-logns") as HTMLElement).hidden).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F9" }));
    expect(M.on()).toBe(true);
    const panel = document.getElementById("game-metrics");
    expect(panel?.hidden).toBe(false);
    expect(host.querySelector("summary")?.textContent).toBe("METRICS · ON · GOV");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "4" }));
    expect(M.page()).toBe("log");
    expect((host.querySelector("#pm-metrics-logns") as HTMLElement).hidden).toBe(false);
    (host.querySelector("#pm-metrics-page") as HTMLButtonElement).click();
    expect(M.page()).toBe("gov");
    (panel?.querySelector('[data-page="phys"]') as HTMLButtonElement).click();
    expect(M.page()).toBe("phys");
    M.unmount();
    expect(document.getElementById("game-metrics")).toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F9" }));
    expect(M.on()).toBe(true);
  });

  it("frametimeBench reads the governor's frame stats", () => {
    const M = createGameMetrics({ store: memoryRawStore(), gov: { fpsEMA: () => 16, floorMs: () => 16, tier: () => 0, resetFrameStats: () => {}, frameStats: () => ({ frames: 9, p50: 16.6666, p95: 20, p99: 30, maxMs: 41.23456, droppedSimS: 0, physicsSteps: 0, windowFrames: 2048 }) } });
    M.frametimeBenchReset();
    expect(M.frametimeBenchSnapshot()).toMatchObject({ p50: 16.667, p95: 20, p99: 30, max: 41.235, frames: 9, longTasks: 0 });
  });
});

// The same world, as f1-game's globals and as the port's sources.
const WORLD = {
  perf: { fps: 58.2, floorMs: 16.9, scale: 0.9, tier: 1, auto: true, crashStrikes: 1, tierFloor: 0 },
  info: { state: "race", track: "monza", flow: "race", lapsTarget: 5, raceQuali: true, career: false },
  timing: { lap: 2, pos: 3, total: 20, gear: 7, energy: 0.6543, lapTime: 61.2345, best: 80.5, lastLap: 81.0004, gapAhead: 1.23, gapBehind: 0.4, aeroX: 0.25, sector: 2 },
  probe: { speed: 70.1, s: 1234.56, x: -1.234, angle: 0.01, k: 0.00123, hw: 7 },
  phys: { slipDeg: 2.345, vLat: 0.41, yawRate: 0.12, slipFactor: 0.93, axEstSm: -3.2, axFrac: 0.4, slope: 0.012, wrongWay: false, rescueT: 0,
    head: 1.57, vmaxNow: 92.3, aeroGrip: 1.234, aeroDf: 0.8, xOn: true, xArmed: false, aeroLoad: 0.7, towing: 0.3, xVmaxGain: 0.012,
    xDfLoss: 0.08, drain: 0.234, regen: 0.105, brakeBias: 0.56, otTime: 3.6, otMJ: 0.42 },
  loop: { stopped: false, frames: 1234 },
  gpuMs: 4.567,
};

function f1MetricsText(page: string, size: string): string {
  type El = { id: string; textContent: string; dataset: Record<string, string>; style: Record<string, string>; children: El[]; hidden: boolean;
    appendChild(c: El): El; setAttribute(): void; addEventListener(): void };
  const made: El[] = [];
  const mk = (): El => {
    const el: El = { id: "", textContent: "", dataset: {}, style: {}, children: [], hidden: false,
      appendChild(c) { this.children.push(c); return c; }, setAttribute() {}, addEventListener() {} };
    made.push(el); return el;
  };
  const store = new Map<string, string>([["apex26.metricsPage", page], ["apex26.metricsSize", size], ["apex26.gfxBackend", "three"]]);
  const M = f1Perf<{ set(v: boolean): boolean }>(["js/perf/metrics-overlay.js"], "GameMetrics", {
    store,
    extra: {
      location: { search: "" },
      document: { readyState: "complete", body: mk(), documentElement: { style: { getPropertyValue: () => "" } },
        addEventListener() {}, getElementById: () => null, createElement: mk },
      window: { innerWidth: 1280, innerHeight: 900, addEventListener() {} },
      LoopHealth: { state: () => WORLD.loop },
      PerfGov: { fpsEMA: () => 17.2, floorMs: () => 16.9, tier: () => 1 },
      GLX: { gpuErrors: () => 2, backendState: () => ({ api: "auto", gpuFirstError: "pipeline: bad layout", gpuErrors: 2 }) },
      RendererPicker: { liveBackend: () => "WebGPU" },
      __apex: {
        perf: () => WORLD.perf, info: () => WORLD.info, timing: () => WORLD.timing, probe: () => WORLD.probe,
        physState: () => WORLD.phys, camera: () => ({ mode: "chase" }), caution: () => ({ label: "VSC" }),
        gpuTimer: () => ({ ms: WORLD.gpuMs }),
      },
    },
  });
  M.set(true);
  const body = made.find((e) => e.id === "game-metrics-body");
  return body ? body.textContent : "(no body)";
}

describe.skipIf(!hasF1Perf)("GameMetrics: painted text matches f1-game line for line", () => {
  for (const page of ["gov", "car", "phys", "log"]) {
    for (const size of ["s", "l"]) {
      it(`${page} / ${size === "s" ? "narrow" : "wide"}`, () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const M = createGameMetrics({
          store: memoryRawStore({ "a26.metricsPage": page, "a26.metricsSize": size }),
          search: () => "", panelHost: host,
          loop: { state: () => ({ ...WORLD.loop, faults: 0, run: 0, cap: 8, totalCap: 240, lastFault: "", staleMs: 1 }) },
          gov: { fpsEMA: () => 17.2, floorMs: () => 16.9, tier: () => 1, frameStats: () => ({ frames: 0, p50: 0, p95: 0, p99: 0, maxMs: 0, droppedSimS: 0, physicsSteps: 0, windowFrames: 2048 }), resetFrameStats: () => {} },
          sources: {
            perf: () => WORLD.perf, info: () => WORLD.info, timing: () => WORLD.timing, probe: () => WORLD.probe,
            physState: () => WORLD.phys, camera: () => ({ mode: "chase" }), caution: () => ({ label: "VSC" }),
            gpuTimer: () => ({ ms: WORLD.gpuMs }),
            backend: () => ({ name: "WebGPU", reason: "auto" }),
            gpuErrors: () => ({ count: 2, first: "pipeline: bad layout" }),
          },
        });
        M.set(true);
        const port = document.getElementById("game-metrics-body")?.textContent;
        expect(port).toBe(f1MetricsText(page, size));
      });
    }
  }
});

// ─── gfx-debug ─────────────────────────────────────────────────────────────

describe("GfxDebug (f1-game gfx-debug-overlay.test.mjs)", () => {
  it("is opt-in: ?gfxdebug=1 or a26.gfxDebug=1, silent otherwise", () => {
    expect(createGfxDebug({ store: memoryRawStore(), search: () => "" }).wanted()).toBe(false);
    expect(createGfxDebug({ store: memoryRawStore(), search: () => "?a=1&gfxdebug=1" }).wanted()).toBe(true);
    expect(createGfxDebug({ store: memoryRawStore({ "a26.gfxDebug": "1" }), search: () => "" }).wanted()).toBe(true);
  });

  it("reports backend, gpu errors, the mem line and the loop heartbeat, and guards every hook", () => {
    let frames = 10;
    const g = createGfxDebug({
      build: () => "e1234",
      backend: () => ({ name: "WebGL2", reason: "webkit" }),
      gpuErrors: () => ({ count: 1, first: "bad\n  pipeline" }),
      rendererMemory: () => ({ geometries: 12, textures: 3 }),
      gov: { tier: () => 2, strikes: () => 1 },
      loop: { state: () => ({ frames, faults: 0, run: 0, cap: 8, totalCap: 240, stopped: false, lastFault: "", staleMs: 5 }) },
      info: () => { throw new Error("pre-race"); },
      extraLines: () => ["post on=true"],
    });
    const t = g.text();
    expect(t).toContain("APEX 26 GFX  build e1234");
    expect(t).toContain("backend=WebGL2  reason=webkit");
    expect(t).toContain("gpuErrors=1\n  first: bad pipeline");
    expect(t).toContain("post on=true");
    expect(t).toMatch(/mem heap=\S+ geo=12 tex=3 tier=2 crashStrikes=1/);
    expect(t).toContain("loop: +10 frames/0ms");
    frames = 10;
    expect(createGfxDebug({}).text()).toContain("renderer: not booted");
  });

  it("the heartbeat is relative: a count that does not move between paints is a stall", () => {
    const h = { frames: 5, faults: 0, run: 0, cap: 8, totalCap: 240, stopped: false, lastFault: "", staleMs: 9 };
    expect(loopStatus(h, 0, 500)).toBe("NO FRAME in the last 500ms");
    expect(loopStatus({ ...h, frames: 0 }, 0, 0)).toBe("NO FRAME COMPLETED YET");
    expect(loopStatus({ ...h, stopped: true }, 3, 500)).toBe("STOPPED at the fault cap");
  });

  it("install paints into the host and stop removes it", () => {
    const g = createGfxDebug({ host: document.body });
    g.install();
    expect(document.getElementById("gfx-debug")?.textContent).toContain("COPY");
    g.stop();
    expect(document.getElementById("gfx-debug")).toBeNull();
  });
});

// ─── PhoneRecorder ─────────────────────────────────────────────────────────

function fakeEnv() {
  const e = { t: 1000, facts: 0, samples: 0, saved: [] as string[], env: null as unknown as RecorderEnv };
  e.env = {
    now: () => e.t, wall: () => Date.UTC(2026, 9, 17, 10, 30, 0) + e.t,
    facts: () => { e.facts++; return { ua: "test", dpr: 3 }; },
    sample: () => { e.samples++; return { frame: { p50: 16.7, p95: 20, p99: 30 }, renderScale: 1, tier: 0 }; },
    save: (txt) => { e.saved.push(txt); }, load: () => e.saved[e.saved.length - 1] ?? null,
  };
  return e;
}

describe("PhoneRecorder (f1-game phone-recorder.test.mjs)", () => {
  it("nothing runs until start(); facts once; samples on 2048 frames and the 2 min timer", () => {
    const f = fakeEnv();
    const r = createRecorder(f.env);
    r.frame(1000);
    expect(r.isOn()).toBe(false);
    expect(r.serialize()).toBe("");
    expect(r.start()).toBe(true);
    expect(r.start()).toBe(false);
    let t = f.t;
    for (let i = 0; i < 2048; i++) { t += 16.7; f.t = t; r.frame(t); }
    const rec = r.record();
    expect(rec?.samples.map((s) => s["trigger"])).toEqual(["start", "window"]);
    expect(rec?.cadence?.frames).toBe(120);
    expect(rec?.cadence?.hz).toBeGreaterThan(59);
    f.t += 120000; r.frame(f.t);
    expect(rec?.samples.at(-1)?.["trigger"]).toBe("timer");
    expect(f.facts).toBe(1);
    r.stop();
    expect(rec?.samples.at(-1)?.["trigger"]).toBe("stop");
    expect(rec?.durationMin).toBeGreaterThan(1.9);
  });

  it("serialize is valid JSON, mirrored after each sample, re-adoptable; a long soak is capped", () => {
    const f = fakeEnv();
    const r = createRecorder(f.env);
    r.start(); f.t += 60000; r.stop();
    const o = JSON.parse(r.serialize()) as { schema: string; samples: { min: number }[] };
    expect(o.schema).toBe("a26.phone-soak/1");
    expect(o.samples[1]?.min).toBe(1);
    expect(f.saved).toHaveLength(3);
    const r2 = createRecorder(f.env);
    expect(r2.adopt(f.saved[2] as string)).toBe(true);
    expect(r2.count()).toBe(2);
    expect(r2.adopt("{not json")).toBe(false);
    const big = createRecorder(fakeEnv().env);
    big.start();
    for (let i = 0; i < 620; i++) big.sample("timer");
    expect(big.record()?.samples).toHaveLength(600);
    expect(big.record()?.truncated).toBe(true);
  });

  it("quick mode stops itself at 30 s; numericLeaves flattens one level; the file name carries the stamp", () => {
    const f = fakeEnv();
    const r = createRecorder(f.env);
    r.start({ quick: true });
    for (let i = 0; i < 2000; i++) { f.t += 16.7; r.frame(f.t); }
    expect(r.isOn()).toBe(false);
    expect(r.record()?.samples.map((s) => s["trigger"])).toEqual(["start", "stop"]);
    expect(numericLeaves({ a: 1.234, b: "x", c: true, d: { e: 2, f: "y", g: { h: 3 } }, i: Number.NaN })).toEqual({ a: 1.23, c: true, "d.e": 2 });
    expect(fileName({ startedAt: "2026-10-17T10:30:00.000Z" })).toBe("a26-soak-20261017-103000.json");
    expect(HOWTO).toHaveLength(6);
  });

  it("share: files via navigator.share, download fallback, cancel is not an error; copy falls back", async () => {
    const shared: unknown[] = [];
    const nav = { share: (d: unknown) => { shared.push(d); return Promise.resolve(); }, canShare: () => true };
    expect((await share("{}", "a.json", { nav })).how).toBe("share");
    const abort = { share: () => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" })) };
    expect((await share("{}", "a.json", { nav: abort })).how).toBe("cancelled");
    const urls = { createObjectURL: () => "blob:x", revokeObjectURL: () => {} };
    expect((await share("{}", "a.json", { nav: {}, URL: urls })).how).toBe("download");
    let wrote = "";
    expect(await copy("abc", { nav: { clipboard: { writeText: (t: string) => { wrote = t; return Promise.resolve(); } } as unknown as Clipboard } })).toBe(true);
    expect(wrote).toBe("abc");
  });

  it("mount builds the PHONE TEST block, RECORD runs a recording, a saved run is adopted", () => {
    const f = fakeEnv();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const p = mountRecorder(host, { env: f.env });
    expect(host.querySelector("#pm-phonerec")).not.toBeNull();
    expect((host.querySelector("#pm-phonerec-share") as HTMLButtonElement).disabled).toBe(true);
    (host.querySelector("#pm-phonerec-rec") as HTMLButtonElement).click();
    expect(p.isOn()).toBe(true);
    expect(host.querySelector("#pm-phonerec-rec")?.textContent).toBe("STOP");
    p.stop();
    expect((host.querySelector("#pm-phonerec-share") as HTMLButtonElement).disabled).toBe(false);
    p.unmount();
    const again = document.createElement("div");
    const q = mountRecorder(again, { env: f.env });
    expect(q.recorder.count()).toBe(2);
    q.unmount();
  });
});

// ─── the barrel ────────────────────────────────────────────────────────────

describe("src/perf barrel", () => {
  it("loads after the styles and exposes the shared instances", async () => {
    const perf = await import("../../../src/perf");
    expect(perf.perfGov.tier()).toBe(0);
    expect(perf.loopHealth.state().frames).toBe(0);
    expect(perf.renderRate.state().mode).toBe("auto");
    expect(perf.raceEntryProfile.armed()).toBe(false);
    expect(perf.GFX_PRESETS.map((p) => p.id)).toEqual(["low", "medium", "high", "ultra"]);
  });
});

// ─── ThreeInspector ────────────────────────────────────────────────────────

describe("ThreeInspector (f1-game three-inspector.test.mjs)", () => {
  const loc = (search: string, hostname = "localhost") => ({ search, hostname, protocol: "http:" });

  it("wanted(): URL beats storage beats the dev-host default; automation and the deployed site default off", () => {
    expect(createThreeInspector({ store: memoryRawStore(), location: loc(""), webdriver: () => false }).wanted()).toBe(true);
    expect(createThreeInspector({ store: memoryRawStore(), location: loc(""), webdriver: () => true }).wanted()).toBe(false);
    expect(createThreeInspector({ store: memoryRawStore(), location: loc("", "brycejmurrin.github.io"), webdriver: () => false }).wanted()).toBe(false);
    const st = memoryRawStore({ "a26.inspector": "0" });
    expect(createThreeInspector({ store: st, location: loc(""), webdriver: () => false }).wanted()).toBe(false);
    expect(createThreeInspector({ store: st, location: loc("?inspector=1"), webdriver: () => false }).wanted()).toBe(true);
    expect(st.data.get("a26.inspector")).toBe("1");
  });

  it("enable attaches, holds the host GPU timer, and teardown restores the renderer's own inspector", async () => {
    const original = { tag: "InspectorBase" };
    const renderer: { inspector: unknown; backend: unknown } = { inspector: original, backend: { isWebGPUBackend: true } };
    const holds: boolean[] = [];
    class Inspector { domElement = document.createElement("div"); }
    const I = createThreeInspector({ store: memoryRawStore(), importInspector: () => Promise.resolve({ Inspector }), location: loc(""), webdriver: () => false });
    await I.boot(() => ({ renderer, hold: (on) => holds.push(on) }));
    expect(I.status()).toMatchObject({ on: true, reason: "on" });
    expect(renderer.inspector).toBeInstanceOf(Inspector);
    expect(document.getElementById("three-inspector-close")).not.toBeNull();
    I.set(null, false);
    expect(renderer.inspector).toBe(original);
    expect(holds).toEqual([true, false]);
    expect(document.getElementById("three-inspector-close")).toBeNull();
    const none = createThreeInspector({ store: memoryRawStore(), location: loc(""), webdriver: () => false });
    await none.boot(() => null);
    expect(none.status()).toMatchObject({ on: false, supported: false });
  });
});
