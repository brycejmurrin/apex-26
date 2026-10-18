/**
 * RACE CONTROL: the line crossing, the chequered flag, classification, and the
 * caution machine (green / local yellow / VSC / safety car / red flag).
 *
 * Ported from f1-game js/race/race-control.js (main @ 2026-10-18). Float math
 * keeps f1-game's operation order. Differences, on purpose:
 * - The machine's closure state lives in `RaceControlState` (src/contracts/race.ts)
 *   and every `G` read is an explicit `RaceControlCtx` member.
 * - The deferred line step (`beginLineStep`/`endLineStep`, module-level in
 *   f1-game :59-88) is a `LineStep` object the caller owns.
 * - `Log` calls are replaced by the optional `onFlag` / `announce` hooks.
 */
import type {
  Caution,
  CautionLevel,
  HazardPicture,
  RaceCar,
  RaceControlState,
  RacePhase,
} from "../contracts/race";

// ─── Result countdown (race-control.js:5-46) ──────────────────────────────

/** Seconds of race time a solo race runs on after the player is done (:20). */
export const POST_FINISH_CAP = 75;

/** game.js owns the bag (`post = { solo, since }`, :12-19). */
export interface PostFinish {
  solo: boolean;
  since: number;
}

type FinishCar = Pick<RaceCar, "finished" | "retired" | "human" | "finishT" | "penalty" | "_nHuman">;

/** Seconds until the result sheet, 0 = keep racing. race-control.js:21-46. */
export function finishDelay(
  cars: readonly (FinishCar | null | undefined)[] | null | undefined,
  raceT: number,
  lapsTarget: number,
  raceT0?: number,
  post?: PostFinish | null,
): number {
  const ran = raceT - ((raceT0 ?? 0) > 0 ? (raceT0 as number) : 0);
  let anyHuman = false, allHumansDone = true, anyFinished = false, running = false, pend = 0;
  for (const c of cars || []) {
    if (!c) continue;
    if (c.finished) { anyFinished = true; if (!c.retired) pend = Math.max(pend, (c.finishT || 0) + (c.penalty || 0)); }
    else if (!c.retired) running = true;
    if (!c.human && !c._nHuman) continue;
    anyHuman = true;
    if (!c.finished && !c.retired) allHumansDone = false;
  }
  if (running && raceT < pend && ran <= 360 * lapsTarget) return 0;
  if (post) { if (!(anyHuman && allHumansDone)) post.since = -1; else if (post.since < 0) post.since = raceT; }
  if (anyHuman && allHumansDone && post && post.solo && running) return raceT - post.since < POST_FINISH_CAP ? 0 : 0.1;
  if (anyHuman && allHumansDone) return 2.2;
  if (!anyHuman && anyFinished) return 3.5;
  if (ran > 360 * lapsTarget) return 0.1;
  return 0;
}

/** The chequered flag is out once any classified car has taken it (:51-54). */
export function flagOut(
  cars: readonly (Pick<RaceCar, "finished" | "retired" | "finishT"> | null | undefined)[] | null | undefined,
  at = Infinity,
): boolean {
  for (const c of cars || []) if (c && c.finished && !c.retired && (c.finishT || 0) <= at) return true;
  return false;
}

// ─── The line crossing (race-control.js:56-137) ───────────────────────────

/** What one call to `lineTransition` reports. */
export interface LineCross {
  direction: 1 | -1;
  changed: boolean;
  lapDone: number | null;
  flagged: boolean;
  recross?: boolean;
  /** Set by the caller (game.js:6206). */
  lapValid?: boolean;
}

type LineCar = Pick<RaceCar, "lap" | "lapTime" | "finished" | "finishT" | "retired" | "_nFallback" | "_recross" | "_lapTimeAtLine" | "fuelLap" | "fuelRestartLaps">;

interface LineEntry<C extends LineCar> {
  c: C;
  cross: LineCross;
  target: number;
  cars: readonly C[];
  time: number;
  callback?: (c: C, cross: LineCross, newS: number) => void;
  newS?: number;
}

function settleLine<C extends LineCar>(e: LineEntry<C>): void {
  const { c, cross, time, target, cars } = e;
  // Temporary AI motion cannot declare a connected owner finished or raise the flag.
  cross.flagged = !c._nFallback && target > 0 && (c.lap > target || (c.lap > 1 && flagOut(cars, time)));
  if (cross.flagged) { c.finished = true; c.finishT = time; }
}

