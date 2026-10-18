// @vitest-environment happy-dom
/**
 * The FREE CAMERA (src/camera/free-cam.ts) and its photo-mode fly-cam
 * (src/camera/photo-cam.ts): f1-game tests/unit/free-cam.test.mjs ported (the
 * pure half, the lifecycle against a fake photo mode, the real photo mode
 * wiring, the flyby editor's sub-mode, the wheel guards and the photo-kit
 * overlays), a mount/unmount leak check, and the motion integration over a
 * scripted flight held bit for bit against f1-game's own Photomode + FreeCam
 * (node:vm over its mini-dom) and against a committed fixture that always runs.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { createFlybySeq, type FlybyCorner, type FlybyShot, type FlybyTrack, type Vec3 } from "../../../src/camera/flyby-seq";
import * as FC from "../../../src/camera/free-cam";
import { mountFreeCam, type FreeCamFlyby, type FreeCamMount, type FreeCamView } from "../../../src/camera/free-cam";
import { mountPhotoMode, type PhotoModeMount } from "../../../src/camera/photo-cam";
import type { Sample } from "../../../src/track/core/types";
import { mapStore } from "./f1-cam-vm";
import { bitDiff, F1, f1Cam, haveF1 } from "./f1-flyby-vm";
import { asJson, f1Vm, haveF1Photo, maybeWriteFixture, miniDom, plainDeep, readFixture, type MiniDom, type MiniEl } from "./f1-photo-vm";
import { leakProbe } from "./leak";

// A straight track along +Z: s metres out, lateral +right = +X. Four corners.
// (free-cam.test.mjs:26-40, as a FreeCamFlyby.)
const CORNERS: FlybyCorner[] = [{ f: 0.1, r: 0 }, { f: 0.3, r: 0 }, { f: 0.5, r: 0 }, { f: 0.7, r: 0 }];
function stubFlyby() {
  const S = {
    FAR: 6000, FOG: 0.15,
    lastShot: null as FlybyShot | null, resets: 0, solves: 0,
    cornerList: (): readonly FlybyCorner[] => CORNERS,
    cornerSide: (_t: FlybyTrack, n: number): number => (n % 2 ? 1 : -1),
    poseFromWorld: () => ({ pose: { at: "corner", n: 2, off: -12.5, x: 30 }, err: 0.01 }),
    shotFromView: (_t: FlybyTrack, _e: Readonly<Vec3>, _g: Readonly<Vec3>, fov?: number | null) =>
      ({ shot: { id: "freecam", eye: [{ at: "corner", n: 2 }], look: [{ at: "corner", n: 2 }], fov: [fov as number, fov as number] } as FlybyShot, err: { eye: 0.01, look: 0.2 } }),
    // The planner stand-in: a corner pose sits at its apex, +x outside by cornerSide, off along +Z.
    solve(track: FlybyTrack, _u: number, shots?: readonly FlybyShot[] | null) {
      const at = (q: { n?: number | string; x?: number; y?: number; off?: number }): Vec3 => {
        const n = q.n as number, s0 = CORNERS[n - 1]!.f * track.total, sd = S.cornerSide(track, n);
        return [(q.x || 0) * sd, 2 + (q.y || 0), s0 + (q.off || 0)];
      };
      S.lastShot = shots![0]!; S.solves++;
      return { eye: at(shots![0]!.eye[0]!), tgt: at(shots![0]!.look[0]!) };
    },
    reset() { S.resets++; },
  };
  return S;
}
const stubSample = (_t: FlybyTrack, s: number, out: Sample): Sample => {
  out.p[0] = 0; out.p[1] = 2; out.p[2] = s; out.t[0] = 0; out.t[1] = 0; out.t[2] = 1; out.r[0] = 1; out.r[1] = 0; out.r[2] = 0; return out;
};
const trk = (): FlybyTrack => ({ total: 1000 }) as unknown as FlybyTrack;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error("#" + id);
  return e as T;
};
const input = (id: string, v: string | number): void => { const i = $<HTMLInputElement>(id); i.value = String(v); i.dispatchEvent(new Event("input")); };

const mounted: { unmount(): void }[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
  document.body.replaceChildren(); document.body.className = "";
});

/** free-cam.test.mjs boot(): the panel against a fake photo mode. */
function boot(opts: { flyby?: FreeCamFlyby } = {}) {
  const pm = document.createElement("div"); pm.id = "pmsettings"; document.body.appendChild(pm);
  const psPanel = document.createElement("div"); psPanel.id = "ps-panel"; document.body.appendChild(psPanel);
  const flyby = opts.flyby || stubFlyby();
  const G = {
    photoCam: { pos: [0, 0, 0] as Vec3, yaw: 0, pitch: 0, fov: 60 },
    track: trk() as FlybyTrack | null, player: { px: 5, pz: 100, head: 0, s: 100 } as { px: number; pz: number; head: number; s: number } | null,
    paused: true, photoMode: false, dbgCam: null as FreeCamView | null,
  };
  let api: FreeCamMount | null = null;
  const photo = {
    enter() { G.photoMode = true; G.photoCam.pos = [1, 2, 3]; },           // initPhotoCam from the game camera
    exit() { G.photoMode = false; api!.onPhotoExit(); G.dbgCam = null; },  // exitPhotoMode's order
    publish() {
      const e = G.photoCam.pos;
      G.dbgCam = { eye: [e[0], e[1], e[2]], target: [e[0], e[1], e[2] - 100], fov: G.photoCam.fov, far: 2500, fog: 1 };
      api!.decorate(G.dbgCam, 0);
    },
    releaseKeys() {},
  };
  const store = mapStore();
  api = mountFreeCam(document.body, {
    photoCam: G.photoCam, dbgCam: () => G.dbgCam, track: () => G.track, player: () => G.player,
    paused: () => G.paused, photoMode: () => G.photoMode, flyby, store, sample: stubSample, photo,
    clipboard: () => Promise.resolve(true),
  });
  mounted.push(api);
  return { G, api, flyby, store, pm, psPanel };
}

