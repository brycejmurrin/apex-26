import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as M from "../../src/car/materials";
import { create as createGeometry } from "../../src/car/geometry";
import * as Shade from "../../src/car/shade";
import { CarShade } from "../../src/car/shade";
import { newMesh, type MeshOut, type Vec3 } from "../../src/car/types";
import { CAR_GLOBALS, CAR_SCRIPTS, F1_DIR, haveF1, loadF1Car } from "../helpers/f1-car-vm";

// f1-game js/car/car-shade.js. Bit-exact against the VM-loaded original: JSON with -0
// kept apart from 0 (JSON round-trips every other double exactly).
type Fn = (...a: unknown[]) => unknown;
type Api = Record<string, unknown>;
const exact = (v: unknown): string | undefined =>
  v === undefined ? undefined : JSON.stringify(v, (_k, x: unknown) => (Object.is(x, -0) ? "-0" : typeof x === "number" && !Number.isFinite(x) ? String(x) : x));
const fn = (api: Api, k: string): Fn => api[k] as Fn;
const mine = CarShade as unknown as Api;
const geo = createGeometry(M);
const tri = geo.addTri as unknown as Fn;

/** Run `call(api, out, tri)` on a fresh mesh against both ports and compare. */
function both(vmShade: Api, vmTri: Fn, call: (api: Api, out: MeshOut, t: Fn) => unknown): void {
  const a = newMesh(), b = newMesh();
  const ra = call(vmShade, a, vmTri), rb = call(mine, b, tri);
  expect(exact(b)).toBe(exact(a));
  expect(exact(rb)).toBe(exact(ra));
}

describe("CarShade sanity", () => {
  it("ring / loft / smooth basics", () => {
    expect(Shade.KEY).toBe("a26.carSmooth");
    const r = Shade.ring({ z: 0, y: 0.5, w: 0.4, h: 0.2 });
    expect(r).toHaveLength(24);
    expect(r[0]).toEqual([0.2, 0.5, 0]);   // the right flank at mid-height: the envelope holds
    expect(r[6]![1]).toBeCloseTo(0.6, 12);   // top centre
    const out = newMesh();
    Shade.loft(out, { z: 1, y: 0.5, w: 0.4, h: 0.2 }, { z: 0, y: 0.5, w: 0.5, h: 0.3 }, M.CARBON, geo.addTri);
    expect(out.idx.length / 3).toBe(4 * 24);
    expect(Shade.smooth(out)).toBeGreaterThan(0);
    for (let v = 0; v < out.nrm.length; v += 3) expect(Math.hypot(out.nrm[v]!, out.nrm[v + 1]!, out.nrm[v + 2]!)).toBeCloseTo(1, 9);
    const cube = newMesh();
    geo.addBox(cube, 0, 0, 0, 1, 1, 1, M.CARBON);
    expect(Shade.smooth(cube)).toBe(0);   // 90° edges are past the 55° crease
    expect(Shade._norm("OFF")).toBeNull();
    expect(Shade._norm("")).toBe("*");
    expect(Shade._norm("McLaren")).toBe("mclaren");
    expect(Shade._norm("bad id!")).toBe("*");
  });
  it("earcut clips a non-convex C into n-2 triangles", () => {
    const C: Vec3[] = [[0, 0, 0], [3, 0, 0], [3, 1, 0], [1, 1, 0], [1, 2, 0], [3, 2, 0], [3, 3, 0], [0, 3, 0]];
    expect(Shade.earcut(C)).toHaveLength(6);
  });
});