// At an exact tie the full-distance crossing raises the flag first (:78).
const byCrossing = <C extends LineCar>(a: LineEntry<C>, b: LineEntry<C>): number =>
  (a.time - b.time) || (Number(b.c.lap > b.target) - Number(a.c.lap > a.target));

/**
 * One physics step's line crossings, settled in clock order after every motion
 * owner has reported (race-control.js:56-88). f1-game keeps this in module
 * scope; here the caller owns one `LineStep`.
 */
export class LineStep<C extends LineCar = LineCar> {
  private lineCars: readonly C[] | null = null;
  private readonly entries: LineEntry<C>[] = [];

  begin(cars: readonly C[]): void { this.lineCars = cars; this.entries.length = 0; }

  /** True when a crossing reported this step has been deferred to `end()` (:68-74). */
  defer(c: C, cross: LineCross | null, newS: number, callback: (c: C, cross: LineCross, newS: number) => void): boolean {
    if (!this.lineCars || !cross || cross.direction < 0) return false;
    const e = this.entries.find((x) => x.cross === cross);
    if (!e) return false;
    e.callback = callback; e.newS = newS;
    return true;
  }

  settle(): void {
    if (this.entries.length > 1) this.entries.sort(byCrossing);
    for (const e of this.entries) settleLine(e);
  }

  end(): void {
    this.lineCars = null;
    this.settle();
    for (const e of this.entries) if (e.callback) e.callback(e.c, e.cross, e.newS as number);
    this.entries.length = 0;
  }

  /** @internal lineTransition's hook. */
  push(e: LineEntry<C>): boolean {
    if (this.lineCars !== e.cars) return false;
    this.entries.push(e);
    return true;
  }
}

/**
 * One line-crossing transition for every motion owner (:102-137). `dt` is the
 * step the caller already added to `lapTime`/`raceT`; with it the lap is timed
 * to the crossing inside the step. Pass `step` to defer flag settlement.
 */
export function lineTransition<C extends LineCar>(
  c: C | null | undefined,
  oldS: number,
  newS: number,
  ds: number,
  total: number,
  lapsTarget: number,
  cars: readonly C[],
  raceT: number,
  dt?: number,
  step?: LineStep<C> | null,
): LineCross | null {
  if (!c || c.finished || !(total > 0)) return null;
  if (ds > 0 && oldS > total * 0.5 && newS < total * 0.5) {
    let over = 0;
    if ((dt as number) > 0 && Number.isFinite(dt)) {
      const frac = (total - oldS) / ds;
      if (Number.isFinite(frac)) over = (dt as number) * (1 - Math.min(1, Math.max(0, frac)));
    }
    const lapDone = Math.max(0, (c.lapTime || 0) - over);
    const recross = !!c._recross;
    c._recross = false;
    c.lap = (c.lap || 0) + 1;
    c.fuelLap = Math.max(c.fuelLap || 0, c.lap + (c.fuelRestartLaps || 0));
    c._lapTimeAtLine = lapDone;
    c.lapTime = (c.lapTime || 0) - lapDone;
    const cross: LineCross = { direction: 1, changed: true, lapDone, flagged: false, recross };
    const e: LineEntry<C> = {
      c, cross, target: Number(lapsTarget), cars,
      time: Number.isFinite(raceT) ? Math.max(0, raceT - over) : 0,
    };
    if (!step || !step.push(e)) settleLine(e);
    return cross;
  }
  if (ds < 0 && oldS < total * 0.5 && newS > total * 0.5) {
    if (!(c.lap > 0)) return { direction: -1, changed: false, lapDone: null, flagged: false };
    c.lap--;
    c.lapTime = c._lapTimeAtLine != null ? c._lapTimeAtLine : c.lapTime;
    c._recross = true;
    return { direction: -1, changed: true, lapDone: null, flagged: false };
  }
  return null;
}

// ─── Classification (race-control.js:138-197) ─────────────────────────────

type OrderCar = Pick<RaceCar, "lap" | "finishT" | "penalty">;

/** Finishers: more laps first, then finishT + penalty; a non-finite clock last (:143-149). */
export function finishOrder(a: OrderCar, b: OrderCar): number {
  const clock = (c: OrderCar): number => {
    const t = c && c.finishT;
    return Number.isFinite(t) ? (t as number) + (c.penalty || 0) : Infinity;
  };
  return ((b.lap || 0) - (a.lap || 0)) || (clock(a) - clock(b));
}

