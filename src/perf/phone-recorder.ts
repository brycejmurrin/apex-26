/**
 * PhoneRecorder: a phone-only soak recorder (f1-game issue #1633). Ported from
 * f1-game js/perf/phone-recorder.js:1-474. The recorder state machine
 * (`create(env)`) is verbatim; the live readers take their sources from an
 * injected `RecorderSources` instead of the GLX / PerfGov / RendererPicker /
 * __apex globals, and the panel is `mount(host, deps)` instead of a timer
 * poll for #pm-metrics-details.
 *
 * SETTINGS > DISPLAY > METRICS > PHONE TEST: RECORD / STOP, SHARE, COPY and the
 * six-line how-to. Nothing runs until RECORD is tapped. On start it captures
 * the device FACTS once (UA, DPR, navigator.gpu, backend + boot reason, the
 * WebGL2 extensions the perf plan asks about, the rAF cadence the page really
 * gets), then samples every SAMPLE_MS and every WINDOW_FRAMES rendered frames:
 * frame p50/p95/p99, render scale, governor tier, renderer retained counts,
 * minutes since start, circuit / weather / preset. SHARE hands one JSON file
 * to the share sheet (iOS Safari), else a download link; COPY is the clipboard
 * fallback.
 *
 * READ-ONLY ON THE GOVERNOR: frameStats()/tier()/userTier()/autoShed() are
 * read, never written. No GPU timer is touched (a synchronous round trip on
 * phones). The only per-frame cost while recording is one rAF callback that
 * bumps a counter. A recording is mirrored to a26.phoneRec after each sample
 * so an iOS tab kill mid-soak does not lose it.
 *
 * Dropped (GLX/WGX-specific): the backendPick fields api/path/pin/softBlit/
 * packLive of f1-game's TLX backendState and the RendererPicker pick; apex-26
 * records `backend` (WebGPU/WebGL2) and the boot `reason` from src/render/boot.ts
 * instead, and three's `renderer.info.memory` as `mem`.
 */
import { localRawStore, perfLog, type RawStore } from "./env";
import type { FrameStats, PerfGov } from "./governor";
import type { PerfSpans } from "./spans";

export const KEY = "a26.phoneRec";
export const SCHEMA = "a26.phone-soak/1";
export const SAMPLE_MS = 120000;
export const WINDOW_FRAMES = 2048;
export const CADENCE_FRAMES = 120;
export const QUICK_MS = 30000;
export const MAX_SAMPLES = 600;
const MAX_EVENTS = 50;
const MAX_SAVE_CHARS = 600000;

export const HOWTO_AUTO = "AUTO SOAK: one tap runs a hands-free 15 min wet Monza race. Set the phone down, screen on, this page in front (a locked or backgrounded page pauses), Low Power Mode off; it stops itself, then tap SHARE.";
export const HOWTO = [
  "1. Low Power Mode OFF, brightness fixed, note charging and case.",
  "2. Start a race: ONE fixed circuit, WET weather, FULL grid, CHASE camera.",
  "3. Pause > SETTINGS > DISPLAY > METRICS > RECORD. Resume and race 15 min.",
  "4. Pause again, tap STOP, then SHARE (Files / AirDrop / Messages) or COPY.",
  "5. Optional repeats: GRAPHICS MEDIUM, and SGSR on. Same circuit each time.",
  "6. Send every file back; it holds device facts plus a sample every 2 min.",
];
// Renderer A/B (two short runs, one per backend). Shown as a second block.
// f1-game's three paths (WEBGL2 / THREE.JS / WEBGPU picker) became the `?gl=` pin.
export const HOWTO_AB = [
  "A/B: two 5-min runs, same circuit and settings, one per renderer backend:",
  "default (WebGPU where allowed), then reload with ?gl=1 to pin WebGL2.",
  "At each start grid take a screenshot (power + volume up) before RECORD.",
  "Each file records its renderer backend in every sample. Quick facts: QUICK 30s.",
];

