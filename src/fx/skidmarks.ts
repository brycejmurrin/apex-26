// SkidMarks: the tyre-mark ring buffer and its batched draw.
//
// Port of f1-game js/fx/skidmarks.js:1-124, verbatim (Float32Array marks and vertex
// stream, Float64Array ages, the same cadence and AI-share arithmetic). The ring, the
// cadence and the vertex expansion (rebuild) are pure; `draw(gfx, eye)` hands the batch
// to a `SkidSink` (f1-game `gfx.drawSkidBatch` / `gfx.drawMark`), which ./three.ts
// implements on three.js. `Log.info` dropped; `verts()` added for tests.
//
// A mark is the 16-float column-major model matrix of the wheel's grounded basis
// (right 0-2, up 4-6, forward 8-10, origin 12-14); rebuild() expands it into a
// _SKID_W x _SKID_L quad 2 cm above the road, 5 floats a vertex: [x, y, z, u, v],
// u, v in -1..1 (the mark shader's falloff coordinates).

/** The renderer side (f1-game GLX/TLX `drawSkidBatch`, `drawMark`). drawSkidBatch returns
 *  true when it drew the whole batch; false makes draw() fall back to per-mark quads. */
export interface SkidSink {
  drawSkidBatch(verts: Float32Array, vertCount: number, dirty: boolean): boolean;
  drawMark?(model: Float32Array, w: number, l: number): void;
}

/** One car's stamp cadence: seconds until its next mark may be laid (skidmarks.js:430). */
export interface StampTimer { t: number }

export interface SkidMarks {
  reset(): void;
  stamp(mat: ArrayLike<number>, laying: boolean, dt?: number): void;
  stampFor(timer: StampTimer | null | undefined, mat: ArrayLike<number>, laying: boolean, dt?: number): boolean;
  draw(gfx: SkidSink, camEye?: ArrayLike<number> | null): void;
  readonly count: number;
  readonly otherCount: number;
  /** The expanded batch as of the last draw (tests / debug). */
  verts(): { readonly verts: Float32Array; readonly vertCount: number };
}

export const MAX_SKID = 120;
const _SKID_W = 0.6, _SKID_L = 2.2;
// 6 verts (two tris) — matches the shadowVAO quad winding [0,1,2, 0,2,3].
const _SKID_CORNERS: readonly number[] = [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5, -0.5];
const SKID_CULL = 170 * 170;
// Seconds between stamps. This was 5 FRAMES: at the same speed a 144 Hz
// display packed marks 2.4x denser than 60 fps and a 30 fps device left
// dashes, while the particle emitters beside it in render() were already
// rate·dt gated. The physics step is the natural unit — 5 steps at 60 Hz.
export const STAMP_EVERY_S = 5 / 60;
// Other cars' marks (stampFor: an AI lock-up, ./car-fx.ts) may hold at
// most this many slots of the shared ring at once — a third — so a field of
// locking rivals never flushes the player's own trail.
export const AI_CAP = 40;

