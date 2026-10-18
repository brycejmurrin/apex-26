/**
 * RaceEntryProfile: the race-entry stopwatch OUTSIDE the track build. Ported
 * verbatim from f1-game js/perf/race-entry-profile.js:1-415; the IIFE became
 * `createRaceEntryProfile(deps)` and `raceEntryProfile` is the shared one.
 *
 * PERF-OPTIONS-2026-09-16.md measured ~2193 ms contiguous / ~4856 ms total
 * main-thread block at race entry, of which the track build is only ~23 %.
 * This keeps startRace's sequential legs AND adds:
 *   - named marks around handoff / warm / first present / car assets / debris
 *   - an optional PerformanceObserver longtask ring for the same window
 * so a real-device probe can attribute the other three quarters instead of
 * guessing. Soft-blit CI numbers are not this freeze — label them separately.
 *
 * WHAT THE SHELL CALLS: `beginUi()` on the Start Race tap, `runSession(...)`
 * (or `begin()`) from startRace, `lap(name)` between legs, `span()/spanAsync()`
 * around stages, `requestWarm()`, `raiseHandoff()`, then `afterPresent()` once
 * per rendered frame. The debug API reads `snapshot()` / `stageTable()`.
 */
import { nowMs } from "./env";

const MAX_TASKS = 64;
const MAX_MARKS = 128;
const INTRO_BUDGET_SOFT_MS = 45000;
const INTRO_BUDGET_HW_MS = 120000;
export const STAGE_LABELS: Readonly<Record<string, string>> = {
  awaitIntroWarm: "Shaders",
  ensureScenery: "Scenery",
  loadTrackStepped: "Track",
  prepareMenuCarAssets: "Cars",
  introPlan: "Flyby plan",
  introWarmPrograms: "Programs",
  lampBake: "Lighting",
  introPrepare: "Prepare",
  introBuild: "Build",
  introWarm: "Warm intro",
  introGarage: "Garage intro",
  flyby: "Flyby",
  studioDone: "Garage",
  studioOpen: "Garage open",
  warmCarAssets: "Car warm",
  debrisPrime: "Debris",
  mirrorPrepare: "Mirror",
  gridCountdown: "Grid",
};

export interface Leg { n: string; ms: number }
export interface Mark { n: string; t: number }
export interface LongTask { start: number; ms: number; name: string }
export interface StageRow { n: string; ms: number | null; kind: "leg" | "span"; open?: boolean }

export interface EntrySnapshot {
  entry: string;
  winT0: number;
  legs: Leg[];
  marks: Mark[];
  longTasks: LongTask[];
  blockMs: number;
  maxBlockMs: number;
  supported: boolean;
  armed: boolean;
  windowMs: number;
  budgetMs: number;
  budgetLeftMs: number | null;
}

/** The loading/handoff screen (f1-game js/ui/loading-screen.js). TODO(lane-shell). */
export interface HandoffScreen {
  phase(): string;
  handoff(): void;
  stop(): void;
}

/** The renderer slice afterPresent / requestWarm read. TODO(lane-render). */
export interface EntryGfx {
  warm?(): void;
  warming?(): boolean;
  backendState?(): { ctxLost?: boolean } | null;
}

/** f1-game js/core/session-entry.js begin() result. TODO(lane-shell). */
export interface SessionRequest<R> {
  outcome: Promise<R>;
}
export interface SessionEntry<R extends { kind: string }> {
  begin(kind: string, key: unknown, prepare: () => Promise<unknown>, body: unknown, stillWanted: unknown, onFail: (e: unknown) => void): SessionRequest<R>;
  owns(result: R): boolean;
}

export interface RaceEntryProfileDeps {
  now?: () => number;
  /** PerfGov.softwareRaster: the soft budget for SwiftShader / llvmpipe. */
  softwareRaster?: () => boolean;
}

export type RaceEntryProfile = ReturnType<typeof createRaceEntryProfile>;

