/**
 * Photo mode: the free-fly camera (WASD/mouse/touch sticks, drag-to-look),
 * enter/exit plumbing (render-scale bump, HUD hide, panel tuck) and its DOM
 * buttons. Photo mode ONLY — the lighting tuner's own buttons live with the
 * lighting tuner.
 *
 * Ported verbatim from f1-game js/camera/photo-cam.js:1-293 (`Photomode`),
 * plus the fly-cam overlay's static DOM from index.html:3466-3493
 * (#photo-controls: the two sticks, the climb/dive pair, the bar and the
 * restore eye), which `mountPhotoMode` builds with the same ids and classes.
 *
 * The `G` context becomes `PhotoModeDeps` and the factory's own state:
 *   G.photoCam / photoKeys / photoMouse / photoMove / photoLook / photoAlt /
 *   photoVertT / photoMode / _photoPrevScale → owned here (`photoCam` may be
 *       injected), exposed on the mount as `photoCam` and `input`.
 *   G.camEye / camTgt / camFov        → deps.gameCamera() (the race camera to fly from).
 *       TODO(lane-shell): GameCams / vantage are not ported.
 *   G.dbgCam                          → deps.setDbgCam / deps.dbgCam (the render
 *       hook reads it). TODO(lane-render).
 *   gfx.isMobile / getRenderScale / setRenderScale, applyResMode,
 *   PerfGov.setAutoRes                → deps.gfx / deps.applyResMode / deps.setAutoRes.
 *       TODO(lane-render).
 *   G.snapGameCam                     → deps.snapGameCam. TODO(lane-shell).
 *   G.soundOn && GameAudio.uiTick/uiSelect → deps.uiTick / deps.uiSelect. TODO(lane-shell).
 *   Input.holdTargetGone              → deps.holdTargetGone, default a verbatim
 *       copy of js/input/hold-buttons.js:58-69. TODO(lane-input): src/input has
 *       no hold buttons yet.
 *   FreeCam.create(G, photo)          → mountFreeCam(freeCamHost, {...deps.freeCam, photo})
 *       when deps.freeCam is given (f1-game: when FreeCam is loaded).
 *   $("game") (the canvas), $("pc-toggle") (the lighting tuner's door),
 *   $("lighting-inner")               → looked up by id in the document, null-guarded.
 *
 * THE ARC RULE: this is a dedicated key handler (not the driving input path)
 * so photo controls never touch driving. Nothing here writes PlayerInput.
 */
import { log } from "../data/log";
import type { Vec3 } from "./flyby-seq";
import { mountFreeCam } from "./free-cam";
import type { FreeCamDeps, FreeCamMount, FreeCamView, PhotoCamState } from "./free-cam";
import "../styles";
import "./camera.css";
import "./photo.css";

/** The held keys (G.photoKeys). */
export interface PhotoKeys {
  w: boolean; s: boolean; a: boolean; d: boolean; up: boolean; dn: boolean;
  pu: boolean; pd: boolean; yl: boolean; yr: boolean; boost: boolean;
}
/** The look drag (G.photoMouse). */
export interface PhotoMouse { dx: number; dy: number; drag: boolean; pid: number | null; px: number; py: number }
/** Everything held that moves the fly-cam. */
export interface PhotoInput {
  readonly keys: PhotoKeys;
  readonly mouse: PhotoMouse;
  readonly move: { x: number; y: number };
  readonly look: { x: number; y: number };
  /** G.photoAlt: the climb/dive hold buttons, -1..1. */
  alt: number;
  /** G.photoVertT: seconds the vertical input has been held (the ramp). */
  vertT: number;
}

export function createPhotoInput(): PhotoInput {
  return {
    keys: { w: false, s: false, a: false, d: false, up: false, dn: false, pu: false, pd: false, yl: false, yr: false, boost: false },
    mouse: { dx: 0, dy: 0, drag: false, pid: null, px: 0, py: 0 },
    move: { x: 0, y: 0 }, look: { x: 0, y: 0 }, alt: 0, vertT: 0,
  };
}

/**
 * Integrate held input into the fly-cam for `dt` seconds at `spd` m/s and
 * return the forward vector (photo-cam.js:187-207, the pure half of
 * updatePhotoCam). Mutates `cam` and consumes the mouse delta / vertical ramp.
 */
