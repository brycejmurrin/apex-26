/**
 * The Data Hub's LIVE tab: polls OpenF1 for the running session's
 * positions/gaps/weather. mergePositionBatch/mergeIntervalBatch fold a delta
 * batch onto per-driver state so a live/liveIntervals cursor never replays.
 *
 * Ported from f1-game js/data/live.js:1-433 (helpers :7-52, create :54-424,
 * exports :425-433). `mount` is new: it stands in for hub.js's loadTab
 * (js/data/hub.js:407-446) and its tab-switch/close calls to
 * stopLiveAuto/disarmLiveAuto (hub.js:287, :340).
 *
 * Changes from f1-game:
 * - F1API (global) → deps.api; Log → ./log (unused here, as in f1-game).
 * - The cache sweep in lastFetchedAt reads the transport's `a26.api.` prefix
 *   (AGENTS.md: f1-game owns `apex26.` on the same origin).
 * - The `F1API.livePositions ? … : F1API.positions(…)` feature tests are gone:
 *   the typed F1Api always has the delta endpoints.
 * - The dh-live-sentinel custom element is defined once per document, so it
 *   calls a per-instance callback stored on the element instead of closing
 *   over the first create()'s resumeLiveAuto.
 */
import { CACHE_PREFIX } from "../transport";
import type { Delta, Gap, Key, PositionValue, Session, SessionDriver, Weather } from "../api";
import type { HubDeps, MountedTab } from "../hub-deps";
import { driverColor } from "../tab-utils";
import { log } from "../log";

export type LivePosition = PositionValue & { timeDiff?: Gap };

export interface LiveState {
  positionCursor: string | null;
  intervalCursor: string | null;
  positions: Map<number, LivePosition>;
  intervals: Record<string, Gap>;
}

/** A /position answer: a delta batch from livePositions or a plain snapshot. */
export type PositionBatch = Delta<LivePosition[] | null> | LivePosition[] | null | undefined;
/** An /intervals answer: a delta batch from liveIntervals or a plain gap map. */
export type IntervalBatch = Delta<Record<string, Gap> | null> | Record<string, Gap> | null | undefined;

export function newLiveState(): LiveState {
  return { positionCursor: null, intervalCursor: null, positions: new Map(), intervals: Object.create(null) as Record<string, Gap> };
}

// live.js:7-14
export function mergePositionBatch(state: Pick<LiveState, "positions" | "positionCursor">, batch: PositionBatch): LivePosition[] {
  const values = batch && (!Array.isArray(batch) && Array.isArray(batch.values) ? batch.values : (Array.isArray(batch) ? batch : []));
  (values || []).forEach((p) => { if (p && p.num != null) state.positions.set(p.num, p); });
  const cursor = batch && !Array.isArray(batch) ? batch.cursor : null;
  if (cursor && (!state.positionCursor || cursor > state.positionCursor)) {
    state.positionCursor = cursor;
  }
  return Array.from(state.positions.values()).sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99));
}

// live.js:16-36
export function mergeIntervalBatch(state: Pick<LiveState, "intervals" | "intervalCursor">, batch: IntervalBatch): Record<string, Gap> {
  if (batch) {
    const b = batch as Record<string, unknown>;
    // `values: null` is typeof "object" is false, so the old ternary fell
    // through to the whole batch and wrote keys "values"/"cursor" into gaps.
    let values: Record<string, unknown>;
    if (b.values != null && typeof b.values === "object" && !Array.isArray(b.values)) {
      values = b.values as Record<string, unknown>;
    } else if (!Object.prototype.hasOwnProperty.call(b, "values") && typeof b === "object") {
      values = b;
    } else {
      values = {};
    }
    Object.keys(values).forEach((k) => {
      if (k === "cursor" || k === "values") return;
      state.intervals[k] = values[k] as Gap;
    });
    const cursor = b.cursor;
    if (typeof cursor === "string" && cursor && (!state.intervalCursor || cursor > state.intervalCursor)) {
      state.intervalCursor = cursor;
    }
  }
  return state.intervals;
}