describe("CarShade switch (pref / on / any / set)", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  async function fresh(stored: Record<string, string>) {
    const store = new Map(Object.entries(stored));
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.resetModules();
    const mod = await import("../../src/car/shade");
    return { S: mod.CarShade, store };
  }
  it("reads a26.carSmooth once, and set() saves it", async () => {
    let { S, store } = await fresh({});
    expect([S.pref(), S.on("ferrari"), S.any()]).toEqual(["*", true, true]);
    ({ S, store } = await fresh({ "a26.carSmooth": "0", "apex26.carSmooth": "1" }));
    expect([S.pref(), S.on("ferrari"), S.any()]).toEqual([null, false, false]);
    store.set("a26.carSmooth", "1");
    expect(S.pref()).toBeNull();   // read once per page
    ({ S, store } = await fresh({ "a26.carSmooth": "mclaren" }));
    expect([S.on("mclaren"), S.on("ferrari"), S.any()]).toEqual([true, false, true]);
    expect(S.set("all")).toBe("*");
    expect(store.get("a26.carSmooth")).toBe("1");
    expect(S.set("off")).toBeNull();
    expect(store.get("a26.carSmooth")).toBe("0");
    expect(S.set("RedBull")).toBe("redbull");
    expect(store.get("a26.carSmooth")).toBe("redbull");
    expect(S.set("")).toBe("*");
    expect(store.has("a26.carSmooth")).toBe(false);
  });
  it.skipIf(!haveF1)("matches f1-game's switch, key renamed", async () => {
    const seq: unknown[] = [undefined, "1", "0", "mclaren", " Ferrari ", "nope!", "", null, "true", "off"];
    for (const start of [null, "0", "1", "mclaren", "junk value"]) {
      const { S } = await fresh(start == null ? {} : { "a26.carSmooth": start });
      const ref = loadF1Car()["CarShade"] as Api;
      if (start != null) fn(ref, "set")(start);   // VM storage is private: seed it through set()
      const vmPref = fn(ref, "pref")();
      expect(S.pref()).toBe(vmPref);
      for (const v of seq) {
        if (v !== undefined) expect(S.set(v)).toBe(fn(ref, "set")(v));
        for (const team of ["mclaren", "ferrari", undefined]) expect(S.on(team)).toBe(fn(ref, "on")(team));
        expect(S.any()).toBe(fn(ref, "any")());
      }
    }
  });
});

