/**
 * ThreeInspector: OPT-IN dev panel, the official three.js Inspector
 * (Performance / Memory / Timeline / Viewer / Parameters / Console) on the
 * WebGPURenderer. Ported from f1-game js/perf/three-inspector.js:1-108; the IIFE
 * became `createThreeInspector(deps)`.
 *
 * `?inspector=1` or set(host, true); default ON on dev hosts
 * (localhost/127.0.0.1/::1/file:), OFF on the deployed site and under
 * navigator.webdriver; remembered in a26.inspector. Costs nothing when off:
 * three/addons/inspector/ is fetched by a dynamic import() only on enable, so
 * Vite splits it into its own chunk. GPU timings need the WebGPU backend with
 * timestamp-query; on the WebGL2 fallback (and SwiftShader) the other tabs still
 * work. While on, the host's own GPU timer is held off (`hold(true)`) so only
 * one consumer resolves timestamp queries.
 *
 * Changes from f1-game: the host comes from an injected `inspectorHost()`
 * (f1-game tlx.inspectorHost) instead of `gfx.inspectorHost`, and teardown
 * restores the renderer's ORIGINAL inspector (three's InspectorBase) rather
 * than assigning null — three's setter calls `value.setRenderer(this)`, so
 * null throws after the assignment (f1-game swallowed that in a try).
 */
import { localRawStore, perfLog, type RawStore } from "./env";

/** The renderer slice the Inspector attaches to: three's `renderer.inspector` setter. */
export interface InspectableRenderer {
  inspector: unknown;
  backend?: unknown;
}

/** f1-game tlx.inspectorHost(): the renderer plus a hold on the host's own GPU timer. TODO(lane-render). */
export interface InspectorHost {
  renderer: InspectableRenderer;
  hold(on: boolean): void;
}

interface InspectorInstance { domElement?: HTMLElement }
type InspectorModule = { Inspector: new () => InspectorInstance };

export interface ThreeInspectorDeps {
  store?: RawStore;
  /** The addon loader (default: dynamic import of three/addons/inspector/Inspector.js). */
  importInspector?: () => Promise<InspectorModule>;
  doc?: Document;
  location?: Pick<Location, "hostname" | "protocol" | "search">;
  webdriver?: () => boolean;
}

export interface InspectorStatus { on: boolean; supported: boolean; reason: string; loading: boolean }

export const INSPECTOR_KEY = "a26.inspector";
const CLOSE_ID = "three-inspector-close";
const CLOSE_CSS = "position:fixed;right:6px;top:6px;z-index:10001;width:32px;height:32px;padding:0;" +
  "border-radius:16px;border:1px solid #888;background:rgba(0,0,0,.7);color:#fff;font:16px/1 sans-serif;" +
  "cursor:pointer;pointer-events:auto;touch-action:manipulation";

const defaultImport = (): Promise<InspectorModule> =>
  import("three/addons/inspector/Inspector.js") as unknown as Promise<InspectorModule>;

