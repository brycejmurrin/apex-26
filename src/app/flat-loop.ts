/**
 * A flat circular test loop implementing `TrackQuery`, for driving the shell
 * before the track lane's Monza build is wired in (PLAN T1.9 accept: "a
 * placeholder body drives around a flat test loop").
 *
 * Geometry: centre (-R, 0, 0), start at the origin heading +Z, a constant
 * right-hander. `r` is the unit right vector, f1-game's `cross(t, WORLD_UP)`
 * = (-t.z, 0, t.x) (js/track/tracks.js:146).
 */
import type { BankingOut, TrackQuery, TrackSample } from "../contracts/track";

export class FlatLoop implements TrackQuery {
  readonly length: number;
  readonly street = false;

  constructor(readonly radius = 180, readonly halfWidth = 7) {
    this.length = 2 * Math.PI * radius;
  }

  wrapS(s: number): number {
    const L = this.length;
    s %= L;
    return s < 0 ? s + L : s;
  }

  sample(s: number, out: TrackSample): TrackSample {
    const a = this.wrapS(s) / this.radius;
    const R = this.radius, sa = Math.sin(a), ca = Math.cos(a);
    out.p[0] = R * ca - R; out.p[1] = 0; out.p[2] = R * sa;
    out.t[0] = -sa; out.t[1] = 0; out.t[2] = ca;
    out.r[0] = -ca; out.r[1] = 0; out.r[2] = -sa;
    out.hw = this.halfWidth;
    return out;
  }

  banking(_s: number, _x: number, _out: BankingOut): BankingOut | null {
    return null;
  }

  onKerb(_s: number, x: number): 0 | 1 {
    const a = Math.abs(x);
    return a >= this.halfWidth - 0.6 && a <= this.halfWidth + 1.1 ? 1 : 0;
  }

  inPitLane(): boolean {
    return false;
  }

  wallAt(): number {
    return this.halfWidth + 6;
  }
}
