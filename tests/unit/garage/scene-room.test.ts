// The garage room's behaviour, ported from f1-game's own tests of
// js/garage/scene.js and run against the TS port (no f1-game needed):
// tests/unit/garage-mesh.test.mjs, garage-sign-occlusion.test.mjs,
// garage-prebuild.test.mjs (sceneHarness), garage-personality.test.mjs,
// scene-live.test.mjs (ctxKey) and garage-crew.test.mjs (draws).
import { describe, expect, it } from "vitest";
import { createGarageScene, SIDES, type SceneDeps } from "../../../src/garage/scene/scene";
import { MAT } from "../../../src/garage/scene/prims";
import type { GarageGfx, GfxMesh, GfxTexture } from "../../../src/garage/scene/types";
import { LIV, liveryStub, recordingCanvas, TEAM } from "./scene-vm";

interface Data { pos: number[]; nrm: number[]; col?: number[]; mat?: number[]; uv?: number[]; idx: number[] }
interface Draw { mesh: GfxMesh; matrix: number[]; opts: unknown }

/** A recording facade that keeps mesh data and every draw's matrix (garage-mesh.test.mjs:24-32). */
function harness(over: Partial<SceneDeps> & { failTexture?: (w: number) => boolean } = {}) {
  const meshes: (Data & { tex: boolean })[] = [], draws: Draw[] = [], decals: { mesh: GfxMesh; tex: GfxTexture; wasFreed: boolean }[] = [];
  const live = new Set<object>(), freed = new Set<object>(), warns: string[] = [];
  let nTex = 0;
  const gfx: GarageGfx = {
    createMesh(d) { meshes.push({ ...(d as Data), tex: false }); const h = { id: meshes.length }; live.add(h); return h; },
    createTexMesh(d) { meshes.push({ ...(d as Data), tex: true }); const h = { id: meshes.length, tex: true }; live.add(h); return h; },
    createTexture(cv) {
      if (over.failTexture && over.failTexture(cv.width)) throw new Error("context lost");
      const h = { tex: ++nTex }; live.add(h); return h;
    },
    freeMesh(h) { live.delete(h); freed.add(h); },
    freeTexture(h) { live.delete(h); freed.add(h); },
    draw(mesh, matrix, opts) { draws.push({ mesh, matrix: Array.from(matrix), opts }); },
    drawDecal(mesh, _m, tex) { decals.push({ mesh, tex, wasFreed: freed.has(tex) }); },
  };
  const cv = recordingCanvas();
  const clock = { t: 0 };
  const scene = createGarageScene({
    now: () => clock.t, log: { info() {}, warn: (m: string) => warns.push(m) },
    createCanvas: cv.createCanvas as unknown as SceneDeps["createCanvas"], livery: liveryStub([]) as unknown as SceneDeps["livery"],
    parts: null,
    ...over,
  });
  scene.init(gfx);
  return { scene, gfx, meshes, draws, decals, live, freed, warns, clock };
}
const drawIn = (h: ReturnType<typeof harness>, ...rest: unknown[]) =>
  (h.scene.draw as (...a: unknown[]) => void)(TEAM, LIV, [0, 1.6, 0], null, 0, ...rest);

