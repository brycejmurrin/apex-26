/**
 * The Data Hub's SCHEDULE tab: the season calendar and the NEXT GP tile.
 * Ported from f1-game js/data/schedule.js:1-267 (helpers :10-102, create
 * :104-263). F1API.schedule() is reached through `deps.api`. Additions over
 * f1-game: `mount()` (the MountedTab seam) and `dispose()` on create()'s
 * return, which stops the countdown timers and observers a node left running.
 */
import type { ScheduleSessionKey, SessionTime } from "../api";
import type { HubDeps, MountedTab } from "../hub-deps";
import { log } from "../log";

/** A calendar entry as far as the time helpers read it (api.ts ScheduleRace or a bare {date, time}). */
export interface Timed { date?: string | null; time?: string | null }
export interface RaceLike extends Timed { sessions?: Partial<Record<ScheduleSessionKey, SessionTime>> }

/* ONE INSTANT, ONE ZONE. A row shows a date and a start time; with the time
   on the viewer's local clock and the date formatted in UTC, a Las Vegas GP
   (2026-11-22 04:00Z) reads "22 Nov · 20:00 PST", a day adrift. When the
   entry has a time, both come from the same instant in the viewer's zone. A
   DATE-ONLY entry is a calendar day, not an instant: it stays in UTC, or
   UTC+13/+14 (NZ summer, Kiribati) shows every race a day late. */
export function raceInstant(r: Timed | null | undefined): number {
  if (!r || !r.date || !r.time) return NaN;
  return Date.parse(`${r.date}T${r.time}`);
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const dateOnly = iso.length === 10;
  const d = new Date(dateOnly ? iso + "T12:00:00Z" : iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, dateOnly ? { day: "numeric", month: "short", timeZone: "UTC" }
                                                  : { day: "numeric", month: "short" });
}

export function dateLabel(r: Timed | null | undefined): string {
  const at = raceInstant(r);
  return fmtDate(Number.isFinite(at) ? new Date(at).toISOString() : r && r.date);
}

// NEXT is the first race that has not finished. With a start instant that is
// decided against the clock (a race stays NEXT for RACE_MS after lights out,
// i.e. while it is running); a date-only entry falls back to the UTC day.
const RACE_MS = 2 * 3600 * 1000;
export function isUpcoming(r: Timed | null | undefined, now: number): boolean {
  if (!r || !r.date) return false;
  const at = raceInstant(r);
  if (Number.isFinite(at)) return at + RACE_MS > now;
  return r.date >= new Date(now).toISOString().slice(0, 10);
}

export function nextRace<T extends Timed>(items: readonly T[] | null | undefined, now: number): T | null {
  for (const r of items || []) if (isUpcoming(r, now)) return r;
  return null;
}

const SESSION_META: Readonly<Record<ScheduleSessionKey, readonly [string, number]>> = Object.freeze({
  fp1: ["FP1", 60], fp2: ["FP2", 60], fp3: ["FP3", 60],
  sq: ["SQ", 45], s: ["S", 30], q: ["Q", 60], r: ["R", 120],
});
const SESSION_ORDER: readonly ScheduleSessionKey[] = ["fp1", "fp2", "fp3", "sq", "s", "q", "r"];

export interface WeekendSession {
  key: ScheduleSessionKey;
  label: string;
  startMs: number;
  endMs: number;
  /** End is the start plus a nominal length, not a published time. */
  est: true;
}

export function weekendSessions(race: RaceLike | null | undefined): WeekendSession[] {
  if (!race) return [];
  const source = race.sessions || {};
  const out: WeekendSession[] = [];
  for (const key of SESSION_ORDER) {
    const session = source[key] || (key === "r" ? race : null);
    const startMs = raceInstant(session);
    if (!Number.isFinite(startMs)) continue;
    out.push({
      key,
      label: SESSION_META[key][0],
      startMs,
      endMs: startMs + SESSION_META[key][1] * 60 * 1000,
      est: true,
    });
  }
  return out.sort(function (a, b) { return a.startMs - b.startMs; });
}

export function countdown(ms: number): string {
  if (!(ms > 0)) return "STARTED";
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const secs = seconds % 60;
  if (days) return days + "d " + String(hours).padStart(2, "0") + "h " + String(minutes).padStart(2, "0") + "m";
  if (hours) return hours + "h " + String(minutes).padStart(2, "0") + "m " + String(secs).padStart(2, "0") + "s";
  return minutes + "m " + String(secs).padStart(2, "0") + "s";
}

// When the current NEXT stops being upcoming: a reused Schedule node must be
// rebuilt then, or the chip sits on a finished race for the node's MAX_AGE.
export function nextFlipAt(items: readonly Timed[] | null | undefined, now: number): number {
  const r = nextRace(items, now);
  if (r) {
    const at = raceInstant(r);
    return Number.isFinite(at) ? at + RACE_MS : Date.parse(r.date + "T00:00:00Z") + 24 * 3600 * 1000;
  }
  return Infinity;
}

