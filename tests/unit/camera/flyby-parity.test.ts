/**
 * The flyby camera port (src/camera/flyby-seq.ts, flyby-sight.ts, cam-avoid.ts,
 * trackside.ts) against f1-game's own js/camera modules, bit for bit (Object.is
 * on every number), on four circuits — a park circuit (monza), a street circuit
 * (monaco), a forest circuit (spa) and a classic (mont_tremblant) — over a
 * scripted time sweep of the whole flyby.
 *
 * Both sides read the SAME built track (f1-game's build in a VM, with its props
 * registry): see f1-flyby-vm.ts. Skipped where f1-game is absent.
 */
import { describe, expect, it } from "vitest";
import { createCamAvoid } from "../../../src/camera/cam-avoid";
import { createFlybySeq, DEFAULT, type FlybyShot, type Vec3 } from "../../../src/camera/flyby-seq";
import * as Sight from "../../../src/camera/flyby-sight";
import { createTracksideCams } from "../../../src/camera/trackside";
import { bitDiff, f1Cam, haveF1, type F1Cam } from "./f1-flyby-vm";

const CIRCUITS = ["monza", "monaco", "spa", "mont_tremblant"];
const SAMPLES = 96;

type Fn = (...a: unknown[]) => unknown;
const call = (o: Record<string, unknown>, name: string, ...a: unknown[]): unknown => (o[name] as Fn)(...a);
/** Re-home a VM-realm value as plain data (numbers keep their bits through JSON? no: copy by walk). */
function plain(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
  if (Array.isArray(v)) return v.map(plain);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x !== "function") out[k] = plain(x);
  }
  return out;
}
const frameOf = (v: { eye: Vec3; tgt: Vec3; fov: number; index: number; id: string; cut: boolean; lift: number; corner: number }) =>
  ({ eye: [...v.eye], tgt: [...v.tgt], fov: v.fov, index: v.index, id: v.id, cut: v.cut, lift: v.lift, corner: v.corner });

function portFor(f1: F1Cam) {
  return createFlybySeq({ corners: (def) => f1.TrackMaps.corners(def) });
}

