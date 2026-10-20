/* Apex 26 — lens only for cameras bolted to the car.
   A few centimetres of extra eye motion clips the bodywork, so speed and
   brake live in the lens. The eye stays where the rig put it.
   Ported verbatim from f1-game js/camera/drive-onboard.js:1-23 (DriveOnboard). */
import type { Vec3 } from "../contracts/track";
import type { LensCtx } from "./drive-lens";

export const MODES: readonly string[] = Object.freeze(["cockpit", "helmet", "hood", "visor", "tcam", "rear"]);

function spOf(ctx: LensCtx | null | undefined): number { return (ctx && ctx.sp) || 0; }
function brakeOf(ctx: LensCtx | null | undefined): number { return (ctx && ctx.brake) || 0; }

/** FOV delta in degrees, or null for another family (drive-onboard.js:11-18). */
export function apply(mode: string, _eye: Vec3, _tgt: Vec3, ctx: LensCtx | null | undefined): number | null {
  if (mode === "cockpit" || mode === "helmet") return 1.5 * spOf(ctx) + 1 * brakeOf(ctx);   // HELMET is the cockpit from inside the lid
  if (mode === "visor") return 1 * spOf(ctx);
  if (mode === "hood") return 2 * spOf(ctx) + 1.5 * brakeOf(ctx);
  if (mode === "tcam") return 2.5 * spOf(ctx);
  if (mode === "rear") return 1 * spOf(ctx) + 4 * brakeOf(ctx);
  return null;
}

export const DriveOnboard = Object.freeze({ apply, modes: MODES });