function bindOverflowTitle(node: HTMLElement | null | undefined, text: string): void {
  if (!node || !node.addEventListener) return;
  node.addEventListener("mouseenter", function () {
    if (typeof matchMedia === "function" && matchMedia("(hover: none)").matches) return;
    if (node.scrollWidth > node.clientWidth + 1) node.title = text;
    else if (node.removeAttribute) node.removeAttribute("title");
  });
  node.addEventListener("mouseleave", function () {
    if (node.removeAttribute) node.removeAttribute("title");
  });
}

/** The tab body; hub.ts rebuilds a reused node once `nextFlipAt` has passed (hub.js:386). */
export type ScheduleNode = HTMLElement & { nextFlipAt?: number };

export type ScheduleDeps = Pick<HubDeps, "api" | "el" | "emptyMsg">;

export interface ScheduleTab {
  loadSchedule(): Promise<ScheduleNode>;
  /** Stop every countdown timer / observer this create() started (apex-26 addition). */
  dispose(): void;
}

export function create({ api, el, emptyMsg }: ScheduleDeps): ScheduleTab {
  const disposers = new Set<() => void>();

  function sessionTime(startMs: number): string {
    return new Date(startMs).toLocaleString(undefined, {
      weekday: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    });
  }

  function keepCountdownAlive(wrap: HTMLElement, tile: HTMLElement, clock: HTMLElement, targetMs: number): void {
    let timer: ReturnType<typeof setInterval> | null = null, shownMinute: number | null = null, labelledMinute: number | null = null;
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

    function tick(): void {
      const left = targetMs - Date.now();
      const minute = Math.floor(Math.max(0, left) / 60000);
      if (!reduced || minute !== shownMinute) {
        clock.textContent = countdown(left);
        shownMinute = minute;
      }
      if (minute !== labelledMinute) {
        clock.setAttribute("aria-label", left > 0 ? "Race starts in " + countdown(left) : "Race started");
        labelledMinute = minute;
      }
    }
    function visible(): boolean {
      if (!wrap.isConnected) return false;
      for (let n: HTMLElement | null = wrap; n; n = n.parentElement) if (n.hidden) return false;
      return true;
    }
    function stopTimer(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
    function sync(): void {
      if (visible()) {
        if (timer === null) {
          tick();
          timer = setInterval(tick, 1000);
        }
      } else stopTimer();
      // A newer schedule tile means this cached node was replaced, not merely
      // hidden while another tab is open; its observer can retire too.
      if (!wrap.isConnected && typeof document !== "undefined") {
        const current = document.querySelector("[data-nextgp=tile]");
        if (current && current !== tile) stop();
      }
    }

    clock.setAttribute("aria-live", "off");
    clock.setAttribute("role", "timer");
    tick();
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    const observer = new MutationObserver(sync);
    function stop(): void {
      observer.disconnect();
      stopTimer();
      disposers.delete(stop);
    }
    disposers.add(stop);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["hidden"], childList: true, subtree: true });
    queueMicrotask(sync);
  }

  function nextTile(race: ScheduleRaceView, wrap: HTMLElement): HTMLElement {
    const tile = el("section");
    tile.setAttribute("data-nextgp", "tile");
    const kicker = el("div", null, "NEXT GP");
    kicker.setAttribute("data-nextgp", "kicker");
    tile.appendChild(kicker);
    const name = el("h3", null, race.name || "Grand Prix");
    name.setAttribute("data-nextgp", "name");
    tile.appendChild(name);
    const place = [race.circuit, [race.locality, race.country].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
    if (place) {
      const venue = el("div", null, place);
      venue.setAttribute("data-nextgp", "place");
      tile.appendChild(venue);
    }

    const at = raceInstant(race);
    const clock = el("div", null, Number.isFinite(at) ? countdown(at - Date.now()) : "TIME TBC");
    clock.setAttribute("data-nextgp", "countdown");
    tile.appendChild(clock);
    if (Number.isFinite(at)) keepCountdownAlive(wrap, tile, clock, at);

    const sessions = weekendSessions(race);
    if (sessions.length) {
      const list = el("div");
      list.setAttribute("data-nextgp", "sessions");
      for (const session of sessions) {
        const row = el("div");
        row.setAttribute("data-nextgp", "session");
        const label = el("span", null, session.label);
        label.setAttribute("data-nextgp", "session-label");
        row.appendChild(label);
        const time = el("time", null, sessionTime(session.startMs));
        time.setAttribute("data-nextgp", "session-time");
        row.appendChild(time);
        list.appendChild(row);
      }
      tile.appendChild(list);
    }
    return tile;
  }

  function raceRow(r: ScheduleRaceView, isNext: boolean): HTMLElement {
    const row = el("div", "dh-race");
    if (isNext) row.classList.add("dh-race-next");
    row.appendChild(el("div", "dh-race-round", r.round != null ? `R${r.round}` : "—"));

    const main = el("div", "dh-race-main");
    const nameLine = el("div", "dh-race-name");
    nameLine.appendChild(el("span", null, r.name || "Grand Prix"));
    if (r.hasSprint) {
      const sprint = el("span", "dh-chip-sprint", "S");
      sprint.title = "Sprint weekend";
      nameLine.appendChild(sprint);
    }
    if (isNext) nameLine.appendChild(el("span", "dh-chip-next", "NEXT"));
    main.appendChild(nameLine);

    const subParts: string[] = [];
    if (r.circuit) subParts.push(r.circuit);
    const place = [r.locality, r.country].filter(Boolean).join(", ");
    if (place) subParts.push(place);
    const subText = subParts.join(" · ") || "—";
    const subEl = el("div", "dh-race-sub", subText);
    // Native `title` stays painted after the row scrolls away (R1 tip over
    // R2). Attach only while the line is actually ellipsized.
    bindOverflowTitle(subEl, subText);
    main.appendChild(subEl);
    if (r.time) {
      const t = new Date(Number.isFinite(raceInstant(r)) ? raceInstant(r) : `1970-01-01T${r.time}`);
      if (!isNaN(t.getTime())) {
        main.appendChild(el("div", "dh-race-time", t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })));
      }
    }
    row.appendChild(main);

    row.appendChild(el("div", "dh-race-date", dateLabel(r)));
    return row;
  }

  function loadSchedule(): Promise<ScheduleNode> {
    return api.schedule().then((items) => {
      const wrap: ScheduleNode = el("div", "dh-tabbody");
      if (!items || !items.length) {
        wrap.appendChild(emptyMsg("No calendar data available yet."));
        return wrap;
      }
      const now = Date.now();
      const next = nextRace(items, now);
      let nextMarked = false;
      if (next) wrap.appendChild(nextTile(next, wrap));
      wrap.appendChild(el("h3", "dh-section", `${new Date().getFullYear()} CALENDAR`));
      const grid = el("div", "dh-race-grid");
      for (const r of items) {
        const isNext = !nextMarked && isUpcoming(r, now);
        if (isNext) nextMarked = true;
        grid.appendChild(raceRow(r, isNext));
      }
      wrap.appendChild(grid);
      wrap.nextFlipAt = nextFlipAt(items, now);   // hub.ts rebuilds a reused node after this
      return wrap;
    });
  }

  function dispose(): void {
    for (const stop of [...disposers]) stop();
  }

  return { loadSchedule, dispose };
}