export function integratePhotoCam(cam: PhotoCamState, inp: PhotoInput, spd: number, dt: number): Vec3 {
  const photoKeys = inp.keys, photoLook = inp.look, photoMouse = inp.mouse, photoMove = inp.move;
  const lookRate = 1.7;                           // rad/s for key/stick look
  // Look: arrow keys + touch look stick + mouse drag delta.
  const yawIn   = (photoKeys.yr ? 1 : 0) - (photoKeys.yl ? 1 : 0) + photoLook.x;
  const pitchIn = (photoKeys.pu ? 1 : 0) - (photoKeys.pd ? 1 : 0) - photoLook.y;
  cam.yaw   += yawIn * lookRate * dt + photoMouse.dx * 0.0032;
  cam.pitch += pitchIn * lookRate * dt - photoMouse.dy * 0.0032;
  photoMouse.dx = 0; photoMouse.dy = 0;
  cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch));
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const fwd: Vec3 = [Math.sin(cam.yaw) * cp, sp, -Math.cos(cam.yaw) * cp];
  const rgt = [Math.cos(cam.yaw), 0, Math.sin(cam.yaw)] as const;
  const mf = (photoKeys.w ? 1 : 0) - (photoKeys.s ? 1 : 0) - photoMove.y;   // stick UP (dy<0) = forward
  const ms = (photoKeys.d ? 1 : 0) - (photoKeys.a ? 1 : 0) + photoMove.x;
  const mvIn = (photoKeys.up ? 1 : 0) - (photoKeys.dn ? 1 : 0) + inp.alt;
  inp.vertT = mvIn ? inp.vertT + dt : 0;
  const vRamp = Math.min(1, 0.12 + 0.88 * Math.pow(Math.min(inp.vertT / 2.2, 1), 1.6));
  const mv = mvIn * vRamp;
  const k = spd * dt;
  cam.pos[0] += (fwd[0] * mf + rgt[0] * ms) * k;
  cam.pos[1] += (fwd[1] * mf + mv) * k;
  cam.pos[2] += (fwd[2] * mf + rgt[2] * ms) * k;
  return fwd;
}

/** js/input/hold-buttons.js:58-69 holdTargetGone, verbatim. */
export function holdTargetGone(el: Element | null | undefined): boolean {
  if (!el || (el as unknown) === el.ownerDocument) return true;
  if (!el.isConnected) return true;
  if ((el as HTMLElement).hidden) return true;
  const parent = el.parentElement;
  if (parent && parent.hidden) return true;
  try {
    const view = el.ownerDocument.defaultView;
    const s = view ? view.getComputedStyle(el) : null;
    if (s && (s.display === "none" || s.visibility === "hidden")) return true;
  } catch { /* getComputedStyle can throw on a detached node */ }
  return false;
}

export interface PhotoGfx {
  readonly isMobile?: boolean;
  getRenderScale?(): number;
  setRenderScale?(s: number): void;
}

export interface PhotoModeDeps {
  /** The race camera photo mode flies from (G.camEye / camTgt / camFov). TODO(lane-shell). */
  gameCamera(): { readonly eye: Readonly<Vec3>; readonly target: Readonly<Vec3>; readonly fov: number };
  /** Publish (or clear) the camera override (G.dbgCam). TODO(lane-render). */
  setDbgCam(cam: FreeCamView | null): void;
  dbgCam(): FreeCamView | null;
  readonly photoCam?: PhotoCamState | null;
  readonly gfx?: PhotoGfx | null;
  readonly applyResMode?: (() => void) | null;
  readonly setAutoRes?: ((on: boolean) => void) | null;
  readonly snapGameCam?: (() => void) | null;
  readonly uiTick?: (() => void) | null;
  readonly uiSelect?: (() => void) | null;
  readonly holdTargetGone?: ((el: Element) => boolean) | null;
  /** Mount the FREE CAMERA panel too (f1-game: when FreeCam is loaded). */
  readonly freeCam?: Omit<FreeCamDeps, "photoCam" | "photo" | "dbgCam" | "photoMode"> | null;
  /** Where the FREE CAMERA panel goes (default: the same element). */
  readonly freeCamHost?: HTMLElement | null;
  /** The window the key / blur / drag listeners go on (default the element's). */
  readonly win?: Window | null;
}

