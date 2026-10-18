/**
 * EXTRA player camera rigs (src/camera/extra-rigs.ts): f1-game
 * tests/unit/extra-rigs.test.mjs ported (pickRival with and without a battle
 * finder, the OVERALL SPEED crawl floor, finite poses for every mode, the pit
 * auto-cut and its opt-in), plus the rigs' poses around a lap held bit for bit
 * against f1-game's ExtraRigs — on an analytic world both sides share (and a
 * committed fixture of it, which always runs) and, where f1-game is present,
 * on its built Monza.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createExtraRigs, localBattles, type ExtraRigsDeps, type PitAutoCtx, type RigCar, type RigExtra, type RigTrackOps } from "../../../src/camera/extra-rigs";
import { createFlybySeq, type FlybyTrack, type Vec3 } from "../../../src/camera/flyby-seq";
import type { CamStore } from "../../../src/camera/store";
import type { Sample } from "../../../src/track/core/types";
import { mapStore } from "./f1-cam-vm";
import { bitDiff, F1, f1Cam, haveF1 } from "./f1-flyby-vm";
import { asJson, f1Vm, haveF1Photo, maybeWriteFixture, plainDeep, readFixture } from "./f1-photo-vm";

type Rigs = ReturnType<typeof createExtraRigs>;
const MODES = [{ id: "chase" }, { id: "far" }, { id: "visor" }, { id: "rival" }, { id: "pitwall" }, { id: "drone" }];

/** extra-rigs.test.mjs loadExtraRigs(): a straight road along +X. */
const straight: RigTrackOps = {
  sample(track, s, out) {
    const L = track.total || 1000;
    let v = s % L; if (v < 0) v += L;
    out.p[0] = v; out.p[1] = 0; out.p[2] = 0;
    out.t[0] = 1; out.t[1] = 0; out.t[2] = 0;
    out.r[0] = 0; out.r[1] = 0; out.r[2] = 1;
    out.hw = 7;
  },
  curvature: () => 0,
  pitLaneAt: () => null,
};
function load(extra: Partial<ExtraRigsDeps> = {}) {
  const store = mapStore();
  const rigs = createExtraRigs({ tracks: straight, camTune: { cornerLead: () => null }, camModes: () => MODES, store, ...extra });
  return { rigs, store };
}

