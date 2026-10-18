/**
 * XR culls with ONE frustum that holds both eyes (f1-game R3-RENDER-3). Ported from
 * f1-game tests/unit/xr-cull-union.test.mjs: XrBoot.applyEyes writes frame.viewProj as
 * the union of the drawn eyes (src/xr/rig.ts unionViewProjTo); every point and box an
 * eye sees survives the cull, the union is not much looser than the two eyes, a mono /
 * one-viewport frame keeps eye 0 exactly, and flat frames are untouched. The frustum
 * planes are f1-game js/render/shared/frustum.js's (tests/unit/xr-harness.ts).
 *
 * three's XRManager computes its own union for culling on the apex-26 render path;
 * this guards the per-eye consumers of applyEyes.
 */
import { describe, expect, it } from "vitest";
import { XrBoot, type XrFrameMatrices } from "../../src/xr/boot";
import { composeEye, invertRigidTo, makeEyeFrame, type EyeFrame, type XrViewport } from "../../src/xr/rig";
import type { XrSession } from "../../src/xr/session";
import { aabbInFrustum, extractPlanes, MemStorage, type Planes } from "./xr-harness";

/** An XRView.projectionMatrix: asymmetric, GL clip space. */
function proj(lDeg: number, rDeg: number, uDeg: number, dDeg: number, n = 0.1, f = 1000): Float32Array {
  const t = (d: number): number => Math.tan((d * Math.PI) / 180) * n;
  const l = -t(lDeg), r = t(rDeg), top = t(uDeg), b = -t(dDeg);
  const m = new Float32Array(16);
  m[0] = (2 * n) / (r - l); m[5] = (2 * n) / (top - b); m[8] = (r + l) / (r - l); m[9] = (top + b) / (top - b);
  m[10] = -(f + n) / (f - n); m[11] = -1; m[14] = (-2 * f * n) / (f - n);
  return m;
}

/** An XRView pose: head yaw/pitch, eye offset along the head's right, an outward cant. */
function pose(xOff: number, yawDeg = 0, pitchDeg = 0, cantDeg = 0): Float32Array {
  const y = ((yawDeg + cantDeg) * Math.PI) / 180, p = (pitchDeg * Math.PI) / 180;
  const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p);
  const hy = (yawDeg * Math.PI) / 180;
  return new Float32Array([cy, 0, -sy, 0, sy * sp, cp, cy * sp, 0, sy * cp, -sp, cy * cp, 0, Math.cos(hy) * xOff, 1.2, -Math.sin(hy) * xOff, 1]);
}

interface ViewSpec { pose: Float32Array; proj: Float32Array; viewport?: XrViewport }

function eyesFor(views: ViewSpec[]): EyeFrame[] {
  const anchor = { eye: [10, 2, 30], fwd: [0.6, 0, 0.8], up: [0, 1, 0] };
  return views.map((v) => {
    const bag = makeEyeFrame();
    bag.viewport = v.viewport ?? { x: 0, y: 0, width: 960, height: 1000 };
    composeEye(anchor, invertRigidTo(new Float32Array(16), v.pose), v.proj, bag);
    return bag;
  });
}

/** XrBoot over a stand-in session that is presenting and hands back `eyes`. */
function load(): { boot: XrBoot; ctx: { eyes: EyeFrame[] | null; presenting: boolean } } {
  const ctx = { eyes: null as EyeFrame[] | null, presenting: true };
  const session = {
    isPresenting: () => ctx.presenting,
    setAnchor() {},
    getAnchor: () => ({ eye: [0, 0, 0], fwd: [0, 0, 1], up: [0, 1, 0] }),
    eyeFrames: () => ctx.eyes,
  } as unknown as XrSession;
  return { boot: new XrBoot({ session, storage: () => new MemStorage() }), ctx };
}

const inside = (pl: Planes, p: number[]): boolean =>
  pl.every((q) => (q[0] as number) * (p[0] as number) + (q[1] as number) * (p[1] as number) + (q[2] as number) * (p[2] as number) + (q[3] as number) >= 0);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

