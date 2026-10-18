/**
 * Chase camera: the "chase" branch of f1-game's vantage solver plus its lens.
 *
 * - Rig: js/camera/vantage.js:675-776 (`back` 5.8, `eyeUp` 1.35, `lead` 6,
 *   `tgtUp` 0.7, the three-quarter side offset `CHASE_SIDE_FRAC`, the corner
 *   lead blend toward the road frame `CHASE_CORNER_LEAD_DEFAULT`, the eye-in
 *   `CHASE_EYE_IN`, the g-dolly, and the speed open `speedOpen`/`pullBack`).
 * - Ride height: vantage.js:356-373 (`rideY` 7-tap Hann average, `rideGrade`).
 *   Heights come from `TrackQuery.sample` (linear) instead of f1-game's
 *   Catmull-Rom `centreY`, which needs the raw node array.
 *   TODO(lane-track): switch to a C1 centre height when the track lane exposes one.
 * - Lens: js/camera/feel.js:112-115 (`modeFov` with chase's
 *   `{ base 57, widen 6, dep 3 }`), :201-222 (`drive`, the chase rates) and
 *   js/camera/drive-chase.js:13-15 (the chase FOV delta).
 * - Followers: feel.js:146-174 (`dampToward`, `follow`).
 *
 * Not ported: the bend hang (`bendHang`, vantage.js:764-768) reads track
 * curvature, which `TrackQuery` does not carry; the wall clamp, CamTune
 * offsets, look-back and free-look come with the camera family.
 *
 * Camera only: this moves where the camera looks, never the car.
 */
import type { CameraPose } from "../contracts/render";
import type { TrackQuery, TrackSample, Vec3 } from "../contracts/track";

const CHASE_SIDE_FRAC = 0.3;          // vantage.js:170
const CHASE_EYE_IN = 0.725;           // vantage.js:174
const CHASE_CORNER_LEAD_DEFAULT = 0.54; // vantage.js:178
const CHASE_G_DOLLY = 14;             // vantage.js:185
const CHASE_G_AIM = 5;                // vantage.js:186
const RIDE_OFF = [-22.5, -15, -7.5, 0, 7.5, 15, 22.5];   // vantage.js:220
const RIDE_W = [0.1464, 0.5, 0.8536, 1, 0.8536, 0.5, 0.1464];
const RIDE_WSUM = 4.0;
const RIDE_SPAN = 60;
const RIDE_GRADE = 40;
/** feel.js:106 FOV_BY_MODE.chase. */
const FOV_CHASE = { base: 57, widen: 6, scale: 1, dep: 3 } as const;
/** feel.js:184 DRIVE_RESPONSE.chase. */
const DRIVE_CHASE = { sp: 4.2, yaw: 2.2, brake: 9, slip: 3.2 } as const;
/** f1-game physics/consts.js:11 VMAX; game.js:6580 injects vTop() at boot. */
export const DEFAULT_VMAX = 72;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** feel.js:146-174: exponential followers keyed by name. dt <= 0 snaps. */
export class Follow {
  private readonly v = new Map<string, number>();
  follow(key: string, target: number, lambda: number, dt: number): number {
    if (!(dt > 0)) { this.v.set(key, target); return target; }
    const cur = this.v.get(key);
    const next = cur === undefined || cur !== cur ? target : cur + (target - cur) * (1 - Math.exp(-lambda * dt));
    this.v.set(key, next);
    return next;
  }
  reset(): void { this.v.clear(); }
}

export interface ChaseInput {
  /** Arc position and lateral offset of the car. */
  readonly s: number;
  readonly x: number;
  /** Speed, m/s. */
  readonly speed: number;
  /** World XZ of the car and its heading (f1-game `extra.carPos`, `extra.carHead`). */
  readonly px: number;
  readonly pz: number;
  readonly head: number;
  /** Yaw rate, rad/s (lens only). */
  readonly yawRate: number;
  /** Smoothed body pitch, + = brake dive (body-attitude `baPitch`); 0 until that lands. */
  readonly pitch: number;
  /** ERS deploying (lens widen). */
  readonly deploy: boolean;
  /** Frame dt, seconds; 0 snaps every follower. */
  readonly dt: number;
}

export class ChaseCam {
  private readonly fol = new Follow();
  private readonly a: TrackSample = { p: [0, 0, 0], t: [0, 0, 1], r: [1, 0, 0], hw: 7 };
  private readonly b: TrackSample = { p: [0, 0, 0], t: [0, 0, 1], r: [1, 0, 0], hw: 7 };
  private readonly eye: Vec3 = [0, 0, 0];
  private readonly tgt: Vec3 = [0, 0, 0];

  constructor(private readonly track: TrackQuery, private readonly vmax = DEFAULT_VMAX) {}

  /** Drop eased state (a cut, a restart). */
  reset(): void { this.fol.reset(); }