describe("the bay's meshes (garage-mesh.test.mjs)", () => {
  it("every garage mesh carries exactly one material id per vertex", () => {
    const h = harness(); drawIn(h);
    const geo = h.meshes.filter((m) => !m.tex);
    expect(geo.length).toBeGreaterThanOrEqual(5);
    for (const m of geo) expect(m.mat && m.mat.length).toBe(m.pos.length / 3);
  });

  it("no horizontal surface carries a wall-keyed material", () => {
    // matWallLike keys CONCRETE/BRICK/METAL/... off world Y, constant on a floor:
    // the largest single horizontal wall-keyed triangle must stay under 0.5 m2.
    const WALL_LIKE = new Set([1, 2, 4, 5, 7, 12, 13, 14]);
    const h = harness(); drawIn(h);
    let worst = 0;
    for (const m of h.meshes) {
      if (!m.mat) continue;
      for (let t = 0; t < m.idx.length; t += 3) {
        const a = m.idx[t]!, b = m.idx[t + 1]!, c = m.idx[t + 2]!;
        if (!WALL_LIKE.has(m.mat[a]!) || Math.abs(m.nrm[a * 3 + 1]!) < 0.98) continue;
        const P = (i: number) => [m.pos[i * 3]!, m.pos[i * 3 + 1]!, m.pos[i * 3 + 2]!];
        const p = P(a), q = P(b), r = P(c);
        const u = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!], v = [r[0]! - p[0]!, r[1]! - p[1]!, r[2]! - p[2]!];
        const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
        worst = Math.max(worst, 0.5 * Math.hypot(n[0]!, n[1]!, n[2]!));
      }
    }
    expect(worst).toBeLessThanOrEqual(0.5);
  });

  it("the big surfaces are not left on MAT.FLAT", () => {
    const h = harness(); drawIn(h);
    const ids = new Set<number>();
    for (const m of h.meshes) if (m.mat) for (const v of m.mat) if (v > 0) ids.add(v);
    for (const want of [MAT.CONCRETE, MAT.ASPHALT, MAT.METAL]) expect(ids.has(want)).toBe(true);
  });

  it("a failed trace upload preserves its decal and retries after recovery", () => {
    let failNext = false;
    const h = harness({ failTexture: () => failNext });
    drawIn(h);
    expect(h.warns.filter((m) => /live trace/.test(m))).toEqual([]);
    const freedBefore = h.freed.size;
    failNext = true; h.clock.t = 2000; drawIn(h);
    expect(h.warns.filter((m) => /live trace failed: context lost/.test(m)).length).toBe(1);
    expect(h.freed.size).toBe(freedBefore);
    expect(h.decals.some((d) => d.wasFreed)).toBe(false);
    failNext = false; h.clock.t = 4000; drawIn(h);
    expect(h.freed.size).toBeGreaterThan(freedBefore);
    expect(h.decals.some((d) => d.wasFreed)).toBe(false);
  });

  it("garage dress upload retries after a transient failure, and a new team clears its cutoff", () => {
    let failures = 1, attempts = 0;
    const h = harness({ failTexture: (w) => { if (w !== 1024) return false; attempts++; return failures-- > 0; } });
    const draw = (team: object = TEAM) => (h.scene.draw as (...a: unknown[]) => void)(team, LIV, [0, 1.6, 0], null, 0);
    draw(); expect(attempts).toBe(1);
    h.clock.t = 500; draw(); expect(attempts).toBe(1);
    h.clock.t = 1100; draw(); expect(attempts).toBe(2);
    failures = 4;
    const broken = { ...TEAM, id: "broken" };
    for (let i = 0; i < 3; i++) { h.clock.t += 1100; draw(broken); }
    const before = attempts;
    h.clock.t += 1100; draw(broken);
    expect(attempts).toBe(before);
    draw({ ...TEAM, id: "recovered" });
    expect(attempts).toBe(before + 1);
  });

  it("arrival moves the reflected car and shutter without rebuilding geometry", () => {
    const h = harness();
    const car = { car: true }, mat = new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 9, 1]);
    h.scene.draw(TEAM, LIV, [-3.8, 2, -4.8], null, 0, null, car, { door: 0 }, mat);
    const count = h.meshes.length;
    expect(h.draws.find((d) => d.mesh === car)!.matrix[14]).toBe(9);
    const closed = h.draws.find((d) => d.matrix[5]! > 1.5);
    expect(closed).toBeTruthy();
    h.draws.length = 0; mat[14] = 0;
    h.scene.draw(TEAM, LIV, [4.1, 2.25, -4.9], null, 0, null, car, { door: 1 }, mat);
    expect(h.meshes.length).toBe(count);
    expect(h.draws.find((d) => d.mesh === car)!.matrix[14]).toBe(0);
    expect(h.draws.find((d) => d.mesh === closed!.mesh)!.matrix[5]).toBeLessThan(0.03);
    h.draws.length = 0;
    h.scene.draw(TEAM, LIV, [0, 2, 0], null, 0, null, car);
    expect(h.draws.find((d) => d.mesh === closed!.mesh)!.matrix[5]).toBe(1);
  });

  it("floor reflection draws after the room so depth clips the mirror", () => {
    const h = harness(), car = { car: true };
    h.scene.draw(TEAM, LIV, [0, 1.4, 3.2], null, 0, null, car);
    const at = h.draws.findIndex((d) => d.mesh === car);
    expect(at).toBeGreaterThan(1);
    expect(h.draws[at]!.opts).toMatchObject({ alpha: 1, depthBias: [-2, -120] });
  });

  it("TOP hides the roof truss and ceiling LED housings; other presets restore them", () => {
    const h = harness();
    const countAt = (name: string) => { h.draws.length = 0; h.scene.spot(name); h.scene.draw(TEAM, LIV, [0, 11, 0], null, 0); return h.draws.length; };
    const hero = countAt("hero"), top = countAt("top"), rear = countAt("rear");
    expect(top).toBe(hero - 2);
    expect(rear).toBe(hero);
    h.scene.spot("top");
    expect(h.scene.live(LIV, 0, { spin: false })[14]).toBe(0);
    h.scene.spot("hero");
    expect(h.scene.live(LIV, 0, { spin: false })[14]).toBeGreaterThan(0);
  });

  it("logo, sponsor and number edits repaint atlases and leave the bay meshes", () => {
    const h = harness(); drawIn(h);
    const n = h.meshes.length, g = h.scene.debug().geomKey;
    h.scene.draw(TEAM, { ...LIV, logo: [1, 0, 0], logo2: [0, 0, 1], logo3: [0, 1, 0], sponsors: "clean" }, [0, 1.6, 0], null, 0);
    expect(h.scene.debug().geomKey).toBe(g);
    expect(h.meshes.length).toBe(n);
    h.scene.draw({ ...TEAM, drivers: [{ num: 1 }, { num: 2 }] }, LIV, [0, 1.6, 0], null, 0);
    expect(h.scene.debug().geomKey).toBe(g);
    expect(h.meshes.length).toBe(n);
    drawIn(h, { weather: "wet" });
    expect(h.scene.debug().geomKey).not.toBe(g);
    expect(h.meshes.length).toBeGreaterThan(n);
    const wetN = h.meshes.length;
    h.scene.draw(TEAM, { ...LIV, c1: [0.1, 0.2, 0.9] }, [0, 1.6, 0], null, 0);
    expect(h.meshes.length).toBeGreaterThan(wetN);
  });

  it("the LEGENDS bay rebuilds when the legend changes, even on the same paint", () => {
    const h = harness();
    const row = (legend: string) => ({ id: "legends", legend, name: "Legends", short: "LGD", drivers: TEAM.drivers });
    h.scene.draw(row("schumacher"), LIV, [0, 1.6, 0], null, 0);
    const a = h.scene.debug().geomKey;
    h.scene.draw(row("senna"), LIV, [0, 1.6, 0], null, 0);
    expect(h.scene.debug().geomKey).not.toBe(a);
  });

  it("the crew is drawn only while a pose plays: three figures and one pole", () => {
    const h = harness();
    h.scene.draw(TEAM, LIV, [0, 1.6, 0], null, 0);
    const meshesBefore = h.meshes.length;
    h.draws.length = 0;
    h.scene.draw(TEAM, LIV, [0, 1.6, 0], null, 0);
    const parked = h.draws.length;
    h.draws.length = 0;
    h.scene.draw(TEAM, LIV, [0, 1.6, 0], null, 0, null, null, { door: 1, z: 2 });
    expect(h.meshes.length).toBe(meshesBefore + 3);
    // + 4 crew draws, - the barrier (arrival hides it)
    expect(h.draws.length).toBe(parked + 4 - 1);
  });
});

