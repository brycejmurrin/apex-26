/**
 * TrackSurface: the shared terrain ribbon and prop-grounding profile. Ported
 * verbatim from f1-game js/track/core/surface.js (TrackSurface, :1-182);
 * `Log.info` dropped (logging only).
 */
import type { BuiltDef } from "./def";
import { clamp, lerp } from "./math/scalar";
import { wrap01 } from "./space";
import type { Track } from "./types";

const clamp01 = (v: number) => clamp(v, 0, 1);
const SHELF_END = 12, SHELF_BLEND = 30;   // metres past the road edge (run-off shelf)

/** The terrain cross-section of a built track. surface.js:80 */
export interface SurfaceProfile {
  outerW: number;
  rails: number[];
  street: boolean;
  flat: boolean;
  pyMin: number;
  floorY: number;
  ground: Float32Array;
  /** Ground height at node k, `lateralDistance` from the centreline, on lateral `side` (sign). */
  heightAt(k: number, lateralDistance: number, side?: number): number;
}

/** surface.js:10 */
function monotonicRails(outerW: number, street: boolean, flat: boolean, extra: number[] | null): number[] {
  const seeds = (street
    ? [5, 10, 16, 22, outerW]
    : flat
      ? [2.2, outerW * 0.3, outerW * 0.55, outerW * 0.8, outerW]
      : [2.2, 7, 14, 48, outerW]).concat(extra || []).sort((x, y) => x - y);
  const clipped: number[] = [];
  for (const value of seeds) {
    const v = Math.max(0.25, Math.min(outerW, value));
    if (!clipped.length || v - clipped[clipped.length - 1]! > 1e-6) clipped.push(v);
  }
  if (!clipped.length || Math.abs(clipped[clipped.length - 1]! - outerW) > 1e-6)
    clipped.push(outerW);

  const rails: number[] = [];
  let previous = 0;
  for (const end of clipped) {
    const pieces = Math.max(1, Math.ceil((end - previous) / 16));
    for (let i = 1; i <= pieces; i++) rails.push(lerp(previous, end, i / pieces));
    previous = end;
  }
  return rails.filter((v, i, a) => i === 0 || v - a[i - 1]! > 1e-6);
}

