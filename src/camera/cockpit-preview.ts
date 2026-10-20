/* Apex 26 — isolated cockpit option preview. A dedicated GLX context draws
   the shipped meshes on demand; opening it never touches the race or camera.
   iframe lifecycle: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe

   Ported from f1-game js/camera/cockpit-preview.js:1-175 (CockpitPreview):
   `bind`, `snapshot` and `mount` (:6-104) verbatim, as `createCockpitPreview(deps)`.
   Globals injected: CockpitOpts → deps.opts; Teams / Liveries / GameStore /
   AppearanceOpts → deps.defaultCar (default: src/car/teams.ts + liveries.ts,
   team index from the store, units "kmh").
   NOT ported: `initFrame` (:106-168), the page inside the iframe that draws the
   cockpit with GLX + CarMesh + Car3D. TODO(lane-car/lane-render): a three.js
   cockpit-view page exposing `window.CockpitPreviewFrame = { set, dispose,
   onClose }`; until then `deps.frameSrc` (f1-game's "cockpit-view.html?…")
   loads nothing that answers and the status line reads "Preview unavailable". */
import { forTeam, type Livery } from "../car/liveries";
import { Teams } from "../car/teams";
import { log } from "../data/log";
import type { CockpitLayout, CockpitOpts } from "./cockpit-opts";
import type { CamStore } from "./store";
import "../styles";   // fixes the @layer order before camera.css joins `components`
import "./camera.css";

export const ANGLES: readonly string[] = Object.freeze(["front", "side", "rear", "wheel", "above"]);
/** cockpit-preview.js:71, the page the iframe loads. */
export const FRAME_SRC = "cockpit-view.html?cockpitpreview=1";

/** The car the preview paints (the bound player car reader, cockpit-preview.js:7-14). */
export interface PreviewCar {
  readonly teamId: string;
  readonly livery: unknown;
  readonly units?: string;
  readonly parts?: unknown;
  readonly [k: string]: unknown;
}

/** What `CockpitPreviewFrame.set(state)` receives. */
export interface PreviewState extends PreviewCar {
  readonly angle: string;
  readonly body: string;
  readonly interior: string;
  readonly wheel: string;
  readonly seat: string;
  readonly halo: number;
  readonly layout: CockpitLayout;
}

/** The iframe page's API (cockpit-preview.js:138-150). */
export interface PreviewFrameApi {
  set(state: PreviewState): void;
  dispose(): void;
  onClose?: (() => void) | null;
}

export interface CockpitPreviewDeps {
  readonly opts: CockpitOpts;
  /** The garage default car when nothing is bound: Teams.LIST[store team ?? 2], its first livery, the speed units. */
  readonly defaultCar?: () => PreviewCar;
  /** Store for the default car's team index (`team`, default 2). */
  readonly store?: Pick<CamStore, "get"> | null;
  /** AppearanceOpts.units(). TODO(lane-shell): appearance options. */
  readonly units?: () => string;
  readonly frameSrc?: string;
  /** Read the frame API off a loaded iframe; default `iframe.contentWindow.CockpitPreviewFrame`. */
  readonly frameApi?: (iframe: HTMLIFrameElement) => PreviewFrameApi | null | undefined;
}

export interface PreviewMount { open(): void; close(focus?: boolean): void; update(): void; unmount(): void }

export type CockpitPreview = ReturnType<typeof createCockpitPreview>;

function defaultFrameApi(iframe: HTMLIFrameElement): PreviewFrameApi | null | undefined {
  const w = iframe.contentWindow as (Window & { CockpitPreviewFrame?: PreviewFrameApi }) | null;
  return w ? w.CockpitPreviewFrame : null;
}

