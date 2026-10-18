// @vitest-environment happy-dom
/** Instant-replay ring (src/camera/replay-buf.ts). Parity against f1-game
 *  js/camera/replay-buf.js in a VM: record a 6-car field over ~3600 frames
 *  (the ring wraps many times) with a lap-line crossing, heading wraps, a
 *  teleport, a retirement, a flag, a red-flag break and a clock rewind; then
 *  at() over a sweep of times, scrub entry / playback / frame steps / LAST /
 *  exit and the restored live poses — Object.is on every number (Float32 lanes
 *  included). The trace is committed as tests/fixtures/camera/replay-buf.json.
 *  Assertions ported from f1-game tests/unit/replay-buf.test.mjs:45-480, :605-778
 *  (the VM/DOM ones; the game.js pins and the game-vm audio runs are the shell's). */
import { describe, expect, it } from "vitest";
import {
  budgetOk, capacityFor, createReplayBuf, frameBytes, HZ, lerpCar, MAX_BYTES, MAX_CARS, MAX_FRAMES,
  type ReplayCar, type ReplayHost,
} from "../../../src/camera/replay-buf";
import { expectBitExact, hasFixture, maybeWriteFixture, readFixture } from "./fixture";
import { f1Cam, hasCam } from "./f1-cam-vm";

type Api = ReturnType<typeof createReplayBuf<ReplayCar>>;
interface F1Replay { create(G: unknown, eligible?: () => boolean): Api; lerpCar: typeof lerpCar; capacityFor: typeof capacityFor }

const L = 3295;

function field(n: number): ReplayCar[] {
  const out: ReplayCar[] = [];
  for (let i = 0; i < n; i++) out.push({ s: 0, x: 0, head: 0, speed: 0, px: 0, py: 1, pz: 0, steer: 0, yawVis: 0, retired: false, finished: false });
  return out;
}
function drive(cars: ReplayCar[], t: number): void {
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]!;
    if (c.retired) continue;
    c.speed = 60 + 10 * Math.sin(t * 0.3 + i);
    c.s = (((100 * i + 61.7 * t) % L) + L) % L;
    c.x = 2.5 * Math.sin(t * 0.7 + i * 0.4);
    // Heading and yaw spin through ±π.
    c.head = ((t * 1.9 + i) % (2 * Math.PI)) - Math.PI;
    c.yawVis = -c.head + 0.01 * i;
    c.px = 300 * Math.cos(c.s / L * 2 * Math.PI) + c.x;
    c.pz = 300 * Math.sin(c.s / L * 2 * Math.PI);
    c.py = 1 + 0.2 * Math.sin(c.s * 0.01);
    c.steer = 0.3 * Math.sin(t * 2 + i);
  }
}

