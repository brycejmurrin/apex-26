// Column-major 4x4 helpers the XR rig needs. Ported verbatim from f1-game
// js/core/mat4.js:14-85 (`ident`, `mulTo`, `invertTo`); the rest of M4 is not used
// by XR. Float operation order is f1-game's (AGENTS.md §Porting).

/** A writable column-major 4x4: WebXR's `Float32Array(16)` or a 16-number array. */
export type Mat4 = Float32Array | number[];
/** A read-only matrix input (an `XRView.projectionMatrix`, a pose's `matrix`). */
export type Mat4In = ArrayLike<number>;

const at = (m: Mat4In, i: number): number => m[i] as number;

/** mat4.js:14-18 */
export function ident(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** mat4.js:20-29: out = a * b. */
export function mulTo<T extends Mat4>(out: T, a: Mat4In, b: Mat4In): T {
  for (let c = 0; c < 4; c++) {
    const b0 = at(b, c * 4), b1 = at(b, c * 4 + 1), b2 = at(b, c * 4 + 2), b3 = at(b, c * 4 + 3);
    out[c * 4] = at(a, 0) * b0 + at(a, 4) * b1 + at(a, 8) * b2 + at(a, 12) * b3;
    out[c * 4 + 1] = at(a, 1) * b0 + at(a, 5) * b1 + at(a, 9) * b2 + at(a, 13) * b3;
    out[c * 4 + 2] = at(a, 2) * b0 + at(a, 6) * b1 + at(a, 10) * b2 + at(a, 14) * b3;
    out[c * 4 + 3] = at(a, 3) * b0 + at(a, 7) * b1 + at(a, 11) * b2 + at(a, 15) * b3;
  }
  return out;
}

/** mat4.js:60-85: general inverse; a singular matrix writes identity. */
export function invertTo<T extends Mat4>(out: T, m: Mat4In): T {
  const a00 = at(m, 0), a01 = at(m, 1), a02 = at(m, 2), a03 = at(m, 3);
  const a10 = at(m, 4), a11 = at(m, 5), a12 = at(m, 6), a13 = at(m, 7);
  const a20 = at(m, 8), a21 = at(m, 9), a22 = at(m, 10), a23 = at(m, 11);
  const a30 = at(m, 12), a31 = at(m, 13), a32 = at(m, 14), a33 = at(m, 15);
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) {
    out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  }
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}