const r2 = (n: unknown): number | null => (n != null && Number.isFinite(+(n as number)) ? Math.round(+(n as number) * 100) / 100 : null);
function safe<T>(fn: () => T | undefined, dflt: T): T { try { const v = fn(); return v === undefined ? dflt : v; } catch { return dflt; } }

export type Leaves = Record<string, number | boolean | null>;

// Numeric leaves of a small object (depth <= 2), flattened as "a" / "a.b".
// The renderer's info objects are version-dependent, so the recorder copies numbers, not names.
export function numericLeaves(o: unknown, out: Leaves = {}, prefix = "", depth = 0): Leaves {
  if (!o || typeof o !== "object") return out;
  let n = Object.keys(out).length;
  const rec = o as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (n >= 80) break;
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) { out[prefix + k] = r2(v); n++; }
    else if (typeof v === "boolean") { out[prefix + k] = v; n++; }
    else if (v && typeof v === "object" && !Array.isArray(v) && depth < 1) numericLeaves(v, out, prefix + k + ".", depth + 1);
  }
  return out;
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1] as number;
}

/** What the live readers read. Every member optional: the recorder must never throw. */
export interface RecorderSources {
  gov?: Pick<PerfGov, "frameStats" | "fpsEMA" | "floorMs" | "tier" | "userTier" | "autoShed" | "autoRes" | "scaleFutile" | "tierFutile"> | null;
  spans?: Pick<PerfSpans, "isOn" | "on" | "stats"> | null;
  /** The bound backend and boot reason (src/render/boot.ts BootResult). TODO(lane-render). */
  backend?: () => { name: string; reason?: string } | null;
  renderScale?: () => number;
  /** three's renderer.info (memory + render counters). TODO(lane-render). */
  rendererInfo?: () => unknown;
  /** The debug API's info(): `{ track }` (src/debug/api.ts). */
  info?: () => { track?: string } | null;
  weather?: () => string | null;
  camera?: () => string | null;
  preset?: () => string | null;
  build?: () => string | null;
  store?: RawStore;
}

export interface RecorderEnv {
  now(): number;
  wall(): number;
  facts(): Record<string, unknown>;
  sample(): Record<string, unknown>;
  spans?(on: boolean): void;
  save(txt: string): void;
  load(): string | null;
}

// ---- live readers (every one guarded: the recorder must never throw) -----
export function probeGl(): Record<string, unknown> {
  const out: Record<string, unknown> = { ok: false };
  if (typeof document === "undefined") return out;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const gl = c.getContext("webgl2");
    if (!gl) return out;
    out["ok"] = true;
    for (const e of ["EXT_color_buffer_float", "EXT_color_buffer_half_float", "WEBGL_multi_draw",
      "EXT_disjoint_timer_query_webgl2", "OES_texture_float_linear", "WEBGL_compressed_texture_astc"]) {
      out[e] = !!gl.getExtension(e);   // presence only; no query is ever issued
    }
    out["maxTexture"] = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    out["maxFragUniformVectors"] = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (dbg) out["renderer"] = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();   // hand the slot back: iOS caps live contexts
  } catch { /* leave what was learned */ }
  return out;
}

type Nav = Navigator & { standalone?: boolean; deviceMemory?: number; gpu?: { requestAdapter?: () => Promise<{ features?: { has(f: string): boolean } } | null> } };

