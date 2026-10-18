// Seated-rig math (pure). Ported from f1-game js/xr/xr-rig.js:1-229 (XrRig):
// composeEye, unionViewProjTo, worldFromAnchorTo, invertRigidTo,
// recenterOffsetFromPose, stickToSteer. No DOM, no three, no session.
//
// WebXR matrices are column-major Float32Array(16). A view's transform.matrix is
// the VIEWER pose in the reference space (eye -> reference); the view matrix is its
// inverse (reference -> eye). The seated cockpit anchor is folded in so an identity
// HMD pose looks straight out of the car.
//
// On three's XRManager path (./three-binding.ts) three builds the per-eye cameras
// itself from `camera.parent.matrixWorld`; that parent is `worldFromAnchorTo`'s
// matrix. composeEye / unionViewProjTo stay for callers that consume per-eye
// matrices directly (a custom present or a cull pass).
import { ident, invertTo, mulTo, type Mat4, type Mat4In } from "./mat4";

export type Vec3 = [number, number, number];
export type Vec3In = ArrayLike<number>;

/** The seated cockpit anchor: driver eye in world, look direction, and up (xr-rig.js:76-79). */
export interface XrAnchor {
  eye: Vec3In;
  fwd: Vec3In;
  up?: Vec3In | null;
}

export interface XrViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One eye's frame bag (xr-session.js:363-366). */
export interface EyeFrame {
  view: Mat4;
  proj: Mat4;
  viewProj: Mat4;
  invProj: Mat4;
  invViewProj: Mat4;
  eye: Vec3;
  viewport: XrViewport | null;
}

export function makeEyeFrame(): EyeFrame {
  return { view: ident(), proj: ident(), viewProj: ident(), invProj: ident(), invViewProj: ident(), eye: [0, 0, 0], viewport: null };
}

const n = (a: ArrayLike<number>, i: number): number => a[i] as number;

// Scratch: composeEye runs up to twice per frame (L/R); no allocation.
const _view = ident();
const _refFromWorld = ident();
const _worldFromRef = ident();
const _tmp = ident();

/** xr-rig.js:27-40: invert a rigid (rotation + translation) column-major 4x4 into `out`. */
export function invertRigidTo<T extends Mat4>(out: T, m: Mat4In): T {
  // R^T
  out[0] = n(m, 0); out[1] = n(m, 4); out[2] = n(m, 8); out[3] = 0;
  out[4] = n(m, 1); out[5] = n(m, 5); out[6] = n(m, 9); out[7] = 0;
  out[8] = n(m, 2); out[9] = n(m, 6); out[10] = n(m, 10); out[11] = 0;
  // t' = -R^T * t
  const tx = n(m, 12), ty = n(m, 13), tz = n(m, 14);
  out[12] = -(n(out, 0) * tx + n(out, 4) * ty + n(out, 8) * tz);
  out[13] = -(n(out, 1) * tx + n(out, 5) * ty + n(out, 9) * tz);
  out[14] = -(n(out, 2) * tx + n(out, 6) * ty + n(out, 10) * tz);
  out[15] = 1;
  return out;
}

/**
 * xr-rig.js:42-67: a world<-reference basis from the seated anchor. Columns are
 * right, up, -fwd (OpenGL camera convention: the view looks down -Z).
 */
export function worldFromAnchorTo<T extends Mat4>(out: T, eye: Vec3In, fwd: Vec3In, up: Vec3In): T {
  let fx = n(fwd, 0), fy = n(fwd, 1), fz = n(fwd, 2);
  const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  let ux = n(up, 0), uy = n(up, 1), uz = n(up, 2);
  const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  // lookAt: right = cross(up, z) where z = normalize(eye - target) = -fwd.
  const zx = -fx, zy = -fy, zz = -fz;
  let rx = uy * zz - uz * zy, ry = uz * zx - ux * zz, rz = ux * zy - uy * zx;
  const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
  // re-orthogonalise up
  ux = zy * rz - zz * ry; uy = zz * rx - zx * rz; uz = zx * ry - zy * rx;
  out[0] = rx; out[1] = ry; out[2] = rz; out[3] = 0;
  out[4] = ux; out[5] = uy; out[6] = uz; out[7] = 0;
  out[8] = zx; out[9] = zy; out[10] = zz; out[11] = 0;
  out[12] = n(eye, 0); out[13] = n(eye, 1); out[14] = n(eye, 2); out[15] = 1;
  return out;
}

