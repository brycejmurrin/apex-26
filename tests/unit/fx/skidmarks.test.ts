// src/fx/skidmarks.ts vs f1-game js/fx/skidmarks.js: a seeded parity run (ring, AI
// share and the expanded vertex batch, bit for bit), the assertions of f1-game
// tests/unit/skidmarks-cadence.test.mjs, and hand-derived spot values.
import { describe, expect, it } from "vitest";
import { AI_CAP, createSkidMarks, MAX_SKID, type SkidMarks, type SkidSink, type StampTimer } from "../../../src/fx/skidmarks";
import { f1Get, firstDiff, hasF1Fx, loadF1Fx, seeded } from "./f1-fx-vm";

const IDENT = (() => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; })();

function count(skids: Pick<SkidMarks, "draw">): number {
  let n = -1;
  skids.draw({ drawSkidBatch: (_v, vertCount) => { n = vertCount / 6; return true; } }, [0, 0, 0]);
  return n;
}

/** A random grounded basis: yaw about +Y, origin anywhere. */
function basis(A: () => number): Float32Array {
  const m = new Float32Array(16), a = A() * Math.PI * 2;
  m[0] = Math.cos(a); m[2] = -Math.sin(a); m[5] = 1; m[8] = Math.sin(a); m[10] = Math.cos(a); m[15] = 1;
  m[12] = A() * 400 - 200; m[13] = A() * 3; m[14] = A() * 400 - 200;
  return m;
}

interface SkApi {
  reset(): void;
  stamp(mat: ArrayLike<number>, laying: boolean, dt?: number): void;
  stampFor(t: StampTimer | null, mat: ArrayLike<number>, laying: boolean, dt?: number): boolean;
  draw(gfx: SkidSink, eye?: ArrayLike<number>): void;
  readonly count: number;
  readonly otherCount: number;
}

function run(sk: SkApi, frames: number): { log: unknown[]; batches: number[][] } {
  const A = seeded(0x51d);
  const timers = [{ t: 0 }, { t: 0 }, { t: 0 }];
  const log: unknown[] = [], batches: number[][] = [];
  const marks: number[][] = [];
  for (let f = 0; f < frames; f++) {
    const dt = f % 41 === 3 ? 0.4 : f % 29 === 0 ? 0 : 1 / 60 + A() * 0.02;
    sk.stamp(basis(A), A() < 0.7, f % 67 === 5 ? undefined : dt);
    for (const t of timers) log.push(sk.stampFor(t, basis(A), A() < 0.8, dt));
    if (f === 500) sk.reset();
    log.push(sk.count, sk.otherCount);
    sk.draw({
      drawSkidBatch: (verts, n, dirty) => { batches.push([n, dirty ? 1 : 0, ...verts.subarray(0, n * 5)]); return f % 13 !== 0; },
      drawMark: (m, w, l) => marks.push([...m, w, l]),
    }, [A() * 100, 0, A() * 100]);
  }
  log.push(marks.length, marks.flat());
  return { log, batches };
}

describe.skipIf(!hasF1Fx)("skidmarks parity with f1-game js/fx/skidmarks.js (VM)", () => {
  it("ring, AI share, per-mark fallback and every vertex batch match bit for bit over 800 frames", () => {
    const f1 = f1Get<{ create(): SkApi; MAX_SKID: number; AI_CAP: number }>(loadF1Fx(["js/fx/skidmarks.js"]), "SkidMarks");
    expect([f1.MAX_SKID, f1.AI_CAP]).toEqual([MAX_SKID, AI_CAP]);
    const a = run(createSkidMarks(), 800), b = run(f1.create(), 800);
    expect(a.log).toEqual(b.log);
    expect(a.batches.length).toBe(b.batches.length);
    for (let i = 0; i < a.batches.length; i++) expect(firstDiff(a.batches[i]!, b.batches[i]!), `batch ${i}`).toBeNull();
  });
});