describe("free camera: the pure half (free-cam.test.mjs)", () => {
  it("speed dial is logarithmic 5-200 m/s and round-trips; the wheel steps and clamps", () => {
    expect(FC.speedFromSlider(0)).toBe(5);
    expect(Math.abs(FC.speedFromSlider(1000) - 200)).toBeLessThan(1e-9);
    expect(Math.abs(FC.speedFromSlider(500) - Math.sqrt(5 * 200))).toBeLessThan(1e-9);
    for (const s of [5, 12, 34, 90, 200]) expect(Math.abs(FC.speedFromSlider(FC.sliderFromSpeed(s)) - s) / s).toBeLessThan(0.005);
    expect(FC.sliderFromSpeed(1e6)).toBe(1000); expect(FC.sliderFromSpeed(-3)).toBe(0);
    expect(Math.abs(FC.wheelSpeed(34, -100) - 34 * 1.15)).toBeLessThan(1e-9);
    expect(FC.wheelSpeed(34, 100)).toBeLessThan(34);
    expect(FC.wheelSpeed(199, -1)).toBe(200); expect(FC.wheelSpeed(5, 1)).toBe(5);
    expect(FC.wheelSpeed(34, 0)).toBe(34);
  });

  it("roll clamps to ±45°, junk is level", () => {
    expect(FC.clampRoll(10)).toBe(10);
    expect(FC.clampRoll(90)).toBe(45); expect(FC.clampRoll(-400)).toBe(-45);
    expect(FC.clampRoll("abc")).toBe(0); expect(FC.clampRoll(undefined)).toBe(0);
  });

  it("COPY VIEW is an __apex.view() call rounded to centimetres", () => {
    expect(FC.viewSnippet([1.234, 2, -3.456], [10, 0.005, 7], 61.25)).toBe("__apex.view({eye:[1.23,2,-3.46],target:[10,0.01,7],fov:61.25})");
  });

  it("snap maths: behind the car along its heading; a corner from its outside, before the apex", () => {
    const S = stubFlyby();
    const p = FC.carPose({ px: 5, pz: 100, head: 0 }, 2);    // heading 0 = +Z
    expect(p.eye.map((v) => +v.toFixed(3))).toEqual([5, 5.2, 91]);
    expect(p.target.map((v) => +v.toFixed(3))).toEqual([5, 3, 114]);
    const q = FC.carPose({ px: 0, pz: 0, head: Math.PI / 2 }, 0);   // +X
    expect(q.eye[0] < 0 && Math.abs(q.eye[2]) < 1e-9 && q.target[0] > 0).toBe(true);
    const c1 = FC.cornerPose(S, trk(), 1)!;             // apex at s=100, side +1
    expect(c1.n).toBe(1); expect(c1.count).toBe(4);
    expect(c1.target).toEqual([0, 3, 100]);
    expect(c1.eye[0] > 0 && c1.eye[2] < 100 && c1.eye[1] > 2).toBe(true);
    expect(FC.cornerPose(S, trk(), 2)!.eye[0]).toBeLessThan(0);
    expect(FC.cornerPose(S, trk(), 5)!.n).toBe(1);
    expect(FC.cornerPose(S, trk(), 0)!.n).toBe(4);
    expect(S.lastShot!.eye[0]!.at).toBe("corner"); expect(S.lastShot!.look[0]!.at).toBe("corner");
    expect(S.resets).toBeGreaterThanOrEqual(4);
    const a = FC.aim([0, 0, 0], [0, 0, -10]);
    expect(Math.abs(a.yaw) < 1e-9 && Math.abs(a.pitch) < 1e-9).toBe(true);
  });

  it("cornerPose plans each corner once per track and hands back a private copy", () => {
    const S = stubFlyby(), t = trk();
    const a = FC.cornerPose(S, t, 2)!;
    const solves = S.solves, resets = S.resets;
    const b = FC.cornerPose(S, t, 2)!;
    expect(S.solves).toBe(solves); expect(S.resets).toBe(resets);
    expect(b).toEqual(a);
    b.eye[0] = 999; b.target[0] = 999;
    expect(FC.cornerPose(S, t, 2)!.eye[0]).not.toBe(999);
    FC.cornerPose(S, t, 3);
    expect(S.solves).toBe(solves + 1);
    expect(FC.cornerPose(S, t, 6)!.n).toBe(2);
    expect(S.solves).toBe(solves + 1);
    FC.cornerPose(S, trk(), 2);
    expect(S.solves).toBe(solves + 2);
  });

  it("anchorText reads a pose as one short line", () => {
    expect(FC.anchorText({ at: "corner", n: 2, off: -12.5, x: 30 })).toBe("T2 -12.5 m, +30 m out");
    expect(FC.anchorText({ at: "start", off: 4 })).toBe("start +4 m");
    expect(FC.anchorText({ at: "landmark", rank: 1 })).toBe("landmark #2");
    expect(FC.anchorText({ at: "centre" })).toBe("whole circuit");
    expect(FC.anchorText(null)).toBe("—");
  });
});

