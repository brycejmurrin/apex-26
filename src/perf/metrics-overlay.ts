/**
 * GameMetrics: toggleable in-game FPS / car / log overlay. Ported from f1-game
 * js/perf/metrics-overlay.js:1-1196. The IIFE (module state, DOMContentLoaded
 * self-init, timer-polled submenu build) became `createGameMetrics(deps)` plus
 * `mount(host, deps)`; every global it read (GameStore, PerfGov, LoopHealth,
 * __apex, RendererPicker, GLX, Log, SettingRow, UiLayers, GameAudio) arrives
 * in `deps`.
 *
 * SETTINGS > DISPLAY — METRICS (on/off), PAGE (gov/car/phys/log), SIDE
 * (auto/left/right), SIZE (s/m/l), LOG NS, and LOG SHOW, folded into one
 * METRICS <details> submenu `mount()` builds into the host it is given. Log
 * filters stay hidden unless PAGE is LOG. Or ` (backtick) / F9. Persists as
 * a26.metrics. URL `?metrics=1` overrides for the session without writing
 * storage.
 *
 * WHY ITS OWN MODULE. This is not a quality tier. The overlay is DOM the player
 * asked for, so it lives next to the other injected SETTINGS rows rather than
 * growing the shell. The panel is created at runtime — no index.html node.
 * Layout lives in ./perf.css (#game-metrics + #game-metrics-bar). AUTO side is
 * left on a short/narrow viewport so the panel cannot cover the right dock.
 * SIZE defaults to S; the bar's S/M/L chip and the SETTINGS row cycle it.
 *
 * Tick is its own rAF at ~4 Hz. It never runs when OFF, and it never logs per
 * frame. Turning ON raises the Log BUFFER to debug for the session (when a
 * MetricsLog is injected) so the overlay's tail actually fills.
 *
 * Pages stay on the canvas (no clipboard). ` / F9 toggles. While ON, [ ] cycle
 * GOV/CAR/PHYS/LOG; 1–4 jump to a page; on LOG, - = cycle namespace and ;
 * cycles the display level.
 *
 * DROPPED as f1-game-backend-specific: the GOV page's `tlx` line (TLX blit /
 * readback / pack / heal / matMode counters), RendererPicker.liveBackend and
 * the apex26.gfxBackend pick. The `gfx` row now shows the bound three.js
 * backend (WebGPU / WebGL2) as `backend` and its boot reason (auto, webkit,
 * pin-webgl, …) as `gfxApi`, from src/render/boot.ts.
 * `setTelemetryLoader` (f1-game's lazy __apex agent surface) became the
 * `sources` object: the shell passes what exists, the rest paints "—".
 */
import { localRawStore, perfLog, type RawStore } from "./env";
import type { FrameStats } from "./governor";
import type { LoopHealthState } from "./loop-health";
import type { RowValues, SettingRowApi } from "./setting-row";

export const KEY = "a26.metrics";
export const PAGE_KEY = "a26.metricsPage";
export const POS_KEY = "a26.metricsPos";
export const SIZE_KEY = "a26.metricsSize";
export const LOG_NS_KEY = "a26.metricsLogNs";
export const LOG_LVL_KEY = "a26.metricsLogLvl";
const PAINT_MS = 250;
export const PAGES = ["gov", "car", "phys", "log"] as const;
export const POSITIONS = ["auto", "left", "right"] as const;
export const SIZES = ["s", "m", "l"] as const;
export const LOG_NS = ["*", "track", "gfx", "game", "scenery", "car", "ui", "input", "net", "data", "audio", "assets"] as const;
export const LOG_LVLS = ["warn", "info", "debug"] as const;
export type Page = (typeof PAGES)[number];
export type Pos = (typeof POSITIONS)[number];
export type Size = (typeof SIZES)[number];

/** f1-game __apex.perf() / renderScale() (js/agent/apex.js:1623), as ./governor.ts renderScaleReport() builds it. */
export interface PerfReading {
  fps?: number | null;
  floorMs?: number | null;
  scale?: number | null;
  tier?: number | null;
  auto?: boolean | null;
  crashStrikes?: number | null;
  tierFloor?: number | null;
}

/** Everything the snapshot reads. Each one optional: a missing source paints "—". */
export interface MetricsSources {
  perf?: () => PerfReading | null;
  gpuTimer?: () => { ms?: number | null } | null;
  /** The bound backend and boot reason (src/render/boot.ts). TODO(lane-render). */
  backend?: () => { name: string; reason?: string } | null;
  gpuErrors?: () => { count: number; first?: string } | null;
  info?: () => { state?: string; track?: string; session?: string; flow?: string; lapsTarget?: number; raceQuali?: boolean; career?: boolean; turns?: number } | null;
  timing?: () => Partial<Record<"lap" | "pos" | "total" | "gear" | "energy" | "lapTime" | "best" | "lastLap" | "raceT" | "gapAhead" | "gapBehind" | "aeroX" | "sector", number | null>> | null;
  probe?: () => Partial<Record<"speed" | "s" | "x" | "angle" | "k" | "hw", number>> | null;
  physState?: () => Record<string, unknown> | null;
  camera?: () => { mode?: string } | null;
  caution?: () => { label?: string } | null;
  /** The HUD's painted km/h digit (f1-game #hud-speed-n). */
  dashKph?: () => number | null;
}

/** f1-game js/core/log.js, the part the LOG page reads. TODO(lane-shell): the shared logger. */
export interface MetricsLog {
  level(spec?: string): { console?: string; buffer?: string; bufferNs?: Record<string, string> };
  records(filter?: { ns?: string; level?: string; limit?: number }): { level: string; ns: string; msg: string }[];
  readonly LEVELS: Record<string, number>;
  readonly DEBUG: number;
}

export interface GameMetricsDeps {
  store?: RawStore;
  search?: () => string;
  gov?: { fpsEMA(): number; floorMs(): number; tier(): number; frameStats(): FrameStats; resetFrameStats(): void } | null;
  loop?: { state(): LoopHealthState } | null;
  sources?: MetricsSources;
  log?: MetricsLog | null;
  settingRow?: SettingRowApi | null;
  uiSelect?: () => void;
  /** A menu layer is open (f1-game UiLayers.anyOpen): page keys stand down. */
  menusOpen?: () => boolean;
  /** HUD profile (f1-game GameStore "hudProfile"): "minimal" compacts the panel. */
  hudProfile?: () => string;
  /** Where #game-metrics goes (default document.body). */
  panelHost?: HTMLElement;
}

