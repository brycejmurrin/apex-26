/**
 * src/xr/plan.ts: table-driven VR path selection. Ported from f1-game
 * tests/unit/xr-plan.test.mjs (pure; no DOM / navigator).
 *
 * Skipped from that file:
 *  - "js/xr/xr-plan.js is referenced (zeroRefModules)": an f1-game file-roster check.
 *  - "GLX getContext requests xrCompatible only when navigator.xr exists": reads
 *    f1-game js/render/glx/glx.js; apex-26 has no GLX (three's XRManager calls
 *    makeXRCompatible itself, tests/unit/xr-three-binding.test.ts).
 */
import { describe, expect, it } from "vitest";
import { normBackend, normXr, planPin, resolve, type XrPlanInput } from "../../src/xr/plan";

const CAPS_FULL = { xr: true, vr: true, gpu: true, xrgpu: true, layers: true, mobileQuest: false };
const CAPS_NO_GPU = { xr: true, vr: true, gpu: false, xrgpu: false };
const CAPS_NO_XRGPU = { xr: true, vr: true, gpu: true, xrgpu: false };
const CAPS_NO_VR = { xr: true, vr: false, gpu: true, xrgpu: true };
const CAPS_NO_XR = { xr: false, vr: false, gpu: false, xrgpu: false };
const CAPS_QUEST = { xr: true, vr: true, gpu: true, xrgpu: true, mobileQuest: true };

interface Row {
  name: string;
  input: XrPlanInput;
  want: { xrMode: string; path: string | null; backendPref: string | null; forceGL?: boolean };
  fallbackFrom?: string;
  reasonIncludes?: string;
}

const ROWS: Row[] = [
  { name: "no xr capability, vr off", input: { caps: CAPS_NO_XR, prefs: { xr: "0", xrBackend: "webgl2" } }, want: { xrMode: "off", path: null, backendPref: null } },
  { name: "xr present but immersive-vr unsupported", input: { caps: CAPS_NO_VR, prefs: { xr: "1", xrBackend: "webgl2" } }, want: { xrMode: "off", path: null, backendPref: null } },
  { name: "armed default → webgl2", input: { caps: CAPS_FULL, prefs: { xr: "1", xrBackend: "webgl2" } }, want: { xrMode: "armed", path: "webgl2", backendPref: "webgl2", forceGL: false } },
  { name: "armed unset xrBackend → webgl2", input: { caps: CAPS_FULL, prefs: { xr: "1" } }, want: { xrMode: "armed", path: "webgl2", backendPref: "webgl2" } },
  { name: "armed + webgpu with all caps → three / experimental", input: { caps: CAPS_FULL, prefs: { xr: "1", xrBackend: "webgpu" } }, want: { xrMode: "armed", path: "webgpu", backendPref: "three", forceGL: false } },
  { name: "armed + webgpu missing gpu → fallback webgl2", input: { caps: CAPS_NO_GPU, prefs: { xr: "1", xrBackend: "webgpu" } }, want: { xrMode: "armed", path: "webgl2", backendPref: "webgl2" }, fallbackFrom: "webgpu" },
  { name: "armed + webgpu missing XRGPUBinding → fallback webgl2", input: { caps: CAPS_NO_XRGPU, prefs: { xr: "1", xrBackend: "webgpu" } }, want: { xrMode: "armed", path: "webgl2", backendPref: "webgl2" }, fallbackFrom: "webgpu" },
  {
    name: "fallback latch forces webgl2 even when webgpu caps ok",
    input: { caps: CAPS_FULL, prefs: { xr: "1", xrBackend: "webgpu" }, boot: { xrFallback: "webgl2" } },
    want: { xrMode: "armed", path: "webgl2", backendPref: "webgl2" },
    fallbackFrom: "webgpu",
  },
  { name: "xr off ignores webgpu preference", input: { caps: CAPS_FULL, prefs: { xr: "0", xrBackend: "webgpu" } }, want: { xrMode: "off", path: null, backendPref: null } },
  { name: "garbage xr pref → off", input: { caps: CAPS_FULL, prefs: { xr: "maybe", xrBackend: "webgl2" } }, want: { xrMode: "off", path: null, backendPref: null } },
  { name: "garbage xrBackend → webgl2 when armed", input: { caps: CAPS_FULL, prefs: { xr: "1", xrBackend: "metal" } }, want: { xrMode: "armed", path: "webgl2", backendPref: "webgl2" } },
  { name: "xr=true boolean accepted as armed", input: { caps: CAPS_FULL, prefs: { xr: true, xrBackend: "webgl2" } }, want: { xrMode: "armed", path: "webgl2", backendPref: "webgl2" } },
  { name: "Quest UA still arms webgpu experimental with a reason", input: { caps: CAPS_QUEST, prefs: { xr: "1", xrBackend: "webgpu" } }, want: { xrMode: "armed", path: "webgpu", backendPref: "three" }, reasonIncludes: "Quest" },
  { name: "empty input → off", input: {}, want: { xrMode: "off", path: null, backendPref: null } },
  {
    name: "armed with gfxBackend three still returns webgl2 override (never writes)",
    input: { caps: CAPS_FULL, prefs: { xr: "1", xrBackend: "webgl2", gfxBackend: "three" } },
    want: { xrMode: "armed", path: "webgl2", backendPref: "webgl2" },
  },
  { name: "storage-blocked shape: missing caps.vr with xr on → off", input: { caps: { xr: true }, prefs: { xr: "1", xrBackend: "webgl2" } }, want: { xrMode: "off", path: null, backendPref: null } },
];

