/**
 * Telemetry transport, scrub interaction, playback, gauges and accessible summary.
 * Ported verbatim from f1-game js/data/telemetry-player.js:1-307
 * (DataTelemetryPlayer):
 *
 *   paintFrame / updateTextSummary   telemetry-player.js:9-39
 *   buildTransport                   telemetry-player.js:41-80
 *   buildBrakingDuel                 telemetry-player.js:82-114
 *   setPlayLabel / buildGauges       telemetry-player.js:115-191
 *   updateGauges                     telemetry-player.js:192-232
 *   attachScrub                      telemetry-player.js:234-277
 *   playAnim / pauseAnim             telemetry-player.js:279-300
 *
 * External: CssZoom.viewportRect (f1-game js/ui/css-zoom.js:41-46) belongs to
 * the shell lane; until it is ported, viewportRect below falls back to
 * getBoundingClientRect, which is what f1-game does when CssZoom is absent.
 */
import type { HubDeps } from "../../hub-deps";
import {
  PADL, PADR, brakingDuel, clamp, dcode, distAtT, drsOpen, laneRole, sampleAt, signed,
  summaryTime, summaryValue, timeAtDist,
  type CarLane, type Gauges, type TelView,
} from "./model";
import type { CarSample } from "../../api";

/** Only paintFrame of the renderer is used here (telemetry-player.js:5,10). */
export interface FramePainter { paintFrame(view: TelView): void }

export interface TelemetryPlayer {
  buildTransport(view: TelView): HTMLElement;
  buildGauges(view: TelView): HTMLElement;
  attachScrub(canvas: HTMLCanvasElement, view: TelView): void;
  pauseAnim(view: TelView): void;
  paintFrame(view: TelView): void;
  updateTextSummary(view: TelView): void;
}

// TODO(lane-shell): use the shell's CssZoom.viewportRect (js/ui/css-zoom.js:41)
// once it is ported; it scales the rect when the engine reports unzoomed boxes.
function viewportRect(canvas: HTMLElement): DOMRect {
  return canvas.getBoundingClientRect();
}

