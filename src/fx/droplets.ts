// Droplets: rain on the lens / visor for the ONBOARD cameras (cockpit, hood, visor,
// helmet, T-cam).
//
// Port of f1-game js/fx/droplets.js:1-215, verbatim, split in two:
//   - `DropletSim`: the pure drop pool (spawn, airflow step, age/kill, spawn
//     accumulator) on the same Float32Arrays, `random` injected (f1-game Math.random);
//   - `createDroplets(deps)`: the Canvas2D overlay that f1-game's IIFE was, its globals
//     (`document`, `window`, `GLX.isMobile`, `matchMedia`, `GfxQuality.current()`)
//     injected. It is renderer-agnostic by design (see below), so it stays a 2D
//     canvas over the three.js canvas rather than a three.js pass.
// `Log.info` dropped; `_reset()` kept for tests.
//
// f1-game header (droplets.js:1-18): A renderer-agnostic 2D overlay: the static
// <canvas id="fx-droplets"> in index.html sits above #game and #game-soft (z-index 2,
// css/overlays.css) and below the HUD, so GLX, TLX and WGX all get the same water and
// no backend pays a pass for it. game.js calls tick() once per rendered frame;
// everything else is here.
//
// Look, after the MotoGP lens drops (Shawn Hargreaves, "raindrops keep falling on my
// lens", https://www.shawnhargreaves.com/blog/motogp-raindrops-keep-falling-on-my-lens.html):
// each drop is a tiny lens that shows a flipped, blurred copy of the scene behind it.
// That game sampled a downscaled copy of the frame; a 2D overlay cannot read a WebGL
// back buffer cheaply, so the refraction is FAKED the way the SDF rain-on-glass shaders
// shade it (https://godotshaders.com/shader/rain-on-glass/): a darker centre, a bright
// rim, a sky-bright lower half (the flipped sky) and one specular glint. One sprite is
// painted once and stamped per drop with drawImage (no per-drop gradients: phones stay
// cheap).
//
// Motion: at speed the airflow pushes drops UP and OUT from the screen centre, bigger
// drops first (they stick less), and stretches them into short streaks; parked, they
// sag slowly down. Under REDUCED MOTION drops never move or stretch — fewer of them
// fade in and out where they landed. Off: GRAPHICS LOW, any non-onboard camera, photo
// mode, and anything below falling rain (the drizzle tier only wets the road). Visual
// only — Math.random is fine, nothing here touches the sim.

export const CAP_PHONE = 40, CAP_DESK = 90;   // live drops
export const RAIN_MIN = 0.5;                  // frame.rain: 1 raining, 0.35 drizzle tier, 0 dry (game.js ramp)
const RATE_RAIN = 18, RATE_STORM = 34;        // drops/s at full rain (storm is the heavier tier)
const STRETCH_MAX = 3.2;                      // streak length / width at full airflow
const DPR_MAX_DESK = 1.5, DPR_MAX_PHONE = 1;

/** Drops per second for a frame.rain value (0 below falling rain); storm is heavier. */
export function rate(rain: number, storm: boolean, reduced: boolean): number {
  if (!(rain >= RAIN_MIN)) return 0;
  const k = Math.min(1, (rain - RAIN_MIN) / (1 - RAIN_MIN));
  return (storm ? RATE_STORM : RATE_RAIN) * (0.3 + 0.7 * k) * (reduced ? 0.4 : 1);
}
/** Live-drop ceiling: phones 40, desktop 90; halved under reduced motion. */
export function cap(mobile: boolean, reduced: boolean): number {
  const c = mobile ? CAP_PHONE : CAP_DESK;
  return reduced ? (c >> 1) : c;
}

// Airflow at standard speed vs (m/s, vStd): 0 parked → 1 by ~70 m/s.
function _air(vs: number): number { return Math.max(0, Math.min(1, (vs - 8) / 62)); }