describe.skipIf(!haveF1)("flyby camera port vs f1-game (same track, bit for bit)", () => {
  const f1 = haveF1 ? f1Cam() : (null as unknown as F1Cam);

  it.each(CIRCUITS)("%s: solve() over the whole DEFAULT flyby", (id) => {
    const track = f1.track(id);
    const F = f1.F as unknown as Record<string, unknown>;
    const P = portFor(f1);
    call(F, "setPlayerSlot", 11, 22); call(F, "setDuration", 20000); call(F, "reset");
    P.setPlayerSlot(11, 22); P.setDuration(20000); P.reset();
    const diffs: string[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const u = i / SAMPLES;
      const want = frameOf(call(F, "solve", track, u) as Parameters<typeof frameOf>[0]);
      const got = frameOf(P.solve(track, u));
      diffs.push(...bitDiff(got, want, `u=${u.toFixed(4)}`));
      if (diffs.length > 6) break;
    }
    expect(diffs).toEqual([]);
    // The plans themselves (eyes, looks, lift profile, squeeze, framing pick).
    const listV = call(F, "bindCorners", track, F["DEFAULT"]) as FlybyShot[];
    const listP = P.bindCorners(track, DEFAULT);
    expect(plain(listP)).toEqual(plain(listV));
    let total = 0; for (const s of listP) total += s.dur || 0;
    for (let k = 0; k < listP.length; k++) {
      const shV = call(F, "landmarkFallback", track, listV[k]) as FlybyShot, shP = P.landmarkFallback(track, listP[k]!);
      const a = plain(call(F, "planShot", track, shV, (shV.dur || 1) / total)) as Record<string, unknown>;
      const b = plain(P.planShot(track, shP, (shP.dur || 1) / total)) as Record<string, unknown>;
      expect(bitDiff(b, a, `${listP[k]!.id}.plan`)).toEqual([]);
    }
  }, 600_000);

  it.each(CIRCUITS)("%s: landmarks, bounds, corners, sides, roles and the pose inverse", (id) => {
    const track = f1.track(id);
    const F = f1.F as unknown as Record<string, unknown>;
    const P = portFor(f1);
    expect(bitDiff(plain(P.bounds(track)), plain(call(F, "bounds", track)))).toEqual([]);
    expect(bitDiff(plain(P.landmarks(track)), plain(call(F, "landmarks", track)))).toEqual([]);
    expect(P.blockers(track).length).toBe((call(F, "blockers", track) as unknown[]).length);
    expect(P.treeBlockers(track).length).toBe((call(F, "treeBlockers", track) as unknown[]).length);
    const n = P.cornerList(track).length;
    expect(n).toBeGreaterThan(3);
    const roles: (number | string)[] = ["first", "mid", "late", "slowest", "fastest", "lore"];
    for (let i = 1; i <= n; i++) roles.push(i);
    for (const r of roles) {
      expect(Object.is(P.cornerS(track, r), call(F, "cornerS", track, r)), `cornerS ${r}`).toBe(true);
      expect(P.cornerSide(track, r), `cornerSide ${r}`).toBe(call(F, "cornerSide", track, r));
      expect(bitDiff(P.cornerTurn(track, P.cornerS(track, r)), plain(call(F, "cornerTurn", track, P.cornerS(track, r))))).toEqual([]);
    }
    for (const r of P.landmarks(track)) expect(Object.is(P.lmBase(track, r), call(F, "lmBase", track, r))).toBe(true);
    // poseFromWorld / shotFromView / posePoint / anchorS on a ring of points.
    const out: Vec3 = [0, 0, 0];
    const smp = { p: [0, 0, 0] as Vec3, t: [0, 0, 0] as Vec3, r: [0, 0, 0] as Vec3, hw: 10 };
    const T = f1.Tracks as unknown as Record<string, unknown>;
    for (let i = 0; i < 24; i++) {
      const s = (i + 0.37) / 24 * track.total, lat = ((i % 5) - 2) * 9;
      call(T, "sample", track, s, smp);
      const p: Vec3 = [smp.p[0] + smp.r[0] * lat, smp.p[1] + 3 + (i % 4) * 5, smp.p[2] + smp.r[2] * lat];
      for (const opts of [undefined, { at: "centre" }, { at: "landmark" }, { at: "start" }, { at: "corner" }]) {
        expect(bitDiff(plain(P.poseFromWorld(track, p, opts)), plain(call(F, "poseFromWorld", track, p, opts))), `poseFromWorld ${i}`).toEqual([]);
      }
      const tgt: Vec3 = [p[0] + 30, p[1] - 2, p[2] - 10];
      expect(bitDiff(plain(P.shotFromView(track, p, tgt, 47)), plain(call(F, "shotFromView", track, p, tgt, 47)))).toEqual([]);
      expect(bitDiff(P.floorEye(track, [...p] as Vec3), plain(call(F, "floorEye", track, [...p])))).toEqual([]);
      expect(bitDiff(P.clearEye(track, [p[0], p[1] + 10, p[2]]), plain(call(F, "clearEye", track, [p[0], p[1] + 10, p[2]])))).toEqual([]);
      expect(Object.is(P.groundAt(track, p[0], p[2], p[1]), call(F, "groundAt", track, p[0], p[2], p[1]))).toBe(true);
    }
    for (const shot of DEFAULT) for (const pose of [...shot.eye, ...shot.look]) {
      expect(bitDiff(P.posePoint(track, pose, out).slice(), plain(call(F, "posePoint", track, pose, [0, 0, 0])))).toEqual([]);
      expect(Object.is(P.anchorS(track, pose), call(F, "anchorS", track, pose))).toBe(true);
    }
  }, 600_000);

  it("vary + bindCorners: seeded variants bind and play identically (monza)", () => {
    const track = f1.track("monza");
    const F = f1.F as unknown as Record<string, unknown>;
    const P = portFor(f1);
    call(F, "setPlayerSlot", 11, 22); P.setPlayerSlot(11, 22);
    for (const seed of [0, 3, 7, 11]) {
      const vV = call(F, "vary", F["DEFAULT"], seed) as FlybyShot[];
      const vP = P.vary(DEFAULT, seed);
      expect(plain(vP)).toEqual(plain(vV));
      expect(plain(P.bindCorners(track, vP))).toEqual(plain(call(F, "bindCorners", track, vV)));
      call(F, "reset"); P.reset();
      for (let i = 0; i <= 24; i++) {
        const u = i / 24;
        const want = frameOf(call(F, "solve", track, u, vV) as Parameters<typeof frameOf>[0]);
        expect(bitDiff(frameOf(P.solve(track, u, vP)), want, `seed ${seed} u=${u}`)).toEqual([]);
      }
    }
  }, 600_000);

  it.each(["monza", "monaco"])("%s: FlybySight boxes, transmit, nearThirds, mix and frame", (id) => {
    const track = f1.track(id);
    const S = f1.S as unknown as Record<string, unknown>;
    expect(bitDiff(plain(Sight.propBoxes(track)), plain(call(S, "propBoxes", track)))).toEqual([]);
    expect(bitDiff(plain(Sight.spanBoxes(track)), plain(call(S, "spanBoxes", track)))).toEqual([]);
    const sc = Sight.sceneOf(track), scV = call(S, "sceneOf", track) as { boxes: unknown[]; maxT: number };
    expect(sc.boxes.length).toBe(scV.boxes.length);
    expect(Object.is(sc.maxT, scV.maxT)).toBe(true);
    const P = portFor(f1);
    const b = P.bounds(track);
    const pts = b.pts;
    for (let i = 0; i < pts.length; i += 7) {
      const eye: Vec3 = [pts[i]![0] + 25, pts[i]![1] + 6, pts[i]![2] - 12];
      const tgt = pts[(i + 3) % pts.length]!;
      expect(bitDiff(Sight.transmit(track, eye, tgt), plain(call(S, "transmit", track, eye, tgt)))).toEqual([]);
      const cam = Sight.camera(eye, tgt, 42, 16 / 9), camV = call(S, "camera", eye, tgt, 42, 16 / 9);
      expect(bitDiff(Sight.nearThirds(track, cam, null), plain(call(S, "nearThirds", track, camV, null)))).toEqual([]);
      expect(bitDiff(Sight.mix(track, cam, i % 2 === 1), plain(call(S, "mix", track, camV, i % 2 === 1)))).toEqual([]);
      const subj = { pts: pts.slice(0, 30), strip: 3 };
      expect(bitDiff(plain(Sight.frame(track, eye, tgt, 42, subj, false, false, false)),
        plain(call(S, "frame", track, eye, tgt, 42, subj, false, false, false)))).toEqual([]);
      const lap = { pts: pts.slice(), lap: true };
      expect(bitDiff(plain(Sight.frame(track, eye, tgt, 40, lap, true, true, true)),
        plain(call(S, "frame", track, eye, tgt, 40, lap, true, true, true)))).toEqual([]);
    }
  }, 600_000);

  it.each(["monza", "monaco"])("%s: CamAvoid.freeEye and TracksideCams match over a lap", (id) => {
    const track = f1.track(id);
    const P = portFor(f1);
    const A = createCamAvoid({ flyby: P });
    const TS = createTracksideCams({ flyby: P, avoid: A });
    const AV = f1.A as unknown as Record<string, unknown>, TV = f1.TS as unknown as Record<string, unknown>;
    const T = f1.Tracks as unknown as Record<string, unknown>;
    expect(bitDiff(plain(TS.build(track)), plain(call(TV, "build", track)))).toEqual([]);
    const smp = { p: [0, 0, 0] as Vec3, t: [0, 0, 0] as Vec3, r: [0, 0, 0] as Vec3, hw: 10 };
    for (let s = 0; s < track.total; s += 17) {
      call(T, "sample", track, s, smp);
      for (const lat of [-26, -12, 9, 22]) {
        const eye: Vec3 = [smp.p[0] + smp.r[0] * lat, smp.p[1] + 4, smp.p[2] + smp.r[2] * lat];
        const frame = { p: [...smp.p] as Vec3, r: [...smp.r] as Vec3, hw: smp.hw };
        expect(A.roadClear(track, eye, 2)).toBe(call(AV, "roadClear", track, eye, 2));
        expect(bitDiff(A.freeEye(track, [...eye] as Vec3, frame), plain(call(AV, "freeEye", track, [...eye], frame))), `s=${s} lat=${lat}`).toEqual([]);
      }
      const extra = { carPos: [smp.p[0], smp.p[2]] };
      expect(bitDiff(plain(TS.pose(track, s, 0, extra)), plain(call(TV, "pose", track, s, 0, extra))), `pose s=${s}`).toEqual([]);
    }
  }, 600_000);
});