const UP: Vec3 = [0, 1, 0];

/**
 * xr-rig.js:69-125: compose one eye into `out`. `viewMat` / `projMat` are the XRView
 * matrices (view = inverse of transform.matrix). A missing view is the mannequin at
 * the cockpit looking along fwd; a missing proj writes identity so readers never NaN.
 */
export function composeEye(anchor: XrAnchor, viewMat: Mat4In | null, projMat: Mat4In | null, out: EyeFrame): EyeFrame {
  worldFromAnchorTo(_worldFromRef, anchor.eye, anchor.fwd, anchor.up || UP);
  invertRigidTo(_refFromWorld, _worldFromRef);

  // view_from_world = view_from_ref * ref_from_world
  if (viewMat && viewMat.length >= 16) {
    mulTo(_view, viewMat, _refFromWorld);
  } else {
    for (let i = 0; i < 16; i++) _view[i] = n(_refFromWorld, i);
  }

  const proj = projMat && projMat.length >= 16 ? projMat : null;
  const oView = out.view, oProj = out.proj, oVP = out.viewProj, oInvP = out.invProj, oInvVP = out.invViewProj, oEye = out.eye;

  for (let i = 0; i < 16; i++) oView[i] = n(_view, i);
  if (proj) {
    for (let i = 0; i < 16; i++) oProj[i] = n(proj, i);
  } else {
    for (let i = 0; i < 16; i++) oProj[i] = i % 5 === 0 ? 1 : 0;
  }
  mulTo(oVP, oProj, oView);
  invertTo(oInvP, oProj);
  invertTo(oInvVP, oVP);

  // Eye position = world translation of the inverse view.
  invertRigidTo(_tmp, oView);
  oEye[0] = n(_tmp, 12); oEye[1] = n(_tmp, 13); oEye[2] = n(_tmp, 14);
  return out;
}

// Scratch for unionViewProjTo (per frame: no allocation).
const _uM = ident(), _uW = ident(), _uP = ident();
const _uC: Vec3[] = [];

/** The eye fields unionViewProjTo reads. */
export interface UnionEye {
  view: Mat4In;
  proj: Mat4In | null;
}

/**
 * xr-rig.js:127-191: ONE cull frustum containing every eye's (three.js
 * WebXRManager's setProjectionFromUnion, fitted to corners). WebXR eye projections
 * are asymmetric, so culling with eye 0's planes dropped the wedge only the right
 * eye sees (f1-game R3-RENDER-3). Writes the union viewProj into `out`; false (out
 * untouched) when an eye is not a finite-near perspective.
 */
