/**
 * Telemetry tab controller: selection, async lap loading and popup lifecycle.
 * Ported verbatim from f1-game js/data/telemetry.js:1-435 (DataTelemetry):
 *
 *   loadTelemetry                       telemetry.js:16-30
 *   tray (lanes) helpers                telemetry.js:32-55
 *   renderTelemetryBody                 telemetry.js:57-199
 *   fetchDriverTel                      telemetry.js:201-242
 *   abortStaleLanes / stopTelAnim       telemetry.js:244-270
 *   closeTelemPopup / openTelemPopup    telemetry.js:272-378
 *   loadTelemetrySet                    telemetry.js:380-425
 *   _dropStrays .. _cumDist             telemetry.js:430-433
 *
 * The global F1API is deps.api; `mount` is apex-26's tab seam
 * (../../hub-deps.ts MountedTab) around f1-game's hub showTab/close calls
 * (js/data/hub.js:283-288, 327-339).
 */
import type { CarSample, LocationSample, Session, SessionDriver } from "../../api";
import type { HubDeps, MountedTab } from "../../hub-deps";
import { countsByDriver } from "../../tab-utils";
import { mountTab } from "../mount";
import {
  create as createModel, cumDist, dcode, dropStrays, gapLimitMs, isGap, laneRole, locAt, locBounds,
  sessionShort, type TelLane, type TelView,
} from "./model";
import { create as createView } from "./view";

/** A lane picked into the tray (telemetry.js:40-41). */
export interface TrayEntry {
  d: SessionDriver;
  sessionKey: Session["sessionKey"];
  meetingKey: Session["meetingKey"];
  sessionLabel: string;
  sessionName: string;
}

export interface TelemetryTab {
  loadTelemetry(): Promise<HTMLElement>;
  /** `leavingTab === true` also aborts an in-flight COMPARE; returns true when it did. */
  closeTelemPopup(leavingTab?: unknown): boolean;
}

