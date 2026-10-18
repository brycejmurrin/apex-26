// GarageScene parity: the TS port (src/garage/scene/scene.ts) against f1-game's
// js/garage/scene.js run in a Node VM, driven through the same calls with a
// recording renderer facade. Every mesh payload (length + Float64-bit hash of
// pos/nrm/col/mat/uv/idx), every draw (mesh, matrix hash, options), every
// texture upload and free, the light rig and the 2D-canvas op log must match
// exactly. The f1-game half is skipped where /home/f1-game is absent; the
// hard-coded spot values at the end always run.
import { describe, expect, it } from "vitest";
import {
  buildStatic, createGarageScene, framingHull, mk, recentre, NO_EXPERIENCE, type SceneDeps,
} from "../../../src/garage/scene/scene";
import type { GarageExperienceApi } from "../../../src/garage/scene/types";
import type { GarageCore } from "../../../src/track/scenery/core";
import {
  f1Scene, fnv, hasF1Scene, LIV, LIV2, liveryStub, recordingCanvas, recordingGfx, SCENE_FILES, summary, TEAM, TEAM2,
} from "./scene-vm";

type AnyFn = (...a: unknown[]) => unknown;
type SceneLike = Record<string, AnyFn> & { BACKDROP: number[] };

/** One side of the comparison: a scene, its recording facade, its clock. */
interface Side {
  scene: SceneLike;
  log: string[];
  canvasOps: string[];
  clock: { t: number };
  /** live meshes/textures */
  live: Set<object>;
}

function f1Side(atlases: boolean): Side {
  const clock = { t: 0 };
  const rec = recordingGfx(), cv = recordingCanvas();
  const get = f1Scene({
    performance: { now: () => clock.t },
    ...(atlases ? { document: cv.document, LiveryTex: liveryStub(cv.ops) } : {}),
    Tracks: { circuitPayloadResident: (t: { id: string }) => t.id === "monza" },
  }, [...SCENE_FILES, "js/car/parts.js"]);
  const scene = get("GarageScene") as SceneLike;
  scene["init"]!(rec.gfx);
  return { scene, log: rec.log, canvasOps: cv.ops, clock, live: rec.live };
}

function tsSide(atlases: boolean, experience: GarageExperienceApi): Side {
  const clock = { t: 0 };
  const rec = recordingGfx(), cv = recordingCanvas();
  const deps: SceneDeps = {
    now: () => clock.t,
    log: { info() {}, warn() {} },
    experience,
    trackResident: (t) => t.id === "monza",
    createCanvas: atlases ? (cv.createCanvas as unknown as NonNullable<SceneDeps["createCanvas"]>) : null,
    livery: atlases ? liveryStub(cv.ops) as unknown as SceneDeps["livery"] : null,
  };
  const scene = createGarageScene(deps) as unknown as SceneLike;
  scene["init"]!(rec.gfx);
  return { scene, log: rec.log, canvasOps: cv.ops, clock, live: rec.live };
}

/** f1-game's own GarageExperience, so the career-facility paths compare too. */
function f1Experience(): GarageExperienceApi {
  return f1Scene({}, SCENE_FILES)("GarageExperience") as GarageExperienceApi;
}

const carMat = new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.3, 0, 7.5, 1]);
const getParts = () => ({ engine: "turbo", brakes: "carbon" });
const car = { car: true };