export function liveFacts(src: RecorderSources): Record<string, unknown> {
  const w = globalThis as unknown as Window;
  const nav = (typeof navigator !== "undefined" ? navigator : {}) as Partial<Nav>;
  const f: Record<string, unknown> = {
    ua: nav.userAgent || "", platform: nav.platform || "",
    dpr: safe(() => w.devicePixelRatio, 1) || 1,
    screen: safe(() => [w.screen.width, w.screen.height], null),
    inner: safe(() => [w.innerWidth, w.innerHeight], null),
    standalone: safe(() => !!(nav.standalone || (w.matchMedia && w.matchMedia("(display-mode: standalone)").matches)), false),
    hwConcurrency: nav.hardwareConcurrency || null, deviceMemory: nav.deviceMemory || null,
    webgpu: !!nav.gpu, webgpuF16: null,
    build: safe(() => (src.build ? src.build() : null), null),
    backend: safe(() => src.backend?.()?.name ?? "", ""),
    bootReason: safe(() => src.backend?.()?.reason ?? null, null),
    gl: probeGl(),
    lowPowerHint: null,   // not exposed to pages: the cadence below is the only tell (30 Hz = LPM)
  };
  const gpu = nav.gpu;
  if (gpu && gpu.requestAdapter) {
    try {
      Promise.resolve(gpu.requestAdapter()).then((a) => { f["webgpuF16"] = !!(a && a.features && a.features.has("shader-f16")); }, () => { f["webgpuF16"] = false; });
    } catch { /* no adapter */ }
  }
  return f;
}

export function liveSample(src: RecorderSources): Record<string, unknown> {
  const PG = src.gov;
  const fs = safe<Partial<FrameStats> | null>(() => PG?.frameStats(), null) || {};
  const o: Record<string, unknown> = {
    frame: { frames: (fs.frames ?? 0) | 0, p50: r2(fs.p50), p95: r2(fs.p95), p99: r2(fs.p99), max: r2(fs.maxMs),
      droppedSimS: r2(fs.droppedSimS) },
    fpsEMA: r2(safe(() => (PG ? 1000 / PG.fpsEMA() : null), null)),
    floorMs: r2(safe(() => PG?.floorMs(), null)),
    renderScale: r2(safe(() => src.renderScale?.(), null)),
    tier: safe(() => PG?.tier(), null), userTier: safe(() => PG?.userTier(), null),
    autoShed: safe(() => PG?.autoShed(), null), autoRes: safe(() => PG?.autoRes(), null),
    scaleFutile: safe(() => PG?.scaleFutile(), null), tierFutile: safe(() => PG?.tierFutile(), null),
    mem: safe(() => { const m = src.rendererInfo?.(); return m ? numericLeaves(m) : null; }, null),
    heapMB: safe(() => { const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory; return m ? r2(m.usedJSHeapSize / 1048576) : null; }, null),
    circuit: safe(() => src.info?.()?.track, null) || null,
    weather: safe(() => src.weather?.(), null) || null,
    preset: safe(() => src.preset?.(), null),
    cam: safe(() => src.camera?.(), null),
    path: safe(() => { const b = src.backend?.(); return b ? { backend: b.name, reason: b.reason ?? null } : null; }, null),
    // Per-subsystem JS ms/frame over the span ring's last ~8.5 s (spans are ON only while recording).
    spans: safe(() => { const S = src.spans; if (!S) return null; const st = S.stats(); const out: Record<string, { p50: number; p95: number }> = {};
      for (const k of Object.keys(st)) { const v = st[k]; if (v) out[k] = { p50: v.p50, p95: v.p95 }; } return out; }, null),
    visibility: safe(() => document.visibilityState, null),
  };
  return o;
}

export function liveEnv(src: RecorderSources = {}): RecorderEnv {
  const st = src.store ?? localRawStore();
  let spansWas = false;
  const env: RecorderEnv = {
    now: () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()),
    wall: () => Date.now(),
    facts: () => liveFacts(src), sample: () => liveSample(src),
    spans: (on) => { safe(() => { const S = src.spans; if (!S) return null; if (on) { spansWas = S.isOn(); S.on(true); } else if (!spansWas) S.on(false); return null; }, null); },
    save: (txt) => { safe(() => { st.rawSet(KEY, txt); return null; }, null); },
    load: () => safe(() => st.raw(KEY), null),
  };
  return env;
}

