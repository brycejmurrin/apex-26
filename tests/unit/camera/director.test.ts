/** Live TV director (src/camera/director.ts). Parity against f1-game
 *  js/camera/director.js in a VM — bare (the director's own fallbacks) and with
 *  js/race/broadcast.js loaded (the shipped policy) — over a scripted 50 s race:
 *  battles forming and breaking, a retirement, a manual camera, the player's
 *  flag and auto-spectate, pause, Photo and a reset. Every tick's camMode,
 *  status, published camera and vantage call is compared with Object.is; the
 *  trace is committed as tests/fixtures/camera/director.json for CI.
 *  Assertions ported from f1-game tests/unit/director.test.mjs:33-240, :446-521
 *  (the VM-only ones; the game.js source pins are the shell's). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CAM_MODES } from "../../../src/camera/modes";
import type { Track } from "../../../src/track/core/types";
import {
  createDirector, Director, directorPolicy, type BankingFn, type BroadcastPolicy, type DirectorHost, type Fight, type RunRow,
} from "../../../src/camera/director";
import type { VantageExtra } from "../../../src/camera/modes";
import { F1_ROOT } from "../data/f1-vm";
import { expectBitExact, hasFixture, maybeWriteFixture, readFixture } from "./fixture";
import { hasCam, LOG } from "./f1-cam-vm";

/** f1-game js/race/broadcast.js:15-16, :188-240 — the policy slice the director
 *  reuses, ported here as the test's injected Broadcast. TODO(lane-race): the
 *  real src/race port replaces this. */
const EVENT_SHOTS: Record<string, string[]> = { pass: ["side", "heli", "chase"], pit: ["heli", "side"], out: ["heli", "side"], fastest: ["tcam", "chase", "side"] };
function testBroadcast(): BroadcastPolicy {
  const SHOTS = ["side", "heli", "tcam", "chase", "cinematic", "low"];
  const _fights: Array<Fight<unknown>> = [];
  return {
    SHOTS, SHOT_MIN_S: 5, SHOT_MAX_S: 14,
    battles<K>(cars: ReadonlyArray<RunRow<K>>, vScale?: number): ReadonlyArray<Fight<K>> {
      let n = 0;
      const floor = 20 * ((vScale as number) > 0 ? (vScale as number) : 1);
      for (let i = 1; i < cars.length; i++) {
        const a = cars[i - 1]!, b = cars[i]!;
        const v = Math.max(b.speed || 0, floor);
        const g = (a.prog - b.prog) / v;
        if (g < 0 || g >= 1.0) continue;
        let f = _fights[n];
        if (!f) { f = { key: null, ahead: null, gapS: 0, score: 0 }; _fights[n] = f; }
        f.key = b.key; f.ahead = a.key; f.gapS = g; f.score = g + i * 0.08;
        n++;
      }
      _fights.length = n;
      _fights.sort((x, y) => x.score - y.score);
      return _fights as Array<Fight<K>>;
    },
    shotFor(kind, onAir, n) {
      const pool = ((kind && EVENT_SHOTS[kind]) || SHOTS).filter((s) => s !== onAir);
      return pool.length ? pool[(n | 0) % pool.length]! : onAir;
    },
  };
}

interface DirApiLike {
  tick(dt: number): void;
  reset(): void;
  status(): object;
  setAutoSpectate(v: boolean): boolean;
}
interface F1Director {
  create(G: unknown, eligible?: () => boolean): DirApiLike;
  decideCut(st: unknown): { subject: unknown; kind: string | null; shot: string } | null;
  wantOn(st: unknown): boolean;
  SHOTS: string[];
  SHOT_MIN_S: number;
  SHOT_MAX_S: number;
}

function loadF1(withBroadcast: boolean, globals: Record<string, unknown> = {}): F1Director {
  const ctx = createContext({ Log: LOG, ...globals });
  const files = withBroadcast ? ["js/race/broadcast.js", "js/camera/director.js"] : ["js/camera/director.js"];
  for (const f of files) runInContext(readFileSync(path.join(F1_ROOT, f), "utf8"), ctx, { filename: f });
  return runInContext("Director", ctx) as F1Director;
}

