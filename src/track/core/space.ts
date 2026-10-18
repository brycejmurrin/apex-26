/**
 * Explicit source-trace <-> racing-lap coordinate transforms.
 * Ported verbatim from f1-game js/track/core/space.js (TrackSpace, :1-164).
 */

/** The def fields these transforms read. */
export interface SpaceDef {
  startFrac?: number | null | undefined;
  reverse?: boolean | undefined;
  sceneryCoordinates?: string | undefined;
  sceneryLapMirror?: boolean | undefined;
  _sceneryShift?: number | undefined;
}

export interface FracRange {
  s0: number;
  s1: number;
}

/** space.js:5 */
export const wrap01 = (v: unknown): number => {
  const n = Number(v) || 0;
  return ((n % 1) + 1) % 1;
};

/** space.js:10 */
export function toRacingFrac(def: SpaceDef | null | undefined, sourceFrac: number): number {
  const phi = wrap01(def && def.startFrac);
  const source = wrap01(sourceFrac);
  return wrap01(def && def.reverse ? phi - source : source - phi);
}

/** space.js:16 */
export function toSourceFrac(def: SpaceDef | null | undefined, racingFrac: number): number {
  const phi = wrap01(def && def.startFrac);
  const racing = wrap01(racingFrac);
  return wrap01(def && def.reverse ? phi - racing : phi + racing);
}

/** space.js:22 */
export function sourceNodeToRacing(def: SpaceDef | null | undefined, node: number, count: number): number {
  const n = Math.max(1, Math.round(count) || 1);
  const source = Math.round(Number(node) || 0);
  const offset = Math.round(wrap01(def && def.startFrac) * n) % n;
  const racing = def && def.reverse ? offset - source : source - offset;
  return ((racing % n) + n) % n;
}

/** space.js:30 */
export function racingNodeToSource(def: SpaceDef | null | undefined, node: number, count: number): number {
  const n = Math.max(1, Math.round(count) || 1);
  const racing = Math.round(Number(node) || 0);
  const offset = Math.round(wrap01(def && def.startFrac) * n) % n;
  const source = def && def.reverse ? offset - racing : offset + racing;
  return ((source % n) + n) % n;
}

/** space.js:38 */
export function sampleSource<T>(def: SpaceDef | null | undefined, racingFrac: number, sampler: (f: number) => T): T {
  return sampler(toSourceFrac(def, racingFrac));
}

/** space.js:42 */
export function scenerySpace(def: SpaceDef | null | undefined): "racing" | "source" {
  const mode = def && def.sceneryCoordinates;
  if (mode === "racing" || mode === "source") return mode;
  return def && def.reverse ? "source" : "racing";
}

/** space.js:48 */
export function lapMirror(def: SpaceDef | null | undefined): boolean {
  return !!(def && def.reverse && def.sceneryLapMirror);
}

/**
 * Where the scenery's s=0 is when that is not the start line's: the ARC-length
 * fraction at which the old origin sits in the new lap (`_sceneryShift`,
 * computed by buildCenterline). space.js:92; see the long note there.
 */
export function sceneryOriginDelta(def: SpaceDef | null | undefined): number {
  return (def && def._sceneryShift) || 0;
}

/** space.js:96 */
export function sceneryFrac(def: SpaceDef | null | undefined, authoredFrac: number): number {
  const shift = sceneryOriginDelta(def);
  if (scenerySpace(def) !== "racing") return wrap01(toRacingFrac(def, authoredFrac) + shift);
  return wrap01((lapMirror(def) ? -authoredFrac : authoredFrac) + shift);
}

/** space.js:102 */
export function sceneryNode(def: SpaceDef | null | undefined, node: number, count: number): number {
  const n = Math.max(1, Math.round(count) || 1);
  const shift = Math.round(sceneryOriginDelta(def) * n);
  if (scenerySpace(def) !== "racing") return ((sourceNodeToRacing(def, node, n) + shift) % n + n) % n;
  const k = Math.round(node) * (lapMirror(def) ? -1 : 1) + shift;
  return ((k % n) + n) % n;
}

/** Inverse of sceneryNode for racing-space defs. space.js:113 */
export function sceneryNodeToAuthored(def: SpaceDef | null | undefined, engineNode: number, count: number): number {
  const n = Math.max(1, Math.round(count) || 1);
  const shift = Math.round(sceneryOriginDelta(def) * n);
  if (scenerySpace(def) !== "racing") {
    // eng = sourceNodeToRacing(authored) + shift  →  authored ≈ racingNodeToSource(eng - shift)
    const racing = ((Math.round(engineNode) - shift) % n + n) % n;
    return racingNodeToSource(def, racing, n);
  }
  let k = Math.round(engineNode) - shift;
  if (lapMirror(def)) k = -k;
  return ((k % n) + n) % n;
}

/**
 * The range twin of sceneryFrac. The whole lap short-circuits before range(),
 * whose endpoint wrap would collapse 0→1 to zero width. space.js:131
 */
export function sceneryRange(def: SpaceDef | null | undefined, s0: number, s1: number): FracRange {
  if (Math.abs(s1 - s0) >= 1 - 1e-9) return { s0: 0, s1: 1 };
  const r = range(def, s0, s1, scenerySpace(def));
  const shift = sceneryOriginDelta(def);
  if (!shift) return r;
  return { s0: wrap01(r.s0 + shift), s1: wrap01(r.s1 + shift) };
}

/** space.js:149 */
export function range(def: SpaceDef | null | undefined, s0: number, s1: number, coordinateSpace: string): FracRange {
  const racing = coordinateSpace === "racing";
  const mirror = racing && lapMirror(def);
  const map = racing
    ? (s: number) => wrap01(mirror ? -s : s)
    : (s: number) => toRacingFrac(def, s);
  const a = map(s0), b = map(s1);
  return (def && def.reverse && !racing) || mirror
    ? { s0: b, s1: a }
    : { s0: a, s1: b };
}