export function createThreeInspector(deps: ThreeInspectorDeps = {}) {
  const st = deps.store ?? localRawStore();
  const importInspector = deps.importInspector ?? defaultImport;
  const doc = (): Document | null => deps.doc ?? (typeof document !== "undefined" ? document : null);
  const loc = (): Pick<Location, "hostname" | "protocol" | "search"> | null =>
    deps.location ?? (typeof location !== "undefined" ? location : null);

  let inspector: InspectorInstance | null = null;   // live Inspector instance
  let host: InspectorHost | null = null;
  let prevInspector: unknown = null;                // the renderer's own InspectorBase, restored on teardown
  let closeBtn: HTMLButtonElement | null = null;
  let token = 0;          // bumps on every on/off so a slow import cannot resurrect a disabled panel
  let last: { on: boolean; supported: boolean; reason: string } = { on: false, supported: false, reason: "off" };

  function devHost(): boolean {
    const l = loc();
    if (!l) return false;
    const h = l.hostname, pr = l.protocol;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || pr === "file:";
  }
  function store(v: boolean): void { try { st.rawSet(INSPECTOR_KEY, v ? "1" : "0"); } catch { /* private mode: not remembered */ } }
  // Precedence: ?inspector=0|1 (remembered) > stored a26.inspector > default. Default is ON only on dev/agent
  // hosts (localhost, 127.0.0.1, ::1, file:) and OFF on the deployed site and under automation (navigator.webdriver:
  // the Playwright harness serves on 127.0.0.1 and must not pay for extra requests + an overlay).
  function wanted(): boolean {
    try {
      const m = /[?&]inspector=([01])(&|$)/.exec(loc()?.search ?? "");
      if (m) { store(m[1] === "1"); return m[1] === "1"; }
      const v = st.raw(INSPECTOR_KEY);
      if (v === "1" || v === "0") return v === "1";
      const wd = deps.webdriver ? deps.webdriver() : (typeof navigator !== "undefined" && !!navigator.webdriver);
      return devHost() && !wd;
    } catch { return false; }
  }

  function say(msg: string): void { perfLog.info("gfx", "[inspector] " + msg); }

  function teardown(): void {
    token++;
    if (closeBtn && closeBtn.parentNode) closeBtn.parentNode.removeChild(closeBtn);
    closeBtn = null;
    const insp = inspector, h = host;
    inspector = null; host = null;
    try { if (h && h.renderer && prevInspector) h.renderer.inspector = prevInspector; } catch { /* renderer may be gone */ }
    prevInspector = null;
    try { if (insp && insp.domElement && insp.domElement.parentNode) insp.domElement.parentNode.removeChild(insp.domElement); } catch { /* detached already */ }
    try { if (h) h.hold(false); } catch { /* renderer may be gone */ }
  }

  async function enable(getHost: (() => InspectorHost | null) | null): Promise<void> {
    const h = getHost ? getHost() : null;
    if (!h || !h.renderer) {
      last = { on: false, supported: false, reason: "no three.js renderer is up yet" };
      say("not available: " + last.reason);
      return;
    }
    if (inspector && host && host.renderer === h.renderer) { last = { on: true, supported: true, reason: "on" }; return; }
    teardown();
    const mine = ++token;
    last = { on: true, supported: true, reason: "loading" };
    let mod: InspectorModule;
    try { mod = await importInspector(); } catch (e) {
      last = { on: false, supported: true, reason: "import failed: " + (e instanceof Error ? e.message : String(e)) };
      say(last.reason);
      return;
    }
    if (mine !== token) return;   // turned off (or replaced) while the files loaded
    const d = doc();
    try {
      host = h;
      h.hold(true);
      inspector = new mod.Inspector();
      prevInspector = h.renderer.inspector;
      h.renderer.inspector = inspector;   // three's setter calls inspector.setRenderer(renderer)
      if (d) {
        const btn = d.createElement("button");
        btn.id = CLOSE_ID;
        btn.type = "button";
        btn.textContent = "×";
        btn.setAttribute("aria-label", "Close three.js Inspector");
        btn.style.cssText = CLOSE_CSS;
        btn.addEventListener("click", () => { store(false); teardown(); last = { on: false, supported: true, reason: "off" }; }, { once: true });
        d.body.appendChild(btn);
        closeBtn = btn;
      }
      last = { on: true, supported: true, reason: "on" };
      const be = h.renderer.backend as { isWebGPUBackend?: boolean } | undefined;
      say("on (" + (be && be.isWebGPUBackend ? "WebGPU" : "WebGL2") + ")");
    } catch (e) {
      teardown();
      last = { on: false, supported: true, reason: "init failed: " + (e instanceof Error ? e.message : String(e)) };
      say(last.reason);
    }
  }

  function status(): InspectorStatus { return { on: !!inspector, supported: last.supported, reason: last.reason, loading: !inspector && last.on }; }

  // set(host, on): on===undefined reads. enable() settles later (dynamic import), so `loading` marks the gap.
  function set(getHost: (() => InspectorHost | null) | null, on?: boolean): InspectorStatus {
    if (on === true) { store(true); void enable(getHost); }
    else if (on === false) { store(false); teardown(); last = { on: false, supported: last.supported, reason: "off" }; }
    return status();
  }

  /** Enable at boot when wanted(); resolves once the import settles. */
  function boot(getHost: (() => InspectorHost | null) | null): Promise<void> { return wanted() ? enable(getHost) : Promise.resolve(); }

  return { set, boot, wanted, stop: teardown, status };
}

export type ThreeInspector = ReturnType<typeof createThreeInspector>;