export function createCockpitPreview(deps: CockpitPreviewDeps) {
  const { opts } = deps;
  const frameSrc = deps.frameSrc ?? FRAME_SRC;
  const frameApi = deps.frameApi ?? defaultFrameApi;
  let readCar: (() => PreviewCar) | null = null;
  function bind(read: (() => PreviewCar) | null): void { readCar = read; }
  function defaultCar(): PreviewCar {
    if (deps.defaultCar) return deps.defaultCar();
    const idx = deps.store ? deps.store.get("team", 2) : 2;
    const team = (typeof idx === "number" ? Teams.LIST[idx] : undefined) || Teams.LIST[2];
    const livery: Livery | undefined = team ? forTeam(team)[0] : undefined;
    return { teamId: team ? team.id : "", livery, units: deps.units ? deps.units() : "kmh" };
  }
  function snapshot(angle: string): PreviewState {
    const car = readCar ? readCar() : defaultCar();
    return Object.assign({}, car, { angle, body: opts.body(), interior: opts.interior(),
      wheel: opts.wheel(), seat: opts.seat(), halo: opts.haloSize(),
      layout: opts.layout() });
  }
  function mount(host: HTMLElement): PreviewMount | null {
    if (host.querySelector("#ckpreview")) return null;
    const doc = host.ownerDocument;
    const section = doc.createElement("section");
    section.id = "ckpreview";
    const toggle = doc.createElement("button");
    toggle.type = "button"; toggle.id = "pm-ckpreview"; toggle.textContent = "PREVIEW COCKPIT";
    toggle.setAttribute("aria-expanded", "false"); toggle.setAttribute("aria-controls", "ckpreview-view");
    const view = doc.createElement("div"); view.id = "ckpreview-view"; view.hidden = true;
    const toolbar = doc.createElement("div"); toolbar.id = "ckpreview-angles";
    toolbar.setAttribute("role", "group"); toolbar.setAttribute("aria-label", "Cockpit preview angle");
    const status = doc.createElement("p"); status.className = "adv-help"; status.setAttribute("aria-live", "polite");
    let iframe: HTMLIFrameElement | null = null, angle = "front", generation = 0;
    const buttons: HTMLButtonElement[] = [];
    const C = opts.CHOICES;
    function update(): void {
      if (!iframe) return;
      const state = snapshot(angle);
      status.textContent = "Stationary preview · " + C.body.labels[state.body] + " · " +
        C.interior.labels[state.interior] + " · " + C.wheel.labels[state.wheel];
      for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset["angle"] === angle));
      try { const api = frameApi(iframe); if (api) api.set(state); }
      catch (e) { status.textContent = "Preview unavailable. Your cockpit choices are saved."; log.warn("cockpit preview", e); }
    }
    function close(focus = false): void {
      generation++;
      if (iframe) {
        try { const api = frameApi(iframe); if (api) api.dispose(); }
        catch { /* an interrupted frame load has no context to release */ }
        iframe.remove();
      }
      iframe = null; view.hidden = true;
      toggle.setAttribute("aria-expanded", "false"); toggle.textContent = "PREVIEW COCKPIT";
      if (focus) toggle.focus();
    }
    function open(): void {
      if (iframe) return;
      const own = ++generation;
      const fr = iframe = doc.createElement("iframe"); fr.title = "3D cockpit preview";
      fr.id = "ckpreview-frame";
      fr.src = frameSrc;
      fr.onload = () => {
        if (own !== generation) return;
        const api = frameApi(fr);
        if (api) api.onClose = () => close(true);
        update();
        if (!frameApi(fr)) status.textContent = "Preview unavailable. Your cockpit choices are saved.";
      };
      view.insertBefore(fr, toolbar); view.hidden = false;
      toggle.setAttribute("aria-expanded", "true"); toggle.textContent = "CLOSE PREVIEW";
      update();
    }
    for (const id of ANGLES) {
      const b = doc.createElement("button"); b.type = "button"; b.dataset["angle"] = id;
      b.textContent = id === "above" ? "ABOVE" : id.toUpperCase();
      b.onclick = () => { angle = id; update(); }; buttons.push(b); toolbar.appendChild(b);
    }
    toggle.onclick = () => iframe ? close(true) : open();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || !iframe) return;
      close(true); e.preventDefault(); e.stopImmediatePropagation();
    };
    doc.addEventListener("keydown", onKey, true);
    // Leaving SETTINGS or collapsing COCKPIT discards the entire graphics context.
    const observer = new MutationObserver(() => {
      for (let el = section.parentElement; el; el = el.parentElement) {
        if (el.hidden || (el.tagName === "DETAILS" && !(el as HTMLDetailsElement).open)) { close(); break; }
      }
    });
    for (let el: HTMLElement | null = host; el; el = el.parentElement) observer.observe(el, { attributes: true, attributeFilter: ["hidden", "open"] });
    const offWheel = opts.onWheel(update);
    section.appendChild(toggle); view.appendChild(toolbar); view.appendChild(status); section.appendChild(view); host.appendChild(section);
    return {
      open, close, update,
      unmount() {
        close();
        observer.disconnect();
        doc.removeEventListener("keydown", onKey, true);
        offWheel();
        section.remove();
      },
    };
  }
  return Object.freeze({ bind, mount, snapshot, ANGLES });
}

/** `mount(el, deps)`: build a preview for `deps` and mount it in `el`. */
export function mountCockpitPreview(el: HTMLElement, deps: CockpitPreviewDeps): PreviewMount | null {
  return createCockpitPreview(deps).mount(el);
}
