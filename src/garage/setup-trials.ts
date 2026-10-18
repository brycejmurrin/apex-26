/**
 * Deliberate unscored launch comparisons. Receipts are session-only; no tuning
 * optimizer.
 *
 * Port of f1-game js/garage/setup-trials.js:1-145, verbatim: contextIssues
 * :13-22, create :23-30, owns/cancel :31-41, attempt :42-63, observe :64-69,
 * record :70-80, invalidate :81-84, summary :85-97, mountPause :98-123,
 * mount :124-143.
 *
 * f1-game keeps ONE comparison in the SetupTrials global; here that state (the
 * run, the sequence, the pause mounts and the listeners) lives in the instance
 * `createSetupTrials(tune)` returns, over an injected SetupTune. `SetupTrials`
 * is the page's instance.
 */
import { SetupTune, type SetupTuneApi, type Tune } from "./setup-tune";
import type { GarageStoreLike } from "./store";

export const REQUIRED = ["physics", "car", "parts", "track", "point", "weather", "tyres", "fuel", "energy", "assists"] as const;
export const STATIC = ["physics", "car", "parts", "track", "weather", "assists"] as const;

export type TrialArm = "baseline" | "control" | "candidate";
const ARMS: readonly TrialArm[] = ["baseline", "control", "candidate"];

/** A launch drill's starting conditions (js/race/setup-trial-session.js context()). */
export type TrialContext = Record<string, unknown>;

/** What the launch callback is handed (setup-trials.js:50). */
export interface TrialLaunchOptions {
  teamId: string;
  tune: Tune;
  mode: "launch";
  /** The revocable lease: false once this comparison is cancelled or no longer owns the sheet. */
  isCurrent: () => boolean;
}

export interface TrialLaunchResult {
  ok: boolean;
  reason?: string | null | undefined;
  context?: TrialContext | null | undefined;
}

export interface TrialOptions {
  teamId: string;
  store: GarageStoreLike;
  launch: (o: TrialLaunchOptions) => Promise<TrialLaunchResult | null | undefined> | TrialLaunchResult | null | undefined;
  refresh?: (() => void) | undefined;
  cancelRuntime?: (() => void) | undefined;
  baseline: Readonly<Tune>;
  candidate?: Readonly<Tune> | undefined;
  /** Read at BEGIN, in preference to `candidate`. */
  candidateNow?: (() => Readonly<Tune>) | undefined;
}

export interface TrialRecordResult {
  mode: string;
  clean: boolean;
  score: number | null;
  reason?: string | null | undefined;
}

export interface TrialReceipt {
  arm: TrialArm;
  score: number | null;
  valid: boolean;
  issues: string[];
}

export interface TrialGroup {
  n: number;
  median: number | null;
  spread: number | null;
}

export interface TrialSummary {
  teamId: string;
  busy: boolean;
  pending: boolean;
  reason: string;
  groups: Record<TrialArm, TrialGroup>;
  comparable: boolean;
  delta: number | null;
  changes: string[];
  receipts: TrialReceipt[];
}

/** The facade mountPause reads (f1-game's G). */
export interface TrialPauseHost {
  $?: ((id: string) => HTMLElement | null) | undefined;
  quitToMenu?: (() => void) | undefined;
  openGarageFrom?: ((from: string) => void) | undefined;
  setupTrialContext?: (() => unknown) | undefined;
}

export interface TrialPauseUi {
  section: HTMLElement;
  refresh(): void;
  dispose(): void;
}

interface Pending {
  arm: TrialArm;
  context: TrialContext | null;
  issues: string[];
  tune: Tune;
}

interface Run {
  id: number;
  teamId: string;
  store: GarageStoreLike;
  launch: TrialOptions["launch"];
  refresh: (() => void) | undefined;
  cancelRuntime: (() => void) | undefined;
  before: Tune;
  baseline: Tune;
  candidate: Tune;
  receipts: TrialReceipt[];
  pending: Pending | null;
  owned: Tune | null;
  revision: string | number | null;
  context: TrialContext | null;
  busy: boolean;
  reason?: string;
}