describe("ExtraRigs (extra-rigs.test.mjs)", () => {
  it("pickRival uses the injected battle finder (Broadcast.battles) when present", () => {
    const a: RigCar = { prog: 100, speed: 50, s: 100, x: 0 };
    const b: RigCar = { prog: 80, speed: 50, s: 80, x: 0 };
    const { rigs } = load({ battles: (<K>() => [{ key: b, ahead: a, gapS: 0.4, score: 0.4 }] as unknown as { key: K; ahead: K; gapS: number; score: number }[]) });
    expect(rigs.pickRival([a, b], a)).toBe(b);
    expect(rigs.pickRival([a, b], b)).toBe(a);
  });

  it("pickRival falls back to nearest car within FALLBACK_S", () => {
    const { rigs } = load();
    const player: RigCar = { prog: 100, speed: 40, s: 100, x: 0 };
    const near: RigCar = { prog: 60, speed: 40, s: 60, x: 0 };   // 1.0 s gap
    const far: RigCar = { prog: 0, speed: 40, s: 0, x: 0 };      // 2.5 s gap — on the edge
    expect(rigs.pickRival([player, near, far], player)).toBe(near);
    expect(rigs.pickRival([player], player)).toBe(null);
  });

  it("RIVAL LOCK picks the same rival at OVERALL SPEED 0.469 as at pace 1; WATCH keeps real m/s (4-F6)", () => {
    const rivalAt = (k: number, pace: number, broadcast: boolean, watch?: boolean): string => {
      const { rigs } = load({ vmax: 72, ...(broadcast ? { battles: localBattles } : {}) });
      const car = (code: string, prog: number): RigCar & { code: string } => ({ code, prog: prog * k, s: prog * k, x: 0, speed: 12 * k, ...(watch ? { replayRate: 1 } : {}) });
      const X = car("X", 1022), P = car("P", 1000), Y = car("Y", 980);
      rigs.tickPitAuto({ vTop: () => 72 * pace, player: P, camMode: 0 });
      return (rigs.pickRival([X, P, Y], P) as { code: string }).code;
    };
    for (const broadcast of [false, true]) {
      expect(rivalAt(1, 1, broadcast)).toBe("Y");
      expect(rivalAt(0.469, 0.469, broadcast)).toBe("Y");
      expect(rivalAt(0.469, 1, broadcast, true)).toBe("X");
      expect(rivalAt(0.469, 0.469, broadcast, true)).toBe("X");
    }
  });

  it("solve returns finite eye/tgt/fov for rival, pitwall, drone", () => {
    const { rigs } = load();
    const track = { total: 1000, pit: { side: 1 }, def: {} } as unknown as FlybyTrack;
    const eye: Vec3 = [0, 0, 0], tgt: Vec3 = [0, 0, 0];
    for (const mode of ["rival", "pitwall", "drone"]) {
      const fov = rigs.solve(mode, track, 100, 0, 50, 0, { bankDy: 0, reduceMotion: false, carPos: [100, 0], carHead: 0, snap: true }, eye, tgt)!;
      expect(Number.isFinite(fov) && fov > 20 && fov < 110, mode).toBe(true);
      expect(eye.every(Number.isFinite) && tgt.every(Number.isFinite), mode).toBe(true);
      expect(Math.hypot(eye[0] - tgt[0], eye[2] - tgt[2]), mode).toBeGreaterThan(1);
    }
    expect(rigs.solve("chase", track, 100, 0, 50, 0, null, eye, tgt)).toBe(null);
  });

  it("tickPitAuto cuts to pitwall on entry and restores on exit", () => {
    const { rigs } = load();
    let mode = 0;
    const G: PitAutoCtx & { player: { pitState: string } } = {
      player: { pitState: "none" },
      get camMode() { return mode; }, set camMode(v) { mode = v; },
      setCamMode(i) { mode = i; return "x"; },
      store: { get: () => true, set() { return true; } } as unknown as CamStore,
    };
    G.player.pitState = "lane";
    expect(rigs.tickPitAuto(G)).toBe("pitwall");
    expect(mode).toBe(4);
    G.player.pitState = "none";
    expect(rigs.tickPitAuto(G)).toBe("chase");
    expect(mode).toBe(0);
  });

  it("tickPitAuto leaves the camera alone by default (opt-in only)", () => {
    const { rigs } = load();
    let mode = 0;
    const G: PitAutoCtx & { player: { pitState: string } } = {
      player: { pitState: "none" },
      get camMode() { return mode; }, set camMode(v) { mode = v; },
      setCamMode(i) { mode = i; return "x"; },
      store: { get: (_k: string, d: unknown) => d, set() { return true; } } as unknown as CamStore,
    };
    G.player.pitState = "lane";
    expect(rigs.tickPitAuto(G)).toBe(null);
    expect(mode).toBe(0);
    G.player.pitState = "none";
    expect(rigs.tickPitAuto(G)).toBe(null);
    expect(mode).toBe(0);
  });

  it("pitCamAuto persists through the store (a26.pitCamAuto)", () => {
    const { rigs, store } = load();
    expect(rigs.pitCamAuto(null)).toBe(false);
    expect(rigs.pitCamAuto(null, false)).toBe(false);
    expect(store.disk.get("pitCamAuto")).toBe(false);
    expect(rigs.pitCamAuto(null)).toBe(false);
    expect(rigs.pitCamAuto(null, true)).toBe(true);
    expect(store.disk.get("pitCamAuto")).toBe(true);
  });

  it("pickRival reuses its running-car rows and array across calls", () => {
    const a: RigCar = { prog: 100, speed: 50, s: 100, x: 0 };
    const b: RigCar = { prog: 80, speed: 50, s: 80, x: 0 };
    const seen: { arr: unknown[]; rows: unknown[] }[] = [];
    const { rigs } = load({ battles: (<K>(cars: { key: K }[]) => { seen.push({ arr: cars, rows: cars.slice() }); return []; }) as NonNullable<ExtraRigsDeps["battles"]> });
    rigs.pickRival([a, b], a);
    rigs.pickRival([b, a], a);
    expect(seen[0]!.arr).toBe(seen[1]!.arr);
    expect(seen[1]!.rows.every((r) => seen[0]!.rows.includes(r))).toBe(true);
    expect(seen[1]!.arr.length).toBe(2);
    expect((seen[1]!.arr[0] as { key: RigCar }).key).toBe(a);
  });

  it("C12: resetAuto clears the pit auto-cut bookkeeping (cam-round2.test.mjs)", () => {
    const { rigs } = load({ camModes: () => [{ id: "chase" }, { id: "pitwall" }] });
    const G: PitAutoCtx & { player: { pitState: string } } = {
      player: { pitState: "none" }, camMode: 0, store: { get: () => true } as unknown as CamStore,
      setCamMode(i) { G.camMode = i; },
    };
    G.player.pitState = "in";
    expect(rigs.tickPitAuto(G)).toBe("pitwall");
    rigs.resetAuto();                 // the player quit the race mid auto-cut
    G.camMode = 0; G.player.pitState = "none";
    expect(rigs.tickPitAuto(G)).toBe(null);
  });

  it("C13: the drone's steady-state lag behind a moving car is the same at 30, 60 and 144 Hz (cam-round2.test.mjs)", () => {
    const lag = (hz: number): number => {
      const { rigs } = load();
      const track = { total: 5000 } as unknown as FlybyTrack, V = 60, dt = 1 / hz;
      const eye: Vec3 = [0, 0, 0], tgt: Vec3 = [0, 0, 0];
      let carX = 0;
      for (let f = 0; f < 4 * hz; f++) {
        carX = 100 + V * f * dt;
        rigs.solve("drone", track, carX, 0, V, 0, { carPos: [carX, 0], carHead: Math.PI / 2, dt: f ? dt : 0, snap: !f }, eye, tgt);
      }
      return carX - eye[0];
    };
    const l30 = lag(30), l60 = lag(60), l144 = lag(144);
    expect(Math.abs(l30 - l144) < 0.15 && Math.abs(l60 - l144) < 0.15, `${l30} / ${l60} / ${l144}`).toBe(true);
  });
});

