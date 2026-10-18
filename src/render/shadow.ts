// Sun shadow box placement, pure so Vitest can pin it.
//
// Ported from f1-game js/render/shared/shadow-pass.js:251-284: the box is `sBox`
// metres (LT.shadowRange, default 80) centred on the camera EYE pushed forward by
// `min(20, sBox * 0.3)` along the car's heading (the look direction when there is
// no car), at the look target's height, and snapped in light space to `sBox / 4`
// so the map only re-renders on a cell crossing and does not swim. The snap uses
// the light's right (`xx..xz`) and up (`yx..yz`) axes as shadow-pass.js does.
import type { Vec3 } from "../contracts/track";

export const SHADOW_RANGE = 80;

export interface ShadowAnchor {
  /** Box centre in world space (before the light-space snap). */
  readonly ctr: Vec3;
  /** Snapped light-space coordinates along the light's right and up axes. */
  readonly lu: number;
  readonly lv: number;
}

export function shadowAnchor(
  eye: Readonly<Vec3>,
  target: Readonly<Vec3>,
  heading: number | null,
  right: Readonly<Vec3>,
  up: Readonly<Vec3>,
  sBox: number = SHADOW_RANGE,
): ShadowAnchor {
  const step = sBox / 4;
  let fbx = target[0] - eye[0],
    fbz = target[2] - eye[2];
  if (heading != null) {
    fbx = Math.sin(heading);
    fbz = Math.cos(heading);
  }
  const fbl = Math.hypot(fbx, fbz),
    fBias = Math.min(20, sBox * 0.3);
  if (fbl > 1e-6) {
    fbx = (fbx / fbl) * fBias;
    fbz = (fbz / fbl) * fBias;
  } else {
    fbx = 0;
    fbz = 0;
  }
  const cx = eye[0] + fbx,
    cy = target[1],
    cz = eye[2] + fbz;
  const [xx, xy, xz] = right;
  const [yx, yy, yz] = up;
  const lu = Math.round((xx * cx + xy * cy + xz * cz) / step) * step;
  const lv = Math.round((yx * cx + yy * cy + yz * cz) / step) * step;
  return { ctr: [cx, cy, cz], lu, lv };
}