/** Build the profile for a built centreline (after TrackPit.build). surface.js:34 */
export function profile(def: BuiltDef, track: Track): SurfaceProfile {
  const street = !!def.street;
  const flat = !!def.flatTerrain;
  const outerW = Math.max(0.5, Number(def.terrainOuter) || (street ? 28 : 120));
  const falloffStart = Number.isFinite(def.terrainFalloffStart) &&
    def.terrainFalloffStart! >= SHELF_BLEND && def.terrainFalloffStart! < outerW
    ? def.terrainFalloffStart! : null;
  // The pit complex's flattened edges are rails too (surface.js:43).
  const pit = track && track.pit && !track.pit.painted ? track.pit : null;
  const pitRails = pit ? [pit.off.outer + 0.3, pit.off.outer + 8.3,
                          pit.off.outer + 0.3 + pit.bay.depth + 3, pit.off.outer + 8.3 + pit.bay.depth + 3] : null;
  const rails = monotonicRails(outerW, street, flat, pitRails);
  const n = track.n;
  // pyMin is the lowest point of the ROAD SURFACE (a banked node's low edge is lift/2 under py).
  const bp = track.bankP;
  let pyMin = Infinity;
  for (let k = 0; k < n; k++) {
    const lift = bp && bp.lift[k]! > 0 ? bp.lift[k]! / 2 : 0;
    pyMin = Math.min(pyMin, track.py[k]! - lift);
  }
  const floorY = pyMin - 1;
  const ground = new Float32Array(track.py);

  // Bridges lift the deck but not the terrain beneath it, at the same shifted frac as buildCenterline.
  if (def.bridges) {
    const ds = track.total / n;
    const dress = def._sceneryShift || 0;
    for (const bridge of def.bridges) {
      const center = wrap01(bridge.s + dress) * track.total;
      for (let k = 0; k < n; k++) {
        let d = Math.abs(k * ds - center);
        d = Math.min(d, track.total - d);
        if (d < bridge.halfM)
          ground[k]! -= bridge.rise * 0.5 * (1 + Math.cos(Math.PI * d / bridge.halfM));
      }
    }
  }

  const p: SurfaceProfile = {
    outerW, rails, street, flat, pyMin, floorY, ground,
    heightAt(k: number, lateralDistance: number, side?: number): number {
      const i = ((Math.round(k) % n) + n) % n;
      const dist = Math.max(0, Math.abs(Number(lateralDistance) || 0));
      const base = ground[i]!;
      // Flat under the pit complex on the pit side, easing back over 8 m (surface.js:96).
      const pit = track && track.pit;
      if (pit && side === pit.side && pit.keep[i]! > 0) {
        const edge = pit.keep[i]!, wk = pit.w[i]!, ew = wk * wk * (3 - 2 * wk);
        const flat = (d: number) => lerp(p.heightAt(k, d, 0), base - 0.03, ew);
        if (dist <= edge) return flat(dist);
        if (dist < edge + 8) {
          const t = (dist - edge) / 8, e = t * t * (3 - 2 * t);
          return lerp(flat(dist), p.heightAt(k, dist, 0), e);
        }
      }
      if (dist >= outerW) return floorY;
      // Berms on banked corners, outer (high) side only (surface.js:116).
      const bermLift = () => {
        if (!def.berms || flat || street || !bp) return 0;
        const lift = bp.lift[i] || 0;
        if (!(lift > 0.15)) return 0;
        const outer = bp.bsign[i] || 0;
        if (!outer || !side || side !== outer) return 0;
        if (dist < 2.0 || dist > 22) return 0;
        const peak = Math.min(2.4, 0.55 + lift * 0.35);
        let w = 1;
        if (dist < 6) w = clamp01((dist - 2.0) / 4);
        else if (dist > 10) w = 1 - clamp01((dist - 10) / 12);
        const e = w * w * (3 - 2 * w);
        return peak * e;
      };
      if (flat || street) {
        const shelf = base - 0.12 - dist * 0.004;
        const edgeStart = outerW * 0.72;
        if (dist <= edgeStart) return shelf + bermLift();
        const t = clamp01((dist - edgeStart) / Math.max(0.01, outerW - edgeStart));
        const ease = t * t * (3 - 2 * t);
        return lerp(shelf, floorY, ease) + bermLift();
      }
      const t = clamp01(dist / outerW);
      const ease = t * t * (3 - 2 * t);
      const localFloor = Math.max(base - 10, Math.min(ground[i]!, pyMin));
      let slope = lerp(base - 0.3 - dist * 0.018, localFloor, ease);
      // Run-off shelf: meet the verge 5 cm under its edge, ease into the fall-off (surface.js:146).
      if (dist < SHELF_BLEND) {
        const shelf = base - 0.08 - Math.max(0, dist - 2.2) * 0.004;
        const u = clamp01((dist - SHELF_END) / (SHELF_BLEND - SHELF_END));
        slope = lerp(shelf, slope, u * u * (3 - 2 * u));
      }
      slope += bermLift();
      if (falloffStart !== null) {
        const edgeT = clamp01((dist - falloffStart) / (outerW - falloffStart));
        return lerp(slope, floorY, edgeT * edgeT * (3 - 2 * edgeT));
      }
      // Last 18% meets the universal floor exactly.
      const edgeT = clamp01((t - 0.82) / 0.18);
      return lerp(slope, floorY, edgeT * edgeT * (3 - 2 * edgeT));
    },
  };
  return p;
}

/** surface.js:176 */
export function heightAt(surface: SurfaceProfile, k: number, lateralDistance: number): number {
  return surface.heightAt(k, lateralDistance);
}