/** A garage session: team picks, paint edits, presets, arrivals, a release. */
function session(s: Side): unknown[] {
  const out: unknown[] = [];
  const S = s.scene, at = (t: number) => { s.clock.t = t; };
  const draw = (...a: unknown[]) => S["draw"]!(...a);
  const snap = (label: string) => out.push(label, S["debug"]!(), [...S.BACKDROP]);
  at(0);
  draw(TEAM, LIV, [0, 1.6, 0], null, 0); snap("first");
  at(400); draw(TEAM, LIV, [0, 1.6, 0], getParts, 0, { track: { id: "monza", name: "Monza", country: "Italy" }, weather: "dry" }); snap("monza");
  at(1700); draw(TEAM, LIV, [-7, 2, 3], getParts, 1, { track: { id: "monza", name: "Monza", country: "Italy" } }, car); snap("outside -X");
  at(3300); S["spot"]!("top"); draw(TEAM, LIV, [0, 11, 0], getParts, 1, null, car, null, carMat); snap("top");
  S["spot"]!("side"); at(5000); draw(TEAM, { ...LIV, logo: [1, 0, 0] }, [11, 2, 0.5], getParts, 0, { sceneNow: 5000 }); snap("logo");
  at(6100); draw(TEAM2, LIV2, [0, 2, 9], getParts, 0, { night: true, wins: 6, weather: "wet", career: true, round: 4,
    last: { p: 3, pts: 15 }, sponsor: { label: "Acme" }, achievements: { active: true, facility: 5, facilityMax: 8, wins: 3, podiums: 6, titles: 1 },
    track: { id: "suzuka", name: "Suzuka", country: "Japan", points: [[0, 0, 0], [50, 0, 10], [80, 0, 90], [10, 0, 60]] } }); snap("night");
  at(6500); draw(TEAM2, LIV2, [0, 2, -4], getParts, 0, { night: true, door: 0.4 }, car, { door: 0.4, z: 0.1 }, carMat); snap("arrival");
  at(7000); draw(TEAM2, LIV2, [3, 2, 8], getParts, 0, { night: true }, car, { door: 1, z: 2, x: 0.5 }, carMat); snap("drive-out");
  at(9000); draw(TEAM2, LIV2, [0, 1.4, 3.2], getParts, 0, { studio: true }, car); snap("studio");
  at(9100); draw(TEAM2, LIV2, [0, 1.4, 3.2], getParts, 0, { ambient: false }); snap("still");
  for (const t of [0, 250, 1234.5, 30000]) out.push(S["live"]!(LIV, t, { night: t > 1000, door: t / 40000, spin: t === 250 }));
  S["pulse"]!(); out.push(S["live"]!(LIV2, 30500, {}), S["live"]!(LIV2, 31800, { ambient: true }));
  out.push(S["lights"]!(null), S["ctxKey"]!({ track: { id: "monza" } }), S["ctxKey"]!({ track: { id: "spa" }, last: { dnf: "engine" } }));
  out.push(S["prepared"]!(TEAM2, LIV2, getParts, 0, { ambient: false }), S["prepare"]!(TEAM, LIV, null, 0, { weather: "dry" }));
  out.push(S["release"]!(), S["release"]!());
  at(12000); draw(TEAM, LIV, [0, 1.6, 0], null, 0); snap("rebuilt");
  return out;
}

describe.skipIf(!hasF1Scene)("GarageScene matches f1-game js/garage/scene.js", () => {
  for (const atlases of [false, true]) {
    it(`a whole session, ${atlases ? "with" : "without"} the atlases`, () => {
      const a = f1Side(atlases), b = tsSide(atlases, f1Experience());
      const ra = JSON.parse(JSON.stringify(session(a))) as unknown, rb = JSON.parse(JSON.stringify(session(b))) as unknown;
      expect(b.log.length).toBeGreaterThan(100);
      expect(b.log).toEqual(a.log);
      expect(rb).toEqual(ra);
      expect(b.canvasOps).toEqual(a.canvasOps);
      if (atlases) expect(b.canvasOps.length).toBeGreaterThan(500);
    });
  }

  it("NO_EXPERIENCE is experience.js for a career without achievements", () => {
    const a = f1Side(true), b = tsSide(true, NO_EXPERIENCE);
    for (const s of [a, b]) {
      s.scene["draw"]!(TEAM, LIV, [0, 1.6, 0], getParts, 0, { track: { id: "monza" } });
      s.scene["draw"]!(TEAM2, LIV2, [0, 1.6, 0], getParts, 1, { career: true, night: true });
    }
    expect(b.log).toEqual(a.log);
    expect(b.canvasOps).toEqual(a.canvasOps);
  });

  it("the preview LRU and its hulls", () => {
    const a = f1Side(false), b = tsSide(false, NO_EXPERIENCE);
    const res: unknown[][] = [[], []];
    [a, b].forEach((s, k) => {
      for (let i = 0; i < 9; i++) {
        const key = `car${i % 7}`, hullKey = `hull${i % 4}`;
        const e = s.scene["previewMesh"]!(key, hullKey, () => cloud(200 + i, i)) as { hull: number[] | null; hullKey: string };
        res[k]!.push(e.hullKey, e.hull && fnv(e.hull), s.scene["debug"]!());
      }
      s.scene["dropPreviewMeshes"]!();
      res[k]!.push(s.scene["debug"]!());
    });
    expect(b.log).toEqual(a.log);
    expect(res[1]).toEqual(JSON.parse(JSON.stringify(res[0])));
  });

  it("buildStatic, framingHull, recentre and mk", () => {
    const get = f1Scene({}, ["js/core/mat4.js", ...SCENE_FILES]);
    const F = get("GarageScene") as { buildStatic: AnyFn; framingHull: AnyFn; recentre: AnyFn };
    for (const liv of [LIV, LIV2, null, { c1: [0.2, 0.2] }])
      for (const o of [undefined, { props: "lite" }, { props: true }, { props: true, equipment: true, ctx: { weather: "rain", wins: 9 } }]) {
        expect(summary(buildStatic(liv as never, o as never))).toEqual(summary(F.buildStatic(liv, o) as never));
      }
    for (let s = 1; s < 6; s++) {
      const data = cloud(400 * s, s);
      const hull = framingHull(data);
      expect(hull).toEqual(Array.from(F.framingHull(data) as number[]));
      const proj = [1.2, 0, 0, 0, 0, 1.9, 0, 0, 0.01 * s, 0, -1.002, -1, 0, 0, -0.2, 0];
      const view = [0.8, 0, -0.6, 0, 0, 1, 0, 0, 0.6, 0, 0.8, 0, -0.5, -1.2, -9, 1];
      const vp = new Float32Array(16), vp2 = new Float32Array(16);
      for (let i = 0; i < 16; i++) vp[i] = vp2[i] = proj[i]! * 0.9 + view[(i * 5) % 16]! * 0.1;
      const p1 = proj.slice(), p2 = proj.slice();
      recentre(p1, view, vp, 0.12, true, hull);
      F.recentre(p2, view, vp2, 0.12, true, hull);
      expect(p1).toEqual(p2);
      expect(Array.from(vp)).toEqual(Array.from(vp2));
    }
    expect(framingHull({ pos: [] })).toBeNull();
  });
});

