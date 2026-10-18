// Shared shapes for the procedural car port (f1-game js/car/*). The builders emit
// f1-game's plain mesh record (car3d.js:134 `{pos,nrm,col,mat,idx}`); ./three.ts turns
// it into a three BufferGeometry. Local space: +Z forward, +Y up, origin on the ground
// under the cockpit (car3d.js:1).

/** A point, direction or linear RGB colour. Colours are compared by IDENTITY in
 *  geometry.ts surfaceOf (car-geometry.js:8), so palette arrays must be passed as-is. */
export type Vec3 = readonly [number, number, number];

/** A mutable point the builders write through (f1-game mutates station arrays in place). */
export type MVec3 = [number, number, number];

/** Section measurement emitted by build() when opts.measure is set (car3d.js:2167). */
export interface MeshPart {
  name: string;
  vertices: number;
  sizeM: [number, number, number];
  centreM: [number, number, number];
  boundsZ: [number, number];
}

/** f1-game's mesh record. One entry per vertex in mat; pos/nrm/col are xyz-packed. */
export interface MeshOut {
  pos: number[];
  nrm: number[];
  col: number[];
  mat: number[];
  idx: number[];
  uv?: number[];
  parts?: MeshPart[];
}

export function newMesh(): MeshOut {
  return { pos: [], nrm: [], col: [], mat: [], idx: [] };
}