export function unionViewProjTo(out: Mat4, eyes: readonly UnionEye[]): boolean {
  const e0 = eyes[0];
  if (!e0) return false;
  const v0 = e0.view;
  let nC = 0, lt = Infinity, rt = -Infinity, xl = Infinity, xr = -Infinity, ys = 0, zs = -Infinity;
  for (let i = 0; i < eyes.length; i++) {
    const eye = eyes[i] as UnionEye;
    const P = eye.proj;
    if (!P || !(n(P, 0) > 0) || !(n(P, 5) > 0) || Math.abs(n(P, 11) + 1) > 1e-6) return false;
    const near = n(P, 14) / (n(P, 10) - 1), fr = n(P, 14) / (n(P, 10) + 1);
    if (!(near > 0)) return false;
    const f = fr > near && Number.isFinite(fr) ? fr : 1e5; // infinite far: past any world
    const tl = (n(P, 8) - 1) / n(P, 0), tr = (n(P, 8) + 1) / n(P, 0), tb = (n(P, 9) - 1) / n(P, 5), tt = (n(P, 9) + 1) / n(P, 5);
    if (tl < lt) lt = tl;
    if (tr > rt) rt = tr;
    mulTo(_uM, v0, invertRigidTo(_uW, eye.view)); // eye i view -> eye 0 view
    const ex = n(_uM, 12);
    if (ex < xl) xl = ex;
    if (ex > xr) xr = ex;
    ys += n(_uM, 13); if (n(_uM, 14) > zs) zs = n(_uM, 14);
    for (let k = 0; k < 8; k++) {
      const d = k < 4 ? near : f, x = (k & 1 ? tr : tl) * d, y = (k & 2 ? tt : tb) * d;
      const c = _uC[nC] || (_uC[nC] = [0, 0, 0]);
      c[0] = n(_uM, 0) * x + n(_uM, 4) * y - n(_uM, 8) * d + n(_uM, 12);
      c[1] = n(_uM, 1) * x + n(_uM, 5) * y - n(_uM, 9) * d + n(_uM, 13);
      c[2] = n(_uM, 2) * x + n(_uM, 6) * y - n(_uM, 10) * d + n(_uM, 14);
      nC++;
    }
  }
  if (!(rt > lt)) return false;
  const zOff = (xr - xl) / (rt - lt);
  const ax = xl - lt * zOff, ay = ys / eyes.length, az = zs + zOff;
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, near = Infinity, far = 0;
  for (let k = 0; k < nC; k++) {
    const c = _uC[k] as Vec3, d = az - c[2];
    if (!(d > 1e-6)) return false;
    const tx = (c[0] - ax) / d, ty = (c[1] - ay) / d;
    if (tx < mnx) mnx = tx;
    if (tx > mxx) mxx = tx;
    if (ty < mny) mny = ty;
    if (ty > mxy) mxy = ty;
    if (d < near) near = d;
    if (d > far) far = d;
  }
  for (let i = 0; i < 16; i++) _uP[i] = 0;
  _uP[0] = 2 / (mxx - mnx); _uP[8] = (mxx + mnx) / (mxx - mnx);
  _uP[5] = 2 / (mxy - mny); _uP[9] = (mxy + mny) / (mxy - mny);
  _uP[10] = -(far + near) / (far - near); _uP[11] = -1; _uP[14] = -2 * far * near / (far - near);
  for (let i = 0; i < 16; i++) _uW[i] = n(v0, i);
  _uW[12] = n(_uW, 12) - ax; _uW[13] = n(_uW, 13) - ay; _uW[14] = n(_uW, 14) - az; // T(-apex) * view0
  mulTo(out, _uP, _uW);
  return true;
}

/** An `XRRigidTransform` init: DOMPointInit position + orientation. */
export interface RigidInit {
  position: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number; w: number };
}

/**
 * xr-rig.js:193-208: origin of the seated space in the BASE reference space.
 * getOffsetReferenceSpace applies this transform's inverse to viewer poses, so use
 * the head's position and yaw, not their inverse. Position zeroes at centre; later
 * head movement and pitch/roll remain.
 */
export function recenterOffsetFromPose(poseMatrix: Mat4In): RigidInit {
  const m = poseMatrix;
  // +Z column gives yaw relative to WebXR's identity (which looks down -Z).
  const yaw = Math.atan2(n(m, 8), n(m, 10));
  return {
    position: { x: n(m, 12), y: n(m, 13), z: n(m, 14) },
    orientation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
  };
}

/** xr-rig.js:210-218: thumbstick X in [-1,1] -> a -1..1 steer command past a dead zone. */
export function stickToSteer(x: number, deadzone?: number | null): number {
  const dz = deadzone == null ? 0.12 : deadzone;
  const v = +x || 0;
  if (Math.abs(v) < dz) return 0;
  const s = Math.sign(v);
  const mag = (Math.abs(v) - dz) / (1 - dz);
  return s * mag;
}
