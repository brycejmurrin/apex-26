// A procedural stand-in track for the render demo when no f1-game mesh dump is
// present (CI, a fresh clone): a flat ring road, a terrain disc and a ring of
// boxes to cast shadows. Same `{pos, nrm, col, idx}` format as tracks.js uploads.
import type { MeshData, TrackMeshKey } from "../../contracts/render";

interface Buf {
  pos: number[];
  nrm: number[];
  col: number[];
  idx: number[];
}
const buf = (): Buf => ({ pos: [], nrm: [], col: [], idx: [] });
const done = (b: Buf): MeshData => ({
  pos: Float32Array.from(b.pos),
  nrm: Float32Array.from(b.nrm),
  col: Float32Array.from(b.col),
  idx: Uint32Array.from(b.idx),
});

function quad(b: Buf, p: number[][], n: number[], c: number[]): void {
  const base = b.pos.length / 3;
  for (const v of p) {
    b.pos.push(v[0]!, v[1]!, v[2]!);
    b.nrm.push(n[0]!, n[1]!, n[2]!);
    b.col.push(c[0]!, c[1]!, c[2]!);
  }
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function box(b: Buf, x: number, z: number, w: number, h: number, d: number, c: number[]): void {
  const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2;
  quad(b, [[x0, h, z0], [x0, h, z1], [x1, h, z1], [x1, h, z0]], [0, 1, 0], c);
  quad(b, [[x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1]], [0, 0, 1], c);
  quad(b, [[x1, 0, z0], [x0, 0, z0], [x0, h, z0], [x1, h, z0]], [0, 0, -1], c);
  quad(b, [[x1, 0, z1], [x1, 0, z0], [x1, h, z0], [x1, h, z1]], [1, 0, 0], c);
  quad(b, [[x0, 0, z0], [x0, 0, z1], [x0, h, z1], [x0, h, z0]], [-1, 0, 0], c);
}

export const RING_R = 200;

export function fallbackTrack(): Map<TrackMeshKey, MeshData> {
  const road = buf(), terrain = buf(), props = buf();
  const N = 256, hw = 7;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
    const p = (a: number, r: number, y: number) => [Math.cos(a) * r, y, Math.sin(a) * r];
    quad(road, [p(a0, RING_R - hw, 0.02), p(a0, RING_R + hw, 0.02), p(a1, RING_R + hw, 0.02), p(a1, RING_R - hw, 0.02)], [0, 1, 0], [0.09, 0.09, 0.1]);
    quad(terrain, [p(a0, 0, 0), p(a0, RING_R * 2, 0), p(a1, RING_R * 2, 0), p(a1, 0, 0)], [0, 1, 0], [0.16, 0.3, 0.09]);
  }
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    box(props, Math.cos(a) * (RING_R + 20), Math.sin(a) * (RING_R + 20), 4, 3 + (i % 5) * 2, 4, [0.55, 0.5, 0.45]);
  }
  return new Map<TrackMeshKey, MeshData>([
    ["road", done(road)],
    ["terrain", done(terrain)],
    ["props", done(props)],
  ]);
}
