// @vitest-environment happy-dom
/** Results cam (src/camera/results-cam.ts). Parity against f1-game
 *  js/camera/results-cam.js (+ js/camera/replay-buf.js for the montage) in a
 *  VM: the pure helpers over a grid of inputs, then a recorded finish —
 *  chequered cut, orbit, a HIGHLIGHTS montage over the ring's tags, the return
 *  to the orbit and a reset — every published pose compared with Object.is.
 *  The trace is committed as tests/fixtures/camera/results-cam.json.
 *  Assertions ported from f1-game tests/unit/results-cam.test.mjs:34-240,
 *  :423-531 (the VM/DOM ones; game.js tick pins and the audio runs are the shell's). */
import { describe, expect, it } from "vitest";
import { createReplayBuf, type ReplayCar } from "../../../src/camera/replay-buf";
import {
  CHEQ_S, chequeredExtra, createResultsCam, highlightsReel, orbitPose, type BankFn, type ResultsCar, type ResultsHost, type SampleFn,
} from "../../../src/camera/results-cam";
import type { VantageExtra } from "../../../src/camera/modes";
import type { Track } from "../../../src/track/core/types";
import { expectBitExact, hasFixture, maybeWriteFixture, readFixture } from "./fixture";
import { f1Cam, hasCam } from "./f1-cam-vm";

type Car = ResultsCar & ReplayCar & { code: string; finPos: number };
type CamApi = ReturnType<typeof createResultsCam<Car>>;
type BufApi = ReturnType<typeof createReplayBuf<Car>>;

const sampleFn: SampleFn = (_t, s, out) => { out.p[0] = Math.cos(s / 700) * 400; out.p[1] = 3 + Math.sin(s * 0.004); out.p[2] = Math.sin(s / 700) * 400; return out; };
const bankFn: BankFn = (_t, s, x, out) => {
  if (Math.floor(s / 400) % 3 === 1) return null;
  const o = out || { dy: 0, roll: 0 };
  o.dy = x * 0.07 + 0.01 * s % 1; o.roll = 0.02;
  return o;
};

// ── Pure helpers over a grid ───────────────────────────────────────────────
function pureTrace(R: { orbitPose: typeof orbitPose; highlightsReel: typeof highlightsReel; chequeredExtra: typeof chequeredExtra }): unknown {
  const orbit: unknown[] = [];
  for (let k = 0; k < 40; k++) orbit.push(R.orbitPose(10 * k - 200, Math.sin(k), -3.5 * k, k * 0.37 - 4));
  const reels: unknown[] = [];
  let seed = 7;
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let r = 0; r < 40; r++) {
    const n = Math.floor(rnd() * 12);
    const tags: Array<{ kind?: string; t: number; car?: number }> = [];
    for (let i = 0; i < n; i++) tags.push({ kind: ["contact", "retirement", "pass", ""][Math.floor(rnd() * 4)]!, t: rnd() * 25 - 2, car: Math.floor(rnd() * 4) });
    if (r % 7 === 0) tags.push({ t: NaN });
    const t0 = r % 5 === 0 ? 3 : 0, t1 = r % 9 === 0 ? t0 : 20 - (r % 3), maxS = [45, 12, 4, 2.5, 0][r % 5]!;
    reels.push(R.highlightsReel(tags, t0, t1, maxS));
  }
  const extras = [R.chequeredExtra({ px: 1, pz: 2, head: 0.3 }), R.chequeredExtra({ px: null, pz: 2 })];
  return { orbit, reels, extras };
}

