/**
 * Brief steady surface inspection. Camera and overlay are transient; no draft
 * writes.
 *
 * Port of f1-game js/garage/surface-inspection.js:1-74, verbatim: VIEWS :4-9,
 * create :14-43, controls :44-70, bind :71, the export object :72.
 *
 * f1-game keeps the one bound inspection (`live`) and the control listeners in
 * the GarageSurfaceInspection global; here they live in the instance
 * `createSurfaceInspection()` returns, and `GarageSurfaceInspection` is the
 * page's instance.
 */

/** Livery field → the framing that shows it (the garage camera's named shots). */
export const VIEWS: Readonly<Record<string, string>> = Object.freeze({
  c1: "side", c2: "side", stripe: "top", noseStripe: "front", accent: "side", nose: "front", pod: "side", lower: "side", upper: "side",
  cover: "hero", spineTint: "top", saddleTint: "hero", sideTint: "side", sunTint: "hero", bandTint2: "top", plateTint: "side",
  patternTint: "hero", patternSecond: "hero",
  wing: "wingFront", rearWing: "wingRear", fin: "rear", finArt: "rear", halo: "front", logo: "hero", logo2: "hero", logo3: "hero",
});
export const DURATION_MS = 5000;

const hasView = (k: string): boolean => Object.prototype.hasOwnProperty.call(VIEWS, k) && !!VIEWS[k];

/** The garage camera an inspection drives (js/garage/setup-camera.js). */
export interface InspectionCamera<S = unknown> {
  /** Snapshot the camera so end() can put it back exactly. */
  capture(): S;
  show(view: string): void;
  restore(snapshot: S): void;
  /** Outline a field's paint region (null clears); true when an outline is drawn. */
  highlight?: ((field: string | null) => unknown) | undefined;
  eligible?: (() => boolean) | undefined;
  schedule?: ((fn: () => void, ms: number) => unknown) | undefined;
  cancel?: ((timer: unknown) => void) | undefined;
}

export interface Inspection {
  inspect(next: string): boolean;
  end(): boolean;
  field(): string | null;
  outlined(): boolean;
  onChange(fn: () => void): () => boolean;
}

export interface InspectionControls {
  dispose(): void;
  row(row: HTMLElement, label: string, key: string): void;
}

/** One inspection over one camera (surface-inspection.js:14-43). */
export function create<S>(camera: InspectionCamera<S>): Inspection {
  let saved: S | null = null, field: string | null = null, timer: unknown = null, outlined = false, epoch = 0;
  let hasSaved = false;
  const changed = new Set<() => void>();
  const emit = (): void => { for (const fn of changed) fn(); };
  const cancel = (): void => {
    epoch++;
    if (timer !== null) { if (camera.cancel) camera.cancel(timer); else clearTimeout(timer as ReturnType<typeof setTimeout>); }
    timer = null;
  };
  const api: Inspection = {
    inspect(next) {
      if (!hasView(next) || (camera.eligible && !camera.eligible())) return false;
      cancel();
      if (camera.highlight) camera.highlight(null);
      if (!hasSaved) { saved = camera.capture(); hasSaved = !!saved; }
      field = next; camera.show(VIEWS[next] as string);
      outlined = !!camera.highlight && camera.highlight(next) === true;
      const request = epoch;
      const done = (): void => { if (request === epoch) api.end(); };
      timer = camera.schedule ? camera.schedule(done, DURATION_MS) : setTimeout(done, DURATION_MS);
      emit(); return true;
    },
    end() {
      cancel();
      if (!hasSaved) return false;
      const before = saved as S; saved = null; hasSaved = false; field = null; outlined = false;
      if (camera.highlight) camera.highlight(null);
      camera.restore(before); emit(); return true;
    },
    field: () => field,
    outlined: () => outlined,
    onChange(fn) { changed.add(fn); return () => changed.delete(fn); },
  };
  return Object.freeze(api);
}

export function createSurfaceInspection() {
  const listeners = new Set<() => void>();
  const notify = (): void => { for (const fn of listeners) fn(); };
  let live: Inspection | null = null;
  function controls(host: HTMLElement): InspectionControls {
    const buttons: { key: string; label: string; button: HTMLButtonElement }[] = [], note = document.createElement("p"); note.className = "adv-help"; note.setAttribute("role", "status"); host.appendChild(note);
    const done = document.createElement("button"); done.type = "button"; done.className = "sel-chip"; done.textContent = "RESTORE INSPECTION CAMERA"; done.disabled = true; host.appendChild(done);
    const paint = (): void => {
      const field = live && live.field();
      done.disabled = !field;
      for (const entry of buttons) { entry.button.setAttribute("aria-pressed", String(field === entry.key)); entry.button.textContent = field === entry.key ? "DONE INSPECTING" : "INSPECT " + entry.label; }
    };
    const onChange = (): void => {
      paint();
      if (!live || !live.field()) note.textContent = "Inspection complete; previous camera restored.";
    };
    listeners.add(onChange);
    done.onclick = () => { if (live) live.end(); note.textContent = "Previous camera restored."; paint(); };
    return Object.freeze({ dispose() { listeners.delete(onChange); }, row(row: HTMLElement, label: string, key: string) {
      if (!hasView(key)) return;
      const button = document.createElement("button"); button.type = "button"; button.className = "cs-liv-ed-inspect";
      button.textContent = "INSPECT " + label; button.setAttribute("aria-pressed", "false");
      button.onclick = () => {
        if (!live) return;
        if (live.field() === key) { live.end(); note.textContent = "Previous camera restored."; }
        else if (live.inspect(key)) note.textContent = label + (live.outlined() ? " affected paint region outlined for five seconds." : " area framed for five seconds; no outline is available for this surface.") + " Paint stays unchanged. DONE INSPECTING restores your camera.";
        paint();
      };
      buttons.push({ key, label, button }); row.appendChild(button);
    } });
  }
  function bind<S>(camera: InspectionCamera<S>): Inspection { if (live) live.end(); live = create(camera); live.onChange(notify); return live; }
  return Object.freeze({ VIEWS, DURATION_MS, create, controls, bind,
    inspect: (key: string): boolean => !!live && live.inspect(key),
    end: (): boolean => !!live && live.end(),
    field: (): string | null => live && live.field() });
}

export type SurfaceInspectionApi = ReturnType<typeof createSurfaceInspection>;

/** The page's inspection (one bound camera at a time). */
export const GarageSurfaceInspection: SurfaceInspectionApi = createSurfaceInspection();
