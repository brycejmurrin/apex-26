/**
 * FlybySeq (src/camera/flyby-seq.ts): f1-game tests/unit/flyby-shots.test.mjs
 * and flyby-pose-inverse.test.mjs, ported to the TS sequencer.
 *
 * - Always run: pure helpers, the hero drive on a synthetic straight, vary(),
 *   the slot fit, and hard-coded spot frames on this repo's own Monaco build
 *   (src/track/core, no props; corners pinned from f1-game's TrackMaps).
 * - With f1-game present: the same spot frames from f1-game's FlybySeq on the
 *   same TS-built track, and the shot-quality assertions of flyby-shots.test.mjs
 *   run by the PORT on f1-game's full builds (props registry included).
 */
import { describe, expect, it } from "vitest";
import {
  boundaries, createFlybySeq, DEFAULT, EASE, GRID_SHOTS, GRID_SPACING, gridProgress, isSolid, loadingPresenter, onRoadPose,
  PAN_MAX, PARA_MAX, POLE_BACK, REF_S, shotAt, swayAt, warmProgress,
  type FlybyCorner, type FlybyPose, type FlybyShot, type FlybyTrack, type HeroCar, type Vec3,
} from "../../../src/camera/flyby-seq";
import * as Sight from "../../../src/camera/flyby-sight";
import { resolve as resolveOverrides } from "../../../src/data/flyby-overrides";
import { gridSlot } from "../../../src/track/core/mesh";
import { buildTrack, curvature, defById, project, sample, wallAt } from "../../../src/track/core/tracks";
import type { Sample, Track } from "../../../src/track/core/types";
import { f1Cam, haveF1, type F1Cam } from "./f1-cam-vm";

const newSample = (): Sample => ({ p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 10 });

/** f1-game TrackMaps.corners(monaco) {f, r} (js/ui/track-maps.js:139), pinned. */
const MONACO_CORNERS: FlybyCorner[] = [
  { f: 0.06659999999999999, r: 18.672678444239573 }, { f: 0.15159999999999996, r: 115.19053689288955 },
  { f: 0.22867510045892092, r: 66.60499543292806 }, { f: 0.23409999999999997, r: 50.920921883801704 },
  { f: 0.26867510045892096, r: 43.585734534969056 }, { f: 0.2742, r: 33.307542257810795 },
  { f: 0.3439070040183567, r: 17.97937046784898 }, { f: 0.34632489954107903, r: 21.973836338183215 },
  { f: 0.38339999999999996, r: 10.137172420922743 }, { f: 0.40769999999999995, r: 16.541575748427256 },
  { f: 0.4344000000000001, r: 16.088089090768303 }, { f: 0.6407000000000003, r: 17.96733389632703 },
  { f: 0.7170999999999998, r: 28.146530292306668 }, { f: 0.7226248995410791, r: 117.68427795839408 },
  { f: 0.763892995981643, r: 30.65646266411844 }, { f: 0.8227, r: 19.75628375817151 },
  { f: 0.8791751004589208, r: 15.470788210230724 }, { f: 0.8797000000000001, r: 15.250608799792035 },
  { f: 0.9064000000000001, r: 19.07104612556987 },
];
/** solve(u) on the TS-built Monaco with MONACO_CORNERS: [eye, tgt, fov], as f1-game's FlybySeq computes them. */
const MONACO_SPOTS: [number, string, number[]][] = [
  [0.04, "wide", [-258.3768001620296, 197.35998601868187, -496.86560872824, 40.304271564223896, 134.67520857254416, 46.485804725438385, 36.79012345679013]],
  [0.2, "landmark1", [380.2329382312298, 203.86351955766335, -212.01502677677655, 40.304271564223896, 145.17281464159575, 46.485804725438385, 38.44444444444444]],
  [0.33, "landmark2", [-217.89742011613708, 126.33847637466151, -244.1051254559758, 40.304271564223896, 90.90528441349444, 46.485804725438385, 40.90625]],
  [0.43, "turn-first", [355.01136139055416, 8.141936773175864, 1.448148293517798, 331.99538349716295, 1.5235194030526782, 27.417188923464135, 42]],
  [0.52, "turn-mid", [-283.69826095056345, 29.073097665174338, 408.69304378173825, -317.29805519038064, 20.651882471445642, 397.9269370040285, 44]],
  [0.61, "turn-late", [300.1684982827606, 4.20532479598669, -9.69526962980234, 308.2467098689873, 0.09597460585345141, -40.12136540041239, 43]],
  [0.7, "grid-crane", [323.4739772876565, 2.080552744741412, -371.06853731534835, 340.44259806501924, 0.8414604030287272, -311.6181897781184, 30.049382716049383]],
  [0.78, "grid-front", [359.6287285387516, 2.352271643280983, -193.59650636836886, 359.94222312306533, 0.6432661359479234, -219.76928207000336, 40]],
  [0.88, "grid-mine", [337.4306437889806, 1.9349541455121588, -314.90706836601015, 344.88638018985705, 0.87225652938728, -287.9566280790466, 36]],
  [0.96, "grid-mine", [340.563034286614, 1.6073690778943976, -303.79497244402336, 364.445504230657, 1.2195086442958178, -178.01999859310575, 39.55555555555556]],
];

