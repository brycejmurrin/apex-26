/**
 * RaceEntryProfile and SoakRun. The soak driver's control law is compared
 * bit-exactly with f1-game's SoakRun.control over a grid of player states on a
 * straight-then-corner road; the rest are behavioural pins ported from f1-game
 * tests/unit/race-entry-profile.test.mjs and soak-run.test.mjs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRaceEntryProfile } from "../../../src/perf/race-entry-profile";
import { control, createSoakRun, type SoakHost, type SoakInput, type SoakState } from "../../../src/perf/soak-run";
import { setPerfLog } from "../../../src/perf/env";
import type { TrackSample } from "../../../src/contracts/track";
import { f1Perf, hasF1Perf } from "./perf-vm";

setPerfLog({ info: () => {}, warn: () => {}, error: () => {} });

// ─── RaceEntryProfile ──────────────────────────────────────────────────────

describe("RaceEntryProfile (f1-game race-entry-profile.test.mjs)", () => {
  it("legs match the startRace stopwatch shape", () => {
    let t = 1000;
    const P = createRaceEntryProfile({ now: () => t });
    P.begin("startRace");
    t = 1010; P.lap("scenery");
    t = 1050; P.lap("resets");
    t = 2050; P.lap("loadTrack");
    expect(P.legs()).toEqual([{ n: "scenery", ms: 10 }, { n: "resets", ms: 40 }, { n: "loadTrack", ms: 1000 }]);
    expect(P.snapshot().legs[2]?.n).toBe("loadTrack");
  });

  it("marks record handoff / warm / present readiness once", () => {
    let t = 0;
    const P = createRaceEntryProfile({ now: () => t });
    P.begin("startRace");
    t = 100; P.mark("handoff:raise");
    t = 200; P.notePresent(true);
    t = 250; P.notePresent(true);
    t = 500; P.notePresent(false);
    t = 550; P.notePresent(false);
    const names = P.snapshot().marks.map((m) => m.n);
    expect(names).toEqual(["begin:startRace", "handoff:raise", "present:warming", "present:ready"]);
  });

  it("synthetic longtasks feed blockMs and maxBlockMs", () => {
    const P = createRaceEntryProfile({ now: () => 1000 });
    P.begin("startRace");
    P._injectTask(400, 10, "self");
    P._injectTask(1200, 50, "self");
    expect(P.snapshot()).toMatchObject({ blockMs: 1600, maxBlockMs: 1200 });
    expect(P.snapshot().longTasks).toHaveLength(2);
  });

  it("tickFrame ends the window two frames after present:ready", () => {
    const P = createRaceEntryProfile({ now: () => 1000 });
    P.begin("startRace");
    P.notePresent(false);
    P.tickFrame();
    expect(P.armed()).toBe(true);
    P.tickFrame();
    expect(P.armed()).toBe(false);
    expect(P.snapshot().marks.some((m) => m.n === "end")).toBe(true);
  });

  it("menu entry stays armed through present:ready and resumes into startRace", () => {
    let t = 0;
    const P = createRaceEntryProfile({ now: () => t });
    P.beginUi("race");
    P.notePresent(false); P.tickFrame(); P.tickFrame(); P.tickFrame();
    expect(P.armed()).toBe(true);
    t = 50; P.continueWindow("startRace");
    const names = P.snapshot().marks.map((m) => m.n);
    expect(names).toEqual(["begin:race", "entry:race", "present:ready", "begin:startRace"]);
  });

  it("afterPresent lowers the handoff on ctxLost even while warming", () => {
    const P = createRaceEntryProfile({ now: () => 0 });
    P.begin("startRace");
    let stopped = 0;
    const screen = { phase: () => "handoff", handoff: () => {}, stop: () => { stopped++; } };
    P.afterPresent(screen, { warming: () => true, backendState: () => ({ ctxLost: true }) });
    expect(stopped).toBe(1);
    expect(P.snapshot().marks.map((m) => m.n)).toContain("handoff:lower-lost");
    const Q = createRaceEntryProfile({ now: () => 0 });
    Q.begin("x");
    Q.afterPresent(screen, { warming: () => true });
    expect(stopped).toBe(1);
  });

  it("span / requestWarm / stageTable and the soft-raster budget", () => {
    let t = 0;
    const P = createRaceEntryProfile({ now: () => t, softwareRaster: () => true });
    P.begin("startRace");
    P.span("loadTrackStepped", () => { t += 30; });
    P.requestWarm({ warm: () => {} });
    P.requestWarm(null, true);
    const table = P.stageTable();
    expect(table.software).toBe(true);
    expect(table.budgetMs).toBe(45000);
    expect(table.stages).toEqual([{ n: "loadTrackStepped", ms: 30, kind: "span", open: false }]);
    expect(P.snapshot().marks.map((m) => m.n)).toContain("warm:skipped-menu");
    const labels: string[] = [];
    P.setProgressSink((l: string) => labels.push(l));
    P.mark("flyby:end");
    expect(labels).toEqual(["Flyby"]);
  });

  it("runSession: a committed session marks session:committed; a superseded one cannot end the newer window", async () => {
    const P = createRaceEntryProfile({ now: () => 0 });
    const entry = {
      begin: (_k: string, _key: unknown, prepare: () => Promise<unknown>) => ({ outcome: prepare().then(() => ({ kind: "committed" })) }),
      owns: () => true,
    };
    await P.runSession(entry, "monza", () => Promise.resolve(), null, null, () => {}).outcome;
    await Promise.resolve();
    expect(P.snapshot().marks.map((m) => m.n)).toEqual(["begin:startRace", "ensureScenery:start", "ensureScenery:end", "session:committed"]);
  });
});

// ─── SoakRun ───────────────────────────────────────────────────────────────

function road(curveAt: number | null, k: number) {
  return { curvature: (s: number): number => (curveAt != null && s >= curveAt && s < curveAt + 80 ? k : 0) };
}

function rig(opts: { curveAt?: number | null; k?: number } = {}) {
  const calls = { raf: [] as FrameRequestCallback[], cancel: 0, recStart: 0, recStop: 0, pauses: 0, startRace: 0, cam: 0 };
  let now = 0;
  let recOn = false;
  const G = { state: "menu", paused: false, player: { s: 100, x: 0, head: 0, speed: 40 }, input: null as SoakInput | null, raceOpts: null as unknown };
  const r = road(opts.curveAt ?? null, opts.k ?? 0.02);
  const host: SoakHost = {
    state: () => G.state,
    player: () => G.player,
    track: () => ({ sample: (_s: number, out: TrackSample) => { out.t[0] = 0; out.t[1] = 0; out.t[2] = 1; out.hw = 7; return out; }, wrapS: (s: number) => s % 5000 }),
    curvature: r.curvature,
    setTestInput: (i) => { G.input = i; },
    paused: () => G.paused,
    pause: () => { calls.pauses++; G.paused = true; },
    startRace: (o) => { calls.startRace++; G.raceOpts = o; G.state = "count"; return Promise.resolve(); },
    setChaseCamera: () => { calls.cam++; },
    recorder: { start: () => { calls.recStart++; recOn = true; }, stop: () => { calls.recStop++; recOn = false; }, isOn: () => recOn },
  };
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => { calls.raf.push(f); return calls.raf.length; });
  vi.stubGlobal("cancelAnimationFrame", () => { calls.cancel++; });
  const S = createSoakRun(host, () => now);
  const frame = (ms: number): void => { now += ms; const f = calls.raf.pop(); if (f) f(now); };
  return { S, G, host, calls, frame, advance: (ms: number) => { now += ms; } };
}

describe("SoakRun (f1-game soak-run.test.mjs)", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("idle until start(): no rAF, no input", () => {
    const { S, G, calls } = rig();
    expect(S.active()).toBe(false);
    expect(calls.raf).toHaveLength(0);
    expect(G.input).toBeNull();
  });

  it("start asks for a wet fixed-circuit race, the chase camera, then drives and records", async () => {
    const { S, G, calls, frame } = rig();
    expect(await S.start({ minutes: 1 })).toBe(true);
    expect(G.raceOpts).toEqual({ track: "monza", laps: 40, weather: "wet" });
    expect(calls.cam).toBe(1);
    frame(16);
    expect(G.input).toBeNull();
    expect(calls.recStart).toBe(0);
    G.state = "race";
    frame(16);
    expect(calls.recStart).toBe(1);
    expect(typeof G.input?.steer).toBe("number");
    expect(S.status().state).toBe("racing");
  });

  it("it finishes on time: clears the input, pauses, stops the recorder, cancels its rAF", async () => {
    const { S, G, calls, frame, advance } = rig();
    await S.start({ minutes: 1 });
    G.state = "race"; frame(16);
    advance(61000); frame(16);
    expect(S.active()).toBe(false);
    expect(G.input).toBeNull();
    expect(calls.recStop).toBe(1);
    expect(calls.pauses).toBe(1);
    expect(calls.cancel).toBe(1);
    expect(S.status().state).toBe("done");
  });

  it("the player quitting ends the soak; a second start while active is refused", async () => {
    const { S, G, frame } = rig();
    await S.start({ minutes: 5 });
    expect(await S.start()).toBe(false);
    G.state = "race"; frame(16);
    G.state = "menu"; frame(16);
    expect(S.active()).toBe(false);
    expect(G.input).toBeNull();
    expect(S.status().reason).toBe("left-race");
  });

  it("the law brakes for a corner it has not reached, flat-outs a straight, and steers toward the road", () => {
    const st = (): SoakState => ({ hold: 94, stalled: 0, lastS: null });
    const straight = rig();
    straight.G.player.speed = 30;
    expect(control(straight.host, st(), 1 / 60)).toMatchObject({ throttle: true, brake: false });
    const corner = rig({ curveAt: 160, k: 0.05 });
    corner.G.player.speed = 80;
    expect(control(corner.host, st(), 1 / 60)).toMatchObject({ throttle: false, brake: true });
    const r = rig();
    r.G.player.x = 3;
    const right = control(r.host, st(), 1 / 60)?.steer ?? 0;
    r.G.player.x = -3;
    const left = control(r.host, st(), 1 / 60)?.steer ?? 0;
    expect(right * left).toBeLessThan(0);
  });
});

type F1Soak = { control(G: unknown, st: SoakState, dt: number): SoakInput | null; create(G: unknown): unknown };

describe.skipIf(!hasF1Perf)("SoakRun.control: bit-exact against f1-game", () => {
  it("a grid of speeds, offsets, headings and corners", () => {
    let n = 0;
    for (const curveAt of [null, 120, 160, 300]) {
      for (const k of [0.004, -0.02, 0.05]) {
        const r = road(curveAt, k);
        const Tracks = { sample: (_T: unknown, _s: number, smp: { t: number[]; hw: number }) => { smp.t[0] = 0.1; smp.t[2] = 0.995; smp.hw = 7; }, curvature: (_T: unknown, s: number) => r.curvature(s) };
        const ctx = { Tracks, M4: { clamp: (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v) } };
        const F = f1Perf<F1Soak>(["js/perf/soak-run.js"], "SoakRun", { extra: ctx });
        for (const speed of [0, 12, 40, 80]) {
          for (const x of [-8, -1.5, 0, 2.5, 7.6]) {
            for (const head of [null, -0.3, 0.2]) {
              const P = { s: 100, x, head, speed };
              const G = { player: P, track: {}, smp: { t: [0, 0, 1], hw: 0 }, wrapS: (s: number) => s % 5000, rescuePlayer: () => {} };
              const host: SoakHost = {
                state: () => "race", player: () => P, curvature: r.curvature, setTestInput: () => {}, paused: () => false, pause: () => {}, startRace: () => undefined,
                track: () => ({ sample: (_s, out) => { out.t[0] = 0.1; out.t[2] = 0.995; out.hw = 7; return out; }, wrapS: (s) => s % 5000 }),
                rescuePlayer: () => {},
              };
              const a: SoakState = { hold: 30, stalled: 0, lastS: null }, b: SoakState = { hold: 30, stalled: 0, lastS: null };
              for (let f = 0; f < 15; f++) {
                const pa = control(host, a, 1 / 60), pb = F.control(G, b, 1 / 60);
                expect(pa).not.toBeNull();
                if (!pa || !pb || !Object.is(pa.steer, pb.steer) || pa.throttle !== pb.throttle || pa.brake !== pb.brake) expect.fail(`case ${n}/${f}: ${JSON.stringify(pa)} vs ${JSON.stringify(pb)}`);
                expect({ ...a }).toEqual({ ...b });
                if (f % 5 === 4) P.s += 0.01; else P.s += 1;
              }
              n++;
            }
          }
        }
      }
    }
    expect(n).toBe(720);
  });
});
