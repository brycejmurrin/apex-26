// Car3D.build output summary shared by the recorded-fixture tests: vertex/index
// counts, bounding box, per-surface vertex counts and an FNV-1a hash over each
// array's Float64 bits (so the hash is bit-exact, -0 and NaN included).
import type { MeshOut } from "../../src/car/types";

export function fnv(a: readonly number[]): string {
  const dv = new DataView(new ArrayBuffer(8));
  let h = 0x811c9dc5;
  for (const v of a) {
    dv.setFloat64(0, v);
    for (let i = 0; i < 8; i++) h = Math.imul(h ^ dv.getUint8(i), 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** FNV-1a over a string's UTF-16 code units. */
export function fnvString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function summary(m: MeshOut) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.pos.length; i++) {
    const v = m.pos[i]!, k = i % 3;
    if (v < min[k]!) min[k] = v;
    if (v > max[k]!) max[k] = v;
  }
  const surfaces: Record<string, number> = {};
  for (const s of m.mat) surfaces[s] = (surfaces[s] ?? 0) + 1;
  return {
    vertices: m.mat.length, indices: m.idx.length, min, max, surfaces,
    hash: { pos: fnv(m.pos), nrm: fnv(m.nrm), col: fnv(m.col), mat: fnv(m.mat), idx: fnv(m.idx) },
  };
}

export type MeshSummary = ReturnType<typeof summary>;