describe("free camera panel (free-cam.test.mjs)", () => {
  it("a temporary dock can close while preserving photo mode for its previous owner", () => {
    const { G, api } = boot();
    api.open(); api.cmd({ roll: 20, lens: "flyby" });
    api.close(false, true);
    expect(api.isOpen()).toBe(false);
    expect(G.photoMode).toBe(true);
    expect(api.state().roll).toBe(0);
  });

  it("open flies from the game camera; roll, lens and Q/E decorate dbgCam; DONE restores", () => {
    const { G, api, pm } = boot();
    expect(api.isOpen()).toBe(false);
    expect(api.open()).toBe(true);
    expect(api.isOpen()).toBe(true); expect(G.photoMode).toBe(true);
    expect($("freecam").hidden).toBe(false);
    expect(pm.hidden).toBe(true);
    expect(document.body.classList.contains("lt-open")).toBe(true);
    expect(G.dbgCam!.eye).toEqual([1, 2, 3]);
    expect(G.dbgCam!.roll).toBe(0);

    const st = api.cmd({ roll: 20, lens: "flyby" });
    expect(st && st.roll).toBe(20); expect(st && st.lens).toBe("flyby");
    expect(Math.abs(G.dbgCam!.roll! - 20 * Math.PI / 180)).toBeLessThan(1e-12);
    expect(G.dbgCam!.cine).toBe(true); expect(G.dbgCam!.far).toBe(6000); expect(G.dbgCam!.fog).toBe(0.15);

    expect(api.key("KeyE", true, null)).toBe(1);
    api.decorate(G.dbgCam, 1);                                 // one second of E: +40°, clamped at 45
    expect(api.state().roll).toBe(45);
    api.key("KeyE", false, null);
    expect(api.key("KeyW", true, null)).toBe(0);
    expect(api.key("ArrowLeft", true, $("fc-speed"))).toBe(-1);
    expect(api.key("ArrowLeft", true, null)).toBe(0);

    const before = api.state().speed;
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
    expect(api.state().speed).toBeGreaterThan(before);

    $("fc-close").click();
    expect(api.isOpen()).toBe(false); expect(G.photoMode).toBe(false);
    expect(G.dbgCam).toBe(null);
    expect($("freecam").hidden).toBe(true);
    expect(pm.hidden).toBe(false);
    expect(document.body.classList.contains("lt-open")).toBe(false);
    const after = api.state().speed;
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
    expect(api.state().speed).toBe(after);                     // the wheel listener left with the panel
    expect(api.state().roll).toBe(0);
    expect(api.state().lens).toBe("race");
  });

  it("photo mode leaving by another door (resume / quit) closes the panel without reopening the menu", () => {
    const { G, api, pm } = boot();
    api.open();
    G.paused = false;
    pm.hidden = true;
    api.onPhotoExit();
    expect(api.isOpen()).toBe(false);
    expect(pm.hidden).toBe(true);
  });

  it("__apex.freeCam: state, place, snap, copy and exit", () => {
    const { G, api } = boot();
    expect((api.cmd() as FC.FreeCamState).open).toBe(false);
    const s = api.cmd({ eye: [0, 10, 0], target: [0, 10, -50], fov: 45 }) as FC.FreeCamState;
    expect(s.open).toBe(true); expect(s.eye).toEqual([0, 10, 0]); expect(s.fov).toBe(45);
    expect((api.cmd({ fov: 500 }) as FC.FreeCamState).fov).toBe(110);
    expect((api.cmd({ snap: "car" }) as FC.FreeCamState).eye).toEqual([5, 5.2, 91]);
    const c = api.cmd({ snap: "corner", n: 3 }) as FC.FreeCamState;
    expect(c.corner).toBe(3);
    expect((api.cmd({ snap: "corner" }) as FC.FreeCamState).corner).toBe(4);
    expect(c.anchor).toMatch(/^T2 -12\.5 m, \+30 m out$/);
    G.player = null;
    expect(api.cmd({ snap: "car" })).toBe(false);
    expect((api.cmd(false) as FC.FreeCamState).open).toBe(false);
    expect(G.dbgCam).toBe(null);
  });

  it("COPY VIEW / COPY FLYBY POSE write the textarea and report the round trip", () => {
    const { api } = boot();
    api.cmd({ eye: [1, 2, 3], target: [1, 2, -97], fov: 50 });
    expect(api.copyView()).toBe("__apex.view({eye:[1,2,3],target:[1,2,-97],fov:50})");
    expect($("fc-out").hidden).toBe(false);
    const r = api.copyPose()!;
    expect(r.shot.id).toBe("freecam");
    expect($<HTMLTextAreaElement>("fc-out").value).toMatch(/"at": "corner"/);
    expect(api.state().poseErr).toMatch(/eye 0\.01 m, look 0\.2 m/);
  });

  it("the flyby editor's sub-mode: starts at the previewed frame on the flyby lens, runs its shot actions, DONE goes back", () => {
    const { G, api, pm } = boot();
    let back = 0; const got: string[] = [];
    const ok = api.enterFrom({
      eye: [10, 20, 30], target: [10, 20, -70], fov: 42, lens: "flyby",
      back: () => { back++; },
      actions: [{ label: "SET SHOT START", run: (r) => { got.push(r.shot.id!); return "Shot 1 starts here."; } }],
    });
    expect(ok).toBe(true); expect(api.isOpen()).toBe(true);
    expect(api.state().lens).toBe("flyby");
    expect(G.dbgCam!.eye).toEqual([10, 20, 30]);
    const shot = $("fc-shot");
    expect(shot.hidden).toBe(false);
    expect(shot.children.length).toBe(1);
    (shot.children[0] as HTMLElement).click();
    expect(got).toEqual(["freecam"]);
    expect($("fc-msg").textContent).toBe("Shot 1 starts here.");
    $("fc-close").click();
    expect(api.isOpen()).toBe(false);
    expect(back).toBe(1);
    expect(pm.hidden).toBe(true);
    expect(shot.hidden).toBe(true);
    api.enterFrom({ back: () => { back++; } });
    if (G.photoMode) api.close(false);                          // resume / quit
    expect(back).toBe(1);
  });

  it("wheel over Studio scroll controls or browser zoom cannot change FreeCam speed", () => {
    const { api, psPanel } = boot(); api.open();
    const child = document.createElement("button"); psPanel.appendChild(child);
    const before = api.state().speed;
    child.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true }));
    // happy-dom's WheelEvent drops the MouseEvent modifier init: set it by hand (browser zoom = ctrl+wheel).
    const zoom = new WheelEvent("wheel", { deltaY: 120 }); Object.defineProperty(zoom, "ctrlKey", { value: true }); window.dispatchEvent(zoom);
    const prevented = new WheelEvent("wheel", { deltaY: 120, cancelable: true });
    prevented.preventDefault(); window.dispatchEvent(prevented);
    expect(api.state().speed).toBe(before);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));
    expect(api.state().speed).toBeLessThan(before);
  });

  it("suspended PhotoKit effects stay hidden across frame updates and restore their prior preferences", () => {
    const { api } = boot(); api.open();
    $("fc-grid").click(); input("fc-dof-blur", 50);
    const grid = $("fc-comp-grid"), dof = $("fc-dof");
    expect(grid.hidden).toBe(false); expect(dof.hidden).toBe(false);
    api.setOverlaysVisible(false); api.decorate({ eye: [0, 0, 0], target: [0, 0, 1], fov: 60 }, 0.1);
    expect(grid.hidden).toBe(true); expect(dof.hidden).toBe(true);
    api.setOverlaysVisible(true); expect(grid.hidden).toBe(false); expect(dof.hidden).toBe(false);
    expect(api.state().grid).toBe("thirds"); expect(api.state().dofBlur).toBe(0.5);
  });

  it("SAVE / LOAD / DELETE MARK bookmark the view per circuit", () => {
    const { api, store, G } = boot(); api.open();
    api.cmd({ eye: [4, 5, 6], target: [4, 5, -94], fov: 40 });
    $<HTMLInputElement>("fc-mark-name").value = "Hairpin";
    $("fc-mark-save").click();
    expect($("fc-msg").textContent).toBe("Saved mark 1 of 12.");
    const saved = store.disk.get("freecamMarks") as Record<string, { name: string; eye: number[] }[]>;
    expect(saved["track"]![0]!.name).toBe("Hairpin");
    api.cmd({ eye: [0, 50, 0], target: [0, 50, -100] });
    $("fc-mark-load").click();
    expect($("fc-msg").textContent).toBe("Loaded “Hairpin”.");
    expect(G.dbgCam!.eye).toEqual([4, 5, 6]);
    $("fc-mark-delete").click();
    expect((store.disk.get("freecamMarks") as Record<string, unknown[]>)["track"]).toEqual([]);
    expect($<HTMLButtonElement>("fc-mark-load").disabled).toBe(true);
  });
});