// ---- poses around a lap, bit for bit --------------------------------------

/** An analytic closed circuit both sides read: a lumpy loop with banked heights, a pit lane and a "building". */
const L = 2400, R = 380;
function world() {
  const sample = (_t: FlybyTrack, s: number, out: Sample): Sample => {
    const th = 2 * Math.PI * s / L;
    const x = R * Math.cos(th) + 60 * Math.cos(3 * th), z = R * Math.sin(th) + 25 * Math.sin(2 * th);
    const dx = -R * Math.sin(th) - 180 * Math.sin(3 * th), dz = R * Math.cos(th) + 50 * Math.cos(2 * th);
    const l = Math.hypot(dx, dz) || 1;
    out.p[0] = x; out.p[1] = 4 * Math.sin(2 * th) + 1.5; out.p[2] = z;
    out.t[0] = dx / l; out.t[1] = 0; out.t[2] = dz / l;
    out.r[0] = -dz / l; out.r[1] = 0; out.r[2] = dx / l;
    out.hw = 7 + 2 * Math.sin(5 * th);
    return out;
  };
  const tracks: RigTrackOps = {
    sample,
    curvature: (_t, s) => 0.004 * Math.sin(4 * Math.PI * s / L) + (s % 600 < 80 ? 0.02 : 0),
    pitLaneAt: (_t, s) => (s > 150 && s < 420 ? { centre: -11, outer: s < 300 ? -15.5 : null } : null),
  };
  const insideProp = (_t: FlybyTrack, p: Readonly<Vec3>, m?: number | null) =>
    (Math.hypot(p[0] - R, p[2]) < 22 + (m || 0) || (p[0] < -300 && p[2] > 40 && p[2] < 90 + (m || 0)) ? { kind: "building", x: 0, y: 0, z: 0, w: 1, h: 1, d: 1 } : null);
  // A deterministic CamFeel.follow stand-in (the real one's damping: feel.js:146-174).
  const fol = new Map<string, number>();
  const feel = { follow(key: string, target: number, lam: number, dt: number): number {
    if (!(dt > 0)) { fol.set(key, target); return target; }
    const cur = fol.get(key);
    const next = cur == null ? target : target + (cur - target) * Math.exp(-lam * dt);
    fol.set(key, next); return next;
  } };
  const camTune = { cornerHang: (m: string) => (m === "drone" ? 0.85 : null), cornerLead: (_m: string) => null as number | null };
  return { tracks, insideProp, feel, camTune };
}
const TRACK = { total: L, pit: { side: -1 }, def: {} } as unknown as FlybyTrack;