/** A seeded point cloud shaped like a car (x ±1, z -2.7..3.2). */
function cloud(n: number, seed: number): { pos: number[]; nrm: number[]; col: number[]; mat: number[]; idx: number[] } {
  let s = seed * 9301 + 49297;
  const r = () => ((s = (s * 233280 + 49297) % 2147483647) / 2147483647);
  const pos: number[] = [];
  for (let i = 0; i < n; i++) pos.push((r() * 2 - 1) * 0.95, r() * 1.1, -2.69 + r() * 5.87);
  return { pos, nrm: pos.map(() => 0), col: pos.map(() => 0.5), mat: pos.filter((_, i) => i % 3 === 0).map(() => 20), idx: [0, 1, 2] };
}

describe("GarageScene spot values (always run)", () => {
  it("the trackside lite bay keeps f1-game's pinned 12318 indices and its hashes", () => {
    const bay = buildStatic(LIV, { props: "lite" });
    // f1-game tests/unit/garage-mesh.test.mjs:445 pins the lite bay at 12318 indices.
    expect(bay.idx.length).toBe(12318);
    expect(bay.mat.length).toBe(bay.pos.length / 3);
    expect(summary(bay)).toEqual(SPOT_LITE);
  });
  it("the full bay with equipment", () => {
    expect(summary(buildStatic(LIV2, { props: true, equipment: true }))).toEqual(SPOT_FULL);
  });
  it("buildStatic is the scenery lane's GarageCore", () => {
    const core: GarageCore = { buildStatic };
    const m = core.buildStatic({ c1: [0.1, 0.2, 0.3], c2: [0.9, 0.9, 0.9], accent: [0.9, 0.9, 0.9] }, { props: "lite" });
    expect(m && m.idx.length).toBe(12318);
  });
  it("mk writes T * Ry * Rz column-major", () => {
    const m = mk(new Float32Array(16), 1, 2, 3, Math.PI / 2, 0);
    expect(Array.from(m).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, -1, 0, -0, 1, 0, 0, 1, 0, 0, 0, 1, 2, 3, 1]);
  });
  it("the light rig: ten fixtures, two uplights, four gantries and the lamp", () => {
    const S = createGarageScene({ log: { info() {}, warn() {} }, createCanvas: null });
    const rig = S.lights(LIV);
    expect(rig.length).toBe(17 * 15);
    expect(rig.slice(0, 15)).toEqual([0, 4.3, 1.6, 15 * 0.55 * 1.16, 15 * 0.55 * 1, 15 * 0.55 * 0.78, 11, 0, -1, 0, 0.72, 0.28, 0.1, 0, 0.45]);
    expect(fnv(rig)).toBe(SPOT_RIG);
    expect(S.debug().bay).toEqual([10.8, 12.8, 5]);
  });
});

// Recorded from this port and checked equal to f1-game by the parity suite above.
const SPOT_LITE = { pos: "16266:d417bce3", nrm: "16266:8cae51a1", col: "16266:5303a150", mat: "5422:b60d7eaa", idx: "12318:82472ad5" };
const SPOT_FULL = { pos: "44238:4882af82", nrm: "44238:c28324a9", col: "44238:ae743507", mat: "14746:5e19e5aa", idx: "31638:d038e923" };
const SPOT_RIG = "a316b2e6";