export function createSkidMarks(): SkidMarks {
  const marks = Array.from({ length: MAX_SKID }, () => new Float32Array(16));
  let active = 0;               // how many marks are live (grows to MAX_SKID then stays)
  let idx = 0;
  const own: StampTimer = { t: 0 };   // the player's cadence: seconds until the next stamp may be laid
  const other = new Uint8Array(MAX_SKID);   // 1 = the slot holds another car's mark
  let otherLive = 0, age = 0;
  const ages = new Float64Array(MAX_SKID);

  const verts = new Float32Array(MAX_SKID * 6 * 5);
  let vertCount = 0;
  let dirty = false;

  const markAt = (i: number): Float32Array => marks[i]!;

  function rebuild(): void {
    const full = active >= MAX_SKID, cnt = full ? MAX_SKID : active;
    let o = 0;
    for (let i = 0; i < cnt; i++) {
      const M = full ? markAt((idx + i) % MAX_SKID) : markAt(i);
      const m0 = M[0]!, m1 = M[1]!, m2 = M[2]!, m4 = M[4]!, m5 = M[5]!, m6 = M[6]!,
            m8 = M[8]!, m9 = M[9]!, m10 = M[10]!, m12 = M[12]!, m13 = M[13]!, m14 = M[14]!;
      for (let v = 0; v < 6; v++) {
        const ax = _SKID_CORNERS[v * 2]!, ay = _SKID_CORNERS[v * 2 + 1]!;
        const lx = ax * _SKID_W, lz = ay * _SKID_L;
        verts[o++] = m0 * lx + m4 * 0.02 + m8 * lz + m12;
        verts[o++] = m1 * lx + m5 * 0.02 + m9 * lz + m13;
        verts[o++] = m2 * lx + m6 * 0.02 + m10 * lz + m14;
        verts[o++] = ax * 2;
        verts[o++] = ay * 2;
      }
    }
    vertCount = cnt * 6;
    dirty = false;
  }

  // Clear the trail. Called from startRace() — marks are per-session, and a
  // second race on the same circuit must not inherit the first one's rubber.
  function reset(): void {
    active = 0; idx = 0; own.t = 0; other.fill(0); otherLive = 0; age = 0; ages.fill(0); dirty = true;
  }

  // One car's cadence: true when a stamp is due. `timer.t` is its countdown.
  function due(timer: StampTimer, laying: boolean, dt: number | undefined): boolean {
    if (!laying) { timer.t = 0; return false; }
    timer.t -= dt !== undefined && dt > 0 ? dt : 1 / 60;   // no dt (an old caller) charges one nominal frame
    if (timer.t > 0) return false;
    // Carry the remainder, so a 30 Hz frame (33 ms) does not round the 83 ms
    // period up to 100 ms — but never more than one period of debt, so a
    // long frame after a stall does not lay a burst of catch-up marks.
    timer.t = Math.max(-STAMP_EVERY_S, timer.t) + STAMP_EVERY_S;
    return true;
  }
  function lay(mat: ArrayLike<number>, isOther: boolean): void {
    if (active >= MAX_SKID && other[idx]) otherLive--;   // overwriting the oldest
    other[idx] = isOther ? 1 : 0;
    if (isOther) otherLive++;
    markAt(idx).set(mat);
    ages[idx] = ++age;
    idx = (idx + 1) % MAX_SKID;
    if (active < MAX_SKID) active++;
    dirty = true;               // rebuild the batched trail next render
  }

  // The player's marks.
  function stamp(mat: ArrayLike<number>, laying: boolean, dt?: number): void {
    if (due(own, laying, dt)) lay(mat, false);
  }
  // Another car's marks, on its OWN cadence (`timer` = { t: 0 }, one per car,
  // owned by the caller) and inside the AI_CAP share. True when one was laid.
  function stampFor(timer: StampTimer | null | undefined, mat: ArrayLike<number>, laying: boolean, dt?: number): boolean {
    if (!timer || !due(timer, laying, dt)) return false;
    if (otherLive >= AI_CAP) {
      let oldest = -1;
      for (let i = 0; i < active; i++) {
        if (other[i] && (oldest < 0 || ages[i]! < ages[oldest]!)) oldest = i;
      }
      // A full player trail has priority over a new rival mark.
      if (oldest < 0) return false;
      markAt(oldest).set(mat); ages[oldest] = ++age; dirty = true;
      return true;
    }
    lay(mat, true);
    return true;
  }

  function draw(gfx: SkidSink, camEye?: ArrayLike<number> | null): void {
    let rebuilt = false;
    if (dirty) { rebuild(); rebuilt = true; }
    if (gfx.drawSkidBatch(verts, vertCount, rebuilt)) return;
    if (!gfx.drawMark) return;
    const ex = (camEye && camEye[0]) || 0, ez = (camEye && camEye[2]) || 0;
    const full = active >= MAX_SKID, cnt = full ? MAX_SKID : active;
    for (let i = 0; i < cnt; i++) {
      const m = full ? markAt((idx + i) % MAX_SKID) : markAt(i);
      const dx = m[12]! - ex, dz = m[14]! - ez;
      if (dx * dx + dz * dz > SKID_CULL) continue;
      gfx.drawMark(m, _SKID_W, _SKID_L);
    }
  }

  return {
    reset, stamp, stampFor, draw,
    get count() { return active; },
    get otherCount() { return otherLive; },
    verts: () => ({ verts, vertCount }),
  };
}
