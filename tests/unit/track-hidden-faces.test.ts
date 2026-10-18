// The hidden-face strip and vertex compaction (src/track/core/hidden-faces.ts, port of
// f1-game js/track/core/hidden-faces.js) and their place in buildTrack (tracks.js:340-369).
//
// Ported from f1-game:
//   * tests/unit/track-build-grids.test.mjs:96-128 "hidden-face strip: a giant box (coarse
//     grid) hides exactly what a brute-force scan says";
//   * tests/unit/props-tri-ratchet.test.mjs:107-131 "compact() on a hand-built buffer:
//     order-preserving remap, blocks shifted".
// The ratchet's fleet sweep (props-tri-ratchet.test.mjs:67-105) needs the scenery build and
// tools/track/props-tris.cjs; it is not ported here (see the buildTrack cases below).
import { describe, expect, it } from "vitest";
import { addBox } from "../../src/track/core/geom";
import { compact, strip, stripSteps, type GeomBlock } from "../../src/track/core/hidden-faces";
import { buildTrack, defById, type PropsBuilder, type PropsResult } from "../../src/track/core/tracks";
import type { GeomOut, RV3 } from "../../src/track/core/types";
import { scratch } from "../../src/track/scenery/models";
import type { PropsResult as SceneryPropsResult } from "../../src/track/scenery/build-props";

// Deterministic PRNG (mulberry32). track-build-grids.test.mjs:44
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Compile-time: the scenery lane's `out` accumulator buffer fits the widened PropsResult.
const _sceneryOut: PropsResult["out"] = null as unknown as SceneryPropsResult["out"];
void _sceneryOut;

describe("TrackHiddenFaces (f1-game hidden-faces.js)", () => {
  // track-build-grids.test.mjs:96
  it("hidden-face strip: a giant box (coarse grid) hides exactly what a brute-force scan says", () => {
    const r = rng(11);
    const geo: GeomOut = { pos: [], nrm: [], col: [], mat: [], idx: [] };
    const boxes: { c: RV3; h: number[] }[] = [];
    const add = (c: RV3, sz: RV3) => { boxes.push({ c, h: sz.map((v) => v / 2) }); addBox(geo, c, sz, [0.5, 0.5, 0.5]); };
    // the giant sheets: 4 km x 20 m and 3 km x 3 km, far past BIG_CELLS 8 m cells
    add([0, -5, 0], [4000, 10, 20]);
    add([2500, 0, 2500], [3000, 40, 3000]);
    // small boxes: inside a giant (hidden), straddling its edge (kept), inside
    // another small box (the fine grid's own answer), and out in the open
    for (let i = 0; i < 120; i++) {
      const kind = i % 4, s = 0.5 + r() * 3;
      if (kind === 0) add([(r() - 0.5) * 3900, -5, (r() - 0.5) * 12], [s, s, s]);
      else if (kind === 1) add([(r() - 0.5) * 3900, 0, 10], [s, s, s]);
      else if (kind === 2) { const c: RV3 = [1200 + r() * 2600, 0, 1200 + r() * 2600]; add(c, [8, 8, 8]); add(c, [s, s, s]); }
      else add([(r() - 0.5) * 6000, 50, -500 - r() * 500], [s, s, s]);
    }
    const pos = geo.pos.slice(), idx = geo.idx.slice(), T = idx.length / 3;
    const inside = (b: { c: RV3; h: number[] }, p: number[]) =>
      Math.abs(p[0]! - b.c[0]) < b.h[0]! - 0.01 && Math.abs(p[1]! - b.c[1]) < b.h[1]! - 0.01 &&
      Math.abs(p[2]! - b.c[2]) < b.h[2]! - 0.01;
    const want: number[] = [];
    let hidden = 0;
    for (let t = 0; t < T; t++) {
      const P = [0, 1, 2].map((q) => pos.slice(idx[t * 3 + q]! * 3, idx[t * 3 + q]! * 3 + 3));
      if (boxes.some((b) => P.every((p) => inside(b, p)))) hidden++;
      else want.push(idx[t * 3]!, idx[t * 3 + 1]!, idx[t * 3 + 2]!);
    }
    expect(hidden > 12 * 60 && want.length > 0, `the scene exercises both grids (${hidden} hidden)`).toBe(true);
    const st = strip(geo, {});
    expect(st.boxes).toBe(boxes.length);
    expect(st.enclosed).toBe(hidden);
    expect(Array.from(geo.idx)).toEqual(want);
  });

  // props-tri-ratchet.test.mjs:107
  it("compact() on a hand-built buffer: order-preserving remap, blocks shifted", () => {
    // 5 vertices; vertex 1 and 3 unreferenced
    const geo = {
      pos: new Float64Array([0, 0, 0, 9, 9, 9, 1, 0, 0, 8, 8, 8, 0, 1, 0]) as ArrayLike<number>,
      nrm: new Float64Array(15).map((_, i) => i) as ArrayLike<number>,
      col: new Float64Array(15).map((_, i) => i / 15) as ArrayLike<number>,
      mat: new Float64Array([0, 5, 2, 5, 4]) as ArrayLike<number>,
      idx: new Uint32Array([0, 2, 4, 4, 2, 0]) as ArrayLike<number>,
      __blocks: [{ base: 0, count: 2, id: "a" }, { base: 2, count: 3, id: "b" }] as GeomBlock[],
    };
    const st = compact(geo);
    expect([st.vertsBefore, st.vertsAfter]).toEqual([5, 3]);
    expect(Array.from(geo.pos)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(geo.mat)).toEqual([0, 2, 4]);
    expect(Array.from(geo.nrm)).toEqual([0, 1, 2, 6, 7, 8, 12, 13, 14]);
    expect(Array.from(geo.idx)).toEqual([0, 1, 2, 2, 1, 0]);
    expect(geo.pos instanceof Float64Array && geo.idx instanceof Uint32Array, "column types kept").toBe(true);
    expect(geo.__blocks.map((b) => [b.base, b.count, b.id])).toEqual([[0, 1, "a"], [1, 2, "b"]]);
    // nothing to drop: untouched, same arrays
    const pos = geo.pos;
    expect(compact(geo).vertsAfter).toBe(3);
    expect(geo.pos).toBe(pos);
  });

  // hidden-faces.js:508-510: strip() drives stripSteps() straight through.
  it("stripSteps yields between passes and returns the same stats and indices as strip()", () => {
    const mk = (): GeomOut => {
      const g: GeomOut = { pos: [], nrm: [], col: [], mat: [], idx: [] };
      addBox(g, [0, 0, 0], [4, 4, 4], [0.5, 0.5, 0.5]);
      addBox(g, [0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5]);
      return g;
    };
    const a = mk(), b = mk();
    const sa = strip(a, {});
    const it = stripSteps(b, {});
    let yields = 0, r = it.next();
    while (!r.done) { yields++; r = it.next(); }
    expect(yields).toBe(4);
    expect({ ...r.value, ms: 0 }).toEqual({ ...sa, ms: 0 });
    expect(sa.enclosed).toBe(12);
    expect(Array.from(b.idx)).toEqual(Array.from(a.idx));
  });
});