export function create({ el, cssColor }: Pick<HubDeps, "el" | "cssColor">, renderer: FramePainter): TelemetryPlayer {
  function paintFrame(view: TelView): void {
    renderer.paintFrame(view);
    updateGauges(view);
  }

  function updateTextSummary(view: TelView): void {
    if (!view || !view.a11ySummary) return;
    const selected = view.laps.map(function (t, i) {
      return dcode(t.d) + " (" + laneRole(i).toLowerCase() + ")";
    }).join(", ");
    const bits = ["Selected drivers: " + (selected || "none") + ".",
      "Time " + summaryTime(view.cursorT) + "."];
    view.laps.forEach(function (lane, i) {
      // The full text is useful to assistive technology and also gives the
      // parent CSS a stable, concise diagnostic line without putting dynamic
      // values into the canvas bitmap.
      const c = sampleAt(lane.car, view.cursorT === null ? 0 : view.cursorT);
      if (!c) {
        bits.push(dcode(lane.d) + ": no current sample.");
        return;
      }
      bits.push(dcode(lane.d) + " " + laneRole(i).toLowerCase() + ": " +
        "speed " + summaryValue(c.speed, " km/h") + ", gear " +
        (typeof c.gear === "number" && isFinite(c.gear) ? (c.gear ? "G" + c.gear : "N") : "—") +
        ", throttle " + summaryValue(c.throttle, "%") + ", brake " + summaryValue(c.brake, "%") +
        ", rpm " + summaryValue(c.rpm, "") + ", DRS " +
        (c.drs == null ? "—" : (drsOpen(c.drs) ? "open" : "closed")) + ".");
    });
    if (view.laps.length > 2) bits.push("Additional lanes are speed markers only.");
    view.a11ySummary.textContent = bits.join(" ");
  }

  function buildTransport(view: TelView): HTMLElement {
    const bar = el("div", "dh-transport");
    const play = el("button", "dh-tbtn dh-tplay", "▶ PLAY");
    play.type = "button";
    play.addEventListener("click", function () { if (view.playing) pauseAnim(view); else playAnim(view); });
    view.playBtn = play;
    const restart = el("button", "dh-tbtn dh-trestart", "⏮");
    restart.type = "button"; restart.title = "Restart lap";
    restart.addEventListener("click", function () { view.cursorT = 0; view._last = 0; paintFrame(view); if (view.updateSummary) view.updateSummary(); });
    bar.appendChild(play); bar.appendChild(restart);

    const rates = el("div", "dh-trates");
    [1, 2, 4].forEach(function (r) {
      const b = el("button", "dh-ratebtn" + (r === view.rate ? " active" : ""), r + "×");
      b.type = "button";
      b.addEventListener("click", function () {
        view.rate = r;
        const bs = rates.querySelectorAll(".dh-ratebtn");
        for (let i = 0; i < bs.length; i++) (bs[i] as Element).classList.toggle("active", bs[i] === b);
      });
      rates.appendChild(b);
    });
    bar.appendChild(rates);

    if (view.primary.loc && view.primary.loc.length > 8) {
      const ob = el("button", "dh-tbtn dh-onboard", "ONBOARD");
      ob.type = "button";
      ob.title = "Rotate the map so the car always points up";
      ob.addEventListener("click", function () {
        view.onboard = !view.onboard;
        ob.classList.toggle("dh-tplaying", view.onboard);
        paintFrame(view);
      });
      bar.appendChild(ob);
    }

    bar.appendChild(el("span", "dh-thint", "drag chart to scrub"));
    if (view.compare) bar.appendChild(buildBrakingDuel(view));
    return bar;
  }

  function buildBrakingDuel(view: TelView): HTMLElement {
    const compare = view.compare as CarLane;
    const panel = el("details", "dh-thint"); panel.appendChild(el("summary", null, "BRAKING ZONE DUEL"));
    panel.appendChild(el("p", null, "Speed-integrated distance estimate. Two loaded lanes, sampled at equal distance. Brake: 10% → 20%; throttle after braking: 70% → 90%; two distinct consecutive feed samples required. Observed changes do not isolate their cause."));
    const inputs: HTMLInputElement[] = [];
    ["Zone start (metres)", "Zone end (metres)"].forEach(function (label, i) {
      const wrap = el("label"); wrap.appendChild(el("span", null, label));
      const input = el("input"); input.type = "number"; input.min = "0"; input.step = "1";
      input.value = i ? "300" : "0"; input.setAttribute("aria-label", label); wrap.appendChild(input); panel.appendChild(wrap); inputs.push(input);
    });
    const result = el("div"); result.setAttribute("role", "status"); panel.appendChild(result);
    function refresh(): void {
      while (result.firstChild) result.removeChild(result.firstChild);
      const analysis = brakingDuel(view.primary, view.compare, +(inputs[0] as HTMLInputElement).value, +(inputs[1] as HTMLInputElement).value);
      if (!analysis.available) { result.appendChild(el("p", null, analysis.reason)); return; }
      result.appendChild(el("p", null, "Observed delta change (comparison minus primary): " + signed(analysis.change, 3) + "s"));
      analysis.lanes.forEach(function (lane, i) {
        result.appendChild(el("p", null, dcode((i ? compare : view.primary).d)));
        ([["Brake onset", lane.brake], ["Minimum speed", lane.minSpeed], ["Throttle recovery", lane.throttle]] as const).forEach(function (entry) {
          if (!entry[1]) { result.appendChild(el("span", null, entry[0] + ": unavailable. ")); return; }
          const metric: { distance: number; value?: number } = entry[1];
          const button = el("button", "dh-tbtn", entry[0] + ": " + Math.round(metric.distance) + "m" + (metric.value === undefined ? "" : " · " + Math.round(metric.value) + " km/h"));
          button.type = "button";
          button.addEventListener("click", function () {
            pauseAnim(view);
            // The shared chart/map cursor is the primary lane's clock.
            view.cursorT = timeAtDist(view.primary.cum, metric.distance); view._last = 0; paintFrame(view);
            if (view.updateSummary) view.updateSummary();
          });
          result.appendChild(button);
        });
      });
    }
    inputs.forEach(function (input) { input.addEventListener("change", refresh); }); refresh(); return panel;
  }
  function setPlayLabel(view: TelView): void {
    if (!view.playBtn) return;
    view.playBtn.textContent = view.playing ? "⏸ PAUSE" : "▶ PLAY";
    view.playBtn.classList.toggle("dh-tplaying", view.playing);
  }

  function buildGauges(view: TelView): HTMLElement {
    const card = el("div", "dh-dash");
    const cmp = view.compare;
    function valCell(cls: string, label: string): HTMLElement[] {
      const w = el("div", "dh-gcell " + cls);
      w.appendChild(el("div", "dh-glabel", label));
      if (!cmp) {
        const v = el("div", "dh-gval", "—"); w.appendChild(v);
        card.appendChild(w); return [v];
      }
      const row = el("div", "dh-gvalrow");
      const v1 = el("span", "dh-gval", "—"); v1.style.color = cssColor(view.colP);
      const v2 = el("span", "dh-gval dh-gval2", "—"); v2.style.color = cssColor(view.colC);
      row.appendChild(v1); row.appendChild(v2);
      w.appendChild(row); card.appendChild(w); return [v1, v2];
    }
    function barCell(cls: string, label: string, color: string): HTMLElement[] {
      const w = el("div", "dh-gcell " + cls);
      w.appendChild(el("div", "dh-glabel", label));
      const out: HTMLElement[] = [];
      const track = el("div", "dh-gbar");
      const fill = el("div", "dh-gfill"); fill.style.background = color;
      track.appendChild(fill); w.appendChild(track); out.push(fill);
      if (cmp) {
        const track2 = el("div", "dh-gbar dh-gbar2");
        const fill2 = el("div", "dh-gfill dh-gfill2"); fill2.style.background = color;
        track2.appendChild(fill2); w.appendChild(track2); out.push(fill2);
      }
      card.appendChild(w); return out;
    }
    const speed = valCell("dh-gspeed", "SPEED km/h");
    const gear = valCell("dh-ggear", "GEAR");
    const thr = barCell("dh-gthr", "THROTTLE", "#3fb950");
    const brk = barCell("dh-gbrk", "BRAKE", "#ff4d4d");
    const rpm = barCell("dh-grpm", "RPM", "#c084fc");
    const drsCell = el("div", "dh-gcell dh-gdrscell");
    drsCell.appendChild(el("div", "dh-glabel", "DRS"));
    const drs0 = el("div", "dh-gdrs-pill", "—");
    const g: Gauges = { speed, gear, thr, brk, rpm, drs: [drs0] };
    drsCell.appendChild(drs0);
    if (cmp) {
      const p2 = el("div", "dh-gdrs-pill dh-gdrs2", "—");
      drsCell.appendChild(p2); g.drs.push(p2);
    }
    card.appendChild(drsCell);
    if (cmp) {
      const dcell = el("div", "dh-gcell dh-gdeltacell");
      dcell.appendChild(el("div", "dh-glabel", "Δ " + dcode(cmp.d)));
      g.delta = el("div", "dh-gval dh-gdelta", "—");
      dcell.appendChild(g.delta); card.appendChild(dcell);
    }
    if (view.multi) {
      const board = el("div", "dh-laneboard");
      const rows: NonNullable<Gauges["board"]> = [];
      g.board = rows;
      view.laps.forEach(function (t, i) {
        const row = el("div", "dh-laneboard-row");
        const dot = el("span", "dh-legend-dot dh-mapdot"); dot.style.background = cssColor(view.laneCols[i]);
        row.appendChild(dot);
        const badge = (view._dup && (view._dup[String(t.d.num)] as number) > 1 && t.sessionLabel) ? " " + t.sessionLabel : "";
        row.appendChild(el("span", "dh-laneboard-code", dcode(t.d) + badge));
        const spd = el("span", "dh-laneboard-spd", "—");
        const dl = el("span", "dh-laneboard-dl", i === 0 ? "REF" : "—");
        row.appendChild(spd); row.appendChild(dl);
        board.appendChild(row);
        rows.push({ spd: spd, dl: dl, ref: i === 0 });
      });
      card.appendChild(board);
    }
    view.g = g;
    return card;
  }
  function updateGauges(view: TelView): void {
    const g = view.g; if (!g) return;
    const t = view.cursorT === null ? 0 : view.cursorT;
    const cars: (CarSample | null)[] = [sampleAt(view.primary.car, t),
                  view.compare ? sampleAt(view.compare.car, t) : null];
    if (!cars[0]) return;
    for (let i = 0; i < g.speed.length; i++) {
      const c = cars[i]; if (!c) continue;
      (g.speed[i] as HTMLElement).textContent = c.speed === null ? "—" : String(Math.round(c.speed));
      (g.gear[i] as HTMLElement).textContent = (c.gear == null) ? "—" : (c.gear ? "G" + c.gear : "N");
      (g.thr[i] as HTMLElement).style.width = (c.throttle === null ? 0 : clamp(c.throttle, 0, 100)) + "%";
      (g.brk[i] as HTMLElement).style.width = (c.brake === null ? 0 : clamp(c.brake, 0, 100)) + "%";
      (g.rpm[i] as HTMLElement).style.width = (c.rpm === null ? 0 : clamp(c.rpm / view.rpmMax * 100, 0, 100)) + "%";
      const open = c.drs != null && drsOpen(c.drs);
      (g.drs[i] as HTMLElement).textContent = open ? "OPEN" : "—";
      (g.drs[i] as HTMLElement).classList.toggle("dh-on", open);
    }
    // Once the reference finishes, its distance and gap clock must stop together.
    const refT = Math.min(t, view.primary.cum.t[view.primary.cum.t.length - 1] as number);
    if (g.delta && view.compare) {
      const dP = distAtT(view.primary.cum, refT);
      const delta = timeAtDist(view.compare.cum, dP) - refT;   // >0: compare is behind
      g.delta.textContent = isFinite(delta) ? signed(delta, 2) + "s" : "—";
      g.delta.classList.toggle("dh-pos", delta > 0.02);
      g.delta.classList.toggle("dh-neg", delta < -0.02);
    }
    // lane board (3-4 lanes): live speed + gap to the reference for every lane
    const board = g.board;
    if (board) {
      const dRef = distAtT(view.primary.cum, refT);
      view.laps.forEach(function (lane, i) {
        const cell = board[i]; if (!cell) return;
        const cc = sampleAt(lane.car, t);
        cell.spd.textContent = (cc && cc.speed !== null) ? String(Math.round(cc.speed)) : "—";
        if (cell.ref) return;
        const dl = timeAtDist(lane.cum, dRef) - refT;   // >0: this lane is behind the ref
        cell.dl.textContent = isFinite(dl) ? signed(dl, 2) : "—";
        cell.dl.classList.toggle("dh-pos", dl > 0.02);
        cell.dl.classList.toggle("dh-neg", dl < -0.02);
      });
    }
  }

  // drag the trace chart to scrub (pauses playback)
  function attachScrub(canvas: HTMLCanvasElement, view: TelView): void {
    let srect: DOMRect | null = null;   // measured once per drag: the canvas is pointer-captured, it cannot move mid-gesture
    function at(ev: PointerEvent): void {
      const r = srect || viewportRect(canvas);
      // map into bitmap px, then invert the plot-area (axis gutter) transform
      // view.cw, NOT canvas.width: the buffer is layout x ratio now, while
      // PADL/PADR and chartX speak layout px. Chart and delta share one width.
      const bx = (ev.clientX - r.left) / (r.width || 1) * view.cw;
      view.cursorT = clamp((bx - PADL) / ((view.cw - PADL - PADR) || 1), 0, 1) * view.tMax;
      paintFrame(view);
    }
    /* ONE POINTER OWNS THE SCRUB, AND IT HAS TO SURVIVE A CANCEL.
       `ev.buttons` is the mouse's question — a touch drag reports 1 while down,
       which worked, but nothing here released the capture or noticed the drag
       being taken away. On iPadOS the hub's own scroller claims a vertical drag
       over the chart and Safari answers with `pointercancel` and no
       `pointerup`, so the scrub died mid-gesture and the panel scrolled
       instead. `touch-action: none` on the canvas (css/data.css) is what
       actually stops that claim — setPointerCapture never did — and tracking
       the pointerId is what keeps a second finger from yanking the cursor. */
    let pid: number | null = null;
    canvas.addEventListener("pointerdown", function (ev) {
      if (pid !== null) return;
      pid = ev.pointerId;
      pauseAnim(view);
      try { if (canvas.setPointerCapture) canvas.setPointerCapture(pid); } catch { /* no active pointer to capture */ }
      srect = viewportRect(canvas);
      at(ev);
    });
    canvas.addEventListener("pointermove", function (ev) {
      if (ev.pointerId !== pid) return;
      at(ev);
    });
    function endScrub(ev: PointerEvent | null): void {
      if (pid === null || (ev && ev.pointerId !== pid)) return;
      try { if (canvas.releasePointerCapture) canvas.releasePointerCapture(pid); } catch { /* already released */ }
      pid = null; srect = null;
      if (view.updateSummary) view.updateSummary();
    }
    canvas.addEventListener("pointerup", endScrub);
    canvas.addEventListener("pointercancel", endScrub);
    canvas.addEventListener("lostpointercapture", endScrub);
  }

  function playAnim(view: TelView): void {
    if (view.playing) return;
    if (view.cursorT === null || view.cursorT >= view.tMax) view.cursorT = 0;
    view.playing = true; view._last = 0; setPlayLabel(view);
    view._raf = requestAnimationFrame(function step(ts) {
      if (!view.playing) return;
      if (!view._last) view._last = ts;
      const dt = (ts - view._last) / 1000; view._last = ts;
      let nt = (view.cursorT || 0) + dt * view.rate;
      if (nt >= view.tMax) nt = 0;        // loop the lap
      view.cursorT = nt;
      paintFrame(view);
      view._raf = requestAnimationFrame(step);
    });
  }
  function pauseAnim(view: TelView): void {
    if (!view.playing) return;
    view.playing = false;
    if (view._raf) { cancelAnimationFrame(view._raf); view._raf = 0; }
    setPlayLabel(view);
    if (view.updateSummary) view.updateSummary();
  }

  return { buildTransport, buildGauges, attachScrub, pauseAnim, paintFrame, updateTextSummary };
}