// ── The scripted race ────────────────────────────────────────────────────
interface Car { code: string; prog: number; s: number; x: number; speed: number; px: number; pz: number; head: number; retired: boolean; finished: boolean }
const L = 5000;
const bank: BankingFn = (_t, s, x, out) => {
  if (Math.floor(s / 500) % 2) { out.dy = x * 0.1; out.roll = Math.atan2(x, 20); return out; }
  return null;
};

function race(drive: (G: DirectorHost<Car>, extra: { eligible: () => boolean; feelCalls: string[] }) => DirApiLike): unknown[] {
  const N = 6;
  const cars: Car[] = [];
  for (let i = 0; i < N; i++) cars.push({ code: "C" + i, prog: 0, s: 0, x: 0, speed: 0, px: 0, pz: 0, head: 0, retired: false, finished: false });
  const place = (t: number): void => {
    for (let i = 0; i < N; i++) {
      const c = cars[i]!;
      if (c.retired) continue;
      // Pairs close up and drift apart: battles form and break on their own.
      c.prog = 1200 - i * 35 + 61 * t + 18 * Math.sin(t * 0.37 + i * 1.3) + (i % 2 ? 12 * Math.sin(t * 0.11) : 0);
      c.speed = 50 + 9 * Math.cos(t * 0.29 + i);
      c.s = c.prog % L;
      c.x = 3 * Math.sin(t * 0.5 + i);
      c.px = c.x + Math.cos(c.s / 800) * 300;
      c.pz = Math.sin(c.s / 800) * 300;
      c.head = c.s / 800 + Math.PI / 2;
    }
  };
  const vcalls: unknown[] = [];
  const modeLog: unknown[] = [];
  let eligible = true;
  const G: DirectorHost<Car> = {
    state: "race", paused: false, photoMode: false, dbgCam: null, cars, player: cars[N - 1]!,
    track: { total: L } as unknown as Track, camMode: CAM_MODES.findIndex((m) => m.id === "tv"),
    setCamMode(i, opts) { G.camMode = i; modeLog.push([i, opts.persist]); },
    camVantage(mode: string, s: number, x: number, spd: number, now: number, e: VantageExtra) {
      vcalls.push([mode, s, x, spd, now, (e.att as Car).code, e.noLook, e.frameSubject, e.dt, e.snap, e.carPos ? [e.carPos[0], e.carPos[1]] : null, e.carHead ?? null, e.bankDy]);
      return { eye: [s * 0.5 + x, 5 + (e.bankDy as number), spd * 0.1], tgt: [s * 0.5 + x + 10, 1 + (e.bankDy as number), (e.dt as number) * 7], fov: 40 + mode.length };
    },
    camPoseOf(c) {
      const i = cars.indexOf(c);
      return i % 2 ? null : { s: c.s + 0.25, x: c.x * 0.5, carPos: [c.px, c.pz], carHead: c.head };
    },
    snapGameCam() { modeLog.push(["snap"]); },
    netPlay: { active: () => false },
    vTop: () => 72 * 0.8,
  };
  const feelCalls: string[] = [];
  const api = drive(G, { eligible: () => eligible, feelCalls });
  const out: unknown[] = [];
  const dt = 1 / 60;
  const chase = 0, tv = CAM_MODES.findIndex((m) => m.id === "tv");
  for (let k = 0; k < 3000; k++) {
    const t = k * dt;
    if (k === 900) G.camMode = chase;          // the viewer picks CHASE
    if (k === 1100) G.camMode = tv;            // …and back to TV
    if (k === 1500) cars[4]!.retired = true;   // a retirement
    if (k === 1800) G.camMode = chase;
    if (k === 2000) cars[N - 1]!.finished = true;   // the player's flag: auto-spectate
    if (k === 2400) G.paused = true;
    if (k === 2500) G.paused = false;
    if (k === 2600) { G.photoMode = true; G.dbgCam = { photo: true }; }
    if (k === 2650) { G.photoMode = false; G.dbgCam = null; }
    if (k === 2700) eligible = false;           // a WATCH takes the picture
    if (k === 2750) eligible = true;
    if (k === 2900) api.reset();
    place(t);
    vcalls.length = 0; modeLog.length = 0; feelCalls.length = 0;
    api.tick(dt);
    const cam = G.dbgCam as { eye?: number[]; target?: number[]; fov?: number; far?: number; photo?: boolean } | null;
    out.push({
      k, camMode: G.camMode, status: api.status(),
      cam: cam ? (cam.photo ? "photo" : { eye: cam.eye!.slice(), target: cam.target!.slice(), fov: cam.fov, far: cam.far }) : null,
      v: vcalls.slice(), modes: modeLog.slice(), feel: feelCalls.slice(),
    });
  }
  return out;
}

