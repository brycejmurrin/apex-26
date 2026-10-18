// @vitest-environment happy-dom
/**
 * src/xr/opts.ts (XrOpts, the VR settings rows) and src/xr/apex-xr.ts (ApexXr
 * bootPick / noteFallback / plan). Ported from f1-game tests/unit/xr-opts.test.mjs,
 * with keys renamed apex26.* -> a26.* (AGENTS.md §Code rules).
 *
 * Skipped from that file:
 *  - "js/xr/xr-opts.js and apex-xr.js exist for zeroRefModules": an f1-game roster check.
 * Adapted: f1-game's bootPick test asserted apex26.gfxBackend stays untouched; apex-26
 * has no stored 2D renderer pick, so the test asserts no storage write but a26.xrCaps.
 */
import { describe, expect, it } from "vitest";
import { ApexXr, questUa } from "../../src/xr/apex-xr";
import { buildXrSettingsBlock, XrOpts, xrSettingRows } from "../../src/xr/opts";
import { MemStorage } from "./xr-harness";

function bootOpts(lsSeed: Record<string, string> = {}, ssSeed: Record<string, string> = {}) {
  const ls = new MemStorage(lsSeed);
  const ss = new MemStorage(ssSeed);
  const released: string[] = [];
  let apex: ApexXr | null = null;
  const opts = new XrOpts({ storage: () => ls, onChange: () => apex?.invalidate(), releaseXrInput: () => released.push("xr") });
  apex = new ApexXr({
    opts,
    storage: () => ls,
    session: () => ss,
    xr: () => ({ requestSession: () => Promise.reject(new Error("unused")) }),
    hasGpu: () => true,
    hasXrGpuBinding: () => false,
    userAgent: () => "Mozilla/5.0",
  });
  return { opts, apex, ls, ss, released };
}

describe("xr opts (xr-opts.test.mjs)", () => {
  it("defaults: xr off, xrBackend webgl2", () => {
    const { opts } = bootOpts();
    expect(opts.xr()).toBe(false);
    expect(opts.xrBackend()).toBe("webgl2");
  });

  it("garbage values fall back to defaults", () => {
    const { opts } = bootOpts({ "a26.xr": "yes", "a26.xrBackend": "vulkan" });
    expect(opts.xr()).toBe(false);
    expect(opts.xrBackend()).toBe("webgl2");
  });

  it("keys use the a26. prefix and never touch f1-game's apex26.*", () => {
    const { opts, ls } = bootOpts({ "apex26.xr": "1" });
    expect(opts.xr()).toBe(false);
    opts.setXr(true);
    opts.setXrBackend("webgpu");
    expect(ls.getItem("a26.xr")).toBe("1");
    expect(ls.getItem("a26.xrBackend")).toBe("webgpu");
    expect([...ls.map.keys()].sort()).toEqual(["a26.xr", "a26.xrBackend", "apex26.xr"]);
  });

  it("arming VR writes nothing but the VR keys (bootPick is an override only)", () => {
    const { apex, ls } = bootOpts({ "a26.xr": "1", "a26.xrBackend": "webgl2", "a26.xrCaps": "1" });
    const before = JSON.stringify([...ls.map]);
    apex.invalidate();
    expect(apex.bootPick()).toBe("webgl2");
    expect(apex.bootPin()).toBe("1");
    expect(JSON.stringify([...ls.map])).toBe(before);
  });

  it("bootPick is null when VR mode is off", () => {
    const { apex } = bootOpts({ "a26.xrCaps": "1", "a26.xr": "0" });
    expect(apex.bootPick()).toBeNull();
    expect(apex.bootPin()).toBeNull();
  });

  it("noteFallback latches sessionStorage", () => {
    const { apex, ss } = bootOpts({ "a26.xr": "1", "a26.xrCaps": "1", "a26.xrBackend": "webgpu" });
    const entry = apex.noteFallback("webgpu", "webgl2", "session.enabledFeatures lacked webgpu");
    expect(entry.to).toBe("webgl2");
    expect(ss.getItem("a26.xrFallback")).toBe("webgl2");
    expect(apex.fallbacks().some((f) => f.reason.includes("enabledFeatures"))).toBe(true);
    expect(apex.plan(true).reasons.some((r) => r.includes("latch"))).toBe(true);
  });

  it("plan records webgpu→webgl2 when XRGPUBinding is missing", () => {
    const { apex } = bootOpts({ "a26.xr": "1", "a26.xrBackend": "webgpu", "a26.xrCaps": "1" });
    const p = apex.plan(true);
    expect(p.xrMode).toBe("armed");
    expect(p.path).toBe("webgl2");
    expect(p.fallbacks.some((f) => f.reason.includes("XRGPUBinding") || f.from === "webgpu")).toBe(true);
  });

  it("VR driving input applies live and releases only XR-owned samples", () => {
    const h = bootOpts();
    expect(h.opts.xrInput()).toBe("controllers");
    expect(h.opts.setXrInput("existing")).toBe("existing");
    expect(h.ls.getItem("a26.xrInput")).toBe("existing");
    expect(h.released).toEqual(["xr"]);
    h.ls.setItem("a26.xrInput", "controllers");
    expect(h.opts.xrInput()).toBe("controllers");
    h.ls.setItem("a26.xrInput", "invalid");
    expect(h.opts.xrInput()).toBe("controllers");
  });

  it("blocked storage reads defaults and writes fail quietly", () => {
    const throwing = { getItem(): string { throw new Error("SecurityError"); }, setItem(): void { throw new Error("SecurityError"); } };
    const opts = new XrOpts({ storage: () => throwing });
    expect(opts.xr()).toBe(false);
    expect(opts.setXr(true)).toBe(true);
    expect(opts.xrInput()).toBe("controllers");
    expect(new XrOpts({ storage: () => null }).xrBackend()).toBe("webgl2");
  });
});