/** A photo-mode mount with the FREE CAMERA panel, the shell's stand-ins around it. */
function photoBoot(opts: { flyby?: FreeCamFlyby } = {}) {
  const pm = document.createElement("div"); pm.id = "pmsettings"; document.body.appendChild(pm);
  const canvas = document.createElement("canvas"); canvas.id = "game"; document.body.appendChild(canvas);
  const toggle = document.createElement("button"); toggle.id = "pc-toggle"; document.body.appendChild(toggle);
  const S = { dbgCam: null as FreeCamView | null, paused: true, snaps: 0 };
  const pmode = mountPhotoMode(document.body, {
    gameCamera: () => ({ eye: [0, 10, 0], target: [0, 10, -1], fov: 60 }),
    setDbgCam: (c) => { S.dbgCam = c; }, dbgCam: () => S.dbgCam,
    snapGameCam: () => { S.snaps++; },
    freeCam: { track: trk, paused: () => S.paused, flyby: opts.flyby || stubFlyby(), sample: stubSample, store: mapStore(), clipboard: () => Promise.resolve(true) },
  });
  mounted.push(pmode);
  return { S, pmode, pm, canvas, toggle };
}
const key = (code: string, type: "keydown" | "keyup"): void => { window.dispatchEvent(new KeyboardEvent(type, { code, cancelable: true })); };