function runPort(withBroadcast: boolean): unknown[] {
  return race((G, { eligible, feelCalls }) => createDirector(G, eligible, {
    broadcast: withBroadcast ? testBroadcast() : null,
    modes: CAM_MODES,
    feel: { scoped: (p, fn) => { feelCalls.push(p); return fn(); } },
    banking: bank,
  }));
}

function runF1(withBroadcast: boolean): unknown[] {
  let feelCalls: string[] = [];
  const D = loadF1(withBroadcast, {
    CamModes: { CAM_MODES },
    CamFeel: { scoped: (p: string, fn: () => unknown) => { feelCalls.push(p); return fn(); } },
    Tracks: { banking: bank },
    PhysicsConsts: { VMAX: 72 },
  });
  return race((G, x) => { feelCalls = x.feelCalls; return D.create(G, x.eligible); });
}


/** The committed slice: every half second plus every tick that cut, switched
 *  mode or snapped (the full 3000-tick trace is compared against the VM). */
function compact(trace: unknown[]): unknown[] {
  let cuts = -1, mode = -1;
  return trace.filter((r) => {
    const x = r as { k: number; camMode: number; status: { cuts: number }; modes: unknown[] };
    const keep = x.k % 30 === 0 || x.status.cuts !== cuts || x.camMode !== mode || x.modes.length > 0;
    cuts = x.status.cuts; mode = x.camMode;
    return keep;
  });
}

describe("Director parity with f1-game director.js", () => {
  for (const bc of [false, true]) {
    const name = bc ? "director-broadcast" : "director";
    it.skipIf(!hasCam)(`${bc ? "with" : "without"} Broadcast: matches the VM bit-exactly over a scripted race`, () => {
      const f1 = runF1(bc);
      maybeWriteFixture(name, compact(f1));
      expectBitExact(runPort(bc), f1);
    });
    it(`${bc ? "with" : "without"} Broadcast: matches the committed fixture`, () => {
      expect(hasFixture(name)).toBe(true);
      expectBitExact(compact(runPort(bc)), readFixture(name));
    });
  }
  it("the scripted race exercises cuts, battles, auto-spectate and releases", () => {
    const tr = runPort(true) as Array<{ status: { cuts: number; shot: string | null }; modes: unknown[]; cam: unknown }>;
    const shots = new Set(tr.map((r) => r.status.shot));
    expect(shots.size).toBeGreaterThanOrEqual(4);
    expect(tr.some((r) => r.modes.some((m) => JSON.stringify(m) === "[18,false]"))).toBe(true);
    expect(tr.some((r) => r.modes.some((m) => JSON.stringify(m) === '["snap"]'))).toBe(true);
    expect(tr.filter((r) => r.cam === null).length).toBeGreaterThan(0);
  });
});

// ── Ported f1-game assertions ─────────────────────────────────────────────
const P = directorPolicy(testBroadcast());