describe("the light rig (garage-personality.test.mjs)", () => {
  const teamEnergy = (rig: number[]) => {
    let e = 0;
    for (let i = 0; i + 14 < rig.length; i += 15) {
      const r = rig[i + 3]!, g = rig[i + 4]!, b = rig[i + 5]!;
      if (r > 0 && Math.abs(g / r - LIV.c1[1]! / LIV.c1[0]!) < 1e-6 && Math.abs(b / r - LIV.c1[2]! / LIV.c1[0]!) < 1e-6) e += r + g + b;
    }
    return e;
  };
  it("the team uplights swell as the shutter lifts, and sit at their usual level otherwise", () => {
    const S = harness().scene;
    const base = teamEnergy(S.live(LIV, 0, { night: false, ambient: true }).slice());
    const open = teamEnergy(S.live(LIV, 0, { night: false, ambient: true, door: 1 }).slice());
    const mid = teamEnergy(S.live(LIV, 0, { night: false, ambient: true, door: 0.5 }).slice());
    const shut = teamEnergy(S.live(LIV, 0, { night: false, ambient: true, door: 0 }).slice());
    expect(base).toBeGreaterThan(0);
    expect(Math.abs(open - base)).toBeLessThan(1e-9);
    expect(Math.abs(shut - base)).toBeLessThan(1e-9);
    expect(mid / base).toBeGreaterThan(2.9);
    expect(mid / base).toBeLessThan(3.5);
    expect(Math.abs(teamEnergy(S.live(LIV, 0, { night: false, ambient: true }).slice()) - base)).toBeLessThan(1e-9);
  });
});

