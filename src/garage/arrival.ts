/**
 * Pit-work arrival: a render-clock sequence, independent of race simulation.
 *
 * Port of f1-game js/garage/arrival.js:1-218, verbatim: settings :7-13,
 * angleMap :22-36, bindSettings :37-94, pathAt :101-106, EYE_L/EYE_R :107,
 * shot :110-117, pose :122-138, poseOut :149-179, create :180-216, the export
 * object :217. Pure apart from bindSettings/create, which drive the DOM through
 * the `$` id lookup they are handed, as in f1-game.
 */
import type { GarageStoreLike } from "./store";

export type ArrivalAngle = "cut" | "left" | "right";

/** The GARAGE ARRIVAL TUNER's saved settings (store key `garageArrival`). */
export interface ArrivalSettings {
  enabled: boolean;
  speed: number;
  angle: ArrivalAngle;
  fov: number;
}

export type Vec3 = [number, number, number];

/** One frame of the sequence: the car on the bay floor, the shutter, the camera. */
export interface ArrivalPose {
  active: boolean;
  fov: number;
  /** Shutter open fraction 0..1. */
  door: number;
  x: number;
  z: number;
  yaw: number;
  label: string;
  eye: Vec3;
  aim: Vec3;
}

/** The id lookup the DOM-facing halves take (f1-game's `$`). */
export type ById = (id: string) => HTMLElement | null;

const DOOR_S = 1.8;
const ease = (x: number): number => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
export const DEFAULT: Readonly<ArrivalSettings> = Object.freeze({ enabled: true, speed: 1, angle: "cut", fov: 54 });
const ANGLES: readonly string[] = ["cut", "left", "right"];

export function settings(value: unknown): ArrivalSettings {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const number = (key: "speed" | "fov", lo: number, hi: number): number => {
    const n = v[key];
    return typeof n === "number" && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : DEFAULT[key];
  };
  return { enabled: v["enabled"] !== false, speed: number("speed", 0.5, 2),
    angle: typeof v["angle"] === "string" && ANGLES.includes(v["angle"]) ? (v["angle"] as ArrivalAngle) : "cut", fov: number("fov", 40, 75) };
}

const EYE_L: Vec3 = [-3.8, 2.1, -4.8], EYE_R: Vec3 = [4.1, 2.25, -4.9];

/* THE ANGLE MAP: a plan of the bay under GARAGE ANGLE — walls, the door, the
 * pit lane, the parked car and the two interior eyes (EYE_L / EYE_R) with a
 * cone toward the door — the chosen one(s) lit, so LEFT / RIGHT / CUT are a
 * picture rather than a word. Pure: the inner SVG for an angle. Bay x maps to
 * 10..110, z (back -6.4 .. door 6.4) to 8..92, the lane below the door. */
export function angleMap(angle: string): string {
  const X = (x: number): string => (60 + x * 100 / 10.8).toFixed(1), Z = (z: number): string => (50 + z * 84 / 12.8).toFixed(1);
  const on = (left: boolean): boolean => angle === "cut" || angle === (left ? "left" : "right");
  const eye = (e: Vec3, left: boolean, n: number | string): string => {
    const lit = on(left), x = X(e[0]), z = Z(e[2]);
    return `<path d="M${x} ${z}L${X(-2.7)} ${Z(6.4)}L${X(2.7)} ${Z(6.4)}Z" fill="currentColor" opacity="${lit ? 0.22 : 0.06}"/>`
      + `<circle cx="${x}" cy="${z}" r="5" fill="${lit ? "#e10600" : "none"}" stroke="currentColor" stroke-width="1.5"/>`
      + (angle === "cut" ? `<text x="${x}" y="${(+z + 3.5).toFixed(1)}" font-size="8" text-anchor="middle" fill="#fff">${n}</text>` : "");
  };
  return `<rect x="10" y="8" width="100" height="84" fill="none" stroke="currentColor" stroke-width="2"/>`
    + `<line x1="${X(-2.7)}" y1="${Z(6.4)}" x2="${X(2.7)}" y2="${Z(6.4)}" stroke="#2a2a2e" stroke-width="4"/>`
    + `<rect x="4" y="96" width="112" height="16" fill="currentColor" opacity="0.12"/>`
    + `<rect x="${X(-0.9)}" y="${Z(-2.8)}" width="${(1.8 * 100 / 10.8).toFixed(1)}" height="${(5.6 * 84 / 12.8).toFixed(1)}" rx="3" fill="currentColor" opacity="0.5"/>`
    + eye(EYE_L, true, angle === "cut" ? 1 : "") + eye(EYE_R, false, 2);
}

