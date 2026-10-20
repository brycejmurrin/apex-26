// @vitest-environment happy-dom
/** CAMERA TUNER panel (src/camera/tuner-panel.ts): the f1-game panel
 *  (js/camera/tuner-panel.js) driven through its DOM with the same ids. */
import { afterEach, describe, expect, it } from "vitest";
import { createCamTune } from "../../../src/camera/offsets";
import { mountCamTuner, type CamTunerMount, type CornerPreview } from "../../../src/camera/tuner-panel";
import { mapStore } from "./f1-cam-vm";

const MODES = [{ id: "chase", label: "CHASE" }, { id: "far", label: "FAR" }, { id: "cockpit", label: "COCKPIT" }, { id: "hood", label: "HOOD" }];

function setup(opts: { previews?: boolean; disk?: ReturnType<typeof mapStore> } = {}) {
  const store = opts.disk ?? mapStore();
  const camTune = createCamTune({ store, teamId: () => null, modeIds: () => MODES.map((m) => m.id) });
  let mode = 0, live = 0, paused = true;
  const jumps: CornerPreview[] = [], fx: Record<string, number>[] = [], copied: string[] = [];
  const pm = document.createElement("div"); pm.id = "pmsettings"; document.body.appendChild(pm);
  const disp = document.createElement("div"); disp.id = "pm-panel-display"; pm.appendChild(disp);
  const btn = document.createElement("button"); btn.id = "pm-camtune"; disp.appendChild(btn);
  const m = mountCamTuner(document.body, {
    camTune, modes: MODES, store,
    camMode: () => mode, setCamMode: (i) => { mode = i; },
    trackId: () => "monza", teamId: () => "ferrari",
    applyLive: () => { live++; },
    ...(opts.previews ? { previewCorner: (p: CornerPreview) => { jumps.push(p); } } : {}),
    paused: () => paused,
    gfx: { setComfortFx: (o) => { fx.push(o); } },
    clipboard: (t) => { copied.push(t); return Promise.resolve(true); },
    openButton: btn,
  });
  return { store, camTune, m, btn, pm, disp, jumps, fx, copied, get mode() { return mode; }, get live() { return live; }, setPaused: (v: boolean) => { paused = v; } };
}
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error("#" + id);
  return e as T;
};
const slide = (id: string, v: number): void => { const i = $<HTMLInputElement>(id); i.value = String(v); i.dispatchEvent(new Event("input")); };

let mounted: CamTunerMount | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; document.body.replaceChildren(); document.body.className = ""; });