// ── A recorded finish ─────────────────────────────────────────────────────
function finish(make: (G: ResultsHost<Car>) => { cam: CamApi; buf: BufApi }): unknown {
  const cars: Car[] = [];
  for (let i = 0; i < 4; i++) cars.push({ code: "C" + i, finPos: 0, s: 0, x: 0, head: 0, speed: 0, px: 0, py: 1, pz: 0, steer: 0, yawVis: 0, retired: false, finished: false });
  const vcalls: unknown[] = [];
  const G: ResultsHost<Car> & { raceT: number } = {
    gfx: { isMobile: false }, netPlay: { active: () => false }, dbgCam: null, cars, player: cars[2]!,
    track: { total: 5000 } as unknown as Track, raceT: 0,
    camVantage(mode: string, s: number, x: number, spd: number, now: number, e: VantageExtra) {
      vcalls.push([mode, s, x, spd, now, e.carPos ? [e.carPos[0], e.carPos[1]] : null, e.carHead ?? null, e.bankDy, e.snap]);
      return { eye: [s * 0.1 + x, 4 + (e.bankDy as number), -10 + spd * 0.01], tgt: [s * 0.1, 1, 0], fov: 58 - (e.bankDy as number) };
    },
    camPoseOf(c) { return c.code === "C1" ? null : { s: c.s! + 0.5, x: c.x!, carPos: [c.px!, c.pz!], carHead: c.head! }; },
  };
  const { cam, buf } = make(G);
  cam.attachReplay(buf);
  const drive = (t: number): void => {
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i]!;
      if (c.retired) continue;
      c.s = (300 * i + 70 * t) % 5000; c.x = 2 * Math.sin(t + i); c.speed = 70 + i;
      c.px = Math.cos(c.s / 700) * 400; c.pz = Math.sin(c.s / 700) * 400; c.py = 1 + 0.1 * i; c.head = c.s / 700;
    }
  };
  for (let f = 0; f <= 600; f++) {
    const t = f / 30;
    G.raceT = t; drive(t);
    if (f === 200) cars[3]!.retired = true;
    if (f === 450) { cars[1]!.finished = true; cars[1]!.finPos = 1; }
    if (f === 500) { cars[2]!.finished = true; cars[2]!.finPos = 2; }
    if (f === 550) { cars[0]!.finished = true; cars[0]!.finPos = 3; }
    buf.sample(t, cars);
  }
  buf.pushTag("contact", 14.2, 0);
  buf.pushTag("contact", 14.9, 0);
  const out: unknown[] = [];
  const rec = (label: string, r: unknown): void => {
    const d = G.dbgCam as { eye: number[]; target: number[]; fov: number; far: number; _resultsCam: boolean } | null;
    out.push({ label, r, status: cam.status(), cam: d ? { eye: d.eye, target: d.target, fov: d.fov, far: d.far, rc: d._resultsCam } : null, v: vcalls.splice(0), poses: label === "hl" ? cars.map((c) => [c.s, c.px, c.pz]) : null });
  };
  rec("flag", cam.onFlag());
  for (let k = 0; k < 60; k++) rec("tick", cam.tick(k % 2 ? 1 / 45 : 1 / 15));
  rec("highlights", cam.startHighlights());
  for (let k = 0; k < 400 && cam.status().phase === "highlights"; k++) rec("hl", cam.tick(0.21));
  for (let k = 0; k < 30; k++) rec("orbit", cam.tick(1 / 30));
  rec("highlights2", cam.startHighlights());
  rec("tick", cam.tick(0.2));
  cam.reset();
  rec("reset", null);
  rec("orbit-idle", cam.startOrbit());
  return out;
}

interface F1Mods {
  R: { create(G: unknown, eligible?: () => boolean): CamApi; orbitPose: typeof orbitPose; highlightsReel: typeof highlightsReel; chequeredExtra: typeof chequeredExtra };
  B: { create(G: unknown, eligible?: () => boolean): BufApi };
}
function loadF1(): F1Mods {
  return f1Cam<F1Mods>(["replay-buf.js", "results-cam.js"], "({ R: ResultsCam, B: ReplayBuf })", {
    PerfGov: { tier: () => 0 }, Tracks: { sample: sampleFn, banking: bankFn },
  });
}

function runPort(): unknown {
  return {
    pure: pureTrace({ orbitPose, highlightsReel, chequeredExtra }),
    finish: finish((G) => ({
      cam: createResultsCam(G, null, { doc: null, perfTier: () => 0, sample: sampleFn, banking: bankFn }),
      buf: createReplayBuf(G as never, null, { doc: null }) as unknown as BufApi,
    })),
  };
}
function runF1(): unknown {
  const M = loadF1();
  return { pure: pureTrace(M.R), finish: finish((G) => ({ cam: M.R.create(G), buf: M.B.create(G) })) };
}

describe("ResultsCam parity with f1-game results-cam.js", () => {
  it.skipIf(!hasCam)("matches the VM bit-exactly (pure helpers + a recorded finish with highlights)", () => {
    const f1 = runF1();
    maybeWriteFixture("results-cam", f1);
    expectBitExact(runPort(), f1);
  });
  it("matches the committed fixture", () => {
    expect(hasFixture("results-cam")).toBe(true);
    expectBitExact(runPort(), readFixture("results-cam"));
  });
  it("the recorded finish walks chequered → orbit → highlights → orbit", () => {
    const tr = (runPort() as { finish: Array<{ status: { phase: string } }> }).finish;
    const phases = tr.map((r) => r.status.phase).filter((p, i, a) => p !== a[i - 1]);
    expect(phases).toEqual(["chequered", "orbit", "highlights", "orbit", "highlights", "idle"]);
  });
});