/** `sweepN`: at() samples per sweep (64 against the VM; 12 in the committed fixture). */
function scenario(make: (G: ReplayHost<ReplayCar>, log: string[]) => Api, sweepN: number): unknown {
  const cars = field(6);
  const log: string[] = [];
  const G: ReplayHost<ReplayCar> & { raceT: number } = {
    cars, netPlay: { active: () => false }, track: { total: L }, raceT: 0, paused: true,
    snapGameCam() { log.push("snap"); },
  };
  const api = make(G, log);
  const out: Record<string, unknown> = {};
  const sweep = (label: string): void => {
    const w = api.window();
    const rows: unknown[] = [];
    for (let k = 0; k <= sweepN; k++) {
      const t = w.t0 - 0.3 + (w.t1 - w.t0 + 0.6) * k / sweepN;
      const a = api.at(t);
      rows.push(a ? [a.t, a.cars.map((c) => [c.s, c.x, c.head, c.speed, c.px, c.py, c.pz, c.steer, c.yawVis, c.status])] : null);
    }
    out[label] = { window: w, tags: api.tags(), last: api.lastTag(), rows };
  };
  // Phase A: 60 s of racing (the ring wraps: capacity 600 frames).
  let t = 0;
  for (let f = 0; f < 1800; f++) {
    t = 5 + f / 120 * 4;   // 30 Hz of race time, with sub-slot ticks skipped by the slot gate
    G.raceT = t;
    drive(cars, t);
    if (f === 900) cars[3]!.pz = (cars[3]!.pz ?? 0) + 80;   // a RECOVER teleport
    if (f === 1000) cars[2]!.retired = true;
    if (f === 1400) cars[5]!.finished = true;
    api.onTick(t, cars, "race");
  }
  api.pushTag("contact", t - 3, 1);
  sweep("A");
  // Phase B: a red-flag break (same clock), more racing.
  api.breakTimeline();
  for (const c of cars) c.px = (c.px ?? 0) + 149;
  for (let f = 1; f <= 900; f++) {
    t += 1 / 30;
    G.raceT = t;
    drive(cars, t);
    api.sample(t, cars);
  }
  sweep("B");
  // Scrub: entry, playback at every rate, frame steps, LAST, exit.
  const live = JSON.parse(JSON.stringify(cars)) as unknown;
  const scrub: unknown[] = [];
  const snapCars = (): unknown => cars.map((c) => [c.s, c.x, c.head, c.speed, c.px, c.py, c.pz, c.steer, c.yawVis, c.rPrevS, c.rPrevX, c.rPrevPx, c.rPrevPz, c.rPrevHead, c.rPrevYawVis]);
  log.length = 0;
  scrub.push(["begin", api.beginScrub(false), api.status(), snapCars(), log.splice(0)]);
  for (let i = 0; i < 90; i++) { api.tickScrub(1 / 60); if (i % 10 === 0) scrub.push(["tick", api.status(), snapCars()]); }
  for (const d of [-1, -1, 1, 1, 1, 2]) scrub.push(["step", d, api.stepFrame(d), api.status().scrubT, log.splice(0)]);
  scrub.push(["last", api.jumpLastTag(), api.status().scrubT, snapCars()]);
  scrub.push(["apply", api.apply(api.window().t0 + 0.123), snapCars(), log.splice(0)]);
  scrub.push(["adj", api.adjacentFrame(api.status().scrubT, -1), api.adjacentFrame(api.status().scrubT, 1), api.adjacentFrame(api.window().t1, 1)]);
  scrub.push(["end", api.endScrub(), JSON.stringify(cars) === JSON.stringify(live), snapCars(), log.splice(0)]);
  out["scrub"] = scrub;
  // Phase C: a clock rewind discards the ring.
  t = 30; G.raceT = t;
  drive(cars, t);
  out["rewind"] = [api.sample(t, cars), api.window(), api.lastTag()];
  for (let f = 1; f <= 200; f++) { t += 1 / 30; drive(cars, t); api.sample(t, cars); }
  sweep("C");
  return out;
}

function runPort(sweepN: number): unknown {
  return scenario((G, log) => createReplayBuf(G, null, {
    doc: null,
    feel: { resetFollow: () => { log.push("feel.resetFollow"); } },
    gameCams: { resetSmoothing: () => { log.push("cams.reset"); } },
  }), sweepN);
}
function runF1(sweepN: number): unknown {
  return scenario((G, log) => {
    const R = f1Cam<F1Replay>(["replay-buf.js"], "ReplayBuf", {
      CamFeel: { resetFollow: () => { log.push("feel.resetFollow"); } },
      GameCams: { resetSmoothing: () => { log.push("cams.reset"); } },
    });
    return R.create(G);
  }, sweepN);
}

describe("ReplayBuf parity with f1-game replay-buf.js", () => {
  it.skipIf(!hasCam)("matches the VM bit-exactly over a recorded race and a scrub", () => {
    expectBitExact(runPort(64), runF1(64));
    const f1 = runF1(12);
    maybeWriteFixture("replay-buf", f1);
    expectBitExact(runPort(12), f1);
  });
  it("matches the committed fixture", () => {
    expect(hasFixture("replay-buf")).toBe(true);
    expectBitExact(runPort(12), readFixture("replay-buf"));
  });
  it.skipIf(!hasCam)("the pure helpers agree bit-exactly", () => {
    const R = f1Cam<F1Replay>(["replay-buf.js"], "ReplayBuf");
    for (let n = 0; n <= 30; n++) expect(capacityFor(n)).toBe(R.capacityFor(n));
    const a = Float32Array.of(3290, 1, Math.PI - 0.01, 50, 1, 2, 3, 0.1, -Math.PI + 0.02);
    const b = Float32Array.of(2, -1, -Math.PI + 0.03, 55, 4, 5, 6, -0.1, Math.PI - 0.04);
    for (const u of [0, 0.1, 0.25, 0.5, 0.77, 1]) for (const Lv of [0, L]) {
      expectBitExact(Array.from(lerpCar(new Float32Array(9), a, b, u, Lv)), Array.from(R.lerpCar(new Float32Array(9), a, b, u, Lv)));
    }
  });
});