describe("prepare / release (garage-prebuild.test.mjs)", () => {
  const setupCtx = { track: { id: "monza" }, weather: "dry", tod: "default", night: false };
  it("a prepared room is the one the first garage draw uses: no rebuild on the tap", () => {
    const h = harness();
    expect(h.scene.prepared(TEAM, LIV, null, 0, setupCtx)).toBe(false);
    expect(h.scene.prepare(TEAM, LIV, null, 0, setupCtx)).toBe(true);
    expect(h.scene.prepared(TEAM, LIV, null, 0, setupCtx)).toBe(true);
    const before = h.meshes.length;
    h.scene.draw(TEAM, LIV, [0, 1.6, 0], null, 0, setupCtx);
    expect(h.meshes.length).toBe(before);
    expect(h.scene.prepared(TEAM, LIV, null, 0, { ...setupCtx, studio: true })).toBe(false);
    expect(h.scene.ctxKey(setupCtx)).toBe(h.scene.ctxKey({ ...setupCtx, sceneNow: 123, ambient: true }));
  });
  it("release frees every garage handle; the next draw rebuilds the room", () => {
    const h = harness();
    h.scene.draw(TEAM, LIV, [0, 1.6, 0], null, 0, setupCtx);
    const car = { pos: [-1, 0, -2, 1, 0, -2, 1, 1, 2, -1, 1, 2], nrm: [], col: [], idx: [0, 1, 2] };
    h.scene.previewMesh("mclaren:a:4", "mclaren:a:4|h", () => car);
    h.scene.previewMesh("mclaren:b:4", "mclaren:b:4|h", () => car);
    const held = h.live.size;
    expect(held).toBeGreaterThan(10);
    expect(h.scene.release()).toBe(held);
    expect(h.live.size).toBe(0);
    expect(h.scene.debug().previewMeshes).toBe(0);
    expect(h.scene.debug().key).toBe("");
    expect(h.scene.prepared(TEAM, LIV, null, 0, setupCtx)).toBe(false);
    expect(h.scene.release()).toBe(0);
    h.scene.draw(TEAM, LIV, [0, 1.6, 0], null, 0, setupCtx);
    expect(h.scene.prepared(TEAM, LIV, null, 0, setupCtx)).toBe(true);
    const rebuilt = h.live.size;
    expect(rebuilt).toBeGreaterThan(0);
    expect(h.scene.release()).toBe(rebuilt);
    expect(h.live.size).toBe(0);
  });
});

describe("ctxKey (scene-live.test.mjs)", () => {
  it("changes when the circuit hydrates, so the live atlas repaints", () => {
    let resident = false;
    const S = harness({ trackResident: () => resident }).scene;
    const t = { id: "spa" };
    const before = S.ctxKey({ track: t });
    resident = true;
    const after = S.ctxKey({ track: t });
    resident = false;
    expect(after).not.toBe(before);
    expect(S.ctxKey({ track: t })).toBe(before);
  });
});

