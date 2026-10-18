/**
 * Data Hub WATCH & DRIVE tab (f1-game "RACE IT"): shows one real Grand Prix lap
 * by lap (the order, the gaps, every pass, stop, flag and retirement), WATCHes
 * it recreated from the real positions, and offers a JUMP IN at any lap in any
 * real driver's seat. The game side is reached only through ./bridge.ts
 * (RealRacePort, the race lane's).
 *
 * Ported verbatim from f1-game js/data/real-race-tab.js:13-19 (messages) and
 * create(deps) :698-1158:
 *   cancel / releaseIncomplete :713-714   scriptFor   :718-729   raceSession :731-741
 *   loadRealRace               :743-755   renderBody  :757-786   simLaps     :788
 *   seatPicker                 :790-807   watchCameraPicker :809-819
 *   replayRow / updateReplayRow :821-877  loadTraces  :878-897   launchRace  :898-915
 *   watch                      :917-929   pitDuelCard :931-959   lapList     :961-1016
 *   boardRow                   :1018-1044 seatsFor    :1046-1051 paint       :1053-1144
 *   jumpIn                     :1146-1150 the returned API :1152-1157
 * DOM structure and class names are f1-game's. Globals become deps: F1API ->
 * deps.api, RealRace -> deps.port (else the registered port), Tracks.LIST ->
 * deps.tracks, Teams.LIST -> deps.teams, SeasonCal.REAL_2026 -> deps.calendar,
 * Log -> ../log.
 */
import type { F1Api, Key, Session } from "../api";
import type { HubDeps, MountedTab } from "../hub-deps";
import { log } from "../log";
import { LIST as TEAMS, type Team } from "../teams";
import type { CacheStorage } from "../transport";
import { DEFAULT_CALENDAR, circuitTracks, realRacePort, type LaunchOptions, type RealRacePort, type WatchCamera } from "./bridge";
import { createRealRaceCache, type RealRaceCache, type TraceIdbFactory } from "./cache";
import {
  DISTANCES, OPENF1, build, fmtGap, fmtLap, lapBoard, pitDuel, raceBook, traceDetails, traceFits,
  type CalendarWindow, type CumTableFn, type PitDuel, type RaceScript, type TrackInfo, type Traces,
} from "./script";

export const DATA_CREDIT = "Timing data: OpenF1 (CC BY-NC-SA 4.0) · pace, stops, flags and the grid are the real ones; the racing is yours.";
export const NO_TRACK_MSG = "This circuit is not in Apex 26 yet — pick another Grand Prix.";
export const NO_RACE_MSG = "No race timing published for this weekend yet.";
export const FETCH_FAIL_MSG = "Could not fetch the race timing — try again in a minute.";
export const INCOMPLETE_MSG = "Timing is still coming in for this race — it plays as far as the data goes.";
export const NO_SEAT_MSG = "no seat in this roster";

/** The WATCH and REAL RACE inputs: what f1-game read from globals. All optional. */
export interface RealRaceInputs {
  /** The REAL RACE director. undefined: the port registered with registerRealRacePort(); null: none. */
  port?: RealRacePort | null;
  /** The game's circuits (f1-game Tracks.LIST). Default: src/circuits CIRCUITS. */
  tracks?: readonly TrackInfo[] | (() => readonly TrackInfo[]);
  /** The roster mapField seats (f1-game Teams.LIST). Default: src/data/teams LIST. */
  teams?: readonly Team[] | (() => readonly Team[]);
  /** SeasonCal.REAL_2026. Default: DEFAULT_CALENDAR; null: no calendar. */
  calendar?: readonly CalendarWindow[] | null;
  /** The script/positions caches (default: built from api, localStorage, indexedDB). */
  cache?: RealRaceCache;
  storage?: CacheStorage | null;
  indexedDB?: TraceIdbFactory | null;
}

/** HubDeps (minus what this tab never reads) plus the inputs. A HubDeps is one. */
export type RealRaceTabDeps =
  Pick<HubDeps, "el" | "clear" | "emptyMsg" | "spinner" | "sel" | "ensureSession" | "buildPicker" | "teamChip" | "fmtDateTime" | "findTeam">
  & Partial<Pick<HubDeps, "invalidateOther" | "close" | "isOpen">>
  & { api: Pick<F1Api, "request" | "meetings" | "locationData" | "cancelAll" | "sessionsForMeeting" | "placeLabel"> & Partial<Pick<F1Api, "forget">> }
  & RealRaceInputs;

export interface RealRaceTab {
  loadRealRace(): Promise<HTMLElement>;
  cancel(): void;
  scriptFor(sessionKey: Key, fresh?: boolean, current?: () => boolean): Promise<RaceScript>;
  jumpIn(script: RaceScript, code: string | null): boolean;
  watch(script: RaceScript, slot: Node | null, fromLap: number, reel: boolean): boolean;
  loadTraces(script: RaceScript, slot: Node | null, then: ((tr: Traces) => unknown) | null, refresh?: boolean): boolean;
  traces(): Traces | null;
  positionsSettled(): Promise<unknown>;
  setTraces(tr: Traces | null | undefined): Traces | null;
  setDistance(f: number): number;
  setStartLap(n: number): number;
  setSeat(code: string | null | undefined): string | null;
  setWatchCamera(camera: WatchCamera): WatchCamera;
}

