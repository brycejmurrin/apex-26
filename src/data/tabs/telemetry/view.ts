/**
 * Telemetry DOM layout, lane legends, stint tables and responsive canvas sizing.
 * Ported verbatim from f1-game js/data/telemetry-view.js:1-442
 * (DataTelemetryView):
 *
 *   shortLS / tallNarrow / chartH / deltaH   telemetry-view.js:15-34
 *   laneHeader                               telemetry-view.js:36-49
 *   buildTelemetryView                       telemetry-view.js:51-380
 *   makeOffscreen / viewRatio / sizeCanvas   telemetry-view.js:382-398
 *   appendStintsPits                         telemetry-view.js:400-435
 *
 * External: DataHub.compoundChipLabel (telemetry-view.js:409) is
 * deps.compoundChipLabel; Dom.fmtLap is ../../dom fmtLap. A null 2D context
 * on an offscreen skips its pre-transform (f1-game would throw).
 */
import { fmtLap as domFmtLap } from "../../dom";
import type { HubDeps } from "../../hub-deps";
import { countsByDriver } from "../../tab-utils";
import type { Rgb } from "../../teams";
import type { CarSample } from "../../api";
import { create as createModel, CHANNELS, cumDist, dcode, laneRole, type CarLane, type TelLane, type TelView } from "./model";
import { create as createPlayer } from "./player";
import { create as createRenderer } from "./render";

export type TelemetryViewDeps = Pick<HubDeps, "el" | "cssColor" | "textColorOn" | "COMPOUND" | "findTeam" | "compoundChipLabel">;
export interface TelemetryLifecycle { stop(): void; setView(view: TelView): void }
export interface TelemetryViewApi {
  buildTelemetryView(detail: HTMLElement, tels: TelLane[]): void;
  pauseAnim(view: TelView): void;
}

type CanvasZoom = HTMLCanvasElement & { currentCSSZoom?: number };