// ── Ported f1-game assertions ─────────────────────────────────────────────
function cars(n: number, base = 0): ReplayCar[] {
  const out: ReplayCar[] = [];
  for (let i = 0; i < n; i++) out.push({ s: base + i, x: i * 0.1, head: 0.01 * i, speed: 50 + i, px: i, py: 1, pz: i * 2, steer: 0, retired: false, finished: false });
  return out;
}
const mk = (G: ReplayHost<ReplayCar>, eligible?: () => boolean): Api => createReplayBuf(G, eligible ?? null, { doc: null });

describe("ReplayBuf (ported assertions)", () => {
  it("budget stays under 0.7 MB for 22 cars / 20 s", () => {
    expect(budgetOk(22, capacityFor(22))).toBe(true);
    expect(frameBytes(22) * capacityFor(22)).toBeLessThanOrEqual(MAX_BYTES);
    expect(capacityFor(22)).toBeGreaterThanOrEqual(HZ * 10);
    expect(MAX_BYTES).toBe(720 * 1024);
    expect(MAX_FRAMES).toBe(600);
  });

  it("recorded heading and mesh yaw cross the ±π boundary without facing backwards", () => {
    const f = cars(1), api = mk({ cars: f, netPlay: { active: () => false } });
    for (const direction of [-1, 1]) {
      api.reset(f);
      Object.assign(f[0]!, { head: direction * (Math.PI - 0.02), yawVis: -direction * (Math.PI - 0.04), px: 10, steer: -0.5 });
      api.sample(0, f);
      Object.assign(f[0]!, { head: -direction * (Math.PI - 0.02), yawVis: direction * (Math.PI - 0.04), px: 20, steer: 0.5 });
      api.sample(1, f);
      for (const t of [0.25, 0.5, 0.75]) {
        const pose = api.at(t)!.cars[0]!;
        expect(Math.cos(pose.head)).toBeLessThan(-0.999);
        expect(Math.cos(pose.yawVis)).toBeLessThan(-0.999);
        expect(Math.abs(pose.px - (10 + 10 * t))).toBeLessThan(1e-6);
        expect(Math.abs(pose.steer - (t - 0.5))).toBeLessThan(1e-6);
      }
    }
  });

  it("sample wraps and at() interpolates; restore is bit-exact on captured fields", () => {
    const f = cars(4);
    const api = mk({ cars: f, netPlay: { active: () => false }, paused: true });
    api.reset(f);
    for (let i = 0; i < HZ * 3; i++) { for (const c of f) { c.s! += 1; c.px! += 0.5; } api.sample(i / HZ, f); }
    expect(api.window().frames).toBeGreaterThanOrEqual(HZ * 2);
    const cap = capacityFor(4);
    for (let i = 0; i < cap + 50; i++) { for (const c of f) c.s! += 0.5; api.sample(10 + i / HZ, f); }
    const w2 = api.window();
    expect(w2.frames).toBe(cap);
    const mid = api.at((w2.t0 + w2.t1) / 2)!;
    expect(mid.cars.length).toBe(4);
    const before = f.map((c) => ({ ...c }));
    expect(api.beginScrub()).toBe(true);
    expect(api.apply(w2.t0)).toBe(true);
    expect(f[0]!.s).not.toBe(before[0]!.s);
    expect(api.endScrub()).toBe(true);
    expect(f).toEqual(before);
    expect(api.isScrubbing()).toBe(false);
  });

  it("sampling and beginScrub are off when netPlay is active", () => {
    const f = cars(2), api = mk({ cars: f, netPlay: { active: () => true } });
    api.reset(f);
    for (let i = 0; i < HZ * 4; i++) api.sample(i / HZ, f);
    expect(api.sample(1, f)).toBe(false);
    expect(api.beginScrub()).toBe(false);
  });

  it("replay seeks preserve photo and debug-camera ownership", () => {
    for (const owner of [{ photoMode: true }, { dbgCam: { _resultsCam: true } }, { dbgCam: { director: true } }]) {
      const f = cars(1);
      let snaps = 0;
      const G: ReplayHost<ReplayCar> = { cars: f, ...owner, snapGameCam() { snaps++; } };
      const api = mk(G);
      api.sample(0, f); f[0]!.s! += 10; api.sample(1, f);
      expect(api.beginScrub(false)).toBe(true);
      api.apply(0); api.tickScrub(0.1); api.endScrub();
      expect(snaps).toBe(0);
    }
  });

  it("injected pose ownership denies sampling, the pause-card door and scrub entry", () => {
    document.body.innerHTML = '<div><button id="pm-resume"></button></div>';
    let eligible = true;
    const f = cars(2), G: ReplayHost<ReplayCar> = { cars: f, netPlay: { active: () => false } };
    const api = createReplayBuf(G, () => eligible, { doc: document });
    for (let i = 0; i < HZ * 4; i++) api.sample(i / HZ, f);
    api.refreshButton();
    const button = document.getElementById("pm-replay")!;
    expect(button.hidden).toBe(false);
    const frames = api.window().frames, before = f.map((c) => ({ ...c }));
    eligible = false;
    api.onTick(6, f, "race"); expect(api.sample(7, f)).toBe(false);
    expect(api.window().frames).toBe(frames);
    api.onPause(true); expect(button.hidden).toBe(true);
    expect(api.beginScrub()).toBe(false); expect(api.isScrubbing()).toBe(false);
    expect(f).toEqual(before);
  });

  it("a clock rewind discards the wrapped future ring and tags", () => {
    const f = cars(1), G: ReplayHost<ReplayCar> = { cars: f, netPlay: { active: () => false }, raceT: 101 }, api = mk(G);
    for (let i = 0; i < MAX_FRAMES + 20; i++) { f[0]!.px = i; api.sample(80 + i / HZ, f); }
    api.pushTag("retirement", 99, 0);
    f[0]!.px = 42; G.raceT = 10;
    expect(api.sample(10, f)).toBe(true);
    const w = api.window(); expect([w.frames, w.t0, w.t1]).toEqual([1, 10, 10]);
    expect(api.lastTag()).toBeNull(); expect(api.status().tags).toBe(0);
    expect(api.at(10)!.cars[0]!.px).toBe(42);
    expect(api.beginScrub()).toBe(false);
  });

  it("a backwards timestamp within the same 30 Hz slot is recorded on its new timeline", () => {
    const f = cars(1), api = mk({ cars: f, netPlay: { active: () => false } });
    api.sample(10.04, f); f[0]!.px = 123;
    expect(api.sample(10.035, f)).toBe(true);
    expect(api.window().frames).toBe(1); expect(api.window().t0).toBe(10.035);
    expect(api.at(10.035)!.cars[0]!.px).toBe(123);
  });

  it("reopening Pause during scrub restores the live pose and hides the dock", () => {
    document.body.innerHTML = '<div><button id="pm-resume"></button></div>';
    const f = cars(1), G: ReplayHost<ReplayCar> = { cars: f, netPlay: { active: () => false }, raceT: 4 };
    const api = createReplayBuf(G, null, { doc: document });
    for (let i = 0; i < HZ * 4; i++) { f[0]!.px = i; api.sample(i / HZ, f); }
    const before = f.map((c) => ({ ...c }));
    expect(api.beginScrub()).toBe(true); expect(f[0]!.px).not.toBe(before[0]!.px);
    const dock = document.getElementById("pm-replay-dock")!;
    expect(dock.hidden).toBe(false);
    expect(dock.getAttribute("role")).toBe("group");
    expect(dock.getAttribute("aria-label")).toBe("Instant replay");
    expect(dock.getAttribute("style")).toBeNull();
    api.onPause(true);
    expect(api.isScrubbing()).toBe(false); expect(f).toEqual(before);
    expect(document.getElementById("pm-replay")!.hidden).toBe(false);
    expect(dock.hidden).toBe(true);
    f[0]!.px = 567; api.tickScrub(0.05); api.endScrub();
    expect(f[0]!.px).toBe(567);
  });

  it("scrubbed poses carry both interpolation endpoints; exit restores absent history exactly", () => {
    const f = cars(2), api = mk({ cars: f, netPlay: { active: () => false } });
    Object.assign(f[0]!, { s: 10, px: 10, pz: 20, head: 0.5, yawVis: -0.4 }); api.sample(0, f);
    Object.assign(f[0]!, { s: 20, px: 20, pz: 30, head: 0.6, yawVis: -0.2 }); api.sample(1, f);
    Object.assign(f[0]!, { s: 1000, px: 1000, pz: 2000, head: 2, yawVis: 0.8, rPrevS: 999, rPrevX: undefined, rPrevPx: 999, rPrevPz: 1999, rPrevHead: 1.9, rPrevYawVis: 0.7 });
    delete f[1]!.yawVis;
    const before = f.map((c) => ({ ...c }));
    expect(api.beginScrub()).toBe(true);
    for (const time of [0, 0.5, 1]) {
      api.apply(time);
      const rec = api.at(time)!.cars[0]!, c = f[0]!;
      for (const alpha of [0, 0.5, 1]) {
        expect(c.rPrevPx! + (c.px! - c.rPrevPx!) * alpha).toBe(rec.px);
        expect(c.rPrevPz! + (c.pz! - c.rPrevPz!) * alpha).toBe(rec.pz);
      }
      expect([c.rPrevS, c.rPrevX, c.rPrevHead, c.rPrevYawVis]).toEqual([rec.s, rec.x, rec.head, rec.yawVis]);
    }
    api.endScrub();
    expect(f).toEqual(before);
    expect(Object.hasOwn(f[0]!, "rPrevX")).toBe(true);
    expect(Object.hasOwn(f[1]!, "rPrevPx")).toBe(false);
    expect(Object.hasOwn(f[1]!, "yawVis")).toBe(false);
  });

  it("retirement edge auto-tags; jumpLastTag seeks", () => {
    const f = cars(2), api = mk({ cars: f, netPlay: { active: () => false } });
    api.reset(f);
    for (let i = 0; i < HZ * 4; i++) api.sample(i / HZ, f);
    f[1]!.retired = true;
    api.sample(5, f);
    const tag = api.lastTag()!;
    expect([tag.kind, tag.car]).toEqual(["retirement", 1]);
    expect(api.beginScrub()).toBe(true);
    expect(api.jumpLastTag()).toBe(true);
    expect(Math.abs(api.status().scrubT - tag.t)).toBeLessThan(1e-6);
    api.endScrub();
  });

  it("a car crossing the start/finish line interpolates through the seam, not round the lap", () => {
    const f = cars(1), api = mk({ cars: f, track: { total: L }, netPlay: { active: () => false } });
    api.reset(f);
    Object.assign(f[0]!, { s: L - 1.3, pz: 0 }); api.sample(10, f);
    Object.assign(f[0]!, { s: 1.37, pz: 2.67 }); api.sample(10 + 1 / HZ, f);
    for (const u of [0.25, 0.5, 0.75]) {
      const s = api.at(10 + u / HZ)!.cars[0]!.s;
      const want = (L - 1.3 + 2.67 * u) % L;
      expect(s >= 0 && s < L).toBe(true);
      expect(Math.abs(((s - want + L / 2) % L + L) % L - L / 2)).toBeLessThan(1e-2);
    }
    expect(lerpCar(new Float32Array(9), Float32Array.of(10, 0, 0, 0, 0, 0, 0, 0, 0), Float32Array.of(20, 0, 0, 0, 0, 0, 0, 0, 0), 0.5)[0]).toBe(15);
  });

  it("a grid over 22 cars records instead of resetting every sample", () => {
    expect(budgetOk(24, capacityFor(24))).toBe(true);
    for (const n of [23, 24, 26]) {
      const f = cars(n), api = mk({ cars: f, netPlay: { active: () => false } });
      for (let i = 0; i < HZ * 2; i++) api.sample(i / HZ, f);
      expect(api.window().frames).toBeGreaterThanOrEqual(HZ * 2 - 1);
      expect(api.window().cars).toBe(Math.min(MAX_CARS, n));
    }
  });

  it("a red-flag re-grid is a timeline break: two segments, never blended across", () => {
    const f = cars(2), api = mk({ cars: f, netPlay: { active: () => false } });
    api.breakTimeline();
    const kA = HZ * 2 - 1, T = (k: number): number => k / HZ;
    for (let i = 0; i <= kA; i++) { for (const c of f) { c.px! += 1; c.speed = 30; } api.sample(T(i), f); }
    const a = f.map((c) => ({ px: c.px, pz: c.pz }));
    f[0]!.px! += 149; f[1]!.px! -= 5; f[0]!.speed = f[1]!.speed = 0;
    api.breakTimeline();
    expect(api.sample(T(kA + 0.4), f)).toBe(false);
    const b = f.map((c) => ({ px: c.px, pz: c.pz }));
    expect(api.sample(T(kA + 1), f)).toBe(true);
    for (let i = 2; i <= HZ; i++) { for (const c of f) c.px! += 0.5; api.sample(T(kA + i), f); }
    expect(api.window().frames).toBe(HZ * 3);
    for (const [u, want] of [[0.1, a], [0.49, a], [0.51, b], [0.9, b]] as const) {
      const snap = api.at(T(kA + u))!;
      for (let c = 0; c < 2; c++) { expect(snap.cars[c]!.px).toBe(want[c]!.px); expect(snap.cars[c]!.pz).toBe(want[c]!.pz); }
    }
  });

  it("a timeline discard does not re-tag cars that were already retired", () => {
    const f = cars(2), api = mk({ cars: f, netPlay: { active: () => false } });
    api.reset(f);
    for (let i = 0; i < HZ * 2; i++) api.sample(i / HZ, f);
    f[1]!.retired = true; api.sample(3, f);
    expect(api.lastTag()!.kind).toBe("retirement");
    api.sample(1, f); api.sample(1.5, f);
    expect(api.lastTag()).toBeNull();
    f[1]!.retired = false; api.sample(2, f);
    f[1]!.retired = true; api.sample(2.5, f);
    expect(api.lastTag()!.kind).toBe("retirement");
  });

  it("one car's teleport snaps without clearing; fast driving still blends", () => {
    const f = cars(2), api = mk({ cars: f, netPlay: { active: () => false } });
    const dt = 1 / HZ;
    for (let i = 0; i < HZ; i++) { f[0]!.px! += 3; f[0]!.speed = 90; f[1]!.px! += 1; f[1]!.speed = 30; api.sample(i / HZ, f); }
    api.pushTag("contact", 0.5, 1);
    const t = (HZ - 1) / HZ, x1 = f[1]!.px, z1 = f[1]!.pz!;
    f[0]!.px! += 3; f[1]!.pz! += 60;
    api.sample(1, f);
    const mid = api.at(t + dt * 0.25)!;
    expect(mid.cars[1]!.pz).toBe(z1);
    expect(mid.cars[1]!.px).toBe(x1);
    expect(api.at(t + dt * 0.75)!.cars[1]!.pz).toBe(z1 + 60);
    expect(Math.abs(mid.cars[0]!.px - (f[0]!.px! - 2.25))).toBeLessThan(1e-4);
    expect(api.window().frames).toBe(HZ + 1); expect(api.lastTag()!.kind).toBe("contact");
    const x0 = f[0]!.px!;
    f[0]!.px! += 90; api.sample(2, f);
    expect(Math.abs(api.at(1.5)!.cars[0]!.px - (x0 + 45))).toBeLessThan(1e-3);
  });

  it("frame controls use adjacent recorded samples across gaps and a wrapped ring", () => {
    const f = cars(1), api = mk({ cars: f, netPlay: { active: () => false } });
    for (const t of [1, 1.1, 1.5, 3]) api.sample(t, f);
    expect(api.adjacentFrame(1.1, -1)).toBe(1);
    expect(api.adjacentFrame(1.1, 1)).toBe(1.5);
    expect(api.adjacentFrame(3, 1)).toBeNull();
    expect(api.adjacentFrame(1, 2)).toBeNull();
    expect(api.beginScrub(false)).toBe(true);
    api.apply(1.5);
    expect(api.stepFrame(-1)).toBe(true);
    expect(api.status().scrubT).toBe(1.1);
    expect(api.status().scrubPlaying).toBe(false);
    api.endScrub();
  });

  it("the dock keeps contact-sheet options and refreshes changed tags without losing selection", () => {
    document.body.innerHTML = '<div><button id="pm-resume"></button></div>';
    const f = cars(1), G: ReplayHost<ReplayCar> = { cars: f, netPlay: { active: () => false }, paused: true };
    const api = createReplayBuf(G, null, { doc: document, photo: { contactSheet: async () => true } });
    for (let i = 0; i < HZ * 4; i++) api.sample(i / HZ, f);
    api.pushTag("pass", 1, 0); api.pushTag("contact", 2, 0);
    expect(api.beginScrub()).toBe(true);
    const picker = document.getElementById("pm-replay-tag") as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual(["pass · 1.0s", "contact · 2.0s"]);
    picker.value = "1";
    api.pushTag("out", 3, 0); api.tickScrub(0);
    expect(picker.options.length).toBe(3);
    expect(picker.value).toBe("1");
    expect((document.getElementById("pm-replay-sheet") as HTMLButtonElement).disabled).toBe(false);
    api.endScrub();
  });
});
