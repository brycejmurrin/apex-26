/**
 * GfxDebug: ON-SCREEN GFX DIAGNOSTIC (?gfxdebug=1 / a26.gfxDebug="1"). Ported
 * from f1-game js/perf/gfx-debug-overlay.js:1-291, the backend-neutral parts.
 *
 * The renderer's own verdict rendered as DOM, for the player who sees a wrong
 * frame on hardware no agent here can run and has no console to read back:
 * the bound backend, GPU errors, renderer memory, the loop heartbeat and the
 * debug API's info() made readable and COPYABLE without devtools. It arms from
 * the URL so a report is one link away, and costs everyone else one
 * query-string test.
 *
 * KEPT: wanted(), the build line, gpuErrors (when the host has a hook), the mem
 * line (heap + renderer memory + tier/strikes), the LOOP HEARTBEAT (the one line
 * that is true when the loop is dead), track/fps, the COPY button, the 500 ms
 * timer. DROPPED as f1-game-backend-specific: picks() (apex26.gfxBackend /
 * tlxForceGL / gfxTlxFail / gfxWgxFail and RendererPicker.liveBackend — apex-26
 * has one backend chosen by src/render/policy.ts, reported here as
 * `backend reason`), pushThreeState (TLX backendState / envState / skyState /
 * chunkState / postState), and pushFrameState (GLX/WGX soft-blit readback of
 * #game-soft). `extraLines` is the hook for render-lane state that replaces them.
 */
import { copy } from "./phone-recorder";
import { localRawStore, nowMs, perfLog, type RawStore } from "./env";
import type { LoopHealthState } from "./loop-health";

const ID = "gfx-debug";
const PAINT_MS = 500;
const PANEL_CSS = "position:fixed;left:8px;top:8px;z-index:9999;max-width:min(92vw,560px);" +
  "max-height:70vh;overflow:auto;background:rgba(0,0,0,.78);color:#9fe;padding:6px 8px;" +
  "border-radius:6px;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;" +
  "pointer-events:auto;user-select:text";
const COPY_BTN_CSS = "float:right;margin:0 0 4px 8px;font:10px/1 inherit;padding:3px 6px;" +
  "background:#123;color:#9fe;border:1px solid #9fe;border-radius:4px;cursor:pointer";
export const GFX_DEBUG_KEY = "a26.gfxDebug";

export interface GfxDebugDeps {
  store?: RawStore;
  search?: () => string;
  build?: () => string | null;
  /** The bound backend and boot reason (src/render/boot.ts BootResult). TODO(lane-render). */
  backend?: () => { name: string; reason?: string } | null;
  /** GPU validation errors, when the render lane captures them. TODO(lane-render). */
  gpuErrors?: () => { count: number; first?: string } | null;
  /** three's renderer.info.memory ({ geometries, textures }). TODO(lane-render). */
  rendererMemory?: () => { geometries?: number; textures?: number } | null;
  gov?: { tier(): number; strikes(): number } | null;
  loop?: { state(): LoopHealthState } | null;
  /** The debug API's info() (src/debug/api.ts) plus an fps reading. */
  info?: () => { track?: string; fps?: number } | null;
  /** Render-lane lines that replace f1-game's TLX state dump. */
  extraLines?: () => string[];
  host?: HTMLElement;
}

function num(v: unknown): number | "?" { return typeof v === "number" && isFinite(v) ? v : "?"; }

export function loopStatus(h: LoopHealthState, dFrames: number, dtMs: number): string {
  if (h.stopped) return "STOPPED at the fault cap";
  if (h.frames === 0) return "NO FRAME COMPLETED YET";
  if (dtMs && dFrames === 0) return `NO FRAME in the last ${dtMs}ms`;
  return `+${dFrames} frames/${dtMs}ms`;
}

