/* The pit-work arrival and the RACE! drive-out. Assertions ported from f1-game
 * tests/unit/garage-arrival.test.mjs:24-163, :260-279, :423-472 (the parts that
 * test js/garage/arrival.js itself, not setup-camera.js / game.js source), plus
 * a bit-exact comparison against f1-game's own arrival.js. */
import { describe, expect, it, vi } from "vitest";
import { BAY } from "../../../src/track/core/pit";
import { GarageArrival as Arrival, type ArrivalPose, type ById } from "../../../src/garage/arrival";
import { f1Load, hasF1Garage, plain } from "./f1-garage-vm";

type Fake = Record<string, unknown> & { hidden: boolean; inert: boolean; textContent: string; focused?: boolean; value?: string; checked?: boolean; onclick?: () => void; onchange?: () => void };
function harness(reduced = false) {
  const elements = new Map<string, Fake>();
  const fake = (id: string): Fake => {
    if (!elements.has(id)) elements.set(id, { hidden: true, inert: false, textContent: "",
      classList: { toggle() {} }, setAttribute(this: Fake, k: string, v: string) { this[k] = v; }, focus(this: Fake) { this.focused = true; } });
    return elements.get(id)!;
  };
  const $ = fake as unknown as ById;
  return { $, el: fake, arrival: Arrival.create($, () => reduced) };
}
function seenThroughDoor(p: ArrivalPose): boolean {
  const [ex, , ez] = p.eye, DOOR_Z = BAY.depth / 2, HW = BAY.doorW / 2;
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  return [[2.8, 1], [2.8, -1], [-2.8, 1], [-2.8, -1]].some(([along, across]) => {
    const cx = p.x + along! * s + across! * c, cz = p.z + along! * c - across! * s;
    return Math.abs(ex + (cx - ex) * (DOOR_Z - ez) / (cz - ez)) < HW;
  });
}

