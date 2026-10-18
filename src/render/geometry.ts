// Track mesh upload: f1-game `{pos, nrm, col, idx, mat?, trk?}` → three BufferGeometry.
//
// Ported from f1-game js/render/three/tlx.js:3634-3663 `buildGeometry` (the
// non-packed branch: Float32 attributes; the TLXShaders.packAttr quantisation is a
// later perf pass). Like TLX, every geometry carries `normal`, `color`, `mat` and
// `trk` so one lit material (one pipeline) serves every track mesh: an absent or
// wrong-length channel becomes a zero-filled one, and an empty mesh gets one
// degenerate vertex (tlx.js:3636).
import { BufferAttribute, BufferGeometry } from "three/webgpu";
import type { MeshData } from "../contracts/render";

/** Above this vertex count the index must be 32-bit (tlx.js:4292 createTexMesh's rule). */
export const U16_MAX_VERTS = 65535;

function sized(src: Float32Array | undefined, n: number): Float32Array {
  return src && src.length === n ? src : new Float32Array(n);
}

export function buildGeometry(data: MeshData): BufferGeometry {
  const g = new BufferGeometry();
  const pos = data.pos.length ? data.pos : new Float32Array(3);
  const verts = pos.length / 3;
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("normal", new BufferAttribute(sized(data.nrm, pos.length), 3));
  g.setAttribute("color", new BufferAttribute(sized(data.col, pos.length), 3));
  g.setAttribute("mat", new BufferAttribute(sized(data.mat, verts), 1));
  g.setAttribute("trk", new BufferAttribute(sized(data.trk, pos.length), 3));
  if (data.idx.length) {
    // f1-game's packIndex (tlx-chunked.js) narrows to Uint16 when every index fits.
    const idx = data.idx instanceof Uint32Array && verts <= U16_MAX_VERTS ? Uint16Array.from(data.idx) : data.idx;
    g.setIndex(new BufferAttribute(idx, 1));
  }
  g.computeBoundingSphere();
  return g;
}