export interface SoakRecord {
  schema: string;
  startedAt: string;
  endedAt: string | null;
  durationMin?: number | null;
  facts: Record<string, unknown>;
  cadence: { frames: number; medianMs: number | null; hz: number | null; maxMs: number | null } | null;
  samples: Record<string, unknown>[];
  events: Record<string, unknown>[];
  truncated: boolean;
  mode: "quick" | "soak";
  plan: { sampleMs: number; windowFrames: number; quickMs: number };
}

export interface Recorder {
  start(opts?: { quick?: boolean }): boolean;
  stop(): boolean;
  frame(nowMs?: number | null): void;
  event(kind: string, extra?: Record<string, unknown>): void;
  sample(trigger: string): Record<string, unknown> | null;
  serialize(): string;
  adopt(txt: string): boolean;
  isOn(): boolean;
  record(): SoakRecord | null;
  elapsedMs(): number;
  count(): number;
}

// ---- the recorder: a state machine driven by frame(nowMs) ----------------
export function create(env: RecorderEnv = liveEnv()): Recorder {
  let on = false; let rec: SoakRecord | null = null; let quick = false;
  let t0 = 0; let lastSampleAt = 0; let framesSince = 0; let totalFrames = 0;
  let lastFrameAt = 0; let deltas: number[] = [];

  function event(kind: string, extra?: Record<string, unknown>): void {
    if (!rec || rec.events.length >= MAX_EVENTS) return;
    rec.events.push(Object.assign({ min: r2((env.now() - t0) / 60000), kind }, extra || {}));
  }
  function sample(trigger: string): Record<string, unknown> | null {
    if (!on || !rec) return null;
    const s = Object.assign({ n: rec.samples.length, trigger, min: r2((env.now() - t0) / 60000), frames: totalFrames }, env.sample());
    if (rec.samples.length < MAX_SAMPLES) rec.samples.push(s); else rec.truncated = true;
    lastSampleAt = env.now(); framesSince = 0;
    persist();
    return s;
  }
  function persist(): void {
    const txt = serialize();
    if (txt.length <= MAX_SAVE_CHARS) env.save(txt);
  }
  function start(opts?: { quick?: boolean }): boolean {
    if (on) return false;
    quick = !!(opts && opts.quick);
    if (env.spans) env.spans(true);
    on = true; t0 = env.now(); lastSampleAt = t0; framesSince = 0; totalFrames = 0; lastFrameAt = 0; deltas = [];
    rec = { schema: SCHEMA, startedAt: new Date(env.wall()).toISOString(), endedAt: null,
      facts: env.facts(), cadence: null, samples: [], events: [], truncated: false,
      mode: quick ? "quick" : "soak", plan: { sampleMs: SAMPLE_MS, windowFrames: WINDOW_FRAMES, quickMs: QUICK_MS } };
    sample("start");
    return true;
  }
  function stop(): boolean {
    if (!on || !rec) return false;
    sample("stop");
    rec.endedAt = new Date(env.wall()).toISOString();
    rec.durationMin = r2((env.now() - t0) / 60000);
    on = false; if (env.spans) env.spans(false); persist();
    return true;
  }
  // One call per rendered rAF frame while recording.
  function frame(nowMs?: number | null): void {
    if (!on || !rec) return;
    const now = nowMs == null ? env.now() : nowMs;
    totalFrames++; framesSince++;
    if (lastFrameAt && !rec.cadence) {
      deltas.push(now - lastFrameAt);
      if (deltas.length >= CADENCE_FRAMES) {
        const m = median(deltas);
        rec.cadence = { frames: deltas.length, medianMs: r2(m), hz: m > 0 ? r2(1000 / m) : null,
          maxMs: r2(Math.max.apply(null, deltas)) };
        deltas = [];
      }
    }
    lastFrameAt = now;
    if (quick) { if (now - t0 >= QUICK_MS) stop(); return; }
    if (framesSince >= WINDOW_FRAMES) sample("window");
    else if (now - lastSampleAt >= SAMPLE_MS) sample("timer");
  }
  function serialize(): string {
    if (!rec) return "";
    return JSON.stringify(rec);
  }
  function adopt(txt: string): boolean {   // a previous recording read back from storage
    const o = safe<SoakRecord | null>(() => JSON.parse(txt) as SoakRecord, null);
    if (!o || o.schema !== SCHEMA || on) return false;
    rec = o; return true;
  }
  return {
    start, stop, frame, event, sample, serialize, adopt,
    isOn: () => on, record: () => rec,
    elapsedMs: () => (on ? env.now() - t0 : 0),
    count: () => (rec ? rec.samples.length : 0),
  };
}