describe("GarageArrival (f1-game js/garage/arrival.js)", () => {
  it("car waits out of sight until the shutter is clear, comes up the lane past the box, backs into the bay and parks", () => {
    for (const angle of ["cut", "left", "right"]) {
      const cfg = Arrival.settings({ angle });
      let prior = Infinity, stopped: ArrivalPose | null = null;
      for (let t = 0; t <= Arrival.DURATION + 0.5; t += 0.02) {
        const p = Arrival.pose(t, cfg, true);
        expect(p.z <= prior + 1e-9 && p.z >= 0).toBe(true);
        if (t < 1.8) { expect(p.z).toBe(13); expect(seenThroughDoor(p), angle).toBe(false); }
        if (p.z < 13) { expect(p.door).toBe(1); if (!stopped) stopped = Arrival.pose(t - 0.02, cfg, true); }
        expect(p.eye[0] > -5.4 && p.eye[0] < 5.4 && p.eye[2] > -6.4 && p.eye[2] < 6.4).toBe(true);
        prior = p.z;
      }
      expect(seenThroughDoor(stopped!), angle).toBe(true);
      const end = Arrival.pose(Arrival.DURATION + 0.5, cfg, true);
      expect([end.x + 0, end.z + 0, end.yaw + 0, end.active]).toEqual([0, 0, 0, false]);
      const side = angle === "left" ? 1 : -1;
      for (let k = 0.05; k < 1; k += 0.05) {
        const p = Arrival.pose(1.8 + 2.6 + 0.4 + 3.6 * k, cfg, true);
        const onStraight = Math.abs(p.x) < 1e-9 && Math.abs(p.yaw) < 1e-9 && p.z <= 8 + 1e-9;
        const onArc = Math.abs(Math.hypot(p.x - side * 5, p.z - 8) - 5) < 1e-6 && Math.abs(p.yaw - side * Math.atan2(p.z - 8, side * (side * 5 - p.x))) < 1e-6;
        expect(onStraight || onArc, `${angle} k ${k.toFixed(2)}`).toBe(true);
      }
    }
  });

  it("skip and natural completion unlock controls and preserve open shutter until exit", () => {
    for (const skip of [true, false]) {
      const { el, arrival } = harness(); arrival.start();
      expect(el("cs-inner").inert).toBe(true);
      expect(el("carsetup")["data-esc-close"]).toBe("cs-arrival-skip");
      if (skip) el("cs-arrival-skip").onclick!();
      else for (let i = 0; i < Math.ceil(Arrival.DURATION / 0.1) + 2; i++) arrival.step(0.1);
      expect(arrival.state!.z).toBe(0); expect(arrival.state!.door).toBe(1);
      expect(el("cs-inner").inert).toBe(false); expect(el("cs-arrival").hidden).toBe(true);
      expect(el("carsetup")["data-esc-close"]).toBe("cs-back");
      arrival.cancel(); expect(arrival.state).toBeNull();
      arrival.start(); expect(arrival.state!.z).toBe(13);
    }
  });

  it("reduced motion bypasses camera movement; tab gaps and invalid dt cannot skip sequence", () => {
    const reduced = harness(true); reduced.arrival.start();
    expect(reduced.arrival.state!.active).toBe(false);
    expect(reduced.el("cs-inner").inert).toBe(false);
    const { arrival } = harness(); arrival.start();
    for (const dt of [NaN, -3, Infinity]) arrival.step(dt);
    expect(arrival.state!.door).toBe(0);
    arrival.step(60); expect(arrival.state!.active).toBe(true); expect(arrival.state!.z).toBe(13);
  });

  it("saved tuner settings control arrival speed, angle, lens and disabled playback", () => {
    const { $, el } = harness();
    let saved: unknown = null;
    const read = Arrival.bindSettings($, { get: () => saved, set: (_k, value) => { saved = value; } });
    el("ga-speed").value = "2"; el("ga-speed").onchange!();
    el("ga-angle").value = "right"; el("ga-angle").onchange!();
    el("ga-fov").value = "70"; el("ga-fov").onchange!();
    const arrival = Arrival.create($, () => false, read);
    arrival.start(); expect(arrival.state!.eye[0]).toBeGreaterThan(0); expect(arrival.state!.fov).toBe(70);
    for (let i = 0; i < Math.ceil(Arrival.DURATION / 0.2) + 1; i++) arrival.step(0.1);
    expect(arrival.state!.active).toBe(false);
    el("ga-enabled").checked = false; el("ga-enabled").onchange!();
    arrival.start(); expect(arrival.state!.active).toBe(false);
    el("ga-reset").onclick!(); expect(saved).toBeNull(); expect(read().speed).toBe(1);
    arrival.start(); expect(arrival.state!.active).toBe(true);
    expect(Arrival.settings({ speed: Infinity, fov: -100, angle: "outside" }).fov).toBe(40);
    expect(Arrival.settings({ speed: Infinity }).speed).toBe(1);
    expect(Arrival.settings({ angle: "outside" }).angle).toBe("cut");
  });

  it("the default drive-out is a real shot (~10.6 s at speed 1), not the old 4x reduce cut", () => {
    expect((Arrival as Record<string, unknown>)["OUT_REDUCE_SPEED"]).toBeUndefined();
    expect(Math.round(Arrival.OUT_DURATION * 1000)).toBeGreaterThanOrEqual(7000);
    expect(Math.abs(Arrival.OUT_DURATION * 1000 / Arrival.settings(null).speed - 10600)).toBeLessThanOrEqual(400);
  });

  it("studio drive-out (poseOut): shutter opens first, then parked beat, then nose first out", () => {
    for (const angle of ["cut", "left", "right"]) {
      const cfg = Arrival.settings({ angle, fov: 58 });
      const p0 = Arrival.poseOut(0, cfg);
      expect(p0.z).toBe(0); expect(p0.door).toBe(0); expect(p0.label).toBe("OPENING GARAGE"); expect(p0.fov).toBe(58);
      expect(Arrival.poseOut(0.9, cfg).door > 0 && Arrival.poseOut(0.9, cfg).door < 1).toBe(true);
      expect(Arrival.poseOut(1.8, cfg).door).toBe(1);
      expect(Arrival.poseOut(1.8, cfg).z).toBe(0);
      expect(Arrival.poseOut(2.5, cfg).z).toBe(0);
      expect(Arrival.poseOut(3.0, cfg).z).toBeGreaterThan(0);
      let prior = -1;
      for (let t = 0; t <= Arrival.OUT_DURATION + 0.5; t += 0.02) {
        const p = Arrival.poseOut(t, cfg);
        expect(p.z).toBeGreaterThanOrEqual(prior);
        expect(p.eye[0] > -5.4 && p.eye[0] < 5.4 && p.eye[2] > -6.4 && p.eye[2] < 6.4).toBe(true);
        expect(p.aim[2]).toBeLessThanOrEqual(9);
        prior = p.z;
      }
      expect(Arrival.poseOut(Arrival.OUT_DURATION, cfg).z).toBeGreaterThan(6.4 + 5);
      expect(Arrival.poseOut(Arrival.OUT_DURATION, cfg).active).toBe(false);
    }
    expect(Arrival.poseOut(0, Arrival.settings({ angle: "right" })).eye[0] > 0 && Arrival.poseOut(0, Arrival.settings({})).eye[0] < 0).toBe(true);
  });

  it("once out of the door the car turns into the pit lane, away from the camera", () => {
    for (const [angle, side] of [["cut", 1], ["left", 1], ["right", -1]] as const) {
      const cfg = Arrival.settings({ angle });
      let px = 0, pyaw = 0;
      for (let t = 0; t <= Arrival.OUT_DURATION + 0.5; t += 0.02) {
        const p = Arrival.poseOut(t, cfg);
        if (p.z < 6.4) expect(Math.abs(p.x) < 1e-9 && Math.abs(p.yaw) < 1e-9).toBe(true);
        expect(side * p.x >= side * px - 1e-9 && side * p.yaw >= side * pyaw - 1e-9).toBe(true);
        px = p.x; pyaw = p.yaw;
      }
      const end = Arrival.poseOut(Arrival.OUT_DURATION, cfg);
      expect(side * end.yaw > 1.0 && side * end.yaw <= Math.PI / 2 + 1e-9).toBe(true);
      expect(side * end.x).toBeGreaterThan(2);
      expect(Math.sign(end.aim[0])).toBe(side);
    }
  });

  it("GARAGE ARRIVAL TUNER is an ADVANCED VISUALS tool: opens over the settings page, DONE gives it back", () => {
    vi.useFakeTimers();
    try {
      const { $, el } = harness();
      el("pmsettings").hidden = false; el("pm-panel-display").hidden = false;
      Arrival.bindSettings($, { get: () => null, set() {} });
      el("pm-garrival").onclick!();
      expect(el("garrival").hidden).toBe(false);
      expect(el("pmsettings").hidden).toBe(true);
      expect(el("pm-panel-display").hidden).toBe(true);
      expect(el("ga-close").focused).toBe(true);
      el("ga-close").onclick!();
      expect(el("garrival").hidden).toBe(true);
      expect(el("pmsettings").hidden).toBe(false);
      expect(el("pm-panel-display").hidden).toBe(false);
      vi.runAllTimers();
      expect(el("pm-garrival").focused).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("PREVIEW IN / OUT go to the preview hook; DONE mid-playback stops it instead of closing", () => {
    const { $, el } = harness(), calls: (string | null)[] = [];
    let playing = false;
    Arrival.bindSettings($, { get: () => null, set() {} }, { preview: (dir) => { calls.push(dir); if (dir) { playing = true; return true; } const was = playing; playing = false; return was; } });
    el("pm-garrival").onclick!();
    el("ga-preview-in").onclick!(); el("ga-preview-out").onclick!();
    el("ga-close").onclick!();
    expect(el("garrival").hidden).toBe(false);
    el("ga-close").onclick!();
    expect(el("garrival").hidden).toBe(true);
    expect(calls).toEqual(["in", "out", null, null]);
  });

  it("the drive-out does not stop in view: it squares into the lane, leaves at the limiter, goes behind the front wall", () => {
    for (const angle of ["cut", "left", "right"]) {
      const cfg = Arrival.settings({ angle }), at = (t: number): ArrivalPose => Arrival.poseOut(t, cfg, true);
      expect(Arrival.OUT_SETTLE).toBeLessThan(Arrival.OUT_DURATION);
      let turned = 0;
      while (Math.abs(at(turned).yaw) < Math.PI / 2 - 1e-9) turned += 0.01;
      expect(seenThroughDoor(at(turned)), angle).toBe(true);
      expect(seenThroughDoor(at(Arrival.OUT_SETTLE)), angle).toBe(false);
      let gone = turned;
      while (seenThroughDoor(at(gone))) gone += 0.01;
      expect(gone - turned).toBeGreaterThanOrEqual(1.2);
      const v = (t: number): number => Math.hypot(at(t + 0.05).x - at(t).x, at(t + 0.05).z - at(t).z) / 0.05;
      for (let t = turned; t + 0.05 <= Arrival.OUT_SETTLE + 1e-9; t += 0.05) expect(Math.abs(v(t) - v(turned))).toBeLessThan(1e-6);
      const end = at(Arrival.OUT_SETTLE);
      expect([at(Arrival.OUT_SETTLE + 30).x, at(Arrival.OUT_SETTLE + 30).z]).toEqual([end.x, end.z]);
      expect(Math.abs(end.aim[0])).toBeLessThanOrEqual(3.5 + 1e-9);
    }
  });

  it("the empty-lane hold is a slow push toward the door, not a frozen frame; calm (reduce motion) holds still", () => {
    for (const angle of ["cut", "right"]) {
      const cfg = Arrival.settings({ angle }), S = Arrival.OUT_SETTLE;
      const a = Arrival.poseOut(S, cfg, true), b = Arrival.poseOut(S + 6, cfg, false), c = Arrival.poseOut(S + 60, cfg, false);
      expect(b.eye[2] > a.eye[2] + 1 && c.eye[2] > b.eye[2]).toBe(true);
      expect(c.eye[2] < 6.4 - 3 && Math.abs(c.eye[0]) < 5.4).toBe(true);
      const step = Math.hypot(...[0, 1, 2].map((i) => Arrival.poseOut(S + 0.02, cfg, true).eye[i]! - a.eye[i]!));
      expect(step).toBeLessThan(1e-9);
      expect(Arrival.poseOut(S + 60, cfg, true).eye).toEqual(a.eye);
    }
  });

  it("handheld sway: centimetres, both shots, and off when calm", () => {
    const cfg = Arrival.DEFAULT;
    for (const fn of [Arrival.pose, Arrival.poseOut]) {
      let max = 0;
      for (let t = 0; t < 8; t += 0.05) {
        const live = fn(t, cfg, false), calm = fn(t, cfg, true);
        max = Math.max(max, Math.hypot(live.eye[0] - calm.eye[0], live.eye[1] - calm.eye[1]));
        expect(live.eye[2]).toBe(calm.eye[2]);
        expect(Math.abs(live.aim[0] - calm.aim[0]) < 0.05 && Math.abs(live.aim[1] - calm.aim[1]) < 0.05).toBe(true);
      }
      expect(max > 0.01 && max < 0.05).toBe(true);
    }
  });

  it("the angle map lights the chosen eye(s)", () => {
    expect((Arrival.angleMap("cut").match(/#e10600/g) || []).length).toBe(2);
    expect((Arrival.angleMap("left").match(/#e10600/g) || []).length).toBe(1);
    expect(Arrival.angleMap("right")).not.toContain("<text");
  });
});

describe.skipIf(!hasF1Garage)("GarageArrival matches f1-game's arrival.js bit for bit", () => {
  type Api = { pose(t: number, c?: unknown, calm?: boolean): unknown; poseOut(t: number, c?: unknown, calm?: boolean): unknown; angleMap(a: string): string; settings(v: unknown): unknown; DURATION: number; OUT_DURATION: number; OUT_SETTLE: number; DEFAULT: unknown };
  const vmApi = (): Api => f1Load(["js/garage/arrival.js"])("GarageArrival") as Api;
  const exact = (a: unknown, b: unknown, at: string): void => {
    if (typeof a === "number" || typeof b === "number") { if (!Object.is(a, b)) throw new Error(at + ": " + String(a) + " !== " + String(b)); return; }
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") { expect(a, at).toBe(b); return; }
    expect(Object.keys(a), at).toEqual(Object.keys(b));
    for (const k of Object.keys(a)) exact((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], at + "." + k);
  };

  it("constants", () => {
    const A = vmApi();
    for (const k of ["DURATION", "OUT_DURATION", "OUT_SETTLE"] as const) exact(A[k], Arrival[k], k);
    expect(Arrival.DEFAULT).toEqual(plain(A.DEFAULT));
  });

  it("settings over good and damaged values", () => {
    const A = vmApi();
    const vals: unknown[] = [null, undefined, 3, "x", {}, { enabled: false }, { enabled: 0 }, { speed: 0.1 }, { speed: 3 }, { speed: "2" }, { speed: NaN }, { fov: 39 }, { fov: 80 }, { fov: 61.5 },
      { angle: "left" }, { angle: "right" }, { angle: "cut" }, { angle: "LEFT" }, { angle: 1 }, { enabled: true, speed: 1.25, angle: "right", fov: 70 }];
    for (const v of vals) exact(plain(A.settings(v)), Arrival.settings(v), JSON.stringify(v));
  });

  it("pose and poseOut over the whole sequence, every angle, calm and handheld", () => {
    const A = vmApi();
    for (const angle of ["cut", "left", "right"] as const) for (const fov of [40, 54, 75]) {
      const c = { enabled: true, speed: 1, angle, fov } as const;
      for (const calm of [false, true]) {
        for (let i = -5; i <= 1400; i++) {
          const t = i * 0.0137;
          exact(A.pose(t, c, calm), Arrival.pose(t, c, calm), `pose ${angle} ${t} ${calm}`);
          exact(A.poseOut(t, c, calm), Arrival.poseOut(t, c, calm), `poseOut ${angle} ${t} ${calm}`);
        }
        for (const t of [NaN, Infinity, -Infinity, 1e6]) {
          exact(A.pose(t, c, calm), Arrival.pose(t, c, calm), `pose ${t}`);
          exact(A.poseOut(t, c, calm), Arrival.poseOut(t, c, calm), `poseOut ${t}`);
        }
      }
    }
    exact(A.pose(2), Arrival.pose(2), "default config");
    exact(A.poseOut(4), Arrival.poseOut(4), "default config out");
  });

  it("angleMap is the same SVG", () => {
    const A = vmApi();
    for (const a of ["cut", "left", "right", "other"]) expect(Arrival.angleMap(a)).toBe(A.angleMap(a));
  });
});