describe("free camera in the real photo mode (free-cam.test.mjs)", () => {
  it("speed dial drives the fly-cam, Q rolls, EXIT closes to the menu, resume closes", () => {
    const { S, pmode, pm } = photoBoot();
    const fc = pmode.freeCam!;
    fc.open();
    expect(fc.isOpen()).toBe(true); expect(pmode.isActive()).toBe(true);
    expect(S.dbgCam!.eye).toEqual([0, 10, 0]);
    input("fc-speed", 1000);
    key("KeyW", "keydown"); pmode.updatePhotoCam(0.05); key("KeyW", "keyup");
    expect(Math.abs(S.dbgCam!.eye[2] - (-10))).toBeLessThan(1e-6);
    key("KeyQ", "keydown"); pmode.updatePhotoCam(0.5); key("KeyQ", "keyup");
    expect(S.dbgCam!.roll).toBeLessThan(0);
    $("pc-exit").click();
    expect(fc.isOpen()).toBe(false); expect(pmode.isActive()).toBe(false); expect(S.dbgCam).toBe(null);
    expect(pm.hidden).toBe(false);
    fc.open();
    S.paused = false; pm.hidden = true;
    pmode.exitPhotoMode();                                        // setPaused(false) / quitToMenu
    expect(fc.isOpen()).toBe(false); expect($("freecam").hidden).toBe(true);
    expect(pm.hidden).toBe(true);
  });

  it("FREE CAMERA toggle enters and leaves photo mode; HIDE PANEL tucks the free-cam panel", () => {
    const { pmode, toggle } = photoBoot();
    toggle.click();
    expect(pmode.isActive()).toBe(true);
    expect(toggle.classList.contains("on")).toBe(true);
    expect($("photo-controls").hidden).toBe(false);
    pmode.freeCam!.open();
    $("pc-panel").click();
    expect(pmode.freeCam!.panel()!.hidden).toBe(true);
    expect(document.body.classList.contains("pc-nopanel")).toBe(true);
    expect($("pc-panel").textContent).toBe("SHOW PANEL");
    $("pc-hud").click(); expect(document.body.classList.contains("pc-uihidden")).toBe(true);
    $("pc-restore").click(); expect(document.body.classList.contains("pc-uihidden")).toBe(false);
    toggle.click();
    expect(pmode.isActive()).toBe(false);
    expect(document.body.classList.contains("photo-mode")).toBe(false);
    expect(pmode.freeCam!.panel()!.hidden).toBe(false);          // HIDE PANEL is not carried over
  });
});

