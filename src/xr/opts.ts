// SETTINGS > DISPLAY rows for VR MODE, VR RENDERER and VR DRIVING. Ported from
// f1-game js/xr/xr-opts.js:1-206 (XROpts).
//
// Keys (raw strings in localStorage):
//   a26.xr         "0" | "1"                      default "0"
//   a26.xrBackend  "webgl2" | "webgpu"            default "webgl2"
//   a26.xrInput    "controllers" | "existing"     default "controllers" (live)
//
// The rows stay hidden unless immersive-vr is capable. Changing VR MODE or VR
// RENDERER shows "Reload to apply" and reloads outside a race. Never writes the 2D
// renderer pick. The rows are data (`xrSettingRows`) so the shell's own settings row
// component can render them; `buildXrSettingsBlock` is a plain-DOM fallback.
import { normBackend, normXr, type XrBackendPref } from "./plan";
import { KEY_XR, KEY_XR_BACKEND, KEY_XR_CAPS, KEY_XR_INPUT, localStore, sGet, sSet, type StorageSource } from "./store";

export { KEY_XR, KEY_XR_BACKEND, KEY_XR_INPUT } from "./store";
export const DEF_XR = "0";
export const DEF_BACKEND: XrBackendPref = "webgl2";

export type XrInputMode = "controllers" | "existing";

export interface XrOptsDeps {
  /** Default: the page's localStorage, guarded. */
  storage?: StorageSource;
  /** A VR pref changed: drop the cached plan (f1-game ApexXR.invalidate). */
  onChange?: () => void;
  /** EXISTING CONTROLS chosen: release the XR input lane (f1-game Input.remoteLost("xr")). */
  releaseXrInput?: () => void;
  /** Immersive-vr capable now (f1-game ApexXR.caps().vr); default reads the a26.xrCaps latch. */
  capsVr?: () => boolean;
}

/** xr-opts.js:14-113: the VR prefs, cached like f1-game (xr / xrBackend), xrInput live. */
export class XrOpts {
  private _xr: boolean | null = null;
  private _backend: XrBackendPref | null = null;
  private readonly storage: StorageSource;

  constructor(private readonly deps: XrOptsDeps = {}) {
    this.storage = deps.storage ?? localStore;
  }

  private readXr(): "0" | "1" {
    const v = sGet(this.storage, KEY_XR);
    if (v == null || v === "") return DEF_XR;
    return normXr(v);
  }

  private readBackend(): XrBackendPref {
    const v = sGet(this.storage, KEY_XR_BACKEND);
    if (v == null || v === "") return DEF_BACKEND;
    return normBackend(v);
  }

  /** VR MODE armed. */
  xr(): boolean {
    if (this._xr === null) this._xr = this.readXr() === "1";
    return this._xr;
  }

  setXr(on: boolean): boolean {
    this._xr = !!on;
    sSet(this.storage, KEY_XR, this._xr ? "1" : "0");
    this.deps.onChange?.();
    return this._xr;
  }

  xrBackend(): XrBackendPref {
    if (this._backend === null) this._backend = this.readBackend();
    return this._backend;
  }

  setXrBackend(v: unknown): XrBackendPref {
    this._backend = normBackend(v);
    sSet(this.storage, KEY_XR_BACKEND, this._backend);
    this.deps.onChange?.();
    return this._backend;
  }

  /** Live choice: read on every XR frame so imports and another tab take effect. */
  xrInput(): XrInputMode {
    return sGet(this.storage, KEY_XR_INPUT) === "existing" ? "existing" : "controllers";
  }

  setXrInput(v: unknown): XrInputMode {
    const mode: XrInputMode = v === "existing" ? "existing" : "controllers";
    sSet(this.storage, KEY_XR_INPUT, mode);
    if (mode === "existing") this.deps.releaseXrInput?.();
    return mode;
  }

  /** xr-opts.js:108-113 */
  capsVr(): boolean {
    if (this.deps.capsVr) {
      try {
        return !!this.deps.capsVr();
      } catch {
        return false;
      }
    }
    return sGet(this.storage, KEY_XR_CAPS) === "1";
  }
}

/** One enumerated settings row: LABEL  < VALUE > (f1-game js/ui/setting-row.js). */
export interface SettingRowSpec {
  id: string;
  label: string;
  options: ReadonlyArray<readonly [value: string, label: string]>;
  title: string;
  read(): string;
  write(value: string): void;
}

export interface XrRowDeps {
  /** A reload-to-apply pref changed (xr-opts.js:93-100). */
  requestReload: () => void;
}