export function createGfxDebug(deps: GfxDebugDeps = {}) {
  const st = deps.store ?? localRawStore();
  let el: HTMLElement | null = null;
  let pre: HTMLElement | null = null;
  let timer: ReturnType<typeof setInterval> | 0 = 0;
  // Previous loop sample, so the heartbeat line in build() can be a DELTA
  let lastFrames = 0;
  let lastPaintAt = 0;

  function wanted(): boolean {
    try {
      const search = deps.search ? deps.search() : (typeof location !== "undefined" ? location.search : "");
      return /[?&]gfxdebug=1/.test(search) || st.raw(GFX_DEBUG_KEY) === "1";
    } catch { return false; }
  }

  // I-5 (#1648): one pasteable line. Heap is Chrome-only (performance.memory);
  // geometries / textures come from three's renderer.info.memory. A host
  // without that hook prints "?".
  function pushMem(lines: string[]): void {
    let heap = "n/a";
    try {
      const m = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
      if (m && typeof m.usedJSHeapSize === "number") heap = (m.usedJSHeapSize / 1048576).toFixed(1) + "MB";
    } catch { /* performance.memory is Chromium-only */ }
    let geo: number | "?" = "?", tex: number | "?" = "?";
    try {
      const ms = deps.rendererMemory && deps.rendererMemory();
      if (ms) { geo = num(ms.geometries); tex = num(ms.textures); }
    } catch { /* memory hook threw: the rest of the line still pastes */ }
    let tier: number | "?" = "?", strikes: number | "?" = "?";
    try {
      if (deps.gov) { tier = num(deps.gov.tier()); strikes = num(deps.gov.strikes()); }
    } catch { /* governor not loaded */ }
    lines.push(`mem heap=${heap} geo=${geo} tex=${tex} tier=${tier} crashStrikes=${strikes}`);
  }

  // THE ONE LINE THAT IS TRUE WHEN THE LOOP IS DEAD. Everything else here reads
  // a value the frame loop wrote (the fps below included), so it freezes at its
  // last healthy reading; this overlay runs on setInterval and outlives the
  // loop. The heartbeat is RELATIVE — frames completed since the last paint —
  // not a millisecond threshold: "staleMs > 1000" reads a healthy headless page
  // (measured 6993 ms) and a struggling phone as dead, while a count that does
  // not move between two paints is a stall at any frame rate
  function pushLoopState(lines: string[]): void {
    if (!deps.loop) return;
    try {
      const h = deps.loop.state();
      const t = nowMs();
      const dFrames = h.frames - lastFrames;
      const dtMs = lastPaintAt ? Math.round(t - lastPaintAt) : 0;
      lastFrames = h.frames;
      lastPaintAt = t;
      lines.push(`loop: ${loopStatus(h, dFrames, dtMs)}` +
        `  total=${h.frames} staleMs=${h.staleMs == null ? "-" : h.staleMs}` +
        `  faults=${h.faults}/${h.totalCap} run=${h.run}/${h.cap}` +
        (h.lastFault ? `\n      lastFault: ${h.lastFault}` : ""));
    } catch { lines.push("loop: unreadable"); }
  }

  function build(): string {
    const lines: string[] = [];
    let id = "";
    try { id = (deps.build && deps.build()) || ""; } catch { /* no build stamp */ }
    lines.push(`APEX 26 GFX  build ${id || "?"}`);

    let b: { name: string; reason?: string } | null = null;
    try { b = deps.backend ? deps.backend() : null; } catch { b = null; }
    if (!b) { lines.push("renderer: not booted — no backend bound"); }
    else lines.push(`backend=${b.name}  reason=${b.reason || "?"}`);

    // GPU validation errors. Zero here is the single most useful fact a report
    // can carry: it separates "the frame is wrong" from "the frame was never
    // legally submitted", and those have nothing in common as bugs
    try {
      const g = deps.gpuErrors ? deps.gpuErrors() : null;
      if (g) {
        lines.push(`gpuErrors=${num(g.count)}`);
        if (g.count > 0 && g.first) lines.push(`  first: ${String(g.first).replace(/\s+/g, " ").slice(0, 300)}`);
      } else lines.push("gpuErrors=(backend has no error hook)");
    } catch { lines.push("gpuErrors=(hook threw)"); }

    try { if (deps.extraLines) for (const l of deps.extraLines()) lines.push(l); } catch (e) { lines.push("render state threw: " + (e instanceof Error ? e.message : String(e))); }
    pushMem(lines);
    pushLoopState(lines);

    try {
      const info = deps.info ? deps.info() : null;
      if (info) lines.push(`track=${info.track || "-"} fps=${num(Math.round(info.fps || 0))}`);
    } catch { /* pre-race */ }
    return lines.join("\n");
  }

  function tick(): void {
    if (!pre) return;
    try { pre.textContent = build(); }
    catch (e) { pre.textContent = "gfx-debug failed: " + (e instanceof Error ? e.message : String(e)); }
  }

  function copyReport(btn: HTMLElement): void {
    const text = pre ? pre.textContent || "" : "";
    const done = (): void => { btn.textContent = "COPIED"; setTimeout(() => { btn.textContent = "COPY"; }, 1200); };
    // Always flash COPIED after an attempt — the overlay text stays selectable
    // if both paths fail.
    void copy(text).then(done, done);
  }

  function install(): void {
    const host = deps.host ?? (typeof document !== "undefined" ? document.body : null);
    if (el || !host) return;
    const doc = host.ownerDocument;
    el = doc.createElement("div");
    el.id = ID;
    el.style.cssText = PANEL_CSS;
    const btn = doc.createElement("button");
    btn.textContent = "COPY";
    btn.style.cssText = COPY_BTN_CSS;
    btn.addEventListener("click", () => copyReport(btn));
    pre = doc.createElement("div");
    el.appendChild(btn);
    el.appendChild(pre);
    host.appendChild(el);
    tick();
    timer = setInterval(tick, PAINT_MS);
    perfLog.info("gfx", "[gfx-debug] overlay on");
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = 0;
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
    pre = null;
  }

  return { install, stop, text: build, wanted };
}

export type GfxDebug = ReturnType<typeof createGfxDebug>;

/**
 * Install the overlay when wanted(), on a later turn of the loop: the shell
 * calls this before the renderer has booted and the first paint reads the
 * backend, so a synchronous install would paint one frame of "not booted"
 * and could out-order the very thing it is meant to report.
 */
export function mount(deps: GfxDebugDeps = {}): GfxDebug {
  const g = createGfxDebug(deps);
  if (g.wanted()) setTimeout(() => g.install(), 0);
  return g;
}