/** The drop pool. Positions are 0..1 of the viewport; renderer-free. */
export class DropletSim {
  n = 0;
  acc = 0;
  // Struct-of-arrays, sized for the desktop cap once.
  readonly x = new Float32Array(CAP_DESK); readonly y = new Float32Array(CAP_DESK);    // 0..1 of the viewport
  readonly r = new Float32Array(CAP_DESK);                                              // radius, fraction of min(w, h)
  readonly age = new Float32Array(CAP_DESK); readonly life = new Float32Array(CAP_DESK);
  readonly vx = new Float32Array(CAP_DESK); readonly vy = new Float32Array(CAP_DESK);   // viewport fractions / s
  readonly a = new Float32Array(CAP_DESK);

  constructor(private readonly random: () => number = Math.random) {}

  spawn(reduced: boolean): void {
    const rnd = this.random;
    const i = this.n++;
    this.x[i] = 0.04 + rnd() * 0.92;
    this.y[i] = 0.04 + rnd() * 0.80;   // not the very bottom: the cockpit/HUD sits there
    this.r[i] = 0.006 + rnd() * rnd() * 0.020;
    this.age[i] = 0;
    this.life[i] = reduced ? 1.8 + rnd() * 1.6 : 2.5 + rnd() * 3.5;
    this.vx[i] = this.vy[i] = 0;
    this.a[i] = 0.55 + rnd() * 0.45;
  }

  kill(i: number): void {
    const l = --this.n;
    if (i === l) return;
    const { x, y, r, age, life, vx, vy, a } = this;
    x[i] = x[l]!; y[i] = y[l]!; r[i] = r[l]!; age[i] = age[l]!; life[i] = life[l]!;
    vx[i] = vx[l]!; vy[i] = vy[l]!; a[i] = a[l]!;
  }

  step(dt: number, vs: number, reduced: boolean): void {
    const { x, y, r, age, life, vx, vy } = this;
    const air = reduced ? 0 : _air(vs);
    for (let i = 0; i < this.n; ) {
      age[i]! += dt;
      // Blown off faster at speed: a drop's life burns 1 + 2·air times as fast.
      if (!reduced) age[i]! += dt * 2 * air;
      if (age[i]! >= life[i]!) { this.kill(i); continue; }
      if (!reduced) {
        // Bigger drops break away first; the flow fans out from the screen centre, up and sideways.
        const stick = Math.min(1, r[i]! / 0.02);
        const push = air * (0.25 + 0.75 * stick);
        const tx = (x[i]! - 0.5) * 1.4 * push, ty = -0.9 * push + (1 - air) * 0.015 * stick;   // parked: a slow sag
        const k = Math.min(1, dt * 6);
        vx[i]! += (tx - vx[i]!) * k; vy[i]! += (ty - vy[i]!) * k;
        x[i]! += vx[i]! * dt; y[i]! += vy[i]! * dt;
        if (x[i]! < -0.05 || x[i]! > 1.05 || y[i]! < -0.05 || y[i]! > 1.05) { this.kill(i); continue; }
      }
      i++;
    }
  }

  /** droplets.js:203-204: accumulate `ratePerS * dt` and spawn whole drops up to `capN`. */
  emit(ratePerS: number, dt: number, capN: number, reduced: boolean): void {
    this.acc += ratePerS * dt;
    while (this.acc >= 1) { this.acc -= 1; if (this.n < capN) this.spawn(reduced); }
  }

  clear(): void { this.n = 0; this.acc = 0; }
}

/** What the overlay reads from the page. Every member optional: absent = f1-game's
 *  guarded default for the missing global. */
export interface DropletDeps {
  /** `document` (the #fx-droplets / #game lookup and the sprite canvas). */
  readonly doc?: Document | null;
  /** `window` (devicePixelRatio, innerWidth, innerHeight). */
  readonly win?: Pick<Window, "devicePixelRatio" | "innerWidth" | "innerHeight"> | null;
  /** f1-game `GLX.isMobile || matchMedia("(pointer: coarse)").matches`, read once.
   *  TODO(lane-render): the renderer's device-class flag; default is the media query. */
  readonly isMobile?: () => boolean;
  /** f1-game `GfxQuality.current() === "low"`. TODO(lane-shell): the GRAPHICS setting. */
  readonly graphicsLow?: () => boolean;
  readonly random?: () => number;
}

