/**
 * The lens context CamFeel.drive hands each camera family, and the shape of a
 * family's lens. From f1-game js/camera/feel.js:212-217 (the `ctx` built in
 * `drive`) and the shared `apply(mode, eye, tgt, ctx)` signature of
 * js/camera/drive-chase.js:13, drive-broadcast.js:18, drive-onboard.js:11.
 *
 * Every value is a followed, clamped blend: `sp` 0..1, `yaw` -1..1 (yaw rate /
 * 1.1), `brake` 0..1 (body pitch / 0.025), `slip` -1..1 (lateral slip / 6).
 */
import type { Vec3 } from "../contracts/track";

export interface LensCtx {
  readonly sp: number;
  readonly yaw: number;
  readonly brake: number;
  readonly slip: number;
}

/** A FOV delta in degrees for `mode`, or null when `mode` is another family's. Never moves eye or tgt. */
export type LensApply = (mode: string, eye: Vec3, tgt: Vec3, ctx: LensCtx | null | undefined) => number | null;