export function create(ctx: TelemetryViewDeps, lifecycle: TelemetryLifecycle): TelemetryViewApi {
  const { el, cssColor, textColorOn, COMPOUND } = ctx;
  const { laneColors } = createModel(ctx);
  const renderer = createRenderer(ctx);
  const { buildBases } = renderer;
  const player = createPlayer(ctx, renderer);
  const { buildTransport, buildGauges, attachScrub, pauseAnim, paintFrame, updateTextSummary } = player;
  const fmtLap = (sec: unknown): string => domFmtLap(sec, "—");

  function shortLS(): boolean {
    return typeof window !== "undefined" && window.innerHeight < 520 && window.innerWidth > window.innerHeight;
  }
  // A PORTRAIT PHONE has height to spare and no width. At the landscape
  // 190/600 a 336 px trace was 106 px tall: seven channels in a strip, the
  // two left axes printed over each other and the gap chart's title under
  // its own line. It scrolls anyway, so it gets a taller trace instead.
  function tallNarrow(w: number): boolean {
    return w < 480 && typeof window !== "undefined" && window.innerHeight > window.innerWidth * 1.2;
  }
  function chartH(w: number, compact: boolean): number {
    const base = Math.round(w * (tallNarrow(w) ? 0.56 : w < 480 ? 190 / 600 : 220 / 600));
    if (compact && shortLS()) return Math.min(base, Math.round(window.innerHeight * 0.38));
    return base;
  }
  function deltaH(w: number): number {
    const base = Math.round(tallNarrow(w) ? Math.max(64, w * 0.2) : w * (72 / 600));
    if (shortLS()) return Math.min(base, Math.round(window.innerHeight * 0.12));
    return base;
  }

  // one-line header per lane: swatch · name (· session) · caller's tail (sectors/lap, or a message)
  function laneHeader(t: TelLane, col: Rgb | undefined, dupNum: Record<string, number>, buildTail: (ht: HTMLElement) => void, role: string): HTMLElement {
    const ht = el("div", "dh-live-title dh-thead");
    const sw = el("span", "dh-swatch"); sw.style.background = cssColor(col);
    ht.appendChild(sw);
    // title= so a name that still ellipsises at a narrow width is recoverable
    const nameEl = el("span", "dh-tname", (t.d.name || dcode(t.d)));
    nameEl.title = t.d.name || dcode(t.d);
    ht.appendChild(nameEl);
    if ((dupNum[String(t.d.num)] as number) > 1 && t.sessionLabel) ht.appendChild(el("span", "dh-lane-ses", t.sessionLabel));
    if (role) ht.appendChild(el("span", "dh-tsect", role));
    buildTail(ht);
    return ht;
  }

  function buildTelemetryView(detail: HTMLElement, tels: TelLane[]): void {
    lifecycle.stop();
    // .cum is assigned below (telemetry-view.js:134) before any consumer reads it.
    const laps = tels.filter(function (t) { return t.car && t.car.length; }) as CarLane[];
    if (!laps[0]) {
      // No lane carries car telemetry — show headers + empty message then quit.
      const mainArea = el("div", "dh-telem-main");
      const laneCols0 = laneColors(tels);
      const dupNum0 = countsByDriver(tels);
      tels.forEach(function (t, i) {
        mainArea.appendChild(laneHeader(t, laneCols0[i], dupNum0, function (ht) {
          ht.appendChild(el("span", "dh-tsect", "Car telemetry isn't available for this lap."));
        }, laneRole(i) + " · NO DATA"));
      });
      detail.appendChild(mainArea);
      appendStintsPits(mainArea, tels[0] as TelLane);
      return;
    }
    const primary = laps[0];
    const compare = laps[1] || null;
    const laneCols = laneColors(tels);
    const dupNum = countsByDriver(tels);
    // stash for the gauge lane board (built later, out of this scope)
    const _dupForView = dupNum;

    // Main column: driver headers, transport, chart, legend, stints
    const mainArea = el("div", "dh-telem-main");
    // Side column: gauges + map
    const sideArea = el("div", "dh-telem-side");

    tels.forEach(function (t, i) {
      const li = (laps as TelLane[]).indexOf(t);
      mainArea.appendChild(laneHeader(t, laneCols[i], dupNum, function (ht) {
        const lap = t.lap;
        if (!lap) {
          ht.appendChild(el("span", "dh-tsect", "No timed lap found in this session."));
          return;
        }
        if (lap.s1 !== null && lap.s2 !== null && lap.s3 !== null) {
          ht.appendChild(el("span", "dh-tsect",
            "S1 " + lap.s1.toFixed(3) + " · S2 " + lap.s2.toFixed(3) + " · S3 " + lap.s3.toFixed(3)));
        }
        const lapEl = el("span", "dh-tlap",
          (lap.lapNumber !== null ? "L" + lap.lapNumber + " · " : "") + fmtLap(lap.lapDuration));
        lapEl.title = "Fastest lap";
        ht.appendChild(lapEl);
      }, li < 0 ? "NO CAR DATA" : laneRole(li)));
    });

    const view: TelView = {
      laps: laps,
      // laneCols must be indexed the SAME way its consumers read it. The lane
      // HEADERS iterate `tels` (so they use laneCols over tels), but every
      // in-chart consumer (map dots, legend, extra-lane speed dots, delta lines)
      // iterates `view.laps` — the FILTERED array. Re-index laneCols onto `laps`
      // so a dropped middle lane (no car telemetry) doesn't shift every following
      // lane onto the next colour, disagreeing with its own header swatch.
      laneCols: laps.map(function (t) { return laneCols[tels.indexOf(t)] as Rgb; }),
      primary: primary,
      compare: compare,          // already known to carry car telemetry (`laps`)
      multi: laps.length > 2,
      visible: {}, cursorT: 0,
      tMax: 0, speedMax: 1, rpmMax: 1,
      playing: false, rate: 1, _raf: 0, _last: 0, onboard: false,
      chart: null, map: null, delta: null,
      chartBase: null, mapBase: null, deltaBase: null, mapT: null,
      sectors: null, g: null, playBtn: null, a11ySummary: null, updateSummary: null,
      // Assigned just below / once the canvases exist (telemetry-view.js:119-122, 171-172).
      visibleC: {}, colP: undefined, colC: null, _dup: {},
      ratio: 1, cw: 0, ch: 0, dw: 0, dh: 0, mw: 0, mh: 0,
    };
    view.updateSummary = function () { updateTextSummary(view); };
    // per-driver visibility: visible = primary (solid), visibleC = compare (dashed)
    view.visibleC = {};
    CHANNELS.forEach(function (ch) { view.visible[ch.id] = view.visibleC[ch.id] = !ch.off; });
    view.colP = view.laneCols[0]; view.colC = view.laneCols[1] || null;
    view._dup = _dupForView;
    function scan(car: readonly CarSample[]): void {
      for (let i = 0; i < car.length; i++) {
        const c = car[i] as CarSample;
        if (c.t > view.tMax) view.tMax = c.t;
        if ((c.speed || 0) > view.speedMax) view.speedMax = c.speed as number;
        if ((c.rpm || 0) > view.rpmMax) view.rpmMax = c.rpm as number;
      }
    }
    // tMax must span the LONGEST lane, or a slower lane's dot/line would be cut
    // off before the lap ended.
    laps.forEach(function (t) { scan(t.car); });
    view.tMax = view.tMax || 1;
    laps.forEach(function (t) { t.cum = cumDist(t.car); });
    if (primary.lap && primary.lap.s1 !== null && primary.lap.s2 !== null) {
      view.sectors = [primary.lap.s1, primary.lap.s1 + primary.lap.s2];
    }

    // Transport bar → main
    const textSummary = el("details");
    textSummary.appendChild(el("summary", "adv-more-btn", "TEXT SUMMARY"));
    const textSummaryBody = el("p", "dh-live-sub");
    textSummaryBody.id = "dh-telem-summary";
    textSummaryBody.setAttribute("role", "status");
    textSummaryBody.setAttribute("aria-live", "polite");
    textSummaryBody.setAttribute("aria-atomic", "true");
    textSummary.appendChild(textSummaryBody);
    view.a11ySummary = textSummaryBody;
    mainArea.appendChild(textSummary);
    mainArea.appendChild(buildTransport(view));

    const isLS = shortLS();
    const sideW = isLS ? 225 : 0;
    const CW = detail.clientWidth > 40
      ? Math.min(600, Math.max(260, detail.clientWidth - sideW - 28))
      : (isLS ? 360 : 330);
    const CH_CHART = chartH(CW, !!view.compare);

    const c1 = el("canvas", "dh-canvas");
    c1.style.touchAction = "none";
    c1.setAttribute("role", "img");
    c1.setAttribute("aria-label", "Telemetry trace chart for " + view.laps.map(function (t, i) {
      return dcode(t.d) + " (" + laneRole(i).toLowerCase() + ")";
    }).join(", ") + "; drag to scrub.");
    c1.setAttribute("aria-describedby", "dh-telem-summary");
    mainArea.appendChild(c1);
    view.chart = c1;
    // Layout dims live on the view; the buffers carry layout x ratio. Every
    // consumer below reads view.cw/ch/dw/dh/mw/mh, never canvas.width — the
    // buffer dimension stopped being a layout number when DPR joined it.
    view.ratio = viewRatio(c1);
    view.cw = CW; view.ch = CH_CHART;
    sizeCanvas(c1, CW, CH_CHART, view.ratio);
    view.chartBase = makeOffscreen(CW, CH_CHART, view.ratio);

    if (view.compare) {
      const CD_H = deltaH(CW);
      const cd = el("canvas", "dh-canvas dh-delta");
      cd.style.touchAction = "none";
      cd.setAttribute("role", "img");
      cd.setAttribute("aria-label", "Time gap chart between the primary and comparison traces; drag to scrub.");
      cd.setAttribute("aria-describedby", "dh-telem-summary");
      mainArea.appendChild(cd);
      view.delta = cd;
      view.dw = CW; view.dh = CD_H;
      sizeCanvas(cd, CW, CD_H, view.ratio);
      view.deltaBase = makeOffscreen(CW, CD_H, view.ratio);
      attachScrub(cd, view);
    }

    const legend = el("div", "dh-legend");
    if (view.compare) {
      // driver key: each lane's code chip in its own trace/dot colour
      view.laps.forEach(function (t, i) {
        const badge = ((dupNum[String(t.d.num)] as number) > 1 && t.sessionLabel) ? " " + t.sessionLabel : "";
        const chip = el("span", "dh-codechip", dcode(t.d) + badge + " · " + laneRole(i));
        chip.setAttribute("aria-label", dcode(t.d) + " " + laneRole(i).toLowerCase());
        const col = view.laneCols[i];
        chip.style.background = cssColor(col);
        chip.style.color = textColorOn(col);
        legend.appendChild(chip);
      });
    }
    CHANNELS.forEach(function (ch) {
      function toggleBtn(cls: string, on: boolean, title: string): HTMLButtonElement {
        const b = el("button", "dh-legend-item " + cls + (on ? "" : " dh-off"));
        b.type = "button"; b.title = title;
        b.setAttribute("aria-pressed", on ? "true" : "false");
        return b;
      }
      function setState(b: HTMLElement, on: boolean): void {
        b.classList.toggle("dh-off", !on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      }
      const vis = (m: Record<string, boolean>): boolean => !!m[ch.id];
      if (!view.compare) {
        const item = toggleBtn("", vis(view.visible), "Show / hide " + ch.label);
        const dot = el("span", "dh-legend-dot"); dot.style.background = ch.color;
        item.appendChild(dot);
        item.appendChild(document.createTextNode(ch.label));
        item.addEventListener("click", function () {
          view.visible[ch.id] = !view.visible[ch.id];
          setState(item, vis(view.visible));
          buildBases(view); paintFrame(view);
        });
        legend.appendChild(item);
        return;
      }
      const cmp = view.compare;
      const cP = ch.id === "speed" ? cssColor(view.colP) : ch.color;
      const cC = ch.id === "speed" ? cssColor(view.colC) : ch.color;
      const grp = el("span", "dh-leg-group");
      const lbl = toggleBtn("dh-leg-lbl", vis(view.visible) || vis(view.visibleC),
        "Show / hide " + ch.label + " for both drivers");
      lbl.appendChild(document.createTextNode(ch.label));
      const b1 = toggleBtn("dh-leg-line", vis(view.visible),
        "Show / hide " + dcode(view.primary.d) + " " + ch.label + " (solid)");
      const d1 = el("span", "dh-legend-dot"); d1.style.background = cP;
      b1.appendChild(d1);
      const b2 = toggleBtn("dh-leg-line", vis(view.visibleC),
        "Show / hide " + dcode(cmp.d) + " " + ch.label + " (dashed)");
      const d2 = el("span", "dh-legend-dot");
      d2.style.background = "repeating-linear-gradient(90deg, " + cC + " 0 3px, transparent 3px 6px)";
      b2.appendChild(d2);
      function repaint(): void {
        setState(b1, vis(view.visible));
        setState(b2, vis(view.visibleC));
        setState(lbl, vis(view.visible) || vis(view.visibleC));
        buildBases(view); paintFrame(view);
      }
      b1.addEventListener("click", function () { view.visible[ch.id] = !view.visible[ch.id]; repaint(); });
      b2.addEventListener("click", function () { view.visibleC[ch.id] = !view.visibleC[ch.id]; repaint(); });
      lbl.addEventListener("click", function () {
        const on = !(view.visible[ch.id] || view.visibleC[ch.id]);
        view.visible[ch.id] = on; view.visibleC[ch.id] = on;
        repaint();
      });
      grp.appendChild(lbl); grp.appendChild(b1); grp.appendChild(b2);
      legend.appendChild(grp);
    });
    mainArea.appendChild(legend);

    // Gauges + map → side column
    sideArea.appendChild(buildGauges(view));

    if (primary.loc && primary.loc.length > 8) {
      const c2 = el("canvas", "dh-canvas dh-map");
      c2.setAttribute("role", "img");
      c2.setAttribute("aria-label", "Track map for the selected telemetry lanes; dots mark each driver and colour shows speed.");
      c2.setAttribute("aria-describedby", "dh-telem-summary");
      sideArea.appendChild(c2);
      view.map = c2;
      view.mw = 320; view.mh = 320;
      sizeCanvas(c2, 320, 320, view.ratio);
      view.mapBase = makeOffscreen(320, 320, view.ratio);
      // colour key for the car dots on the map
      const mkey = el("div", "dh-maplegend");
      const mchip = function (col: Rgb | undefined, code: string): HTMLElement {
        const item = el("span", "dh-legend-item dh-legend-static");
        const dot = el("span", "dh-legend-dot dh-mapdot"); dot.style.background = cssColor(col);
        item.appendChild(dot); item.appendChild(document.createTextNode(code));
        return item;
      };
      // one map-legend chip per lane, in that lane's colour
      view.laps.forEach(function (t, i) {
        const badge = ((dupNum[String(t.d.num)] as number) > 1 && t.sessionLabel) ? " " + t.sessionLabel : "";
        mkey.appendChild(mchip(view.laneCols[i], dcode(t.d) + badge + " · " + laneRole(i)));
      });
      // track colouring key: slow (blue) -> fast (red), sectors marked S2/S3
      const gi = el("span", "dh-legend-item dh-legend-static");
      gi.appendChild(document.createTextNode("SLOW"));
      gi.appendChild(el("span", "dh-gradbar"));
      gi.appendChild(document.createTextNode("FAST"));
      mkey.appendChild(gi);
      sideArea.appendChild(mkey);
    }

    appendStintsPits(sideArea, primary);

    detail.appendChild(mainArea);
    detail.appendChild(sideArea);

    // currentCSSZoom reads 1 on a detached tree, so the ratio derived above
    // missed any ancestor zoom. Re-derive it now that the canvases are live —
    // otherwise the first paint is wrong-sized and the observer's initial fire
    // rebuilds every layer a second time (the double-build it exists to avoid).
    const liveRatio = viewRatio(c1);
    if (liveRatio !== view.ratio) {
      view.ratio = liveRatio;
      sizeCanvas(c1, view.cw, view.ch, liveRatio);
      view.chartBase = makeOffscreen(view.cw, view.ch, liveRatio);
      if (view.delta) { sizeCanvas(view.delta, view.dw, view.dh, liveRatio); view.deltaBase = makeOffscreen(view.dw, view.dh, liveRatio); }
      if (view.map) { sizeCanvas(view.map, view.mw, view.mh, liveRatio); view.mapBase = makeOffscreen(view.mw, view.mh, liveRatio); }
    }

    attachScrub(c1, view);
    buildBases(view);
    paintFrame(view);
    updateTextSummary(view);
    lifecycle.setView(view);

    // Resize canvases when the popup is resized (e.g. orientation change)
    if (typeof ResizeObserver !== "undefined") {
      let roPending = false;
      const ro = new ResizeObserver(() => {
        if (roPending) return;
        roPending = true;
        requestAnimationFrame(() => {
          roPending = false;
          if (!view.chart || !mainArea.isConnected) return;
          const mainW = mainArea.clientWidth - 32; // minus padding
          if (mainW <= 0) return;

          // Mirror buildTelemetryView's cap and css .dh-canvas's 600 max-width:
          // an 800 cap allocates buffers the stylesheet then downscales,
          // softening the DPR-crisp charts, and a formula mismatch makes the
          // observer's first fire rebuild every layer a second time per open.
          const newCW = Math.min(600, Math.max(260, mainW));
          const newCH = chartH(newCW, !!view.compare);
          // The ratio joins the change test — the house lesson from the circuit
          // detail canvas: a DPR/zoom change under an unchanged box produced an
          // identical key and the early return skipped the refit.
          const newR = viewRatio(view.chart);

          // Read BEFORE the chart branch overwrites view.ratio: the map below compares it too, and
          // a DPR change under an unchanged box would otherwise leave the map at the old ratio.
          const ratioChanged = view.ratio !== newR;
          let resized = false;
          if (view.cw !== newCW || view.ch !== newCH || ratioChanged) {
            view.ratio = newR;
            view.cw = newCW; view.ch = newCH;
            sizeCanvas(view.chart, newCW, newCH, newR);
            view.chartBase = makeOffscreen(newCW, newCH, newR);
            if (view.delta) {
              const dh = deltaH(newCW);
              view.dw = newCW; view.dh = dh;
              sizeCanvas(view.delta, newCW, dh, newR);
              view.deltaBase = makeOffscreen(newCW, dh, newR);
            }
            resized = true;
          }

          if (view.map && sideArea.isConnected) {
            const sideW = sideArea.clientWidth - 24;
            if (sideW > 0 && (view.mw !== sideW || ratioChanged)) {
              view.mw = sideW; view.mh = sideW;
              sizeCanvas(view.map, sideW, sideW, newR);
              view.mapBase = makeOffscreen(sideW, sideW, newR);
              resized = true;
            }
          }

          if (resized) {
            buildBases(view);
            paintFrame(view);
          }
        });   // requestAnimationFrame
      });
      ro.observe(detail);
      view._ro = ro;
    }
  }

  // The offscreen buffer allocates at layout x ratio and pre-transforms its
  // context, so every renderer keeps drawing in LAYOUT px — the same house
  // split the picker preview and minimap use (ratio = min(3, zoom x dpr)).
  function makeOffscreen(w: number, h: number, r: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    r = r || 1;
    c.width = Math.max(1, Math.round(w * r)); c.height = Math.max(1, Math.round(h * r));
    const g = c.getContext("2d");
    if (g) g.setTransform(r, 0, 0, r, 0, 0);
    return c;
  }
  function viewRatio(cv: CanvasZoom | null): number {
    return Math.min(3, Math.max(1, ((cv && cv.currentCSSZoom) || 1) * (window.devicePixelRatio || 1)));
  }
  function sizeCanvas(cv: HTMLCanvasElement, w: number, h: number, r: number): void {
    cv.width = Math.max(1, Math.round(w * r));
    cv.height = Math.max(1, Math.round(h * r));
  }

  function appendStintsPits(detail: HTMLElement, b: TelLane): void {
    const d = b.d;
    const myStints = (b.stints || []).filter(function (s) { return s.num === d.num; });
    if (myStints.length) {
      const sec = el("div", "dh-livecard");
      sec.appendChild(el("h3", "dh-section", "TYRE STINTS"));
      myStints.sort(function (a, c) { return (a.stint || 0) - (c.stint || 0); });
      myStints.forEach(function (s) {
        const row = el("div", "dh-row");
        const label = ctx.compoundChipLabel(s.compound);
        const chip = el("span", "dh-codechip", label);
        if (s.compound) chip.setAttribute("data-compound", String(s.compound));
        chip.style.background = (s.compound && COMPOUND[s.compound]) || "#888";
        chip.style.color = (s.compound === "HARD") ? "#111" : "#fff";
        row.appendChild(chip);
        row.appendChild(el("span", "dh-name", "Laps " + (s.lapStart || "?") + "–" + (s.lapEnd || "?")));
        if (s.age != null) row.appendChild(el("span", "dh-wins", "age " + s.age));
        sec.appendChild(row);
      });
      detail.appendChild(sec);
    }
    const myPits = (b.pits || []).filter(function (p) { return p.num === d.num || p.num === null; });
    if (myPits.length) {
      const sec = el("div", "dh-livecard");
      sec.appendChild(el("h3", "dh-section", "PIT STOPS"));
      myPits.forEach(function (p) {
        const row = el("div", "dh-row");
        row.appendChild(el("span", "dh-pos", "L" + (p.lap != null ? p.lap : "?")));
        row.appendChild(el("span", "dh-name", p.duration != null ? p.duration.toFixed(1) + "s" : "—"));
        sec.appendChild(row);
      });
      detail.appendChild(sec);
    }
  }

  return { buildTelemetryView, pauseAnim };
}