/** Cars still running at the flag: progress less penalty × vRef metres (:155-157). */
export function runOrder(vRef: number): (a: Pick<RaceCar, "prog" | "penalty">, b: Pick<RaceCar, "prog" | "penalty">) => number {
  return (a, b) => (b.prog - (b.penalty || 0) * vRef) - (a.prog - (a.penalty || 0) * vRef);
}

type ClassCar = Pick<RaceCar, "lap" | "finished" | "retired" | "dsq" | "prog" | "classified">;

/**
 * The classification order from endRace's three piles: laps first (B2.5.5(a)),
 * then the 90 % line for every car (B2.5.5(b)). Sets `classified` on every car.
 * race-control.js:175-186.
 */
export function classify<C extends ClassCar>(cars: readonly C[], fin: readonly C[], run: readonly C[], out: readonly C[]): C[] {
  const lapsAt = (c: C): number => (c.lap || 0) + (c.finished ? 0 : 1);
  const done = (c: C): number => (c.retired ? (c.lap || 0) - 1 : lapsAt(c) - 1);
  const ref = fin.length ? fin : run.length ? run : out.filter((c) => !c.dsq);
  const winDone = ref.length ? Math.max(...ref.map((c) => c.lap || 0)) - 1 : 0;
  const cut = Math.floor(0.9 * winDone);
  for (const c of cars) c.classified = !c.dsq && (winDone > 0 ? done(c) >= cut : !c.retired);
  const all = fin.concat(run, out);
  return all.filter((c) => c.classified).sort((a, b) => lapsAt(b) - lapsAt(a))
    .concat(fin.concat(run, out).filter((c) => !c.classified && !c.dsq)
      .sort((a, b) => (lapsAt(b) - lapsAt(a)) || ((b.prog || 0) - (a.prog || 0))));
}

/** A race that never saw the flag (:192-197). */
export interface ShortRun {
  laps: number;
  of: number;
}

/** `{ laps, of }` for a race no car finished, else null (:192-197). */
export function shortRun(
  cars: readonly Pick<RaceCar, "finished" | "retired" | "dsq" | "lap">[] | null | undefined,
  lapsTarget: number,
): ShortRun | null {
  if (!(lapsTarget > 0) || !cars || cars.some((c) => c.finished && !c.retired)) return null;
  const live = cars.filter((c) => !c.retired);
  const ref = live.length ? live : cars.filter((c) => !c.dsq);
  return { laps: ref.length ? Math.max(0, Math.max(...ref.map((c) => c.lap || 0)) - 1) : 0, of: lapsTarget };
}

// ─── The caution machine (race-control.js:199-621) ────────────────────────

export const LABEL = ["GREEN", "YELLOW", "VSC", "SAFETY CAR", "RED FLAG"] as const;
export const YELLOW_MIN = 3;
export const VSC_MIN = 6;
export const SC_MIN = 10;
export const RED_MIN = 16;
export const RED_STOP = 8;
export const RED_HOLD = 6;
export const MIN_HOLD = 6;
export const YELLOW_MAX = 30;
export const SC_MAX = 90;
export const CAP_REARM_HOLD = 45;
export const QUERY_EVERY = 0.25;
/** Storm SC windows, f1-game js/race/storm.js:38-39. */
export const STORM_SC_START_S = 90;
export const STORM_SC_ROLL_S = 150;

/** A fresh, green caution (:218-220). */
export function blankCaution(): Caution {
  return { level: 0, sector: -1, frac: 0, total: 0, sectors: [0, 0, 0], sinceT: 0, cause: "", phase: "" };
}

/**
 * Everything the machine read off `G` (race-control.js:227-604). Functions are
 * called live, exactly where f1-game read the member.
 */
