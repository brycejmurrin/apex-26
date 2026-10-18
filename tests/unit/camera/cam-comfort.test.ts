/** CamComfort (src/camera/cam-comfort.ts). Assertions ported from f1-game
 *  tests/unit/cam-comfort.test.mjs:44-155; the FX clamps compared with
 *  f1-game cam-comfort.js in a VM (Object.is). Also the local store fallback. */
import { describe, expect, it } from "vitest";
import * as CC from "../../../src/camera/cam-comfort";
import { createLocalCamStore, type CamStore, type StorageLike } from "../../../src/camera/store";
import { f1Cam, hasCam } from "./f1-cam-vm";

type RawStore = CamStore & { _disk: Map<string, unknown> };
function rawStore(initial?: Record<string, unknown>): RawStore {
  const disk = new Map<string, unknown>(Object.entries(initial || {}));
  return {
    raw: (k) => (disk.has(k) ? (disk.get(k) as string) : null),
    rawSet: (k, v) => { disk.set(k, v); return true; },
    get: (k, d) => (disk.has(k) ? disk.get(k) : d),
    set: (k, v) => { disk.set(k, v); return true; },
    _disk: disk,
  };
}

describe("CamComfort", () => {
  it("detectTouch / detectXr read navigator capabilities", () => {
    expect(CC.detectTouch({ maxTouchPoints: 2 }, {})).toBe(true);
    expect(CC.detectTouch({ maxTouchPoints: 0 }, {})).toBe(false);
    expect(CC.detectTouch({ maxTouchPoints: 0 }, { ontouchstart: null })).toBe(true);
    expect(CC.detectXr({ xr: {} })).toBe(true);
    expect(CC.detectXr({})).toBe(false);
  });

  it("boot writes on when touch and key unset; never overwrites a choice", () => {
    const s1 = rawStore();
    expect(CC.boot(s1, { maxTouchPoints: 5 }, {})).toBe("on");
    expect(s1.raw(CC.KEY)).toBe("on");
    expect(CC.boot(s1, { maxTouchPoints: 5 }, {})).toBe(null);
    const s2 = rawStore({ [CC.KEY]: "off" });
    expect(CC.boot(s2, { maxTouchPoints: 5 }, {})).toBe(null);
    expect(s2.raw(CC.KEY)).toBe("off");
  });

  it("boot is a no-op on desktop", () => {
    const s = rawStore();
    expect(CC.boot(s, { maxTouchPoints: 0 }, {})).toBe(null);
    expect(s.raw(CC.KEY)).toBe(null);
  });

  it("reduced-motion boot preselects both renderer comfort hooks off; applyFx reaches the hook", () => {
    expect(CC.FX_DEFS.every((d) => d.unit === "")).toBe(true);
    const s = rawStore();
    const reduced = { matchMedia: (q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)" }) };
    CC.boot(s, { maxTouchPoints: 0 }, reduced);
    expect(s.get("motionBlur", null)).toBe(1);
    expect(s.get("speedLines", null)).toBe(1);
    s.set("motionBlur", 7);
    s.set("speedLines", 4);
    let applied: Record<string, number> | null = null;
    const G = { gfx: { setComfortFx(o: Record<string, number>) { applied = o; } } };
    expect({ ...CC.applyFx(G, s) }).toEqual({ motionBlur: 7, speedLines: 4 });
    expect(applied).toEqual({ motionBlur: 7, speedLines: 4 });
  });

  it("active follows the stored preference", () => {
    expect(CC.active(rawStore({ [CC.KEY]: "on" }))).toBe(true);
    expect(CC.active(rawStore({ [CC.KEY]: "off" }))).toBe(false);
    expect(CC.active(rawStore())).toBe(false);
    expect(CC.active(null)).toBe(false);
  });

  it("boot ignores navigator.xr and drops the old XR auto value on a non-touch device", () => {
    const s = rawStore();
    expect(CC.boot(s, { maxTouchPoints: 0, xr: {} }, {})).toBe(null);
    expect(s.raw(CC.KEY)).toBe(null);
    const withDel = (init: Record<string, unknown>): RawStore => { const r = rawStore(init); r.rawDel = (k) => { r._disk.delete(k); return true; }; return r; };
    const desk = withDel({ [CC.KEY]: "on" });
    expect(CC.boot(desk, { maxTouchPoints: 0, xr: {} }, {})).toBe(null);
    expect(desk.raw(CC.KEY)).toBe(null);
    expect(CC.active(desk)).toBe(false);
    const phone = withDel({ [CC.KEY]: "on" });
    CC.boot(phone, { maxTouchPoints: 5 }, {});
    expect(phone.raw(CC.KEY)).toBe("on");
  });

  it("an explicit REDUCE MOTION: OFF wins over the touch auto-pick", () => {
    const s = rawStore({ [CC.KEY]: "on" });
    let motion: string | null = null;
    s.get = (k, d) => (k === "motion" && motion !== null ? motion : d);
    expect(CC.active(s)).toBe(true);
    motion = "off";
    expect(CC.active(s)).toBe(false);
    motion = "reduce";
    expect(CC.active(s)).toBe(true);
  });

  it("active() is memoised on rev / rawRev: one raw read per revision", () => {
    const disk = new Map<string, string>([["camComfortPref", "on"]]);
    let reads = 0, motion: string | null = null;
    const s = {
      rev: 0, rawRev: 0,
      raw(k: string) { reads++; return disk.get(k) ?? null; },
      rawSet(k: string, v: unknown) { this.rawRev++; disk.set(k, String(v)); return true; },
      rawDel(k: string) { this.rawRev++; disk.delete(k); return true; },
      get(k: string, d: unknown) { return k === "motion" ? motion : d; },
      set() { return true; },
    };
    expect(CC.active(s)).toBe(true);
    for (let i = 0; i < 100; i++) expect(CC.active(s)).toBe(true);
    expect(reads).toBe(1);
    CC.set(s, false);
    expect(CC.active(s)).toBe(false);
    expect(reads).toBe(2);
    CC.set(s, true); motion = "off"; s.rev++;
    expect(CC.active(s)).toBe(false);
    motion = null; s.rev++;
    expect(CC.active(s)).toBe(true);
    const plain = rawStore({ camComfortPref: "on" });
    expect(CC.active(plain)).toBe(true);
    plain._disk.set("camComfortPref", "off");
    expect(CC.active(plain)).toBe(false);
  });

  it("FX notches clamp to 1..10 and round; spot values", () => {
    const s = rawStore({ motionBlur: 12.6, speedLines: "x" });
    expect(CC.fxGet(s, "motionBlur")).toBe(10);
    expect(CC.fxGet(s, "speedLines")).toBe(5);
    expect(CC.fxGet(s, "nope")).toBe(1);
    expect(CC.fxSet(s, "speedLines", 0.4)).toBe(true);
    expect(s.get("speedLines", null)).toBe(1);
    expect(CC.fxSet(s, "speedLines", NaN)).toBe(false);
    expect(CC.fxGet(null, "motionBlur")).toBe(5);
  });

  it("the local store keeps f1-game's key spelling under a26. and falls back to SettingsDefaults", () => {
    const mem = new Map<string, string>();
    const storage: StorageLike = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); }, removeItem: (k) => { mem.delete(k); } };
    const s = createLocalCamStore(storage);
    expect(s.raw("cockpitHalo")).toBe("fairing");            // SettingsDefaults
    expect(s.raw("a26.cockpitHalo")).toBe("fairing");
    s.rawSet("a26.cockpitHalo", "0");
    expect(mem.get("a26.cockpitHalo")).toBe("0");
    expect(s.raw("cockpitHalo")).toBe("0");
    s.set("camTune", { chase: { dist: 1 } });
    expect(mem.get("a26.camTune")).toBe('{"chase":{"dist":1}}');
    expect(s.get("camTune", null)).toEqual({ chase: { dist: 1 } });
    expect(s.get("missing", 7)).toBe(7);
    const rev = s.rev, rawRev = s.rawRev;
    s.set("x", 1); s.rawDel("a26.cockpitHalo");
    expect([s.rev, s.rawRev]).toEqual([rev + 1, rawRev + 1]);
    expect(s.raw("cockpitHalo")).toBe("fairing");
    const broken = createLocalCamStore({ getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} });
    expect(broken.rawSet("k", "v")).toBe(false);
    expect(broken.raw("k")).toBe("v");                       // usable this session
  });

  it.skipIf(!hasCam)("bit-exact against f1-game cam-comfort.js: FX clamps, active, boot", () => {
    type VmCC = typeof CC;
    const V = f1Cam<VmCC>(["cam-comfort.js"], "CamComfort");
    for (const v of [-3, 0, 0.49, 0.5, 1, 1.5, 4.4999, 4.5, 5, 9.5, 10, 10.49, 11, 1e9, NaN, Infinity, "7", null, true]) {
      const a = rawStore({ motionBlur: v }), b = rawStore({ motionBlur: v });
      expect(Object.is(CC.fxGet(a, "motionBlur"), V.fxGet(b, "motionBlur"))).toBe(true);
      expect(CC.fxSet(a, "speedLines", v)).toBe(V.fxSet(b, "speedLines", v));
      expect(a.get("speedLines", null)).toBe(b.get("speedLines", null));
    }
    for (const pref of [null, "on", "off", "auto"]) for (const touch of [0, 3]) {
      const init = pref === null ? {} : { [CC.KEY]: pref };
      const a = rawStore(init), b = rawStore(init);
      expect(CC.boot(a, { maxTouchPoints: touch }, {})).toBe(V.boot(b, { maxTouchPoints: touch }, {}));
      expect([...a._disk]).toEqual([...b._disk]);
      expect(CC.active(a)).toBe(V.active(b));
    }
  });
});