const json = (value: unknown): string | undefined => JSON.stringify(value, (_k, v: unknown) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, (v as Record<string, unknown>)[k]])) : v);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function same(a: unknown, b: unknown): boolean { return json(a) === json(b); }

export function contextIssues(a: TrialContext | null | undefined, b: TrialContext | null | undefined, keys: readonly string[] = REQUIRED): string[] {
  const issues: string[] = [];
  if (!b || b["unscored"] !== true) issues.push("Unscored session not verified");
  if (!b || b["stableWeather"] !== true) issues.push("Stable weather not verified");
  for (const k of keys) {
    if (!b || b[k] == null || (a && a[k] == null)) issues.push(k + " unknown");
    else if (a && !same(a[k], b[k])) issues.push(k + " changed");
  }
  return issues;
}

export function createSetupTrials(tune: SetupTuneApi = SetupTune) {
  let run: Run | null = null, sequence = 0;
  const pauseMounts = new WeakMap<object, TrialPauseUi>();
  const listeners = new Set<() => void>();
  function notify(): void { for (const fn of listeners) fn(); }
  function create(o: TrialOptions | null | undefined): boolean {
    cancel();
    if (!o || typeof o.launch !== "function") return false;
    run = { id: ++sequence, teamId: o.teamId, store: o.store, launch: o.launch, refresh: o.refresh, cancelRuntime: o.cancelRuntime,
      before: tune.get(o.teamId), baseline: copy(o.baseline as Tune), candidate: copy((o.candidateNow ? o.candidateNow() : o.candidate) as Tune), receipts: [], pending: null,
      owned: null, revision: null, context: null, busy: false };
    notify(); return true;
  }
  function owns(r: Run): boolean { return !!r.owned && same(tune.get(r.teamId), r.owned) && (!r.store.keyRevision || r.revision === r.store.keyRevision("setup." + r.teamId)); }
  function cancel(): boolean {
    const r = run;
    if (!r) return false;
    // Cancel the owned session before restoring the mechanical sheet. The callback
    // must refuse a newer session; it runs while the launch lease is still current.
    if (r.cancelRuntime) r.cancelRuntime();
    run = null;
    if (owns(r)) { tune.set(r.teamId, r.before); if (r.refresh) r.refresh(); }
    notify(); return true;
  }
  async function attempt(arm: TrialArm): Promise<boolean> {
    const r = run;
    if (!r || r.busy || r.pending || !ARMS.includes(arm) || r.receipts.filter(x => x.arm === arm).length >= 6) return false;
    if (r.owned && !owns(r)) { r.reason = "Mechanical setup changed outside this comparison. Cancel and start again."; notify(); return false; }
    r.busy = true; const t = arm === "candidate" ? r.candidate : r.baseline;
    r.owned = tune.set(r.teamId, t); r.revision = r.store.keyRevision ? r.store.keyRevision("setup." + r.teamId) : null;
    notify();
    let result: TrialLaunchResult | null | undefined;
    try { result = await r.launch({ teamId: r.teamId, tune: copy(t), mode: "launch", isCurrent: () => run === r && owns(r) }); }
    catch { result = { ok: false, reason: "Could not start the launch drill." }; }
    if (run !== r) return false;
    r.busy = false;
    if (!result || !result.ok) { r.reason = result && result.reason || "Could not start the launch drill."; notify(); return false; }
    // Normal restart recomputes from this sheet without taking ownership from a later edit.
    if (!owns(r)) { r.reason = "Restart changed the proposed mechanical setup."; notify(); return false; }
    const context = result.context;
    const issues = contextIssues(r.context, context);
    if (!r.context && !issues.length) r.context = copy(context as TrialContext);
    r.pending = { arm, context: context ? copy(context) : null, issues, tune: copy(t) };
    r.reason = issues.length ? "Not comparable: " + issues.join("; ") : "Launch drill armed. Drive from rest to half racing speed.";
    notify(); return true;
  }
  function observe(context: TrialContext | null | undefined): boolean {
    const r = run, p = r && r.pending;
    if (!r || !p) return false;
    p.issues = [...new Set(p.issues.concat(contextIssues(p.context, context, STATIC), owns(r) ? [] : ["Mechanical setup changed during attempt"]))];
    return true;
  }
  function record(result: TrialRecordResult | null | undefined, context: TrialContext | null | undefined): boolean {
    const r = run, p = r && r.pending;
    if (!r || !p || !result || result.mode !== "launch") return false;
    r.pending = null;
    const issues = p.issues.concat(contextIssues(p.context, context, STATIC));
    if (!owns(r)) issues.push("Mechanical setup changed during attempt");
    if (!result.clean || !Number.isFinite(result.score)) issues.push(result.reason || "Unclean or incomplete attempt");
    r.receipts.push({ arm: p.arm, score: Number.isFinite(result.score) ? result.score : null, valid: !issues.length, issues: [...new Set(issues)] });
    r.reason = issues.length ? "Attempt excluded: " + issues.join("; ") : "Clean launch recorded. Return to Garage to choose the next attempt.";
    notify(); return true;
  }
  function invalidate(reason?: string): boolean {
    if (!run || !run.pending) return false;
    return record({ mode: "launch", clean: false, score: null, reason: reason || "Attempt reset" }, run.pending.context);
  }
  function summary(): TrialSummary | null {
    if (!run) return null;
    const r = run;
    const groups = {} as Record<TrialArm, TrialGroup>;
    for (const arm of ARMS) {
      const rows = r.receipts.filter(x => x.arm === arm && x.valid).map(x => x.score as number).sort((a, b) => a - b), n = rows.length;
      groups[arm] = { n, median: n ? ((rows[Math.floor((n - 1) / 2)] as number) + (rows[Math.floor(n / 2)] as number)) / 2 : null, spread: n ? (rows[n - 1] as number) - (rows[0] as number) : null };
    }
    const enough = Object.values(groups).every(g => g.n >= 3), mismatched = r.receipts.some(x => x.issues.some(i => /changed|unknown|verified/.test(i)));
    // `enough` means every median and spread below is a number.
    const repeatable = enough && Math.abs((groups.baseline.median as number) - (groups.control.median as number)) <= Math.max(.01, groups.baseline.spread as number, groups.control.spread as number);
    return { teamId: r.teamId, busy: r.busy, pending: !!r.pending, reason: r.reason || "Choose three clean attempts per arm, including the identical-setup control.", groups,
      comparable: enough && !mismatched && repeatable, delta: enough && !mismatched && repeatable ? (groups.candidate.median as number) - (groups.baseline.median as number) : null,
      changes: tune.FIELDS.filter(k => r.baseline[k] !== r.candidate[k]).map(k => tune.RANGE[k].label + ": " + r.baseline[k] + " → " + r.candidate[k]), receipts: copy(r.receipts) };
  }
  function mountPause(G: TrialPauseHost): TrialPauseUi | null {
    const mounted = pauseMounts.get(G);
    if (mounted) return mounted;
    const pause = G.$ && G.$("pausemenu"), host = pause && pause.querySelector(".sheet-body");
    if (!pause || !host || !G.quitToMenu || !G.openGarageFrom) return null;
    const quitToMenu = G.quitToMenu, openGarageFrom = G.openGarageFrom;
    const box = document.createElement("section"); box.className = "player-tool-panel"; box.setAttribute("aria-label", "Setup comparison");
    const status = document.createElement("p"); status.className = "adv-help"; status.setAttribute("role", "status");
    const row = document.createElement("div"); row.className = "chip-row";
    function button(label: string, fn: () => void): void { const b = document.createElement("button"); b.type = "button"; b.className = "sel-chip"; b.textContent = label; b.onclick = fn; row.appendChild(b); }
    const ownsSession = (): boolean => !!run && (!G.setupTrialContext || !!G.setupTrialContext());
    button("RETURN TO SETUP COMPARISON", () => {
      if (!ownsSession()) return;
      invalidate("Returned to garage before drill completion");
      quitToMenu(); openGarageFrom("menu");
    });
    button("CANCEL SETUP COMPARISON", () => {
      if (!ownsSession()) return;
      // Stop the live graph/session first, so restoring a sheet cannot leave
      // a candidate's old computed mods running against the restored values.
      quitToMenu(); cancel(); openGarageFrom("menu");
    });
    const paint = (): void => { const s = summary(); box.hidden = !ownsSession(); status.textContent = s ? "Setup comparison: " + s.reason + " Return keeps completed attempts; unfinished attempts are excluded. Cancel ends the session before restoring only the setup still owned by this comparison." : ""; };
    box.append(status, row); host.appendChild(box); listeners.add(paint); paint();
    let observer: MutationObserver | null = null;
    if (typeof MutationObserver === "function") { observer = new MutationObserver(paint); observer.observe(pause, { attributes: true, attributeFilter: ["hidden"] }); }
    const ui: TrialPauseUi = { section: box, refresh: paint, dispose() { if (observer) observer.disconnect(); listeners.delete(paint); box.remove(); pauseMounts.delete(G); } }; pauseMounts.set(G, ui); return ui;
  }
  function mount(host: HTMLElement, o: TrialOptions): { dispose(): void } {
    const box = document.createElement("section"); box.className = "player-tool-panel";
    const title = document.createElement("h3"); title.className = "sel-label"; title.textContent = "MEASURE A SETUP · UNSCORED LAUNCH";
    const status = document.createElement("p"); status.className = "adv-help"; status.setAttribute("role", "status");
    const rows = document.createElement("div"); rows.className = "chip-row";
    const buttons: HTMLButtonElement[] = [];
    function button(label: string, fn: () => unknown): HTMLButtonElement { const b = document.createElement("button"); b.type = "button"; b.className = "sel-chip"; b.textContent = label; b.onclick = fn; rows.appendChild(b); buttons.push(b); return b; }
    const at = (i: number): HTMLButtonElement => buttons[i] as HTMLButtonElement; // all six exist before the first paint
    const paint = (): void => {
      const s = summary(), mine = !!s && s.teamId === o.teamId;
      status.textContent = !s || !mine ? "Compare the setup from this garage visit with the current sheet. Include an identical baseline control; three clean repeats of each are required (up to six attempts per arm). Measures only this launch drill." : s.reason + " Baseline → candidate: " + (s.changes.join("; ") || "identical mechanical sheets (A/A)") + ". " + Object.entries(s.groups).map(([k, g]) => k + ": " + g.n + " clean" + (g.n ? ", median " + (g.median as number).toFixed(3) + "s, spread " + (g.spread as number).toFixed(3) + "s" : "")).join(" · ") + (s.comparable ? " Observed candidate minus baseline: " + (s.delta as number).toFixed(3) + "s. This is not a universal setup ranking." : " No comparison conclusion yet.") + (s.receipts.length ? " Attempts: " + s.receipts.map(x => x.arm + " " + (x.valid ? (x.score as number).toFixed(3) + "s" : "excluded: " + x.issues.join(", "))).join("; ") : "");
      for (let i = 1; i < 4; i++) at(i).disabled = !s || !mine || s.busy || s.pending || s.receipts.filter(x => x.arm === ARMS[i - 1]).length >= 6;
      at(0).disabled = !!mine; at(4).disabled = !mine; at(5).disabled = !s || !mine || !s.pending;
    };
    button("BEGIN COMPARISON", () => { create(o); paint(); });
    for (const arm of ARMS) button(arm === "control" ? "RUN A/A CONTROL" : "RUN " + arm.toUpperCase(), () => attempt(arm));
    button("CANCEL / RESTORE OWNED SETUP", cancel);
    button("EXCLUDE CURRENT ATTEMPT", () => invalidate("Stopped before drill completion"));
    box.append(title, status, rows); host.appendChild(box); listeners.add(paint); paint();
    return { dispose() { listeners.delete(paint); box.remove(); } };
  }
  return Object.freeze({ create, cancel, attempt, observe, record, invalidate, summary, contextIssues, mount, mountPause, active: (): boolean => !!run });
}

export type SetupTrialsApi = ReturnType<typeof createSetupTrials>;

/** The page's SetupTrials (one comparison at a time), over the page's SetupTune. */
export const SetupTrials: SetupTrialsApi = createSetupTrials();