export interface BindSettingsOptions {
  /** preview(dir, btn): PREVIEW IN / OUT ("in" | "out") start one playback
   *  and return whether it started; preview(null) stops one and returns whether
   *  one was playing (js/garage/setup-camera.js startArrivalPreview). */
  preview?: ((dir: "in" | "out" | null, btn?: HTMLElement) => boolean) | undefined;
}

/** Wires the tuner panel (index.html #garrival, ga-* controls); returns the settings reader. */
export function bindSettings($: ById, store: GarageStoreLike, opts: BindSettingsOptions = {}): () => ArrivalSettings {
  const preview = typeof opts.preview === "function" ? opts.preview : null;
  const read = (): ArrivalSettings => settings(store.get("garageArrival", null));
  const fields = ["enabled", "speed", "angle", "fov"] as const;
  // The ga-* controls are index.html's and always present (f1-game reads them unguarded).
  const input = (id: string): HTMLInputElement => $(id) as HTMLInputElement;
  function refresh(): void {
    const value = read();
    for (const key of fields) {
      const el = input("ga-" + key);
      if (key === "enabled") el.checked = value[key];
      else el.value = String(value[key]);
    }
    // The angle map lives next to the selector it explains (made once, here:
    // the panel's markup is index.html's, this picture is the setting's).
    const sel = $("ga-angle");
    let map = $("ga-angle-map");
    if (!map && sel && sel.insertAdjacentHTML) {
      sel.insertAdjacentHTML("afterend", '<svg id="ga-angle-map" viewBox="0 0 120 116" role="img"></svg>');
      map = $("ga-angle-map");
    }
    if (map) {
      map.innerHTML = angleMap(value.angle);
      if (map.setAttribute) map.setAttribute("aria-label", value.angle === "cut" ? "Two camera cut: left of the bay, then right"
        : (value.angle === "left" ? "Left" : "Right") + " of the bay, looking out of the door");
    }
  }
  for (const key of fields) input("ga-" + key).onchange = () => {
    const el = input("ga-" + key), value = read();
    if (key === "enabled") value[key] = el.checked;
    else if (key === "angle") (value as { angle: string }).angle = el.value;   // settings() below re-validates it
    else value[key] = Number(el.value);
    store.set("garageArrival", settings(value)); refresh();
  };
  $("ga-reset")!.onclick = () => { store.set("garageArrival", null); refresh(); };
  // An ADVANCED VISUALS tool (#garrival), docked right like the three tuners:
  // it takes the settings page's place while open and gives it back on DONE.
  const page = (on: boolean): void => {
    const ps = $("pmsettings"), dp = $("pm-panel-display");
    if (ps) ps.hidden = !on;
    if (dp) dp.hidden = !on;
  };
  const panel = $("garrival"), openBtn = $("pm-garrival"), done = $("ga-close");
  if (panel && openBtn) openBtn.onclick = () => {
    refresh(); page(false); panel.hidden = false;
    if (typeof document !== "undefined" && document.body) document.body.classList.add("lt-open");
    if (done && done.focus) done.focus();
  };
  for (const [b, dir] of [[$("ga-preview-in"), "in"], [$("ga-preview-out"), "out"]] as const) {
    if (b) b.onclick = () => { if (preview) preview(dir, b); };
  }
  if (panel && done) done.onclick = () => {
    if (preview && preview(null)) return;   // DONE (or Escape) mid-playback stops it, back to the panel
    panel.hidden = true; page(true);
    if (typeof document !== "undefined" && document.body) document.body.classList.remove("lt-open");
    // After the settings dialog's own re-show handling, which focuses its
    // CLOSE door; a tool's DONE hands focus back to the tool's button.
    if (openBtn && openBtn.focus) { if (typeof setTimeout === "function") setTimeout(() => openBtn.focus(), 0); else openBtn.focus(); }
  };
  refresh();
  return read;
}

/* ONE PATH, BOTH WAYS. The drive-out leaves the box along it (straight out of
 * the door to OUT_STRAIGHT, a quarter arc of OUT_R metres into the lane, then
 * down the lane); the arrival runs the lane the other way, stops just past the
 * box, and backs in along the same arc, the way a crew pushes a car back into
 * its garage. side +1 / -1 is the lane direction away from the camera's eye
 * (x and yaw ride the pose; setup-camera.js builds the car matrix from them). */