// Physics fields the PHYS page shows, named as the debug API's physState() returns them.
const PHYS_FIELDS = ["slipDeg", "vLat", "yawRate", "slipFactor", "axEstSm", "axFrac", "slope", "wrongWay", "rescueT", "head",
  "vmaxNow", "aeroGrip", "aeroDf", "xOn", "xArmed", "aeroLoad", "towing", "xVmaxGain", "xDfLoss", "drain", "regen",
  "brakeBias", "otTime", "otMJ"] as const;
type PhysField = (typeof PHYS_FIELDS)[number];
type Val = number | boolean | string | null;

export interface MetricsSnapshot extends Record<PhysField, Val> {
  on: boolean; page: Page; logNs: string; logLvl: string;
  fps: number | null; ms: number | null; budget: number | null; scale: number | null; tier: number | null; backend: string;
  auto: boolean | null; strikes: number | null; tierFloor: number | null; gpuMs: number | null; loopStopped: boolean | null; loopFrames: number | null;
  gfxApi: string; gpuErr: number | null; gpuFirst: string;
  state: string; track: string; session: string; flow: string;
  lapsTarget: number | null; quali: boolean | null; career: boolean | null; turns: number | null;
  lap: Val; pos: Val; total: Val;
  lapTime: number | null; best: number | null; lastLap: number | null; raceT: number | null;
  gapAhead: number | null; gapBehind: number | null; aeroX: Val; sector: Val;
  speedKph: number | null; speedIsDash: boolean; dashKph: number | null; gndKph: number | null;
  gear: Val; energy: Val; s: number | null; x: number | null;
  angle: number | null; k: number | null; hw: number | null;
  cam: string; caution: string; buildDone: string;
  logConsole: string; logBuffer: string; logN: number; logShown: number;
  logs: string[];
}

function fmt(v: unknown, digits?: number): string {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number" && digits != null) return v.toFixed(digits);
  return String(v);
}

export function fmtTime(t: number | null | undefined): string {
  if (t == null || !isFinite(t)) return "—";
  const ms = Math.round(t * 1000);   // round first: never "1:60.000"
  const m = Math.floor(ms / 60000);
  const s = (ms - m * 60000) / 1000;
  return m + ":" + (s < 10 ? "0" : "") + s.toFixed(3);
}

// Two-column row: label (padded to L chars) then value.
const L = 8;
function row(label: string, value: string): string { return (label + ":").padEnd(L) + " " + value; }
// CAN THE BOX ACTUALLY HOLD THE WIDE LAYOUT? A VIEWPORT proxy
// (`metricsRatio() < 480`) disagrees with the width's vw cap in ./perf.css,
// so it picks the wide layout for boxes that cannot hold it and the tail is
// CUT (white-space:pre inside overflow:hidden — lost, not scrolled).
// MEASURED with a 20-character probe in the body's own font, both viewports:
//   narrow longest 25 ch, wide longest 52 ch (GOV is the widest page)
//   desktop boxes 170/221/322 px at ch 8.57 -> 19/25/37 fit
//   phone   boxes 111/134/189 px at ch 7.35 -> 15/18/25 fit
// Under the proxy seven of nine desktop cases and nine of nine phone cases cut.
// WIDE_CH is that measured 52 plus one, and the CSS steps are sized in the same units.
// The measurement forces layout, so it is cached on (font-size, box width) —
// this runs at 4 Hz and must not reflow every paint.
const WIDE_CH = 53;
function sep(): string { return "─".repeat(24); }
// Compact two-value pair for narrow screens.
function pair(l1: string, v1: string, l2: string, v2: string): string { return l1 + " " + v1 + "   " + l2 + " " + v2; }
const up = (list: readonly string[]): RowValues => list.map((v) => [v, String(v).toUpperCase()] as const);

function isOneOf<T extends string>(list: readonly T[], v: string | null | undefined): v is T {
  return v != null && (list as readonly string[]).indexOf(v) >= 0;
}