describe("mount / unmount leaves nothing behind", () => {
  it("free camera: no listener on window / document / the page, no timer", () => {
    const probe = leakProbe();
    try {
      const pm = document.createElement("div"); pm.id = "pmsettings"; document.body.appendChild(pm);
      const pcFov = document.createElement("input"); pcFov.id = "pc-fov"; document.body.appendChild(pcFov);
      const G = { photoCam: { pos: [0, 0, 0] as Vec3, yaw: 0, pitch: 0, fov: 60 }, dbgCam: null as FreeCamView | null };
      const m = mountFreeCam(document.body, { photoCam: G.photoCam, dbgCam: () => G.dbgCam, track: trk, flyby: stubFlyby(), sample: stubSample, store: mapStore(), clipboard: () => Promise.resolve(true) });
      m.open(); m.copyView();
      expect(probe.liveListeners().length).toBeGreaterThan(0);
      m.unmount();
      expect(probe.liveListeners()).toEqual([]);
      expect(probe.pendingTimers()).toBe(0);
      expect(document.getElementById("freecam")).toBe(null);
      expect(document.getElementById("fc-comp-grid")).toBe(null);
      expect(document.body.classList.contains("lt-open")).toBe(false);
    } finally { probe.restore(); }
  });

  it("photo mode (with its free camera), mid-flight: no listener, no timer, the door released", () => {
    const probe = leakProbe();
    try {
      const { pmode, toggle } = photoBoot();
      mounted.pop();
      pmode.freeCam!.open();
      key("KeyW", "keydown");
      pmode.unmount();
      expect(probe.liveListeners()).toEqual([]);
      expect(probe.pendingTimers()).toBe(0);
      expect(toggle.onclick).toBe(null);
      expect(document.getElementById("photo-controls")).toBe(null);
      expect(document.body.classList.contains("photo-mode")).toBe(false);
    } finally { probe.restore(); }
  });
});