export interface PhotoModeMount {
  initPhotoCam(): void;
  updatePhotoCam(dt: number): void;
  enterPhotoMode(): void;
  exitPhotoMode(): void;
  isActive(): boolean;
  releasePhotoInput(): void;
  readonly freeCam: FreeCamMount | null;
  readonly photoCam: PhotoCamState;
  readonly input: PhotoInput;
  /** The #photo-controls layer this mount built. */
  readonly root: HTMLElement;
  unmount(): void;
}

/** index.html:3466-3493: the fly-cam overlay, built rather than static. */
function buildShell(doc: Document): HTMLElement {
  const h = (tag: string, props: Record<string, string> = {}, kids: (Node | string)[] = []): HTMLElement => {
    const n = doc.createElement(tag);
    for (const k in props) {
      if (k === "class") n.className = props[k]!; else n.setAttribute(k, props[k]!);
    }
    for (const c of kids) n.append(c);
    return n;
  };
  const root = h("div", { id: "photo-controls", "data-esc-close": "pc-exit" });
  root.hidden = true;
  const fov = h("input", { id: "pc-fov", type: "range", min: "20", max: "110", step: "1", value: "60" }) as HTMLInputElement;
  root.append(
    h("div", { class: "pc-stickwrap pc-move-wrap" }, [h("span", { class: "pc-lbl" }, ["MOVE"]), h("div", { id: "pc-move", class: "pc-stick" }, [h("div", { class: "pc-nub" })])]),
    h("div", { class: "pc-altcol" }, [
      h("button", { id: "pc-up", class: "pc-btn", "aria-label": "Up" }, ["▲"]),
      h("button", { id: "pc-down", class: "pc-btn", "aria-label": "Down" }, ["▼"]),
    ]),
    h("div", { class: "pc-stickwrap pc-look-wrap" }, [h("span", { class: "pc-lbl" }, ["LOOK"]), h("div", { id: "pc-look", class: "pc-stick" }, [h("div", { class: "pc-nub" })])]),
    h("div", { id: "pc-bar" }, [
      h("span", { class: "pc-hint" }, ["WASD move · R/F up·down · arrows or drag to look · Shift boost"]),
      h("label", { class: "pc-fovlab" }, ["FOV ", fov]),
      h("button", { id: "pc-hud" }, ["HIDE HUD"]),
      h("button", { id: "pc-panel" }, ["HIDE PANEL"]),
      h("button", { id: "pc-exit" }, ["EXIT"]),
    ]),
    // shown only while body.pc-uihidden: the one control that brings the
    // photo-mode UI back (mirrors the race HUD's #hud-restore eye).
    h("button", { id: "pc-restore", "aria-label": "Show controls" }, ["👁"]),
  );
  return root;
}