describe.skipIf(!haveF1)("CarShade matches f1-game bit for bit", () => {
  const vmg = haveF1 ? loadF1Car() : {};
  const ref = (vmg["CarShade"] ?? {}) as Api;
  const vmGeo = haveF1 ? (vmg["CarGeometry"] as { create(c: unknown): Api }).create(vmg["CarMaterials"]) : {};
  const vmTri = (vmGeo as Api)["addTri"] as Fn;
  const VMM = (vmg["CarMaterials"] ?? {}) as Record<string, Vec3>;

  it("constants", () => {
    for (const k of ["RING_N", "EXP", "EXP_TOP", "LOWER", "COVER_Z", "COVER_Z_NEAR", "RAMP"]) expect(exact(mine[k])).toBe(exact(ref[k]));
    expect(ref["KEY"]).toBe("apex26.carSmooth");
    expect(Object.keys(mine).sort()).toEqual(Object.keys(ref).sort());
  });

  it("pure helpers: ring, sect, sink, fine, rquad, earcut, podRing, densifyCoverPts, downwash, cokeFoot", () => {
    const st = (api: Api) => [
      fn(api, "ring")({ z: 0.4, y: 0.42, w: 0.36, h: 0.28, t: 0.7, x: 0.01 }),
      fn(api, "ring")({ z: 1.2, y: 0.3, w: 0.2, h: 0.12 }, 16, 2.5, 4),
      fn(api, "sect")(12, 6, 2.6), fn(api, "sect")(8, 2, 2),
      fn(api, "sink")({ top: 0.42, bottom: 0.18, topSide: 0.09, side: 0.13 }, 0.05),
      fn(api, "sink")({ top: 0.42, bottom: 0.18, topSide: 0.09 }, -0.2),
      fn(api, "fine")([[0.235, 0.505, -0.46], [0.24, 0.7, -0.3], [0.1, 0.95, 0.1], [0, 0.97, 0.3], [-0.1, 0.95, 0.1]], 3),
      fn(api, "fine")([[0.235, 0.505, -0.46], [0.24, 0.7, -0.3], [0.1, 0.95, 0.1], [0, 0.97, 0.3], [-0.1, 0.95, 0.1]], 3, 1, 4),
      fn(api, "rquad")([[0, 0, 1], [1, 0, 1], [1, 0.5, 1], [0, 0.5, 1]], [[0.5, 0.5], [0.2, 0.1], [0, 0], [0.5, 0.5]], 3),
      fn(api, "earcut")([[0, 0, 0], [0, 3, 0], [0, 3, 1], [0, 1, 1], [0, 1, 2], [0, 3, 2], [0, 3, 3], [0, 0, 3]]),
      fn(api, "podRing")({ z: -0.4, inner: 0.25, outer: 0.62, innerBottom: 0.14, innerTop: 0.52, outerBottom: 0.16, outerTop: 0.44 }, -1),
      fn(api, "podRing")({ z: 0.3, inner: 0.25, outer: 0.58, innerBottom: 0.14, innerTop: 0.55, outerBottom: 0.2, outerTop: 0.47 }, 1),
      fn(api, "densifyCoverPts")([[0.24, 0.3], [0.2, 0.62], [0.12, 0.72], [0, 0.78]]),
      fn(api, "densifyCoverPts")([[0.24, 0.3], [0.2, 0.62], [0.12, 0.72], [0, 0.78]], 3),
    ];
    expect(exact(st(mine))).toBe(exact(st(ref)));
    const pods = [0.62, 0.3, -0.38, -0.62, -1.0, -1.48].map((z, i) => ({ z, inner: 0.25, outer: 0.6 - i * 0.03, innerBottom: 0.14, innerTop: 0.55, outerBottom: 0.16, outerTop: 0.47 }));
    for (const coke of [undefined, 0.72, 0.95, 1.1, 1.3, 1.38, 2]) {
      const a = fn(mine, "downwash")(pods, (z: number) => 0.5 + z * 0.05, coke), b = fn(ref, "downwash")(pods, (z: number) => 0.5 + z * 0.05, coke);
      expect(exact(a)).toBe(exact(b));
      expect(a === pods).toBe(b === pods);
      const cs = [{ z: -0.55, x: 0.24 }, { z: -2.0, x: 0.12 }];
      for (const z of [-0.55, -0.9, -1.47, -2.0]) {
        const c = { z, x: 0.2, bottom: 0.3, top: 0.7 };
        expect(exact(fn(mine, "cokeFoot")(c, cs, coke))).toBe(exact(fn(ref, "cokeFoot")(c, cs, coke)));
      }
    }
  });

  it("geometry emitters with car3d's own arguments", () => {
    const C = (api: Api) => (api === mine ? (M as unknown as Record<string, Vec3>) : VMM);
    const red: Vec3 = [1.3, 0.05, 0.05];
    const cases: [string, (api: Api, out: MeshOut, t: Fn) => unknown][] = [
      ["loft", (a, o, t) => fn(a, "loft")(o, { z: 1.0, y: 0.42, w: 0.3, h: 0.24, t: 0.62 }, { z: 0.2, y: 0.45, w: 0.42, h: 0.34, t: 0.66 }, red, t)],
      ["loft opts", (a, o, t) => fn(a, "loft")(o, { z: -0.28, y: 0.76, w: 0.30, h: 0.20, t: 0.55 }, { z: -0.6, y: 0.7, w: 0.26, h: 0.3, t: 0.7, x: 0.0 }, red, t, { frontCol: C(a)["INTAKE"], n: 16, surface: 21 })],
      ["capLoft", (a, o, t) => fn(a, "capLoft")(o, { z: 2.1, y: 0.3, w: 0.16, h: 0.12 }, { z: 1.4, y: 0.36, w: 0.24, h: 0.2 }, { topSide: 0.06, side: 0.08 }, { topSide: 0.09, side: 0.12 }, red, t)],
      ["podLoft", (a, o, t) => fn(a, "podLoft")(o, [0.62, 0.3, -0.38, -0.62, -1.0, -1.48].map((z, i) => ({ z, inner: 0.25, outer: 0.6 - i * 0.03, innerBottom: 0.14, innerTop: 0.55 - i * 0.02, outerBottom: 0.16, outerTop: 0.47 - i * 0.03 })), red, C(a)["INTAKE"], t)],
      ["coverLoft", (a, o, t) => fn(a, "coverLoft")(o, { coverAt: (z: number) => ({ z, x: 0.22 + z * 0.04, bottom: 0.3, top: 0.75 + z * 0.06 }) },
        (c: { x: number; bottom: number; top: number }) => ({ pts: fn(a, "densifyCoverPts")([[c.x, c.bottom], [c.x * 0.9, c.top - 0.1], [c.x * 0.5, c.top - 0.03], [0, c.top]]) }), -0.55, -2.0, red, t, { zs: a["COVER_Z_NEAR"] })],
      ["coverLoft far", (a, o, t) => fn(a, "coverLoft")(o, { coverAt: (z: number) => ({ z, x: 0.22 + z * 0.04, bottom: 0.3, top: 0.75 + z * 0.06 }) },
        (c: { x: number; bottom: number; top: number }) => ({ pts: [[c.x, c.bottom], [c.x * 0.9, c.top - 0.1], [0, c.top]] }), -0.6, -1.95, red, t)],
      ["strut", (a, o, t) => fn(a, "strut")(o, [0, 0.53, 0.47], [0, 0.83, 0.47], 0.05, 0.035, C(a)["HALO"], t, 23, { taper: 0.8, n: 10 })],
      ["strut arm", (a, o, t) => fn(a, "strut")(o, [0.2, 0.3, 1.6], [0.68, 0.32, 1.62], 0.02 * 1.9, 0.02 * 0.62, C(a)["CARBON"], t, null, { n: 6 })],
      ["strut pylon", (a, o, t) => fn(a, "strut")(o, [0.09, 0.085, 2.54], [0.09, 0.275, 2.40], 0.16, 0.040, red, t, null, { n: 10, taper: 0.72 })],
      ["pipe hoop", (a, o, t) => fn(a, "pipe")(o, fn(a, "fine")([[0.235, 0.505, -0.46], [0.24, 0.7, -0.3], [0.1, 0.95, 0.1], [0, 0.97, 0.3], [-0.1, 0.95, 0.1], [-0.24, 0.7, -0.3]], 3), C(a)["HALO"], t, 23, { chord: 0.04, thick: 0.03, n: 10, p: 2, up: [0, 1, 0] })],
      ["block", (a, o, t) => (fn(a, "blockFn")(t, { r: [0, 0.03, 0.07, 0.02] }) as Fn)(o, [[0.3, 0.2, 0.5], [0.6, 0.2, 0.5], [0.6, 0.5, 0.5], [0.3, 0.5, 0.5], [0.3, 0.2, -0.3], [0.62, 0.2, -0.3], [0.62, 0.52, -0.3], [0.3, 0.52, -0.3]], red, C(a)["INTAKE"])],
      ["box", (a, o, t) => (fn(a, "boxFn")(t, { r: 0.028 }) as Fn)(o, 0.6, 0.28, 1.79, 0.06, 0.20, 0.13, C(a)["DARK"])],
      ["box default", (a, o, t) => fn(a, "box")(o, 0, 0.9, -0.3, 0.2, 0.1, 0.4, red, t, null, { seg: 4 })],
      ["housing", (a, o, t) => fn(a, "housing")(o, [[0.42, 0.62, 0.28], [0.58, 0.62, 0.30], [0.58, 0.69, 0.30], [0.42, 0.69, 0.28], [0.42, 0.62, 0.36], [0.58, 0.62, 0.40], [0.58, 0.69, 0.40], [0.42, 0.69, 0.36]], red, t, 20)],
      ["cTub", (a, o, t) => fn(a, "cTub")(o, [{ z: 0.35, y: 0.42, w: 0.5, h: 0.4, t: 0.82, open: 0.2, rail: 0.6 }, { z: -0.45, y: 0.45, w: 0.56, h: 0.46, t: 0.8, open: 0.21, rail: 0.64 }], 0.24, red, t)],
      ["floor", (a, o, t) => fn(a, "floor")(o, { cx: 0, cy: 0.06, cz: -0.3, sx: 1.5, sy: 0.02, sz: 3.2 }, 0.06, (z: number) => 0.6 + 0.1 * Math.cos(z), C(a)["CARBON"], t)],
      ["endplate", (a, o, t) => { for (const s of [-1, 1]) for (const ep of [
        { front: { z: -2.2, top: 0.92, bottom: 0.5 }, rear: { z: -2.62, top: 0.96, bottom: 0.525 } },
        { front: { z: -2.25, top: 0.8, bottom: 0.4 }, rear: { z: -2.6, top: 0.66, bottom: 0.3 } }]) fn(a, "endplate")(o, ep, s, C(a)["DARK"], red, 20, t); }],
      ["tunnel", (a, o, t) => { for (const s of [-1, 1]) fn(a, "tunnel")(o, s, 0.08, 0.36, 0.48, 0.05, 0.11, 0.24, C(a)["DARK"], C(a)["CARBON"], t, 21); }],
      ["headrest", (a, o, t) => { for (const st of [undefined, 0, 1, 2, 7]) fn(a, "headrest")(o, red, t, 20, st); }],
      ["skin open", (a, o, t) => fn(a, "skin")(o, [[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [1, 0, -1], [0, 1, -1]], [[0, 0, -2], [1.2, 0, -2], [0, 1.1, -2]]], red, t, null, { caps: false, segCol: (i: number) => (i ? red : C(a)["DARK"]) })],
    ];
    for (const [name, call] of cases) {
      const a = newMesh(), b = newMesh();
      call(ref, a, vmTri); call(mine, b, tri);
      expect(b.idx.length, name).toBeGreaterThan(0);
      expect(exact(b), name).toBe(exact(a));
    }
  });

  it("vertexNormals, smooth and the two-tone zones, in place", () => {
    const build = (api: Api, out: MeshOut, t: Fn) => {
      fn(api, "loft")(out, { z: 1.05, y: 0.42, w: 0.3, h: 0.3, t: 0.6 }, { z: 0.05, y: 0.45, w: 0.44, h: 0.36, t: 0.7 }, [0.9, 0.1, 0.1], t);
      fn(api, "podLoft")(out, [0.62, 0.3, -0.38, -0.62, -1.0, -1.48].map((z, i) => ({ z, inner: 0.25, outer: 0.6 - i * 0.03, innerBottom: 0.14, innerTop: 0.55 - i * 0.02, outerBottom: 0.16, outerTop: 0.47 - i * 0.03 })), [0.9, 0.1, 0.1], null, t);
    };
    const anchors = { podStations: [0.62, 0.3, -0.38, -0.62, -1.0, -1.48].map((z) => ({ z })), podAt: (z: number) => ({ bottom: 0.16, top: 0.47 + z * 0.02 }) };
    for (const which of ["lowerZone", "upperZone"]) {
      both(ref, vmTri, (api, out, t) => {
        build(api, out, t);
        const n = fn(api, which)(out, 0, out.pos.length / 3, [0.9, 0.1, 0.1], [0.2, 0.2, 0.22], anchors, 20);
        const bad = fn(api, which)(out, 0, out.pos.length / 3, [0.9, 0.1, 0.1], "#333333", anchors, 20);
        return [n, bad, fn(api, "smooth")(out, { skip: [25] }), fn(api, "smooth")(out, { creaseDeg: 20 })];
      });
    }
    both(ref, vmTri, (api, out, t) => {
      build(api, out, t);
      out.idx.push(0, 0, 0);   // a degenerate triangle is skipped
      return fn(api, "smooth")(out);
    });
    // The tyre tread: shared ring vertices, radial normals.
    both(ref, vmTri, (api, out) => {
      const SEG = 24, prof = [[0, 0.948], [0.09, 1], [0.91, 1], [1, 0.948]];
      for (const [xf, rm] of prof) for (let i = 0; i < SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        out.pos.push(-0.17 + 0.34 * xf!, 0.34 * rm! * Math.cos(a), 0.34 * rm! * Math.sin(a)); out.nrm.push(0, Math.cos(a), Math.sin(a)); out.col.push(0, 0, 0); out.mat.push(22);
      }
      for (let r = 0; r < prof.length - 1; r++) for (let i = 0; i < SEG; i++) {
        const i2 = (i + 1) % SEG, A = r * SEG + i, B = r * SEG + i2, C = (r + 1) * SEG + i2, D = (r + 1) * SEG + i;
        out.idx.push(A, B, C, A, C, D);
      }
      fn(api, "vertexNormals")(out, 0, SEG * 2);
      fn(api, "vertexNormals")(out, SEG, out.pos.length / 3);
    });
  });
});