// ---- the motion integration, bit for bit ------------------------------------

/** One scripted step: inputs applied, then `dt` integrated, then dbgCam read. */
interface Step {
  keys?: [string, "keydown" | "keyup"][];
  move?: [number, number]; look?: [number, number]; mouse?: [number, number]; alt?: number;
  speed?: number; fov?: number; lens?: "race" | "flyby"; dof?: [number, number];
  dt: number;
}
const FLIGHT: Step[] = [
  { dt: 0 },
  { keys: [["KeyW", "keydown"]], dt: 1 / 60 },
  { dt: 0.016 },
  { speed: 640, dt: 1 / 30 },
  { keys: [["ShiftLeft", "keydown"]], dt: 0.021 },
  { keys: [["KeyD", "keydown"], ["ArrowLeft", "keydown"]], dt: 0.05 },
  { mouse: [13, -7], dt: 1 / 144 },
  { keys: [["ShiftLeft", "keyup"], ["KeyW", "keyup"], ["KeyR", "keydown"]], dt: 0.1 },
  { dt: 0.7 }, { dt: 0.9 }, { dt: 1.3 },
  { keys: [["KeyR", "keyup"], ["KeyD", "keyup"], ["ArrowLeft", "keyup"], ["KeyQ", "keydown"]], move: [0.31, -0.77], dt: 0.033 },
  { look: [-0.4, 0.25], dt: 0.25 },
  { keys: [["KeyQ", "keyup"], ["KeyE", "keydown"]], alt: -1, dt: 0.4 },
  { lens: "flyby", fov: 37, dof: [55, 30], dt: 0.012 },
  { keys: [["KeyE", "keyup"], ["ArrowUp", "keydown"], ["KeyS", "keydown"]], move: [0, 0], look: [0, 0], alt: 0, speed: 3, dt: 2.5 },
  { keys: [["ArrowUp", "keyup"], ["KeyF", "keydown"], ["Space", "keydown"]], dt: 0.2 },
  { keys: [["Space", "keyup"]], mouse: [-120, 300], dt: 0.08 },
  { keys: [["KeyF", "keyup"], ["KeyS", "keyup"]], lens: "race", dt: 1 / 60 },
];

/** The port: photo mode + FREE CAMERA in happy-dom, flown through FLIGHT. */
function portFlight(): unknown[] {
  const { S, pmode } = photoBoot();
  pmode.freeCam!.open();
  const frames: unknown[] = [];
  for (const st of FLIGHT) {
    for (const [code, type] of st.keys || []) key(code, type);
    if (st.move) { pmode.input.move.x = st.move[0]; pmode.input.move.y = st.move[1]; }
    if (st.look) { pmode.input.look.x = st.look[0]; pmode.input.look.y = st.look[1]; }
    if (st.mouse) { pmode.input.mouse.dx += st.mouse[0]; pmode.input.mouse.dy += st.mouse[1]; }
    if (st.alt != null) pmode.input.alt = st.alt;
    if (st.speed != null) input("fc-speed", st.speed);
    if (st.fov != null) input("fc-fov", st.fov);
    if (st.dof) { input("fc-dof-focus", st.dof[0]); input("fc-dof-blur", st.dof[1]); }
    if (st.lens) $("fc-lens-" + st.lens).click();
    pmode.updatePhotoCam(st.dt);
    frames.push(plainDeep({ cam: S.dbgCam, pc: pmode.photoCam, vertT: pmode.input.vertT }));
  }
  return frames;
}

