/* Optional, bounded cover artwork. Coordinates are shared by crown, tail and both flanks.
   Ported verbatim from f1-game js/car/livery-design.js:1-222 (the IIFE becomes module scope). */
import type { LiveryCtx2D, LiveryRect } from "./livery-canvas";

export type RangeKey = "patternWidth" | "patternRepeat" | "patternOffset" | "patternTaper" | "patternOpacity"
  | "patternRotation" | "patternStretch" | "patternWeight";

/** The livery fields the pattern painter reads. Sliders arrive as numbers or numeric strings. */
export type DesignLivery = { [K in RangeKey]?: unknown } & {
  spineLogo?: string | null | undefined;
  patternTint?: unknown;
  patternSecond?: unknown;
  c1?: unknown;
  c2?: unknown;
  finHandoff?: string | null | undefined;
  patternPlacement?: string | null | undefined;
  patternSide?: string | null | undefined;
};

export interface DesignRegions { crest?: LiveryRect | undefined; tail?: LiveryRect | undefined; spineSideL?: LiveryRect | undefined }
export interface DesignFlank { zF: number; zLen: number; sTop: number; sLen: number }
export interface DesignFlankFrame { R: LiveryRect; fx(u: number): number }

export const PATTERNS: readonly string[] = Object.freeze(["ribbon", "brokenChevron", "contours", "honeycomb", "segments", "gradient", "twoTone", "checker", "diamonds", "slashes", "pinstripes", "dots", "lightning", "waves", "sunburst", "scallops", "herringbone", "circuit", "shards", "pixelFade", "speedlines"]);
export const SECOND_COLOR: readonly string[] = Object.freeze(["gradient", "twoTone", "segments", "checker", "diamonds", "dots", "waves", "sunburst", "scallops", "herringbone", "circuit", "shards", "pixelFade"]);
export const LINE_PATTERNS: readonly string[] = Object.freeze(["contours", "honeycomb", "waves", "herringbone", "circuit", "speedlines"]);
export const RANGES: Readonly<Record<RangeKey, readonly [number, number, number]>> = Object.freeze({
  patternWidth: [20, 100, 70], patternRepeat: [2, 12, 6], patternOffset: [-40, 40, 0],
  patternTaper: [0, 80, 20], patternOpacity: [10, 100, 100],
  patternRotation: [-180, 180, 0], patternStretch: [50, 200, 100], patternWeight: [25, 200, 100],
});
export const PALETTES: readonly { readonly name: string; readonly colors: readonly string[] }[] = Object.freeze([
  { name: "Midnight electric", colors: ["#101728", "#27e6bd", "#f6f4e9"] },
  { name: "Heritage cream", colors: ["#731b27", "#f2dfb0", "#182623"] },
  { name: "Glacier", colors: ["#e8f2f7", "#2078cf", "#202735"] },
  { name: "Solar", colors: ["#251d35", "#ff742b", "#ffe65b"] },
  { name: "Orchid", colors: ["#271b42", "#df68ed", "#83e5f1"] },
  { name: "Gulf coast", colors: ["#14384c", "#fa8636", "#9ae3f2"] },
  { name: "Acid carbon", colors: ["#15191b", "#c9fa36", "#f0f2e7"] },
  { name: "Cherry blossom", colors: ["#441b38", "#ffb9d0", "#fff0d8"] },
  { name: "Copper storm", colors: ["#182b37", "#cc854d", "#aec9ce"] },
]);
export function value(liv: DesignLivery | null | undefined, key: RangeKey): number {
  const r = RANGES[key], raw = liv && liv[key];
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.max(r[0], Math.min(r[1], n)) : r[2];
}
function color(v: unknown, fallback: string): string {
  return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
    ? "rgb(" + (v as number[]).map((n) => Math.round(Math.max(0, Math.min(1, n)) * 255)).join(",") + ")" : fallback;
}
// No textures, timers or random state: identical inputs produce identical art at every atlas tier.
function paint(ctx: LiveryCtx2D, liv: DesignLivery): void {
  const kind = liv.spineLogo;
  const width = value(liv, "patternWidth") / 100 * 0.8;
  const offset = value(liv, "patternOffset") / 100;
  const taper = value(liv, "patternTaper") / 100;
  const step = 1.5 / Math.round(value(liv, "patternRepeat"));
  const primary = color(liv.patternTint, color(liv.c2, "#ffffff"));
  const secondary = color(liv.patternSecond, color(liv.c1, "#161b25"));
  const half = (z: number) => width * (1 - taper * Math.max(0, Math.min(1, (z - 0.5) / 1.5)));
  ctx.save(); ctx.globalAlpha *= value(liv, "patternOpacity") / 100;
  ctx.beginPath(); ctx.moveTo(offset - half(0.5), 0.5); ctx.lineTo(offset + half(0.5), 0.5);
  ctx.lineTo(offset + half(2), 2); ctx.lineTo(offset - half(2), 2); ctx.closePath(); ctx.clip();
  const angle = value(liv, "patternRotation") * Math.PI / 180, stretch = value(liv, "patternStretch") / 100;
  if (angle || stretch !== 1) {
    const a = Math.cos(angle), b = Math.sin(angle), c = -b * stretch, d = a * stretch;
    // Transform the artwork after clipping: coverage and wrap registration stay on the car.
    ctx.transform(a, b, c, d, offset - a * offset - c * 1.25, 1.25 - b * offset - d * 1.25);
  }
  const weight = value(liv, "patternWeight") / 100;
  ctx.fillStyle = primary; ctx.strokeStyle = primary; ctx.lineWidth = 0.018 * weight;
  if (kind === "ribbon") ctx.fillRect(offset - width, 0.5, width * 2, 1.5);
  else if (kind === "gradient") {
    const fill = ctx.createLinearGradient(0, 0.5, 0, 2);
    fill.addColorStop(0, primary); fill.addColorStop(1, secondary);
    ctx.fillStyle = fill; ctx.fillRect(-1.2, 0.5, 2.4, 1.5);
  } else if (kind === "twoTone") {
    ctx.fillRect(-1.2, 0.5, 2.4, 1.5);
    ctx.fillStyle = secondary; ctx.beginPath(); ctx.moveTo(offset - 0.18, 0.5);
    ctx.lineTo(offset + 0.18, 2); ctx.lineTo(1.2, 2); ctx.lineTo(1.2, 0.5); ctx.closePath(); ctx.fill();
  } else if (kind === "brokenChevron") {
    for (let z = 0.3; z < 2.3; z += step) {
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(offset + side * 0.035, z);
        ctx.lineTo(offset + side * width, z + step * 0.65);
        ctx.lineTo(offset + side * width, z + step * 0.9);
        ctx.lineTo(offset + side * 0.035, z + step * 0.25); ctx.closePath(); ctx.fill();
      }
    }
  } else if (kind === "contours") {
    for (let z = 0.25; z < 2.5; z += step) {
      ctx.beginPath();
      for (let j = 0; j <= 48; j++) {
        const x = -1.2 + j * 0.05, y = z + Math.sin((x - offset) * 5) * step * 0.55;
        if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
  } else if (kind === "segments") {
    for (let z = 0.5; z < 2; z += step) for (const side of [-1, 1]) {
      ctx.fillStyle = side < 0 ? primary : secondary;
      ctx.fillRect(offset + (side < 0 ? -width : 0.025), z, width - 0.025, step * 0.68);
    }
  } else if (kind === "pinstripes") {
    for (let col = -12; col <= 12; col++) ctx.fillRect(offset + col * step - step * 0.09, 0.5, step * 0.18, 1.5);
  } else if (kind === "slashes" || kind === "lightning") {
    for (let z = -1; z < 3; z += step) {
      ctx.beginPath(); ctx.moveTo(-1.2, z);
      if (kind === "lightning") { ctx.lineTo(offset + 0.1, z + 0.3); ctx.lineTo(offset - 0.1, z + 0.48); }
      ctx.lineTo(1.2, z + 0.8); ctx.lineTo(1.2, z + 0.8 + step * 0.3);
      if (kind === "lightning") { ctx.lineTo(offset - 0.2, z + 0.48 + step * 0.3); ctx.lineTo(offset, z + 0.3 + step * 0.3); }
      ctx.lineTo(-1.2, z + step * 0.3); ctx.closePath(); ctx.fill();
    }
  } else if (["checker", "diamonds", "dots"].includes(kind as string)) {
    for (let col = -12; col <= 12; col++) for (let row = 0; row <= 12; row++) {
      const x = offset + col * step, z = 0.5 + row * step;
      if (x < offset - width - step || x > offset + width + step || z > 2 + step) continue;
      ctx.fillStyle = (col + row) % 2 ? primary : secondary;
      if (kind === "checker") ctx.fillRect(x, z, step, step);
      else {
        ctx.beginPath();
        const points = kind === "dots" ? 16 : 4, radius = step * (kind === "dots" ? 0.22 : 0.44);
        for (let i = 0; i < points; i++) {
          const angle = i * Math.PI * 2 / points, px = x + Math.cos(angle) * radius, pz = z + Math.sin(angle) * radius;
          if (i) ctx.lineTo(px, pz); else ctx.moveTo(px, pz);
        }
        ctx.closePath(); ctx.fill();
      }
    }
  } else if (kind === "waves" || kind === "speedlines") {
    for (let row = -6; row <= 18; row++) {
      const z = 0.5 + row * step;
      ctx.strokeStyle = kind === "waves" && row % 2 ? secondary : primary;
      ctx.beginPath();
      for (let j = 0; j <= 48; j++) {
        const x = offset - 1.8 + j * 0.075;
        const y = z + (kind === "waves" ? Math.sin((x - offset) * 9 + row * 0.65) * step * 0.38 : (x - offset) * 0.12);
        if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
  } else if (kind === "sunburst") {
    const rays = Math.round(value(liv, "patternRepeat")) * 2;
    for (let i = 0; i < rays; i++) {
      const a = i * Math.PI * 2 / rays, b = (i + 1) * Math.PI * 2 / rays;
      ctx.fillStyle = i % 2 ? primary : secondary;
      ctx.beginPath(); ctx.moveTo(offset, 1.25);
      ctx.lineTo(offset + Math.cos(a) * 4, 1.25 + Math.sin(a) * 4);
      ctx.lineTo(offset + Math.cos(b) * 4, 1.25 + Math.sin(b) * 4); ctx.closePath(); ctx.fill();
    }
  } else if (kind === "scallops") {
    for (let row = -6; row <= 18; row++) for (let col = -10; col <= 10; col++) {
      const x = offset + (col + (Math.abs(row) % 2) / 2) * step, z = 0.5 + row * step * 0.8;
      ctx.fillStyle = row % 2 ? primary : secondary;
      ctx.beginPath(); ctx.moveTo(x - step * 0.5, z);
      for (let i = 0; i <= 5; i++) {
        const a = Math.PI - i * Math.PI / 5;
        ctx.lineTo(x + Math.cos(a) * step * 0.5, z + Math.sin(a) * step * 0.8);
      }
      ctx.closePath(); ctx.fill();
    }
  } else if (kind === "herringbone" || kind === "circuit") {
    for (let row = -6; row <= 18; row++) for (let col = -12; col <= 12; col++) {
      const x = offset + col * step, z = 0.5 + row * step;
      ctx.strokeStyle = (col + row) % 2 ? primary : secondary;
      ctx.beginPath(); ctx.moveTo(x, z);
      if (kind === "herringbone") {
        ctx.lineTo(x + step * 0.5, z + step * 0.45); ctx.lineTo(x + step, z);
      } else {
        ctx.lineTo(x + step * 0.65, z); ctx.lineTo(x + step * 0.65, z + step * 0.6);
        ctx.lineTo(x + step * 0.9, z + step * 0.6);
      }
      ctx.stroke();
      if (kind === "circuit") { ctx.fillStyle = ctx.strokeStyle; ctx.fillRect(x - 0.018 * weight, z - 0.018 * weight, 0.036 * weight, 0.036 * weight); }
    }
  } else if (kind === "shards" || kind === "pixelFade") {
    for (let row = -6; row <= 18; row++) for (let col = -12; col <= 12; col++) {
      const x = offset + col * step, z = 0.5 + row * step;
      // Integer hash, no random seed or time dependence: saved paint reproduces exactly.
      const hash = ((Math.imul(col + 29, 73856093) ^ Math.imul(row + 17, 19349663)) >>> 0) / 4294967296;
      ctx.fillStyle = hash < 0.5 ? primary : secondary;
      if (kind === "pixelFade") {
        if (hash > Math.max(0.08, Math.min(1, (2.15 - z) / 1.65))) continue;
        ctx.fillRect(x, z, step * 0.85, step * 0.85);
      } else {
        ctx.beginPath(); ctx.moveTo(x, z); ctx.lineTo(x + step, z + step * hash);
        ctx.lineTo(x + step * 0.25, z + step); ctx.closePath(); ctx.fill();
      }
    }
  } else if (kind === "honeycomb") {
    const radius = step * 0.44, dz = Math.sqrt(3) * radius;
    for (let col = -12; col <= 12; col++) for (let row = -1; row < 18; row++) {
      const x = offset + col * radius * 1.5, z = 0.5 + (row + (Math.abs(col) % 2) / 2) * dz;
      if (x < -1.2 || x > 1.2 || z > 2.2) continue;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = i * Math.PI / 3, xx = x + Math.cos(angle) * radius, yy = z + Math.sin(angle) * radius;
        if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy);
      }
      ctx.closePath(); ctx.stroke();
    }
  }
  ctx.restore();
}
export function drawAtlas(ctx: LiveryCtx2D, liv: DesignLivery | null | undefined, regions: DesignRegions, flank: DesignFlank,
  eachFlank: (fn: (f: DesignFlankFrame) => void) => void): boolean {
  if (!liv || !PATTERNS.includes(liv.spineLogo as string)) return false;
  const region = (r: LiveryRect | undefined, transform: readonly [number, number, number, number, number, number]) => {
    if (!r) return;
    ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.transform(...transform); paint(ctx, liv); ctx.restore();
  };
  const c = regions.crest, t = regions.tail;
  if (c) region(c, [c.w / (2 * flank.sTop), 0, 0, -c.h / 0.66, c.x + c.w / 2, c.y + c.h * 1.28 / 0.66]);
  if (t && liv.finHandoff !== "hardCut") region(t, [t.w / (2 * flank.sTop), 0, 0, -t.h / 0.64, t.x + t.w / 2, t.y + t.h * 1.92 / 0.64]);
  if (liv.patternPlacement === "wrap") eachFlank((f) => {
    const left = f.R === regions.spineSideL;
    if (liv.patternSide === "left" && !left || liv.patternSide === "right" && left) return;
    const sign = left ? -1 : 1, dx = (f.fx(1) - f.fx(0)) / flank.zLen;
    region(f.R, [0, sign * f.R.h / flank.sLen, dx, 0, f.fx(0) + flank.zF * dx, f.R.y - flank.sTop * f.R.h / flank.sLen]);
  });
  return true;
}
export function history<T>(initial: T, limit = 50) {
  const clone = (d: T): T => JSON.parse(JSON.stringify(d)) as T;
  const original = clone(initial), entries = [clone(initial)]; let at = 0, dragging = false;
  return {
    record(d: T, drag = false) {
      if (JSON.stringify(entries[at]) === JSON.stringify(d)) { if (!drag) dragging = false; return; }
      entries.splice(at + 1);
      if (dragging) entries[at] = clone(d); else { entries.push(clone(d)); at++; }
      if (entries.length > limit + 1) { entries.shift(); at--; }
      dragging = drag;
    },
    undo() { dragging = false; return at > 0 ? clone(entries[--at]!) : null; },
    redo() { dragging = false; return at < entries.length - 1 ? clone(entries[++at]!) : null; },
    canUndo: () => at > 0, canRedo: () => at < entries.length - 1,
    original: () => clone(original),
  };
}
/** f1-game's frozen `LiveryDesign` global (livery-design.js:221). */
export const LiveryDesign = Object.freeze({ PATTERNS, SECOND_COLOR, LINE_PATTERNS, RANGES, PALETTES, value, drawAtlas, history });
