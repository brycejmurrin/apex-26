/**
 * DataHub: the F1 data overlay. Tabs: SCHEDULE | STANDINGS | RESULTS | LIVE |
 * TELEMETRY | WATCH & DRIVE | EXPORT. Ported from f1-game js/data/hub.js:1-789.
 * All API-derived DOM is built with createElement/textContent, never innerHTML.
 *
 * Changes from f1-game: the hub is a factory (`createDataHub`) instead of a
 * global, the tab modules are injected (`tabs`) so each is a separate module
 * with its own `mount(el, deps)`, and the f1-game-specific screen ids it
 * checked before opening (BLOCKING_SEL, the help doors) are options the shell
 * lane passes in.
 */
import { f1Api, type F1Api, type Meeting, type Session } from "./api";
import { clear, compoundLetter, el } from "./dom";
import type { HubDeps, HubSelection, TabNode, TabOutcome } from "./hub-deps";
import { log } from "./log";
import "../styles";   // fixes the @layer order before hub.css joins `overlays`
import "./hub.css";
import { LIST, type Rgb, type Team } from "./teams";

export const NO_LIVE_MSG = "No live data — sessions appear here during race weekends " +
  "(free data is delayed until ~30 min after each session).";
export const NO_TELEM_MSG = "No telemetry available yet. The latest completed F1 session " +
  "(2023+) appears here once its data is published (~30–60 min after the session).";
export const NO_RESULT_MSG = "No classification for this session yet — results are published " +
  "shortly after the chequered flag. Pick another session above.";

const MINUTE = 60 * 1000;
// re-fetch a tab if its rendered content is older than this when shown again
const MAX_AGE: Readonly<Record<string, number>> = { schedule: 6 * 60 * MINUTE, standings: 60 * MINUTE, results: 60 * MINUTE, live: 5 * MINUTE, telemetry: 15 * MINUTE, race: 60 * MINUTE, export: 24 * 60 * MINUTE };

// tyre compound colors
export const COMPOUND: Readonly<Record<string, string>> = Object.freeze({
  SOFT: "#e8002d", MEDIUM: "#f6d200", HARD: "#f0f0f0",
  INTERMEDIATE: "#3fb950", WET: "#1e90ff",
});

export type TabId = "schedule" | "standings" | "results" | "live" | "telemetry" | "race" | "export";
type Loader = () => Promise<TabNode>;

/** The tab modules' create() results the hub drives (hub.js:526-667). */
export interface HubTabs {
  schedule(deps: HubDeps): { loadSchedule: Loader };
  standings(deps: HubDeps): { loadStandings: Loader };
  results(deps: HubDeps): { loadResults: Loader };
  live(deps: HubDeps): { loadLive: Loader; stopLiveAuto(): void; disarmLiveAuto(): void };
  telemetry(deps: HubDeps): { loadTelemetry: Loader; closeTelemPopup(leaving?: boolean): boolean };
  race?(deps: HubDeps): { loadRealRace: Loader; cancel(): void };
  export(deps: HubDeps): { loadExport: Loader };
}

export interface DataHubOptions {
  tabs: HubTabs;
  api?: F1Api;
  /** A screen that owns the top layer; the hub will not open over it (hub.js:59-73). */
  blockingLayer?: () => Element | null;
  /** Ids whose click closes the hub first (hub.js:75-81: #mb-help, #pm-howto). */
  helpDoorIds?: readonly string[];
  /** Read live: COLOURBLIND CUES on (f1-game A11yOpts.cuesOn). TODO(lane-shell): wire to settings. */
  cuesOn?: () => boolean;
}

export interface DataHub {
  init(rootEl: HTMLElement): void;
  open(want?: TabId): void;
  close(): void;
  isOpen(): boolean;
  compoundChipLabel(compound: string | null | undefined): string;
  readonly COMPOUND: Readonly<Record<string, string>>;
  /** The deps object the hub hands its tabs (for a tab mounted outside the hub). */
  readonly deps: HubDeps;
}