const OUT_STRAIGHT = 8, OUT_R = 5, OUT_TURN = Math.PI / 2, OUT_PATH = OUT_STRAIGHT + OUT_R * OUT_TURN;
function pathAt(s: number, side: number): { x: number; z: number; yaw: number } {
  const th = Math.min(OUT_TURN, Math.max(0, s - OUT_STRAIGHT) / OUT_R), past = Math.max(0, s - OUT_PATH);
  const z = (s < OUT_STRAIGHT ? Math.max(0, s) : OUT_STRAIGHT + OUT_R * Math.sin(th)) + past * Math.cos(th);
  return { x: side * (OUT_R * (1 - Math.cos(th)) + past * Math.sin(th)), z, yaw: side * th };
}
type Shot = Omit<ArrivalPose, "eye" | "aim">;
// HANDHELD: a slow, small sway on both shots, as if someone were filming from
// the back of the bay. Off when `calm` (reduce motion); timing never changes.
function shot(base: Shot, eye: Vec3, aim: Vec3, t: number, calm: boolean): ArrivalPose {
  const out: ArrivalPose = Object.assign(base, { eye: eye.slice() as Vec3, aim });
  if (calm) return out;
  out.eye[0] += 0.022 * Math.sin(1.3 * t) + 0.010 * Math.sin(3.1 * t + 1);
  out.eye[1] += 0.014 * Math.sin(1.7 * t + 2);
  aim[0] += 0.028 * Math.sin(0.9 * t + 0.5); aim[1] += 0.018 * Math.sin(1.2 * t + 1.3);
  return out;
}
// THE ARRIVAL (WORK ON CAR): the shutter opens (DOOR_S) on an empty lane, the
// car comes up the lane past the box (IN_LANE s, braking to a stop IN_LANE_M
// metres along, just past the door and in view), sits a beat, then backs in
// along the drive-out's own arc (IN_BACK s) and parks, nose to the pit lane.
const IN_LANE = 2.6, IN_LANE_M = 22, IN_PAUSE = 0.4, IN_BACK = 3.6;
export const DURATION = DOOR_S + IN_LANE + IN_PAUSE + IN_BACK + 0.3;
export function pose(seconds: number, config: Readonly<ArrivalSettings> = DEFAULT, calm = false): ArrivalPose {
  const t = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const left = config.angle === "left" || (config.angle !== "right" && t < DOOR_S);
  const side = config.angle === "left" ? 1 : -1;   // away from the eye that watches it in (after the door)
  const u = Math.max(0, Math.min(1, (t - DOOR_S) / IN_LANE)), lane = IN_LANE_M * (1 - (1 - u) * (1 - u));
  const back = ease((t - DOOR_S - IN_LANE - IN_PAUSE) / IN_BACK);
  const p = back > 0 ? pathAt(OUT_PATH * (1 - back), side)
    : { x: side * (OUT_R + lane - IN_LANE_M), z: OUT_STRAIGHT + OUT_R, yaw: side * OUT_TURN };
  return shot({ active: t < DURATION, fov: config.fov, door: ease(t / DOOR_S), x: p.x, z: p.z, yaw: p.yaw,
    label: t < DOOR_S ? "OPENING GARAGE" : t < DURATION - 0.3 ? "BRINGING CAR IN" : "READY FOR WORK" },
    // Interior versions of garage-angles' bay/rear three-quarter framings.
    // A cut after the shutter opens keeps both eyes behind the threshold.
    left ? EYE_L : EYE_R,
    [Math.max(-3.5, Math.min(3.5, p.x * 0.7)), 0.8, t < DOOR_S ? 6.2 : Math.min(9, p.z * 0.48 + 0.8)], t, calm);
}
/* THE DRIVE-OUT: the arrival in reverse, opening every RACE! while the circuit
 * builds (js/game.js studioOpen). The shutter opens first (DOOR_S), the car sits
 * a beat, then rolls out nose first, sweeps across the doorway into the lane
 * and goes on down it at the PIT LIMITER — the speed it turned in at, no
 * launch — so it is seen leaving (~1.4 s in the doorway's view, 2026-10-14)
 * before the garage's front wall hides it. No circuit is needed — this is the
 * setup screen's own room — so it plays the moment START is pressed.
 * Reduce-motion Start Race plays it too, AT THE TUNER'S PACE: the 4x short cut
 * (~1.9 s) read as a glitch, not a leave (2026-10-09), and the card, the flyby
 * and the announcer always follow it (js/ui/loading-screen.js run). */
