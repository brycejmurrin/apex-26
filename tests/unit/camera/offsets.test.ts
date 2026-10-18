/** CamTune (src/camera/offsets.ts). Assertions ported from f1-game
 *  tests/unit/camera-defaults.test.mjs (the CamTune tests) and
 *  cam-comfort.test.mjs:157-214 (track/car scopes); parity against f1-game
 *  js/camera/offsets.js in a VM: `apply` poses and FOVs with Object.is, and the
 *  export/share code byte for byte. */
import { describe, expect, it } from "vitest";
import type { Vec3 } from "../../../src/contracts/track";
import { CAM_TUNE_DEFS, createCamTune, type CamTune } from "../../../src/camera/offsets";
import { f1Cam, hasCam, mapStore } from "./f1-cam-vm";

const TEAMS = [{ id: "mclaren" }, { id: "ferrari" }];
function make(disk?: ReturnType<typeof mapStore>, modeIds?: () => readonly string[]): { C: CamTune; store: ReturnType<typeof mapStore> } {
  const store = disk ?? mapStore();
  return { C: createCamTune({ store, teamId: (i) => TEAMS[i]?.id ?? null, ...(modeIds ? { modeIds } : {}) }), store };
}
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("CamTune", () => {
  it("CORNER LEAD's registry default is the shipped lead (0.54), so 0 is storable", () => {
    const { C } = make();
    const shipped = 0.54;   // CHASE_CORNER_LEAD_DEFAULT, src/camera/chase.ts / vantage.js:178
    expect(CAM_TUNE_DEFS.find((d) => d.id === "cornerLead")?.def).toBe(shipped);
    expect(C.cornerLead("chase")).toBe(null);
    expect(C.values("chase")["cornerLead"]).toBe(shipped);
    C.set("chase", "cornerLead", 0);
    expect(C.stored("chase", "cornerLead")).toBe(true);
    expect(C.cornerLead("chase")).toBe(0);
    C.set("chase", "cornerLead", shipped);
    expect(C.cornerLead("chase")).toBe(shipped);
    C.reset("chase");
    expect(C.stored("chase", "cornerLead")).toBe(false);
    expect(C.cornerLead("chase")).toBe(null);
    C.set("cockpit", "cornerLead", 1);
    expect(C.cornerLead("cockpit")).toBe(null);
  });

  it("tunes HELMET as its own camera, apart from COCKPIT", () => {
    const { C } = make();
    C.set("helmet", "height", 0.5);
    expect(C.getModeOnly("helmet", "height")).toBe(0.5);
    expect(C.stored("cockpit", "height")).toBe(false);
    const eye: Vec3 = [0, 1, 0], tgt: Vec3 = [0, 1, 30];
    C.apply("helmet", eye, tgt, 64);
    expect(Math.abs(eye[1] - 1.5)).toBeLessThan(1e-9);
    const ce: Vec3 = [0, 1, 0];
    C.apply("cockpit", ce, [0, 1, 30], 64);
    expect(ce[1]).toBe(1);
  });

  it("CORNER HANG ships at 1 and 0 stays stored", () => {
    const { C } = make();
    const def = CAM_TUNE_DEFS.find((d) => d.id === "cornerHang");
    expect(def?.def).toBe(1);
    expect(def?.modes).toContain("chase");
    expect(def?.modes).toContain("heli");
    expect(def?.modes).toContain("drone");
    expect(def?.modes).not.toContain("far");
    expect(def?.modes).not.toContain("pitwall");
    expect(C.cornerHang("chase")).toBe(null);
    expect(C.values("chase")["cornerHang"]).toBe(1);
    C.set("chase", "cornerHang", 0);
    expect(C.stored("chase", "cornerHang")).toBe(true);
    expect(C.cornerHang("chase")).toBe(0);
    C.set("chase", "cornerHang", 1);
    expect(C.cornerHang("chase")).toBe(1);
    C.reset("chase");
    expect(C.stored("chase", "cornerHang")).toBe(false);
    expect(C.cornerHang("cockpit")).toBe(null);
  });

  it("the six geometric knobs stay deltas defaulting to 0", () => {
    for (const id of ["height", "dist", "side", "pitch", "yaw", "fov"]) expect(CAM_TUNE_DEFS.find((k) => k.id === id)?.def).toBe(0);
  });

  it("exports edits as a pack and APXC1 share code and imports them back; legacy snippets; clamping", () => {
    const { C } = make();
    C.set("chase", "dist", 2.5);
    C.setGlobal("fov", 4);
    C.comfortSet("bob", 0.3);
    const pack = C.exportPack();
    expect(pack.v).toBe(1);
    expect(pack.modes?.["chase"]?.["dist"]).toBe(2.5);
    expect(pack.global?.["fov"]).toBe(4);
    expect(pack.comfort?.["bob"]).toBe(0.3);
    const share = C.encodeShare(pack);
    expect(share).toMatch(/^APXC1\./);
    C.resetAll();
    expect(Object.keys(C.exportEdits()).length).toBe(0);
    expect(C.importText(share).ok).toBe(true);
    expect(C.getModeOnly("chase", "dist")).toBe(2.5);
    expect(C.getGlobal("fov")).toBe(4);
    expect(C.bob()).toBe(0.3);

    C.resetAll();
    expect(C.importText('window.CameraEdits = {\n  "hood": {"height": 0.5}\n};').ok).toBe(true);
    expect(C.getModeOnly("hood", "height")).toBe(0.5);

    C.resetAll();
    C.importPack({ v: 1, modes: { chase: { dist: 999, height: "nope" } }, comfort: { bob: -2 } });
    expect(C.getModeOnly("chase", "dist")).toBe(24);
    expect(C.stored("chase", "height")).toBe(false);
    expect(C.bob()).toBe(0);
  });

  it("the whole COPY VALUES block imports back (APXC1 token found anywhere)", () => {
    const { C: A } = make();
    A.set("chase", "dist", 2.5);
    A.set("hood", "height", 0.4);
    A.setGlobal("fov", 4);
    A.comfortSet("bob", 0.3);
    const pack = A.exportPack();
    const block = [
      "window.CameraEdits = {",
      "  // THIS MODE — CHASE  (1 tuned)",
      '  "chase": ' + JSON.stringify(pack.modes?.["chase"]) + ",",
      "  // EVERY OTHER TUNED MODE — 1 mode",
      '  "hood": ' + JSON.stringify(pack.modes?.["hood"]),
      "};",
      "",
      "// Pack (JSON) — paste into IMPORT, or use the share code below",
      JSON.stringify(pack),
      "",
      "// Share code",
      A.encodeShare(pack),
    ].join("\n");
    const dec = A.decodeShare(block);
    expect(dec.ok && dec.kind).toBe("share");
    const { C: B } = make();
    expect(B.importText(block).ok).toBe(true);
    expect(B.getModeOnly("chase", "dist")).toBe(2.5);
    expect(B.getModeOnly("hood", "height")).toBe(0.4);
    expect(B.getGlobal("fov")).toBe(4);
    expect(B.bob()).toBe(0.3);
    const code = A.encodeShare(pack);
    expect(A.decodeShare("  " + code + "  \n").ok).toBe(true);
    const tail = A.decodeShare(code + "\n// thanks!");
    expect(tail.ok && (tail.pack as { modes: { chase: { dist: number } } }).modes.chase.dist).toBe(2.5);
    expect(A.decodeShare("Share code: " + code).ok).toBe(true);
    expect(A.decodeShare("window.CameraEdits = {").ok).toBe(false);
  });

  it("a modes-only import keeps the global baseline and COMFORT knobs; a pack is authoritative", () => {
    const { C } = make();
    C.setGlobal("fov", 6);
    C.comfortSet("bob", 0.3);
    C.comfortSet("fovBias", 3);
    C.set("chase", "dist", 2);
    expect(C.importText('window.CameraEdits = {\n  "hood": {"height": 0.5}\n};').ok).toBe(true);
    expect(C.getModeOnly("hood", "height")).toBe(0.5);
    expect(C.stored("chase", "dist")).toBe(false);
    expect(C.getGlobal("fov")).toBe(6);
    expect(C.bob()).toBe(0.3);
    expect(C.fovBias()).toBe(3);
    C.importPack({ v: 1, modes: { chase: { dist: 1 } } });
    expect(C.getGlobal("fov")).toBe(0);
    expect(C.bob()).toBe(1);
  });

  it("persist(which) writes only the named store; keys are f1-game's names", () => {
    const store = mapStore();
    const writes: string[] = [];
    const set = store.set;
    store.set = (k, v) => { writes.push(k); return set(k, plain(v)); };
    const { C } = make(store);
    C.set("chase", "dist", 2); C.setGlobal("fov", 5); C.comfortSet("bob", 0.5);
    writes.length = 0; C.persist("modes");
    expect(writes).toEqual([C.KEY]);
    expect(C.KEY).toBe("camTune");
    writes.length = 0; C.persist("global");
    expect(writes).toEqual([C.KEY_GLOBAL]);
    writes.length = 0; C.persist("comfort");
    expect(writes).toEqual([C.KEY_COMFORT]);
    expect((store.disk.get(C.KEY_COMFORT) as { bob: number }).bob).toBe(0.5);
    writes.length = 0; C.persist();
    expect(writes.slice().sort()).toEqual([C.KEY, C.KEY_COMFORT, C.KEY_GLOBAL].sort());
  });

  it("comfort knobs are independent of reduce-motion and default to shipped", () => {
    const { C } = make();
    for (const d of C.COMFORT_DEFS) expect(C.comfortGet(d.id)).toBe(d.def);
    expect(C.shakeOffset(1, true)).toBe(0);
    expect(C.shakeOffset(1, false)).toBe(0.9);
    C.comfortSet("bob", 0.5);
    expect(C.shakeOffset(1, false)).toBe(0.45);
    expect(C.buzzAmp(1, false, true, 1)).toBe(0);
    expect(C.buzzAmp(1, false, false, 1)).toBeGreaterThan(0);
    expect(C.rollTarget(0.1, 0, 0, true)).toBe(0);
    C.comfortSet("rollLean", 0.5);
    expect(C.rollTarget(0.2, 0, 0, false)).toBe(0.1);
  });

  it("global baseline layers under per-mode; copyFrom, applyToAllModes and presets work", () => {
    const { C } = make(undefined, () => ["chase", "far", "hood", "tcam"]);
    C.setGlobal("fov", 6);
    expect(C.values("chase")["fov"]).toBe(6);
    C.set("chase", "fov", -2);
    expect(C.values("chase")["fov"]).toBe(-2);
    expect(C.values("hood")["fov"]).toBe(6);
    C.set("hood", "height", 0.4);
    C.copyFrom("hood", "tcam");
    expect(C.getModeOnly("tcam", "height")).toBe(0.4);
    expect(C.applyToAllModes("hood")).toBe(3);
    expect(C.getModeOnly("far", "height")).toBe(0.4);
    expect(C.applyPreset("flat")).toBe(true);
    expect(C.cornerLead("chase")).toBe(0);
    expect(C.applyPreset("calm")).toBe(true);
    expect(C.bob()).toBe(0.2);
    expect(C.applyPreset("stock")).toBe(true);
    expect(C.count("chase")).toBe(0);
    expect(C.countGlobal()).toBe(0);
    expect(C.bob()).toBe(1);
    expect(C.applyPreset("toString")).toBe(false);
  });

  it("explicit camera defaults override global values through export/load until reset", () => {
    const disk = mapStore();
    let { C } = make(disk);
    C.setGlobal("fov", 8); C.setGlobal("cornerLead", 1);
    C.set("chase", "fov", 0); C.set("chase", "cornerLead", 0.54);
    C.load(C.exportEdits()); C.persist();
    ({ C } = make(disk));
    expect(C.values("chase")["fov"]).toBe(0);
    expect(C.apply("chase", [0, 2, -8], [0, 1, 0], 60)).toBe(60);
    expect(C.cornerLead("chase")).toBe(0.54);
    expect(C.values("far")["fov"]).toBe(8);
    C.reset("chase");
    expect(C.values("chase")["fov"]).toBe(8);
    expect(C.cornerLead("chase")).toBe(1);
  });

  it("overrides resolve track over car over the global baseline (cam-comfort.test.mjs)", () => {
    const { C } = make();
    expect(C.importPack({
      v: 2, global: { dist: 1 }, comfort: { bob: 0.8 },
      cars: { mclaren: { modes: { chase: { dist: 2 } }, comfort: { bob: 0.5 } } },
      tracks: { monza: { modes: { chase: { dist: 3 } }, comfort: { bob: 0.2 } } },
    }).ok).toBe(true);
    C.setContext("monza", "mclaren");
    expect(C.get("chase", "dist")).toBe(3);
    expect(C.comfortGet("bob")).toBe(0.2);
    C.setContext("spa", "mclaren");
    expect(C.get("chase", "dist")).toBe(2);
    expect(C.comfortGet("bob")).toBe(0.5);
    C.setContext("spa", "ferrari");
    expect(C.get("chase", "dist")).toBe(1);
    expect(C.comfortGet("bob")).toBe(0.8);
  });

  it("JSON and APXC1 packs round-trip track and car overrides", () => {
    const { C: src } = make();
    src.importPack({
      v: 2,
      cars: { mclaren: { modes: { cockpit: { height: 0.25 } }, comfort: { rollLean: 0.4 } } },
      tracks: { spa: { modes: { chase: { fov: 5 } }, comfort: { speedFov: 0.3 } } },
    });
    const pack = plain(src.exportPack());
    expect(pack.cars?.["mclaren"]?.modes["cockpit"]).toEqual({ height: 0.25 });
    expect(pack.tracks?.["spa"]?.comfort).toEqual({ speedFov: 0.3 });
    const { C: dst } = make();
    const dec = dst.decodeShare(src.encodeShare(pack));
    expect(dec.ok).toBe(true);
    if (dec.ok) expect(dst.importPack(dec.pack).ok).toBe(true);
    expect(plain(dst.exportPack())).toEqual(pack);
  });

  it("spot values: SIDE moves the eye RIGHT, YAW pans right, PITCH tilts up, FOV clamps 20-110", () => {
    const { C } = make();
    C.set("chase", "side", 2); C.set("chase", "yaw", 10); C.set("chase", "pitch", 5); C.set("chase", "fov", 35);
    const eye: Vec3 = [0, 2, -8], tgt: Vec3 = [0, 1, 0];
    expect(C.apply("chase", eye, tgt, 90)).toBe(110);
    // Forward +Z: right is -X in this Y-up world ((-fz, fx) = (-1, 0)).
    expect(eye).toEqual([-2, 2, -8]);
    // f1-game offsets.js output for the same input (yaw +10° pans toward -X, pitch +5° lifts the aim).
    expect(tgt).toEqual([-1.4156439533372969, 1.7225099683637646, 0.28139645790921364]);
  });

  it.skipIf(!hasCam)("bit-exact against f1-game offsets.js: apply poses, values, export and share code", () => {
    const vmStore = mapStore();
    type VmTune = CamTune;
    const F = f1Cam<VmTune>(["offsets.js"], "CamTune", { GameStore: { store: vmStore }, Teams: { LIST: TEAMS } });
    const { C } = make();
    const PROFILES: Record<string, number>[] = [
      {}, { height: 0.35 }, { dist: -2.5, height: -0.35, fov: -4 }, { side: 3.175, yaw: -12.25 },
      { pitch: 44.75 }, { pitch: -45, yaw: 90, fov: 35 }, { dist: 24, side: -12, height: 10, pitch: 7.5, yaw: -33.5, fov: -35 },
      { yaw: 0.25 }, { pitch: 0.25, dist: 0.025 },
    ];
    const POSES: [Vec3, Vec3][] = [
      [[0, 2, -8], [0, 1, 0]], [[12.5, 3.1, -40.2], [10.1, 0.7, -34.6]], [[5, 60, 5], [5, 0, 5]],     // straight down (overhead)
      [[0, 1, 0], [0, 1.0000001, 0.00000001]], [[-311.27, 14.9, 902.004], [-306.5, 13.2, 897.75]], [[1, 1, 1], [1, 5, 1]],
    ];
    let n = 0;
    for (const bias of [0, 2.5, -15]) for (const global of [{}, { fov: 8 }, { side: 0.5, pitch: -3 }]) for (const prof of PROFILES) {
      for (const T of [C, F]) {
        T.resetAll(); T.comfortSet("fovBias", bias);
        for (const [id, v] of Object.entries(global)) T.setGlobal(id, v);
        for (const [id, v] of Object.entries(prof)) T.set("chase", id, v);
      }
      for (const [e0, t0] of POSES) for (const fov0 of [20, 57.3, 81, 110]) {
        const e1: Vec3 = [...e0], t1: Vec3 = [...t0], e2: Vec3 = [...e0], t2: Vec3 = [...t0];
        const f1 = C.apply("chase", e1, t1, fov0), f2 = F.apply("chase", e2, t2, fov0);
        const a = [...e1, ...t1, f1], b = [...e2, ...t2, f2];
        if (!a.every((v, i) => Object.is(v, b[i]))) throw new Error(`${JSON.stringify(prof)} bias ${bias}: ${a} vs ${b}`);
        n++;
      }
      expect(C.values("chase")).toEqual(plain(F.values("chase")));
      expect(C.encodeShare()).toBe(F.encodeShare());
    }
    expect(n).toBeGreaterThan(1500);
    for (const id of Object.keys(C.PRESETS)) {
      C.applyPreset(id); F.applyPreset(id);
      expect(plain(C.exportPack())).toEqual(plain(F.exportPack()));
      for (const m of ["chase", "far", "hood", "cockpit", "heli"]) {
        expect([C.cornerLead(m), C.cornerHang(m), C.speedFov(), C.bob(), C.rollLean(), C.fovBias()])
          .toEqual([F.cornerLead(m), F.cornerHang(m), F.speedFov(), F.bob(), F.rollLean(), F.fovBias()]);
      }
    }
    for (const raw of [{ chase: { dist: 1e9, side: -1e9, fov: 0.1 } }, { v: 1, global: { pitch: 99 }, comfort: { fovBias: -99, speedFov: 0.33 } }, [1, 2], "x"]) {
      expect(C.importPack(raw)).toEqual(plain(F.importPack(raw)));
      expect(plain(C.exportPack())).toEqual(plain(F.exportPack()));
    }
    expect(C.decodeShare("APXC1.e30")).toEqual(plain(F.decodeShare("APXC1.e30")));
    expect(C.decodeShare("APXC1.!!")).toEqual(plain(F.decodeShare("APXC1.!!")));
    for (const v of [[0.3, true, false, 1], [1, false, false, 0.6]] as const) {
      expect(Object.is(C.buzzAmp(v[0], v[1], v[2], v[3]), F.buzzAmp(v[0], v[1], v[2], v[3]))).toBe(true);
      expect(Object.is(C.rollTarget(0.031, -2.2, 0.004, false), F.rollTarget(0.031, -2.2, 0.004, false))).toBe(true);
      expect(Object.is(C.shakeOffset(0.77, false), F.shakeOffset(0.77, false))).toBe(true);
    }
  });
});