export interface RaceControlCtx {
  /** G.state. */
  readonly phase: RacePhase;
  /** G.timeTrial. */
  readonly timeTrial: boolean;
  /** G.session === "quali". */
  readonly quali: boolean;
  /** G.ranked: cars by progress, leader first. */
  readonly ranked: readonly Pick<RaceCar, "lap">[];
  /** G.raceT. */
  readonly raceT: number;
  /** NetPlay.active(). */
  readonly netActive: boolean;
  /** NetPlay.ownsRaceControl(). */
  readonly ownsRaceControl: boolean;
  /** NetPlay.reportCaution: the host publishes a changed caution. */
  readonly reportCaution?: (c: Readonly<Caution>) => void;
  /** DebrisWorld.active(). */
  readonly debrisActive: () => boolean;
  /** DebrisWorld.hazards(). */
  readonly hazards: () => HazardPicture;
  /** Storm.is(G.raceWeather). */
  readonly storm: boolean;
  /** TyreModel.treadFor(weather, wetness) > 0 (race-control.js:589-592). */
  readonly lowGrip: boolean;
  /** G.announce; returns false when the banner did not take it. */
  readonly announce?: (text: string, secs: number, kind: string) => boolean | void;
  /** Log hook for every level change (Log.info "RaceControl flag A -> B"). */
  readonly onFlag?: (prev: number, next: number) => void;
}

/** A fresh machine (race-control.js:227-264). `enabled` is the stored CAUTIONS setting. */
export function createRaceControl(enabled = true): RaceControlState {
  return {
    caution: blankCaution(), enabled, queryT: 0, capHoldT: 0, capHoldLevel: 0,
    replayOwned: false, restartWanted: false, otHoldLap: null, lowGripNoted: false,
    held: 0, heldCause: "", scriptHeld: 0, scriptCause: "", wxHeld: 0,
    stormSince: null, stormAtStart: false, stormLastT: 0, sent: "",
  };
}

/** race-control.js:266-278. */
export function resetRaceControl(st: RaceControlState): void {
  st.caution = blankCaution(); st.replayOwned = false;
  st.held = 0; st.heldCause = "";
  st.scriptHeld = 0; st.scriptCause = ""; st.wxHeld = 0; st.stormSince = null; st.stormAtStart = false; st.stormLastT = 0;
  st.queryT = 0;
  st.capHoldT = 0; st.capHoldLevel = 0;
  st.restartWanted = false;
  st.otHoldLap = null;
  st.lowGripNoted = false;
  st.sent = "";
}

type FlagHooks = Pick<RaceControlCtx, "ranked" | "onFlag">;

// Every level change goes through here: the hook, and the Overtake hold when a SC or red ends (:282-288).
function flag(st: RaceControlState, ctx: FlagHooks, prev: number, next: number): void {
  if (prev !== next && ctx.onFlag) ctx.onFlag(prev, next);
  if (prev >= 3 && next < 3) {
    const leader = ctx.ranked && ctx.ranked[0];
    st.otHoldLap = leader ? (leader.lap | 0) : null;
  }
}

/** CAUTIONS switch; off also drops a flying flag (:292-297). The caller persists `enabled`. */
export function setCautionsEnabled(st: RaceControlState, on: boolean): boolean {
  st.enabled = !!on;
  if (!st.enabled) resetRaceControl(st);
  return st.enabled;
}

type PublishCtx = Pick<RaceControlCtx, "netActive" | "ownsRaceControl" | "reportCaution">;

function publish(st: RaceControlState, ctx: PublishCtx): void {
  if (!ctx.netActive || !ctx.ownsRaceControl) return;
  const c = st.caution;
  const key = c.level + "|" + c.sector + "|" + c.cause + "|" + c.phase +
    "|" + c.total + "|" + (c.sectors ? c.sectors.join(",") : "");
  if (key === st.sent) return;
  st.sent = key;
  if (ctx.reportCaution) {
    ctx.reportCaution({
      level: c.level, sector: c.sector, frac: c.frac, cause: c.cause, total: c.total,
      sectors: c.sectors, sinceT: c.sinceT, phase: c.phase,
    });
  }
}

function dropToGreen(st: RaceControlState, ctx: FlagHooks): void {
  const c = st.caution, prev = c.level;
  c.level = 0; c.sector = -1; c.frac = 0;
  c.cause = ""; c.sinceT = 0; c.phase = "";
  flag(st, ctx, prev, 0);
}

function capDropIfExpired(st: RaceControlState, ctx: FlagHooks & PublishCtx): boolean {
  const c = st.caution;
  if (c.level === 0 || c.level === 4) return false;
  const cap = c.level >= 2 ? SC_MAX : YELLOW_MAX;
  if (c.sinceT < cap) return false;
  st.capHoldLevel = c.level;
  dropToGreen(st, ctx);
  st.capHoldT = CAP_REARM_HOLD;
  publish(st, ctx);
  return true;
}

