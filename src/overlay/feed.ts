/**
 * The stream / broadcast overlay frame schema: a pure, read-only mapping from
 * the ranked field to a versioned frame, plus a differ that sends a full frame
 * every FULL_MS and only changed keys between.
 * Port of f1-game js/overlay/feed.js:1-137 (OverlayFeed). `battles` is ported
 * from js/race/broadcast.js:194-210 (Broadcast.battles), which feed.js called
 * when loaded; TODO(lane-race): import it from src/race once ported there.
 */

export const VERSION = 1;
export const FULL_MS = 2000;
/** Two cars this close (seconds) are a battle (broadcast.js:10). */
const BATTLE_S = 1.0;

export type Tone = "purple" | "green" | "yellow" | "";

export interface SectorCell {
  readonly value: number | null;
  readonly tone: Tone;
  readonly glyph: "★" | "▼" | "▲" | "";
}

export interface SectorFrame {
  readonly idx: number;
  readonly last: readonly SectorCell[];
}

export interface OverlayRow {
  readonly pos: number;
  readonly code: string;
  readonly team: string;
  readonly interval: number | null;
  readonly gap: number | null;
  readonly tyre: string | null;
  readonly pit: boolean;
  readonly you: boolean;
}

export interface OverlayBattle {
  readonly ahead: string;
  readonly behind: string;
  readonly gapS: number;
}

export interface OverlayCaption {
  readonly n: string | null;
  readonly who: string;
  readonly text: string;
  readonly kind: string;
  readonly id: string;
}

export interface OverlayFrame {
  readonly v: typeof VERSION;
  readonly seq: number;
  readonly t: number;
  readonly state: string;
  readonly track: string | null;
  readonly lap: number;
  readonly laps: number;
  readonly flag: string;
  readonly rows: readonly OverlayRow[];
  readonly battle: OverlayBattle | null;
  readonly sectors: SectorFrame;
  readonly caption: OverlayCaption | null;
}

/** A diffed frame: every key but v/seq/t is optional; `full` marks a keyframe. */
export type OverlayPatch = Pick<OverlayFrame, "v" | "seq" | "t"> & Partial<Omit<OverlayFrame, "v" | "seq" | "t">> & { full?: true };

/** A car as the feed reads it. Every field is optional: the feed never writes. */
export interface FeedCar {
  readonly code?: string;
  readonly id?: string | number;
  readonly num?: string | number;
  readonly team?: string | { readonly color?: string; readonly colour?: string } | null;
  readonly colour?: string;
  readonly color?: string;
  readonly tyre?: { readonly code?: string; readonly c?: string; readonly compound?: string } | null;
  readonly pos?: number;
  readonly prog?: number;
  readonly speed?: number;
  readonly intervalS?: number;
  readonly gapToLeaderS?: number;
  readonly pit?: boolean;
  readonly inPit?: boolean;
  readonly you?: boolean;
  readonly isPlayer?: boolean;
}

export interface FeedInput {
  readonly seq?: number;
  readonly t?: number;
  readonly state?: string;
  readonly track?: string | null;
  readonly lap?: number;
  readonly laps?: number;
  readonly flag?: string;
  readonly ranked?: readonly FeedCar[];
  readonly vScale?: number;
  readonly sectorLast?: ReadonlyArray<number | null | undefined>;
  readonly sectorBests?: ReadonlyArray<number | null | undefined>;
  readonly fieldSectorBests?: ReadonlyArray<number | null | undefined>;
  readonly caption?: { readonly id?: unknown; readonly n?: unknown; readonly who?: unknown; readonly text?: unknown; readonly kind?: unknown } | null;
}

const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const codeOf = (c: FeedCar | null | undefined): string => String((c && (c.code || c.id || c.num)) || "—");

function teamOf(c: FeedCar | null | undefined): string {
  if (!c) return "";
  if (typeof c.team === "string") return c.team;
  return (c.team && (c.team.color || c.team.colour)) || c.colour || c.color || "";
}

function tyreOf(c: FeedCar | null | undefined): string | null {
  const t = c && c.tyre;
  return t && (t.code || t.c || t.compound) ? String(t.code || t.c || t.compound).charAt(0).toUpperCase() : null;
}

/** HUD parity: pb = t <= personal best; session best = pb && t <= field best (feed.js:21-28). */
export function sector(value: unknown, personalBest: unknown, fieldBest: unknown): SectorCell {
  const t = number(value);
  if (t == null) return { value: null, tone: "", glyph: "" };
  const pb = typeof personalBest === "number" && Number.isFinite(personalBest) && t <= personalBest;
  const sb = pb && typeof fieldBest === "number" && Number.isFinite(fieldBest) && t <= fieldBest;
  return { value: t, tone: sb ? "purple" : pb ? "green" : "yellow", glyph: sb ? "★" : pb ? "▼" : "▲" };
}

type Seq = ReadonlyArray<number | null | undefined> | null | undefined;

export function sectorFrame(last: Seq, best: Seq, fieldBest: Seq): SectorFrame {
  const out: SectorCell[] = [];
  for (let i = 0; i < 3; i++) out.push(sector(last && last[i], best && best[i], fieldBest && fieldBest[i]));
  return { idx: out.findLastIndex((s) => s.value != null), last: out };
}

interface Fight<K> {
  key: K;
  ahead: K;
  gapS: number;
  score: number;
}