  solve(c: ChaseInput): CameraPose {
    const track = this.track, eye = this.eye, tgt = this.tgt;
    const spd = Number.isFinite(c.speed) ? c.speed : 0;
    const x = Number.isFinite(c.x) ? c.x : 0;
    const s = c.s;
    const spN = clamp(spd / this.vmax, 0, 1);
    const back = 5.8, eyeUp = 1.35, lead = 6, tgtUp = 0.7;
    track.sample(track.wrapS(s - back), this.b);
    const cx = x * 0.5;
    const rideC = this.rideY(s), grade = this.rideGrade(s);
    const rideEye = rideC - back * grade;
    const rideTgtAhead = rideC + lead * grade;
    const hx = Math.sin(c.head), hz = Math.cos(c.head);
    const rx = hz, rz = -hx;
    const side = back * CHASE_SIDE_FRAC;
    eye[0] = c.px - hx * back + rx * side; eye[1] = rideEye + eyeUp; eye[2] = c.pz - hz * back + rz * side;
    tgt[0] = c.px + hx * lead; tgt[1] = rideC + tgtUp; tgt[2] = c.pz + hz * lead;
    const lead2 = CHASE_CORNER_LEAD_DEFAULT;
    const cvB = this.b;
    const eyeR0 = cvB.p[0] + cvB.r[0] * cx, eyeR1 = rideEye + eyeUp, eyeR2 = cvB.p[2] + cvB.r[2] * cx;
    track.sample(track.wrapS(s + lead), this.a);
    const lx = x * 0.4;
    const tgtR0 = this.a.p[0] + this.a.r[0] * lx, tgtR1 = rideTgtAhead + tgtUp, tgtR2 = this.a.p[2] + this.a.r[2] * lx;
    eye[0] = lerp(eye[0], eyeR0, lead2); eye[1] = lerp(eye[1], eyeR1, lead2); eye[2] = lerp(eye[2], eyeR2, lead2);
    tgt[0] = lerp(tgt[0], tgtR0, lead2); tgt[1] = lerp(tgt[1], tgtR1, lead2); tgt[2] = lerp(tgt[2], tgtR2, lead2);
    {
      const fx2 = tgt[0] - eye[0], fz2 = tgt[2] - eye[2];
      const fl2 = Math.hypot(fx2, fz2);
      if (fl2 > 1e-4) { eye[0] += (fx2 / fl2) * CHASE_EYE_IN; eye[2] += (fz2 / fl2) * CHASE_EYE_IN; }
    }
    const gP = c.pitch || 0;
    eye[0] += hx * gP * CHASE_G_DOLLY; eye[2] += hz * gP * CHASE_G_DOLLY;
    tgt[1] -= gP * CHASE_G_AIM;
    // speedOpen + pullBack (vantage.js:323-340): open 1.6 m along the view at full speed.
    const open = this.fol.follow("chaseOpen", spN * 1.6, 2.6, c.dt);
    if (open > 0) {
      const fx = tgt[0] - eye[0], fz = tgt[2] - eye[2];
      const fl = Math.hypot(fx, fz);
      if (fl >= 1e-4) { eye[0] -= (fx / fl) * open; eye[2] -= (fz / fl) * open; }
    }
    let fov = FOV_CHASE.base + FOV_CHASE.widen * spN * FOV_CHASE.scale + (c.deploy ? 1 : 0) * FOV_CHASE.dep;
    fov += this.lens(spN, c);
    return { eye, target: tgt, fovY: fov * Math.PI / 180, near: 0.1, far: 4000 };
  }

  /** feel.js:201-222 `drive` + drive-chase.js:15: FOV delta in degrees. */
  private lens(spN: number, c: ChaseInput): number {
    const dt = c.dt > 0 ? c.dt : 0;
    const sp = this.fol.follow("sp:chase", clamp(spN, 0, 1), DRIVE_CHASE.sp, dt);
    const yaw = this.fol.follow("yaw:chase", clamp(c.yawRate / 1.1, -1, 1), DRIVE_CHASE.yaw, dt);
    const brake = this.fol.follow("brk:chase", clamp(c.pitch / 0.025, 0, 1), DRIVE_CHASE.brake, dt);
    return 4 * sp + 2 * Math.abs(yaw) + 2 * brake;
  }

  private centreY(s: number): number {
    return this.track.sample(this.track.wrapS(s), this.a).p[1];
  }

  private rideY(s: number): number {
    if (this.track.length < RIDE_SPAN * 2) return this.centreY(s);
    let acc = 0;
    for (let k = 0; k < RIDE_OFF.length; k++) acc += this.centreY(s + RIDE_OFF[k]!) * RIDE_W[k]!;
    return acc / RIDE_WSUM;
  }

  private rideGrade(s: number): number {
    if (this.track.length < RIDE_GRADE * 4) return 0;
    return (this.rideY(s + RIDE_GRADE) - this.rideY(s - RIDE_GRADE)) / (2 * RIDE_GRADE);
  }
}