export function createGameMetrics(deps: GameMetricsDeps = {}) {
  const st = deps.store ?? localRawStore();
  const src: MetricsSources = deps.sources ?? {};
  const search = (): string => {
    try { return deps.search ? deps.search() : (typeof location !== "undefined" ? location.search : ""); } catch { return ""; }
  };

  let _on: boolean | null = null;
  let _page: Page | null = null;
  let _pos: Pos | null = null;
  let _size: Size | null = null;
  let _logNs: string | null = null;
  let _logLvl: string | null = null;
  let _raf = 0;
  let _lastPaint = 0;
  let _panel: HTMLElement | null = null;
  let _body: HTMLElement | null = null;
  let _bar: HTMLElement | null = null;
  let _btn: HTMLElement | null = null;
  let _pageBtn: HTMLElement | null = null;
  let _posBtn: HTMLElement | null = null;
  let _sizeBtn: HTMLElement | null = null;
  let _logNsBtn: HTMLElement | null = null;
  let _logLvlBtn: HTMLElement | null = null;
  let _summary: HTMLElement | null = null;
  let _raisedBuffer: { buffer: string; bufferNs: Record<string, string> } | null = null;
  let _chW = 0, _chKey = "";

  // Mirrors the HUD gap-form pattern: innerWidth / hudScale is the slot proxy.
  // Two display densities:
  //   WIDE  (ratio >= 480): label column + value, full rows, up to 12 rows
  //   NARROW (ratio < 480): compact, two values per line, fewer rows
  function metricsRatio(): number {
    try {
      const root = document.documentElement;
      const s = +root.style.getPropertyValue("--hud-z-top")
        || +root.style.getPropertyValue("--hud-scale") || 1;
      return window.innerWidth / s;
    } catch { return 800; }
  }

  function qFlag(re: RegExp): RegExpExecArray | null {
    try { return re.exec(search()); } catch { return null; }
  }

  function read(): boolean {
    const q = qFlag(/[?&]metrics=(1|0|on|off|true|false)/i);
    if (q) return /^(1|on|true)$/i.test(q[1] as string);
    return st.raw(KEY) === "1";
  }

  function pinned(re: RegExp): boolean { return !!qFlag(re); }

  function readPage(): Page {
    const q = qFlag(/[?&]metricsPage=(gov|car|phys|log)/i);
    if (q) return (q[1] as string).toLowerCase() as Page;
    const v = st.raw(PAGE_KEY);
    if (isOneOf(PAGES, v)) return v;
    return "gov";
  }

  function readLogNs(): string {
    const q = qFlag(/[?&]metricsLog=([A-Za-z*]+)/i);
    if (q) {
      const v = (q[1] as string).toLowerCase();
      if (isOneOf(LOG_NS, v)) return v;
    }
    const v = st.raw(LOG_NS_KEY);
    if (isOneOf(LOG_NS, v)) return v;
    return "*";
  }

  function readLogLvl(): string {
    const q = qFlag(/[?&]metricsLvl=(warn|info|debug)/i);
    if (q) return (q[1] as string).toLowerCase();
    const v = st.raw(LOG_LVL_KEY);
    if (isOneOf(LOG_LVLS, v)) return v;
    return "warn";
  }

  function readPos(): Pos {
    const q = qFlag(/[?&]metricsPos=(auto|left|right)/i);
    if (q) return (q[1] as string).toLowerCase() as Pos;
    const v = st.raw(POS_KEY);
    if (isOneOf(POSITIONS, v)) return v;
    return "auto";
  }

  function pos(): Pos {
    if (_pos === null) _pos = readPos();
    return _pos;
  }

  function readSize(): Size {
    const q = qFlag(/[?&]metricsSize=(s|m|l)/i);
    if (q) return (q[1] as string).toLowerCase() as Size;
    const v = st.raw(SIZE_KEY);
    if (isOneOf(SIZES, v)) return v;
    return "s";
  }

  function size(): Size {
    if (_size === null) _size = readSize();
    return _size;
  }

  function applySize(el: HTMLElement | null): Size {
    if (!el) return size();
    el.dataset["size"] = size();
    return size();
  }

  function resolvePos(): "left" | "right" {
    const want = pos();
    if (want === "left" || want === "right") return want;
    try {
      if (window.innerHeight <= 520 || window.innerWidth < 900) return "left";
    } catch { /* no window */ }
    return "right";
  }

  function applyPos(el: HTMLElement | null): "left" | "right" {
    if (!el) return resolvePos();
    const side = resolvePos();
    el.dataset["pos"] = side;
    return side;
  }

  function on(): boolean {
    if (_on === null) _on = read();
    return _on;
  }

  function page(): Page {
    if (_page === null) _page = readPage();
    return _page;
  }

  function logNs(): string {
    if (_logNs === null) _logNs = readLogNs();
    return _logNs;
  }

  function logLvl(): string {
    if (_logLvl === null) _logLvl = readLogLvl();
    return _logLvl;
  }

  function store(key: string, val: string, pinRe: RegExp): void {
    if (pinned(pinRe)) return;
    st.rawSet(key, val);   // a blocked write is session-only
  }

  function snapshot(): MetricsSnapshot {
    const pg = page();
    const wantGov = pg === "gov";
    const wantCar = pg === "car";
    const wantPhys = pg === "phys";
    const wantLog = pg === "log";
    const out: MetricsSnapshot = {
      on: on(),
      page: page(),
      logNs: logNs(),
      logLvl: logLvl(),
      fps: null, ms: null, budget: null, scale: null, tier: null, backend: "",
      auto: null, strikes: null, tierFloor: null, gpuMs: null, loopStopped: null, loopFrames: null,
      // What the BOUND backend says about the device: which API three actually
      // took, how many GPU errors it has raised, and the first one. A phone
      // screenshot of this panel is the evidence a "see-through car" report
      // never carried.
      gfxApi: "", gpuErr: null, gpuFirst: "",
      state: "", track: "", session: "", flow: "",
      lapsTarget: null, quali: null, career: null, turns: null,
      lap: null, pos: null, total: null,
      lapTime: null, best: null, lastLap: null, raceT: null,
      gapAhead: null, gapBehind: null, aeroX: null, sector: null,
      speedKph: null, speedIsDash: false, dashKph: null, gndKph: null,
      gear: null, energy: null, s: null, x: null,
      angle: null, k: null, hw: null,
      cam: "", caution: "", buildDone: "",
      slipDeg: null, vLat: null, yawRate: null, slipFactor: null,
      axEstSm: null, axFrac: null, slope: null, wrongWay: null, rescueT: null,
      head: null, vmaxNow: null, aeroGrip: null, aeroDf: null,
      xOn: null, xArmed: null, aeroLoad: null,
      // physState() already RETURNS these every paint; field names match the
      // debug hook on purpose: a player's screenshot then maps straight onto
      // physState() when they report something.
      towing: null, xVmaxGain: null, xDfLoss: null,
      drain: null, regen: null, brakeBias: null, otTime: null, otMJ: null,
      logConsole: "", logBuffer: "", logN: 0, logShown: 0,
      logs: [],
    };
    try {
      if (wantGov && deps.loop) {
        const h = deps.loop.state();
        out.loopStopped = h.stopped; out.loopFrames = h.frames;
      }
    } catch { /* loop health not booted */ }
    try {
      const G = deps.gov;
      if (G) {
        const ema = G.fpsEMA();
        if (ema > 0) { out.fps = +(1000 / ema).toFixed(1); out.ms = +ema.toFixed(1); }
        out.budget = +G.floorMs().toFixed(1);
        out.tier = G.tier();
      }
    } catch { /* governor not booted */ }
    try {
      const p = src.perf && src.perf();
      if (p) {
        if (p.fps != null) out.fps = p.fps;
        if (p.floorMs != null) out.budget = p.floorMs;
        if (p.scale != null) out.scale = p.scale;
        if (p.tier != null) out.tier = p.tier;
        if (p.auto != null) out.auto = p.auto;
        if (p.crashStrikes != null) out.strikes = p.crashStrikes;
        if (p.tierFloor != null) out.tierFloor = p.tierFloor;
      }
    } catch { /* renderer not live */ }
    try {
      if (wantGov && src.gpuTimer) {
        const g = src.gpuTimer();
        if (g && g.ms != null && g.ms >= 0) out.gpuMs = +g.ms.toFixed(2);
      }
    } catch { /* SwiftShader / no timestamp-query */ }
    try {
      const b = src.backend && src.backend();
      if (b) { out.backend = b.name || ""; out.gfxApi = b.reason || ""; }
    } catch { /* backend not bound yet */ }
    try {
      const e = src.gpuErrors && src.gpuErrors();
      if (e) { out.gpuErr = e.count | 0; if (e.first) out.gpuFirst = String(e.first).slice(0, 72); }
    } catch { /* no error hook */ }
    try {
      const i = src.info && src.info();
      if (i) {
        out.state = i.state || "";
        out.track = i.track || "";
        out.session = i.session || i.flow || "";
        out.flow = i.flow || "";
        if (i.lapsTarget != null) out.lapsTarget = i.lapsTarget;
        if (i.raceQuali != null) out.quali = i.raceQuali;
        if (i.career != null) out.career = i.career;
        if (i.turns != null) out.turns = i.turns;
      }
    } catch { /* info needs a live app */ }
    try {
      const t = wantCar && src.timing ? src.timing() : null;
      if (t) {
        out.lap = t.lap ?? null;
        out.pos = t.pos ?? null;
        out.total = t.total ?? null;
        out.gear = t.gear ?? null;
        out.energy = t.energy ?? null;
        if (t.lapTime != null) out.lapTime = t.lapTime;
        if (t.best != null) out.best = t.best;
        if (t.lastLap != null) out.lastLap = t.lastLap;
        if (t.raceT != null) out.raceT = t.raceT;
        if (t.gapAhead != null) out.gapAhead = t.gapAhead;
        if (t.gapBehind != null) out.gapBehind = t.gapBehind;
        if (t.aeroX != null) out.aeroX = t.aeroX;
        if (t.sector != null) out.sector = t.sector;
      }
    } catch { /* timing needs the player */ }
    // HUD km/h is dashKph (vStd*3.6), not raw ground*3.6. Keep both: a painted
    // 0 is a real parked reading, and headless leaves the digit at 0.
    try {
      const v = wantCar && src.dashKph ? src.dashKph() : null;
      if (v != null && isFinite(v)) { out.dashKph = v; out.speedKph = v; out.speedIsDash = true; }
    } catch { /* no HUD (menu) */ }
    // probe() is one track sample. A full observation adds walls, a 3-point
    // lookahead, field sort, and reward terms — too much for a 4 Hz overlay.
    try {
      const o = wantCar && src.probe ? src.probe() : null;
      if (o) {
        if (o.speed != null) out.gndKph = +(o.speed * 3.6).toFixed(1);
        if (out.speedKph == null && out.gndKph != null) out.speedKph = out.gndKph;
        if (o.s != null) out.s = o.s;
        if (o.x != null) out.x = o.x;
        if (o.angle != null) out.angle = o.angle;
        if (o.k != null) out.k = o.k;
        if (o.hw != null) out.hw = o.hw;
      }
    } catch { /* probe needs player + track */ }
    try {
      const p = wantPhys && src.physState ? src.physState() : null;
      if (p && p["ok"] !== false) {
        for (const f of PHYS_FIELDS) {
          const v = p[f];
          if (v != null && (typeof v === "number" || typeof v === "boolean" || typeof v === "string")) out[f] = v;
        }
        const ax = p["aeroX"];
        if (out.aeroX == null && ax != null && (typeof ax === "number" || typeof ax === "boolean")) out.aeroX = ax;
      }
    } catch { /* physState needs the player */ }
    try {
      const c = src.camera && src.camera();
      if (c && c.mode) out.cam = c.mode;
    } catch { /* camera hook */ }
    try {
      const c = src.caution && src.caution();
      if (c && c.label) out.caution = c.label;
    } catch { /* caution layer absent */ }
    try {
      const Log = deps.log;
      if (Log) {
        const lv = Log.level();
        out.logConsole = lv.console || "";
        out.logBuffer = lv.buffer || "";
        if (wantLog) {
          const rec = Log.records();
          out.logN = rec.length;
          const ns = logNs();
          const filt: { level: string; limit: number; ns?: string } = { level: logLvl(), limit: 12 };
          if (ns && ns !== "*") filt.ns = ns;
          const shown = Log.records(filt);
          out.logShown = shown.length;
          out.logs = shown.map((r) => (r.level[0] ?? "") + " " + r.ns + " " + r.msg);
        }
        if (wantGov && out.track) {
          const tr = Log.records({ ns: "track", level: "info" });
          for (let i = tr.length - 1; i >= 0; i--) {
            const m = (tr[i] as { msg: string }).msg;
            if (/^build done /.test(m) && m.indexOf(out.track) >= 0) {
              out.buildDone = m;
              break;
            }
          }
        }
      }
    } catch { /* log module absent */ }
    return out;
  }

  function ensurePanel(): HTMLElement | null {
    if (_panel) return _panel;
    const host = deps.panelHost ?? (typeof document !== "undefined" ? document.body : null);
    if (!host) return null;
    const doc = host.ownerDocument;
    const el = doc.createElement("div");
    el.id = "game-metrics";
    el.setAttribute("aria-label", "Debug metrics");
    const bar = doc.createElement("div");
    bar.id = "game-metrics-bar";
    bar.setAttribute("role", "toolbar");
    PAGES.forEach((p) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.dataset["page"] = p;
      b.textContent = p.toUpperCase();
      bar.appendChild(b);
    });
    const sizeChip = doc.createElement("button");
    sizeChip.type = "button";
    sizeChip.dataset["sizeCycle"] = "1";
    sizeChip.setAttribute("aria-label", "Overlay size");
    sizeChip.textContent = size().toUpperCase();
    bar.appendChild(sizeChip);
    bar.addEventListener("click", (e) => {
      const t = e.target as HTMLElement | null;
      if (!t || !t.dataset) return;
      e.preventDefault();
      e.stopPropagation();
      if (t.dataset["sizeCycle"]) { nextSize(1); return; }
      const pg = t.dataset["page"];
      if (pg) setPage(pg);
    });
    const body = doc.createElement("pre");
    body.id = "game-metrics-body";
    el.appendChild(bar);
    el.appendChild(body);
    try {
      if (deps.hudProfile && deps.hudProfile() === "minimal") el.dataset["compact"] = "1";
    } catch { /* no HUD profile */ }
    applyPos(el);
    applySize(el);
    host.appendChild(el);
    _panel = el;
    _bar = bar;
    _body = body;
    return el;
  }

  function chWidth(): number {
    if (!_body || typeof getComputedStyle !== "function") return 0;
    const cs = getComputedStyle(_body);
    const key = (cs && cs.fontSize) || "";
    if (_chW && key === _chKey) return _chW;
    try {
      const probe = _body.ownerDocument.createElement("span");
      probe.textContent = "00000000000000000000";           // 20, so rounding is 1/20th
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
      _body.appendChild(probe);
      const w = probe.getBoundingClientRect().width / 20;
      _body.removeChild(probe);
      if (w > 0) { _chW = w; _chKey = key; }
    } catch { /* detached / no layout: fall through to the proxy below */ }
    return _chW;
  }
  function fitsWide(): boolean {
    const ch = chWidth();
    // The GRANTED width, never the PAINTED one. Reading _body.clientWidth here
    // latched: the panel sizes to its content, so narrow content gave a small box,
    // a small box failed this test, and the layout could never climb back to wide
    // — a one-way door that measured its own output. The panel's resolved width
    // comes from the CSS step and does not depend on what was painted into it.
    if (!ch || !_panel || typeof getComputedStyle !== "function") return metricsRatio() >= 480;
    const cs = getComputedStyle(_panel);
    const granted = parseFloat(cs.width) || 0;
    if (!granted) return metricsRatio() >= 480;   // unmeasurable is UNKNOWN, not small
    // The step is the border box; the text lives inside the padding and border.
    const chrome = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) +
                   (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
    return Math.floor(Math.max(0, granted - chrome) / ch) >= WIDE_CH;
  }

  /** The panel's lines for snapshot `s` (pure given `narrow`). */
  function lines(s: MetricsSnapshot, narrow: boolean): string[] {
    const hdr = "";
    if (s.page === "car") {
      if (narrow) {
        return [
          hdr,
          pair("spd", fmt(s.dashKph) + "km/h", "g", fmt(s.gear)),
          pair("ERS", fmt(s.energy, 2), "aero", fmt(s.aeroX, 2)),
          pair("P",   fmt(s.pos), "lap", fmt(s.lap) + (s.lapsTarget != null ? "/" + s.lapsTarget : "")),
          "t   " + fmtTime(s.lapTime) + "  best " + fmtTime(s.best),
          pair("gap", fmt(s.gapAhead, 1) + "/" + fmt(s.gapBehind, 1), "S", fmt(s.sector)),
        ];
      }
      return [
        hdr,
        sep(),
        row("speed",  fmt(s.dashKph) + " km/h   gnd " + fmt(s.gndKph) + " km/h"),
        row("gear",   fmt(s.gear) + "   ERS " + fmt(s.energy, 2) + "   aero " + fmt(s.aeroX, 2)),
        row("pos",    "P" + fmt(s.pos) + (s.total != null ? "/" + s.total : "") +
                      "   lap " + fmt(s.lap) + (s.lapsTarget != null ? "/" + s.lapsTarget : "") +
                      "   S" + fmt(s.sector)),
        row("time",   fmtTime(s.lapTime) + "   best " + fmtTime(s.best)),
        row("last",   fmtTime(s.lastLap)),
        row("gap",    fmt(s.gapAhead, 1) + " / " + fmt(s.gapBehind, 1) + " m"),
        row("s  x",   fmt(s.s, 1) + "   " + fmt(s.x, 2) + "   k " + fmt(s.k, 4)),
      ];
    }
    if (s.page === "phys") {
      if (narrow) {
        return [
          hdr,
          pair("slip", fmt(s.slipDeg, 1) + "°", "slipF", fmt(s.slipFactor, 2)),
          pair("vLat", fmt(s.vLat, 2), "yaw", fmt(s.yawRate, 2)),
          pair("ax",   fmt(s.axEstSm, 2), "slope", fmt(s.slope, 3)),
          pair("vmax", fmt(s.vmaxNow, 1), "ww", fmt(s.wrongWay)),
          pair("grip", fmt(s.aeroGrip, 3), "xOn", fmt(s.xOn)),
          // Eight more physState() fields. Kept inside the 25-char narrow
          // budget the width work measured — a longer line here is CUT, not
          // scrolled.
          pair("tow", fmt(s.towing, 2), "bb", fmt(s.brakeBias, 2)),
          pair("xdv", fmt(s.xVmaxGain, 3), "xdf", fmt(s.xDfLoss, 3)),
          pair("drn", fmt(s.drain, 3), "rgn", fmt(s.regen, 3)),
          pair("ot", fmt(s.otTime, 1), "mj", fmt(s.otMJ, 2)),
        ];
      }
      return [
        hdr,
        sep(),
        row("slip",   fmt(s.slipDeg, 1) + "°   vLat " + fmt(s.vLat, 2) + "   slipF " + fmt(s.slipFactor, 2)),
        row("yaw",    fmt(s.yawRate, 2) + " rad/s   ax " + fmt(s.axEstSm, 2) + "   axFrac " + fmt(s.axFrac, 2)),
        row("slope",  fmt(s.slope, 3) + "   wrongWay " + fmt(s.wrongWay) + "   rescue " + fmt(s.rescueT, 1) + "s"),
        row("vmax",   fmt(s.vmaxNow, 1) + " m/s   head " + fmt(s.head, 2)),
        row("aero",   "grip " + fmt(s.aeroGrip, 3) + "   df " + fmt(s.aeroDf, 2) + "   load " + fmt(s.aeroLoad, 2)),
        row("DRS",    "on " + fmt(s.xOn) + "   armed " + fmt(s.xArmed) + "   aeroX " + fmt(s.aeroX, 2)),
        // X-MODE'S PRICE, not just its state. xVmaxGain / xDfLoss are what the
        // open wing actually buys and costs; every F1 game shows DRS as a lit
        // letter and never what it is worth.
        row("x cost", "vmax +" + fmt(s.xVmaxGain, 3) + "   df -" + fmt(s.xDfLoss, 3)),
        // TOW is the slipstream the player is sitting in (0..1, folded into
        // vmaxNow). On a phone, where the aero cannot be felt, it is the
        // difference between "hold station" and "pull out".
        row("tow",    fmt(s.towing, 2) + "   brakeBias " + fmt(s.brakeBias, 3)),
        // ERS FLOW rather than the level the HUD bar already shows.
        row("ers",    "drain " + fmt(s.drain, 3) + "   regen " + fmt(s.regen, 3)),
        row("ot",     fmt(s.otTime, 1) + " s   left " + fmt(s.otMJ, 2) + " MJ"),
      ];
    }
    if (s.page === "log") {
      const filterRow = fmt(s.logLvl) + "  ns:" + fmt(s.logNs) + "  " + fmt(s.logShown) + "/" + fmt(s.logN);
      const logMax = narrow ? 36 : 50;
      const trimLog = (str: string): string => str.length > logMax ? str.slice(0, logMax - 1) + "…" : str;
      return [
        hdr + "  = ns  ; lvl",
        sep(),
        row("level",  fmt(s.logConsole || null) + " / buf:" + fmt(s.logBuffer || null)),
        row("show",   filterRow),
        sep(),
      ].concat(s.logs.length ? s.logs.map(trimLog) : ["(empty — raise level with ;",
                                                       " or cycle ns with =)"]);
    }
    // GOV — most critical: fps + frame time front, then context
    if (narrow) {
      return [
        hdr,
        pair("fps", s.loopStopped ? "STOPPED" : fmt(s.fps), "ms", fmt(s.ms)),
        pair("loop", s.loopStopped ? "STOPPED" : "frames", "n", fmt(s.loopFrames)),
        pair("tier", fmt(s.tier), "auto", fmt(s.auto)),
        pair("gfx", fmt(s.backend || null) + (s.gfxApi ? "/" + s.gfxApi : ""), "err", fmt(s.gpuErr)),
        (s.track || "menu") + "  " + (s.caution || "GREEN"),
      ].concat(s.gpuFirst ? [s.gpuFirst.slice(0, 40)] : []);
    }
    return [
      hdr,
      sep(),
      row("fps",    (s.loopStopped ? "STOPPED" : fmt(s.fps)) + "   frame " + fmt(s.ms) + " ms" +
                    (s.gpuMs != null ? "   gpu " + s.gpuMs + " ms" : "")),
      row("loop", (s.loopStopped ? "STOPPED" : "frames") + " " + fmt(s.loopFrames)),
      row("budget", fmt(s.budget) + " ms   tier " + fmt(s.tier) +
                    (s.tierFloor != null ? " (fl " + s.tierFloor + ")" : "") +
                    "   auto " + fmt(s.auto)),
      // err FIRST: on a phone the row's tail is what clips, and the error
      // count is the one number a "nothing renders" screenshot must carry.
      row("gfx",    fmt(s.backend || null) + (s.gfxApi ? "/" + s.gfxApi : "") +
                    "   err " + fmt(s.gpuErr) + "   strikes " + fmt(s.strikes) +
                    (s.scale != null ? "   scale " + fmt(s.scale) : "")),
    ].concat(s.gpuFirst ? [row("gpu", s.gpuFirst)] : []).concat([
      sep(),
      row("session", (s.track || "menu") + "  " + (s.flow || s.session || s.state || "") +
                     "  " + (s.caution || "GREEN") + "  cam " + fmt(s.cam || null) +
                     (s.quali ? "  quali" : "") + (s.career ? "  career" : "")),
      row("build",  s.buildDone ? s.buildDone.replace(/^build done /, "") : "—"),
    ]);
  }

  function paintOverlay(): void {
    const el = ensurePanel();
    if (!el) return;
    if (!on()) { el.hidden = true; return; }
    el.hidden = false;
    const s = snapshot();
    applyPos(el);
    applySize(el);
    if (_bar) {
      const kids = _bar.children;
      for (let i = 0; i < kids.length; i++) {
        const b = kids[i] as HTMLElement;
        if (b.dataset["sizeCycle"]) {
          b.textContent = size().toUpperCase();
          continue;
        }
        const onPage = b.dataset["page"] === s.page;
        b.setAttribute("aria-pressed", onPage ? "true" : "false");
      }
    }
    const narrow = size() === "s" || !fitsWide();
    const out = _body || el;
    out.textContent = lines(s, narrow).filter(Boolean).join("\n");
  }

  function loop(now: number): void {
    _raf = 0;
    if (!on()) return;
    if (now - _lastPaint >= PAINT_MS) {
      _lastPaint = now;
      paintOverlay();
    }
    if (typeof requestAnimationFrame === "function")
      _raf = requestAnimationFrame(loop);
  }

  function startLoop(): void {
    if (typeof requestAnimationFrame !== "function") return;
    if (!_raf) _raf = requestAnimationFrame(loop);
  }

  /* The six SETTINGS rows are setting rows when deps.settingRow is given — the
     same LABEL ‹ VALUE › control as every other Settings pick. Without it they
     are the one-button cycle, painted as `LABEL: VALUE`. */
  function isRow(el: HTMLElement): boolean { return el.classList.contains("set-row"); }
  function paintRow(el: HTMLElement | null, label: string, value: string): void {
    if (!el) return;
    if (deps.settingRow && isRow(el)) { deps.settingRow.paint(el, value); return; }
    el.textContent = label + ": " + String(value).toUpperCase();
  }
  function paintBtn(btn: HTMLElement | null): void { paintRow(btn, "OVERLAY", on() ? "on" : "off"); }
  function paintPageBtn(btn: HTMLElement | null): void { paintRow(btn, "PAGE", page()); }
  function paintLogNsBtn(btn: HTMLElement | null): void { paintRow(btn, "LOG NS", logNs()); }
  function paintLogLvlBtn(btn: HTMLElement | null): void { paintRow(btn, "LOG SHOW", logLvl()); }
  function paintPosBtn(btn: HTMLElement | null): void { paintRow(btn, "SIDE", pos()); }
  function paintSizeBtn(btn: HTMLElement | null): void { paintRow(btn, "SIZE", size()); }

  function paintSummary(): void {
    const sum = _summary;
    if (!sum) return;
    const doc = sum.ownerDocument;
    const span = (fold: string, text: string): HTMLSpanElement => {
      const s = doc.createElement("span"); s.dataset["fold"] = fold; s.textContent = text; return s;
    };
    const parts = [span("k", "METRICS"), span("sep", " · ")];
    if (on()) parts.push(span("on", "ON"), span("sep", " · "), span("val", page().toUpperCase()));
    else parts.push(span("off", "OFF"));
    sum.replaceChildren(...parts);
  }

  function paintLogVisibility(): void {
    const show = page() === "log";
    if (_logNsBtn) _logNsBtn.hidden = !show;
    if (_logLvlBtn) _logLvlBtn.hidden = !show;
  }

  function paintSettingBtns(): void {
    paintBtn(_btn);
    paintPageBtn(_pageBtn);
    paintPosBtn(_posBtn);
    paintSizeBtn(_sizeBtn);
    paintLogNsBtn(_logNsBtn);
    paintLogLvlBtn(_logLvlBtn);
    paintLogVisibility();
    paintSummary();
  }

  function raiseBuffer(): void {
    const Log = deps.log;
    if (!Log) return;
    try {
      const cur = Log.level();
      const buf = cur.buffer || "";
      if ((Log.LEVELS[buf] ?? 0) >= Log.DEBUG) return;
      _raisedBuffer = { buffer: buf, bufferNs: cur.bufferNs || {} };
      Log.level("buffer:debug");
      const ns = _raisedBuffer.bufferNs;
      for (const k in ns) Log.level("buffer:" + k + ":" + ns[k]);
    } catch { /* keep shipped thresholds */ }
  }

  function restoreBuffer(): void {
    const Log = deps.log;
    if (!_raisedBuffer || !Log) return;
    try {
      Log.level("buffer:" + _raisedBuffer.buffer);
      const ns = _raisedBuffer.bufferNs;
      for (const k in ns) Log.level("buffer:" + k + ":" + ns[k]);
    } catch { /* leave whatever the player set */ }
    _raisedBuffer = null;
  }

  function set(v: boolean): boolean {
    const next = !!v;
    _on = next;
    store(KEY, next ? "1" : "0", /[?&]metrics=/i);
    perfLog.info("game", "metrics " + (next ? "on " + page() : "off"));
    if (next) {
      raiseBuffer();
      paintOverlay();
      startLoop();
    } else {
      restoreBuffer();
      paintOverlay();
    }
    paintSettingBtns();
    return next;
  }

  function toggle(): boolean { return set(!on()); }

  function setPage(name: string): Page {
    const next = String(name || "").toLowerCase();
    if (!isOneOf(PAGES, next)) return page();
    _page = next;
    store(PAGE_KEY, next, /[?&]metricsPage=/i);
    if (on()) perfLog.info("game", "metrics page " + next);
    if (on()) paintOverlay();
    paintSettingBtns();
    return _page;
  }

  function nextPage(dir: number): Page {
    const i = PAGES.indexOf(page());
    const d = dir < 0 ? -1 : 1;
    return setPage(PAGES[(i + d + PAGES.length) % PAGES.length] as Page);
  }

  function setPos(name: string): Pos {
    const next = String(name || "").toLowerCase();
    if (!isOneOf(POSITIONS, next)) return pos();
    _pos = next;
    store(POS_KEY, next, /[?&]metricsPos=/i);
    if (_panel) applyPos(_panel);
    paintSettingBtns();
    return _pos;
  }

  function nextPos(dir: number): Pos {
    const i = POSITIONS.indexOf(pos());
    const d = dir < 0 ? -1 : 1;
    return setPos(POSITIONS[(Math.max(0, i) + d + POSITIONS.length) % POSITIONS.length] as Pos);
  }

  function setSize(name: string): Size {
    const next = String(name || "").toLowerCase();
    if (!isOneOf(SIZES, next)) return size();
    _size = next;
    store(SIZE_KEY, next, /[?&]metricsSize=/i);
    if (_panel) applySize(_panel);
    if (on()) paintOverlay();
    paintSettingBtns();
    return _size;
  }

  function nextSize(dir: number): Size {
    const i = SIZES.indexOf(size());
    const d = dir < 0 ? -1 : 1;
    return setSize(SIZES[(Math.max(0, i) + d + SIZES.length) % SIZES.length] as Size);
  }

  function setLogNs(name: string): string {
    const next = String(name || "").toLowerCase();
    if (!isOneOf(LOG_NS, next)) return logNs();
    _logNs = next;
    store(LOG_NS_KEY, next, /[?&]metricsLog=/i);
    if (on()) paintOverlay();
    paintSettingBtns();
    return _logNs;
  }

  function nextLogNs(dir: number): string {
    const i = (LOG_NS as readonly string[]).indexOf(logNs());
    const d = dir < 0 ? -1 : 1;
    return setLogNs(LOG_NS[(Math.max(0, i) + d + LOG_NS.length) % LOG_NS.length] as string);
  }

  function setLogLvl(name: string): string {
    const next = String(name || "").toLowerCase();
    if (!isOneOf(LOG_LVLS, next)) return logLvl();
    _logLvl = next;
    store(LOG_LVL_KEY, next, /[?&]metricsLvl=/i);
    if (on()) paintOverlay();
    paintSettingBtns();
    return _logLvl;
  }

  function nextLogLvl(dir: number): string {
    const i = (LOG_LVLS as readonly string[]).indexOf(logLvl());
    const d = dir < 0 ? -1 : 1;
    return setLogLvl(LOG_LVLS[(Math.max(0, i) + d + LOG_LVLS.length) % LOG_LVLS.length] as string);
  }

  function typingTarget(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" || el.tagName === "BUTTON" || el.isContentEditable);
  }

  function uiSelect(): void {
    try { deps.uiSelect?.(); } catch { /* audio not up yet; the pick still applies */ }
  }

  // values: [[v, label], …]; read(): v; write(v). Falls back to a cycle button
  // where SettingRow is absent (see paintRow).
  function makeMetricsRow(doc: Document, id: string, label: string, title: string, values: RowValues,
    readV: () => string, write: (v: string) => void, paint: (b: HTMLElement) => void): HTMLElement {
    const SR = deps.settingRow;
    if (!SR) {
      const b = doc.createElement("button");
      b.id = id;
      b.type = "button";
      b.title = title;
      paint(b);
      b.onclick = () => {
        const vs = values.map((p) => p[0]);
        write(vs[(vs.indexOf(String(readV())) + 1) % vs.length] as string);
        uiSelect();
      };
      return b;
    }
    const r = SR.build(id, label, values);
    r.row.title = title;
    SR.wire(r.row, { values, read: readV, write: (v) => { write(v); uiSelect(); } });
    return r.row;
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
    if (typingTarget(e.target)) return;
    if (e.key === "`" || e.code === "Backquote" || e.key === "F9") {
      e.preventDefault();
      toggle();
      return;
    }
    if (!on()) return;
    try {
      if (deps.menusOpen && deps.menusOpen()) return;
    } catch { /* menus not booted */ }
    if (e.key === "]" || e.key === "[") {
      e.preventDefault();
      nextPage(e.key === "]" ? 1 : -1);
      return;
    }
    const jump: Record<string, Page> = { "1": "gov", "2": "car", "3": "phys", "4": "log" };
    const j = jump[e.key];
    if (j) {
      e.preventDefault();
      setPage(j);
      return;
    }
    if (e.key === "=" || e.key === "-") {
      e.preventDefault();
      if (page() !== "log") setPage("log");
      nextLogNs(e.key === "=" ? 1 : -1);
      return;
    }
    if (e.key === ";") {
      e.preventDefault();
      if (page() !== "log") setPage("log");
      nextLogLvl(1);
    }
  };
  const onResize = (): void => {
    if (_panel) { applyPos(_panel); applySize(_panel); }
  };

  /**
   * SETTINGS > DISPLAY — the METRICS submenu, built into `host`: one <details>
   * whose summary carries ON/page state so the fold does not have to open to
   * be read, then OVERLAY / PAGE / SIDE / SIZE / LOG NS / LOG SHOW. LOG filters
   * hide unless PAGE is LOG. Binds ` / F9 and the page keys on `win`.
   * f1-game ran initUI() + buildSubmenu() on timers; here it is one call.
   */
  function mountUI(host: HTMLElement | null, win: Window | null = typeof window !== "undefined" ? window : null): () => void {
    perfLog.info("game", "GameMetrics.initUI");
    let det: HTMLDetailsElement | null = null;
    if (host && !host.ownerDocument.getElementById("pm-metrics")) {
      const doc = host.ownerDocument;
      det = doc.createElement("details");
      det.id = "pm-metrics-details";
      det.className = "pm-metrics-sub";
      const sum = doc.createElement("summary");
      sum.className = "adv-more-btn";
      sum.title = "Live FPS / car / phys / log overlay controls";
      det.appendChild(sum);
      _summary = sum;
      const body = doc.createElement("div");
      body.className = "pm-metrics-sub-body";
      body.setAttribute("role", "group");
      body.setAttribute("aria-label", "Metrics controls");
      // The rows' own explanations are hover-only titles; this line is the one a
      // phone can read.
      const help = doc.createElement("p");
      help.className = "adv-help";
      help.textContent = "A live readout over the race for testing and tuning. OVERLAY turns it on (` or F9 in a race); PAGE picks GOV for performance, CAR for timing and speed, PHYS for grip and forces, LOG for the event log; SIDE and SIZE place it.";
      body.appendChild(help);

      _btn = makeMetricsRow(doc,
        "pm-metrics", "OVERLAY",
        "Show the live metrics overlay on the canvas. ` or F9 also toggles it. " +
          "Each page shows different data: GOV = perf/session, CAR = timing/speed, " +
          "PHYS = grip/forces, LOG = filtered log tail.",
        up(["on", "off"]), () => (on() ? "on" : "off"), (v) => { set(v === "on"); }, paintBtn,
      );
      _pageBtn = makeMetricsRow(doc,
        "pm-metrics-page", "PAGE",
        "Which overlay page is shown while METRICS is ON. Pick a page before turning on, or use [ ] / 1–4 in-game.",
        up(PAGES), page, setPage, paintPageBtn,
      );
      _posBtn = makeMetricsRow(doc,
        "pm-metrics-pos", "SIDE",
        "Which side the metrics overlay docks on. AUTO is left on a short or narrow viewport so the panel cannot cover GAS/BRAKE.",
        up(POSITIONS), pos, setPos, paintPosBtn,
      );
      _sizeBtn = makeMetricsRow(doc,
        "pm-metrics-size", "SIZE",
        "How large the metrics overlay is. S is the phone default. The S/M/L chip on the overlay also cycles this.",
        up(SIZES), size, setSize, paintSizeBtn,
      );
      _logNsBtn = makeMetricsRow(doc,
        "pm-metrics-logns", "LOG NS",
        "Filter the LOG overlay tail to one namespace (* = all). = / - cycle while the overlay is up.",
        up(LOG_NS), logNs, setLogNs, paintLogNsBtn,
      );
      _logLvlBtn = makeMetricsRow(doc,
        "pm-metrics-loglvl", "LOG SHOW",
        "How verbose the LOG overlay tail is (warn / info / debug). ; cycles while the overlay is up.",
        up(LOG_LVLS), logLvl, setLogLvl, paintLogLvlBtn,
      );
      [_btn, _pageBtn, _posBtn, _sizeBtn, _logNsBtn, _logLvlBtn].forEach((b) => {
        if (!b) return;
        b.addEventListener("click", (e) => { e.stopPropagation(); });
        body.appendChild(b);
      });
      det.appendChild(body);
      host.appendChild(det);
      paintSettingBtns();
    }

    if (win) {
      win.addEventListener("keydown", onKey);
      win.addEventListener("resize", onResize);
    }

    if (on()) { raiseBuffer(); paintOverlay(); startLoop(); }
    return () => {
      if (win) {
        win.removeEventListener("keydown", onKey);
        win.removeEventListener("resize", onResize);
      }
      if (_raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(_raf);
      _raf = 0;
      restoreBuffer();
      det?.remove();
      _panel?.remove();
      _panel = null; _bar = null; _body = null; _summary = null;
      _btn = _pageBtn = _posBtn = _sizeBtn = _logNsBtn = _logLvlBtn = null;
    };
  }

  // Read-only Playwright seam: the governor's frameStats() + a longtask ring
  // for the frame-time spec. Does not touch gameplay; reset only clears the
  // governor's diagnostic history.
  let _ftLt = 0;
  let _ftObs: PerformanceObserver | null = null;

  function frametimeBenchReset(): void {
    try { deps.gov?.resetFrameStats(); } catch { /* pre-boot harness */ }
    _ftLt = 0;
    if (_ftObs) {
      try { _ftObs.disconnect(); } catch { /* gone */ }
      _ftObs = null;
    }
    if (typeof PerformanceObserver !== "function") return;
    try {
      const types = PerformanceObserver.supportedEntryTypes;
      if (!types || types.indexOf("longtask") < 0) return;
      _ftObs = new PerformanceObserver((list) => {
        _ftLt += list.getEntries().length;
      });
      _ftObs.observe({ type: "longtask", buffered: true });
    } catch {
      _ftObs = null;
    }
  }

  function frametimeBenchSnapshot() {
    const ft: Pick<FrameStats, "frames" | "p50" | "p95" | "p99" | "maxMs"> = deps.gov
      ? deps.gov.frameStats()
      : { frames: 0, p50: 0, p95: 0, p99: 0, maxMs: 0 };
    let heapUsedMB: number | null = null;
    let heapTotalMB: number | null = null;
    try {
      const m = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
      if (m) {
        heapUsedMB = +(m.usedJSHeapSize / (1024 * 1024)).toFixed(2);
        heapTotalMB = +(m.totalJSHeapSize / (1024 * 1024)).toFixed(2);
      }
    } catch { /* no performance.memory */ }
    return {
      p50: +(+ft.p50 || 0).toFixed(3),
      p95: +(+ft.p95 || 0).toFixed(3),
      p99: +(+ft.p99 || 0).toFixed(3),
      max: +(+ft.maxMs || 0).toFixed(3),
      frames: ft.frames || 0,
      longTasks: _ftLt,
      heapUsedMB,
      heapTotalMB,
    };
  }

  return {
    KEY, PAGE_KEY, POS_KEY, SIZE_KEY, LOG_NS_KEY, LOG_LVL_KEY,
    PAGES, POSITIONS, SIZES, LOG_NS, LOG_LVLS,
    on, set, toggle, page, setPage, nextPage,
    pos, setPos, nextPos, resolvePos,
    size, setSize, nextSize,
    logNs, setLogNs, nextLogNs, logLvl, setLogLvl, nextLogLvl,
    snapshot, lines, paint: paintOverlay, mountUI,
    frametimeBenchReset, frametimeBenchSnapshot,
  };
}

export type GameMetrics = ReturnType<typeof createGameMetrics>;

/** Create the overlay and mount its METRICS fold into `host` (the DISPLAY settings panel). */
export function mount(host: HTMLElement | null, deps: GameMetricsDeps = {}): GameMetrics & { unmount: () => void } {
  const m = createGameMetrics(deps);
  const unmount = m.mountUI(host);
  return Object.assign(m, { unmount });
}