describe("CAMERA TUNER panel", () => {
  it("builds f1-game's shell DOM and opens docked over the live view", () => {
    const s = setup(); mounted = s.m;
    for (const id of ["camtune", "camtune-inner", "ct-rail", "ct-head", "ct-profile", "ct-modes", "ct-help-on", "ct-rows", "ct-previews", "ct-json", "ct-reset", "ct-reset-all", "ct-copy", "ct-close"]) expect(document.getElementById(id), id).not.toBe(null);
    expect(s.m.isOpen()).toBe(false);
    s.btn.click();
    expect(s.m.isOpen()).toBe(true);
    expect(document.body.classList.contains("lt-open")).toBe(true);
    expect(s.pm.hidden && s.disp.hidden).toBe(true);
    expect($("ct-previews").hidden).toBe(true);           // no dev-API jumps
    expect($("ct-modes").children.length).toBe(MODES.length);
    expect($("ct-tab-chase").classList.contains("active")).toBe(true);
    expect($("ct-profile").textContent).toBe("CHASE  (default framing)");
    expect($("ct-import").nextElementSibling?.id).toBe("ct-close");
    expect(s.live).toBeGreaterThan(0);
    $("ct-close").click();
    expect(s.m.isOpen()).toBe(false);
    expect(document.body.classList.contains("lt-open")).toBe(false);
    expect(s.pm.hidden || s.disp.hidden).toBe(false);      // back to SETTINGS › DISPLAY while paused
  });

  it("a slider edits the live camera's mode, persists only that store and labels the value", () => {
    const s = setup(); mounted = s.m;
    s.m.openCamTuner();
    slide("ct-in-height", 0.5);
    expect(s.camTune.getModeOnly("chase", "height")).toBe(0.5);
    expect(s.store.disk.get("camTune")).toEqual({ chase: { height: 0.5 } });
    expect(s.store.disk.has("camTuneGlobal")).toBe(false);
    expect($("ct-v-height").textContent).toBe("+0.50m");
    expect($("ct-profile").textContent).toBe("CHASE  (1 tuned)");
    expect($("ct-tab-chase").classList.contains("tuned")).toBe(true);
    slide("ct-in-yaw", -12.25);
    expect($("ct-v-yaw").textContent).toBe("−12.25°");
    expect($("ct-row-cornerLead").style.display).toBe("");
    $("ct-tab-cockpit").click();
    expect(s.mode).toBe(2);
    expect($("ct-row-cornerLead").style.display).toBe("none");   // chase/far/drone only
    expect($<HTMLInputElement>("ct-in-height").value).toBe("0");
    $("ct-tab-cockpit").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(s.mode).toBe(3);
    $("ct-tab-hood").dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    expect(s.mode).toBe(0);
  });

  it("ALL CAMS writes the baseline; THIS TRACK writes the current track's override", () => {
    const s = setup(); mounted = s.m;
    s.m.openCamTuner();
    (document.querySelector('#ct-scope [data-scope="global"]') as HTMLButtonElement).click();
    expect($("ct-profile").textContent).toBe("ALL CAMERAS  (no baseline)");
    expect($("ct-row-cornerLead").style.display).toBe("");     // global shows every knob
    slide("ct-in-fov", 6);
    expect(s.camTune.getGlobal("fov")).toBe(6);
    expect(s.store.disk.get("camTuneGlobal")).toEqual({ fov: 6 });
    expect(s.camTune.values("hood")["fov"]).toBe(6);
    (document.querySelector('#ct-scope [data-scope="track"]') as HTMLButtonElement).click();
    slide("ct-in-dist", 3);
    expect(s.camTune.context()).toEqual({ track: "monza", car: "ferrari" });
    expect(s.camTune.getScoped("track", "chase", "dist")).toBe(3);
    expect(s.store.disk.get("camTuneTrack")).toEqual({ monza: { modes: { chase: { dist: 3 } }, comfort: {} } });
    expect($("ct-profile").textContent).toBe("TRACK MONZA  (1 overrides)");
    $("ct-reset").click();
    expect(s.camTune.countScoped("track", "chase")).toBe(0);
  });

  it("comfort and FX sliders, presets, copy-from and HERE → ALL", () => {
    const s = setup(); mounted = s.m;
    s.m.openCamTuner();
    slide("ct-cin-bob", 0.25);
    expect(s.camTune.bob()).toBe(0.25);
    expect(s.store.disk.get("camComfort")).toEqual({ bob: 0.25 });
    slide("ct-fxin-motionBlur", 3);
    expect(s.store.disk.get("motionBlur")).toBe(3);
    expect(s.fx[s.fx.length - 1]).toEqual({ motionBlur: 3, speedLines: 5 });
    expect($("ct-fxv-motionBlur").textContent).toBe("3");
    $("ct-preset-close").click();
    expect(s.camTune.getModeOnly("chase", "dist")).toBe(-2.5);
    expect(s.camTune.bob()).toBe(1);                           // CLOSE UP's `comfort: null` clears comfort (offsets.js PRESETS)
    expect($("ct-cv-bob").textContent).toBe("1.00");
    $("ct-tab-hood").click();
    const sel = $<HTMLSelectElement>("ct-copy-from");
    expect(sel.value).toBe("chase");
    $("ct-copy-from-btn").click();
    expect(s.camTune.getModeOnly("hood", "dist")).toBe(-2.5);
    const all = $("ct-copy-all-btn");
    all.click();
    expect(all.textContent).toBe("COPY TO ALL?");
    expect(s.camTune.getModeOnly("cockpit", "dist")).toBe(0.12);
    all.click();
    expect(all.textContent).toBe("COPIED 3 ✓");
    expect(s.camTune.getModeOnly("cockpit", "dist")).toBe(-2.5);
    $("ct-reset-all").click();
    expect(s.camTune.count("chase") + s.camTune.countGlobal()).toBe(0);
  });

  it("COPY VALUES writes the CameraEdits + pack + share block, and IMPORT reads it back", async () => {
    const s = setup(); mounted = s.m;
    s.m.openCamTuner();
    $("ct-copy").click();
    expect($("ct-copy").textContent).toBe("NOTHING TUNED");
    slide("ct-in-dist", 2.5);
    $("ct-tab-hood").click();
    slide("ct-in-height", 0.4);
    $("ct-copy").click();
    await Promise.resolve();
    const block = $<HTMLTextAreaElement>("ct-json").value;
    expect(block.startsWith("window.CameraEdits = {\n  // THIS MODE — HOOD  (1 tuned)")).toBe(true);
    expect(block).toMatch(/\n\/\/ Share code\nAPXC1\.[A-Za-z0-9_-]+$/);
    expect(s.copied).toEqual([block]);
    expect($("ct-copy").textContent).toBe("COPIED ✓");
    s.m.unmount(); mounted = null;
    document.body.replaceChildren();
    const t = setup(); mounted = t.m;
    t.m.openCamTuner();
    const ta = $<HTMLTextAreaElement>("ct-json");
    ta.value = block;
    $("ct-import").click();
    expect($("ct-import").textContent).toBe("IMPORTED ✓");
    expect(t.camTune.getModeOnly("chase", "dist")).toBe(2.5);
    expect(t.camTune.getModeOnly("hood", "height")).toBe(0.4);
    expect(t.store.disk.get("camTune")).toEqual({ chase: { dist: 2.5 }, hood: { height: 0.4 } });
    ta.value = "garbage {";
    $("ct-import").click();
    expect($("ct-import").textContent).toBe("BAD PASTE");
  });

  it("corner previews show only with a jump, and the help toggle reveals explanations", () => {
    const s = setup({ previews: true }); mounted = s.m;
    s.m.openCamTuner();
    expect($("ct-previews").hidden).toBe(false);
    $("ct-prev-spa").click();
    expect(s.jumps).toEqual([{ id: "spa", frac: 0.34, speed: 62 }]);
    const help = $<HTMLInputElement>("ct-help-on");
    help.checked = true; help.dispatchEvent(new Event("change"));
    expect($("camtune-inner").classList.contains("lt-show-help")).toBe(true);
    s.m.unmount(); mounted = null;
    expect(document.getElementById("camtune")).toBe(null);
    expect(s.btn.onclick).toBe(null);
  });
});