interface TabState {
  node: TabNode | null;
  at: number;
  dataAt?: number | null;
  offlineCopy?: boolean;
  status: "ready" | "empty" | "failed" | "loading";
  error: unknown;
  hasData?: boolean;
}

// THE OS flag OR SETTINGS › ACCESSIBILITY › REDUCE MOTION (html[data-motion]),
// both read live (hub.js:12-18).
export function motionReduced(): boolean {
  const mq = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  return !!(mq && mq.matches) || (typeof document !== "undefined" && !!document.documentElement &&
    !!document.documentElement.dataset && document.documentElement.dataset.motion === "reduce");
}

// The API names teams by sponsor; the hub matches by `short` (hub.js:99-127).
const TEAM_KEYS: readonly [string, string][] = [
  ["racing bulls", "RB"], ["rb f1", "RB"], ["visa", "RB"],
  ["red bull", "RBR"],
  ["mercedes", "MER"],
  ["ferrari", "FER"],
  ["mclaren", "MCL"],
  ["alpine", "ALP"],
  ["haas", "HAA"],
  ["williams", "WIL"],
  ["audi", "AUD"], ["sauber", "AUD"],
  ["aston", "AMR"],
  ["cadillac", "CAD"],
];

export function findTeam(apiName: string | null | undefined): Team | null {
  if (!apiName) return null;
  const n = String(apiName).toLowerCase();
  for (const [needle, short] of TEAM_KEYS) {
    if (n.indexOf(needle) !== -1) {
      for (const t of LIST) {
        if (t.short === short) return t;
      }
    }
  }
  return null;
}

export function cssColor(c: Rgb | null | undefined): string {
  if (!c) return "rgb(128,128,128)"; // fallback grey
  return "rgb(" + Math.round(c[0] * 255) + "," + Math.round(c[1] * 255) + "," + Math.round(c[2] * 255) + ")";
}

