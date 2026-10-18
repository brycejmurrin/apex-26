/**
 * The PHONE AS CONTROLLER page's script: every element is handed to
 * PhonePad.pad() here; phone-pad.ts looks nothing up itself.
 * Port of f1-game controller.html:305-331 (the zoom canceller) and :438-511
 * (the DOMContentLoaded wiring, the landscape lock and the ?demo modes).
 *
 * apex-26 differences: an ES module entry (controller.html loads it with
 * `<script type="module">`, so it runs after parsing and needs no
 * DOMContentLoaded); the "scripts did not load" check is gone (a module that
 * failed to load runs nothing at all); the pre-paint THEME script is not
 * ported (no theme layer yet, see controller.html's header).
 *
 * The #pad=CODE fragment may carry `&relay=URL` beside the token (a private
 * relay); pad() applies it through rendezvous.setSessionUrl on CONNECT, for
 * this document only, never touching the saved relay preference.
 */
import { DASH, pad } from "./phone-pad";
import type { PadController, PadEventName } from "./phone-pad";

declare global {
  interface Window {
    /** The console/test handle, mirroring the game's own. */
    __apexPad?: PadController;
  }
}

/**
 * DOUBLE-TAP AND PINCH ZOOM, OFF. A wheel is tapped fast and by two thumbs, and
 * a second tap on a pedal zoomed the page. Here the whole linked page is the
 * driving surface, so iOS GestureEvents die page-wide once linked. Native
 * buttons and the code field keep every activation (cancelling their touchend
 * would eat the click); the pedals are pointer-driven divs, so cancelling
 * theirs costs nothing. controller.html:305-331.
 */
function guardZoom(): void {
  let lastT = 0, lastX = 0, lastY = 0;
  const TAP_MS = 350, TAP_PX2 = 900;
  const kill = (e: Event): void => { e.preventDefault(); };
  const linked = (): boolean => !!(document.body && document.body.classList.contains("linked"));
  const killGesture = (e: Event): void => { if (linked()) kill(e); };
  document.addEventListener("gesturestart", killGesture, { capture: true, passive: false });
  document.addEventListener("gesturechange", killGesture, { capture: true, passive: false });
  document.addEventListener("gestureend", killGesture, { capture: true, passive: false });
  document.addEventListener("dblclick", kill, { capture: true });
  document.addEventListener("touchend", (e) => {
    if (e.touches && e.touches.length) return;
    const target = e.target as Element | null;
    if (target && target.closest && target.closest("button,input")) { lastT = 0; return; }
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const now = Date.now(), dx = t.clientX - lastX, dy = t.clientY - lastY;
    if (now - lastT <= TAP_MS && dx * dx + dy * dy <= TAP_PX2) kill(e);
    lastT = now; lastX = t.clientX; lastY = t.clientY;
  }, { capture: true, passive: false });
}

/** The orientation lock is not in every TypeScript DOM lib (and Safari has none). */
interface LockableOrientation { lock?: (o: string) => Promise<void> }
function orientation(): LockableOrientation | null {
  return typeof screen !== "undefined" && screen.orientation ? screen.orientation as unknown as LockableOrientation : null;
}