export function createRaceEntryProfile(deps: RaceEntryProfileDeps = {}) {
  const clock = deps.now ?? nowMs;
  let legs: Leg[] = [];
  let marks: Mark[] = [];
  let longTasks: LongTask[] = [];
  let lapT0 = 0;
  let winT0 = 0, winT1 = 0;
  let observer: PerformanceObserver | null = null;
  let supported = false;
  let armed = false;
  let sawWarming = false;
  let sawReady = false;
  let endAfterReady = 0;
  let generation = 0, presentationEnabled = true;
  // True after beginUi until continueWindow/begin consumes it — keeps cover marks
  // for one tap→startRace handoff without suppressing a superseding startRace begin().
  let uiPending = false;
  let entryKind = "";
  let introBudgetT0 = 0;
  let introBudgetMs = 0;
  let introBudgetArmed = false;
  let progressSink: ((label: string) => void) | null = null;
  /** True from beginUi until startRace commits — keeps the window armed through flyby/handoff. */
  let menuEntrySession = false;

  function now(): number {
    try { return clock(); } catch { return Date.now(); }
  }

  function pushMark(n: string): void {
    if (marks.length >= MAX_MARKS) return;
    marks.push({ n, t: +(now() - winT0).toFixed(2) });
  }

  function onLongTask(list: PerformanceObserverEntryList): void {
    if (!armed) return;
    for (const e of list.getEntries()) {
      if (longTasks.length >= MAX_TASKS) break;
      const start = +e.startTime;
      // Only tasks that overlap this window (observer may be buffered).
      if (start + e.duration < winT0) continue;
      longTasks.push({
        start: +start.toFixed(2),
        ms: +e.duration.toFixed(2),
        name: e.name || "unknown",
      });
    }
  }

  function armObserver(): void {
    supported = false;
    if (typeof PerformanceObserver !== "function") return;
    try {
      const types = PerformanceObserver.supportedEntryTypes;
      if (types && types.indexOf && types.indexOf("longtask") < 0) return;
      const mine = generation;
      observer = new PerformanceObserver((list) => { if (mine === generation) onLongTask(list); });
      observer.observe({ type: "longtask", buffered: true });
      supported = true;
    } catch {
      observer = null;
      supported = false;
    }
  }

  function disarmObserver(): void {
    if (!observer) return;
    try { observer.disconnect(); } catch { /* already gone */ }
    observer = null;
  }

  function softwareRaster(): boolean {
    try { return !!(deps.softwareRaster && deps.softwareRaster()); } catch { return false; }
  }

  function armIntroBudget(tag?: string): void {
    if (tag) entryKind = String(tag);
    introBudgetArmed = true;
    introBudgetT0 = now();
    introBudgetMs = softwareRaster() ? INTRO_BUDGET_SOFT_MS : INTRO_BUDGET_HW_MS;
  }

  function introBudgetLeft(): number {
    if (!introBudgetArmed) return INTRO_BUDGET_HW_MS;
    return Math.max(0, introBudgetMs - (now() - introBudgetT0));
  }

  function introBudgetExpired(): boolean {
    return introBudgetArmed && introBudgetLeft() <= 0;
  }

  function setProgressSink(fn: unknown): void {
    progressSink = typeof fn === "function" ? (fn as (label: string) => void) : null;
  }

  function stagesFromSnapshot(snap: { legs?: readonly Leg[]; marks?: readonly Mark[] }): StageRow[] {
    const rows: StageRow[] = [];
    for (const leg of snap.legs || []) {
      if (!leg || !(leg.ms >= 0)) continue;
      rows.push({ n: leg.n, ms: +leg.ms, kind: "leg" });
    }
    const ms = snap.marks || [];
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!m || !/:start$/.test(m.n)) continue;
      const base = m.n.slice(0, -6);
      const e = ms.slice(i + 1).find((x) => x && x.n === base + ":end");
      rows.push({
        n: base,
        ms: e ? +((e.t - m.t)).toFixed(2) : null,
        kind: "span",
        open: !e,
      });
    }
    return rows;
  }

  function stageTable(snap?: EntrySnapshot) {
    const s = snap || snapshot();
    const stages = stagesFromSnapshot(s);
    const totalMs = s.windowMs || 0;
    return {
      entry: entryKind,
      software: softwareRaster(),
      budgetMs: introBudgetMs,
      budgetLeftMs: introBudgetT0 ? +introBudgetLeft().toFixed(2) : null,
      windowMs: totalMs,
      stages,
      blockMs: s.blockMs,
      maxBlockMs: s.maxBlockMs,
    };
  }

  function diffStages(raceSnap?: EntrySnapshot | null, practiceSnap?: { entry?: string; legs?: Leg[]; marks?: Mark[] } | null) {
    const a = stagesFromSnapshot(raceSnap || snapshot());
    const b = stagesFromSnapshot(practiceSnap || { legs: [], marks: [] });
    const names = new Set([...a.map((r) => r.n), ...b.map((r) => r.n)]);
    const rows: { n: string; raceMs: number | null; practiceMs: number | null; deltaMs: number | null }[] = [];
    for (const n of names) {
      const ra = a.find((r) => r.n === n);
      const pb = b.find((r) => r.n === n);
      const raceMs = ra && ra.ms != null ? ra.ms : null;
      const practiceMs = pb && pb.ms != null ? pb.ms : null;
      rows.push({
        n,
        raceMs,
        practiceMs,
        deltaMs: raceMs != null && practiceMs != null ? +(raceMs - practiceMs).toFixed(2) : null,
      });
    }
    rows.sort((x, y) => Math.abs(y.deltaMs || 0) - Math.abs(x.deltaMs || 0));
    return { entryRace: raceSnap && raceSnap.entry, entryPractice: practiceSnap && practiceSnap.entry, rows };
  }

  function begin(tag?: string): void {
    disarmObserver();
    generation++; presentationEnabled = true;
    uiPending = false;
    legs = [];
    marks = [];
    longTasks = [];
    sawWarming = false;
    sawReady = false;
    endAfterReady = 0;
    winT0 = now(); winT1 = winT0;
    lapT0 = winT0;
    armed = true;
    armIntroBudget(tag);
    armObserver();
    if (tag) pushMark("begin:" + tag);
  }

  /** Arm on the UI Start Race tap so cover→paint marks survive until startRace.
   *  startRace's runSession uses continueWindow once; a later startRace still
   *  calls begin() so generation bumps and old observers are dropped. */
  function beginUi(tag?: string): void {
    if (armed) { mark("ui:tap"); return; }
    menuEntrySession = true;
    begin(tag || "uiStart");
    uiPending = true;
    mark("entry:" + (entryKind || tag || "ui"));
  }

  function continueWindow(tag?: string): void {
    const resumeMenu = marks.some((m) => /^entry:/.test(m.n));
    if ((armed && uiPending) || resumeMenu) {
      if (!armed) {
        armed = true;
        disarmObserver();
        generation++;
        armObserver();
      }
      uiPending = false;
      if (tag) pushMark("begin:" + tag);
      presentationEnabled = false;
      return;
    }
    begin(tag);
  }

  function clearMenuEntrySession(): void {
    menuEntrySession = false;
  }

  /** Yield so the loading cover can paint before ensure* / intro sync work.
   *  https://developer.chrome.com/blog/use-scheduler-yield — Safari: rAF+timeout. */
  function afterPaint(): Promise<void> {
    mark("ui:cover");
    const done = (): void => { mark("ui:painted"); };
    const sched = (globalThis as { scheduler?: { yield?: () => Promise<unknown> } }).scheduler;
    if (sched && sched.yield) {
      return sched.yield().then(done, done);
    }
    if (typeof requestAnimationFrame === "function") {
      return new Promise<void>((r) => {
        requestAnimationFrame(() => { setTimeout(r, 0); });
      }).then(done, done);
    }
    return Promise.resolve().then(done);
  }

  function end(): void {
    if (!armed) return;
    winT1 = now();
    pushMark("end");
    armed = false;
    disarmObserver();
  }

  function lap(n: string): void {
    const t = now();
    legs.push({ n, ms: +(t - lapT0).toFixed(2) });
    lapT0 = t;
  }

  function mark(n: string): void {
    if (!armed) return;
    pushMark(n);
    if (progressSink && /:end$/.test(n)) {
      const base = n.slice(0, -4);
      try { progressSink(STAGE_LABELS[base] || base); } catch { /* UI only */ }
    }
  }

  /** First warming present and first ready present only — not every frame. */
  function notePresent(warming: boolean): void {
    if (!armed) return;
    if (warming) {
      if (!sawWarming) { sawWarming = true; pushMark("present:warming"); }
      return;
    }
    if (!sawReady) {
      sawReady = true;
      pushMark("present:ready");
      endAfterReady = 2;   // keep the observer for a couple of frames past ready
    }
  }

  /** Call once per rendered frame while a race-entry window is armed. */
  function tickFrame(): void {
    if (menuEntrySession || !armed || !sawReady) return;
    if (endAfterReady > 0 && --endAfterReady === 0) end();
  }

  /** Renderer warm request (or skipped/noop) — one call site in startRace. */
  function requestWarm(gfx: EntryGfx | null | undefined, alreadyWarmed?: boolean): void {
    if (gfx && gfx.warm && !alreadyWarmed) { mark("warm:request"); gfx.warm(); }
    else mark(alreadyWarmed ? "warm:skipped-menu" : "warm:noop");
  }

  function raiseHandoff(screen: HandoffScreen): void {
    presentationEnabled = true;
    mark("handoff:raise");
    screen.handoff();
  }

  function span<T>(name: string, fn: () => T): T {
    mark(name + ":start");
    try { return fn(); }
    finally { mark(name + ":end"); }
  }

  async function spanAsync<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const mine = generation;
    mark(name + ":start");
    try { return await fn(); }
    finally { if (mine === generation) mark(name + ":end"); }
  }

  /** Lower the handoff card on the first painted present; tick the window.
   *  Context-loss fail-fast: a lost device never presents, so treat ctxLost as
   *  !warming and drop the handoff — otherwise HUD surveys wait forever. */
  function afterPresent(screen: HandoffScreen, gfx: EntryGfx | null | undefined, preparing = false): void {
    const handoff = screen.phase() === "handoff", watching = armed && presentationEnabled;
    if (handoff || watching) {
      let lost = false;
      try { const s = gfx && gfx.backendState && gfx.backendState(); lost = !!(s && s.ctxLost); } catch { lost = false; }
      const warming = !lost && (preparing || !!(gfx && gfx.warming && gfx.warming()));
      if (watching) notePresent(warming);
      if (handoff && !warming) { mark(lost ? "handoff:lower-lost" : "handoff:lower"); screen.stop(); }
    }
    tickFrame();
  }

  /** Latch identity and profiler ownership survive duplicate/superseded starts. */
  function runSession<R extends { kind: string }>(sessionEntry: SessionEntry<R>, key: unknown, scenery: () => Promise<unknown>,
    body: unknown, stillWanted: unknown, onFail: (e: unknown) => void): SessionRequest<R> {
    let owner = 0;
    const owns = (): boolean => owner !== 0 && owner === generation;
    const request = sessionEntry.begin("race", key, async () => {
      // Keep ui:cover / ui:painted from the Start Race tap when present.
      continueWindow("startRace"); owner = generation; presentationEnabled = false;
      mark("ensureScenery:start");
      try { return await scenery(); }
      finally { if (owns()) mark("ensureScenery:end"); }
    }, body, stillWanted, (e) => {
      if (owns()) end();
      onFail(e);
    });
    request.outcome.then((result) => {
      if (!owns()) return;
      if (result.kind !== "committed" || !sessionEntry.owns(result)) { clearMenuEntrySession(); end(); }
      else { mark("session:committed"); clearMenuEntrySession(); presentationEnabled = true; }
    }, () => { if (owns()) { clearMenuEntrySession(); end(); } });
    return request;
  }

  function blockMs(): number {
    let s = 0;
    for (const t of longTasks) s += t.ms;
    return +s.toFixed(2);
  }

  function maxBlockMs(): number {
    let m = 0;
    for (const t of longTasks) if (t.ms > m) m = t.ms;
    return +m.toFixed(2);
  }

  function snapshot(): EntrySnapshot {
    return {
      entry: entryKind,
      winT0,
      legs: legs.slice(),
      marks: marks.slice(),
      longTasks: longTasks.slice(),
      blockMs: blockMs(),
      maxBlockMs: maxBlockMs(),
      supported,
      armed,
      windowMs: armed || marks.length ? +((armed ? now() : winT1) - winT0).toFixed(2) : 0,
      budgetMs: introBudgetMs,
      budgetLeftMs: introBudgetT0 ? +introBudgetLeft().toFixed(2) : null,
    };
  }

  return {
    begin, beginUi, continueWindow, afterPaint, end, lap, mark, notePresent, tickFrame,
    requestWarm, raiseHandoff, span, spanAsync, afterPresent, runSession, clearMenuEntrySession,
    snapshot, stageTable, diffStages, stagesFromSnapshot,
    introBudgetLeft, introBudgetExpired, setProgressSink, softwareRaster,
    legs: () => legs.slice(),
    armed: () => armed,
    supported: () => supported,
    // Test / probe seam: inject synthetic longtasks without a real observer.
    _injectTask(ms: number, start?: number | null, name?: string): void {
      if (longTasks.length >= MAX_TASKS) return;
      longTasks.push({
        start: +(start != null ? start : now()).toFixed(2),
        ms: +(+ms).toFixed(2),
        name: name || "synthetic",
      });
    },
  };
}