// Every CarShade call a real f1-game car build makes, replayed through the port: the
// original IIFE's return value is wrapped in the VM, and each call runs both versions on
// identical arguments (car3d's own stations, anchors, profiles and addTri).
const EMIT = new Set(["loft", "capLoft", "podLoft", "loftRings", "coverLoft", "skin", "pipe", "strut", "block", "box",
  "housing", "cTub", "floor", "endplate", "tunnel", "headrest"]);
const INPLACE = new Set(["smooth", "vertexNormals", "lowerZone", "upperZone", "heightZone"]);
const FACTORY = new Set(["boxFn", "blockFn"]);
function loadIntercepted(onCall: (name: string, ref: string | undefined, port: string | undefined) => void): Api {
  const wrap = (orig: Api): Api => {
    const w: Api = {};
    for (const [k, v] of Object.entries(orig)) {
      if (typeof v !== "function") { w[k] = v; continue; }
      const o = v as Fn, m = fn(mine, k);
      if (EMIT.has(k)) w[k] = (out: unknown, ...rest: unknown[]) => {
        const a = newMesh(), b = newMesh();
        o(a, ...rest); m(b, ...rest); onCall(k, exact(a), exact(b));
        return o(out, ...rest);
      };
      else if (INPLACE.has(k)) w[k] = (out: MeshOut, ...rest: unknown[]) => {
        const copy = structuredClone(out);
        const ra = o(out, ...rest), rb = m(copy, ...rest);
        onCall(k, exact([ra, out.pos, out.nrm, out.col, out.mat, out.idx]), exact([rb, copy.pos, copy.nrm, copy.col, copy.mat, copy.idx]));
        return ra;
      };
      else if (FACTORY.has(k)) w[k] = (t: unknown, opt: unknown) => {
        const fo = o(t, opt) as Fn, fm = m(t, opt) as Fn;
        return (out: unknown, ...rest: unknown[]) => {
          const a = newMesh(), b = newMesh();
          fo(a, ...rest); fm(b, ...rest); onCall(k, exact(a), exact(b));
          return fo(out, ...rest);
        };
      };
      else w[k] = (...args: unknown[]) => { const ra = o(...args); onCall(k, exact(ra), exact(m(...args))); return ra; };
    }
    return w;
  };
  const noop = (): void => {};
  const ctx = vm.createContext({ console, Log: { info: noop, warn: noop, error: noop, debug: noop }, __wrapShade: wrap });
  vm.runInContext("globalThis.window = globalThis;", ctx);
  for (const rel of CAR_SCRIPTS) {
    let src = fs.readFileSync(path.join(F1_DIR, rel), "utf8");
    if (rel.endsWith("car-shade.js")) {
      const head = "const CarShade = (function () {", tail = "})();\nObject.freeze(CarShade);";
      expect(src.includes(head) && src.includes(tail)).toBe(true);
      src = src.replace(head, "const CarShade = __wrapShade((function () {").replace(tail, "})());\nObject.freeze(CarShade);");
    }
    vm.runInContext(src, ctx, { filename: rel });
  }
  return vm.runInContext(`({ ${CAR_GLOBALS.join(", ")} })`, ctx) as Api;
}

