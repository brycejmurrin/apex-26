/**
 * Minimal race HUD: speed, gear, lap, lap time, last lap (PLAN T1.10).
 *
 * DOM writes are throttled two ways, as f1-game's HUD does:
 * - write-on-change: `text()` keeps the last string per element and only
 *   touches `textContent` when it differs (js/ui/hud.js:76 `hText`);
 * - a refresh interval: the readouts are recomputed at most every
 *   `intervalMs` (default 1/15 s), so a 144 Hz display does not pay for 144
 *   string builds and text writes a second.
 * No reads of layout (offsetWidth, getBoundingClientRect) happen here, so the
 * HUD cannot force a reflow.
 */
import { fmtTime, gearText, spdDigits, spdUnit, type SpeedUnits } from "./readouts";

export interface HudState {
  /** Shown speed in dash km/h (readouts.dashKph). */
  readonly kph: number;
  readonly gear: number;
  readonly lap: number;
  /** Total laps, or 0 for an open session (time trial). */
  readonly laps: number;
  readonly lapTime: number;
  readonly last: number;
  readonly best: number;
}

export class Hud {
  readonly root: HTMLElement;
  private readonly el: Record<"speed" | "unit" | "gear" | "lap" | "time" | "last" | "best", HTMLElement>;
  private readonly cache = new Map<HTMLElement, string>();
  private lastPaint = -Infinity;

  constructor(parent: HTMLElement, private readonly units: SpeedUnits = "kmh", private readonly intervalMs = 1000 / 15) {
    const doc = parent.ownerDocument;
    this.root = doc.createElement("div");
    this.root.id = "hud";
    this.root.innerHTML =
      '<div class="hud-spd"><span data-k="speed">0</span><small data-k="unit"></small></div>' +
      '<div class="hud-gear" data-k="gear">N</div>' +
      '<dl class="hud-times">' +
      "<dt>LAP</dt><dd data-k=\"lap\">-</dd>" +
      "<dt>TIME</dt><dd data-k=\"time\">-</dd>" +
      "<dt>LAST</dt><dd data-k=\"last\">-</dd>" +
      "<dt>BEST</dt><dd data-k=\"best\">-</dd>" +
      "</dl>";
    const q = (k: string): HTMLElement => this.root.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
    this.el = { speed: q("speed"), unit: q("unit"), gear: q("gear"), lap: q("lap"), time: q("time"), last: q("last"), best: q("best") };
    this.text(this.el.unit, spdUnit(units));
    parent.appendChild(this.root);
  }

  /** Paint `s` if the refresh interval has passed (or `force`). Returns whether it painted. */
  update(s: HudState, nowMs: number, force = false): boolean {
    if (!force && nowMs - this.lastPaint < this.intervalMs) return false;
    this.lastPaint = nowMs;
    this.text(this.el.speed, String(spdDigits(s.kph, this.units)));
    this.text(this.el.gear, gearText(s.gear));
    this.text(this.el.lap, s.lap <= 0 ? "OUT" : s.laps > 0 ? `${s.lap}/${s.laps}` : String(s.lap));
    this.text(this.el.time, s.lap <= 0 ? "-" : fmtTime(s.lapTime));
    this.text(this.el.last, fmtTime(s.last));
    this.text(this.el.best, fmtTime(s.best));
    return true;
  }

  setVisible(on: boolean): void { this.root.hidden = !on; }

  private text(el: HTMLElement, v: string): void {
    if (this.cache.get(el) === v) return;
    this.cache.set(el, v);
    el.textContent = v;
  }
}