/** Every rig around a lap, plus the rival pick and the pit auto-cut over a race's worth of states. */
function lapScript(rigs: Rigs, track: FlybyTrack, n: number, setLead?: (v: number | null) => void): unknown {
  const out: unknown[] = [];
  const eye: Vec3 = [0, 0, 0], tgt: Vec3 = [0, 0, 0];
  const total = track.total;
  const rival: RigCar = { s: 0, x: 2, prog: 0, speed: 60 };
  for (let i = 0; i <= n; i++) {
    const s = (i + 0.31) / n * total, x = 3.5 * Math.sin(i * 0.7), spd = 35 + 30 * Math.sin(i * 0.13);
    const dt = i % 7 === 3 ? 0 : (i % 3 === 0 ? 1 / 144 : 1 / 60);
    (rival as { s: number }).s = s + (i % 2 ? 40 : -25); (rival as { prog: number }).prog = i % 2 ? 1e4 : -1;
    const ex: RigExtra = {
      bankDy: 0.2 * Math.cos(i), dt, snap: i === 0 || i === Math.floor(n / 2), reduceMotion: i > n * 0.75,
      ...(i % 5 === 0 ? {} : { carPos: [Math.cos(i) * 300, Math.sin(i) * 300] as const, carHead: i * 0.37 }),
      ...(i % 4 === 1 ? {} : { rival, playerProg: 5000 }),
    };
    if (setLead) setLead(i % 9 === 4 ? 0.3 : null);
    const row: unknown[] = [];
    for (const mode of ["rival", "pitwall", "drone"]) {
      const fov = rigs.solve(mode, track, s, x, spd, i * 16, ex, eye, tgt);
      row.push([fov, eye[0], eye[1], eye[2], tgt[0], tgt[1], tgt[2]]);
    }
    if (i === Math.floor(n / 3)) rigs.reset("drone");
    out.push(row);
  }
  // pickRival over a shuffled field, and the auto-cut through two pit stops.
  const field: (RigCar & { code: string })[] = [];
  for (let k = 0; k < 9; k++) field.push({ code: "C" + k, prog: 900 - k * 23 + (k % 3) * 9, speed: 40 + k, s: 0, x: 0, rank: k + 1, ...(k === 4 ? { pitState: "lane" } : {}), ...(k === 6 ? { retired: true } : {}) });
  const picks = field.map((p) => (rigs.pickRival(field, p) as { code: string } | null)?.code ?? null);
  let mode = 1;
  const store = mapStore({ pitCamAuto: true });
  const G = { vTop: () => 60, player: { pitState: "none" } as RigCar & { pitState: string }, store: store as unknown as CamStore,
    get camMode() { return mode; }, set camMode(v: number) { mode = v; } };
  const cuts: unknown[] = [];
  for (const ps of ["none", "entry", "lane", "box", "none", "none", "lane", "none"]) {
    G.player.pitState = ps;
    if (ps === "box") mode = 2;      // the player left PIT WALL by hand mid-stop
    cuts.push([rigs.tickPitAuto(G), mode]);
  }
  return plainDeep({ poses: out, picks, cuts, after: rigs.pickRival(field, field[0]) && (rigs.pickRival(field, field[0]) as { code: string }).code });
}

function portRigs() {
  const w = world();
  let lead: number | null = null;
  const rigs = createExtraRigs({ tracks: w.tracks, flyby: { insideProp: w.insideProp }, feel: w.feel, camTune: { cornerHang: w.camTune.cornerHang, cornerLead: () => lead }, camModes: () => MODES, vmax: 72 });
  return lapScript(rigs, TRACK, 96, (v) => { lead = v; });
}

describe("rig poses around a lap", () => {
  it("match the committed f1-game reference (tests/fixtures/camera/extra-rigs-lap.json)", () => {
    expect(asJson(portRigs())).toEqual(readFixture("extra-rigs-lap.json"));
  });

  it.skipIf(!haveF1Photo)("match f1-game's ExtraRigs bit for bit on the shared analytic world", () => {
    const w = world();
    let lead: number | null = null;
    const vm = f1Vm(null, ["js/core/mat4.js", "js/camera/extra-rigs.js"], {
      Log: { info() {} }, Tracks: w.tracks, FlybySeq: { insideProp: w.insideProp }, CamFeel: w.feel,
      CamTune: { cornerHang: w.camTune.cornerHang, cornerLead: () => lead },
      CamModes: { CAM_MODES: MODES }, PhysicsConsts: { VMAX: 72 },
    });
    const want = lapScript(vm.get<Rigs>("ExtraRigs"), TRACK, 96, (v) => { lead = v; });
    const got = portRigs();
    expect(bitDiff(got, want)).toEqual([]);
    maybeWriteFixture("extra-rigs-lap.json", asJson(want));
  });
});

describe.skipIf(!haveF1 || !haveF1Photo)("rig poses around Monza vs f1-game (its built track, real Tracks and FlybySeq)", () => {
  it("rival / pitwall / drone over a lap", () => {
    const f1 = f1Cam();
    const track = f1.track("monza");
    const ctx = f1.sandbox;
    const file = "js/camera/extra-rigs.js";
    if (!ctx["ExtraRigs"]) runInContext(readFileSync(path.join(F1, file), "utf8").replace(/^const\b/gm, "var"), ctx, { filename: file });
    const P = createFlybySeq({ corners: (def) => f1.TrackMaps.corners(def) });
    const port = createExtraRigs({ flyby: P });
    const want = lapScript(ctx["ExtraRigs"] as Rigs, track, 160);
    const got = lapScript(port, track, 160);
    expect(bitDiff(got, want)).toEqual([]);
  }, 600_000);
});