let monacoTs: FlybyTrack | null = null;
const tsMonaco = (): FlybyTrack => (monacoTs ??= buildTrack(defById("monaco")!) as FlybyTrack);

/** A straight road along +z (hw 10, right = +x, y = 3), `n` nodes over `total` metres. */
function straight(total: number, n: number, line?: (s: number) => number): Track {
  const f = (v: (i: number) => number) => Float32Array.from({ length: n }, (_, i) => v(i));
  const t = {
    n, total, px: f(() => 0), py: f(() => 3), pz: f((i) => i * total / n), tx: f(() => 0), ty: f(() => 0), tz: f(() => 1),
    rx: f(() => 1), ry: f(() => 0), rz: f(() => 0), hw: f(() => 10), bank: f(() => 0),
    def: { id: "straight", street: false }, street: false, meshes: {}, map: null,
  } as unknown as Track;
  if (line) { t.line = f((i) => line(i * total / n)); t.lineW = f(() => 1); }
  return t;
}

describe("FlybySeq: pure parts (always run)", () => {
  it("#1575: boundaries drive a 150 ms dip, slower under reduced motion, and expose wide-sector progress", () => {
    const F = createFlybySeq();
    const shots: FlybyShot[] = [{ id: "wide", dur: 0.25, eye: [], look: [] }, { id: "turn", dur: 0.25, eye: [], look: [] }, { id: "wide2", dur: 0.5, eye: [], look: [] }];
    expect(boundaries(shots)).toEqual([0.25, 0.5]);
    F.setDuration(20000);
    expect(F.presentation(0.25, shots, false).dipMs).toBe(150);
    expect(F.presentation(0.25, shots, true).dipMs).toBe(300);
    expect(F.presentation(0.25, shots, false).dip).toBe(1);
    expect(F.presentation(0.1, shots, false).dip).toBe(0);
    expect(F.presentation(0.125, shots, false).sectors).toBe(0.5);
    expect(F.presentation(0.375, shots, false).sectors).toBe(0);
    expect(F.presentation(0.75, shots, false).sectors).toBe(1);
  });

  it("#1575: a per-shot sway is optional and disabled under reduced motion", () => {
    const sh = (o: Partial<FlybyShot>): FlybyShot => ({ eye: [], look: [], ...o });
    expect(swayAt(sh({ sway: 0.4 }), 0.25, false)).toBe(0.4);
    expect(swayAt(sh({}), 0.25, false)).toBe(0);
    expect(swayAt(sh({ sway: 0.4 }), 0.25, true)).toBe(0);
  });

  it("#1571: the flyby hero reaches the apex at mid-shot on the racing line", () => {
    const speedReads: number[] = [];
    const F = createFlybySeq({ speedAt: (s) => { speedReads.push(s); return 40 + s / 100; } });
    const cars: HeroCar[] = [
      { isPlayer: true, s: 10, x: 0, px: 0, pz: 10, speed: 0 },
      { isPlayer: false, s: 20, x: 0, px: 0, pz: 20, speed: 0 },
    ];
    // f1-game stubs TrackLine.at as 2 + s/1000; here it is the track lane's line.ts at() on a
    // baked Float32Array line, so the lateral is that value at float32 precision.
    const track = straight(1000, 100, (s) => 2 + s / 1000) as FlybyTrack;
    const hero = F.driveHero(track, 300, 0.5, 3, cars);
    expect(hero).toBe(cars[0]);
    expect(hero!.s).toBe(300);
    expect(hero!.x).toBe(Math.fround(2.3));
    expect(hero!.speed).toBe(43);
    expect(speedReads).toEqual([300, 300]);
    expect(hero!.px).toBe(Math.fround(2.3));
    expect(hero!.pz).toBe(300);
    // A new field (or none) puts the previous hero back on its grid box.
    F.setHeroCars(null);
    expect(cars[0]).toMatchObject({ s: 10, x: 0, px: 0, pz: 10, speed: 0 });
    // No DrivingLine: the hero stays parked (f1-game's typeof guard).
    expect(createFlybySeq().driveHero(track, 300, 0.5, 3, cars)).toBeNull();
  });

  it("sparse scenery hulls are not treated as solid; a road pose is |x| <= 8, y <= 6", () => {
    const r = (o: object) => ({ kind: "structure", x: 0, y: 0, z: 0, w: 1, d: 1, h: 1, ...o });
    expect(isSolid(r({ fill: 0.05, h: 1.3 }))).toBe(false);
    expect(isSolid(r({ fill: 0.6, h: 12 }))).toBe(true);
    expect(isSolid(r({ kind: "building", h: 14 }))).toBe(true);
    expect(isSolid(r({ kind: "bush", h: 1.2 }))).toBe(false);
    expect(onRoadPose({ at: "pole", x: 3.5, y: 2.2 })).toBe(true);
    expect(onRoadPose({ at: "corner", x: 16, y: 9 })).toBe(false);
    expect(onRoadPose({ at: "centre" })).toBe(false);
  });

  it("shotAt / warmProgress / gridProgress / the shipped constants", () => {
    const u = warmProgress();
    expect(u > 0 && u < 1).toBe(true);
    expect(shotAt(u).id).toBe("turn-first");
    expect(shotAt(0).id).toBe("wide");
    expect(warmProgress([{ id: "wide", dur: 1, eye: [], look: [] }])).toBe(0);
    expect(shotAt(2).index).toBe(DEFAULT.length - 1);   // beyond 1 holds the last frame
    expect([gridProgress(1), gridProgress(3), gridProgress(9)]).toEqual([0.5 / 3, 2.5 / 3, 2.5 / 3]);
    expect(GRID_SHOTS.map((s) => s.id)).toEqual(["grid-walk", "grid-crane", "grid-front", "grid-mine"]);
    expect(DEFAULT.map((s) => s.id)).toEqual(["wide", "wide2", "landmark1", "landmark2", "turn-first", "turn-mid", "turn-late",
      "grid-walk", "grid-crane", "grid-front", "grid-mine"]);
    expect(REF_S).toBe(20);
    expect(PAN_MAX * 180 / Math.PI).toBeCloseTo(25, 12);
    expect(PARA_MAX * 180 / Math.PI).toBeCloseTo(30, 12);
    expect(EASE["inOut"]!(0.25)).toBe(0.125);
  });

  it("vary: one seed, one sequence; every variant keeps the ids, the grid close and unique corner roles", () => {
    const F = createFlybySeq();
    const D = JSON.stringify(DEFAULT);
    expect(JSON.stringify(F.vary(DEFAULT, 7))).toBe(JSON.stringify(F.vary(DEFAULT, 7)));
    let differs = 0;
    for (let seed = 0; seed < 16; seed++) {
      const v = F.vary(DEFAULT, seed);
      expect(v.map((s) => s.id)).toEqual(DEFAULT.map((s) => s.id));
      expect(JSON.stringify(v.filter((s) => /^grid/.test(s.id!)))).toBe(JSON.stringify(DEFAULT.filter((s) => /^grid/.test(s.id!))));
      const roles = v.filter((s) => s.eye[0]!.at === "corner").map((s) => s.eye[0]!.n);
      expect(new Set(roles).size).toBe(roles.length);
      if (JSON.stringify(v) !== D) differs++;
    }
    expect(differs).toBeGreaterThanOrEqual(12);
    expect(JSON.stringify(DEFAULT)).toBe(D);
  });

  it("a random grid drops your car's shot; a grid too small for a numbered slot drops the walk; withoutGrid keeps the circuit", () => {
    const F = createFlybySeq();
    const ids = (l: readonly FlybyShot[]) => l.map((s) => s.id);
    F.setPlayerSlot(11, 22);
    expect(ids(F.vary(DEFAULT, 5))).toContain("grid-mine");
    F.setPlayerSlot(null, 22);
    expect(F.slotKnown()).toBe(false);
    const v = F.vary(DEFAULT, 5);
    expect(ids(v)).not.toContain("grid-mine");
    expect(v.length).toBe(DEFAULT.length - 1);
    F.setPlayerSlot(0, 1);
    const tt = ids(F.vary(DEFAULT, 3));
    expect(tt.includes("grid-walk") || !tt.includes("grid-mine")).toBe(false);
    F.setPlayerSlot(1, 2);
    expect(ids(F.withoutSlot(DEFAULT))).not.toContain("grid-walk");
    F.setPlayerSlot(11, 22);
    expect(F.withoutSlot(DEFAULT)).toBe(DEFAULT);
    const out = ids(F.withoutGrid(DEFAULT));
    expect(out.length > 0 && out.length < DEFAULT.length).toBe(true);
    expect(out.some((id) => id!.indexOf("grid") === 0)).toBe(false);
    expect(out).toContain("wide");
    expect(out).toContain("turn-first");
    F.setPlayerSlot(-1);
    expect(F.slotIndex({ at: "slot", n: "player" })).toBe(11);
  });

  it("per-circuit overrides (src/data/flyby-overrides) patch DEFAULT by id without mutating it", () => {
    const snap = JSON.stringify(DEFAULT);
    const list = resolveOverrides("monaco", DEFAULT);
    expect(list).not.toBe(DEFAULT);
    expect(list.map((s) => s.id)).toEqual(DEFAULT.map((s) => s.id));
    expect(list.find((s) => s.id === "turn-mid")!.fov).toEqual([34, 38]);
    expect(resolveOverrides("monza", DEFAULT)).toBe(DEFAULT);
    expect(JSON.stringify(DEFAULT)).toBe(snap);
    // The patched shot plays: its corner is a plain number the sequencer binds as authored.
    const F = createFlybySeq({ corners: () => MONACO_CORNERS });
    expect(F.bindCorners(tsMonaco(), list).find((s) => s.id === "turn-mid")!.eye[0]!.n).toBe(8);
  });

  it("loadingPresenter writes the #loading dataset and dips on a cut", () => {
    const anims: unknown[] = [];
    const el = { dataset: { phase: "run" } as Record<string, string>, animate: (k: unknown) => { anims.push(k); } };
    const present = loadingPresenter(el as unknown as HTMLElement);
    present({ dip: 0, dipMs: 150, sectors: 0.5 }, false);
    expect(el.dataset["sectors"]).toBe("0.500");
    expect(anims.length).toBe(0);
    present({ dip: 1, dipMs: 150, sectors: 0 }, true);
    expect(el.dataset["sectors"]).toBe("");
    expect(el.dataset["dip"]).toBe("");
    expect(anims.length).toBe(1);
  });
});