export function textColorOn(c: Rgb | null | undefined): string {
  if (!c) return "#fff";
  const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return lum > 0.55 ? "#0a0a0f" : "#fff";
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const OPENF1_FIRST_YEAR = 2023;
// Per call, not at boot: a tab left open across New Year must roll over (hub.js:410-418).
export function apiYears(): number[] {
  const now = new Date().getFullYear();
  const out: number[] = [];
  for (let y = Math.max(now, OPENF1_FIRST_YEAR); y >= OPENF1_FIRST_YEAR; y--) out.push(y);
  return out;
}

// OpenF1 reuses meeting_name for testing + calendar weekends (two "Pre-Season
// Testing", two "Bahrain Grand Prix"). Append circuit when it is not already in
// the name; when that still collides, append YYYY-MM-DD (hub.js:567-580).
export function meetingPickerOptions(ms: readonly Meeting[]): { value: Meeting["meetingKey"]; label: string }[] {
  const base = ms.map((m) => {
    let label = m.name || m.circuit || "Round";
    if (m.circuit && label.indexOf(m.circuit) < 0) label += " · " + m.circuit;
    return label;
  });
  const counts = new Map<string, number>();
  for (const b of base) counts.set(b, (counts.get(b) || 0) + 1);
  return ms.map((m, i) => {
    let label = base[i] as string;
    if ((counts.get(label) || 0) > 1 && m.dateStart) {
      label += " · " + String(m.dateStart).slice(0, 10);
    }
    return { value: m.meetingKey, label };
  });
}

export function createDataHub(opts: DataHubOptions): DataHub {
  const api = opts.api ?? f1Api();
  const helpDoorIds = opts.helpDoorIds ?? ["mb-help", "pm-howto"];

  const TABS: { id: TabId; label: string; developer?: boolean; load: Loader }[] = [
    { id: "schedule", label: "SCHEDULE", load: () => loadSchedule() },
    { id: "standings", label: "STANDINGS", load: () => loadStandings() },
    { id: "results", label: "RESULTS", load: () => loadResults() },
    { id: "live", label: "LIVE", load: () => loadLive() },
    { id: "telemetry", label: "TELEMETRY", load: () => loadTelemetry() },
    ...(opts.tabs.race ? [{ id: "race" as const, label: "WATCH & DRIVE", load: () => loadRealRace() }] : []),
    { id: "export", label: "GPS TRACE EXPORT", developer: true, load: () => loadExport() },
  ];

  let root: HTMLElement | null = null;
  let contentEl: HTMLElement | null = null;
  const tabButtons: Partial<Record<TabId, HTMLButtonElement>> = {};
  let openFlag = false;
  let active: TabId = "schedule";
  let returnFocus: Element | null = null;
  let developerTools: HTMLDetailsElement | null = null;
  const state: Partial<Record<TabId, TabState | null>> = {};
  const gen: Partial<Record<TabId, number>> = {};
  const bump = (id: TabId): void => { gen[id] = (gen[id] || 0) + 1; };
  const bumpAll = (): void => { for (const k of Object.keys(gen) as TabId[]) bump(k); };

  function fromHelpDoor(t: EventTarget | null): boolean {
    let n = t as Node | null;
    while (n && n !== document) {
      if (n instanceof Element && helpDoorIds.indexOf(n.id) !== -1) return true;
      n = n.parentNode;
    }
    return false;
  }

  function compoundChipLabel(compound: string | null | undefined): string {
    if (opts.cuesOn && opts.cuesOn()) {
      const L = compoundLetter(compound);
      if (L) return L;
    }
    return (compound || "—").slice(0, 4);
  }

  function teamChip(code: string | null | undefined, teamName: string | null | undefined): HTMLElement {
    const t = findTeam(teamName);
    const chip = el("span", "dh-codechip", code || "—");
    const col = t ? t.color : null;
    chip.style.background = cssColor(col);
    chip.style.color = textColorOn(col);
    return chip;
  }

  function init(rootEl: HTMLElement): void {
    if (root || !rootEl) return;
    root = rootEl;
    root.classList.add("dh-overlay");
    root.setAttribute("aria-labelledby", "dh-title");

    const card = el("div", "dh-card fit-managed");
    const header = el("div", "sheet-head");
    const title = el("h2", "", "F1 DATA HUB");
    title.id = "dh-title";
    header.appendChild(title);
    // The dialog's data-esc-close target: adopt the shell's, or build one.
    let closeBtn = document.getElementById("dh-close-btn");
    if (!closeBtn) {
      const b = el("button", "dh-close", "✕");
      b.type = "button";
      b.id = "dh-close-btn";
      b.setAttribute("aria-label", "Close data hub");
      closeBtn = b;
    }
    closeBtn.hidden = false;
    closeBtn.addEventListener("click", close);
    header.appendChild(closeBtn);
    card.appendChild(header);

    const tabs = el("div", "dh-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Data hub sections");
    developerTools = el("details", "dh-developer-tools");
    developerTools.appendChild(el("summary", "", "Developer tools"));
    for (const t of TABS) {
      const b = el("button", "dh-tab", t.label);
      b.type = "button";
      b.id = "dh-tab-" + t.id;
      if (!t.developer) b.setAttribute("role", "tab");
      b.setAttribute("aria-controls", "dh-panel");
      if (!t.developer) b.setAttribute("aria-selected", "false");
      b.tabIndex = t.developer ? 0 : -1;
      b.addEventListener("click", () => showTab(t.id));
      tabButtons[t.id] = b;
      (t.developer ? developerTools : tabs).appendChild(b);
    }
    card.appendChild(tabs);
    card.appendChild(developerTools);

    const content = el("div", "dh-content");
    contentEl = content;
    content.id = "dh-panel";
    content.setAttribute("role", "tabpanel");
    // Native title tooltips do not dismiss on scroll: drop them on the scroller.
    content.addEventListener("scroll", () => {
      const titled = content.querySelectorAll("[title]");
      for (const t of titled) t.removeAttribute("title");
    }, { passive: true });
    card.appendChild(content);
    root.appendChild(card);

    // Capture, not bubble: the help doors unhide How to Play in their own handlers.
    document.addEventListener("click", (ev) => {
      if (openFlag && fromHelpDoor(ev.target)) close();
    }, true);

    // Roving-tablist arrows only; Escape and Tab containment are the dialog's.
    document.addEventListener("keydown", (ev) => {
      if (!openFlag) return;
      const target = ev.target;
      if (target instanceof Element && target.getAttribute("role") === "tab") {
        const ids = TABS.filter((t) => !t.developer).map((t) => t.id);
        let idx = ids.indexOf(active);
        if (ev.key === "ArrowRight") idx = (idx + 1) % ids.length;
        else if (ev.key === "ArrowLeft") idx = (idx + ids.length - 1) % ids.length;
        else if (ev.key === "Home") idx = 0;
        else if (ev.key === "End") idx = ids.length - 1;
        else idx = -1;
        const next = ids[idx];
        if (next) {
          ev.preventDefault();
          showTab(next);
          tabButtons[next]?.focus();
        }
      }
    });
  }

  function open(want?: TabId): void {
    if (!root) return;
    const block = opts.blockingLayer ? opts.blockingLayer() : null;
    if (block) {
      log.info("hub open skipped — #" + (block.id || "?") + " is up");
      return;
    }
    if (want && TABS.some((t) => t.id === want)) active = want;
    // Already open: switch tab only (a second open would overwrite returnFocus).
    if (openFlag) { showTab(active); return; }
    returnFocus = document.activeElement;
    log.info("hub open");
    root.hidden = false;
    openFlag = true;
    showTab(active);
    // After the showModal seam, not synchronously (hub.js:153-160).
    queueMicrotask(() => {
      if (openFlag) tabButtons[active]?.focus();
    });
  }

  function close(): void {
    if (!root) return;
    cancelRealRace();
    log.info("hub close");
    disarmLiveAuto();
    closeTelemPopup();
    // Nothing still loading is wanted: bump every generation, then drop the
    // requests themselves so a reopen does not queue behind them (hub.js:170-178).
    bumpAll();
    api.cancelAll();
    // Every picker-driven tab: cancelAll() left "error" in their selects.
    state.live = null;
    state.telemetry = null;
    state.results = null;
    state.race = null;
    // A reopen is a fresh intent: a FAILED tab must try again (hub.js:186-195).
    for (const id of Object.keys(state) as TabId[]) {
      const st = state[id];
      if (!st || st.status !== "failed") continue;
      state[id] = st.node ? { node: st.node, at: st.at, dataAt: st.dataAt ?? null, offlineCopy: !!st.offlineCopy, status: "ready", error: null } : null;
    }
    root.hidden = true;
    openFlag = false;
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
    returnFocus = null;
  }

  function isOpen(): boolean { return openFlag; }

  function tabDef(id: TabId): (typeof TABS)[number] {
    return TABS.find((t) => t.id === id) ?? (TABS[0] as (typeof TABS)[number]);
  }

  function showTab(id: TabId): void {
    if (id !== "race") {
      cancelRealRace();
      // Cancellation invalidates the WATCH controller behind this DOM.
      state.race = null; bump("race");
    }
    // Leaving TELEMETRY mid-COMPARE aborts its fetches; the tab is rebuilt on return.
    if (closeTelemPopup(id !== active)) {
      bumpAll();
      state.telemetry = null;
    }
    if (id !== "live") stopLiveAuto();
    active = id;
    for (const k of Object.keys(tabButtons) as TabId[]) {
      const b = tabButtons[k] as HTMLButtonElement;
      b.classList.toggle("active", k === id);
      if (k !== "export") {
        b.setAttribute("aria-selected", k === id ? "true" : "false");
        b.tabIndex = k === id || (id === "export" && k === "schedule") ? 0 : -1;
      }
    }
    if (developerTools && id === "export") developerTools.open = true;
    if (contentEl) contentEl.setAttribute("role", id === "export" ? "region" : "tabpanel");
    const activeBtn = tabButtons[id];
    if (contentEl && activeBtn) contentEl.setAttribute("aria-labelledby", activeBtn.id);
    // Scroll the active tab into view only when the strip overflows and the
    // button is clipped (hub.js:234-247).
    const strip = activeBtn && activeBtn.parentElement;
    const overflow = !!(strip && (strip.scrollWidth - strip.clientWidth > 1));
    if (overflow && activeBtn && strip && activeBtn.scrollIntoView) {
      const left = activeBtn.offsetLeft || 0;
      const right = left + (activeBtn.offsetWidth || 0);
      const viewL = strip.scrollLeft || 0;
      const viewR = viewL + strip.clientWidth;
      if (left < viewL || right > viewR) {
        activeBtn.scrollIntoView({ inline: "nearest", behavior: motionReduced() ? "auto" : "smooth", block: "nearest" });
      }
    }
    if (!contentEl) return;
    contentEl.classList.toggle("dh-has-split", id === "live" || id === "telemetry");
    const st = state[id];
    const maxAge = MAX_AGE[id] || 60 * MINUTE;
    if (st && st.status === "failed") {
      clear(contentEl);
      contentEl.appendChild(errorBlock(id, st.error, !!st.node && st.hasData !== false));
      if (st.node) {
        contentEl.appendChild(st.node);
        if (st.hasData !== false) contentEl.appendChild(footnote(st.dataAt || st.at, !!st.offlineCopy));
      }
      contentEl.scrollTop = 0;
      return;
    }
    // A node may say when it goes stale on its own (Schedule: the NEXT race ends).
    const flipAt = st && st.node ? (st.node as TabNode & { nextFlipAt?: number }).nextFlipAt : undefined;
    if (st && st.node && (Date.now() - st.at) < maxAge && !(flipAt !== undefined && Date.now() >= flipAt)) {
      if (Date.now() - st.at > 1000) log.info("tab " + id + " cached");
      clear(contentEl);
      contentEl.appendChild(st.node);
      if (st.status !== "loading") contentEl.appendChild(footnote(st.dataAt || st.at, !!st.offlineCopy));
      contentEl.scrollTop = 0;
      return;
    }
    loadTab(id);
  }

  function loadTab(id: TabId): void {
    const host = contentEl;
    if (!host) return;
    const myGen = (gen[id] = (gen[id] || 0) + 1);
    lastEmpty = "";
    log.info("tab " + id + " load");
    clear(host);
    host.appendChild(spinner());
    const staleMark = api.staleMark();

    tabDef(id).load().then((node) => {
      if (gen[id] !== myGen) return;
      log.info("tab " + id + " done");
      // A refetch that fell back to the stored copy: the footnote dates the copy.
      const staleAt = api.staleSince(staleMark);
      const outcome: TabOutcome = node.tabOutcome || {};
      state[id] = {
        node,
        at: Date.now(),
        dataAt: staleAt,
        offlineCopy: staleAt != null,
        // Empty is a successful API answer and gets the normal freshness window.
        status: node.querySelector && node.querySelector(".dh-empty") ? "empty" : "ready",
        error: null,
        ...outcome,
      };
      if (openFlag && active === id) showTab(id);
    }, (err: unknown) => {
      if (gen[id] !== myGen) return;
      log.warn("tab " + id + " fail");
      // KEEP the stale node: a schedule from an hour ago is still the schedule.
      const st = state[id];
      state[id] = st && st.node
        ? { node: st.node, at: st.at, dataAt: st.dataAt ?? null, offlineCopy: !!st.offlineCopy, status: "failed", error: err }
        : { node: null, at: 0, status: "failed", error: err };
      if (openFlag && active === id) {
        clear(host);
        host.appendChild(errorBlock(id, err, !!(st && st.node)));
        if (st && st.node) {
          host.appendChild(st.node);
          host.appendChild(footnote(st.dataAt || st.at, !!st.offlineCopy));
        }
      }
    });
  }

  // role=status: the load / error state is announced to a screen reader.
  function spinner(): HTMLElement {
    const w = el("div", "dh-loading");
    w.setAttribute("role", "status");
    w.appendChild(el("div", "dh-spinner"));
    w.appendChild(el("div", "dh-loading-text", "LOADING"));
    return w;
  }

  // OFFLINE (no network) vs UPSTREAM (service busy) vs a live-session lockout (hub.js:343-384).
  function errorBlock(id: TabId, err: unknown, hasStale: boolean): HTMLElement {
    const w = el("div", "dh-error");
    w.setAttribute("role", "status");
    const offline = navigator.onLine === false;
    let reason = offline ? "offline" : "upstream";
    let title = offline ? "OFFLINE" : "SERVICE UNAVAILABLE";
    let msg = offline
      ? "No network on this device. Open Data Hub once while online to keep a copy of schedule and standings for later."
      : "Couldn't reach the F1 data service. It may be busy or blocked — try again in a moment.";
    if (hasStale) {
      title = offline ? "OFFLINE · CACHED" : "REFRESH FAILED · CACHED";
      msg = offline
        ? "You're offline. Showing the last data loaded on this device."
        : "Couldn't refresh from the F1 data service. Showing the last data you loaded.";
      reason = offline ? "offline-cached" : "upstream-cached";
    }
    if (err instanceof Error && err.message && err.message.indexOf("Live F1 session") !== -1) {
      title = "LIVE SESSION";
      msg = err.message;
      reason = "live-auth";
    }
    w.dataset.reason = reason;
    const titleEl = el("div", "dh-error-msg", title);
    titleEl.dataset.role = "title";
    w.appendChild(titleEl);
    w.appendChild(el("div", "dh-error-msg", msg));
    if (!hasStale && offline) {
      const hint = el("div", "dh-error-msg",
        "Tip: schedule, standings and results keep an API cache after a successful fetch — retry after you reconnect.");
      hint.dataset.role = "hint";
      w.appendChild(hint);
    }
    const retry = el("button", "dh-retry", "RETRY");
    retry.type = "button";
    retry.addEventListener("click", () => loadTab(id));
    w.appendChild(retry);
    return w;
  }

  function footnote(at: number, offlineCopy: boolean): HTMLElement {
    const mins = Math.floor((Date.now() - at) / MINUTE);
    let txt: string;
    if (mins < 1) txt = "updated just now";
    else if (mins < 60) txt = "updated " + mins + "m ago";
    else txt = "updated " + Math.floor(mins / 60) + "h " + (mins % 60) + "m ago";
    if (offlineCopy || navigator.onLine === false) txt += " · offline copy";
    return el("div", "dh-footnote", txt);
  }

  let lastEmpty = "";
  function emptyMsg(text: string): HTMLElement {
    if (lastEmpty !== active) {
      lastEmpty = active;
      log.info("tab " + active + " empty");
    }
    return el("div", "dh-empty", text);
  }

  const sel: HubSelection = { year: null, meetingKey: null, sessionKey: null, meta: null, selAt: 0, pinned: false };
  let selectionGen = 0;           // explicit picker intent, shared across tab instances
  const SESSION_STALE_MS = 120 * 1000;

  function ensureSession(force?: boolean): Promise<Session | null> {
    const have = sel.sessionKey !== null;
    const fresh = have && sel.selAt && (Date.now() - sel.selAt) < SESSION_STALE_MS;
    // A pin is an explicit user pick: it outranks force (hub.js:426-431).
    if (sel.pinned) return Promise.resolve(sel.meta);
    if (have && !force && fresh) return Promise.resolve(sel.meta);
    const mySelection = selectionGen;
    return api.latestSession(0).then((ses) => {
      // A YEAR/GP change is explicit intent even while its own request has not pinned a session yet.
      if (mySelection !== selectionGen || sel.pinned) return sel.meta;
      if (ses && ses.sessionKey != null) {
        sel.meta = ses;
        sel.sessionKey = ses.sessionKey;
        sel.meetingKey = ses.meetingKey;
        sel.year = ses.year || (apiYears()[0] as number);
        sel.selAt = Date.now();
      } else if (!sel.pinned) {
        sel.meta = null;
        sel.sessionKey = null;
        sel.meetingKey = null;
        sel.selAt = 0;
        // Off-season / empty latest: keep RESULTS' year pills usable.
        if (sel.year == null) sel.year = apiYears()[0] as number;
      }
      return sel.meta;
    });
  }

  // Force the sibling session-tab to re-render for a newly picked session.
  function invalidateOther(except: string): void {
    for (const id of ["live", "telemetry", "results"] as const) {
      if (id !== except) { state[id] = null; bump(id); }
    }
  }

  function setSelectOptions(selectEl: HTMLSelectElement, options: { value: unknown; label: string }[], selectedVal: unknown): void {
    clear(selectEl);
    let title = "";
    for (const o of options) {
      const op = el("option", null, o.label);
      op.value = String(o.value);
      if (String(o.value) === String(selectedVal)) { op.selected = true; title = o.label; }
      selectEl.appendChild(op);
    }
    if (title) selectEl.title = title; else selectEl.removeAttribute("title");
  }

  // onChange (optional) runs synchronously when the player starts a YEAR or
  // GRAND PRIX change, BEFORE the picker queues its own request (hub.js:476-479).
  function buildPicker(onPick: (meta: Session | null) => void, onChange?: () => void): HTMLElement {
    let pickerGen = 0;
    const initialSessionKey = sel.sessionKey;
    const box = el("div", "dh-picker");
    const yearRow = el("div", "dh-pick-years");
    for (const y of apiYears()) {
      const b = el("button", "dh-pill" + (y === sel.year ? " active" : ""), String(y));
      b.type = "button";
      b.addEventListener("click", () => {
        if (y === sel.year) return;
        ++selectionGen;
        cancelRealRace();
        if (onChange) onChange();
        sel.year = y; sel.meetingKey = null; sel.sessionKey = null; sel.pinned = false;
        for (const c of yearRow.children) c.classList.toggle("active", c === b);
        loadGPs(true);
      });
      yearRow.appendChild(b);
    }
    box.appendChild(yearRow);

    const fieldsRow = el("div", "dh-pick-fields");
    const gpField = el("label", "dh-pick-field");
    gpField.appendChild(el("span", "dh-pick-label", "GRAND PRIX"));
    const gpSel = el("select", "dh-pick-select");
    gpField.appendChild(gpSel);
    fieldsRow.appendChild(gpField);
    const sesField = el("label", "dh-pick-field");
    sesField.appendChild(el("span", "dh-pick-label", "SESSION"));
    const sesSel = el("select", "dh-pick-select");
    sesField.appendChild(sesSel);
    fieldsRow.appendChild(sesField);
    box.appendChild(fieldsRow);

    let sesIndex = new Map<string, Session>();
    const ph = (s: HTMLSelectElement, t: string): void => setSelectOptions(s, [{ value: "", label: t }], "");
    // An explicit empty year/meeting is still the player's selection.
    function emptySelection(userChanged: boolean): void {
      if (!userChanged) return;
      sel.meta = null; sel.sessionKey = null; sel.selAt = 0;
      sel.pinned = true;
      if (openFlag && box.isConnected !== false) onPick(null);
    }
    // A pick answered after the player left this tab must not call onPick
    // (hub.js:548-559); drop the session tabs' cached nodes instead.
    function detached(userChanged: boolean): boolean {
      if (!userChanged || box.isConnected !== false) return false;
      invalidateOther(active);
      return true;
    }

    gpSel.addEventListener("change", () => {
      ++selectionGen;
      cancelRealRace();
      if (onChange) onChange();
      sel.meetingKey = gpSel.value ? Number(gpSel.value) : null;
      sel.sessionKey = null;
      sel.pinned = false;
      loadSessions(true);
    });
    sesSel.addEventListener("change", () => {
      if (!sesSel.value) return;
      const m = sesIndex.get(sesSel.value);
      if (!m) return;
      ++selectionGen;
      cancelRealRace();
      sel.sessionKey = m.sessionKey; sel.meta = m; sel.pinned = true;
      onPick(m);
    });

    function loadGPs(userChanged: boolean): void {
      const myGen = ++pickerGen, mySelection = selectionGen;
      ph(gpSel, "loading…"); ph(sesSel, "—");
      api.meetings(sel.year).then((ms) => {
        if (myGen !== pickerGen || mySelection !== selectionGen) return;
        if (!ms.length) emptySelection(userChanged);
        if (detached(userChanged)) return;
        if (!ms.length) { ph(gpSel, "no data"); return; }
        // The LATEST MEETING THAT HAS STARTED, not the year's last entry.
        if (sel.meetingKey === null) {
          const now = Date.now(), started = ms.filter((m) => { const t = Date.parse(m.dateStart as string); return !(t > now); });
          sel.meetingKey = ((started.length ? started[started.length - 1] : ms[0]) as Meeting).meetingKey;
        }
        setSelectOptions(gpSel, meetingPickerOptions(ms), sel.meetingKey);
        loadSessions(userChanged);
      }, () => {
        if (myGen !== pickerGen || mySelection !== selectionGen) return;
        ph(gpSel, "error");
      });
    }

    function loadSessions(userChanged: boolean): void {
      const myGen = ++pickerGen, mySelection = selectionGen;
      ph(sesSel, "loading…");
      if (sel.meetingKey === null) { ph(sesSel, "no data"); return; }
      api.sessionsForMeeting(sel.meetingKey).then((ss) => {
        if (myGen !== pickerGen || mySelection !== selectionGen) return;
        if (!ss.length) emptySelection(userChanged);
        if (detached(userChanged)) return;
        sesIndex = new Map(ss.map((s) => [String(s.sessionKey), s]));
        if (!ss.length) { ph(sesSel, "no data"); return; }
        if (sel.sessionKey === null) {
          const race = ss.filter((s) => (s.type || "").toLowerCase() === "race");
          const def = (race.length ? race[race.length - 1] : ss[ss.length - 1]) as Session;
          sel.sessionKey = def.sessionKey; sel.meta = def;
        }
        setSelectOptions(sesSel, ss.map((s) => ({ value: s.sessionKey, label: s.name || s.type || "Session" })), sel.sessionKey);
        if (userChanged) sel.pinned = true;
        // Another tab's detached picker may have filled shared metadata first.
        if (userChanged || (initialSessionKey === null && openFlag && box.isConnected !== false)) onPick(sel.meta);
      }, () => {
        if (myGen !== pickerGen || mySelection !== selectionGen) return;
        ph(sesSel, "error");
      });
    }

    loadGPs(false);   // reflect current selection without firing onPick
    return box;
  }

  const deps: HubDeps = {
    api, el, clear, emptyMsg, spinner, fmtDateTime, sel, ensureSession, buildPicker,
    invalidateOther, findTeam, cssColor, textColorOn, teamChip, compoundChipLabel, COMPOUND,
    close, isOpen, motionReduced, NO_LIVE_MSG, NO_TELEM_MSG, NO_RESULT_MSG,
    onOutcome(node) {
      const st = state.results;
      if (!st || st.node !== node) return;   // detached/closed/replaced picker
      Object.assign(st, node.tabOutcome);
      if (openFlag && active === "results") showTab("results");
    },
  };

  const { loadSchedule } = opts.tabs.schedule(deps);
  const { loadStandings } = opts.tabs.standings(deps);
  const { loadResults } = opts.tabs.results(deps);
  const { loadLive, stopLiveAuto, disarmLiveAuto } = opts.tabs.live(deps);
  const { loadTelemetry, closeTelemPopup } = opts.tabs.telemetry(deps);
  const race = opts.tabs.race ? opts.tabs.race(deps) : null;
  const loadRealRace: Loader = race ? race.loadRealRace : () => Promise.resolve(emptyMsg("WATCH & DRIVE is not available."));
  const cancelRealRace = (): void => { if (race) race.cancel(); };
  const { loadExport } = opts.tabs.export(deps);

  return { init, open, close, isOpen, compoundChipLabel, COMPOUND, deps };
}
