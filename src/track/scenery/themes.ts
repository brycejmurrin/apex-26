/**
 * Deterministic scenery theme registry.
 *
 * Port of f1-game js/track/scenery/themes.js:1-89 (`SceneryThemes`), verbatim
 * apart from types. The `Log.info` trace at themes.js:66 is dropped: it has no
 * effect on the result.
 */
import type { RVec3, SceneryTheme } from "../../contracts/scenery";

type Plain = { [key: string]: unknown };

interface ThemeRow {
  readonly palette?: { readonly [key: string]: RVec3 };
  readonly spacing?: { readonly furniture?: number; readonly service?: number };
  readonly budgets?: { readonly hero?: number; readonly facility?: number; readonly repeated?: number };
}

const BASE = {
  name: "neutral",
  palette: {
    shell: [0.58, 0.60, 0.64],
    roof: [0.18, 0.20, 0.24],
    glass: [0.28, 0.42, 0.58],
    window: [0.92, 0.84, 0.62],
    accent: [0.82, 0.12, 0.16],
    service: [0.72, 0.74, 0.78],
  },
  spacing: { furniture: 80, service: 180 },
  budgets: { hero: 50000, facility: 25000, repeated: 10000 },
} satisfies SceneryTheme;

const THEMES: { readonly [name: string]: ThemeRow } = {
  permanent: {
    palette: { shell: [0.72, 0.73, 0.75], roof: [0.34, 0.36, 0.40],
               glass: [0.28, 0.38, 0.50], accent: [0.86, 0.30, 0.20] },
    spacing: { furniture: 150, service: 260 },
  },
  street: {
    palette: { shell: [0.45, 0.47, 0.52], glass: [0.20, 0.34, 0.52] },
  },
  desert: {
    palette: { shell: [0.68, 0.58, 0.44], accent: [0.96, 0.68, 0.16] },
    spacing: { furniture: 120, service: 220 },
  },
  park: {
    palette: { shell: [0.68, 0.68, 0.64], roof: [0.20, 0.28, 0.22] },
    spacing: { furniture: 140, service: 240 },
  },
  "night-event": {
    palette: { shell: [0.30, 0.32, 0.38], window: [0.70, 0.86, 1.00] },
  },
};

function isPlainObject(value: unknown): value is Plain {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (!isPlainObject(value)) return value;
  const out: Plain = {};
  for (const key of Object.keys(value)) out[key] = clone(value[key]);
  return out;
}

function merge(base: unknown, extra: unknown): Plain {
  const out = clone(base) as Plain;
  if (!isPlainObject(extra)) return out;
  for (const key of Object.keys(extra)) {
    const left = out[key];
    const right = extra[key];
    out[key] = isPlainObject(left) && isPlainObject(right) ? merge(left, right) : clone(right);
  }
  return out;
}

/** Resolved theme `name` (+ overrides). themes.js:65-74. */
export function resolve(name: string | undefined | null, overrides?: unknown, context?: { readonly night?: boolean } | null): SceneryTheme {
  const theme = (name != null ? THEMES[name] : undefined) || {};
  const result = merge(merge(BASE, theme), overrides || {});
  result["name"] = name != null && THEMES[name] ? name : "neutral";
  const palette = result["palette"];
  if (context && context.night && isPlainObject(palette) && Array.isArray(palette["window"])) {
    palette["window"] = (palette["window"] as number[]).map((v) => Math.min(2, v * 1.15));
  }
  return result as unknown as SceneryTheme;
}

/** Deterministic FNV-1a pick of one of `choices`. themes.js:76-85. */
export function variant<T>(trackId: string, modelId: string, index: unknown, choices: readonly T[] | null | undefined): T | null {
  if (!Array.isArray(choices) || !choices.length) return null;
  const text = `${trackId}|${modelId}|${Number(index) || 0}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return choices[(hash >>> 0) % choices.length] as T;
}