describe("xr plan (xr-plan.test.mjs)", () => {
  it("resolve table (≥15 rows)", () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(15);
    for (const row of ROWS) {
      const got = resolve(row.input);
      expect(got.xrMode, row.name + " xrMode").toBe(row.want.xrMode);
      expect(got.path, row.name + " path").toBe(row.want.path);
      expect(got.backendPref, row.name + " backendPref").toBe(row.want.backendPref);
      if (row.want.forceGL != null) expect(got.forceGL, row.name + " forceGL").toBe(row.want.forceGL);
      expect(Array.isArray(got.reasons)).toBe(true);
      expect(Array.isArray(got.fallbacks)).toBe(true);
      if (row.fallbackFrom) expect(got.fallbacks.some((f) => f.from === row.fallbackFrom), row.name).toBe(true);
      if (row.reasonIncludes) expect(got.reasons.some((r) => r.includes(row.reasonIncludes as string)), row.name).toBe(true);
    }
  });

  it("never invents a gfxBackend write: resolve is pure", () => {
    const prefs = { xr: "1", xrBackend: "webgpu", gfxBackend: "webgpu" };
    const before = JSON.stringify(prefs);
    resolve({ caps: CAPS_NO_GPU, prefs });
    expect(JSON.stringify(prefs)).toBe(before);
  });

  it("normXr / normBackend accept the loose spellings and default the rest", () => {
    for (const v of ["1", 1, true, "on", "true"]) expect(normXr(v)).toBe("1");
    for (const v of ["0", 0, false, "yes", null, undefined, ""]) expect(normXr(v)).toBe("0");
    expect(normBackend("WebGPU")).toBe("webgpu");
    for (const v of ["webgl2", "vulkan", null, undefined, 3]) expect(normBackend(v)).toBe("webgl2");
  });

  it("planPin (apex-26): off leaves the 2D pick, webgl2 pins ?gl=1, webgpu pins ?gl=0", () => {
    expect(planPin(resolve({ caps: CAPS_FULL, prefs: { xr: "0" } }))).toBeNull();
    expect(planPin(resolve({ caps: CAPS_FULL, prefs: { xr: "1" } }))).toBe("1");
    expect(planPin(resolve({ caps: CAPS_NO_XRGPU, prefs: { xr: "1", xrBackend: "webgpu" } }))).toBe("1");
    expect(planPin(resolve({ caps: CAPS_FULL, prefs: { xr: "1", xrBackend: "webgpu" } }))).toBe("0");
  });
});
