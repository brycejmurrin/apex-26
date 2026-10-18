/* Apex 26 — lens only for the broadcast cameras.
   The rig places the helicopter, the crane, the wall. This does not move
   them again. The return is a FOV delta in degrees, or null for another family.
   Ported verbatim from f1-game js/camera/drive-broadcast.js:1-34 (DriveBroadcast). */
import type { Vec3 } from "../contracts/track";
import type { LensCtx } from "./drive-lens";

function n(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

function read(ctx: Partial<LensCtx> | null | undefined): LensCtx {
  const c = ctx || {};
  return { sp: n(c.sp), yaw: n(c.yaw), brake: n(c.brake), slip: n(c.slip) };
}

/** drive-broadcast.js:18-29. */
export function apply(mode: string, _eye: Vec3, _tgt: Vec3, ctx: Partial<LensCtx> | null | undefined): number | null {
  const c = read(ctx);
  if (mode === "heli") return 8 * c.sp + 3 * Math.abs(c.yaw);
  if (mode === "side") return 5 * c.sp;
  if (mode === "cinematic") return 4 * c.sp;
  if (mode === "overhead") return 3 * c.sp;
  if (mode === "drone") return 6 * c.sp + 2 * Math.abs(c.yaw);
  if (mode === "rival") return 6 * c.sp;
  if (mode === "pitwall") return 2 * c.sp;
  if (mode === "trackside") return 3 * c.sp + 0.5 * Math.abs(c.yaw);
  return null;
}

export const MODES: readonly string[] = Object.freeze(["heli", "side", "cinematic", "overhead", "drone", "rival", "pitwall", "trackside"]);

export const DriveBroadcast = Object.freeze({ apply, modes: MODES });