/** f1-game: js/camera/{photo-kit,free-cam,photo-cam}.js on its mini-dom, flown through FLIGHT. */
async function f1Flight(): Promise<unknown[]> {
  const dom: MiniDom = miniDom();
  const S = stubFlyby();
  const vm = f1Vm(dom, ["js/core/log.js", "js/core/mat4.js", "js/core/clipboard.js", "js/camera/photo-kit.js", "js/camera/free-cam.js", "js/camera/photo-cam.js"], {
    FlybySeq: { FAR: S.FAR, FOG: S.FOG, poseFromWorld: S.poseFromWorld, shotFromView: S.shotFromView },
    Tracks: { sample: stubSample },
    GameAudio: { uiSelect() {}, uiTick() {} }, PerfGov: { setAutoRes() {} },
    Input: { holdTargetGone: () => false },
  });
  const G: Record<string, unknown> = {
    $: (id: string) => dom.byId(id), gfx: {}, photoCam: { pos: [0, 0, 0], pitch: 0, yaw: 0, fov: 60 },
    photoKeys: {}, photoMouse: { dx: 0, dy: 0, drag: false, pid: null, px: 0, py: 0 }, photoMove: { x: 0, y: 0 }, photoLook: { x: 0, y: 0 },
    photoAlt: 0, photoVertT: 0,
    applyResMode() {}, snapGameCam() {}, camEye: [0, 10, 0], camTgt: [0, 10, -1], camFov: 60,
    track: { total: 1000 }, paused: true, photoMode: false, dbgCam: null,
  };
  const pm = vm.get<{ create(G: unknown): { updatePhotoCam(dt: number): void; freeCam: { open(): boolean } } }>("Photomode").create(G);
  pm.freeCam.open();
  const fire = (code: string, type: string): void => { for (const fn of vm.wl[type] || []) fn({ code, type, preventDefault() {}, stopPropagation() {} }); };
  const inp = (id: string, v: number): void => { const el: MiniEl = dom.byId(id); el.value = String(v); dom.dispatch(el, { type: "input" }); };
  const frames: unknown[] = [];
  const mv = G["photoMove"] as { x: number; y: number }, lk = G["photoLook"] as { x: number; y: number }, ms = G["photoMouse"] as { dx: number; dy: number };
  for (const st of FLIGHT) {
    for (const [code, type] of st.keys || []) fire(code, type);
    if (st.move) { mv.x = st.move[0]; mv.y = st.move[1]; }
    if (st.look) { lk.x = st.look[0]; lk.y = st.look[1]; }
    if (st.mouse) { ms.dx += st.mouse[0]; ms.dy += st.mouse[1]; }
    if (st.alt != null) G["photoAlt"] = st.alt;
    if (st.speed != null) inp("fc-speed", st.speed);
    if (st.fov != null) inp("fc-fov", st.fov);
    if (st.dof) { inp("fc-dof-focus", st.dof[0]); inp("fc-dof-blur", st.dof[1]); }
    if (st.lens) dom.byId("fc-lens-" + st.lens).click();
    pm.updatePhotoCam(st.dt);
    frames.push(plainDeep({ cam: G["dbgCam"], pc: G["photoCam"], vertT: G["photoVertT"] }));
  }
  return frames;
}

describe("fly-cam motion integration (scripted flight)", () => {
  it("matches the committed f1-game reference (tests/fixtures/camera/photo-flight.json)", () => {
    const got = portFlight();
    expect(got.length).toBe(FLIGHT.length);
    expect(asJson(got)).toEqual(readFixture("photo-flight.json"));
  });

  it.skipIf(!haveF1Photo)("matches f1-game's Photomode + FreeCam + PhotoKit bit for bit", async () => {
    const want = await f1Flight();
    const got = portFlight();
    expect(bitDiff(got, want)).toEqual([]);
    maybeWriteFixture("photo-flight.json", asJson(want));
  });
});

// ---- cornerPose on a real circuit ------------------------------------------

describe.skipIf(!haveF1 || !haveF1Photo)("cornerPose vs f1-game's FreeCam on a built circuit", () => {
  it("monza: every corner, through the real planner", () => {
    const f1 = f1Cam();
    const track = f1.track("monza");
    const vmFile = "js/camera/free-cam.js";
    // FreeCam needs M4 / Log (the track VM has both) and FlybySeq (loaded there).
    const vmCtx = f1.sandbox as Record<string, unknown>;
    if (!vmCtx["FreeCam"]) runInContext(readFileSync(path.join(F1, vmFile), "utf8").replace(/^const\b/gm, "var"), vmCtx, { filename: vmFile });
    const F1FC = vmCtx["FreeCam"] as { cornerPose(t: unknown, n: number): unknown };
    const P = createFlybySeq({ corners: (def) => f1.TrackMaps.corners(def) });
    const n = P.cornerList(track).length;
    for (let i = 0; i <= n + 1; i++) {
      expect(bitDiff(plainDeep(FC.cornerPose(P, track, i)), plainDeep(F1FC.cornerPose(track, i))), `corner ${i}`).toEqual([]);
    }
  }, 600_000);
});