function boot(): void {
  guardZoom();
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
  const linkEl = $("link");
  const setLink = (t: string): void => { if (linkEl) linkEl.textContent = t; };
  const buttons: Partial<Record<PadEventName, HTMLElement | (HTMLElement | null)[] | null>> = {
    shiftUp: $("b-shiftUp"), shiftDown: $("b-shiftDown"), overtake: [$("b-overtake"), $("b-ot-big")],
    boost: [$("b-boost"), $("b-boost-big")], aero: $("b-aero"), camera: $("b-camera"), radio: $("b-radio"),
    recover: $("b-recover"), pause: [$("b-pause"), $("b-pause-menu")],
    navSelect: $("b-navSelect"), navBack: $("b-navBack"),
  };
  const ctl = pad({
    steeringMode: $<HTMLSelectElement>("steering-mode"), steer: $("steering-strip"), health: $("input-health"), healthAge: $("input-age"),
    body: document.body, status: $("status"), codeIn: $<HTMLInputElement>("code"), connect: $<HTMLButtonElement>("connect"),
    gas: $("gas"), brake: $("brake"), lookBack: $("b-look"), center: $("b-center"), rim: $("rim"),
    buttons,
    stick: $("dpad"), nub: $("dpad-nub"),
    arrows: { navUp: $("b-navUp"), navDown: $("b-navDown"), navLeft: $("b-navLeft"), navRight: $("b-navRight") },
    scan: $("scan"), scanBox: $("scan-box"), video: $<HTMLVideoElement>("scan-video"),
    hud: { gear: $("h-gear"), speed: $("h-speed"), lap: $("h-lap"), pos: $("h-pos"), ers: $("h-ers"), flag: $("h-flag"),
           ot: $("h-ot"), aero: $("h-aero"), last: $("h-last"), leds: $("leds"), screen: $("screen"), team: document.documentElement,
           mtitle: $("mp-title"),
           body: document.body },
  }, {
    onOpen: () => {
      setLink("LINKED");
      // Landscape is where the wheel has room; the lock is best-effort.
      try { const o = orientation(); if (o && o.lock) o.lock("landscape").catch(() => {}); } catch { /* no lock here */ }
    },
    onClose: () => { setLink("LINK CLOSED"); },
  });
  window.__apexPad = ctl;
  // LANDSCAPE LOCK where the platform has one. Android needs fullscreen before
  // screen.orientation.lock, and both need a user gesture, so they ride the
  // CONNECT tap. iOS has neither: the #rotate card is what it gets.
  $("connect")?.addEventListener("click", () => {
    try {
      const o = orientation();
      if (!(o && o.lock) || !matchMedia("(pointer: coarse)").matches) return;
      const el = document.documentElement;
      const fs = el.requestFullscreen ? el.requestFullscreen({ navigationUI: "hide" }) : Promise.resolve();
      fs.then(() => o.lock ? o.lock("landscape") : undefined).catch(() => {});
    } catch { /* best effort */ }
  }, { capture: true });
  // ?demo — the wheel with a moving sample dash and no link, for a look at the
  // layout; ?demo=auto shows it with gears, throttle and aero on AUTO;
  // ?demo=menu shows the menu pad (the game out of a race); &still levels the rim.
  if (/[?&]demo\b/.test(location.search)) {
    document.body.classList.add("linked");
    setLink("DEMO · NOT LINKED");
    const auto = /[?&]demo=auto\b/.test(location.search) ? (DASH.gearsAuto | DASH.throttleAuto | DASH.aeroAuto) : 0;
    const still = /[?&]still\b/.test(location.search);
    const menu = /[?&]demo=menu\b/.test(location.search);
    // A tap arms the real sensor (iOS asks inside the tap): the demo rim then
    // follows the phone in the hand instead of the sine wave.
    let live = false;
    document.addEventListener("pointerdown", () => {
      if (live) return;
      void ctl.armSensor().then((ok) => { live = ok; if (ok) setLink("DEMO · TILT THE PHONE"); });
    });
    const t0 = performance.now();
    const demo = (): void => {
      const t = (performance.now() - t0) / 1000, rev = (Math.sin(t * 1.7) + 1) / 2;
      ctl.paintHud({ gear: 3 + Math.floor(t % 5), kmh: 140 + Math.round(rev * 170), rpm: 0.35 + rev * 0.65, lap: 4, laps: 12,
        pos: 6, cars: 20, ers: (Math.cos(t / 3) + 1) / 2, flags: auto | (rev > 0.9 ? DASH.redline : DASH.otArmed),
        caution: 0, lastLapMs: 91234, state: menu ? "menu" : "race", team: "#00b4ab" });
      if (!still && !live) ctl.setRoll(Math.sin(t / 2) * 25);
      requestAnimationFrame(demo);
    };
    requestAnimationFrame(demo);
  }
}

boot();