describe("ApexXr detect / stats (apex-xr.js)", () => {
  it("detect latches a26.xrCaps, calls onCaps and re-resolves the plan", async () => {
    const ls = new MemStorage({ "a26.xr": "1" });
    const seen: boolean[] = [];
    const apex = new ApexXr({
      storage: () => ls,
      session: () => new MemStorage(),
      xr: () => ({ isSessionSupported: async () => true, requestSession: () => Promise.reject(new Error("unused")) }),
      hasGpu: () => false,
      hasXrGpuBinding: () => false,
      userAgent: () => "Mozilla/5.0 OculusBrowser/40",
      onCaps: (c) => seen.push(!!c.vr),
    });
    expect(apex.plan().xrMode).toBe("off");
    const caps = await apex.detect();
    expect(caps.vr).toBe(true);
    expect(caps.mobileQuest).toBe(true);
    expect(ls.getItem("a26.xrCaps")).toBe("1");
    expect(seen).toEqual([true]);
    expect(apex.plan().xrMode).toBe("armed");
    expect(apex.stats()).toMatchObject({ path: "webgl2", presenting: false, sessionBackend: null, frameCount: 0 });
  });

  it("a probe that throws is not VR; questUa", async () => {
    const apex = new ApexXr({
      storage: () => new MemStorage(),
      session: () => new MemStorage(),
      xr: () => ({ isSessionSupported: () => { throw new Error("SecurityError"); }, requestSession: () => Promise.reject(new Error("x")) }),
    });
    expect((await apex.detect()).vr).toBe(false);
    expect(questUa("Mozilla OculusBrowser/1")).toBe(true);
    expect(questUa(null)).toBe(false);
  });

  it("rendererMatchesPlan reads the bound backend (f1-game read apex26.gfxBound)", () => {
    let bound: "WebGL2" | "WebGPU" | null = "WebGPU";
    const ls = new MemStorage({ "a26.xr": "1", "a26.xrCaps": "1" });
    const apex = new ApexXr({ storage: () => ls, session: () => new MemStorage(), xr: () => ({ requestSession: () => Promise.reject(new Error("x")) }), boundBackend: () => bound });
    expect(apex.rendererMatchesPlan()).toBe(false);
    bound = "WebGL2";
    expect(apex.rendererMatchesPlan()).toBe(true);
    ls.setItem("a26.xr", "0");
    apex.invalidate();
    bound = null;
    expect(apex.rendererMatchesPlan()).toBe(true);
  });
});

describe("VR settings rows (xr-opts.js initUI)", () => {
  it("three rows wired to the prefs; reload outside a race, a hint inside one", () => {
    const ls = new MemStorage({ "a26.xrCaps": "1" });
    const opts = new XrOpts({ storage: () => ls });
    let reloads = 0, race = false;
    const block = buildXrSettingsBlock(document, opts, { reload: () => reloads++, inRace: () => race });
    document.body.appendChild(block.root);
    expect(block.root.hidden).toBe(false);
    expect([...block.root.querySelectorAll(".set-row")].map((r) => r.id)).toEqual(["pm-xr-mode", "pm-xr-backend", "pm-xr-input"]);
    const mode = document.getElementById("pm-xr-mode-sel") as HTMLSelectElement;
    expect(mode.value).toBe("off");
    mode.value = "on";
    mode.dispatchEvent(new Event("change"));
    expect(ls.getItem("a26.xr")).toBe("1");
    expect(reloads).toBe(1);
    expect(document.getElementById("pm-xr-reload")?.textContent).toBe("RELOADING…");
    race = true;
    const backend = document.getElementById("pm-xr-backend-sel") as HTMLSelectElement;
    backend.value = "webgpu";
    backend.dispatchEvent(new Event("change"));
    expect(ls.getItem("a26.xrBackend")).toBe("webgpu");
    expect(reloads).toBe(1);
    expect(document.getElementById("pm-xr-reload")?.textContent).toMatch(/Finish the race/);
    const input = document.getElementById("pm-xr-input-sel") as HTMLSelectElement;
    input.value = "existing";
    input.dispatchEvent(new Event("change"));
    expect(ls.getItem("a26.xrInput")).toBe("existing");
    expect(reloads).toBe(1);
    block.onCaps({ vr: false });
    expect(block.root.hidden).toBe(true);
    block.onCaps({ vr: true });
    expect(block.root.hidden).toBe(false);
    block.root.remove();
  });

  it("rows stay hidden without a VR capability latch; the spec list is data", () => {
    const opts = new XrOpts({ storage: () => new MemStorage() });
    expect(buildXrSettingsBlock(document, opts).root.hidden).toBe(true);
    const rows = xrSettingRows(opts, { requestReload: () => {} });
    expect(rows.map((r) => r.label)).toEqual(["VR MODE", "VR RENDERER", "VR DRIVING"]);
    expect(rows[1]?.options.map(([v]) => v)).toEqual(["webgl2", "webgpu"]);
  });
});