describe.skipIf(!haveF1)("CarShade inside real f1-game car builds", () => {
  it("every call car3d / car-body-geom / car-wheels make matches", () => {
    const calls = new Map<string, number>(), bad: string[] = [];
    const g = loadIntercepted((name, ref, port) => {
      calls.set(name, (calls.get(name) ?? 0) + 1);
      if (ref !== port && bad.length < 5) bad.push(name);
    });
    const Car3D = g["Car3D"] as { build(c1: Vec3, c2: Vec3, opts: unknown): MeshOut };
    const builds: [Vec3, Vec3, unknown][] = [
      [[0.95, 0.45, 0.05], [0.1, 0.1, 0.12], { teamId: "mclaren", livery: { lower: [0.12, 0.12, 0.13] } }],
      [[0.8, 0.02, 0.02], [1, 1, 1], { teamId: "ferrari", livery: { cover: [1, 1, 1] }, parts: { aero: 0, brakes: 2, tyres: 2, _visual: { engine: { coke: 1.3 }, cockpit: { headrest: 1 } } } }],
      [[0.05, 0.05, 0.06], [0.7, 0.7, 0.72], { teamId: "mercedes", livery: { upper: [0.75, 0.75, 0.78] }, parts: { aero: 2, _visual: { engine: { coke: 0.9 }, cockpit: { headrest: 2 } } } }],
      [[0.1, 0.12, 0.4], [0.9, 0.1, 0.1], { teamId: "redbull", field: true, livery: { nose: [1, 0.85, 0.05] } }],
      [[0.1, 0.3, 0.8], [1, 0.4, 0.7], { teamId: "alpine", smooth: true, parts: { _visual: { engine: { coke: 1.38 } } } }],
    ];
    for (const [c1, c2, opts] of builds) Car3D.build(c1, c2, opts);
    expect(bad).toEqual([]);
    for (const k of ["loft", "capLoft", "podLoft", "coverLoft", "strut", "housing", "cTub", "floor", "endplate", "tunnel",
      "headrest", "smooth", "vertexNormals", "lowerZone", "upperZone", "downwash", "cokeFoot", "densifyCoverPts", "on", "fine", "sink", "boxFn", "blockFn"]) {
      expect(calls.get(k) ?? 0, k).toBeGreaterThan(0);
    }
  }, 60_000);
});

