/**
 * The transform-only DOM painter for overlay.html: a timing tower, the battle
 * box, sector times and a caption, all fed by OverlayFeed frames.
 * Port of f1-game js/overlay/render.js:1-149 (OverlayRender). The demo's
 * TvGraphics preview (render.js:117-131) waits for the race lane's
 * tv-graphics port. TODO(lane-race).
 */
import { frame as feedFrame, type OverlayFrame, type OverlayPatch } from "./feed";

export const MAX_ROWS = 20;
const ROW_PX = 34;

export type Chroma = "green" | "blue" | "magenta" | "";

export interface OverlayOptions {
  readonly scale: number;
  readonly rows: number;
  readonly side: "left" | "right";
  readonly chroma: Chroma;
  readonly demo: boolean;
  readonly only: "captions" | "";
}

/** `?scale=0.5..2&rows=1..20&side=right&chroma=green|blue|magenta&demo=1&only=captions` (render.js:7-14). */
export function options(search: string | null | undefined): OverlayOptions {
  const q = new URLSearchParams(search || "");
  const scale = Math.min(2, Math.max(0.5, Number(q.get("scale")) || 1));
  const rows = Math.min(MAX_ROWS, Math.max(1, Number(q.get("rows")) | 0 || MAX_ROWS));
  const side = q.get("side") === "right" ? "right" : "left";
  const c = q.get("chroma");
  const chroma: Chroma = c === "green" || c === "blue" || c === "magenta" ? c : "";
  return { scale, rows, side, chroma, demo: q.get("demo") === "1", only: q.get("only") === "captions" ? "captions" : "" };
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
}

function text(el: Element, value: unknown): void {
  const next = value == null ? "" : String(value);
  if (el.textContent !== next) el.textContent = next;
}

interface RowEls {
  el: HTMLDivElement;
  pos: HTMLElement;
  team: HTMLElement;
  code: HTMLElement;
  gap: HTMLElement;
  tyre: HTMLElement;
  key: string;
}

export interface Painter {
  /** Paint a full frame or a differ patch; false when it is not a v1 frame. */
  paint(frame: OverlayFrame | OverlayPatch | null | undefined): boolean;
  readonly rows: readonly RowEls[];
}

function must<T extends Element>(root: ParentNode, sel: string): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error("overlay: missing " + sel);
  return el;
}

export function create(root: ParentNode, config: Partial<OverlayOptions> = {}): Painter {
  const limit = Math.min(MAX_ROWS, Math.max(1, (config.rows ?? 0) | 0 || MAX_ROWS));
  const tower = must<HTMLElement>(root, ".ov-tower");
  const battle = must<HTMLElement>(root, ".ov-battle");
  const sectors = must<HTMLElement>(root, ".ov-sectors");
  const caption = must<HTMLElement>(root, ".ov-caption");
  const rows: RowEls[] = [];
  for (let i = 0; i < MAX_ROWS; i++) {
    const el = node("div", "ov-row");
    const pos = node("b", "ov-pos");
    const team = node("i", "ov-team");
    const code = node("strong", "ov-code");
    const gap = node("span", "ov-gap");
    const tyre = node("em", "ov-tyre");
    el.append(pos, team, code, gap, tyre);
    el.hidden = i >= limit;
    tower.appendChild(el);
    rows.push({ el, pos, team, code, gap, tyre, key: "" });
  }
  const battleWho = must<HTMLElement>(battle, "strong");
  const battleGap = must<HTMLElement>(battle, "span");
  const sec = sectors.querySelectorAll<HTMLElement>("span");
  const capWho = must<HTMLElement>(caption, "strong");
  const capText = must<HTMLElement>(caption, "span");

  function paint(f: OverlayFrame | OverlayPatch | null | undefined): boolean {
    if (!f || f.v !== 1) return false;
    const list = f.rows || [];
    for (let i = 0; i < rows.length; i++) {
      const out = rows[i] as RowEls;
      const row = list[i];
      out.el.hidden = i >= limit || !row;
      if (!row || i >= limit) continue;
      const key = [row.pos, row.code, row.team, row.interval, row.tyre, row.pit, row.you].join("|");
      // Transform-only: a reorder slides the row, nothing reflows.
      out.el.style.transform = "translate3d(0," + (Math.max(1, row.pos) - 1) * ROW_PX + "px,0)";
      if (key === out.key) continue;
      out.key = key;
      text(out.pos, row.pos);
      text(out.code, row.code);
      text(out.gap, row.pos === 1 ? "LEADER" : row.pit ? "PIT" : row.interval == null ? "" : "+" + Number(row.interval).toFixed(2));
      text(out.tyre, row.tyre || "");
      out.team.style.background = row.team || "";
      out.el.dataset["you"] = row.you ? "1" : "";
    }
    if (f.battle !== undefined) {
      battle.hidden = !f.battle;
      if (f.battle) {
        text(battleWho, f.battle.ahead + "  ·  " + f.battle.behind);
        text(battleGap, Number(f.battle.gapS).toFixed(2) + "s");
      }
    }
    if (f.sectors && f.sectors.last) {
      for (let i = 0; i < sec.length; i++) {
        const el = sec[i] as HTMLElement;
        const s = f.sectors.last[i];
        text(el, !s || s.value == null ? "S" + (i + 1) : s.glyph + Number(s.value).toFixed(3));
        el.dataset["tone"] = (s && s.tone) || "";
      }
    }
    if (f.caption !== undefined) {
      caption.hidden = !f.caption;
      if (f.caption) {
        text(capWho, f.caption.n ? f.caption.n + "  " + f.caption.who : f.caption.who);
        text(capText, f.caption.text);
        caption.dataset["kind"] = f.caption.kind || "";
      }
    }
    return true;
  }

  return { paint, rows };
}