export interface Droplets {
  /** Once per rendered frame. on: an onboard camera, racing, not photo mode. rain:
   *  frame.rain (0..1). storm: the heavier tier. vs: the viewed car's vStd speed (m/s).
   *  reduced: prefers-reduced-motion. dt 0 (paused) freezes the drops in place. */
  tick(dt: number, on: boolean, rain: number, storm: boolean, vs: number, reduced: boolean): void;
  clear(): void;
  stats(): { n: number; shown: boolean; cap: number; w: number; h: number };
  readonly rate: typeof rate;
  readonly cap: typeof cap;
  readonly RAIN_MIN: number;
  readonly sim: DropletSim;
  /** Tests: forget the cached canvas / device class (a new stub DOM). */
  _reset(): void;
}

function defaultIsMobile(): boolean {
  return typeof matchMedia === "function" && !!matchMedia("(pointer: coarse)").matches;
}

export function createDroplets(deps: DropletDeps = {}): Droplets {
  const doc = deps.doc !== undefined ? deps.doc : (typeof document !== "undefined" ? document : null);
  const win = deps.win !== undefined ? deps.win : (typeof window !== "undefined" ? window : null);
  const isMobile = deps.isMobile ?? defaultIsMobile;
  const graphicsLow = deps.graphicsLow ?? (() => false);
  const sim = new DropletSim(deps.random ?? Math.random);

  let _cv: HTMLCanvasElement | null = null, _ctx: CanvasRenderingContext2D | null = null;
  let _sprite: HTMLCanvasElement | null = null, _looked = false;
  let _w = 0, _h = 0, _dpr = 1, _shown = false, _mobile: boolean | null = null;

  function _mob(): boolean {
    if (_mobile === null) _mobile = isMobile();
    return _mobile;
  }

  function _lookup(): HTMLCanvasElement | null {
    if (_looked) return _cv;
    _looked = true;
    _cv = doc && doc.getElementById ? (doc.getElementById("fx-droplets") as HTMLCanvasElement | null) : null;
    if (!_cv && doc && doc.createElement) {
      // No static element in this shell: build it right after #game, the
      // #game-soft pattern (f1-game js/render/glx/glx.js ensureSoftDisplay); the
      // #fx-droplets style rule places it either way. TODO(lane-data styles): port it.
      const game = doc.getElementById ? doc.getElementById("game") : null;
      if (game && game.parentNode) {
        _cv = doc.createElement("canvas");
        _cv.id = "fx-droplets";
        _cv.setAttribute("aria-hidden", "true");
        _cv.hidden = true;
        game.parentNode.insertBefore(_cv, game.nextSibling);
      }
    }
    _ctx = _cv && _cv.getContext ? _cv.getContext("2d") : null;
    if (!_ctx) { _cv = null; return null; }
    _sprite = _paintSprite();
    return _cv;
  }

  // The one drop: 64 px, painted once. Dark core, bright rim, light lower half, glint up-left.
  function _paintSprite(): HTMLCanvasElement | null {
    if (!doc || !doc.createElement) return null;
    const s = doc.createElement("canvas");
    if (!s || !s.getContext) return null;
    s.width = s.height = 64;
    const g = s.getContext("2d");
    if (!g || !g.createRadialGradient) return null;
    const body = g.createRadialGradient(32, 30, 4, 32, 32, 31);
    body.addColorStop(0, "rgba(20,26,34,0.30)");      // the darker centre: the refracted road
    body.addColorStop(0.62, "rgba(70,82,96,0.22)");
    body.addColorStop(0.86, "rgba(235,242,250,0.55)"); // the bright rim
    body.addColorStop(1, "rgba(235,242,250,0)");       // soft edge
    g.fillStyle = body; g.beginPath(); g.arc(32, 32, 31, 0, Math.PI * 2); g.fill();
    const sky = g.createLinearGradient(0, 30, 0, 60);   // the flipped sky in the lower half
    sky.addColorStop(0, "rgba(200,215,230,0)"); sky.addColorStop(1, "rgba(200,215,230,0.28)");
    g.fillStyle = sky; g.beginPath(); g.arc(32, 32, 24, 0, Math.PI); g.fill();
    g.fillStyle = "rgba(255,255,255,0.75)";            // specular glint
    g.beginPath(); g.arc(24, 22, 4.5, 0, Math.PI * 2); g.fill();
    return s;
  }

  function _resize(cv: HTMLCanvasElement): void {
    if (!win) return;
    const dpr = Math.min(win.devicePixelRatio || 1, _mob() ? DPR_MAX_PHONE : DPR_MAX_DESK);
    const w = Math.max(1, Math.round((win.innerWidth || 1) * dpr)), h = Math.max(1, Math.round((win.innerHeight || 1) * dpr));
    if (w === _w && h === _h && dpr === _dpr) return;
    _w = w; _h = h; _dpr = dpr;
    cv.width = w; cv.height = h;
  }

  function _show(on: boolean): void {
    if (on === _shown) return;
    _shown = on;
    if (_cv) _cv.hidden = !on;
    if (!on) { sim.clear(); if (_ctx && _w) _ctx.clearRect(0, 0, _w, _h); }
  }

  function _draw(g: CanvasRenderingContext2D, reduced: boolean): void {
    const { x, y, r, age, life, vx, vy, a: alpha } = sim;
    g.clearRect(0, 0, _w, _h);
    const m = Math.min(_w, _h);
    for (let i = 0; i < sim.n; i++) {
      const t = age[i]! / life[i]!;
      // Fade in fast, out slow (the reduced path's whole motion is this envelope).
      const env = Math.min(1, t * (reduced ? 4 : 12)) * Math.min(1, (1 - t) * (reduced ? 3 : 4));
      const a = alpha[i]! * env;
      if (a <= 0.01) continue;
      const rad = r[i]! * m, cx = x[i]! * _w, cy = y[i]! * _h;
      const sp = Math.hypot(vx[i]!, vy[i]!);
      const st = reduced ? 1 : Math.min(STRETCH_MAX, 1 + sp * 4);
      g.globalAlpha = a;
      if (_sprite) {
        if (st > 1.05) {
          g.save(); g.translate(cx, cy); g.rotate(Math.atan2(vy[i]!, vx[i]!) + Math.PI / 2);
          g.drawImage(_sprite, -rad, -rad * st, rad * 2, rad * 2 * st);
          g.restore();
        } else g.drawImage(_sprite, cx - rad, cy - rad, rad * 2, rad * 2);
      } else {
        g.fillStyle = "rgba(220,230,240,0.35)";
        g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
      }
    }
    g.globalAlpha = 1;
  }

  function tick(dt: number, on: boolean, rain: number, storm: boolean, vs: number, reduced: boolean): void {
    if (!(on && !graphicsLow() && rain >= RAIN_MIN * 0.5)) { _show(false); return; }   // a fading shower keeps its drops
    const cv = _lookup();
    if (!cv || !_ctx) return;
    _show(true);
    _resize(cv);
    if (!(dt > 0)) return;   // paused: the last frame stays on the glass
    if (dt > 0.1) dt = 0.1;
    sim.step(dt, vs || 0, !!reduced);
    const c = cap(_mob(), !!reduced);
    sim.emit(rate(rain, storm, !!reduced), dt, c, !!reduced);
    _draw(_ctx, !!reduced);
  }

  function clear(): void { _show(false); }
  function stats(): { n: number; shown: boolean; cap: number; w: number; h: number } {
    return { n: sim.n, shown: _shown, cap: cap(_mob(), false), w: _w, h: _h };
  }
  function _reset(): void { _looked = false; _cv = _ctx = _sprite = null; _mobile = null; sim.clear(); _shown = false; _w = _h = 0; }

  return { tick, clear, stats, rate, cap, RAIN_MIN, sim, _reset };
}