// ── Ported f1-game assertions ─────────────────────────────────────────────
function scene(player: ResultsCar, more: Partial<ResultsHost<ResultsCar>> = {}): ResultsHost<ResultsCar> {
  return { player, cars: [player], dbgCam: null, netPlay: { active: () => false }, gfx: {}, ...more };
}

describe("ResultsCam (ported assertions)", () => {
  it("orbitPose is finite and highlightsReel respects budget + order", () => {
    const pose = orbitPose(10, 1, -5, Math.PI / 4);
    expect(pose.eye.every(Number.isFinite) && pose.target.every(Number.isFinite)).toBe(true);
    const reel = highlightsReel([{ kind: "contact", t: 1, car: 0 }, { kind: "retirement", t: 8, car: 2 }, { kind: "chequered", t: 19, car: 0 }], 0, 20, 12);
    expect(reel.length).toBeGreaterThanOrEqual(2);
    let span = 0;
    for (const c of reel) { expect(c.t1).toBeGreaterThan(c.t0); span += c.t1 - c.t0; }
    expect(span).toBeLessThanOrEqual(12 + 1e-6);
    expect(reel[0]!.t0).toBeLessThanOrEqual(reel[reel.length - 1]!.t0);
  });

  it("chequered → orbit; disabled on mobile / high PerfGov tier", () => {
    const player: ResultsCar = { s: 0, x: 0, px: 1, py: 1, pz: 2, head: 0, speed: 40, finPos: 1 };
    let tier = 0;
    const G = scene(player, { gfx: { isMobile: false }, camVantage: () => ({ eye: [0, 4, -10], target: [0, 1, 0], fov: 58 }) });
    const api = createResultsCam(G, null, { doc: null, perfTier: () => tier, sample: null, banking: null });
    expect(api.onFlag()).toBe(true);
    expect(api.live()).toBe(true);
    expect(api.status().phase).toBe("chequered");
    expect((G.dbgCam as { _resultsCam?: boolean })._resultsCam).toBe(true);
    for (let i = 0; i < 80; i++) api.tick(1 / 30);
    expect(api.status().phase).toBe("orbit");
    G.gfx = { isMobile: true };
    api.reset();
    expect(api.onFlag()).toBe(false);
    G.gfx = { isMobile: false }; tier = 2;
    expect(api.onFlag()).toBe(false);
    expect(api.enabled()).toBe(false);
    expect(CHEQ_S).toBe(2.2);
  });

  it("highlight windows fit end tags, short recordings and the actual budget", () => {
    const fin = highlightsReel([{ t: 20 }], 0, 20, 4);
    expect([fin[0]!.t0, fin[0]!.t1]).toEqual([16, 20]);
    const short = highlightsReel([{ t: 10 }, { t: 10.5 }, { t: 11 }], 10, 11, 2.5);
    expect(short.length).toBe(1);
    expect(short.reduce((sum, c) => sum + c.t1 - c.t0, 0)).toBe(1);
    expect(short[0]!.events!.length).toBe(3);
    expect(highlightsReel([{ t: 10 }], 10, 10, 4).length).toBe(0);
    expect(highlightsReel([{ t: 10 }], 11, 10, 4).length).toBe(0);
  });

  it("untagged subsecond highlights stay inside the recording and finish promptly", () => {
    const car: ResultsCar = { finPos: 1, s: 0, px: 0, pz: 0 }, applied: number[] = [];
    const G = scene(car, { camVantage: () => ({ eye: [0, 5, -10], tgt: [0, 0, 0] }) });
    const camera = createResultsCam(G, null, { doc: null, sample: null, banking: null });
    let end = 10.2;
    camera.attachReplay({ window: () => ({ t0: 10, t1: end, frames: 6 }), tags: () => [], beginScrub: () => true, apply: (t) => applied.push(t), endScrub() {} });
    camera.onFlag();
    expect(camera.startHighlights()).toBe(true);
    camera.tick(0.1);
    expect(applied.every((t) => t >= 10 && t <= 10.2)).toBe(true);
    camera.tick(0.11);
    expect(camera.status().phase).toBe("orbit");
    end = 10;
    expect(camera.startHighlights()).toBe(false);
  });

  it("HIGHLIGHTS button stays hidden when ReplayBuf has no scrubbable footage", () => {
    document.body.innerHTML = '<div id="results"><div id="res-menu"></div></div>';
    const car: ResultsCar = { finPos: 1, s: 0, px: 0, pz: 0 };
    const G = scene(car, { camVantage: () => ({ eye: [0, 5, -10], tgt: [0, 0, 0] }) });
    const camera = createResultsCam(G, null, { doc: document, sample: null, banking: null });
    camera.attachReplay({ window: () => ({ t0: 0, t1: 0, frames: 0 }), tags: () => [], beginScrub: () => true, apply() {}, endScrub() {} });
    camera.onFlag();
    const btn = document.getElementById("res-highlights") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.hidden).toBe(true);
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/No recorded footage/i);
    expect(camera.startHighlights()).toBe(false);
  });

  it("highlights frame the tagged car after posing, including a retirement, then return to the winner", () => {
    document.body.innerHTML = '<div id="results"><div id="res-menu"></div></div>';
    const winner: ResultsCar = { finPos: 1, s: 10, px: 10, pz: 0 }, retired: ResultsCar = { finPos: 2, retired: true, s: 800, px: 800, pz: 0 };
    const G: ResultsHost<ResultsCar> = { player: winner, cars: [winner, retired], gfx: {}, dbgCam: null,
      camVantage: (_m, s) => ({ eye: [s, 5, -10], tgt: [s, 0, 0], fov: 58 }) };
    const camera = createResultsCam(G, null, { doc: document, sample: null, banking: null });
    camera.attachReplay({ window: () => ({ t0: 0, t1: 20, frames: 600 }),
      tags: () => [{ kind: "retirement", t: 10, car: 1 }, { kind: "contact", t: 15, car: 99 }],
      beginScrub: () => true, apply: () => { retired.s = retired.px = 700; }, endScrub: () => { retired.s = retired.px = 800; } });
    camera.onFlag();
    const target = (): number => (G.dbgCam as { target: number[] }).target[0]!;
    expect(target()).toBe(10);
    expect(camera.startHighlights()).toBe(true);
    expect(document.getElementById("results")!.dataset["resultsPlayback"]).toBe("playing");
    expect(document.getElementById("res-highlights")!.textContent).toBe("BACK TO RESULTS");
    expect(target()).toBe(700);
    expect(G.player).toBe(winner);
    camera.tick(4.1);
    expect(target()).toBe(10);
    camera.tick(4.1);
    expect(camera.status().phase).toBe("orbit");
    expect(target()).toBe(10);
    expect(retired.px).toBe(800);
    expect(document.getElementById("results")!.dataset["resultsPlayback"]).toBeUndefined();
  });

  it("montage completion and reset restore the exact finish; online sessions cannot acquire replay", () => {
    const car: Car = { code: "W", finPos: 1, s: 0, x: 0, head: 0, speed: 50, px: 0, py: 1, pz: 0, steer: 0, yawVis: 0 };
    const G: ResultsHost<Car> = { player: car, cars: [car], gfx: {}, dbgCam: null, netPlay: { active: () => false },
      camVantage: (_m, s) => ({ eye: [s, 5, -10], tgt: [s, 0, 0], fov: 58 }) };
    const replay = createReplayBuf(G as never, null, { doc: null }) as unknown as BufApi;
    for (let f = 0; f <= 90; f++) { car.s = f; car.px = f; replay.sample(f / 30, [car]); }
    const fin = { ...car };
    let allowed = true;
    const camera = createResultsCam(G, () => allowed, { doc: null, sample: null, banking: null });
    camera.attachReplay(replay); camera.onFlag();
    expect(camera.startHighlights()).toBe(true);
    for (let i = 0; i < 150; i++) camera.tick(1 / 30);
    expect(camera.status().phase).toBe("orbit");
    expect(car).toEqual(fin);
    expect(replay.isScrubbing()).toBe(false);
    expect(camera.startHighlights()).toBe(true);
    camera.reset();
    expect(car).toEqual(fin);
    expect(camera.startHighlights()).toBe(false);
    camera.onFlag(); expect(camera.startHighlights()).toBe(true);
    allowed = false;
    expect(camera.tick(1 / 30)).toBe(false);
    expect(camera.live()).toBe(false);
    expect(replay.isScrubbing()).toBe(false);
    expect(car).toEqual(fin);
    allowed = true;
    camera.onFlag();
    G.netPlay = { active: () => true };
    expect(camera.startHighlights()).toBe(false);
    expect(camera.startOrbit()).toBe(false);
  });

  it("the orbit stands on the rendered subject and the road elevation, banked", () => {
    const car: ResultsCar = { finPos: 1, s: 120, x: 2, px: 9, pz: 9 };
    const G = scene(car, { track: {} as Track, camPoseOf: () => ({ s: 100, x: 3, carPos: [50, 60], carHead: 0 }) });
    const cam = createResultsCam(G, null, { doc: null, sample: (_t, s, out) => { out.p[1] = s * 0.01; return out; }, banking: (_t, _s, x) => ({ dy: x }) });
    cam.onFlag(); cam.startOrbit();
    const d = G.dbgCam as { eye: number[]; target: number[] };
    expect(d.target).toEqual([50, 1 + 3 + 1.2, 60]);
  });
});
