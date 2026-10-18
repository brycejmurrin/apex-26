/** DriveOnboard / DriveBroadcast (src/camera/drive-*.ts): the lens FOV deltas.
 *  Parity against f1-game js/camera/drive-onboard.js and drive-broadcast.js in
 *  a VM over a mode x context grid (Object.is on every value). */
import { describe, expect, it } from "vitest";
import type { Vec3 } from "../../../src/contracts/track";
import { DriveBroadcast } from "../../../src/camera/drive-broadcast";
import type { LensCtx } from "../../../src/camera/drive-lens";
import { DriveOnboard } from "../../../src/camera/drive-onboard";
import { f1Cam, hasCam } from "./f1-cam-vm";

const MODES = ["chase", "far", "drift", "low", "reverse", "cockpit", "helmet", "hood", "visor", "tcam", "rear",
  "heli", "side", "cinematic", "overhead", "drone", "rival", "pitwall", "trackside", "tv", "bogus"];
const VALS = [-1, -0.6180339887, -0.25, 0, 1e-9, 0.1, 0.333, 0.5, 0.75, 0.99, 1];

function* ctxs(): Generator<LensCtx> {
  for (const sp of VALS) for (const yaw of [-1, -0.3, 0, 0.42, 1]) for (const brake of [0, 0.37, 1]) for (const slip of [-0.5, 0, 0.8]) yield { sp, yaw, brake, slip };
}

describe("drive lenses", () => {
  const eye: Vec3 = [0, 2, -8], tgt: Vec3 = [0, 1, 0];

  it("onboard: speed and brake live in the lens; other families return null", () => {
    const c = { sp: 1, yaw: 0, brake: 1, slip: 0 };
    expect(DriveOnboard.apply("cockpit", eye, tgt, c)).toBe(2.5);
    expect(DriveOnboard.apply("helmet", eye, tgt, c)).toBe(2.5);
    expect(DriveOnboard.apply("visor", eye, tgt, c)).toBe(1);
    expect(DriveOnboard.apply("hood", eye, tgt, c)).toBe(3.5);
    expect(DriveOnboard.apply("tcam", eye, tgt, c)).toBe(2.5);
    expect(DriveOnboard.apply("rear", eye, tgt, c)).toBe(5);
    expect(DriveOnboard.apply("chase", eye, tgt, c)).toBe(null);
    expect(DriveOnboard.apply("cockpit", eye, tgt, null)).toBe(0);
    expect([...DriveOnboard.modes]).toEqual(["cockpit", "helmet", "hood", "visor", "tcam", "rear"]);
  });

  it("broadcast: per-camera deltas, non-finite inputs read as 0", () => {
    const c = { sp: 0.5, yaw: -0.5, brake: 0, slip: 0 };
    expect(DriveBroadcast.apply("heli", eye, tgt, c)).toBe(5.5);
    expect(DriveBroadcast.apply("trackside", eye, tgt, c)).toBe(1.75);
    expect(DriveBroadcast.apply("drone", eye, tgt, c)).toBe(4);
    expect(DriveBroadcast.apply("cockpit", eye, tgt, c)).toBe(null);
    expect(DriveBroadcast.apply("heli", eye, tgt, { sp: NaN, yaw: Infinity })).toBe(0);
    expect(eye).toEqual([0, 2, -8]);
    expect(tgt).toEqual([0, 1, 0]);
  });

  it.skipIf(!hasCam)("bit-exact against f1-game drive-onboard.js / drive-broadcast.js", () => {
    type Apply = { apply(m: string, e: Vec3, t: Vec3, c: unknown): number | null; modes: string[] };
    const on = f1Cam<Apply>(["drive-onboard.js"], "DriveOnboard");
    const br = f1Cam<Apply>(["drive-broadcast.js"], "DriveBroadcast");
    expect([...DriveOnboard.modes]).toEqual([...on.modes]);
    expect([...DriveBroadcast.modes]).toEqual([...br.modes]);
    let n = 0;
    for (const c of ctxs()) for (const m of MODES) {
      const a = DriveOnboard.apply(m, eye, tgt, c), b = on.apply(m, eye, tgt, c);
      const x = DriveBroadcast.apply(m, eye, tgt, c), y = br.apply(m, eye, tgt, c);
      if (!Object.is(a, b) || !Object.is(x, y)) throw new Error(`${m} ${JSON.stringify(c)}: ${a}/${b} ${x}/${y}`);
      n++;
    }
    expect(n).toBeGreaterThan(10000);
  });
});