describe("buildTrack: seal, strip, compact (tracks.js:344-367)", () => {
  it("empty props (the default stub) stay empty", () => {
    const t = buildTrack(defById("monza")!);
    const p = t.propsGeo!;
    expect(p.pos.length + p.idx.length).toBe(0);
    expect(p._hidden).toMatchObject({ trisBefore: 0, trisAfter: 0, enclosed: 0, buried: 0, bottom: 0, boxes: 0 });
    expect(p._compact).toMatchObject({ vertsBefore: 0, vertsAfter: 0 });
    expect(t.propTop).toBe(0);
  });

  // A builder that hands over growable accumulators (models.js:52 scratch) with a box
  // enclosed in another: sealed, the inner box stripped, its vertices compacted away.
  const nested = (compactProps: boolean | undefined) => {
    const plain: GeomOut = { pos: [], nrm: [], col: [], mat: [], idx: [] };
    const builder: PropsBuilder = {
      build(track) {
        const c: RV3 = [track.px[0]! + 300, track.py[0]! + 20, track.pz[0]! + 300];
        addBox(plain, c, [6, 6, 6], [0.5, 0.5, 0.5]);
        addBox(plain, c, [2, 2, 2], [0.5, 0.5, 0.5]);
        const out = scratch(64);
        for (const k of ["pos", "nrm", "col", "mat", "idx"] as const) for (const v of plain[k]!) out[k].push(v);
        return { out, glass: scratch(8), water: { pos: [], nrm: [], col: [], idx: [], mat: [] } };
      },
    };
    return buildTrack(defById("monza")!, compactProps === undefined ? { props: builder } : { props: builder, compactProps });
  };

  it("an accumulator builder is sealed, stripped and compacted", () => {
    const t = nested(undefined);
    const p = t.propsGeo!;
    expect(p.pos instanceof Float64Array && p.pos.length).toBe(24 * 3);
    expect(p.idx instanceof Uint32Array && p.idx.length).toBe(12 * 3);
    expect(p._hidden).toMatchObject({ trisBefore: 24, trisAfter: 12, enclosed: 12, boxes: 2 });
    expect(p._compact).toMatchObject({ vertsBefore: 48, vertsAfter: 24 });
    expect(t.geometryDiagnostics!.find((d) => d.name === "props")!.ok).toBe(true);
    expect(t.geometryDiagnostics!.find((d) => d.name === "glass")!.ok).toBe(true);
    expect(t.geo!.props).toBe(p);
  });

  it("compactProps: false strips but keeps every vertex", () => {
    const p = nested(false).propsGeo!;
    expect(p.pos.length).toBe(48 * 3);
    expect(p.idx.length).toBe(12 * 3);
    expect(p._compact).toBeUndefined();
  });
});