/**
 * Close pairs, best first: the gap behind the car ahead under BATTLE_S, scored
 * gap + position * 0.08 so a fight near the front ranks above an equal one at
 * the back (broadcast.js:194-210).
 */
export function battles<K>(cars: ReadonlyArray<{ key: K; prog: number; speed: number }>, vScale?: number): Array<Fight<K>> {
  const out: Array<Fight<K>> = [];
  const floor = 20 * (vScale != null && vScale > 0 ? vScale : 1);
  for (let i = 1; i < cars.length; i++) {
    const a = cars[i - 1] as { key: K; prog: number; speed: number };
    const b = cars[i] as { key: K; prog: number; speed: number };
    const v = Math.max(b.speed || 0, floor);
    const g = (a.prog - b.prog) / v;
    if (g < 0 || g >= BATTLE_S) continue;
    out.push({ key: b.key, ahead: a.key, gapS: g, score: g + i * 0.08 });
  }
  out.sort((x, y) => x.score - y.score);
  return out;
}

export function battle(ranked: readonly FeedCar[] | null | undefined, vScale?: number): OverlayBattle | null {
  if (!ranked || ranked.length < 2) return null;
  const input = ranked
    .map((c) => ({
      key: c,
      prog: Number.isFinite(c.prog) ? (c.prog as number) : 0,
      speed: Number.isFinite(c.speed) ? (c.speed as number) : 0,
    }))
    .sort((a, b) => b.prog - a.prog);
  const fight = battles(input, vScale)[0] || null;
  return fight ? { ahead: codeOf(fight.ahead), behind: codeOf(fight.key), gapS: +fight.gapS.toFixed(3) } : null;
}

export function rowsFrom(ranked: readonly FeedCar[] | null | undefined): OverlayRow[] {
  const rows: OverlayRow[] = [];
  const lead = ranked && ranked[0];
  for (let i = 0; ranked && i < ranked.length; i++) {
    const c = ranked[i] as FeedCar;
    const ahead = ranked[i - 1];
    const speed = Math.max(c.speed || 0, 20);
    rows.push({
      pos: typeof c.pos === "number" && Number.isFinite(c.pos) ? c.pos : i + 1,
      code: codeOf(c),
      team: teamOf(c),
      interval: i ? (number(c.intervalS) ?? +(((ahead?.prog || 0) - (c.prog || 0)) / speed).toFixed(3)) : null,
      gap: i ? (number(c.gapToLeaderS) ?? +(((lead?.prog || 0) - (c.prog || 0)) / speed).toFixed(3)) : null,
      tyre: tyreOf(c),
      pit: !!(c.pit || c.inPit),
      you: !!(c.you || c.isPlayer),
    });
  }
  return rows;
}

export function frame(input: FeedInput | null | undefined): OverlayFrame {
  const i = input || {};
  const ranked = Array.isArray(i.ranked) ? i.ranked : [];
  const cap = i.caption;
  return {
    v: VERSION,
    seq: (i.seq ?? 0) | 0,
    t: number(i.t) || 0,
    state: String(i.state || "idle"),
    track: i.track == null ? null : String(i.track),
    lap: (i.lap ?? 0) | 0,
    laps: (i.laps ?? 0) | 0,
    flag: String(i.flag || ""),
    rows: rowsFrom(ranked),
    battle: battle(ranked, i.vScale),
    sectors: sectorFrame(i.sectorLast, i.sectorBests, i.fieldSectorBests),
    caption:
      cap && cap.id != null
        ? {
            n: cap.n == null ? null : String(cap.n),
            who: cap.who == null ? "" : String(cap.who),
            text: cap.text == null ? "" : String(cap.text),
            kind: cap.kind == null ? "" : String(cap.kind),
            id: String(cap.id),
          }
        : null,
  };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Only a v1 frame with a finite seq is a frame (feed.js:130-132). */
export function accept(value: unknown): OverlayFrame | null {
  return typeof value === "object" && value !== null && (value as { v?: unknown }).v === VERSION && Number.isFinite((value as { seq?: unknown }).seq)
    ? (value as OverlayFrame)
    : null;
}

const DIFF_KEYS = ["state", "track", "lap", "laps", "flag", "rows", "battle", "sectors"] as const;

export interface Differ {
  next(nextFrame: unknown, now?: number): OverlayPatch | null;
  reset(): void;
}

export function createDiffer(fullEveryMs?: number): Differ {
  const every = fullEveryMs != null && Number.isFinite(fullEveryMs) ? Math.max(250, fullEveryMs) : FULL_MS;
  let previous: OverlayFrame | null = null;
  let lastFull = -Infinity;
  let captionId: string | null = null;
  return {
    next(nextFrame, now) {
      const f = accept(nextFrame);
      if (!f) return null;
      const at = now != null && Number.isFinite(now) ? now : f.t * 1000;
      const full = !previous || at - lastFull >= every;
      const out: Record<string, unknown> = full ? { ...f, full: true } : { v: VERSION, seq: f.seq, t: f.t };
      if (!full && previous) {
        for (const key of DIFF_KEYS) {
          if (!same(f[key], previous[key])) out[key] = f[key];
        }
        if (f.caption && f.caption.id !== captionId) out["caption"] = f.caption;
        else if (!f.caption && previous.caption) out["caption"] = null;
      }
      if (full) lastFull = at;
      if (f.caption) captionId = f.caption.id;
      previous = f;
      return out as OverlayPatch;
    },
    reset() {
      previous = null;
      lastFull = -Infinity;
      captionId = null;
    },
  };
}
