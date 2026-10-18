/**
 * AI PACE BAND: gap-to-player catch-up (opt-in) vs race-scripted fixed pace
 * (the default). Pure factor/apply helpers.
 *
 * Port of f1-game js/physics/ai-band.js (`AiBand`, :18-75), verbatim. The
 * module-level mode becomes an explicit argument (the race reads the setting).
 */
export const START_GUARD_S = 8;
export const GAP_REF_M = 700;
export type AiPaceMode = "scripted" | "catchup";
export const MODES: readonly AiPaceMode[] = Object.freeze(["scripted", "catchup"]);

export function isMode(v: unknown): v is AiPaceMode {
  return v === "scripted" || v === "catchup";
}
export function normalize(v: unknown): AiPaceMode {
  return isMode(v) ? v : "scripted";
}

export interface BandCtx {
  readonly mode: AiPaceMode;
  readonly leadProg: number;
  readonly carProg: number;
  readonly trackTotal: number;
  readonly raceT: number;
  readonly launchT0: number;
  readonly bandAuth: number;
}

/** Catch-up factor in [0, bandAuth]: zero in scripted mode, inside the start guard, once lapped, or when the AI is ahead. */
export function factor(ctx: BandCtx | null | undefined): number {
  if (!ctx) return 0;
  const m = normalize(ctx.mode);
  if (m !== "catchup") return 0;
  const lead = ctx.leadProg,
    car = ctx.carProg,
    total = ctx.trackTotal;
  if (!(Number.isFinite(lead) && Number.isFinite(car) && Number.isFinite(total) && total > 0)) return 0;
  const gap = lead - car;
  if (!(gap > 0 && gap < total * 0.5)) return 0;
  const t0 = ctx.launchT0 || 0;
  if ((ctx.raceT || 0) - t0 <= START_GUARD_S) return 0;
  const auth = Number.isFinite(ctx.bandAuth) ? Math.max(0, ctx.bandAuth) : 0;
  return Math.min(gap / GAP_REF_M, 1) * auth;
}

/** Scale vmax by the catch-up factor, capped at BAND_CEIL. */
export function applyVmax(vmax: number, bandFactor: number, paceScale: number, bandCeil: number): { vmax: number; bandNow: number } {
  const f = Math.max(0, bandFactor || 0);
  if (f <= 0) return { vmax: vmax, bandNow: 0 };
  const scale = Math.max(1e-6, paceScale || 1);
  const ceil = Number.isFinite(bandCeil) ? bandCeil : 1;
  const bandCap = Math.max(1, ceil / scale);
  return { vmax: vmax * Math.min(1 + f, bandCap), bandNow: f };
}