/** Build photo mode's overlay in `el` and wire it (photo-cam.js:138-423 `create`). */
export function mountPhotoMode(el: HTMLElement, deps: PhotoModeDeps): PhotoModeMount {
  log.info("Photomode.create");
  const doc = el.ownerDocument;
  const win: Window | null = deps.win !== undefined ? deps.win : doc.defaultView;
  const gfx = deps.gfx || {};
  const photoCam: PhotoCamState = deps.photoCam || { pos: [0, 0, 0], yaw: 0, pitch: 0, fov: 60 };
  const input = createPhotoInput();
  const photoKeys = input.keys, photoMouse = input.mouse, photoMove = input.move, photoLook = input.look;
  const isGone = deps.holdTargetGone || holdTargetGone;
  let photoMode = false;
  let prevScale = 1;
  const root = buildShell(doc);
  el.appendChild(root);
  const $ = (id: string): HTMLElement | null => root.querySelector<HTMLElement>("#" + id) ?? doc.getElementById(id);
  // Every listener this mount adds, for unmount.
  const offs: (() => void)[] = [];
  const listen = (t: EventTarget, type: string, fn: EventListener, opts?: boolean | AddEventListenerOptions): void => {
    t.addEventListener(type, fn, opts);
    offs.push(() => t.removeEventListener(type, fn, opts));
  };

  // THE FREE CAMERA panel (./free-cam.ts) is this fly-cam with its own dock,
  // created here so the shell gains nothing.
  const freeCam: FreeCamMount | null = deps.freeCam
    ? mountFreeCam(deps.freeCamHost || el, {
      ...deps.freeCam,
      photoCam, dbgCam: () => deps.dbgCam(), photoMode: () => photoMode,
      photo: { enter: enterPhotoMode, exit: exitPhotoMode, publish: () => updatePhotoCam(0), releaseKeys: releasePhotoInput },
      ...(win ? { win } : {}),
    })
    : null;

  function initPhotoCam(): void {
    const g = deps.gameCamera();
    photoCam.pos[0] = g.eye[0]; photoCam.pos[1] = g.eye[1]; photoCam.pos[2] = g.eye[2];
    let dx = g.target[0] - g.eye[0], dy = g.target[1] - g.eye[1], dz = g.target[2] - g.eye[2];
    const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
    photoCam.pitch = Math.asin(Math.max(-1, Math.min(1, dy)));
    photoCam.yaw = Math.atan2(dx, -dz);
    photoCam.fov = g.fov;
    const fv = $("pc-fov") as HTMLInputElement | null; if (fv) fv.value = String(Math.round(g.fov));
    releasePhotoInput();
  }
  // EVERY HELD CONTROL, RELEASED — and nothing about where the camera IS.
  // The window "blur" resets for exactly this reason ("any pointer that lifts
  // or is captured elsewhere"), and the two virtual sticks and two hold buttons
  // below already handle pointerup/pointercancel/lostpointercapture citing the
  // same class of bug. What none of them covered is focus simply going away —
  // an alt-tab, an OS notification, a permission prompt — which fires no
  // pointer or key event at all, so a held W or a finger down on the move stick
  // left that axis pinned and the free camera flew off in that direction until
  // the player pressed the same control again. Split out of initPhotoCam so
  // blur can release the input WITHOUT also re-deriving the pose from the game
  // camera, which would teleport the shot.
  const altitudeHeld = { up: false, down: false };
  // Physical aliases own their holds independently: releasing Space cannot
  // cancel a still-held R, nor can one Shift release cancel the other.
  const aliasHeld: Record<string, boolean> = { KeyR: false, Space: false, ShiftLeft: false, ShiftRight: false };
  function releasePhotoInput(): void {
    altitudeHeld.up = altitudeHeld.down = false;
    for (const code in aliasHeld) aliasHeld[code] = false;
    photoMove.x = photoMove.y = photoLook.x = photoLook.y = 0;
    photoMouse.dx = photoMouse.dy = 0; photoMouse.drag = false; photoMouse.pid = null;
    input.alt = 0; input.vertT = 0;
    for (const k in photoKeys) photoKeys[k as keyof PhotoKeys] = false;
  }
  // Integrate held input into the fly-cam each paused frame and publish dbgCam.
  function updatePhotoCam(dt: number): void {
    const spd = freeCam && freeCam.isOpen() ? freeCam.speed(photoKeys.boost)   // the panel's SPEED dial
      : (photoKeys.boost ? 95 : 34);                // m/s (Shift = boost)
    const fwd = integratePhotoCam(photoCam, input, spd, dt);
    const e = photoCam.pos;
    // far: the far plane is the game's ONLY distance cull (chunk AABBs test against
    // the frustum incl. far; fog never culls). 2500 m from altitude framed EVERY
    // chunk of a street circuit — ~1.1 M tris / ~970 draw calls per frame on Vegas,
    // which overflows a mobile TBDR tiler and gets the web app jetsam-killed. Keep
    // 1100 m on mobile (fog hides the edge); desktop can afford the full vista.
    // fog: 1.0 — the 0.15× default at the dbgCam branch was meant for the dev
    // view() hook; the tuner preview should show the REAL race fog anyway.
    const cam: FreeCamView = { eye: [e[0], e[1], e[2]], target: [e[0] + fwd[0] * 100, e[1] + fwd[1] * 100, e[2] + fwd[2] * 100],
      fov: photoCam.fov, far: gfx.isMobile ? 1100 : 2500, fog: 1.0 };   // not 8000 — a huge far plane wrecks depth precision → z-fighting/flicker
    deps.setDbgCam(cam);
    if (freeCam) freeCam.decorate(cam, dt);   // roll, lens, status line — inert unless its panel is open
  }
  function enterPhotoMode(): void {
    if (photoMode) return;
    log.info("Photomode.enter");
    const ae = doc.activeElement as HTMLElement | null;
    if (ae && ae.blur) ae.blur();
    photoMode = true;
    if (deps.setAutoRes) deps.setAutoRes(false);
    prevScale = gfx.getRenderScale ? gfx.getRenderScale() : 1;
    initPhotoCam();
    doc.body.classList.add("photo-mode");
    root.hidden = false;
    const t = doc.getElementById("pc-toggle"); if (t) { t.classList.add("on"); t.textContent = "● FREE CAMERA"; }
    if (win) {
      win.addEventListener("keydown", photoKeyHandler, true);
      win.addEventListener("keyup", photoKeyHandler, true);
      win.addEventListener("blur", releasePhotoInput);
    }
  }
  function exitPhotoMode(): void {
    if (!photoMode) return;
    log.info("Photomode.exit");
    photoMode = false;
    if (freeCam) freeCam.onPhotoExit();       // resume / quit / the tuner closing take the free-cam panel with them
    deps.setDbgCam(null);                     // hand the game camera back
    if (deps.snapGameCam) deps.snapGameCam(); // …AT the car: the damped rig otherwise swoops back from wherever the free camera was parked
    doc.body.classList.remove("photo-mode", "pc-nopanel", "pc-uihidden");
    root.hidden = true;
    const li = doc.getElementById("lighting-inner"); if (li) li.hidden = false;     // un-hide the tuner if it was tucked away
    const pb = $("pc-panel"); if (pb) pb.textContent = "HIDE PANEL";
    const t = doc.getElementById("pc-toggle"); if (t) { t.classList.remove("on"); t.textContent = "📷 FREE CAMERA"; }
    if (win) {
      win.removeEventListener("keydown", photoKeyHandler, true);
      win.removeEventListener("keyup", photoKeyHandler, true);
      win.removeEventListener("blur", releasePhotoInput);
    }
    if (gfx.setRenderScale) gfx.setRenderScale(prevScale || 1);
    if (deps.applyResMode) deps.applyResMode();
  }
  function togglePhotoPanel(): void {
    const p = freeCam && freeCam.isOpen() ? freeCam.panel() : doc.getElementById("lighting-inner"); if (!p) return;
    const hide = !p.hidden;
    p.hidden = hide;
    doc.body.classList.toggle("pc-nopanel", hide);
    const pb = $("pc-panel"); if (pb) pb.textContent = hide ? "SHOW PANEL" : "HIDE PANEL";
    if (deps.uiTick) deps.uiTick();
  }
  function setPhotoUiHidden(hide: boolean): void {
    doc.body.classList.toggle("pc-uihidden", hide);
    if (deps.uiTick) deps.uiTick();
  }
  // Dedicated key handler (not the driving input) so photo controls never touch driving.
  function photoKeyHandler(ev: Event): void {
    const e = ev as KeyboardEvent;
    const focused = doc.activeElement, tag = (focused && focused.tagName) || "";
    const down = e.type === "keydown";
    // Typing in a slider — but a key-UP always releases: W held while a click
    // moved focus into a slider (or COPY VIEW's textarea) stayed down forever.
    // The Studio's buttons own Space/Enter and menu arrows. Key-up must still
    // release camera input held before focus moved into the dock.
    const studioControl = focused && focused.closest && focused.closest("#ps-panel");
    const studioKey = e.code === "Space" || e.code === "Enter" || e.code === "NumpadEnter" || /^Arrow/.test(e.code);
    if (down && e.code !== "Escape" && ((studioControl && studioKey) || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT")) return;
    const fc = freeCam ? freeCam.key(e.code, down, doc.activeElement) : 0;
    if (fc < 0 && down) return;                // an arrow key over the free-cam panel belongs to its focused control
    if (fc > 0) { e.preventDefault(); if (down) e.stopPropagation(); return; }
    let hit = true;
    switch (e.code) {
      case "KeyW": photoKeys.w = down; break;
      case "KeyS": photoKeys.s = down; break;
      case "KeyA": photoKeys.a = down; break;
      case "KeyD": photoKeys.d = down; break;
      case "KeyR": case "Space":
        aliasHeld[e.code] = down; photoKeys.up = !!(aliasHeld["KeyR"] || aliasHeld["Space"]); break;
      case "KeyF": photoKeys.dn = down; break;
      case "ArrowUp": photoKeys.pu = down; break;
      case "ArrowDown": photoKeys.pd = down; break;
      case "ArrowLeft": photoKeys.yl = down; break;
      case "ArrowRight": photoKeys.yr = down; break;
      case "ShiftLeft": case "ShiftRight":
        aliasHeld[e.code] = down; photoKeys.boost = !!(aliasHeld["ShiftLeft"] || aliasHeld["ShiftRight"]); break;
      default: hit = false;
    }
    // A key-UP still reaches the driving input: W held from driving, released in here, stayed held after RESUME.
    if (hit) { e.preventDefault(); if (down) e.stopPropagation(); }
  }
  // Virtual thumbstick: pointer offset from centre → normalised (−1..1) vector.
  function wirePhotoStick(id: string, vec: { x: number; y: number }): void {
    const stick = $(id); if (!stick) return;
    const nub = stick.querySelector<HTMLElement>(".pc-nub");
    let pid: number | null = null;
    // The box and zoom are measured ONCE per drag (pointerdown) — the stick
    // only moves on resize/zoom-cap changes, never mid-hold, and gBCR +
    // currentCSSZoom per pointermove is a style-system query at up to 240 Hz.
    let _r: DOMRect | null = null, _zoom = 1;
    const set = (cx: number, cy: number): void => {
      const r = _r || stick.getBoundingClientRect();
      const rad = r.width / 2;
      let dx = (cx - (r.left + rad)) / rad, dy = (cy - (r.top + rad)) / rad;
      const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
      vec.x = dx; vec.y = dy;
      /* Two coordinate spaces meet here. The VECTOR is a ratio of visual px
         over visual px, so zoom cancels and the drive is correct. The nub's
         translate() resolves in the element's LOCAL space, while `rad` is
         VISUAL px (the stick sits inside .pc-stickwrap's zoom) — so the nub
         travelled 40% of its throw at UI SIZE 40% and flew outside the ring
         at 200%. Divide the throw back into local px. */
      const localRad = rad / _zoom;
      if (nub) nub.style.transform = "translate(" + (dx * localRad * 0.6) + "px," + (dy * localRad * 0.6) + "px)";
    };
    const end = (): void => { vec.x = 0; vec.y = 0; pid = null; if (nub) nub.style.transform = "translate(0,0)"; };
    const endIf = (ev: Event): void => { const e = ev as PointerEvent; if (pid === null || e.pointerId === pid) end(); };
    listen(stick, "pointerdown", (ev) => {
      const e = ev as PointerEvent;
      pid = e.pointerId;
      /* THE THROW IS SPEC'D, NOT A BROWSER QUIRK. Pointer Events requires
         setPointerCapture to throw NotFoundError when the pointerId "does not
         match any of the active pointers", and the pointer can already be gone by
         the time this line runs — a touch cancelled between pointerdown and the
         handler (a rapid tap, a gesture the system claimed) is the documented
         trigger, and it is not platform-specific. An unguarded throw aborts the
         handler before set() AND before preventDefault(), so the stick reads zero
         and the page keeps the gesture. */
      try { stick.setPointerCapture(pid); } catch { /* the spec'd throw above — the stick still works uncaptured */ }
      _r = stick.getBoundingClientRect();
      _zoom = (stick as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1;
      set(e.clientX, e.clientY);
      e.preventDefault();
    });
    listen(stick, "pointermove", (ev) => { const e = ev as PointerEvent; if (e.pointerId === pid) { set(e.clientX, e.clientY); e.preventDefault(); } });
    listen(stick, "pointerup", endIf);
    listen(stick, "pointercancel", endIf);
    /* THE STICK CAN BE TAKEN AWAY MID-HOLD, AND THEN NO pointerup EVER ARRIVES.
       The HUD sheet display:none's the whole fly-cam overlay whenever a
       .screen.dim opens, and HIDE HUD does the same to everything but the
       restore eye — both can fire with a thumb down. A touch pointer holds
       IMPLICIT capture, so removing the element loses the capture instead of
       delivering an up, the vector stays at its last value, and updatePhotoCam
       flies the camera away for good. */
    listen(stick, "lostpointercapture", endIf);
  }
  function wirePhotoHold(id: string, onDown: () => void, offUp: () => void): void {
    const b = $(id); if (!b) return;
    let pid: number | null = null;
    const release = (ev?: Event): void => { const e = ev as PointerEvent | undefined; if (pid === null || !e || e.pointerId === pid) { pid = null; offUp(); } };
    listen(b, "pointerdown", (ev) => {
      const e = ev as PointerEvent;
      pid = e.pointerId;
      try { b.setPointerCapture(pid); } catch { /* see wirePhotoStick: a pointer already gone can throw here too */ }
      onDown();
      e.preventDefault();
    });
    listen(b, "pointerup", release);
    listen(b, "pointercancel", release);
    /* No pointerleave: with the pointer captured it is a BOUNDARY event, fired
       the moment setPointerCapture retargets, so the button let go on the same
       press that took it. And a lostpointercapture is a teardown only when the
       button was taken away — WebKit keeps one capture slot, so a second finger
       on the other hold button steals it with this thumb still down
       (hold-buttons.js holdTargetGone / lostCaptureShouldRelease). */
    listen(b, "lostpointercapture", (e) => { if (isGone(b)) release(e); });   // see wirePhotoStick
  }
  wirePhotoStick("pc-move", photoMove);
  wirePhotoStick("pc-look", photoLook);
  const altitude = (id: "up" | "down", held: boolean): void => { altitudeHeld[id] = held; input.alt = Number(altitudeHeld.up) - Number(altitudeHeld.down); };
  wirePhotoHold("pc-up", () => altitude("up", true), () => altitude("up", false));
  wirePhotoHold("pc-down", () => altitude("down", true), () => altitude("down", false));
  /* Drag anywhere on the scene (outside the sticks) to look — mouse or a spare
     finger. THE DRAG BELONGS TO ONE POINTER: `pointermove` on `window` accepted
     every pointer, so with a drag live the finger working a thumbstick ALSO fed
     photoMouse and the view whipped between two screen positions on every
     event. And with no `pointercancel` handler the flag latched `true` forever
     the first time iOS claimed a touch for a system gesture. */
  {
    const canvas = doc.getElementById("game");
    if (canvas && win) {
      const stop = (ev: Event): void => {
        const e = ev as PointerEvent;
        if (photoMouse.pid !== null && e && e.pointerId !== photoMouse.pid) return;
        photoMouse.drag = false; photoMouse.pid = null;
      };
      listen(canvas, "pointerdown", (ev) => {
        const e = ev as PointerEvent;
        if (!photoMode || photoMouse.drag) return;
        photoMouse.drag = true; photoMouse.pid = e.pointerId;
        photoMouse.px = e.clientX; photoMouse.py = e.clientY;
      });
      listen(win, "pointermove", (ev) => {
        const e = ev as PointerEvent;
        if (!photoMode || !photoMouse.drag || e.pointerId !== photoMouse.pid) return;
        photoMouse.dx += e.clientX - photoMouse.px; photoMouse.dy += e.clientY - photoMouse.py;
        photoMouse.px = e.clientX; photoMouse.py = e.clientY;
      });
      listen(win, "pointerup", stop);
      listen(win, "pointercancel", stop);
    }
  }
  const toggle = doc.getElementById("pc-toggle");
  const onToggle = (): void => { if (deps.uiSelect) deps.uiSelect(); if (photoMode) exitPhotoMode(); else enterPhotoMode(); };
  if (toggle) toggle.onclick = onToggle;
  $("pc-exit")!.onclick = () => {
    if (deps.uiTick) deps.uiTick();
    if (freeCam && freeCam.isOpen()) freeCam.close(true); else exitPhotoMode();   // EXIT from the free-cam panel goes back to the menu
  };
  $("pc-panel")!.onclick = togglePhotoPanel;
  $("pc-hud")!.onclick = () => setPhotoUiHidden(true);
  $("pc-restore")!.onclick = () => setPhotoUiHidden(false);
  ($("pc-fov") as HTMLInputElement).oninput = (e) => { photoCam.fov = Number((e.target as HTMLInputElement).value); };

  return {
    initPhotoCam, updatePhotoCam, enterPhotoMode, exitPhotoMode, releasePhotoInput, freeCam,
    isActive: () => photoMode,
    photoCam, input, root,
    unmount() {
      exitPhotoMode();
      if (freeCam) freeCam.unmount();
      for (const off of offs.splice(0)) off();
      if (toggle && toggle.onclick === onToggle) toggle.onclick = null;
      root.remove();
    },
  };
}

export const Photomode = Object.freeze({ mount: mountPhotoMode, integratePhotoCam, createPhotoInput, holdTargetGone });