describe("no wall sign has opaque geometry mounted over it (garage-sign-occlusion.test.mjs)", () => {
  const NEAR = 0.5, MAX_PCT = 5, GX = 60, GY = 12;
  type P3 = [number, number, number];
  it("checks every wall-mounted dress and live quad", () => {
    const h = harness();
    h.scene.draw(TEAM, { c1: [0.95, 0.45, 0.05], c2: [0.05, 0.05, 0.06] }, [0, 1.6, 0], null, 0, { wins: 3, night: false });
    expect(h.warns).toEqual([]);
    const quads: { n: P3; P: P3[] }[] = [], tris: P3[][] = [];
    for (const m of h.meshes) {
      const V = (j: number): P3 => [m.pos[j * 3]!, m.pos[j * 3 + 1]!, m.pos[j * 3 + 2]!];
      if (m.tex) {
        for (let v = 0; v + 3 < m.pos.length / 3; v += 4) {
          const n: P3 = [m.nrm[v * 3]!, m.nrm[v * 3 + 1]!, m.nrm[v * 3 + 2]!];
          if (Math.abs(n[1]) > 0.5) continue;
          quads.push({ n, P: [V(v), V(v + 1), V(v + 2), V(v + 3)] });
        }
      } else for (let i = 0; i + 2 < m.idx.length; i += 3) tris.push([V(m.idx[i]!), V(m.idx[i + 1]!), V(m.idx[i + 2]!)]);
    }
    expect(quads.length).toBeGreaterThanOrEqual(15);
    const inTri = (px: number, py: number, A: number[], B: number[], C: number[]) => {
      if (Math.abs((B[0]! - A[0]!) * (C[1]! - A[1]!) - (B[1]! - A[1]!) * (C[0]! - A[0]!)) < 1e-7) return false;
      const s1 = (B[0]! - A[0]!) * (py - A[1]!) - (B[1]! - A[1]!) * (px - A[0]!);
      const s2 = (C[0]! - B[0]!) * (py - B[1]!) - (C[1]! - B[1]!) * (px - B[0]!);
      const s3 = (A[0]! - C[0]!) * (py - C[1]!) - (A[1]! - C[1]!) * (px - C[0]!);
      return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
    };
    const cut: string[] = [];
    for (const q of quads) {
      const a = q.n[0] ? 0 : 2, sgn = q.n[a]! > 0 ? 1 : -1, plane = q.P[0]![a]!;
      const b = a === 0 ? 2 : 0, c = 1;
      const lo = [Math.min(...q.P.map((p) => p[b]!)), Math.min(...q.P.map((p) => p[c]!))];
      const hi = [Math.max(...q.P.map((p) => p[b]!)), Math.max(...q.P.map((p) => p[c]!))];
      const near: number[][][] = [];
      for (const T of tris) {
        const d = T.map((p) => (p[a]! - plane) * sgn);
        if (Math.min(...d) < 0.012 || Math.max(...d) > NEAR) continue;
        const t2 = T.map((p) => [p[b]!, p[c]!]);
        if (Math.max(...t2.map((p) => p[0]!)) < lo[0]! || Math.min(...t2.map((p) => p[0]!)) > hi[0]! ||
            Math.max(...t2.map((p) => p[1]!)) < lo[1]! || Math.min(...t2.map((p) => p[1]!)) > hi[1]!) continue;
        near.push(t2);
      }
      let cov = 0;
      for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
        const px = lo[0]! + (hi[0]! - lo[0]!) * (i + 0.5) / GX, py = lo[1]! + (hi[1]! - lo[1]!) * (j + 0.5) / GY;
        if (near.some((T) => inTri(px, py, T[0]!, T[1]!, T[2]!))) cov++;
      }
      const pct = 100 * cov / (GX * GY);
      if (pct > MAX_PCT) cut.push(`quad n=[${q.n}] at (${q.P[0]!.map((x) => x.toFixed(2))}): ${pct.toFixed(1)}%`);
    }
    expect(cut).toEqual([]);
  });
});

it("SIDES is f1-game's wall order", () => {
  expect(SIDES).toEqual(["nx", "px", "back", "door", "mid", "shutter", "barrier"]);
});