const OUT_HOLD = 1.1, OUT_RUN = 5.0, OUT_ACCEL = 1.2, OUT_EXIT_M = 8.5;
const OUT_V = OUT_PATH / (OUT_RUN - OUT_ACCEL / 2), OUT_EXIT = OUT_EXIT_M / OUT_V;
export const OUT_SETTLE = DOOR_S + OUT_HOLD + OUT_RUN + OUT_EXIT;   // gone behind the wall: the car holds from here
export const OUT_DURATION = OUT_SETTLE + 0.3;                         // a beat on the empty lane
// THE EMPTY-LANE HOLD: studioDone keeps this shot up past OUT_DURATION until
// RACE!'s load is done (seconds on a slow phone). A slow push toward the
// doorway (HOLD_PUSH m, easing out over ~HOLD_TAU s) keeps it a shot, not a
// stalled frame; the aim drifts from the jamb back to the lane. Not when calm.
const HOLD_PUSH = 2.2, HOLD_TAU = 4;
function outDistance(tm: number): number {
  if (tm <= 0) return 0;
  if (tm < OUT_ACCEL) return OUT_V * tm * tm / (2 * OUT_ACCEL);
  return OUT_V * (Math.min(tm, OUT_RUN + OUT_EXIT) - OUT_ACCEL / 2);
}
export function poseOut(seconds: number, config: Readonly<ArrivalSettings> = DEFAULT, calm = false): ArrivalPose {
  const t = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const right = config.angle === "right", side = right ? -1 : 1;   // turn away from the eye
  const opening = t < DOOR_S;
  const p = pathAt(outDistance(Math.min(t, OUT_SETTLE) - DOOR_S - OUT_HOLD), side);
  const eye = right ? EYE_R : EYE_L;
  // The aim follows it round to the jamb and holds on the doorway as it goes.
  const aim: Vec3 = [side * Math.min(side * p.x * 0.7, 3.5), 0.8, opening ? 6.2 : Math.min(9, 1.2 + p.z * 0.62)];
  let e = eye;
  if (!calm && t > OUT_SETTLE) {
    const k = 1 - Math.exp(-(t - OUT_SETTLE) / HOLD_TAU);
    e = [eye[0] * (1 - 0.25 * k), eye[1] - 0.25 * k, eye[2] + HOLD_PUSH * k];
    aim[0] -= side * 2.2 * k;
  }
  return shot({ active: t < OUT_DURATION, fov: config.fov, door: ease(t / DOOR_S), x: p.x, z: p.z, yaw: p.yaw,
    label: opening ? "OPENING GARAGE" : "LEAVING THE GARAGE" }, e, aim, t, calm);
}

export interface ArrivalPlayer {
  start(): void;
  step(dt: number): ArrivalPose | null;
  cancel(): void;
  finish(): void;
  readonly state: ArrivalPose | null;
}

/** The WORK ON CAR playback over the setup screen (#carsetup, cs-* ids, all present in index.html). */
export function create($: ById, reducedMotion: () => boolean, readSettings: () => unknown = () => DEFAULT): ArrivalPlayer {
  let state: ArrivalPose | null = null, time = 0, config: Readonly<ArrivalSettings> = DEFAULT;
  const root = $("carsetup")!, panel = $("cs-inner")!, controls = $("cs-stack")!;
  const overlay = $("cs-arrival")!, skip = $("cs-arrival-skip")!, label = $("cs-arrival-label")!;
  function chrome(on: boolean): void {
    root.classList.toggle("cs-arriving", on);
    panel.inert = controls.inert = on;
    overlay.hidden = !on;
    root.setAttribute("data-esc-close", on ? "cs-arrival-skip" : "cs-back");
  }
  function finish(): void {
    if (!state) return;
    state = pose(DURATION, config); time = DURATION;
    chrome(false);
    $("cs-done")!.focus({ preventScroll: true });
  }
  function start(): void {
    config = settings(readSettings());
    time = 0; state = pose(0, config);
    if (!config.enabled || reducedMotion()) { finish(); return; }
    label.textContent = state.label;
    chrome(true); skip.focus({ preventScroll: true });
  }
  function step(dt: number): ArrivalPose | null {
    if (state && state.active) {
      // Background-tab gaps must not swallow the whole arrival.
      time += Math.min(0.1, Math.max(0, Number.isFinite(dt) ? dt : 0)) * config.speed;
      state = pose(time, config);
      if (label.textContent !== state.label) label.textContent = state.label;
      if (!state.active) finish();
    }
    return state;
  }
  function cancel(): void { state = null; time = 0; chrome(false); }
  skip.onclick = finish;
  return { start, step, cancel, finish, get state() { return state; } };
}

export const GarageArrival = Object.freeze({ create, pose, poseOut, angleMap, DURATION, OUT_DURATION, OUT_SETTLE, DEFAULT, settings, bindSettings });