export type SessionPhase = "LIVE" | "UPCOMING" | "COMPLETED";
type SessionTiming = { dateStart?: string | null; type?: string | null } | null | undefined;

// live.js:38-46
export function sessionStatus(meta: SessionTiming, now?: number | null): SessionPhase {
  const start = Date.parse((meta && meta.dateStart) || "");
  if (!isFinite(start)) return "LIVE";
  const at = now == null ? Date.now() : now;
  if (start > at) return "UPCOMING";
  const type = String((meta && meta.type) || "").toLowerCase();
  const liveHours = type === "race" ? 4 : 2;
  return at - start <= liveHours * 60 * 60 * 1000 ? "LIVE" : "COMPLETED";
}

// live.js:48-52
export function sessionTimeLabel(meta: SessionTiming, phase: SessionPhase, fmtDateTime: (iso: string) => string): string {
  if (!meta || !meta.dateStart) return "";
  const verb = phase === "UPCOMING" ? "Starts " : "Started ";
  return verb + fmtDateTime(meta.dateStart);
}

export type LiveDeps = Pick<HubDeps,
  "api" | "el" | "clear" | "emptyMsg" | "spinner" | "ensureSession" | "sel" | "buildPicker" |
  "invalidateOther" | "fmtDateTime" | "findTeam" | "cssColor" | "textColorOn" | "NO_LIVE_MSG">;

