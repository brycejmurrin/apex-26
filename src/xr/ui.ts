// The ENTER VR button. Ported from f1-game js/xr/xr-ui.js:1-115 (XrUi).
//
// Shown only after isSessionSupported("immersive-vr") resolves true. A visible
// button always starts VR, switches the renderer to the XR-capable WebGL2 path
// (one reload), or shows a clear error; never a silent no-op.
import type { XrBoot } from "./boot";
import type { XrSession } from "./session";

export const BUTTON_ID = "xr-enter";
export const FLASH_MS = 3500;

export interface XrUiDeps {
  session: XrSession;
  boot?: XrBoot;
  /** Default the page's document. */
  doc?: Document;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

const errMessage = (e: unknown): string | null =>
  e instanceof Error ? e.message || null : e == null ? null : String(e) || null;

export class XrUi {
  private _btn: HTMLButtonElement | null = null;
  private _mounted = false;
  private _unsub: (() => void) | null = null;
  private _msgTimer: unknown = null;

  constructor(private readonly deps: XrUiDeps) {}

  private doc(): Document {
    return this.deps.doc ?? document;
  }

  /** xr-ui.js:16-29 */
  ensureButton(): HTMLButtonElement {
    if (this._btn) return this._btn;
    const b = this.doc().createElement("button");
    b.id = BUTTON_ID;
    b.type = "button";
    b.title = "VR: A/X recenter, B/Y pause. Supported overlay menus: stick navigate, A/X select, B/Y back.";
    b.hidden = true;
    b.setAttribute("aria-label", "Enter VR");
    b.setAttribute("aria-pressed", "false");
    b.textContent = "ENTER VR";
    b.addEventListener("click", (e) => void this.onClick(e));
    this._btn = b;
    return b;
  }

  /** xr-ui.js:31-41 */
  flashMessage(msg: string): void {
    const b = this.ensureButton();
    b.textContent = msg;
    b.disabled = true;
    const clear = this.deps.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
    const set = this.deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    if (this._msgTimer !== null) clear(this._msgTimer);
    this._msgTimer = set(() => {
      this._msgTimer = null;
      b.disabled = false;
      this.syncLabel();
    }, FLASH_MS);
  }

  /** xr-ui.js:43-67 */
  async onClick(e?: Event): Promise<void> {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const s = this.deps.session;
    if (this._btn && this._btn.disabled) return;
    if (s.isPresenting()) {
      await s.end();
      return;
    }
    // Both armed and spontaneous entry use the reversible WebGL2 pin.
    const boot = this.deps.boot;
    if (boot) {
      const gate = boot.ensureXrBackend();
      if (gate.reloading) {
        this.flashMessage("SWITCHING…");
        return;
      }
      if (!gate.ok) {
        this.flashMessage(gate.message || "VR UNAVAILABLE");
        return;
      }
    }
    try {
      const started = await s.start();
      if (!started) this.flashMessage(errMessage(s.lastError()) || "VR FAILED");
    } catch (err) {
      this.flashMessage(errMessage(err) || "VR FAILED");
    }
  }

  /** xr-ui.js:69-75 */
  syncLabel(): void {
    const b = this._btn;
    if (!b || b.disabled) return;
    const on = this.deps.session.isPresenting();
    b.textContent = on ? "EXIT VR" : "ENTER VR";
    b.setAttribute("aria-label", on ? "Exit VR" : "Enter VR");
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }

  /** xr-ui.js:77-81 */
  show(on: boolean): void {
    const b = this.ensureButton();
    b.hidden = !on;
    if (on) this.syncLabel();
  }

  /** xr-ui.js:83-104: append the (hidden) button and probe; it shows when supported. */
  mount(parent?: HTMLElement | null): HTMLButtonElement {
    const b = this.ensureButton();
    if (this._mounted) return b;
    const host = parent || this.doc().body;
    host.appendChild(b);
    this._mounted = true;
    const s = this.deps.session;
    this._unsub = s.on((ev, _detail) => {
      if (ev === "capability") {
        this.show(s.isSupported());
      } else if (ev === "start" || ev === "end") {
        this.syncLabel();
        this.show(s.isSupported());
      }
    });
    void Promise.resolve(s.probe()).then((ok) => this.show(!!ok), () => this.show(false));
    return b;
  }

  /** xr-ui.js:106-111 */
  unmount(): void {
    if (this._unsub) {
      try {
        this._unsub();
      } catch {
        /* */
      }
      this._unsub = null;
    }
    if (this._msgTimer !== null) {
      (this.deps.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)))(this._msgTimer);
      this._msgTimer = null;
    }
    if (this._btn && this._btn.parentNode) this._btn.parentNode.removeChild(this._btn);
    this._mounted = false;
  }
}