describe("Director (ported assertions)", () => {
  it("decideCut holds under SHOT_MIN_S and cuts by SHOT_MAX_S onto a battle", () => {
    const a = { code: "AAA" }, b = { code: "BBB" }, c = { code: "CCC" };
    const running = [{ key: a, prog: 1000, speed: 50 }, { key: b, prog: 990, speed: 50 }, { key: c, prog: 800, speed: 50 }];
    expect(P.decideCut({ wall: 1, lastCut: 0, subject: a, onAirShot: "side", cuts: 0, running })).toBeNull();
    const mid = P.decideCut({ wall: P.SHOT_MIN_S + 0.1, lastCut: 0, subject: a, onAirShot: "side", cuts: 0, running })!;
    expect(mid.subject).toBe(b);
    expect(mid.kind).toBe("pass");
    expect(P.SHOTS).toContain(mid.shot);
    expect(mid.shot).not.toBe("side");
    const quiet = [{ key: a, prog: 1000, speed: 50 }, { key: c, prog: 500, speed: 50 }];
    expect(P.decideCut({ wall: P.SHOT_MIN_S + 1, lastCut: 0, subject: a, onAirShot: "heli", cuts: 1, running: quiet })).toBeNull();
    const forced = P.decideCut({ wall: P.SHOT_MAX_S + 0.1, lastCut: 0, subject: a, onAirShot: "heli", cuts: 2, running: quiet })!;
    expect(forced.subject === a || forced.subject === c).toBe(true);
    // The bare fallbacks agree on the decision shape.
    expect(Director.decideCut({ wall: Director.SHOT_MIN_S + 0.1, lastCut: 0, subject: a, onAirShot: "side", cuts: 0, running })!.subject).toBe(b);
  });

  it("wantOn is solo-only and requires tv mode or finished/retired auto-spectate", () => {
    expect(P.wantOn({ net: true, modeId: "tv", autoSpectate: true, finished: true })).toBe(false);
    expect(P.wantOn({ net: false, modeId: "tv", autoSpectate: false, finished: false })).toBe(true);
    expect(P.wantOn({ net: false, modeId: "chase", autoSpectate: true, finished: true })).toBe(true);
    expect(P.wantOn({ net: false, modeId: "chase", autoSpectate: true, finished: false, retired: false })).toBe(false);
    expect(P.wantOn({ net: false, modeId: "chase", autoSpectate: false, finished: true })).toBe(false);
  });

  interface SceneCar { code: string; prog: number; s: number; speed: number; x?: number; retired?: boolean; finished?: boolean }
  function cameraScene() {
    const car: SceneCar = { code: "VER", prog: 100, s: 100, speed: 50 };
    const G: DirectorHost<SceneCar> & { snapGameCam?: () => void } = {
      state: "race", paused: false, photoMode: false, camMode: 1,
      player: car, cars: [car], track: {} as Track, dbgCam: null,
      netPlay: { active: () => false },
      setCamMode(i) { G.camMode = i; },
      camVantage(_shot, s) { return { eye: [s, 5, 0], tgt: [s + 10, 2, 0], fov: 50 }; },
    };
    let eligible = true;
    const api = createDirector(G, () => eligible, { broadcast: testBroadcast(), modes: [{ id: "chase" }, { id: "tv" }], banking: null });
    return { G, car, api, eligibility(v: boolean) { eligible = v; } };
  }

  it("tick writes dbgCam from camVantage, never mutates car speed, and clears on leaving TV", () => {
    const { G, car, api } = cameraScene();
    api.tick(P.SHOT_MIN_S + 1);
    expect(G.dbgCam).toBeTruthy();
    expect(car.speed).toBe(50);
    expect(api.status().on).toBe(true);
    G.camMode = 0;
    api.tick(0.1);
    expect(G.dbgCam).toBeNull();
  });

  it("the battle pick is the same at OVERALL SPEED 0.469 as at pace 1 (vTop()/VMAX)", () => {
    const subjectAt = (pace: number): string | null => {
      const mk = (code: string, prog: number): SceneCar => ({ code, prog: prog * pace, s: prog * pace, x: 0, speed: 12 * pace, retired: false, finished: false });
      const field = [mk("LEA", 1024), mk("CHA", 1000), mk("TAI", 0)];
      const G: DirectorHost<SceneCar> = {
        state: "race", camMode: 1, cars: field, player: field[2]!, track: { total: 5000 } as unknown as Track, dbgCam: null,
        netPlay: { active: () => false }, vTop: () => 72 * pace,
        camVantage: (_m, s, x) => ({ eye: [s, 5, x], tgt: [s + 10, 2, x], fov: 50 }),
      };
      const api = createDirector(G, undefined, { broadcast: testBroadcast(), modes: [{ id: "chase" }, { id: "tv" }], banking: null });
      api.tick(1);
      return api.status().subject;
    };
    expect(subjectAt(1)).toBe("LEA");
    expect(subjectAt(0.469)).toBe(subjectAt(1));
  });

  it("WATCH or scrub ownership prevents live TV cuts and retired-seat auto-spectate", () => {
    const { G, car, api, eligibility } = cameraScene();
    eligibility(false);
    for (const mode of [0, 1]) {
      G.camMode = mode;
      for (const flag of ["finished", "retired"] as const) {
        car[flag] = true;
        api.tick(20);
        expect(G.camMode).toBe(mode);
        expect(G.dbgCam).toBeNull();
        expect(api.status().cuts).toBe(0);
        car[flag] = false;
      }
    }
    eligibility(true);
    api.tick(1);
    expect(G.dbgCam).toBeTruthy();
    eligibility(false);
    api.tick(20);
    expect(G.dbgCam).toBeNull();
  });

  it("pause holds the shot and clock without forcing a retired-seat camera", () => {
    const { G, car, api } = cameraScene();
    api.tick(1);
    const camera = G.dbgCam, status = api.status();
    const pose = JSON.parse(JSON.stringify(camera)) as unknown;
    G.paused = true;
    car.s = 400;
    api.tick(30);
    expect(G.dbgCam).toBe(camera);
    expect(JSON.parse(JSON.stringify(G.dbgCam))).toEqual(pose);
    expect(api.status()).toEqual(status);
    G.camMode = 0;
    car.retired = true;
    api.tick(30);
    expect(G.camMode).toBe(0);
    expect(G.dbgCam).toBeNull();
  });

  it("Photo and foreign debug cameras keep ownership through TV ticks, reset and exit", () => {
    const { G, api } = cameraScene();
    api.tick(1);
    const photo = { eye: [4, 8, 12], target: [14, 8, 12], fov: 70 };
    G.dbgCam = photo;
    G.photoMode = true;
    api.tick(20);
    expect(G.dbgCam).toBe(photo);
    G.photoMode = false;
    api.tick(20);
    expect(G.dbgCam).toBe(photo);
    expect(api.status().on).toBe(false);
    G.state = "menu";
    api.tick(1);
    api.reset();
    expect(G.dbgCam).toBe(photo);
    G.state = "race";
    G.dbgCam = null;
    api.tick(1);
    expect(G.dbgCam).toBeTruthy();
  });

  it("skips the running-car scan while holding a fresh shot (SHOT_MIN_S dwell)", () => {
    const car: SceneCar = { code: "VER", s: 100, x: 0, speed: 60, prog: 1000, retired: false, finished: false };
    const field: SceneCar[] = [car, { code: "HAM", s: 90, x: 0, speed: 58, prog: 990, retired: false, finished: false }];
    let carReads = 0, vantageCalls = 0;
    const G: DirectorHost<SceneCar> = {
      state: "race", camMode: 1, player: car, track: { total: 5000 } as unknown as Track, dbgCam: null,
      netPlay: { active: () => false }, setCamMode(i) { G.camMode = i; },
      get cars() { carReads++; return field; },
      camVantage(_m, s, x) { vantageCalls++; return { eye: [s, 5, x], tgt: [s + 10, 2, x], fov: 50 }; },
    };
    const api = createDirector(G, undefined, { broadcast: testBroadcast(), modes: [{ id: "chase" }, { id: "tv" }], banking: null });
    api.tick(P.SHOT_MIN_S + 1);
    expect(carReads >= 1 && !!G.dbgCam).toBe(true);
    carReads = 0; vantageCalls = 0;
    for (let i = 0; i < 60; i++) api.tick(1 / 60);
    expect(carReads).toBe(0);
    expect(vantageCalls).toBe(60);
    for (const c of field) c.retired = true;
    api.tick(1 / 60);
    expect(carReads).toBeGreaterThanOrEqual(1);
  });

  it("post-finish coverage opens on the car, rotates external shots, and respects a manual camera", () => {
    const { G, car, api } = cameraScene();
    const rival: SceneCar = { code: "NOR", prog: 800, s: 800, speed: 50 };
    (G.cars as SceneCar[]).push(rival); G.camMode = 0; car.finished = true;
    const switches: Array<{ i: number; persist: boolean }> = [];
    G.setCamMode = (i, opts) => { G.camMode = i; switches.push({ i, persist: opts.persist }); };
    const shots: Array<string | null> = [];
    for (let i = 0; i < 4; i++) { api.tick(15); shots.push(api.status().shot); expect(api.status().subject).toBe("NOR"); }
    expect(shots).toEqual(["chase", "side", "heli", "cinematic"]);
    expect(switches).toEqual([{ i: 1, persist: false }]);
    G.camMode = 0; api.tick(1);
    expect(G.dbgCam).toBeNull();
    api.tick(20);
    expect(G.camMode).toBe(0);
    G.camMode = 1; api.tick(1);
    expect(api.status().on).toBe(true);
    api.reset();
    expect(G.camMode).toBe(0);
    api.tick(1);
    expect(api.status().shot).toBe("chase");
  });

  it("manual TV handoff snaps to the player's camera once; other owners keep authority", () => {
    for (const state of [{}, { paused: true }, { finished: true }] as Array<{ paused?: boolean; finished?: boolean }>) {
      const { G, car, api } = cameraScene();
      car.finished = !!state.finished;
      api.tick(1);
      let snaps = 0;
      G.snapGameCam = () => { expect(G.dbgCam).toBeNull(); snaps++; };
      G.paused = !!state.paused; G.camMode = 0;
      api.tick(1); api.tick(1);
      expect(snaps).toBe(1);
    }
    for (const owner of ["photo", "foreign", "replay", "reset"]) {
      const { G, api, eligibility } = cameraScene();
      api.tick(1);
      G.snapGameCam = () => { expect.fail(`${owner} retains camera authority`); };
      G.camMode = 0;
      if (owner === "photo") G.photoMode = true;
      if (owner === "foreign") G.dbgCam = { eye: [100, 5, 0] };
      if (owner === "replay") eligibility(false);
      if (owner === "reset") api.reset(); else api.tick(1);
    }
  });

  it("the director's follows run under CamFeel's tv: scope", () => {
    const scopes: string[] = [];
    const car: SceneCar = { code: "VER", prog: 100, s: 100, speed: 50 };
    const G: DirectorHost<SceneCar> = {
      state: "race", camMode: 1, player: car, cars: [car], track: {} as Track, dbgCam: null,
      camVantage: (_m, s) => ({ eye: [s, 5, 0], tgt: [s + 10, 2, 0], fov: 50 }),
    };
    createDirector(G, undefined, { modes: [{ id: "chase" }, { id: "tv" }], banking: null, feel: { scoped: (p, fn) => { scopes.push(p); return fn(); } } }).tick(1);
    expect(scopes).toEqual(["tv:"]);
  });
});