export interface LiveTab {
  loadLive(): Promise<HTMLElement>;
  stopLiveAuto(): void;
  disarmLiveAuto(): void;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
type SortKey = "pos" | "team";

const SENTINEL = "dh-live-sentinel";
type SentinelEl = HTMLElement & { onConnect?: () => void };

function errorInfo(error: unknown): { status: unknown; message: string } {
  const err = (error && typeof error === "object" ? error : {}) as { status?: unknown; message?: unknown };
  return { status: err.status, message: typeof err.message === "string" ? err.message : "" };
}

// live.js:54-424
export function create({
  api, el, clear, emptyMsg, spinner, ensureSession, sel, buildPicker,
  invalidateOther, fmtDateTime, findTeam, cssColor, textColorOn, NO_LIVE_MSG,
}: LiveDeps): LiveTab {
  const LIVE_REFRESH = 30 * 1000;
  let liveTimer: ReturnType<typeof setTimeout> | null = null;
  let liveRefreshGen = 0;
  const liveOpts: { auto: boolean; sort: SortKey } = { auto: false, sort: "pos" };
  let armAuto: (() => void) | null = null;

  function stopLiveAuto(): void {
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
  }

  // Hub close: an in-flight refresh's settlement arm re-schedules through
  // armAuto, and on CLOSE (unlike a tab switch) the live DOM stays attached
  // under the hidden root — so every guard passed and the 30 s OpenF1 loop
  // ran forever. Nulling armAuto fails the identity check in both the
  // settlement arm and the timer; reopening re-arms via renderLiveBody.
  function disarmLiveAuto(): void {
    stopLiveAuto();
    armAuto = null;
  }

  function resumeLiveAuto(): void {
    if (!liveOpts.auto || liveTimer || !armAuto) return;
    armAuto();
  }

  function makeSentinel(): SentinelEl | null {
    if (typeof customElements === "undefined") return null;
    if (!customElements.get(SENTINEL)) {
      customElements.define(SENTINEL, class extends HTMLElement {
        onConnect?: () => void;
        connectedCallback(): void {
          // Fires mid-appendChild — a resume failure must not break the
          // hub's tab switch, and there is nothing to tell the player.
          try { this.onConnect?.(); } catch { /* see above */ }
        }
      });
    }
    const s = document.createElement(SENTINEL) as SentinelEl;
    s.onConnect = resumeLiveAuto;
    s.hidden = true;
    return s;
  }

  function lastFetchedAt(sessionKey: Key): number | null {
    let newest = 0;
    try {
      const marker = "session_key=" + encodeURIComponent(sessionKey);
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || key.indexOf(CACHE_PREFIX) !== 0) continue;
        const at = key.indexOf(marker);
        if (at === -1) continue;
        const after = key.charAt(at + marker.length);
        if (after && after !== "&") continue;   // session_key=11 must not match =110
        if (!/\/(weather|position|drivers)\?/.test(key)) continue;
        // Prefix-read the timestamp (api.cacheEntryT) — position payloads
        // run multi-MB, and this sweep repeats every refresh under AUTO.
        const t = api.cacheEntryT(localStorage.getItem(key));
        if (t != null && t > newest) newest = t;
      }
    } catch { /* no storage: every response was a real fetch */ }
    return newest || null;
  }

  function loadLive(): Promise<HTMLElement> {
    return ensureSession(true).then(function () {
      const wrap = el("div", "dh-tabbody dh-split");
      const leftPane = el("div", "dh-split-L");
      const rightPane = el("div", "dh-split-R");
      leftPane.appendChild(buildPicker(function (meta) {
        renderLiveBody(meta, leftPane, rightPane);
        invalidateOther("live");
      }));
      wrap.appendChild(leftPane);
      wrap.appendChild(rightPane);
      renderLiveBody(sel.meta, leftPane, rightPane);
      return wrap;
    });
  }

  function renderLiveBody(meta: Session | null, leftPane: HTMLElement, rightPane: HTMLElement): void {
    stopLiveAuto();
    ++liveRefreshGen;
    while (leftPane.children.length > 1 && leftPane.lastChild) leftPane.removeChild(leftPane.lastChild);
    clear(rightPane);
    if (!meta || meta.sessionKey == null) { armAuto = null; rightPane.appendChild(emptyMsg(NO_LIVE_MSG)); return; }
    const sessionKey = meta.sessionKey;

    const info = el("div", "dh-livecard");
    const infoTitle = el("div", "dh-live-title");
    infoTitle.appendChild(el("span", null, meta.name || meta.type || "Session"));
    if (meta.type && meta.type !== meta.name) infoTitle.appendChild(el("span", "dh-live-type", meta.type));
    const phase = sessionStatus(meta);
    const stateBadge = el("span", "dh-live-state", phase);
    stateBadge.setAttribute("data-state", phase.toLowerCase());
    infoTitle.appendChild(stateBadge);
    info.appendChild(infoTitle);
    const place = api.placeLabel(meta.circuit, meta.country, " · ");
    if (place) info.appendChild(el("div", "dh-live-sub", place));
    const timeLabel = sessionTimeLabel(meta, phase, fmtDateTime);
    if (timeLabel) info.appendChild(el("div", "dh-live-sub", timeLabel));
    leftPane.appendChild(info);

    const bar = el("div", "dh-livecontrols");
    const refreshBtn = el("button", "dh-livebtn", "↻ REFRESH");
    refreshBtn.type = "button";
    const autoBtn = el("button", "dh-livebtn" + (liveOpts.auto ? " active" : ""), "AUTO");
    autoBtn.type = "button";
    autoBtn.title = "Auto-refresh every 30s";
    autoBtn.setAttribute("data-aria-toggle", "");
    autoBtn.setAttribute("aria-pressed", liveOpts.auto ? "true" : "false");
    const stamp = el("span", "dh-live-updated", "");
    bar.appendChild(refreshBtn);
    bar.appendChild(autoBtn);
    bar.appendChild(stamp);
    leftPane.appendChild(bar);

    const dataEl = el("div", "dh-tabbody");
    rightPane.appendChild(dataEl);

    let refreshPromise: Promise<void> | null = null;
    let scheduleAuto: (() => void) | null = null;
    const liveState = newLiveState();

    function refresh(): Promise<void> {
      if (refreshPromise) return refreshPromise;
      if (liveOpts.auto) stopLiveAuto();
      const myGen = ++liveRefreshGen;
      const priorState = dataEl.getAttribute("data-state");
      const hadData = priorState === "ready" || priorState === "empty" || priorState === "partial" || priorState === "stale";
      if (!hadData) { clear(dataEl); dataEl.appendChild(spinner()); }
      dataEl.setAttribute("aria-busy", "true");
      const settle = <T>(promise: Promise<T>): Promise<Settled<T>> => promise.then(
        (value): Settled<T> => ({ ok: true, value }),
        (error: unknown): Settled<T> => ({ ok: false, error }),
      );
      // AUTO (and manual refresh) must not hit the 10 min TTL_LATEST cache —
      // otherwise a 30 s loop silently re-serves the same payload. ttl:0
      // bypasses the read (api.ts request) while still writing on success.
      const ttl = 0;
      const positionReq = api.livePositions(sessionKey, liveState.positionCursor);
      const intervalReq = api.liveIntervals(sessionKey, liveState.intervalCursor);
      refreshPromise = Promise.all([
        settle(api.weather(sessionKey, ttl)),
        settle(positionReq),
        settle(api.sessionDrivers(sessionKey)),
        settle(intervalReq),
      ] as const).then((batch) => {
        if (myGen !== liveRefreshGen) return;
        dataEl.setAttribute("aria-busy", "false");
        const all: readonly Settled<unknown>[] = batch;
        const failed = all.filter((x): x is { ok: false; error: unknown } => !x.ok);
        const gate = failed.find((x) => {
          const err = errorInfo(x.error);
          const msg = err.message;
          return err.status === 401 || err.status === 403 ||
            msg.indexOf("Live F1 session") !== -1 ||
            msg.indexOf("HTTP 401") !== -1 || msg.indexOf("HTTP 403") !== -1;
        });
        if (failed.length === batch.length || gate) {
          if (!hadData) clear(dataEl);
          else {
            const oldFailure = dataEl.querySelector(".dh-error[data-refresh-error]");
            if (oldFailure && oldFailure.parentNode) oldFailure.parentNode.removeChild(oldFailure);
          }
          const failure = el("div", "dh-error");
          failure.setAttribute("role", "status");
          failure.setAttribute("data-refresh-error", "");
          failure.setAttribute("data-state", hadData ? "stale" : "failed");
          failure.appendChild(el("div", "dh-error-msg", gate
            ? (errorInfo(gate.error).message || "Live data is unavailable.")
            : (hadData ? "Couldn't refresh live data. Showing the last update."
              : "Couldn't load live data. Try again.")));
          if (hadData && dataEl.firstChild) dataEl.insertBefore(failure, dataEl.firstChild);
          else dataEl.appendChild(failure);
          dataEl.setAttribute("data-state", hadData ? "stale" : "failed");
          if (gate) {
            liveOpts.auto = false;
            autoBtn.classList.remove("active");
            autoBtn.setAttribute("aria-pressed", "false");
            stopLiveAuto();
          }
          return;
        }
        clear(dataEl);
        if (failed.length) {
          const partial = el("div", "dh-error");
          partial.setAttribute("role", "status");
          partial.setAttribute("data-state", "partial");
          partial.appendChild(el("div", "dh-error-msg", "Some live data couldn't refresh."));
          dataEl.appendChild(partial);
        }
        const [wx, pos, drv, gap] = batch;
        const positions = mergePositionBatch(liveState, pos.ok ? pos.value : null);
        const gaps = mergeIntervalBatch(liveState, gap.ok ? gap.value : null);
        positions.forEach((p) => {
          if (p.num != null && Object.prototype.hasOwnProperty.call(gaps, p.num)) {
            const g = gaps[String(p.num)];
            if (g !== undefined) p.timeDiff = g;
          }
        });
        fillLive(dataEl, wx.ok ? wx.value : null, positions, drv.ok ? drv.value : null);
        dataEl.setAttribute("data-state", failed.length ? "partial"
          : (positions.length ? "ready" : "empty"));
        const fetchedAt = lastFetchedAt(sessionKey);
        stamp.textContent = "updated " + new Date(fetchedAt || Date.now())
          .toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      }).finally(() => {
        dataEl.setAttribute("aria-busy", "false");
        refreshPromise = null;
        // Settlement-driven scheduling: the 30 seconds starts after this
        // batch finishes, never while it is still occupying the API's queue.
        if (liveOpts.auto && scheduleAuto && armAuto === scheduleAuto && dataEl.isConnected) scheduleAuto();
      });
      return refreshPromise;
    }

    refreshBtn.addEventListener("click", () => { void refresh(); });
    autoBtn.addEventListener("click", () => {
      liveOpts.auto = !liveOpts.auto;
      autoBtn.classList.toggle("active", liveOpts.auto);
      autoBtn.setAttribute("aria-pressed", liveOpts.auto ? "true" : "false");
      stopLiveAuto();
      resumeLiveAuto();
    });
    const schedule = (): void => {
      stopLiveAuto();
      if (!liveOpts.auto || armAuto !== schedule) return;
      // An in-flight batch owns scheduling through its finally arm above.
      if (refreshPromise) return;
      liveTimer = setTimeout(() => {
        liveTimer = null;
        if (!liveOpts.auto || armAuto !== schedule || !dataEl.isConnected) return;
        if (document.hidden) { schedule(); return; }
        void refresh();
      }, LIVE_REFRESH);
    };
    scheduleAuto = schedule;
    armAuto = schedule;
    const sentinel = makeSentinel();
    if (sentinel) bar.appendChild(sentinel);
    resumeLiveAuto();
    void refresh();
  }

  function fillLive(body: HTMLElement, weather: Weather | null, positions: LivePosition[], drivers: SessionDriver[] | null): void {
    if (weather) {
      const wx = el("div", "dh-livecard dh-weather");
      wx.appendChild(el("h3", "dh-section", "WEATHER"));
      const grid = el("div", "dh-wx-grid");
      const items: [string, string | null][] = [
        ["AIR", weather.airT !== null ? weather.airT + "°C" : null],
        ["TRACK", weather.trackT !== null ? weather.trackT + "°C" : null],
        ["HUMIDITY", weather.humidity !== null ? weather.humidity + "%" : null],
        ["RAIN", weather.rainfall !== null ? (weather.rainfall > 0 ? "YES" : "NO") : null],
        ["WIND", weather.windSpeed !== null ? weather.windSpeed + " m/s" : null],
      ];
      items.forEach((it) => {
        if (it[1] === null) return;
        const cell = el("div", "dh-wx-cell");
        cell.appendChild(el("div", "dh-wx-label", it[0]));
        cell.appendChild(el("div", "dh-wx-value", it[1]));
        grid.appendChild(cell);
      });
      wx.appendChild(grid);
      body.appendChild(wx);
    }

    if (!positions.length) {
      body.appendChild(emptyMsg(NO_LIVE_MSG));
      return;
    }
    const byNum: Record<string, SessionDriver> = {};
    (drivers || []).forEach((d) => {
      if (d && d.num != null) byNum[d.num] = d;
    });

    const sec = el("div", "dh-livecard");
    const head = el("div", "dh-class-head");
    head.appendChild(el("h3", "dh-section", "CLASSIFICATION"));
    const sorts = el("div", "dh-sorts");
    const sortBtns: Partial<Record<SortKey, HTMLButtonElement>> = {};
    ([["pos", "POS"], ["team", "TEAM"]] as const).forEach((s) => {
      const b = el("button", "dh-sortbtn", s[1]);
      b.type = "button";
      b.addEventListener("click", () => { liveOpts.sort = s[0]; renderRows(); });
      sortBtns[s[0]] = b;
      sorts.appendChild(b);
    });
    head.appendChild(sorts);
    sec.appendChild(head);

    const rows = el("div", "dh-class-rows");
    sec.appendChild(rows);
    body.appendChild(sec);

    const driverOf = (p: LivePosition): Partial<SessionDriver> => byNum[String(p.num)] || {};
    function teamOf(p: LivePosition): string { return driverOf(p).team || ""; }
    function posOf(p: LivePosition): number { return (p.pos === null || p.pos === undefined) ? 999 : p.pos; }

    function renderRows(): void {
      for (const [k, btn] of Object.entries(sortBtns)) {
        const on = k === liveOpts.sort;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      }
      clear(rows);
      const list = positions.slice();
      if (liveOpts.sort === "team") {
        list.sort((a, b) => teamOf(a).localeCompare(teamOf(b)) || (posOf(a) - posOf(b)));
      } else {
        list.sort((a, b) => posOf(a) - posOf(b));
      }

      let maxGap = 0;
      if (liveOpts.sort === "pos" && list.length > 0) {
        list.forEach((p) => {
          if (typeof p.timeDiff === "number" && p.timeDiff > maxGap) maxGap = p.timeDiff;
        });
      }

      list.forEach((p) => {
        const d = driverOf(p);
        const row = el("div", "dh-row");

        const mainInfo = el("div", "dh-cons-main");
        mainInfo.appendChild(el("span", "dh-pos", p.pos != null ? p.pos : "—"));
        const chip = el("span", "dh-codechip", d.code || (p.num != null ? "#" + p.num : "—"));
        const col = driverColor(d, findTeam, null);
        chip.style.background = cssColor(col);
        chip.style.color = textColorOn(col);
        mainInfo.appendChild(chip);
        mainInfo.appendChild(el("span", "dh-name", d.name || "—"));
        mainInfo.appendChild(el("span", "dh-td-team dh-live-team", d.team || ""));
        row.appendChild(mainInfo);

        if (liveOpts.sort === "pos" && p.pos !== 1 && typeof p.timeDiff === "number" && maxGap > 0) {
          const gapWrap = el("div", "dh-live-gapwrap");
          const gapBar = el("div", "dh-live-gapbar");
          gapBar.style.width = Math.min(100, (p.timeDiff / maxGap) * 100) + "%";
          gapBar.style.backgroundColor = cssColor(col);
          gapWrap.appendChild(gapBar);
          const gapLbl = el("span", "dh-live-gaplbl", "+" + p.timeDiff.toFixed(3));
          gapWrap.appendChild(gapLbl);
          row.appendChild(gapWrap);
        } else if (liveOpts.sort === "pos" && typeof p.timeDiff === "string") {
          const gapWrap = el("div", "dh-live-gapwrap");
          gapWrap.appendChild(el("span", "dh-live-gaplbl", p.timeDiff));
          row.appendChild(gapWrap);
        }

        rows.appendChild(row);
      });
    }
    renderRows();
  }

  return { loadLive, stopLiveAuto, disarmLiveAuto };
}

/**
 * Mount LIVE into `host`: spinner, loadLive, then the tab node. unmount()
 * disarms the auto-poll the way hub.js's close does (hub.js:287) and detaches.
 */
export function mount(host: HTMLElement, deps: LiveDeps): MountedTab {
  const tab = create(deps);
  let gen = 0;
  function load(): Promise<void> {
    const myGen = ++gen;
    deps.clear(host);
    host.appendChild(deps.spinner());
    return tab.loadLive().then((node) => {
      if (myGen !== gen) return;
      deps.clear(host);
      host.appendChild(node);
    }, (err: unknown) => {
      if (myGen !== gen) return;
      log.warn("tab live fail", err);
      deps.clear(host);
      const w = deps.el("div", "dh-error");
      w.setAttribute("role", "status");
      w.appendChild(deps.el("div", "dh-error-msg", errorInfo(err).message || "Couldn't load live data. Try again."));
      host.appendChild(w);
    });
  }
  void load();
  return {
    refresh: load,
    unmount(): void {
      ++gen;
      tab.disarmLiveAuto();
      deps.clear(host);
    },
  };
}