/** xr-opts.js:142-175: the three VR rows, wired to `opts`. */
export function xrSettingRows(opts: XrOpts, deps: XrRowDeps): SettingRowSpec[] {
  return [
    {
      id: "pm-xr-mode",
      label: "VR MODE",
      options: [["off", "OFF"], ["on", "ON"]],
      title:
        "Arm VR mode. Reload after changing. On an immersive-vr headset the boot picks WebGL2 or experimental WebGPU. Does not change your 2D RENDERER pick.",
      read: () => (opts.xr() ? "on" : "off"),
      write: (v) => {
        opts.setXr(v === "on");
        deps.requestReload();
      },
    },
    {
      id: "pm-xr-backend",
      label: "VR RENDERER",
      options: [["webgl2", "WEBGL2 (RECOMMENDED)"], ["webgpu", "WEBGPU (EXPERIMENTAL)"]],
      title:
        "WebGL2 is the shippable Quest path. WebGPU is experimental (three XRManager) and falls back to WebGL2 when navigator.gpu or XRGPUBinding is missing. Reload to apply.",
      read: () => opts.xrBackend(),
      write: (v) => {
        opts.setXrBackend(v);
        deps.requestReload();
      },
    },
    {
      id: "pm-xr-input",
      label: "VR DRIVING",
      options: [["controllers", "VR CONTROLLERS"], ["existing", "EXISTING CONTROLS"]],
      title:
        "Use VR triggers and stick, or keep your wheel, keyboard or paired phone. Pause, recenter and VR menu controls remain available. Applies immediately.",
      read: () => opts.xrInput(),
      write: (v) => {
        opts.setXrInput(v);
      },
    },
  ];
}

/** Builds one row's DOM and wires it to the spec. TODO(lane-shell): pass the shell's SettingRow. */
export type SettingRowBuilder = (doc: Document, spec: SettingRowSpec) => HTMLElement;

/** A plain label + <select> row (the shell's SettingRow adds the < > steppers). */
export const plainSettingRow: SettingRowBuilder = (doc, spec) => {
  const row = doc.createElement("div");
  row.id = spec.id;
  row.className = "set-row";
  row.title = spec.title;
  row.setAttribute("role", "group");
  const label = doc.createElement("span");
  label.className = "tune-label";
  label.id = `${spec.id}-label`;
  label.textContent = spec.label;
  row.setAttribute("aria-labelledby", label.id);
  const sel = doc.createElement("select");
  sel.id = `${spec.id}-sel`;
  sel.setAttribute("aria-labelledby", label.id);
  for (const [value, text] of spec.options) {
    const o = doc.createElement("option");
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  }
  sel.value = spec.read();
  sel.addEventListener("change", () => {
    spec.write(sel.value);
    sel.value = spec.read();
  });
  row.appendChild(label);
  row.appendChild(sel);
  return row;
};

export interface XrSettingsBlock {
  root: HTMLElement;
  /** Capability probe result: rows show only on an immersive-vr capable device (xr-opts.js:115-122). */
  onCaps(caps: { vr?: boolean } | null | undefined): void;
  /** The "Reload to apply" line (xr-opts.js:102-106). */
  showHint(msg: string): void;
}

export interface XrSettingsDeps {
  /** A race is running: do not reload (f1-game `document.body.dataset.race === "1"`). */
  inRace?: () => boolean;
  /** Default `location.reload()`. */
  reload?: () => void;
  buildRow?: SettingRowBuilder;
}

/**
 * xr-opts.js:124-193: the VR block (heading, three rows, reload hint). The caller
 * places `root` (f1-game puts it after the RENDERER fold of the display panel).
 * TODO(lane-shell): mount it in SETTINGS > DISPLAY and call onCaps() after ApexXr.detect().
 */
export function buildXrSettingsBlock(doc: Document, opts: XrOpts, deps: XrSettingsDeps = {}): XrSettingsBlock {
  const wrap = doc.createElement("div");
  wrap.id = "pm-xr-block";
  wrap.hidden = !opts.capsVr();
  const head = doc.createElement("h3");
  head.className = "pm-group-h";
  head.textContent = "VR";
  wrap.appendChild(head);

  const hint = doc.createElement("p");
  hint.id = "pm-xr-reload";
  hint.className = "tune-label";
  hint.hidden = true;
  hint.textContent = "Reload to apply";
  const showHint = (msg: string): void => {
    hint.textContent = msg;
    hint.hidden = false;
  };
  const requestReload = (): void => {
    if (deps.inRace?.()) {
      showHint("Finish the race, then reload to apply VR settings");
      return;
    }
    showHint("RELOADING…");
    try {
      (deps.reload ?? (() => location.reload()))();
    } catch {
      /* no location (tests) */
    }
  };
  const build = deps.buildRow ?? plainSettingRow;
  for (const spec of xrSettingRows(opts, { requestReload })) wrap.appendChild(build(doc, spec));
  wrap.appendChild(hint);
  return {
    root: wrap,
    onCaps: (caps) => {
      wrap.hidden = !(caps && caps.vr);
    },
    showHint,
  };
}