function check(h: ReturnType<typeof load>, label: string, views: ViewSpec[]) {
  h.ctx.eyes = eyesFor(views);
  const frame: XrFrameMatrices = { viewProj: new Float32Array(16) };
  expect(h.boot.applyEyes(frame, [0, 0, 0], [0, 0, 1], [0, 1, 0]), label).toBeTruthy();
  const pc = extractPlanes(frame.viewProj as Float32Array), pe = h.ctx.eyes.map((e) => extractPlanes(e.viewProj));
  const r = rng(7);
  let seen = 0, missed = 0, cullOnly = 0, boxMiss = 0;
  for (let i = 0; i < 40000; i++) {
    const c = [10 + (r() - 0.5) * 1200, 2 + (r() - 0.3) * 200, 30 + (r() - 0.5) * 1200];
    const hh = r() * 12;
    const mn = [(c[0] as number) - hh, (c[1] as number) - hh, (c[2] as number) - hh];
    const mx = [(c[0] as number) + hh, (c[1] as number) + hh, (c[2] as number) + hh];
    const eyeSees = pe.some((pl) => inside(pl, c));
    if (eyeSees) { seen++; if (!inside(pc, c)) missed++; } else if (inside(pc, c)) cullOnly++;
    const pts = [c];
    for (let k = 0; k < 8; k++) pts.push([k & 1 ? (mx[0] as number) : (mn[0] as number), k & 2 ? (mx[1] as number) : (mn[1] as number), k & 4 ? (mx[2] as number) : (mn[2] as number)]);
    if (pts.some((p) => pe.some((pl) => inside(pl, p))) && !aabbInFrustum(pc, mn, mx)) boxMiss++;
  }
  expect(seen, label + ": points in view").toBeGreaterThan(2000);
  expect(missed, label + ": points an eye sees that the cull drops").toBe(0);
  expect(boxMiss, label + ": boxes an eye sees that the cull drops").toBe(0);
  return { frame, seen, missed, cullOnly };
}

const QUEST = { L: proj(52, 42, 42, 50), R: proj(42, 52, 42, 50) };

describe("xr cull union (xr-cull-union.test.mjs)", () => {
  it("a Quest-class asymmetric pair: the cull keeps everything the RIGHT eye sees, and stays tight", () => {
    const h = load();
    const r = check(h, "quest", [{ pose: pose(-0.0315), proj: QUEST.L }, { pose: pose(0.0315), proj: QUEST.R }]);
    expect(r.cullOnly / r.seen).toBeLessThan(0.02);
    const e0 = (h.ctx.eyes as EyeFrame[])[0] as EyeFrame;
    expect(r.frame.viewProj).not.toBe(e0.viewProj);
    expect(r.frame.view).toBe(e0.view);
    expect(r.frame.proj).toBe(e0.proj);
  });

  it("head turned and pitched, and canted displays: still nothing an eye sees is culled", () => {
    const h = load();
    check(h, "yaw/pitch", [{ pose: pose(-0.032, 35, -12), proj: QUEST.L }, { pose: pose(0.032, 35, -12), proj: QUEST.R }]);
    check(h, "canted", [{ pose: pose(-0.032, 0, 0, 10), proj: proj(60, 35, 45, 45) }, { pose: pose(0.032, 0, 0, -10), proj: proj(35, 60, 45, 45) }]);
    check(h, "uneven up/down", [{ pose: pose(-0.03), proj: proj(50, 40, 38, 52) }, { pose: pose(0.03), proj: proj(40, 50, 44, 46) }]);
  });

  it("one drawn eye (a zero-width right view) keeps eye 0's matrix exactly; flat frames are untouched", () => {
    const h = load();
    h.ctx.eyes = eyesFor([{ pose: pose(0), proj: QUEST.L }, { pose: pose(0), proj: QUEST.R, viewport: { x: 0, y: 0, width: 0, height: 0 } }]);
    const frame: XrFrameMatrices = { viewProj: null };
    h.boot.applyEyes(frame, [0, 0, 0], [0, 0, 1], [0, 1, 0]);
    expect(frame.viewProj).toBe((h.ctx.eyes[0] as EyeFrame).viewProj);
    h.ctx.presenting = false;
    const flatVP = new Float32Array(16), flat: XrFrameMatrices = { viewProj: flatVP };
    expect(h.boot.applyEyes(flat, [0, 0, 0], [0, 0, 1], [0, 1, 0])).toBeNull();
    expect(flat.viewProj).toBe(flatVP);
  });

  it("a non-perspective eye falls back to eye 0 rather than culling with a broken frustum", () => {
    const h = load();
    const ortho = new Float32Array(16);
    ortho[0] = ortho[5] = 0.01; ortho[10] = -0.001; ortho[15] = 1;
    h.ctx.eyes = eyesFor([{ pose: pose(-0.03), proj: QUEST.L }, { pose: pose(0.03), proj: ortho }]);
    const frame: XrFrameMatrices = { viewProj: null };
    h.boot.applyEyes(frame, [0, 0, 0], [0, 0, 1], [0, 1, 0]);
    expect(frame.viewProj).toBe((h.ctx.eyes[0] as EyeFrame).viewProj);
  });
});