/** The `?demo=1` loop: a two-car battle that swaps leaders every 4 s (render.js:96-110). */
export function demoFrame(elapsed: number): OverlayFrame {
  const phase = Math.floor(elapsed / 4) % 2;
  const leader = { code: phase ? "NOR" : "LEC", pos: 1, prog: 5050, speed: 76, team: phase ? "#ff8700" : "#e8002d" };
  const chaser = { code: phase ? "LEC" : "NOR", pos: 2, prog: 4996, speed: 76, team: phase ? "#e8002d" : "#ff8700", you: true };
  const ranked = [
    leader,
    chaser,
    { code: "VER", pos: 3, prog: 4870, speed: 74, team: "#3671c6" },
    { code: "RUS", pos: 4, prog: 4710, speed: 72, team: "#27f4d2" },
    { code: "PIA", pos: 5, prog: 4590, speed: 73, team: "#ff8700" },
  ];
  return feedFrame({
    seq: Math.floor(elapsed * 4),
    t: elapsed,
    state: "race",
    track: "monza",
    lap: 18,
    laps: 53,
    flag: "green",
    ranked,
    sectorLast: [25.104, 28.471, 23.992],
    sectorBests: [25.104, 28.471, 23.8],
    fieldSectorBests: [25.104, 28.2, 23.7],
    caption: elapsed % 8 < 4 ? { id: "demo-" + Math.floor(elapsed / 8), n: "04", who: "NOR", text: "That was a decisive move.", kind: "radio" } : null,
  });
}

/** Mount on `main#overlay[role=region]` with the page's query options (render.js:112-145). */
export function boot(doc: Document = document, search: string = location.search): Painter | null {
  const root = doc.querySelector<HTMLElement>('main#overlay[role="region"]');
  if (!root) return null;
  const config = options(search);
  doc.documentElement.dataset["chroma"] = config.chroma;
  doc.body.dataset["side"] = config.side;
  doc.body.dataset["only"] = config.only;
  root.style.setProperty("--ov-scale", String(config.scale));
  const painter = create(root, config);
  if (!config.demo) {
    painter.paint(
      feedFrame({ seq: 0, state: "waiting", ranked: [], caption: { id: "waiting", who: "APEX 26", text: "Waiting for a broadcast feed", kind: "status" } }),
    );
    return painter;
  }
  const started = performance.now();
  const paint = (): void => void painter.paint(demoFrame((performance.now() - started) / 1000));
  paint();
  setInterval(paint, 250);
  return painter;
}