// ---- SHARE / COPY --------------------------------------------------------
export function fileName(rec: { startedAt?: string } | null): string {
  const stamp = String((rec && rec.startedAt) || "").replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return "a26-soak-" + (stamp || "run") + ".json";
}

export interface ShareResult { how: "share" | "download" | "cancelled" | "none"; url?: string; name?: string }
interface ShareDeps { doc?: Document; URL?: { createObjectURL(b: Blob): string; revokeObjectURL(u: string): void }; nav?: Partial<Navigator> }

// The panel keeps one fallback link. Replacing it must release the old
// recording blob; keep the current URL usable, and allow the browser the
// same 10 s read window as the other export flows before revoking an old one.
let releaseDownload: (() => void) | null = null;
export function download(text: string, name: string, d?: ShareDeps): ShareResult {
  const doc = (d && d.doc) || (typeof document !== "undefined" ? document : null);
  const URLc = (d && d.URL) || (typeof URL !== "undefined" ? URL : null);
  if (!doc || !URLc || typeof Blob === "undefined") return { how: "none" };
  const url = URLc.createObjectURL(new Blob([text], { type: "application/json" }));
  if (releaseDownload) releaseDownload();
  releaseDownload = () => setTimeout(() => safe(() => URLc.revokeObjectURL(url), null), 10000);
  const a = doc.createElement("a");
  a.href = url; a.download = name; a.textContent = "DOWNLOAD " + name;
  a.style.display = "none";
  (doc.body || doc.documentElement).appendChild(a);
  safe(() => a.click(), null);
  safe(() => a.remove(), null);
  return { how: "download", url, name };
}
// Resolves to {how: share|download|cancelled|none, url?, name?}. The file is
// built synchronously inside the tap, which iOS requires for navigator.share.
export function share(text: string, name: string, d: ShareDeps = {}): Promise<ShareResult> {
  const nav = d.nav || (typeof navigator !== "undefined" ? navigator : null);
  try {
    if (nav && typeof nav.share === "function" && typeof File === "function") {
      const f = new File([text], name, { type: "application/json" });
      if (!nav.canShare || nav.canShare({ files: [f] })) {
        return Promise.resolve(nav.share({ files: [f], title: name })).then(
          (): ShareResult => ({ how: "share", name }),
          (e: unknown): ShareResult => (e && (e as { name?: string }).name === "AbortError" ? { how: "cancelled", name } : download(text, name, d)));
      }
    }
  } catch { /* fall through to a download */ }
  return Promise.resolve(download(text, name, d));
}
export function copy(text: string, d: ShareDeps = {}): Promise<boolean> {
  const nav = d.nav || (typeof navigator !== "undefined" ? navigator : null);
  const viaTextarea = (): boolean => {
    const doc = d.doc || (typeof document !== "undefined" ? document : null);
    if (!doc) return false;
    const ta = doc.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    doc.body.appendChild(ta); ta.select();
    // execCommand is deprecated but is the only copy path on plain http / old iOS.
    const ok = safe(() => (doc as Document & { execCommand(c: string): boolean }).execCommand("copy"), false);
    ta.remove();
    return !!ok;
  };
  if (nav && nav.clipboard && nav.clipboard.writeText) {
    return Promise.resolve(nav.clipboard.writeText(text)).then(() => true, () => viaTextarea());
  }
  return Promise.resolve(viaTextarea());
}