const msgOf = (e: unknown): unknown => (e instanceof Error && e.message ? e.message : e);

interface ReplayUi {
  script: RaceScript; slot: Node; state: HTMLElement; coverage: HTMLDetailsElement; coverageBody: HTMLElement;
  progress: HTMLProgressElement; load: HTMLButtonElement; highlights: HTMLButtonElement; full: HTMLButtonElement; cancel: HTMLButtonElement;
}

export function create(deps: RealRaceTabDeps): RealRaceTab {
  const { el, clear, emptyMsg, spinner, sel, ensureSession, buildPicker, invalidateOther, teamChip, fmtDateTime, findTeam, close, isOpen, api } = deps;
  const cache = deps.cache ?? createRealRaceCache({ api,
    ...(deps.storage !== undefined ? { storage: deps.storage } : {}),
    ...(deps.indexedDB !== undefined ? { indexedDB: deps.indexedDB } : {}) });
  const calendar = deps.calendar === undefined ? DEFAULT_CALENDAR : deps.calendar;
  const port = (): RealRacePort | null => (deps.port === undefined ? realRacePort() : deps.port);
  const cumTable = (): CumTableFn | null => { const p = port(); return p && p.cumTable ? (s) => p.cumTable!(s) : null; };
  let defaultTracks: readonly TrackInfo[] | null = null;
  function tracks(): readonly TrackInfo[] {
    const t = deps.tracks;
    if (typeof t === "function") return t();
    if (t) return t;
    return defaultTracks || (defaultTracks = circuitTracks());
  }
  function teams(): readonly Team[] { const t = deps.teams; return typeof t === "function" ? t() : t || TEAMS; }

  let bodyGen = 0;
  let distance = 1;   // the fraction of the real distance the player races (DISTANCES)
  let startLap = 1;   // the REAL lap the player drops into (1 = the grid)
  let lapSession: Key | null = null;   // the race startLap belongs to
  let watchCamera: WatchCamera = "auto";   // WATCH has its own shots (AUTO: the TV director, js/race/broadcast.js); driving preferences stay intact
  let seatCode: string | null = null;   // the DRIVE AS pick, a driver code (null: the first seated driver)
  let traces: Traces | null = null;     // the real positions for the painted script, once loaded
  let loading: { done: number; total: number; sessionKey: Key | null } | null = null;    // {done, total} while the positions load
  let requestGen = 0, replayUi: ReplayUi | null = null, traceError = "", partialTraces: Traces | null = null, traceWork: Promise<unknown> = Promise.resolve();
  let driveAction: HTMLButtonElement | null = null;
  // A download in flight leaves ~20 queued /location requests in the transport's
  // FIFO that every other tab would wait behind; drop them (showTab cancels this
  // tab BEFORE it starts the next tab's load).
  function cancel(): void { if (loading) api.cancelAll(); ++bodyGen; ++requestGen; loading = null; replayUi = null; driveAction = null; traceError = ""; releaseIncomplete(); }
  function releaseIncomplete(): void { partialTraces = null; if (traces && !traces.complete) traces = null; }

  /** The script for a session: the cache, else nine OpenF1 requests. */
  function scriptFor(sessionKey: Key, fresh?: boolean, current?: () => boolean): Promise<RaceScript> {
    const hit = !fresh && cache.cached(sessionKey);
    if (hit) return Promise.resolve({ ...hit, provenance: "cached" as const });
    return cache.fetchRaw(sessionKey, !!fresh).then((raw) => {
      if (current && !current()) throw new Error("cancelled");
      const script = build(raw, findTeam, tracks(), calendar);
      if (!script.drivers.length) throw new Error(NO_RACE_MSG);
      if (script.complete) cache.remember(script); else if (!fresh) cache.forgetRaw(sessionKey);
      return { ...script, provenance: "fetched" as const };
    });
  }

  /** The RACE (or the Sprint the picker chose) of the selected meeting. */
  function raceSession(meta: Session | null): Promise<Session | null> {
    const isRace = (m: Session | null): boolean => !!m && /^(race|sprint)$/i.test(String(m.name || "")) && /race/i.test(String(m.type || ""));
    if (isRace(meta)) return Promise.resolve(meta);
    const mk = meta && meta.meetingKey != null ? meta.meetingKey : sel.meetingKey;
    if (mk == null) return Promise.resolve(null);
    return api.sessionsForMeeting(mk).then((ss) => {
      const races = ss.filter(isRace);
      return races.find((m) => /^race$/i.test(String(m.name))) || races[0] || null;
    });
  }

  function loadRealRace(): Promise<HTMLElement> {
    cancel();
    const generation = bodyGen;
    return ensureSession(false).then(() => {
      const wrap = el("div");
      if (generation !== bodyGen) return wrap;
      wrap.appendChild(buildPicker((meta) => { renderBody(meta, body); if (invalidateOther) invalidateOther("race"); }));
      const body = el("div");
      wrap.appendChild(body);
      renderBody(sel.meta, body);
      return wrap;
    });
  }

  function renderBody(meta: Session | null, body: HTMLElement): void {
    ++requestGen;
    releaseIncomplete();
    loading = null; replayUi = null; driveAction = null; traceError = "";
    const myGen = ++bodyGen;
    clear(body);
    if (!meta || meta.sessionKey == null) { body.appendChild(emptyMsg(NO_RACE_MSG)); return; }
    const slot = el("div");
    slot.appendChild(spinner());
    body.appendChild(slot);
    raceSession(meta).then((race) => {
      if (myGen !== bodyGen) return;
      if (!race) { clear(slot); slot.appendChild(emptyMsg(NO_RACE_MSG)); return; }
      return scriptFor(race.sessionKey as Key).then((script) => {
        if (myGen !== bodyGen) return;
        clear(slot);
        if (!script.laps || !script.drivers.length) { slot.appendChild(emptyMsg(NO_RACE_MSG)); return; }
        paint(script, slot);
      });
    }).then(null, (e: unknown) => {
      if (myGen !== bodyGen) return;
      log.warn("real race script failed: " + String(msgOf(e)));
      clear(slot);
      const failure = emptyMsg(FETCH_FAIL_MSG);
      failure.setAttribute("role", "status");
      const retry = el("button", "dh-retry", "RETRY"); retry.type = "button";
      retry.addEventListener("click", () => renderBody(meta, body));
      slot.append(failure, retry);
    });
  }

  function simLaps(script: RaceScript): number { return Math.max(1, Math.round(script.laps * distance)); }

  /** DRIVE AS: the seat every JUMP IN uses — the drivers with a roster seat, in grid order. */
  function seatPicker(script: RaceScript, seats: Set<number> | null): HTMLElement {
    const field = el("label", "dh-pick-field");
    field.appendChild(el("span", "dh-pick-label", "DRIVER"));
    const pick = el("select", "dh-pick-select");
    pick.setAttribute("aria-label", "DRIVER");
    const seated = script.drivers.filter((d) => !seats || seats.has(d.num));
    if (!seated.some((d) => d.code === seatCode)) seatCode = seated.length ? seated[0]!.code : null;
    seated.forEach((d) => {
      const op = el("option", null, (d.grid != null ? "P" + d.grid + " · " : "") + d.code + " · " + d.name);
      op.value = d.code;
      if (d.code === seatCode) op.selected = true;
      pick.appendChild(op);
    });
    pick.addEventListener("change", () => { seatCode = pick.value || seatCode; if (driveAction) driveAction.textContent = "JUMP IN AS " + seatCode + " · L" + startLap; });
    field.appendChild(pick);
    return field;
  }

  function watchCameraPicker(): HTMLElement {
    const field = el("label", "dh-pick-field");
    field.appendChild(el("span", "dh-pick-label", "WATCH CAMERA"));
    const pick = el("select", "dh-pick-select");
    pick.setAttribute("aria-label", "WATCH CAMERA");
    for (const [value, label] of [["auto", "AUTO · TV DIRECTOR"], ["side", "TV TRACKSIDE"], ["heli", "AERIAL"], ["tcam", "T-CAM"], ["chase", "CHASE"]] as const) {
      const op = el("option", null, label); op.value = value; op.selected = value === watchCamera; pick.appendChild(op);
    }
    pick.addEventListener("change", () => { watchCamera = pick.value as WatchCamera; });
    field.appendChild(pick); return field;
  }

  /** REAL POSITIONS: load the field's real x/y (OpenF1 /location) once, then WATCH the
   *  whole race or its HIGHLIGHTS with the camera on the DRIVE AS pick — every car
   *  where it really was. Until they load, the WATCH buttons load them first. */
  function replayRow(script: RaceScript, slot: HTMLElement): HTMLElement {
    const row = el("div", "dh-rounds");
    const have = traceFits(traces, script);
    const p = port();
    const canReplay = !!script.t0 && !!p && !!p.replay;
    if (!canReplay) { row.appendChild(el("span", "dh-lr-meta", "Real positions need a script with timestamps — reopen the tab to refetch it.")); return row; }
    const state = el("span", "dh-lr-meta"); state.setAttribute("role", "status");
    row.appendChild(state);
    const coverage = el("details", "dh-lr-meta");
    coverage.appendChild(el("summary", null, "Downloaded feed coverage"));
    const coverageBody = el("div"); coverage.appendChild(coverageBody); row.appendChild(coverage);
    // A race loaded on an earlier visit is in IndexedDB: say so once it answers (a repaint, not a fetch).
    const progress = el("progress"); progress.max = script.drivers.length;
    progress.setAttribute("aria-label", "Download real car positions"); progress.hidden = true; row.appendChild(progress);
    const mk = (label: string, aria: string, fn: () => unknown): HTMLButtonElement => { const b = el("button", "dh-pill", label); b.type = "button"; b.setAttribute("aria-label", aria); b.addEventListener("click", fn); row.appendChild(b); return b; };
    const load = mk("LOAD POSITIONS", "LOAD POSITIONS — real positions of every car", () => loadTraces(script, slot, null, !!(traceFits(traces, script) && !(traces!.failed || []).length && traceDetails(script, traces).some((d) => d.gaps.length))));
    const highlights = mk("HIGHLIGHTS", "Watch the highlights of the race, recreated", () => watch(script, slot, 1, true));
    const full = mk("WATCH FROM L" + startLap, "Watch the race recreated from lap " + startLap, () => watch(script, slot, startLap, false));
    const cancelBtn = mk("CANCEL DOWNLOAD", "Cancel the real positions download", () => {
      requestGen++; loading = null; traceError = "Download cancelled. RETRY keeps the cars already loaded.";
      api.cancelAll(); updateReplayRow();
    });
    replayUi = { script, slot, state, coverage, coverageBody, progress, load, highlights, full, cancel: cancelBtn };
    updateReplayRow();
    const generation = requestGen;
    if (!have && !loading) cache.traceGet(script.sessionKey, script).then((hit) => {
      if (generation === requestGen && (!isOpen || isOpen()) && hit && replayUi && replayUi.slot === slot && replayUi.script.sessionKey === script.sessionKey && slot.isConnected !== false && !loading) { traces = hit; traceError = ""; updateReplayRow(); }
    });
    return row;
  }
  function updateReplayRow(): void {
    if (!replayUi) return;
    const u = replayUi, sk = u.script.sessionKey, tr = traceFits(traces, u.script) ? traces : null;
    const busy = loading && loading.sessionKey === sk, failed = tr && tr.failed ? tr.failed : [];
    u.coverage.hidden = !tr;
    clear(u.coverageBody);
    if (tr) {
      u.coverageBody.appendChild(el("p", null, "Times are seconds from lights out. Feed gaps or endings do not indicate a sporting retirement. Gaps over 3 seconds are listed."));
      traceDetails(u.script, tr).forEach((d) => {
        const seconds = (t: number): string => t.toFixed(1) + "s";
        const gaps = d.gaps.slice(0, 12).map((g) => seconds(g[0]) + "–" + seconds(g[1])).join(", ") + (d.gaps.length > 12 ? " (" + d.gaps.length + " gaps total)" : "");
        u.coverageBody.appendChild(el("div", null, d.code + ": " + (d.dns ? "DNS" : !d.count ? "missing feed" : d.count + " samples · " + seconds(d.start!) + "–" + seconds(d.end!)) +
          (d.retired ? " · classified retirement" : "") + (d.retry ? " · retry available" : "") + (gaps ? " · gaps " + gaps : "")));
      });
    }
    u.state.textContent = busy ? "LOADING REAL POSITIONS · " + loading!.done + " / " + loading!.total + " CARS"
      : traceError || (tr ? failed.length ? "PARTIAL POSITIONS · RETRY " + failed.map((n) => u.script.drivers.find((d) => d.num === n)?.code || n).join(", ") : "REAL POSITIONS READY · " + Object.keys(tr.cars).length + " CARS"
        : "REAL POSITIONS · ABOUT 60 MB ON FIRST LOAD · SAVED ON THIS DEVICE");
    u.progress.hidden = !busy; if (busy) u.progress.value = loading!.done;
    const gaps = tr && traceDetails(u.script, tr).some((d) => d.gaps.length);
    u.load.hidden = !!tr && !failed.length && !gaps; u.load.disabled = !!loading;
    u.load.textContent = tr && !failed.length && gaps ? "REFRESH POSITIONS · ABOUT 60 MB" : traceError || failed.length ? "RETRY POSITIONS" : "LOAD POSITIONS";
    u.load.setAttribute("aria-label", tr && !failed.length && gaps ? "Refresh all real positions, about 60 megabytes; the previous recording remains available if refresh fails" : u.load.textContent + " — real positions of every car");
    u.highlights.disabled = u.full.disabled = !!loading; u.cancel.hidden = !busy;
  }
  function loadTraces(script: RaceScript, slot: Node | null, then: ((tr: Traces) => unknown) | null, refresh = false): boolean {
    if (loading) return false;
    const mine = ++requestGen;
    const current = (): boolean => mine === requestGen && (!isOpen || isOpen()) && (!slot || slot.isConnected !== false);
    loading = { done: 0, total: script.drivers.length, sessionKey: script.sessionKey }; traceError = ""; updateReplayRow();
    traceWork = cache.fetchTraces(script, (done, total, tr) => {
      if (!current()) return;
      partialTraces = tr; loading = { done, total, sessionKey: script.sessionKey }; updateReplayRow();
    }, traceFits(traces, script) ? traces : partialTraces, { refresh })
      .then((tr) => {
        if (!current()) return;
        traces = tr; partialTraces = tr; loading = null; updateReplayRow();
        if (then) then(tr);
      }, (e: unknown) => {
        if (!current()) return;
        loading = null; traceError = "Could not load real positions. Check your connection and RETRY.";
        log.warn("real positions: " + String(msgOf(e))); updateReplayRow();
      });
    return true;
  }
  // launch() synchronously accepts a staged race or refuses it. Keep the Hub
  // and its downloaded positions until that handoff has actually succeeded.
  function launchRace(script: RaceScript, options: LaunchOptions): boolean {
    const generation = bodyGen, request = requestGen;
    const current = (): boolean => generation === bodyGen && request === requestGen && (!isOpen || isOpen());
    if (!current()) return false;
    let accepted = false;
    try { const p = port(); accepted = !!p && !!p.launch && !!p.launch(script, options); }
    catch (e) { log.warn("real race launch: " + String(msgOf(e))); }
    if (!current()) return false;
    if (!accepted) {
      traceError = "Could not start the race. Please try again."; updateReplayRow();
      return false;
    }
    traceError = "";
    if (close) close();
    return true;
  }

  /** WATCH / HIGHLIGHTS: the positions first (if not yet), then the replay in the DRIVE AS seat. */
  function watch(script: RaceScript, slot: Node | null, fromLap: number, reel: boolean): boolean {
    const myGen = bodyGen, seat = seatCode, camera = watchCamera;
    const go = (tr: Traces): boolean => {
      if (myGen !== bodyGen || (slot && slot.isConnected === false)) return false;
      if (isOpen && !isOpen()) return false;   // the positions landed after the hub closed (or a JUMP IN left it): nothing to watch from
      startLap = fromLap;
      log.info("real replay " + script.sessionKey + (reel ? " highlights" : " from " + fromLap) + " follow=" + seat);
      return launchRace(script, { seat, laps: script.laps, startLap: fromLap, watch: true, camera, reel: !!reel, traces: tr, intro: true });   // intro: the pre-race card and announcer (js/race/real-race.js launch)
    };
    if (traceFits(traces, script)) return go(traces!);
    return loadTraces(script, slot, go);
  }

  function pitDuelCard(script: RaceScript, slot: HTMLElement): HTMLElement {
    const card = el("section", "dh-livecard");
    card.appendChild(el("h3", "dh-section", "PIT-STOP DUEL"));
    card.appendChild(el("p", "dh-live-sub", "Observed net gap change across two stops. A negative change means the first driver gained time; this does not isolate the cause."));
    const fields = el("div", "dh-pick-fields"), picks: HTMLSelectElement[] = [];
    ["First driver and stop", "Second driver and stop"].forEach((label, i) => {
      const field = el("label", "dh-pick-field"); field.appendChild(el("span", "dh-pick-label", label));
      const pick = el("select", "dh-pick-select"); pick.setAttribute("aria-label", label);
      const blank = el("option", null, "Choose a stop"); blank.value = ""; pick.appendChild(blank);
      script.drivers.forEach((d) => (d.pits || []).forEach((lap) => {
        const option = el("option", null, d.code + " · L" + lap); option.value = d.num + ":" + lap; pick.appendChild(option);
      }));
      field.appendChild(pick); fields.appendChild(field); picks[i] = pick;
    });
    card.appendChild(fields);
    const result = el("p", "dh-lr-meta"); result.setAttribute("role", "status"); card.appendChild(result);
    const action = el("button", "dh-pill", "WATCH STOP DUEL"); action.type = "button"; card.appendChild(action);
    let comparison: PitDuel | null = null;
    const refresh = (): void => {
      const a = picks[0]!.value.split(":"), b = picks[1]!.value.split(":");
      const c = pitDuel(script, a[0], a[1], b[0], b[1]); comparison = c; action.disabled = !c.available;
      const signed = (v: number): string => (v >= 0 ? "+" : "") + v.toFixed(3) + "s";
      result.textContent = c.available ? "Observed net gap change: " + signed(c.change) + " · L" + c.before + " " + signed(c.gapBefore) + " → L" + c.after + " " + signed(c.gapAfter) +
        " · compounds " + c.compounds.join(" / ") + " · " + (c.caution ? "caution overlap" : "no recorded caution overlap") + " · " + (c.rain === null ? "rain data unavailable" : c.rain ? "rain overlap" : "no recorded rain overlap") : c.reason;
    };
    picks.forEach((pick) => pick.addEventListener("change", refresh));
    action.addEventListener("click", () => { const c = comparison; if (c && c.available) { const number = Number(picks[0]!.value.split(":")[0]); seatCode = script.drivers.find((d) => d.num === number)!.code; watch(script, slot, c.startLap, false); } });
    refresh(); return card;
  }

  /** The race lap by lap: one row per lap with what it held and a JUMP IN; a
   *  click on the lap opens its classification (gaps, intervals, lap times, sets). */
  function lapList(script: RaceScript): HTMLElement {
    const book = raceBook(script, cumTable());
    const wrap = el("div");
    wrap.appendChild(el("div", "dh-lr-name", "LAP BY LAP"));
    wrap.appendChild(el("div", "dh-lr-meta", "Every pass, stop, flag and retirement as it happened. Open a lap for the order and the gaps; JUMP IN drops you into the race as it stood at the start of that lap. JUMP IN and WATCH run at dawn, unless the race ran at night."));
    const table = el("table", "dh-table");
    const thead = el("thead"), hr = el("tr");
    ["LAP", "LEADER", "WHAT HAPPENED", "FASTEST", ""].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr); table.appendChild(thead);
    const tbody = el("tbody");
    const p = port();
    book.forEach((b) => {
      const tr = el("tr");
      tr.appendChild(el("td", null, "L" + b.lap));
      tr.appendChild(el("td", null, b.leader || "—"));
      const bits: string[] = [];
      if (b.flag) bits.push(b.flag);
      if (b.rain) bits.push("RAIN");
      b.passes.forEach((ps) => bits.push(ps.by + " passed " + ps.over + (ps.pos ? " for P" + ps.pos : "")));
      if (b.pits.length) bits.push("pit: " + b.pits.join(", "));
      b.out.forEach((c) => bits.push(c + " OUT"));
      tr.appendChild(el("td", null, bits.length ? bits.join(" · ") : (b.lap === 1 ? "lights out" : "")));
      tr.appendChild(el("td", null, b.fastest ? b.fastest.code + " " + fmtLap(b.fastest.t) : "—"));
      const cell = el("td");
      const go = el("button", "dh-pill", b.lap === 1 ? "START" : "JUMP IN");
      go.type = "button";
      go.setAttribute("aria-label", (b.lap === 1 ? "START" : "JUMP IN") + " at lap " + b.lap);
      go.addEventListener("click", (e) => { e.stopPropagation(); startLap = b.lap; jumpIn(script, seatCode); });
      cell.appendChild(go);
      if (script.t0 && p && p.replay) {
        const w = el("button", "dh-pill", "WATCH");
        w.type = "button";
        w.setAttribute("aria-label", "Watch the race recreated from lap " + b.lap);
        w.addEventListener("click", (e) => { e.stopPropagation(); watch(script, tbody.parentNode && tbody.parentNode.parentNode, b.lap, false); });
        cell.appendChild(w);
      }
      tr.appendChild(cell);
      tr.setAttribute("role", "button");
      tr.tabIndex = 0;
      tr.setAttribute("aria-expanded", "false");
      let open: HTMLTableRowElement | null = null;
      const toggle = (): void => {
        if (open) { open.hidden = !open.hidden; tr.setAttribute("aria-expanded", open.hidden ? "false" : "true"); return; }
        open = boardRow(script, b.lap);
        tr.setAttribute("aria-expanded", "true");
        if (tr.nextSibling) tbody.insertBefore(open, tr.nextSibling); else tbody.appendChild(open);
      };
      tr.addEventListener("click", toggle);
      tr.addEventListener("keydown", (e) => { if (e.target === tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); } });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  /** The classification at the end of a lap, as one full-width row of the lap list. */
  function boardRow(script: RaceScript, lap: number): HTMLTableRowElement {
    const tr = el("tr", "dh-lap-board");
    const td = el("td");
    td.colSpan = 5;
    const table = el("table", "dh-table");
    const thead = el("thead"), hr = el("tr");
    ["POS", "DRIVER", "GAP", "INT", "LAP", "TYRE", ""].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr); table.appendChild(thead);
    const tbody = el("tbody");
    lapBoard(script, lap, cumTable()).forEach((r) => {
      const row = el("tr");
      if (r.pos <= 3 && !r.out) row.className = r.pos === 1 ? "dh-lr-p1" : r.pos === 2 ? "dh-lr-p2" : "dh-lr-p3";
      row.appendChild(el("td", null, r.out ? "OUT" : "P" + r.pos));
      row.appendChild(el("td", null, r.code));
      row.appendChild(el("td", null, r.out ? "L" + r.done : r.down ? "+" + r.down + (r.down > 1 ? " LAPS" : " LAP") : (r.gapApproximate ? "≈" : "") + fmtGap(r.gap)));
      row.appendChild(el("td", null, r.out ? "" : (r.intervalApproximate ? "≈" : "") + fmtGap(r.interval)));
      row.appendChild(el("td", null, fmtLap(r.t)));
      row.appendChild(el("td", null, r.tyre || "—"));
      row.appendChild(el("td", null, r.pitIn ? "IN" : r.pitOut ? "OUT LAP" : ""));
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    td.appendChild(table);
    tr.appendChild(td);
    return tr;
  }

  /** The roster seats this script's drivers take (RealRace.mapField), or null before the game is up. */
  function seatsFor(script: RaceScript): Set<number> | null {
    const p = port();
    if (!p || !p.mapField) return null;
    const nums = new Set(p.mapField(script, teams()).map((s) => s.num));
    return nums;
  }

  function paint(script: RaceScript, slot: HTMLElement): void {
    const head = el("div");
    head.appendChild(el("div", "dh-lr-name", (script.year ? script.year + " " : "") + script.name + (script.session !== "Race" ? " · " + script.session : "")));
    const meta = api.placeLabel
      ? api.placeLabel(script.circuit, script.country)
      : [script.circuit, script.country].filter(Boolean).join(", ");
    const winner = script.drivers.find((d) => d.pos === 1);
    head.appendChild(el("div", "dh-lr-meta", [meta, script.dateStart ? fmtDateTime(script.dateStart) : "", script.laps + " laps",
      winner ? "won by " + winner.name : "", script.cautions.filter((c) => c.level < 4).length + " safety car / VSC", script.weather.toUpperCase()].filter(Boolean).join(" · ")));
    slot.appendChild(head);
    const playable = !!script.trackId && tracks().some((t) => t.id === script.trackId);
    if (!playable) { slot.appendChild(emptyMsg(NO_TRACK_MSG)); return; }
    if (!script.complete) slot.appendChild(el("div", "dh-lr-meta", INCOMPLETE_MSG));
    if (startLap > script.laps || lapSession !== script.sessionKey) startLap = 1;   // a new race starts from its grid, not the last race's lap
    lapSession = script.sessionKey;
    const seats = seatsFor(script);

    const watchCard = el("section", "dh-livecard");
    watchCard.appendChild(el("h3", "dh-section", "WATCH THE REAL RACE"));
    watchCard.appendChild(el("p", "dh-live-sub", "Follow any driver with the TV director, or choose your own camera. Highlights takes you straight to the race's key moments."));
    const pickRow = el("div", "dh-pick-fields");
    pickRow.appendChild(seatPicker(script, seats)); pickRow.appendChild(watchCameraPicker());
    watchCard.appendChild(pickRow); watchCard.appendChild(replayRow(script, slot)); slot.appendChild(watchCard);
    slot.appendChild(pitDuelCard(script, slot));

    const driveCard = el("section", "dh-livecard");
    driveCard.appendChild(el("h3", "dh-section", "DRIVE THIS RACE"));
    driveCard.appendChild(el("p", "dh-live-sub", "Take the selected driver's seat. Choose your distance; real stops and flags stay in proportion. Open RACE STORY below to start from a particular lap."));
    // Distance controls belong to driving; WATCH always uses the real race clock.
    const pills = el("div", "dh-rounds");
    DISTANCES.forEach((f) => {
      const n = Math.max(1, Math.round(script.laps * f));
      const b = el("button", "dh-pill" + (f === distance ? " active" : ""), f === 1 ? n + " LAPS (FULL)" : n + " LAPS");
      b.type = "button";
      b.setAttribute("aria-pressed", f === distance ? "true" : "false");
      b.addEventListener("click", () => { if (f !== distance) { distance = f; clear(slot); paint(script, slot); } });
      pills.appendChild(b);
    });
    driveCard.appendChild(pills);
    const action = el("button", "dh-livebtn", "JUMP IN AS " + (seatCode || "—") + " · L" + startLap);
    driveAction = action;
    action.type = "button"; action.disabled = !seatCode;
    action.addEventListener("click", () => jumpIn(script, seatCode)); driveCard.appendChild(action); slot.appendChild(driveCard);
    const story = el("details"); story.appendChild(el("summary", "adv-more-btn", "RACE STORY · EVERY LAP, PASS & PIT STOP"));
    story.appendChild(lapList(script)); slot.appendChild(story);

    const entry = el("details"); entry.appendChild(el("summary", "adv-more-btn", "ENTRY LIST · GRID, TYRES & RESULTS"));
    const table = el("table", "dh-table");
    const thead = el("thead"), hr = el("tr");
    ["GRID", "DRIVER", "TEAM", "TYRES", "RESULT", ""].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr); table.appendChild(thead);
    const tbody = el("tbody");
    script.drivers.forEach((d) => {
      const tr = el("tr");
      tr.appendChild(el("td", null, d.grid != null ? "P" + d.grid : "—"));
      const who = el("td");
      who.appendChild(teamChip(d.code, d.team));
      who.appendChild(el("span", null, " " + d.name));
      tr.appendChild(who);
      tr.appendChild(el("td", null, d.team));
      tr.appendChild(el("td", null, d.stints.map((s) => (s.c[0] || "?") + (s.to - s.from + 1)).join(" ") || "—"));
      tr.appendChild(el("td", null, d.dsq ? "DSQ" : d.dns ? "DNS" : d.dnf ? "DNF L" + d.lapsDone : d.pos != null ? "P" + d.pos : "—"));
      const cell = el("td");
      const seated = !seats || seats.has(d.num);
      const go = el("button", "dh-pill", seated ? "JUMP IN" : NO_SEAT_MSG);
      go.type = "button";
      go.disabled = !seated;
      go.setAttribute("aria-label", seated ? "JUMP IN — race as " + d.name : d.name + ": " + NO_SEAT_MSG);
      if (seated) go.addEventListener("click", () => { seatCode = d.code; jumpIn(script, d.code); });
      cell.appendChild(go);
      tr.appendChild(cell);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    entry.appendChild(table); slot.appendChild(entry);
    const source = el("details", "dh-footnote");
    source.appendChild(el("summary", null, "Data source and freshness"));
    source.appendChild(el("p", null, DATA_CREDIT));
    source.appendChild(el("p", null, "Session " + script.sessionKey + " · " + (script.provenance === "cached" ? "Cached timing" : "Loaded OpenF1 timing") + " · assembled " + (script.fetchedAt && Number.isFinite(Date.parse(script.fetchedAt)) ? new Date(script.fetchedAt).toLocaleString() : "time unavailable for older cache") + ". ≈ gaps include reconstructed untimed laps; these are estimates, not official timing. Normal loads may reuse cached API responses; Refresh requests uncached responses."));
    const link = el("a", null, "OpenF1 session source");
    link.href = OPENF1 + "/sessions?session_key=" + encodeURIComponent(String(script.sessionKey)); link.target = "_blank"; link.rel = "noopener noreferrer"; source.appendChild(link);
    const licence = el("a", null, "CC BY-NC-SA 4.0 licence"); licence.href = "https://creativecommons.org/licenses/by-nc-sa/4.0/"; licence.target = "_blank"; licence.rel = "noopener noreferrer"; source.appendChild(licence);
    const refresh = el("button", "dh-pill", "REFRESH THIS SESSION"); refresh.type = "button";
    const status = el("p", null, ""); status.setAttribute("role", "status");
    refresh.onclick = () => {
      const generation = bodyGen; refresh.disabled = true; status.textContent = "Refreshing timing…";
      scriptFor(script.sessionKey as Key, true, () => generation === bodyGen && slot.isConnected !== false && (!isOpen || isOpen())).then((next) => {
        if (generation !== bodyGen || slot.isConnected === false || (isOpen && !isOpen())) return;
        traces = null; slot.textContent = ""; paint(next, slot);
      }, () => { if (generation === bodyGen && slot.isConnected !== false) { refresh.disabled = false; status.textContent = "Refresh failed. The previous replay is still available."; } });
    };
    source.appendChild(refresh); source.appendChild(status); slot.appendChild(source);
  }

  function jumpIn(script: RaceScript, code: string | null): boolean {
    log.info("real race jump in " + script.sessionKey + " as " + code + " laps=" + simLaps(script) + " from=" + startLap);
    const tr = traceFits(traces, script) ? traces : null;
    return launchRace(script, { seat: code, laps: simLaps(script), startLap, traces: tr, intro: true });   // intro: the pre-race card and announcer, as RACE! has
  }

  return { loadRealRace, scriptFor, jumpIn, watch, loadTraces, cancel,
           traces: () => traces, positionsSettled: () => traceWork, setTraces: (tr) => { traces = tr || null; return traces; },
           setDistance: (f) => { distance = DISTANCES.includes(f) ? f : 1; return distance; },
           setStartLap: (n) => { startLap = Math.max(1, n | 0); return startLap; },
           setSeat: (code) => { seatCode = code || null; return seatCode; },
           setWatchCamera: (camera) => { watchCamera = camera; return watchCamera; } };
}

/**
 * Mount the tab standalone (apex-26 seam; the Hub drives create() itself, the
 * way f1-game's hub.js loadTab does: spinner, swap, error block). A refresh or
 * unmount bumps `gen` so a load still in flight never paints over a newer one.
 */
export function mount(host: HTMLElement, deps: RealRaceTabDeps): MountedTab {
  const tab = create(deps);
  let gen = 0;
  function refresh(): Promise<void> {
    const myGen = ++gen;
    deps.clear(host);
    host.appendChild(deps.spinner());
    return tab.loadRealRace().then((node) => {
      if (myGen !== gen) return;
      deps.clear(host);
      host.appendChild(node);
    }, (err: unknown) => {
      if (myGen !== gen) return;
      log.warn("tab race fail", err);
      deps.clear(host);
      host.appendChild(deps.emptyMsg(FETCH_FAIL_MSG));
    });
  }
  return { refresh, unmount() { ++gen; tab.cancel(); deps.clear(host); } };
}