// Combine the two holders and step a flag the OLD hold raised down to the new one (:515-530).
function rehold(st: RaceControlState, ctx: FlagHooks & PublishCtx): number {
  const prevHeld = st.held;
  st.held = Math.max(st.scriptHeld, st.wxHeld);
  st.heldCause = !st.held ? "" : st.scriptHeld >= st.wxHeld ? st.scriptCause : "STORM";
  const c = st.caution;
  if (st.held < c.level && c.level <= prevHeld && c.level < 4) {
    if (st.held === 0) dropToGreen(st, ctx);
    else {
      const prev = c.level;
      c.level = st.held as CautionLevel; c.sector = -1; c.frac = 0;
      c.cause = st.heldCause; c.sinceT = 0; c.phase = "";
      flag(st, ctx, prev, st.held);
    }
    publish(st, ctx);
  }
  return st.held;
}

/** Fly a flag by script, level 1-3; 0 releases (:506-512). */
export function holdCaution(st: RaceControlState, ctx: FlagHooks & PublishCtx, level: number, cause?: string): number {
  st.scriptHeld = Math.max(0, Math.min(3, level | 0));
  st.scriptCause = st.scriptHeld ? (typeof cause === "string" && cause ? cause.slice(0, 64) : LABEL[st.scriptHeld] as string) : "";
  rehold(st, ctx);
  return st.scriptHeld;
}

// STORM → SAFETY CAR (:543-567).
function stormTick(st: RaceControlState, ctx: RaceControlCtx): void {
  const t = typeof ctx.raceT === "number" && Number.isFinite(ctx.raceT) ? ctx.raceT : 0;
  if (st.stormSince != null && t < st.stormLastT - 0.5) st.stormSince -= st.stormLastT - t;
  st.stormLastT = t;
  if (!ctx.storm) {
    st.stormSince = null;
    if (st.wxHeld) { st.wxHeld = 0; rehold(st, ctx); if (ctx.announce) ctx.announce("STORM EASING — SAFETY CAR IN THIS LAP", 3, "info"); }
    return;
  }
  if (st.stormSince == null) {
    st.stormSince = t; st.stormAtStart = t < 2;
    st.wxHeld = 3; rehold(st, ctx);
    if (ctx.announce) ctx.announce(st.stormAtStart ? "STORM — START BEHIND THE SAFETY CAR" : "STORM — SAFETY CAR DEPLOYED", 3, "warning");
    return;
  }
  if (st.wxHeld && t - st.stormSince >= (st.stormAtStart ? STORM_SC_START_S : STORM_SC_ROLL_S)) {
    st.wxHeld = 0; rehold(st, ctx);
  }
}

/**
 * One race-control tick (:342-479). f1-game's per-frame stamp dedupe
 * (`G._s8Stamp`) is the caller's: call this once per display frame.
 */