// ---- panel + REC badge ---------------------------------------------------
export interface PhoneRecorderDeps extends RecorderSources {
  /** Where the REC badge goes (default document.body). */
  badgeHost?: HTMLElement;
  /** The AUTO SOAK driver (./soak-run.ts). */
  soak?: { active(): boolean; start(): Promise<boolean>; stop(why?: string): unknown; status(): { state?: string } } | null;
  /** Ask the metrics overlay for its telemetry sources (f1-game GameMetrics.ensureTelemetry). */
  ensureTelemetry?: () => void;
  env?: RecorderEnv;
}

function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

export interface PhoneRecorderPanel {
  recorder: Recorder;
  start(): boolean;
  stop(): boolean;
  isOn(): boolean;
  json(): string;
  unmount(): void;
}

/** Build the PHONE TEST block into `host` (f1-game mounted into `#pm-metrics-details .pm-metrics-sub-body`). */
export function mount(host: HTMLElement, deps: PhoneRecorderDeps = {}): PhoneRecorderPanel {
  const doc = host.ownerDocument;
  const env = deps.env ?? liveEnv(deps);
  const r = create(env);
  let _raf = 0; let _badge: HTMLElement | null = null; let _lastBadgeSec = -1;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  function loop(t: number): void {
    _raf = 0;
    if (!r.isOn()) return;
    r.frame(t);
    paintBadge();
    _raf = requestAnimationFrame(loop);
  }
  function kick(): void { if (!_raf && typeof requestAnimationFrame === "function") _raf = requestAnimationFrame(loop); }

  function paintBadge(): void {
    if (!r.isOn()) { if (_badge) _badge.hidden = true; return; }
    const sec = Math.floor(r.elapsedMs() / 1000);
    if (sec === _lastBadgeSec) return;
    _lastBadgeSec = sec;
    if (!_badge) {
      _badge = doc.createElement("div");
      _badge.id = "phone-rec-badge";
      _badge.setAttribute("aria-hidden", "true");
      (deps.badgeHost ?? doc.body).appendChild(_badge);
    }
    _badge.hidden = false;
    _badge.textContent = "● REC " + fmtClock(r.elapsedMs()) + " · " + r.count();
    paintUI();
  }

  const box = doc.createElement("div");
  box.id = "pm-phonerec"; box.setAttribute("role", "group"); box.setAttribute("aria-label", "Phone test recorder");
  const h = doc.createElement("p"); h.className = "adv-help"; h.style.fontWeight = "700"; h.textContent = "PHONE TEST";
  const how = doc.createElement("ol"); how.className = "adv-help";
  HOWTO.forEach((l) => { const li = doc.createElement("li"); li.textContent = l.replace(/^\d\. /, ""); how.appendChild(li); });
  const au = doc.createElement("p"); au.className = "adv-help"; au.textContent = HOWTO_AUTO;
  const ab = doc.createElement("ol"); ab.className = "adv-help";
  HOWTO_AB.forEach((l) => { const li = doc.createElement("li"); li.textContent = l; ab.appendChild(li); });
  const row = doc.createElement("div"); row.style.margin = "0";
  const mk = (id: string, label: string, fn: () => void): HTMLButtonElement => {
    const b = doc.createElement("button");
    b.type = "button"; b.id = id; b.textContent = label;
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    row.appendChild(b); return b;
  };
  const status = doc.createElement("p"); status.className = "adv-help"; status.setAttribute("role", "status");
  const link = doc.createElement("p"); link.className = "adv-help";
  const ui = {
    auto: mk("pm-phonerec-auto", "AUTO SOAK", onAuto),
    rec: mk("pm-phonerec-rec", "RECORD", () => onRecord(false)),
    quick: mk("pm-phonerec-quick", "QUICK 30s", () => onRecord(true)),
    share: mk("pm-phonerec-share", "SHARE", onShare),
    copy: mk("pm-phonerec-copy", "COPY", onCopy),
    status, link,
  };
  [h, au, how, ab, row, status, link].forEach((n) => box.appendChild(n));
  host.appendChild(box);

  function paintUI(): void {
    const have = r.isOn() || !!r.record();
    ui.rec.textContent = r.isOn() ? "STOP" : "RECORD";
    ui.quick.disabled = r.isOn();
    const auto = !!deps.soak && deps.soak.active();
    ui.auto.textContent = auto ? "STOP AUTO" : "AUTO SOAK";
    ui.rec.disabled = auto;
    ui.rec.setAttribute("aria-pressed", r.isOn() ? "true" : "false");
    ui.share.disabled = !have; ui.copy.disabled = !have;
    if (!ui.status.dataset["msg"]) {
      ui.status.textContent = auto ? "auto soak " + (deps.soak?.status().state || "") + " · " + fmtClock(r.elapsedMs()) + " · " + r.count() + " samples" : r.isOn() ? "recording · " + fmtClock(r.elapsedMs()) + " · " + r.count() + " samples"
        : (have ? "saved run: " + r.count() + " samples" : "idle — nothing runs until you tap RECORD");
    }
  }
  function flash(msg: string): void {
    ui.status.textContent = msg; ui.status.dataset["msg"] = "1";
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashTimer = null; delete ui.status.dataset["msg"]; paintUI(); }, 4000);
  }

  function onRecord(quick: boolean): void {
    if (r.isOn()) { r.stop(); flash("stopped · " + r.count() + " samples · tap SHARE"); }
    else {
      safe(() => { deps.ensureTelemetry?.(); return null; }, null);
      r.start({ quick }); kick();
      flash(quick ? "quick facts: stay on this screen 30 s" : "recording — resume and race 15 min");
    }
    paintBadge(); paintUI();
  }
  function onAuto(): void {
    const soak = deps.soak;
    if (!soak) { flash("auto soak unavailable on this build"); return; }
    if (soak.active()) { soak.stop("stopped"); flash("auto soak stopped"); paintUI(); return; }
    flash("auto soak: building a wet Monza race, keep this screen on");
    void soak.start().then((ok) => { if (!ok) flash("auto soak could not start"); paintUI(); });
  }
  function current(): { text: string; name: string } { return { text: r.serialize(), name: fileName(r.record()) }; }
  function onShare(): void {
    if (r.isOn()) r.stop();
    const c = current(); if (!c.text) return;
    void share(c.text, c.name).then((res) => {
      if (res.how === "download") showLink(res);
      flash(res.how === "share" ? "shared" : res.how === "cancelled" ? "share cancelled" : res.how === "download" ? "saved: tap the link below" : "cannot share here: use COPY");
    });
    paintUI();
  }
  function showLink(res: ShareResult): void {
    ui.link.textContent = "";
    const a = doc.createElement("a");
    a.href = res.url || ""; a.download = res.name || ""; a.textContent = "DOWNLOAD " + (res.name || "");
    ui.link.appendChild(a);
  }
  function onCopy(): void {
    const c = current(); if (!c.text) return;
    void copy(c.text).then((ok) => flash(ok ? "copied " + Math.round(c.text.length / 1024) + " KB" : "copy blocked: use SHARE"));
  }

  const onVis = (): void => { if (r.isOn()) r.event("visibility", { state: doc.visibilityState }); };
  doc.addEventListener("visibilitychange", onVis);

  // A run that survived a tab kill is shareable without recording again.
  if (!r.record()) { const txt = env.load(); if (txt) r.adopt(txt); }
  paintUI();
  perfLog.info("game", "PhoneRecorder.mount");

  return {
    recorder: r,
    start: () => { const ok = r.start(); kick(); paintBadge(); paintUI(); return ok; },
    stop: () => { const ok = r.stop(); paintBadge(); paintUI(); return ok; },
    isOn: () => r.isOn(),
    json: () => r.serialize(),
    unmount: () => {
      doc.removeEventListener("visibilitychange", onVis);
      if (_raf) cancelAnimationFrame(_raf);
      _raf = 0;
      if (flashTimer) clearTimeout(flashTimer);
      box.remove();
      _badge?.remove();
    },
  };
}