describe("FlybySeq on this repo's Monaco build (always run)", () => {
  it("spot frames are f1-game's numbers", () => {
    const track = tsMonaco();
    const F = createFlybySeq({ corners: () => MONACO_CORNERS });
    F.setDuration(20000);
    for (const [u, id, want] of MONACO_SPOTS) {
      const v = F.solve(track, u);
      expect(v.id).toBe(id);
      const got = [...v.eye, ...v.tgt, v.fov];
      for (let i = 0; i < want.length; i++) expect(Object.is(got[i], want[i]), `u=${u} [${i}] ${got[i]} vs ${want[i]}`).toBe(true);
    }
  }, 120_000);

  it("the grid anchor and the player's slot are gridSlot()'s own (src/track/core/mesh.ts)", () => {
    const track = tsMonaco();
    const F = createFlybySeq({ corners: () => MONACO_CORNERS });
    expect([POLE_BACK, GRID_SPACING]).toEqual([14, 8]);
    for (const k of [0, 1, 11, 19]) {
      F.setPlayerSlot(k);
      expect(F.slotIndex({ at: "slot", n: "player" })).toBe(k);
      const want = gridSlot(track, k);
      expect(Math.abs(F.anchorS(track, { at: "slot", n: "player" }) - want.s)).toBeLessThan(1e-6);
      const p = F.posePoint(track, { at: "slot", n: "player", off: 0, x: 0, y: 0 }, [0, 0, 0]);
      const pr = project(track, p[0], p[2], null, p[1]);
      expect(Math.abs(pr.lat - want.x)).toBeLessThan(0.1);
    }
    // The grid's back is the grid that is there.
    F.setPlayerSlot(0, 22); const full = F.anchorS(track, { at: "grid" });
    F.setPlayerSlot(0, 1); const solo = F.anchorS(track, { at: "grid" });
    const d = ((full - solo) % track.total + track.total) % track.total;
    expect(d).toBeGreaterThan(track.total / 2);
  });

  it("a centre pose of distR 0 / yR 0 is the centroid, not the clamp; no landmarks → whole-circuit poses", () => {
    const track = tsMonaco();
    const F = createFlybySeq({ corners: () => MONACO_CORNERS });
    const b = F.bounds(track);
    const p = F.posePoint(track, { at: "centre", distR: 0, yR: 0 }, [0, 0, 0]);
    expect(Math.hypot(p[0] - b.x, p[2] - b.z)).toBeLessThan(1e-6);
    expect(Math.abs(p[1] - b.y)).toBeLessThan(1e-6);
    const e = F.posePoint(track, { at: "centre", distR: 0.01, yR: 0.01 }, [0, 0, 0]);
    expect(Math.abs(Math.hypot(e[0] - b.x, e[2] - b.z) - 200)).toBeLessThan(1e-6);
    expect(Math.abs(e[1] - b.y - 55)).toBeLessThan(1e-6);
    // The bare build has no props: an eye stays an eye and a look a look.
    expect(F.landmarks(track)).toEqual([]);
    const eye = F.posePoint(track, { at: "landmark", rank: 0, distK: 1.7, yK: 0, y: 12 }, [0, 0, 0]);
    const look = F.posePoint(track, { at: "landmark", rank: 0, distK: 0, yK: 0.2 }, [0, 0, 0]);
    expect(Math.hypot(look[0] - eye[0], look[2] - eye[2])).toBeGreaterThan(Math.abs(look[1] - eye[1]));
    const fb = F.landmarkFallback(track, DEFAULT[2]!);
    expect([fb.eye[0]!.at, fb.look[0]!.at]).toEqual(["centre", "centre"]);
  });
});