/** What the rows read off api.ts's ScheduleRace (kept structural so tests can pass partial races). */
export interface ScheduleRaceView extends RaceLike {
  round?: number | null; name?: string | null; circuit?: string | null;
  locality?: string | null; country?: string | null; hasSprint?: boolean;
}

/** Mount SCHEDULE into `host`: spinner, load, then the node (or an error block). */
export function mount(host: HTMLElement, deps: ScheduleDeps & Pick<HubDeps, "clear" | "spinner">): MountedTab {
  const tab = create(deps);
  return mountTab("schedule", host, deps, () => {
    tab.dispose();
    return tab.loadSchedule();
  }, () => tab.dispose());
}

// MOUNT SEAM (apex-26): hub.js's loadTab (hub.js:404-445) owns spinner, swap
// and error block; a standalone mount needs the same three steps. A refresh or
// unmount bumps `gen` so a load still in flight never paints over a newer one.
function mountTab(name: string, host: HTMLElement, deps: Pick<HubDeps, "el" | "clear" | "spinner">,
                  load: () => Promise<HTMLElement>, onUnmount: () => void): MountedTab {
  let gen = 0;
  function refresh(): Promise<void> {
    const myGen = ++gen;
    deps.clear(host);
    host.appendChild(deps.spinner());
    return load().then((node) => {
      if (myGen !== gen) return;
      deps.clear(host);
      host.appendChild(node);
    }, (err: unknown) => {
      if (myGen !== gen) return;
      log.warn("tab " + name + " fail", err);
      deps.clear(host);
      host.appendChild(errorNode(deps.el, () => { void refresh(); }));
    });
  }
  void refresh();
  return {
    refresh,
    unmount() {
      gen++;
      onUnmount();
      deps.clear(host);
    },
  };
}

// The UPSTREAM case of hub.js's errorBlock (hub.js:462-503), same classes.
function errorNode(el: HubDeps["el"], retryFn: () => void): HTMLElement {
  const w = el("div", "dh-error");
  w.setAttribute("role", "status");
  w.dataset.reason = "upstream";
  const titleEl = el("div", "dh-error-msg", "SERVICE UNAVAILABLE");
  titleEl.dataset.role = "title";
  w.appendChild(titleEl);
  w.appendChild(el("div", "dh-error-msg", "Couldn't reach the F1 data service. It may be busy or blocked — try again in a moment."));
  const retry = el("button", "dh-retry", "RETRY");
  retry.type = "button";
  retry.addEventListener("click", retryFn);
  w.appendChild(retry);
  return w;
}