export function create(ctx: HubDeps): TelemetryTab {
  const { el, clear, emptyMsg, spinner, sel, ensureSession, buildPicker,
          invalidateOther, cssColor, textColorOn, NO_TELEM_MSG, api } = ctx;

  const { driverColor, laneColors } = createModel(ctx);
  const { buildTelemetryView, pauseAnim } = createView(ctx, {
    stop: stopTelAnim,
    setView: function (view) { telView = view; },
  });

  function loadTelemetry(): Promise<HTMLElement> {
    return ensureSession().then(function () {
      const wrap = el("div", "dh-tabbody dh-split");
      const leftPane = el("div", "dh-split-L");
      const rightPane = el("div", "dh-split-R");
      leftPane.appendChild(buildPicker(function (meta) {
        renderTelemetryBody(meta, leftPane, rightPane);
        invalidateOther("telemetry");
      }, abortStaleLanes));
      wrap.appendChild(leftPane);
      wrap.appendChild(rightPane);
      renderTelemetryBody(sel.meta, leftPane, rightPane);
      return wrap;
    });
  }

  let driverGen = 0;
  const MAX_LANES = 4;
  let tray: TrayEntry[] = [];
  function trayHas(num: SessionDriver["num"], sk: Session["sessionKey"]): boolean { return tray.some(function (e) { return e.d.num === num && e.sessionKey === sk; }); }
  function trayToggle(d: SessionDriver, meta: Session): void {
    const sk = meta.sessionKey;
    const i = tray.findIndex(function (e) { return e.d.num === d.num && e.sessionKey === sk; });
    if (i !== -1) { tray.splice(i, 1); return; }
    tray.push({ d: d, sessionKey: sk, meetingKey: meta.meetingKey, sessionLabel: sessionShort(meta),
                sessionName: meta.name || meta.type || "Session" });
    if (tray.length > MAX_LANES) tray.shift();   // oldest lane drops off
  }
  // The lanes overlay on ONE track map, so they must be the same circuit. A
  // session switch WITHIN a meeting is the cross-session flow (race vs quali);
  // switching to a different Grand Prix drops the now-mismatched lanes.
  function pruneTrayToMeeting(meta: Session | null): void {
    if (!meta || meta.meetingKey == null) return;
    tray = tray.filter(function (e) { return e.meetingKey == null || e.meetingKey === meta.meetingKey; });
  }
  function trayNeedsBadges(): boolean {
    const byNum: Record<string, number> = {};
    for (const e of tray) byNum[String(e.d.num)] = (byNum[String(e.d.num)] || 0) + 1;
    return tray.some(function (e) { return (byNum[String(e.d.num)] as number) > 1; });
  }

  function renderTelemetryBody(meta: Session | null, leftPane: HTMLElement, rightPane: HTMLElement): void {
    const myDriverGen = ++driverGen;
    ++telGen;
    abortStaleLanes();   // a SESSION pick mid-COMPARE: sessionDrivers must not queue behind the old lanes
    if (meta) pruneTrayToMeeting(meta);   // drop lanes from a different circuit
    // Keep the picker (first child of leftPane); remove everything appended after it
    while (leftPane.children.length > 1) leftPane.removeChild(leftPane.lastChild as ChildNode);
    clear(rightPane);
    if (!meta || meta.sessionKey == null) { tray = []; rightPane.appendChild(emptyMsg(NO_TELEM_MSG)); return; }
    const session = meta;
    const sessionKey = meta.sessionKey;
    rightPane.appendChild(spinner());

    api.sessionDrivers(sessionKey).then(function (driversIn) {
      if (myDriverGen !== driverGen) return;
      // Session info → left pane
      const info = el("div", "dh-livecard");
      const title = el("div", "dh-live-title");
      title.appendChild(el("span", null, session.name || session.type || "Session"));
      if (session.type && session.type !== session.name) title.appendChild(el("span", "dh-live-type", session.type));
      info.appendChild(title);
      const place = api.placeLabel(session.circuit, session.country, " · ");
      if (place) info.appendChild(el("div", "dh-live-sub", place));
      // Two short lines — a single long ·-joined string was clipped mid-word
      // in the narrow split pane ("drag chart to .").
      info.appendChild(el("div", "dh-live-sub",
        "Select one driver for a fastest-lap trace. Select a second to compare; the first is the reference."));
      info.appendChild(el("div", "dh-live-sub",
        "A third or fourth driver adds speed markers. Switch SESSION to compare race vs quali."));
      leftPane.appendChild(info);

      clear(rightPane);

      const drivers = (driversIn || []).filter(function (d) { return d && d.num != null; });
      if (!drivers.length) { rightPane.appendChild(emptyMsg(NO_TELEM_MSG)); return; }

      const chipByNum: Record<string, HTMLButtonElement> = {};
      const pick = el("div", "dh-driverpick");
      const detail = el("div", "dh-telem-detail");

      function selectionChanged(): void {
        // A changed tray supersedes both outcomes of the pending lap load.
        ++telGen;
        abortStaleLanes();
        syncChips();
      }
      function syncChips(): void {
        drivers.forEach(function (d) {
          const selected = trayHas(d.num, session.sessionKey);
          const chip = chipByNum[String(d.num)] as HTMLButtonElement;
          chip.classList.toggle("active", selected);
          chip.setAttribute("aria-pressed", selected ? "true" : "false");
        });
        clear(detail);
        if (tray.length === 0) {
          detail.appendChild(emptyMsg("Select one driver to view a fastest lap. Select a second to compare; the first driver is the reference."));
          return;
        }
        const badges = trayNeedsBadges();
        const summary = el("div", "dh-livecard");
        summary.appendChild(el("h3", "dh-section", tray.length === 1 ? "SELECTED DRIVER" : "COMPARE DRIVERS (" + tray.length + ")"));
        const laneCols = laneColors(tray);
        tray.forEach(function (e, i) {
          const row = el("div", "dh-row");
          const chip = el("span", "dh-codechip", dcode(e.d));
          const col = laneCols[i];
          chip.style.background = cssColor(col);
          chip.style.color = textColorOn(col);
          row.appendChild(chip);
          row.appendChild(el("span", "dh-name", e.d.name || "—"));
          row.appendChild(el("span", "dh-tsect", laneRole(i)));
          if (badges || tray.some(function (o) { return o.sessionKey !== e.sessionKey; })) {
            row.appendChild(el("span", "dh-lane-ses", e.sessionLabel || e.sessionName));
          }
          const rm = el("button", "dh-lane-x", "×");
          rm.type = "button"; rm.title = "Remove lane";
          rm.addEventListener("click", function () {
            const idx = tray.findIndex(function (o) { return o.d.num === e.d.num && o.sessionKey === e.sessionKey; });
            if (idx !== -1) tray.splice(idx, 1);
            selectionChanged();
          });
          row.appendChild(rm);
          summary.appendChild(row);
        });
        if (tray.length > 2) {
          summary.appendChild(el("div", "dh-live-sub",
            "The first two lanes draw full traces; additional lanes add speed markers."));
        }
        const loadBtn = el("button", "dh-livebtn");
        loadBtn.textContent = tray.length === 1 ? "LOAD FASTEST LAP" : "COMPARE " + tray.length + " LAPS";
        loadBtn.dataset["block"] = "full";   // css/data.css .dh-livebtn[data-block]
        loadBtn.type = "button";
        loadBtn.addEventListener("click", function () {
          const focus = chipByNum[String((tray[0] as TrayEntry).d.num)] || loadBtn;
          loadTelemetrySet(tray.slice(), detail, syncChips, focus);
        });
        summary.appendChild(loadBtn);
        if (tray.length > 1) {
          const clr = el("button", "dh-livebtn dh-lane-clear", "CLEAR SELECTION");
          clr.type = "button"; clr.dataset["block"] = "tight";
          clr.addEventListener("click", function () { tray = []; selectionChanged(); });
          summary.appendChild(clr);
        }
        detail.appendChild(summary);
      }

      const pickHead = el("h3", "dh-section", "SELECT DRIVERS");
      drivers.forEach(function (d) {
        const fullName = d.name || dcode(d);
        const parts = fullName.trim().split(/\s+/);
        const shortName = parts.length > 1 ? parts[parts.length - 1] as string : fullName;
        // The surname in its own span: a phone shows the code alone (css/data.css), and aria-label keeps the full name.
        const b = el("button", "dh-dchip", dcode(d));
        b.appendChild(el("span", null, " · " + shortName));
        b.type = "button";
        b.style.borderColor = cssColor(driverColor(d));
        b.setAttribute("aria-label", "Select " + fullName);
        b.addEventListener("click", function () {
          trayToggle(d, session);
          selectionChanged();
        });
        chipByNum[String(d.num)] = b;
        pick.appendChild(b);
      });

      syncChips();
      // Driver chips → left pane; chart detail → right pane
      leftPane.appendChild(pickHead);
      leftPane.appendChild(pick);
      rightPane.appendChild(detail);
    }, function () {
      if (myDriverGen !== driverGen) return;
      clear(rightPane);
      const failure = el("div", "dh-error");
      failure.setAttribute("role", "status");
      failure.setAttribute("data-state", "failed");
      failure.appendChild(el("div", "dh-error-msg", "Couldn't load telemetry drivers. Try again."));
      const retry = el("button", "dh-retry", "RETRY");
      retry.type = "button";
      retry.addEventListener("click", function () { renderTelemetryBody(session, leftPane, rightPane); });
      failure.appendChild(retry);
      rightPane.appendChild(failure);
    });
  }

  // fetch one driver's fastest-lap bundle (extras = stints + pits for primary)
  function fetchDriverTel(sessionKey: NonNullable<Session["sessionKey"]>, d: SessionDriver, withExtras: boolean): Promise<TelLane> {
    const num = d.num as number;   // the picker only offers drivers with a number (telemetry.js:90)
    return api.fastestLap(sessionKey, num).then(function (lap): TelLane | Promise<TelLane> {
      if (!lap || !lap.dateStart) return { d: d, lap: null };
      const start = lap.dateStart;
      const dur = lap.lapDuration || 90;
      const ms = Date.parse(start);
      const end = isFinite(ms) ? new Date(ms + dur * 1000 + 1500).toISOString() : start;
      return Promise.all([
        // These two ARE the telemetry view. A rejected request is a failed
        // load, while a fulfilled [] is a valid "not published" answer.
        api.carData(sessionKey, num, start, end),
        api.locationData(sessionKey, num, start, end),
        withExtras ? api.stints(sessionKey, num).catch(function () { return []; }) : undefined,
        withExtras ? api.pits(sessionKey, num).catch(function () { return []; }) : undefined,
      ]).then(function (res) {
        // CLIP BACK TO THE LAP. The window above overshoots by 1.5s so the last
        // samples of the lap are certainly returned, but that tail must not be
        // drawn: it is ~100m of extra track past the line, and how much of it
        // there is depends on what the driver did NEXT. In a race they stay flat
        // out down the straight; in qualifying they lift for an in-lap and can
        // reach the pit entry, which spurs off the circuit, stretches the map's
        // x/y bounds and rescales everything — the same track, drawn as a
        // different shape in one session than the other.
        const endMs = isFinite(ms) ? ms + dur * 1000 : null;
        function clipToLap<S extends CarSample | LocationSample>(list: S[] | null | undefined): S[] {
          if (!endMs || !list || !list.length) return list || [];
          const kept = list.filter(function (s) {
            const at = +s.date;
            return !isFinite(at) || at <= endMs;
          });
          // Coverage and sparsity do not authorize samples from the next lap.
          return kept;
        }
        return { d: d, lap: lap, car: clipToLap(res[0]), loc: dropStrays(clipToLap(res[1])),
                 stints: res[2] || [], pits: res[3] || [] };
      });
    });
  }

  let telGen = 0;
  let telLanes = 0;                   // lane fetches in flight (loadTelemetrySet): what closeTelemPopup(true) aborts
  // Changing GP / YEAR / SESSION inside TELEMETRY (M24 only covered LEAVING the tab):
  // the lanes of a COMPARE still fetching sit ahead of the picker's next request
  // in F1API's serialized OpenF1 lane, so the new driver list waited out tens of
  // seconds of work nobody will render. telGen goes first so the lanes' rejections
  // are ignored, not painted as a failed lap.
  function abortStaleLanes(): boolean {
    if (!telLanes) return false;
    ++telGen;
    api.cancelAll();
    return true;
  }
  let telView: TelView | null = null;          // the live telemetry view (for animation cleanup)
  let telemPopup: HTMLDialogElement | null = null;   // the full-screen player popup <dialog>
  let telemReturnFocus: Element | null = null;

  function stopTelAnim(): void {
    if (telView) {
      pauseAnim(telView);
      if (telView._ro) { telView._ro.disconnect(); telView._ro = null; }
      // Drop the reference too: the view holds canvases, offscreen bases and
      // every lane's sample arrays, and a stopped view is never resumed — a
      // new one is assigned on the next lap load.
      telView = null;
    }
  }

  // `leavingTab === true` (hub showTab; a click handler passes an Event, never
  // true): a COMPARE still fetching is aborted too, so the next tab does not
  // queue behind it in F1API's serialized OpenF1 lane (M24). Returns true when
  // it aborted anything, so the hub drops this tab's now half-failed node.
  function closeTelemPopup(leavingTab?: unknown): boolean {
    ++telGen;   // a lap load in flight must not resurrect the popup after close
    const restore = telemPopup ? telemReturnFocus : null;
    stopTelAnim();
    if (telemPopup) {
      // Null the tracker FIRST: close() fires the dialog's close event, whose
      // listener re-enters here — with telemPopup already null that pass is a
      // no-op, which is what makes cancel/close/backdrop all safe to overlap.
      const node = telemPopup;
      telemPopup = null;
      if (node.open) { try { node.close(); } catch { /* already closing */ } }
      if (node.parentNode) node.parentNode.removeChild(node);
    }
    telemReturnFocus = null;
    if (restore && restore.isConnected && (restore as HTMLElement).focus) (restore as HTMLElement).focus();
    if (leavingTab !== true || !telLanes) return false;
    api.cancelAll();
    return true;
  }

  function openTelemPopup(tels: TelLane[], returnFocus: HTMLElement | null): void {
    closeTelemPopup();
    telemReturnFocus = (returnFocus && returnFocus.isConnected)
      ? returnFocus : document.activeElement;
    // A REAL <dialog>, not a div claiming role=dialog: showModal() gives the
    // top layer, focus containment, inert background and Escape for free —
    // the platform asserts the role and aria-modal, so neither is written.
    const overlay = el("dialog", "dh-tpopup");
    overlay.setAttribute("aria-labelledby", "dh-tpopup-title");

    // fit-managed: SheetShape scans this class alongside .sheet, so a short
    // window at high UI SIZE shrinks the popup instead of starving the trace.
    const card = el("div", "dh-tpopup-card fit-managed");

    // Header: driver name(s) + session context + close button
    const hdr = el("div", "dh-tpopup-hdr");
    const titleEl = el("div", "dh-tpopup-title");
    titleEl.id = "dh-tpopup-title";
    const dupName = countsByDriver(tels);
    const label = tels.map(function (t) {
      const nm = t.d.name || dcode(t.d);
      return ((dupName[String(t.d.num)] as number) > 1 && t.sessionLabel) ? nm + " " + t.sessionLabel : nm;
    }).join(" vs ");
    titleEl.appendChild(el("span", null, label));
    const first = tels[0];
    const oneSession = tels.every(function (t) { return !t.sessionLabel || t.sessionLabel === (first as TelLane).sessionLabel; });
    // The LANES' session, not the one picked now: the tray keeps a
    // meeting's lanes across a session switch.
    const laneSes = first && first.sessionName;
    if (sel.meta && oneSession) {
      const same = !laneSes || laneSes === (sel.meta.name || sel.meta.type);
      const sub = [laneSes || sel.meta.name || sel.meta.type, same ? sel.meta.circuit || sel.meta.country : null].filter(Boolean).join(" · ");
      if (sub) titleEl.appendChild(el("span", "dh-tpopup-sub", sub));
    } else if (sel.meta) {
      const sub = [sel.meta.circuit || sel.meta.country].filter(Boolean).join(" · ");
      if (sub) titleEl.appendChild(el("span", "dh-tpopup-sub", sub + " · cross-session"));
    }
    hdr.appendChild(titleEl);
    const closeBtn = el("button", "dh-close", "✕");
    closeBtn.type = "button";
    // autofocus: showModal's focusing steps then GUARANTEE initial focus here,
    // instead of racing whatever the async body build makes focusable first.
    closeBtn.autofocus = true;
    closeBtn.setAttribute("aria-label", "Close telemetry");
    closeBtn.addEventListener("click", closeTelemPopup);
    hdr.appendChild(closeBtn);
    card.appendChild(hdr);

    const body = el("div", "dh-tpopup-body");
    body.appendChild(spinner());
    card.appendChild(body);
    overlay.appendChild(card);

    // Close on backdrop click — the dialog element is styled full-viewport
    // (the scrim IS the element, css/data.css), so a press outside the card
    // targets the dialog itself.
    overlay.addEventListener("pointerdown", function (e) {
      if (e.target === overlay) closeTelemPopup();
    });
    // Escape arrives as `cancel`; route it through the real teardown (a bare
    // native close would leak the animation, the ResizeObserver and an
    // in-flight lap load — see closeTelemPopup). `close` is the backstop for
    // any other native close path; re-entry is a no-op by construction.
    overlay.addEventListener("cancel", function (e) {
      e.preventDefault();
      closeTelemPopup();
    });
    overlay.addEventListener("close", function () {
      if (telemPopup === overlay) closeTelemPopup();
    });

    const host = document.getElementById("datahub") || document.body;
    host.appendChild(overlay);
    telemPopup = overlay;
    overlay.showModal();
    closeBtn.focus();

    // Build after layout so clientWidth measurements are real
    setTimeout(function () {
      if (telemPopup !== overlay) return;
      clear(body);
      buildTelemetryView(body, tels);
    }, 0);
  }

  function loadTelemetrySet(lanes: TrayEntry[], detail: HTMLElement, syncChips: (() => void) | null, returnFocus: HTMLElement | null): void {
    const myGen = ++telGen;
    stopTelAnim();
    if (!lanes.length) {
      if (syncChips) syncChips();
      return;
    }
    clear(detail);
    detail.appendChild(spinner());
    Promise.all(lanes.map(function (e, i) {
      telLanes++;
      // The lane count drops inside this ONE then-stage (both arms), not a
      // trailing .finally(): that is an extra microtask hop per lane, and the
      // popup then opens one tick later than the harness drains for.
      return fetchDriverTel(e.sessionKey as NonNullable<Session["sessionKey"]>, e.d, i === 0).then(function (tel) {
        telLanes--;
        tel.sessionLabel = e.sessionLabel; tel.sessionName = e.sessionName;
        return tel;
      }, function (err: unknown) { telLanes--; throw err; });
    }))
      .then(function (tels) {
        if (myGen !== telGen) return;
        if (syncChips) syncChips();
        openTelemPopup(tels, returnFocus);
      }, function (err: unknown) {
        if (myGen !== telGen) return;
        clear(detail);
        let msg = "Couldn't load telemetry.";
        const m = err instanceof Error ? err.message : (err && typeof err === "object" && "message" in err ? (err as { message: unknown }).message : null);
        if (typeof m === "string" && m && m.indexOf("Live F1 session") !== -1) msg = m;
        const failure = el("div", "dh-error");
        failure.setAttribute("role", "status");
        failure.setAttribute("data-state", "failed");
        failure.appendChild(el("div", "dh-error-msg", msg));
        const retry = el("button", "dh-retry", "RETRY");
        retry.type = "button";
        retry.addEventListener("click", function () {
          loadTelemetrySet(lanes, detail, syncChips, returnFocus);
        });
        failure.appendChild(retry);
        detail.appendChild(failure);
        const backBtn = el("button", "dh-livebtn", "BACK");
        backBtn.dataset["block"] = "full";
        backBtn.addEventListener("click", function () { if (syncChips) syncChips(); });
        detail.appendChild(backBtn);
      });
  }

  return { loadTelemetry, closeTelemPopup };
}

/**
 * Mount the TELEMETRY tab into `host`: spinner, then loadTelemetry's node.
 * unmount() closes the popup (stopping playback rAF and the ResizeObserver)
 * and aborts an in-flight COMPARE, as hub.js showTab does on leaving the tab.
 */
export function mount(host: HTMLElement, deps: HubDeps): MountedTab & { tab: TelemetryTab } {
  const tab = create(deps);
  const mounted = mountTab("telemetry", host, deps, tab.loadTelemetry, function () { tab.closeTelemPopup(true); });
  return { tab, refresh: mounted.refresh, unmount: mounted.unmount };
}

// Retain the established diagnostic surface for existing callers and probes
// (telemetry.js:430-433).
export {
  dropStrays as _dropStrays, locBounds as _locBounds, gapLimitMs as _gapLimitMs,
  isGap as _isGap, locAt as _locAt, cumDist as _cumDist,
};