// ---- f1-game's shot-quality assertions, run by the port on f1-game's builds ----

describe.skipIf(!haveF1)("FlybySeq port on f1-game's full builds (flyby-shots.test.mjs)", () => {
  const f1 = haveF1 ? f1Cam() : (null as unknown as F1Cam);
  const port = () => {
    const F = createFlybySeq({ corners: (def) => f1.TrackMaps.corners(def) });
    F.setPlayerSlot(11, 22); F.setDuration(20000); F.reset();
    return F;
  };
  const SAMPLES = 120;

  it("spot frames: f1-game's FlybySeq on this repo's Monaco build gives MONACO_SPOTS", () => {
    const track = buildTrack(defById("monaco")!) as FlybyTrack & { _fbCorners?: unknown };
    track._fbCorners = MONACO_CORNERS;   // f1-game reads its corners off the track
    const F = f1.F as unknown as Record<string, (...a: unknown[]) => { eye: Vec3; tgt: Vec3; fov: number; id: string }>;
    F["setPlayerSlot"]!(11, 22); F["setDuration"]!(20000); F["reset"]!();
    for (const [u, id, want] of MONACO_SPOTS) {
      const v = F["solve"]!(track, u);
      expect(v.id).toBe(id);
      expect([...v.eye, ...v.tgt, v.fov].every((x, i) => Object.is(x, want[i]))).toBe(true);
    }
  }, 120_000);

  it.each(["monza", "monaco", "bahrain"])("%s: the eye is never inside a building, and clearance lifts but never relocates", (id) => {
    const track = f1.track(id), F = port();
    const hits: string[] = [];
    let maxLift = 0, where = "";
    for (let i = 0; i <= SAMPLES; i++) {
      const u = i / SAMPLES, v = F.solve(track, u), shot = DEFAULT[v.index]!;
      if (v.lift > maxLift) { maxLift = v.lift; where = v.id; }
      if (onRoadPose(shot.eye[0]) && onRoadPose(shot.eye[1])) {
        const pr = project(track, v.eye[0], v.eye[2], null, v.eye[1]);
        if (Math.abs(pr.lat) > 12) hits.push(`u=${u.toFixed(2)} ${v.id} ${pr.lat.toFixed(1)} m off the centreline`);
        continue;
      }
      const hit = F.insideProp(track, v.eye, 0);
      if (hit) hits.push(`u=${u.toFixed(2)} ${v.id} inside ${hit.kind}`);
    }
    expect(hits).toEqual([]);
    expect(maxLift, where).toBeLessThan(25);
  }, 300_000);

  it("monza: each shot is continuous, only a boundary is a cut, and airCorner names the filmed turn", () => {
    const track = f1.track("monza"), F = port();
    const turns = f1.TrackMaps.corners(track.def).length;
    let prev: Vec3 | null = null, prevIdx = -1;
    const steps: Record<string, number[]> = {};
    for (let i = 0; i <= SAMPLES; i++) {
      const v = F.solve(track, i / SAMPLES);
      const eye: Vec3 = [v.eye[0], v.eye[1], v.eye[2]];
      if (prev && v.index === prevIdx) {
        (steps[v.id] ??= []).push(Math.hypot(eye[0] - prev[0], eye[1] - prev[1], eye[2] - prev[2]));
        expect(v.cut).toBe(false);
      }
      expect(F.airCorner()).toBe(v.corner);
      if (!/^turn-/.test(v.id)) expect(v.corner).toBe(0);
      else expect(v.corner >= 1 && v.corner <= turns).toBe(true);
      prev = eye; prevIdx = v.index;
    }
    for (const [id, d] of Object.entries(steps)) {
      const avg = d.reduce((a, b) => a + b, 0) / d.length, max = Math.max(...d);
      expect(avg > 0 && max > avg * 4, `shot ${id}: ${max} vs avg ${avg}`).toBe(false);
    }
    F.reset();
    expect(F.airCorner()).toBe(0);
    const solid = F.blockers(track);
    expect(solid.length).toBeGreaterThan(0);
    expect(solid.length).toBeLessThan(track.props!.list!.length);
  }, 300_000);

  it.each(["monza", "monaco"])("%s: a corner's +x is its OUTSIDE, whichever way it turns", (id) => {
    const track = f1.track(id), F = port();
    const bad: string[] = [];
    const n = F.cornerList(track).length;
    for (let i = 1; i <= n; i++) {
      const s = F.cornerS(track, i), k = curvature(track, s);
      if (!(Math.abs(k) > 0.004)) continue;
      if (F.cornerSide(track, i) !== (k > 0 ? 1 : -1)) bad.push(`T${i} k=${k.toFixed(4)}`);
    }
    expect(bad).toEqual([]);
  }, 300_000);

  it.each(["monza", "monaco", "bahrain"])("%s: a landmark bearing of 0 is the TRACK side of it", (id) => {
    const track = f1.track(id), F = port();
    const pts = F.bounds(track).pts, out: string[] = [];
    const nearest = (x: number, z: number) => Math.min(...pts.map((p) => Math.hypot(p[0] - x, p[2] - z)));
    F.landmarks(track).forEach((r, rank) => {
      const eye = F.posePoint(track, { at: "landmark", rank, bear: 0, distK: 1.5, yK: 0 }, [0, 0, 0]);
      let crosses = false;
      for (let i = 0; i <= 40 && !crosses; i++) {
        const pr = project(track, eye[0] + (r.x - eye[0]) * i / 40, eye[2] + (r.z - eye[2]) * i / 40);
        if (Math.abs(pr.lat) < 15) crosses = true;
      }
      if (!crosses && !(nearest(eye[0], eye[2]) < nearest(r.x, r.z))) out.push(`rank ${rank} (${r.kind})`);
    });
    expect(out).toEqual([]);
  }, 300_000);

  it("monaco: on a street circuit a corner camera stands at the fence, not in a building", () => {
    const track = f1.track("monaco"), F = port();
    for (const shot of DEFAULT) for (const pose of shot.eye) {
      if (pose.at !== "corner") continue;
      const s = F.anchorS(track, pose), eye = F.posePoint(track, pose, [0, 0, 0]);
      const pr = project(track, eye[0], eye[2], s, eye[1]);
      expect(Math.abs(pr.lat)).toBeLessThanOrEqual(wallAt(track, s, pr.lat > 0 ? 1 : -1) + F.FENCE + 0.5);
    }
  }, 300_000);

  it.each(["monza", "monaco"])("%s: the clearance lift is PLANNED: no pop inside a shot, corners step in before they lift", (id) => {
    const track = f1.track(id), F = port();
    const out: string[] = [];
    let prevY = 0, prevIdx = -1;
    for (let i = 0; i <= 400; i++) {
      const v = F.solve(track, i / 400);
      if (v.index === prevIdx && Math.abs(v.eye[1] - prevY) > 4) out.push(`${v.id} jumps at ${i}`);
      if (/^turn-/.test(v.id) && v.lift > 15) out.push(`${v.id} lifted ${v.lift.toFixed(1)}`);
      prevY = v.eye[1]; prevIdx = v.index;
    }
    expect([...new Set(out)]).toEqual([]);
  }, 300_000);

  it.each(["monza", "mont_tremblant"])("%s: a planned eye is not inside a tall tree's canopy", (id) => {
    const track = f1.track(id), F = port();
    const trees = (track.props!.list || []).filter((r) => r.h >= 8 && ["pine", "stonePine", "cypress", "broadleafFall", "palm", "acacia", "tree"].includes(r.kind));
    const bad = new Set<string>();
    for (let i = 0; i <= 400; i++) {
      const v = F.solve(track, i / 400), p = v.eye;
      for (const r of trees) {
        if (Math.abs(p[0] - r.x) < r.w / 2 && Math.abs(p[2] - r.z) < r.d / 2 && p[1] > r.y - r.h / 2 && p[1] < r.y + r.h / 2) bad.add(v.id);
      }
    }
    expect([...bad]).toEqual([]);
  }, 300_000);

  it.each(["monza", "kyalami"])("%s: landmarks: no gantries, nothing on the road, heights above ground; missing ranks become centre shots", (id) => {
    const track = f1.track(id), F = port(), out: string[] = [], smp = newSample();
    const lm = F.landmarks(track);
    for (const r of lm) {
      if (r.kind === "gantry") out.push("gantry");
      const pr = project(track, r.x, r.z);
      sample(track, pr.s, smp);
      if (Math.abs(pr.lat) - smp.hw < 5) out.push(`${r.kind} on the road`);
      const base = F.lmBase(track, r);
      if (base < r.y - r.h / 2 - 1e-6 || base > r.y + r.h / 2) out.push(`${r.kind} base outside its hull`);
    }
    for (const shot of DEFAULT) {
      const ranks = shot.eye.concat(shot.look).filter((p) => p.at === "landmark").map((p) => p.rank || 0);
      if (!ranks.length) continue;
      const fb = F.landmarkFallback(track, shot), need = Math.max(...ranks) >= lm.length;
      if (need !== (fb !== shot)) out.push(`${shot.id} fallback ${fb !== shot}`);
      if (need && !(fb.eye[0]!.at === "centre" && fb.look[0]!.at === "centre")) out.push(`${shot.id} fell back to ${fb.eye[0]!.at}`);
    }
    // One pose, no landmarks at all (f1-game seeds `_fbLandmarks = []` on a child of the track).
    const bare = Object.assign(Object.create(track) as FlybyTrack, { props: { list: [] } });
    const eye = F.posePoint(bare, { at: "landmark", rank: 0, distK: 1.7, yK: 0, y: 12 }, [0, 0, 0]);
    const look = F.posePoint(bare, { at: "landmark", rank: 0, distK: 0, yK: 0.2 }, [0, 0, 0]);
    if (!(Math.hypot(look[0] - eye[0], look[2] - eye[2]) > Math.abs(look[1] - eye[1]))) out.push("no-landmark fallback looks straight up");
    expect(out).toEqual([]);
  }, 300_000);

  it.each(["mont_tremblant", "jeddah"])("%s: a corner ROLE lands on a real corner, not a kink or a chicane flick", (id) => {
    const track = f1.track(id), F = port(), out: string[] = [];
    for (const role of ["first", "mid", "late"]) {
      const t = F.cornerTurn(track, F.cornerS(track, role));
      if (t.net < 35 * Math.PI / 180) out.push(`${role}: net ${t.net}`);
      else if (t.swept > 1.5 * t.net && t.net < 45 * Math.PI / 180) out.push(`${role}: a chicane`);
    }
    expect(out).toEqual([]);
  }, 300_000);

  it.each(["monza", "monaco", "spa"])("%s: corners by character: slowest / fastest / lore resolve to filmable corners", (id) => {
    const track = f1.track(id), F = port();
    const cs = F.cornerList(track);
    const at = (n: string) => cs.findIndex((_c, i) => Math.abs(F.cornerS(track, i + 1) - F.cornerS(track, n)) < 1e-6);
    const slow = at("slowest"), fast = at("fastest"), lore = at("lore");
    expect(slow >= 0 && fast >= 0 && lore >= 0).toBe(true);
    for (const k of [slow, fast, lore]) {
      const t = F.cornerTurn(track, F.cornerS(track, k + 1));
      expect(t.net >= 35 * Math.PI / 180 && (t.swept <= 1.5 * t.net || t.net >= 45 * Math.PI / 180)).toBe(true);
    }
    expect(cs[slow]!.r <= cs[fast]!.r).toBe(true);
  }, 300_000);

  it.each(["monza", "bahrain", "mont_tremblant"])("%s: one corner, one shot: no flyby films the same corner twice", (id) => {
    const track = f1.track(id), F = port(), out: string[] = [];
    for (let seed = -1; seed < 12; seed++) {
      const list = F.bindCorners(track, seed < 0 ? DEFAULT : F.vary(DEFAULT, seed));
      const s = list.filter((sh) => sh.eye[0]!.at === "corner").map((sh) => F.cornerS(track, sh.eye[0]!.n));
      for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
        const d = Math.abs(s[i]! - s[j]!), gap = Math.min(d, track.total - d);
        if (gap < 120) out.push(`seed ${seed}: shots ${i} and ${j} ${gap.toFixed(0)} m apart`);
      }
    }
    expect(out).toEqual([]);
  }, 300_000);

  it("monza: a NUMBERED corner is the author's: bindCorners never moves it, roles steer around it", () => {
    const track = f1.track("monza"), F = port();
    const c = (n: number | string): FlybyPose => ({ at: "corner", n, off: -30, x: 15, y: 8 });
    const sh = (id: string, n: number | string): FlybyShot => ({ id, dur: 0.25, ease: "inOut", eye: [c(n), c(n)], look: [c(n), c(n)], fov: [40, 40] });
    const b = F.bindCorners(track, [sh("a", 3), sh("b", 3), sh("c", 1), sh("d", 2), sh("e", "first")]);
    expect(b.slice(0, 4).map((s) => s.eye[0]!.n)).toEqual([3, 3, 1, 2]);
    const sFirst = F.cornerS(track, b[4]!.eye[0]!.n);
    expect(Math.abs(sFirst - F.cornerS(track, 1)) >= 120 && Math.abs(sFirst - F.cornerS(track, 3)) >= 120).toBe(true);
  }, 300_000);

  it("monza: the clearance grid index finds exactly what a full scan finds", () => {
    const track = f1.track("monza"), F = port(), b = F.blockers(track), B = F.bounds(track);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const scan = (p: Vec3, m: number) => { for (const r of b) if (Math.abs(p[0] - r.x) < r.w / 2 + m && Math.abs(p[2] - r.z) < r.d / 2 + m && p[1] > r.y - r.h / 2 - m && p[1] < r.y + r.h / 2 + m) return r; return null; };
    let hits = 0;
    for (let i = 0; i < 4000; i++) {
      const pick = b[(rnd() * b.length) | 0]!;
      const p: Vec3 = i % 2 ? [pick.x + (rnd() - 0.5) * pick.w * 1.4, pick.y + (rnd() - 0.5) * pick.h, pick.z + (rnd() - 0.5) * pick.d * 1.4]
                            : [B.x + (rnd() - 0.5) * B.rad * 2, rnd() * 40, B.z + (rnd() - 0.5) * B.rad * 2];
      const m = [0, 2.5, 7][i % 3]!;
      const want = scan(p, m);
      expect(F.insideProp(track, p, m)).toBe(want);
      if (want) hits++;
    }
    expect(hits).toBeGreaterThan(500);
  }, 300_000);

  it("monaco: plans are reused when they still hold, and re-planned when they do not", () => {
    const track = f1.track("monaco"), F = port();
    const list = F.bindCorners(track, DEFAULT), total = list.reduce((a, s) => a + (s.dur || 0), 0);
    const plain = list.find((s) => !JSON.stringify(s).includes('"slot"') && !JSON.stringify(s).includes('"grid"'))!;
    const slotShot = list.find((s) => JSON.stringify(s).includes('"slot"'))!;
    const a = F.planShot(track, plain, plain.dur! / total);
    F.setPlayerSlot(3, 22);
    expect(F.planShot(track, plain, plain.dur! / total)).toBe(a);
    expect(F.planShot(track, plain, plain.dur! / (total * 0.9))).toBe(a);
    F.setDuration(10000);
    expect(F.planShot(track, plain, plain.dur! / total)).not.toBe(a);
    F.setDuration(20000);
    const b = F.planShot(track, slotShot, slotShot.dur! / total);
    F.setPlayerSlot(7, 22);
    expect(F.planShot(track, slotShot, slotShot.dur! / total)).not.toBe(b);
  }, 300_000);

  it("spa: planSteps plans every shot, and solve() then reuses each plan", () => {
    const track = f1.track("spa"), F = port();
    const list = F.vary(DEFAULT, 9, false), step = F.planSteps(track, list);
    let n = 0; while (!step()) n++;
    expect(n).toBe(list.length - 1);
    const bound = F.bindCorners(track, list);
    let total = 0; for (const s of bound) total += s.dur || 0;
    const plans = bound.map((s) => { const sh = F.landmarkFallback(track, s); return F.planShot(track, sh, (sh.dur || 1) / total); });
    let acc = 0;
    bound.forEach((s, i) => {
      F.solve(track, (acc + (s.dur || 0) / 2) / total, list);
      const sh = F.landmarkFallback(track, s);
      expect(F.planShot(track, sh, (sh.dur || 1) / total)).toBe(plans[i]);
      acc += s.dur || 0;
    });
  }, 300_000);

  it("monza: the planner frames its subject: turn-first clears the grandstand, the grid walk holds the field", () => {
    const track = f1.track("monza"), F = port();
    const list = F.bindCorners(track, DEFAULT);
    let total = 0; for (const s of list) total += s.dur || 0;
    const at = (id: string, t: number) => {
      let acc = 0;
      for (const s of list) { if (s.id === id) return F.solve(track, (acc + (s.dur || 0) * t) / total); acc += s.dur || 0; }
      throw new Error(id);
    };
    for (const t of [0.03, 0.5, 0.97]) {
      const v = at("turn-first", t);
      const th = Sight.nearThirds(track, Sight.camera([...v.eye] as Vec3, [...v.tgt] as Vec3, v.fov, 16 / 9), null);
      expect(Math.max(...th)).toBeLessThanOrEqual(0.4);
    }
    for (const t of [0.03, 0.5, 0.97]) {
      const v = at("grid-walk", t), cam = Sight.camera([...v.eye] as Vec3, [...v.tgt] as Vec3, v.fov, 16 / 9);
      let inF = 0;
      for (let k = 0; k < 22; k++) {
        const q = Sight.project(cam, F.posePoint(track, { at: "slot", n: k, off: 0, x: 0, y: 0.8 }, [0, 0, 0]));
        if (q && Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1) inF++;
      }
      expect(inF / 22).toBeGreaterThanOrEqual(0.6);
    }
  }, 300_000);

  // flyby-pose-inverse.test.mjs
  it("monza: poseFromWorld round-trips every anchor kind; shotFromView solves back to the view", () => {
    const track = f1.track("monza"), F = port(), TOL = 0.25;
    const out: Vec3 = [0, 0, 0];
    const back = (pose: FlybyPose) => F.posePoint(track, pose, out).slice() as Vec3;
    const dist = (a: Readonly<Vec3>, b: Readonly<Vec3>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const smp = newSample(), kinds = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const s = (i + 0.37) / 40 * track.total, lat = ((i % 5) - 2) * 9;
      sample(track, s, smp);
      const p: Vec3 = [smp.p[0] + smp.r[0] * lat, smp.p[1] + 3 + (i % 4) * 5, smp.p[2] + smp.r[2] * lat];
      const { pose, err } = F.poseFromWorld(track, p);
      kinds.add(pose.at!);
      expect(pose.at === "corner" || pose.at === "start").toBe(true);
      expect(err).toBeLessThan(TOL);
      expect(dist(back(pose), p)).toBeLessThan(TOL);
    }
    expect(kinds.has("corner") && kinds.has("start")).toBe(true);
    const cs = F.cornerS(track, 1);
    sample(track, cs, smp);
    const side = F.cornerSide(track, 1);
    const c = F.poseFromWorld(track, [smp.p[0] + smp.r[0] * 15 * side, smp.p[1] + 6, smp.p[2] + smp.r[2] * 15 * side]).pose;
    expect(c.at).toBe("corner");
    expect(c.n).toBe(1);
    expect(c.x! > 14 && c.x! < 16).toBe(true);
    expect(Math.abs(c.off!) < 1 && Math.abs(c.y! - 6) < 0.3).toBe(true);
    const b = F.bounds(track);
    const heli: Vec3 = [b.x + Math.cos(b.face + 0.7) * 500, b.y + 120, b.z + Math.sin(b.face + 0.7) * 500];
    const h = F.poseFromWorld(track, heli, { at: "centre" });
    expect(h.pose.at).toBe("centre");
    expect(Math.abs(h.pose.bear! - 0.7)).toBeLessThan(1e-3);
    expect(h.err).toBeLessThan(TOL);
    const hh = F.poseFromWorld(track, [heli[0], b.y + 400, heli[2]], { at: "centre" });
    expect(hh.pose.y! > 0 && hh.err < TOL).toBe(true);
    const tn = F.poseFromWorld(track, [b.x + 20, b.y + 80, b.z], { at: "centre" });
    expect(tn.pose.at).not.toBe("centre");
    expect(tn.err).toBeLessThan(TOL);
    const lm = F.landmarks(track);
    if (lm.length) {
      const r = lm[0]!;
      const l = F.poseFromWorld(track, [r.x + 70, r.y + 20, r.z - 40], { at: "landmark", rank: 0 });
      expect(l.pose.at).toBe("landmark");
      expect(l.err).toBeLessThan(TOL);
    }
    sample(track, 900, smp);
    const eye: Vec3 = [smp.p[0] + smp.r[0] * 20, smp.p[1] + 8, smp.p[2] + smp.r[2] * 20];
    const tgt: Vec3 = [smp.p[0] + smp.t[0] * 40, smp.p[1] + 1, smp.p[2] + smp.t[2] * 40];
    const sv = F.shotFromView(track, eye, tgt, 48);
    expect(sv.err.eye < TOL && sv.err.look < TOL).toBe(true);
    F.reset();
    const v = F.solve(track, 0.5, [sv.shot]);
    expect(dist(v.tgt, tgt)).toBeLessThan(TOL);
    expect(dist(v.eye, eye) - (v.lift || 0)).toBeLessThan(TOL);
    expect(v.fov).toBe(48);
    const json = JSON.stringify(sv.shot);
    expect(JSON.stringify(JSON.parse(json))).toBe(json);
    expect(/NaN|null/.test(json)).toBe(false);
  }, 300_000);
});