export function updateRaceControl(st: RaceControlState, ctx: RaceControlCtx, dt: number): void {
  const c = st.caution;
  if ((ctx.phase !== "race" && !(st.replayOwned && ctx.phase === "count")) || ctx.timeTrial || ctx.quali) {
    if (c.level !== 0 || st.capHoldT || st.replayOwned) resetRaceControl(st);
    st.lowGripNoted = false;
    return;
  }
  if (st.replayOwned) return;
  if (!st.lowGripNoted && ctx.lowGrip && ctx.announce) {
    st.lowGripNoted = ctx.announce("LOW GRIP — OVERTAKE OFF", 3, "warning") !== false;
  }
  if (!ctx.ownsRaceControl) return;
  stormTick(st, ctx);
  const cz = st.caution;   // stormTick may not replace it, but keep f1-game's live read
  if (st.held > cz.level && cz.level !== 4) {
    const prev = cz.level;
    cz.level = st.held as CautionLevel; cz.sector = -1; cz.frac = 0;
    cz.cause = st.heldCause; cz.sinceT = 0; cz.phase = "";
    flag(st, ctx, prev, st.held);
    publish(st, ctx);
  }
  if (cz.level !== 0) cz.sinceT += dt;
  if (cz.level === 4) {
    cz.phase = cz.sinceT < RED_STOP ? "stopping" : "held";
    if (cz.sinceT >= RED_STOP + RED_HOLD) {
      st.restartWanted = true;
      st.capHoldLevel = 4; st.capHoldT = CAP_REARM_HOLD;
      dropToGreen(st, ctx);
    }
    publish(st, ctx);
    return;
  }
  if (!st.enabled) {
    if (!(st.held && cz.level <= st.held)) capDropIfExpired(st, ctx);
    return;
  }
  if (!ctx.debrisActive()) {
    if (!(st.held && cz.level <= st.held)) capDropIfExpired(st, ctx);
    return;
  }
  st.queryT += dt;
  if (st.queryT < QUERY_EVERY) return;
  st.queryT -= QUERY_EVERY;

  const hz = ctx.hazards();
  const redTotal = hz.redTotal == null ? hz.total : hz.redTotal;
  let desired = 0, dsector = -1, dfrac = 0, dcause = "";
  if (redTotal >= RED_MIN) { desired = 4; dcause = "RED FLAG"; }
  else if (hz.total >= SC_MIN) { desired = 3; dcause = "SAFETY CAR"; }
  else if (hz.total >= VSC_MIN) { desired = 2; dcause = "VSC"; }
  else if (hz.worst.count >= YELLOW_MIN) {
    desired = 1; dsector = hz.worst.sector; dfrac = hz.worst.frac; dcause = "YELLOW";
  }
  cz.total = hz.total;
  cz.sectors = hz.sectors.slice();
  if (desired === 4 && ctx.netActive) { desired = 3; dcause = "SAFETY CAR"; }

  if (st.held && desired < st.held) { desired = st.held; dsector = -1; dfrac = 0; dcause = st.heldCause; }
  if (!(st.held && cz.level <= st.held) && capDropIfExpired(st, ctx)) return;
  if (st.capHoldT > 0) {
    st.capHoldT = Math.max(0, st.capHoldT - QUERY_EVERY);
    if (st.capHoldT === 0) st.capHoldLevel = 0;
  }

  if (desired > cz.level) {
    if (st.capHoldT > 0 && desired <= st.capHoldLevel && desired !== st.held) { publish(st, ctx); return; }
    const prev = cz.level;
    cz.level = desired as CautionLevel; cz.sector = dsector; cz.frac = dfrac;
    cz.cause = dcause; cz.sinceT = 0;
    cz.phase = desired === 4 ? "stopping" : "";
    flag(st, ctx, prev, desired);
  } else if (desired < cz.level) {
    if (cz.sinceT >= MIN_HOLD) {
      const prev = cz.level;
      cz.level = desired as CautionLevel;
      if (desired !== 1) cz.sector = -1;
      else if (dsector >= 0) cz.sector = dsector;
      else if (hz.worst && hz.worst.sector >= 0) cz.sector = hz.worst.sector;
      else cz.sector = 0;
      cz.frac = dfrac; cz.cause = dcause; cz.sinceT = 0;
      flag(st, ctx, prev, desired);
    }
  } else if (desired === 1 && dsector >= 0) {
    cz.sector = dsector; cz.frac = dfrac;
  }
  publish(st, ctx);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The host's word off the wire, every field coerced (:484-499). */
export function applyCaution(st: RaceControlState, ctx: FlagHooks, d: unknown): boolean {
  if (!d || typeof d !== "object") return false;
  const o = d as Record<string, unknown>;
  st.replayOwned = o["replay"] === true;
  const c = st.caution, prev = c.level;
  c.level = Math.max(0, Math.min(4, (o["level"] as number) | 0)) as CautionLevel;
  const sector = o["sector"];
  c.sector = Number.isInteger(sector) && (sector as number) >= -1 ? (sector as number) : -1;
  c.frac = num(o["frac"]);
  c.cause = typeof o["cause"] === "string" ? o["cause"].slice(0, 64) : "";
  c.total = Math.max(0, num(o["total"]));
  const sectors = o["sectors"];
  if (Array.isArray(sectors)) c.sectors = sectors.slice(0, 3).map(num);
  c.sinceT = Math.max(0, num(o["sinceT"]));
  c.phase = typeof o["phase"] === "string" ? o["phase"].slice(0, 16) : "";
  flag(st, ctx, prev, c.level);
  return true;
}

/** The one-shot restart request at the end of a red-flag procedure (:570). */
export function takeRestart(st: RaceControlState): boolean { const r = st.restartWanted; st.restartWanted = false; return r; }
/** Drop the re-arm hold once the surface is cleared (:578). */
export function clearCapHold(st: RaceControlState): void { st.capHoldT = 0; st.capHoldLevel = 0; }
/** A red-flag regrid rewound the leader's lap (:580). */
export function rewound(st: RaceControlState): void { if (st.otHoldLap != null) st.otHoldLap -= 1; }

/** May a car earn Overtake at the Detection Line now? (:596). */
export function otDetectOpen(st: RaceControlState, lowGrip: boolean): boolean { return st.caution.level < 3 && !lowGrip; }

/** OVERTAKE enabled (B7.2.2): leader past lap 1, no SC/red, not low grip, past the hold (:597-604). */
export function otEnabled(st: RaceControlState, ranked: readonly Pick<RaceCar, "lap">[], lowGrip: boolean): boolean {
  if (st.caution.level >= 3 || lowGrip) return false;
  const leader = ranked[0];
  if (!leader || !(leader.lap > 1)) return false;
  return st.otHoldLap == null || leader.lap > st.otHoldLap;
}

/** The HUD readout (:606-613). */
export function cautionInfo(st: RaceControlState, lowGrip: boolean): {
  level: CautionLevel; label: string; sector: number; frac: number; total: number; sectors: number[];
  sinceT: number; cause: string; phase: string; enabled: boolean; lowGrip: boolean;
} {
  const c = st.caution;
  return {
    level: c.level, label: LABEL[c.level] || "GREEN",
    sector: c.sector, frac: c.frac, total: c.total,
    sectors: c.sectors, sinceT: +c.sinceT.toFixed(2),
    cause: c.cause, phase: c.phase, enabled: st.enabled, lowGrip,
  };
}

// ─── Safety-car queue and no passing (race-control.js:622-678) ────────────

export const SC_PACE = 0.45, SC_CATCH = 0.6, SC_QUEUE_GAP = 1.0;

type QueueCar = Pick<RaceCar, "prog" | "speed" | "finished" | "retired" | "_snapProg" | "_snapSpeed">;
const snapProg = (o: QueueCar): number => (Number.isFinite(o._snapProg) ? (o._snapProg as number) : o.prog);
const snapSpeed = (o: QueueCar): number => (Number.isFinite(o._snapSpeed) ? (o._snapSpeed as number) : o.speed);

/** The SC queue cap as a fraction of vTop (:635-656). */
export function scQueueFrac<C extends QueueCar>(
  c: C | null | undefined,
  cars: readonly C[],
  total: number,
  leader: C | null | undefined,
  vTop: number,
  skip?: (o: C) => boolean,
): number {
  const out = (o: C): boolean => o.finished || o.retired || (!!skip && skip(o));
  if (leader && out(leader)) {
    leader = null;
    for (const o of cars) if (!out(o) && (!leader || snapProg(o) > snapProg(leader))) leader = o;
  }
  if (!c || c === leader || !(total > 0)) return SC_PACE;
  let gap = Infinity;
  for (const o of cars) {
    if (o === c || out(o)) continue;
    const d = ((snapProg(o) - c.prog) % total + total) % total;
    if (d > 0 && d < gap) gap = d;
  }
  if (!Number.isFinite(gap)) return SC_PACE;
  const gapS = gap / Math.max(1, SC_PACE * vTop);
  const t = Math.min(1, Math.max(0, gapS - SC_QUEUE_GAP));
  return SC_PACE + (SC_CATCH - SC_PACE) * t;
}

export const HOLD_M = 12;

/** No passing under a caution: the car ahead in the running order is a speed ceiling (:668-678). */
export function holdCap<C extends QueueCar>(c: C, ranked: readonly C[] | null | undefined, fair?: (o: C) => boolean): number {
  const i = ranked ? ranked.indexOf(c) : -1;
  for (let j = i - 1; j >= 0; j--) {
    const o = (ranked as readonly C[])[j] as C;
    if (o.finished || o.retired || (fair && fair(o))) continue;
    const gap = snapProg(o) - c.prog;
    if (!(gap < HOLD_M)) return Infinity;
    return Math.max(0, (snapSpeed(o) || 0) * (gap < HOLD_M / 2 ? 0.9 : 1));
  }
  return Infinity;
}
