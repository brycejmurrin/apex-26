/**
 * PerfSpans: the per-subsystem frame budget. Ported verbatim from f1-game
 * js/perf/spans.js:1-109; the IIFE's default instance is `perfSpans` and
 * `createPerfSpans(clock)` makes more (f1-game's `PerfSpans.create`).
 *
 * begin(name)/end(name) bracket a phase of the frame loop (f1-game game.js
 * tickBody: frame, input, physics, ai, collide, debris, render, hud); the debug
 * API reads p50/p95/p99/max per span as JSON, plus the Long Animation Frames
 * ring.
 *
 * OFF by default and then costs one boolean test per call. ON, a span writes one
 * Float64 into a fixed ring: no per-frame allocation (the first sight of a name
 * allocates its ring, once). Spans may nest (physics contains ai); each name
 * keeps ONE open start, so recursion of the same name is not supported.
 *
 * measure(true) additionally emits performance.measure() per span so the phases
 * show as User Timing tracks in a Chrome / Perfetto trace; that path allocates,
 * so it is a separate opt-in.
 *
 * LoAF: PerformanceObserver "long-animation-frame" (Chrome 123+), feature-
 * detected, the last LOAF_CAP entries with their top scripts. Software-GL
 * (SwiftShader) timings make CPU JS cost meaningful and GPU/fill numbers not.
 */

const RING = 512;       // samples kept per span (~8.5 s at 60 fps)
const LOAF_CAP = 32;    // long-animation-frame entries kept
const LOAF_SCRIPTS = 4; // scripts kept per entry (the longest)

export interface SpanStats {
  n: number;
  window: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface LoafScript { sourceURL: string; sourceFunctionName: string; duration: number }
export interface LoafEntry { start: number; duration: number; blockingDuration: number; scripts: LoafScript[] }
export interface LoafReport { supported: boolean | null; entries: LoafEntry[] }

export interface SpansReport {
  on: boolean;
  measure: boolean;
  unit: "ms";
  ring: number;
  spans: Record<string, SpanStats>;
  loaf: LoafReport;
}

export interface PerfSpans {
  create(clock?: () => number): PerfSpans;
  begin(name: string): void;
  end(name: string): void;
  reset(): void;
  stats(): Record<string, SpanStats>;
  isOn(): boolean;
  on(v: boolean): boolean;
  measure(v?: boolean): boolean;
  loaf(): LoafReport;
  report(): SpansReport;
}

interface Slot { buf: Float64Array; n: number; head: number; max: number; sum: number; count: number; t0: number }

/** The LoAF entry fields read here (not yet in lib.dom). */
interface LoafPerfEntry extends PerformanceEntry {
  blockingDuration?: number;
  scripts?: ReadonlyArray<{ sourceURL?: string; sourceFunctionName?: string; duration: number }>;
}

export function createPerfSpans(clock?: () => number): PerfSpans {
  const now = clock || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const spans: Record<string, Slot> = Object.create(null) as Record<string, Slot>;
  let on = false, measure = false;
  let loafObs: PerformanceObserver | null = null, loafSupported: boolean | null = null, loaf: LoafEntry[] = [];

  function slot(name: string): Slot {
    return spans[name] || (spans[name] = { buf: new Float64Array(RING), n: 0, head: 0, max: 0, sum: 0, count: 0, t0: -1 });
  }
  function begin(name: string): void {
    if (!on) return;
    slot(name).t0 = now();
  }
  function end(name: string): void {
    if (!on) return;
    const s = spans[name];
    if (!s || s.t0 < 0) return;
    const t1 = now(), d = t1 - s.t0;
    if (measure && typeof performance !== "undefined" && typeof performance.measure === "function") {
      try { performance.measure("apex:" + name, { start: s.t0, end: t1 }); } catch { /* a stub clock is not a timeline */ }
    }
    s.t0 = -1;
    s.buf[s.head] = d; s.head = (s.head + 1) % RING;
    if (s.n < RING) s.n++;
    if (d > s.max) s.max = d;
    s.sum += d; s.count++;
  }

  function observeLoaf(): void {
    if (loafObs || loafSupported === false) return;
    try {
      const types = (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes) || [];
      loafSupported = types.indexOf("long-animation-frame") >= 0;
      if (!loafSupported) return;
      loafObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as LoafPerfEntry[]) {
          const scripts = (e.scripts || []).map((x) => ({
            sourceURL: x.sourceURL || "", sourceFunctionName: x.sourceFunctionName || "", duration: Math.round(x.duration * 10) / 10,
          })).sort((a, b) => b.duration - a.duration).slice(0, LOAF_SCRIPTS);
          loaf.push({ start: Math.round(e.startTime), duration: Math.round(e.duration * 10) / 10, blockingDuration: Math.round((e.blockingDuration || 0) * 10) / 10, scripts });
          if (loaf.length > LOAF_CAP) loaf.shift();
        }
      });
      loafObs.observe({ type: "long-animation-frame", buffered: false });
    } catch { loafSupported = false; loafObs = null; }
  }

  function pct(sorted: number[], q: number): number {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[i] as number;
  }
  const r3 = (x: number): number => Math.round(x * 1000) / 1000;

  function stats(): Record<string, SpanStats> {
    const out: Record<string, SpanStats> = {};
    for (const name of Object.keys(spans)) {
      const s = spans[name] as Slot;
      const a = Array.from(s.n < RING ? s.buf.subarray(0, s.n) : s.buf).sort((x, y) => x - y);
      out[name] = { n: s.count, window: s.n, p50: r3(pct(a, 0.5)), p95: r3(pct(a, 0.95)), p99: r3(pct(a, 0.99)), max: r3(s.max), mean: r3(s.count ? s.sum / s.count : 0) };
    }
    return out;
  }
  function reset(): void {
    for (const name of Object.keys(spans)) delete spans[name];
    loaf = [];
  }
  function setOn(v: boolean): boolean {
    on = !!v;
    if (on) observeLoaf();
    else if (loafObs) { try { loafObs.disconnect(); } catch { /* gone */ } loafObs = null; }
    return on;
  }
  return {
    create: createPerfSpans,
    begin, end, reset, stats,
    isOn: () => on,
    on: setOn,
    measure: (v) => { if (v !== undefined) measure = !!v; return measure; },
    loaf: () => ({ supported: loafSupported, entries: loaf.slice() }),
    report: () => ({ on, measure, unit: "ms", ring: RING, spans: stats(), loaf: { supported: loafSupported, entries: loaf.slice() } }),
  };
}

/** The shared instance the frame loop brackets (f1-game's global `PerfSpans`). */
export const perfSpans: PerfSpans = createPerfSpans();