describe("skidmarks cadence (skidmarks-cadence.test.mjs)", () => {
  const laidOver = (seconds: number, hz: number): number => {
    const skids = createSkidMarks();
    const dt = 1 / hz, frames = Math.round(seconds * hz);
    for (let i = 0; i < frames; i++) skids.stamp(IDENT, true, dt);
    return count(skids);
  };

  it("two seconds of laying leaves the same trail at 30, 60 and 144 Hz", () => {
    for (const hz of [30, 60, 144]) expect(Math.abs(laidOver(2, hz) - 24), `${hz} Hz`).toBeLessThanOrEqual(1);
  });

  it("the first stamp of a slide lands at once, and lifting off re-arms it", () => {
    const skids = createSkidMarks();
    skids.stamp(IDENT, true, 1 / 60);
    expect(count(skids)).toBe(1);
    skids.stamp(IDENT, false, 1 / 60);
    skids.stamp(IDENT, true, 1 / 60);
    expect(count(skids)).toBe(2);
  });

  it("a caller that passes no dt is charged one nominal frame per call", () => {
    const skids = createSkidMarks();
    for (let i = 0; i < 10; i++) skids.stamp(IDENT, true);
    expect(count(skids)).toBe(2);
  });

  it("other cars stamp on their own cadence, inside a capped share of the ring", () => {
    const skids = createSkidMarks();
    const a = { t: 0 }, b = { t: 0 };
    for (let i = 0; i < 60; i++) {
      skids.stamp(IDENT, true, 1 / 60);
      skids.stampFor(a, IDENT, true, 1 / 60);
      skids.stampFor(b, IDENT, true, 1 / 60);
    }
    expect(count(skids)).toBe(36);
    expect(skids.otherCount).toBe(24);
    for (let i = 0; i < 240; i++) { skids.stampFor(a, IDENT, true, 1 / 60); skids.stampFor(b, IDENT, true, 1 / 60); }
    expect(skids.otherCount).toBe(AI_CAP);
    expect(skids.stampFor(a, IDENT, true, 1)).toBe(true);
    for (let i = 0; i < 60 * 12; i++) skids.stamp(IDENT, true, 1 / 60);
    expect(count(skids)).toBe(MAX_SKID);
    expect(skids.otherCount, "overwritten rival marks leave the share").toBe(0);
    expect(skids.stampFor(b, IDENT, true, 1)).toBe(true);
    skids.reset();
    expect(count(skids)).toBe(0);
    expect(skids.otherCount).toBe(0);
    expect(skids.stampFor(null, IDENT, true, 1 / 60)).toBe(false);
  });

  it("rival quota refreshes oldest rival marks without moving the player ring", () => {
    const skids = createSkidMarks(), timer = { t: 0 }, mat = IDENT.slice();
    for (let i = 0; i < 80; i++) { mat[12] = -1000 - i; skids.stamp(mat, true, 1); }
    for (let i = 0; i < 600; i++) { mat[12] = i; skids.stampFor(timer, mat, true, 1); }
    const centers: number[] = [];
    skids.draw({ drawSkidBatch: (verts, n) => {
      for (let i = 0; i < n * 5; i += 30) centers.push((verts[i]! + verts[i + 10]!) / 2);
      return true;
    } });
    expect(skids.otherCount).toBe(40);
    expect(centers.filter((x) => x < 0).length).toBe(80);
    expect(centers.includes(599)).toBe(true);
    mat[12] = -2000; skids.stamp(mat, true, 1);
    expect(skids.otherCount).toBe(40);
  });
});

describe("skidmarks spot values", () => {
  it("an identity mark at (10, 0, 20) expands to a 0.6 x 2.2 quad 2 cm up, uv ±1 (skidmarks.js:403-422)", () => {
    const skids = createSkidMarks(), m = IDENT.slice();
    m[12] = 10; m[14] = 20;
    skids.stamp(m, true, 1 / 60);
    let got: number[] = [], dirty: boolean[] = [];
    const sink: SkidSink = { drawSkidBatch: (v, n, d) => { got = Array.from(v.subarray(0, n * 5)); dirty.push(d); return true; } };
    skids.draw(sink);
    const f = Math.fround;
    expect(got.slice(0, 10)).toEqual([f(10 - 0.3), f(0.02), f(20 - 1.1), -1, -1, f(10 - 0.3), f(0.02), f(20 + 1.1), -1, 1]);
    skids.draw(sink);
    expect(dirty, "rebuilt once, then re-issued clean").toEqual([true, false]);
  });

  it("without a batch path, marks past 170 m are culled (skidmarks.js:474-486)", () => {
    const skids = createSkidMarks(), m = IDENT.slice();
    skids.stamp(m, true, 1);
    m[12] = 200; skids.stamp(m, true, 1);
    const drawn: number[] = [];
    skids.draw({ drawSkidBatch: () => false, drawMark: (mm, w, l) => drawn.push(mm[12]!, w, l) }, [0, 0, 0]);
    expect(drawn).toEqual([0, 0.6, 2.2]);
  });
});
