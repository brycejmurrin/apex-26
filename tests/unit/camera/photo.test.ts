// @vitest-environment happy-dom
/**
 * Photo mode and its kit: src/camera/photo-kit.ts (f1-game
 * tests/unit/photo-kit.test.mjs ported, plus the framing/lens helpers held bit
 * for bit against f1-game's PhotoKit and a committed fixture) and
 * src/camera/photo-cam.ts's key / hold-button handling (f1-game
 * tests/unit/photomode-hold.test.mjs, the photo-mode cases).
 */
import { afterEach, describe, expect, it } from "vitest";
import * as PK from "../../../src/camera/photo-kit";
import { createPhotoInput, integratePhotoCam, mountPhotoMode, type PhotoModeMount } from "../../../src/camera/photo-cam";
import type { FreeCamView } from "../../../src/camera/free-cam";
import { mapStore } from "./f1-cam-vm";
import { bitDiff } from "./f1-flyby-vm";
import { asJson, f1Vm, haveF1Photo, maybeWriteFixture, plainDeep, readFixture } from "./f1-photo-vm";

const mounted: { unmount(): void }[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
  document.body.replaceChildren(); document.body.className = "";
});

describe("PhotoKit (photo-kit.test.mjs)", () => {
  it("nextGrid cycles off → thirds → golden → off", () => {
    expect(PK.nextGrid("off")).toBe("thirds");
    expect(PK.nextGrid("thirds")).toBe("golden");
    expect(PK.nextGrid("golden")).toBe("off");
    expect(PK.nextGrid("bogus")).toBe("thirds");
  });

  it("saveMark / marksFor round-trip per track, capped at MAX_MARKS", () => {
    const store = mapStore();
    for (let i = 0; i < PK.MAX_MARKS + 3; i++) PK.saveMark(store, "monza", { name: "m" + i, eye: [i, 2, 0], target: [i, 1, 10], fov: 50, roll: 0 });
    const list = PK.marksFor(store, "monza");
    expect(list.length).toBe(PK.MAX_MARKS);
    expect(list[0]!.name).toBe("m3");
    expect(PK.marksFor(store, "spa").length).toBe(0);
  });

  it("applyDof writes cam.dof and drives overlay CSS vars", () => {
    const cam: PK.DofCam = {};
    const overlay = document.createElement("div"); overlay.hidden = true;
    const r = PK.applyDof(cam, 0.5, 0.5, overlay);
    expect(cam.dof).toEqual({ focus: 0.5, blur: 0.5 });
    expect(r.blur).toBe(0.5);
    expect(overlay.hidden).toBe(false);
    expect(overlay.style.getPropertyValue("--fc-dof-blur")).toBe("3.00px");
    expect(overlay.style.getPropertyValue("--fc-dof-clear")).toBe("39%");
    expect(overlay.style.getPropertyValue("--fc-dof-soft")).toBe("70%");
    PK.applyDof(cam, 0.5, 0, overlay);
    expect(overlay.hidden).toBe(true);
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
  });

  it("named bookmarks remain independently reachable after deleting a selected older mark", () => {
    const store = mapStore();
    for (let i = 0; i < 12; i++) PK.saveMark(store, "spa", { name: "Angle " + i, eye: [i, 2, 3], target: [4, 5, 6], fov: 35 + i, roll: i });
    const before = PK.marksFor(store, "spa");
    expect(before[0]!.name).toBe("Angle 0"); expect(before[5]!.eye[0]).toBe(5);
    PK.deleteMark(store, "spa", 5); const remaining = PK.marksFor(store, "spa");
    expect(remaining.length).toBe(11); expect(remaining[5]!.name).toBe("Angle 6");
    PK.saveMark(store, "spa", { name: "Replacement", eye: [90, 2, 3], target: [4, 5, 6] });
    expect(PK.marksFor(store, "spa")[0]!.name).toBe("Angle 0");
    PK.saveMark(store, "spa", { name: "Thirteenth", eye: [99, 2, 3], target: [4, 5, 6] });
    expect(PK.marksFor(store, "spa")[0]!.name).toBe("Angle 1");
  });

  it("bookmarks live under a26.freecamMarks, never f1-game's apex26.", () => {
    const store = mapStore();
    PK.saveMark(store, "monza", { eye: [1, 2, 3], target: [4, 5, 6] }, () => 77);
    expect([...store.disk.keys()]).toEqual(["freecamMarks"]);   // the CamStore prefixes it (src/camera/store.ts)
    expect(PK.marksFor(store, "monza")[0]).toEqual({ name: "Mark 1", eye: [1, 2, 3], target: [4, 5, 6], fov: 60, roll: 0, t: 77 });
  });

  it("overlays mount once by id and come down with remove()", () => {
    const a = PK.mountOverlays(document.body, document);
    const b = PK.mountOverlays(document.body, document);
    expect(b.grid).toBe(a.grid); expect(b.dof).toBe(a.dof);
    expect(PK.setGrid(a.grid, "golden")).toBe("golden");
    expect(a.grid!.dataset["grid"]).toBe("golden"); expect(a.grid!.hidden).toBe(false);
    expect(PK.setGrid(a.grid, "nope")).toBe("off"); expect(a.grid!.hidden).toBe(true);
    PK.showOverlays(false, a.grid, a.dof);
    b.remove();                                              // created nothing: removes nothing
    expect(document.getElementById("fc-comp-grid")).not.toBe(null);
    a.remove();
    expect(document.getElementById("fc-comp-grid")).toBe(null);
    expect(document.getElementById("fc-dof")).toBe(null);
  });
});

// ---- the framing / lens helpers, bit for bit ---------------------------------

/** A stand-in overlay both sides write to: records exactly what PhotoKit sets. */
function fakeOverlay() {
  const o = { hidden: true, attrs: {} as Record<string, string>, vars: {} as Record<string, string>, dataset: {} as Record<string, string>,
    style: { setProperty: (k: string, v: string) => { o.vars[k] = v; } }, setAttribute: (k: string, v: string) => { o.attrs[k] = v; } };
  return o;
}
const DOF_CASES: [unknown, unknown][] = [[0.4, 0], [0.5, 0.5], [0, 1], [1, 0.019], [1, 0.02], [0.33, 0.77], [-3, 9], ["0.6", "0.25"], [NaN, Infinity], [null, undefined], [0.123456, 0.987654]];
const MARKS: Record<string, unknown>[] = [
  { name: "Parabolica", eye: [10.25, 3.5, -7], target: [0, 1, 0], fov: 47.5, roll: 12 },
  { eye: ["1", 2, 3], target: [4, "5", 6], fov: 300, roll: -90 },
  { name: "x".repeat(60), eye: [1, 1, 1], target: [2, 2, 2], fov: "junk", roll: NaN },
  { name: "", eye: [0, 0, 0], target: [0, 0, -1], fov: 19.9, roll: 44.9 },
];

/** Run PhotoKit's pure helpers through one script; `K` is either side's PhotoKit. */
function kitScript(K: typeof PK, store: ReturnType<typeof mapStore>, now?: () => number): unknown {
  const out: Record<string, unknown> = {};
  out["dof"] = DOF_CASES.map(([f, b]) => {
    const cam: Record<string, unknown> = {}, ov = fakeOverlay();
    const r = K.applyDof(cam as PK.DofCam, f, b, ov as unknown as HTMLElement);
    return { r, cam, hidden: ov.hidden, attrs: ov.attrs, vars: ov.vars };
  });
  out["grid"] = ["off", "thirds", "golden", "nope", ""].map((g) => {
    const ov = fakeOverlay();
    return { next: K.nextGrid(g), set: K.setGrid(ov as unknown as HTMLElement, g), data: ov.dataset, hidden: ov.hidden };
  });
  const lists: unknown[] = [];
  for (const m of MARKS) lists.push(now ? K.saveMark(store, "monza", m as unknown as PK.MarkInput, now) : K.saveMark(store, "monza", m as unknown as PK.MarkInput));
  for (let i = 0; i < 14; i++) lists.push(now ? K.saveMark(store, "spa", { name: "s" + i, eye: [i, i, i], target: [0, 0, 0] }, now) : K.saveMark(store, "spa", { name: "s" + i, eye: [i, i, i], target: [0, 0, 0] }));
  lists.push(K.deleteMark(store, "monza", 1), K.deleteMark(store, "monza", 9), K.deleteMark(store, "monza", -1), K.deleteMark(store, "spa", 0.7));
  lists.push(K.saveMark(store, "", MARKS[0] as unknown as PK.MarkInput), K.saveMark(null, "monza", MARKS[0] as unknown as PK.MarkInput));
  out["marks"] = lists;
  out["store"] = store.disk.get("freecamMarks");
  return plainDeep(out);
}

describe("PhotoKit framing / lens / bookmark maths", () => {
  it("matches the committed f1-game reference (tests/fixtures/camera/photo-kit.json)", () => {
    expect(asJson(kitScript(PK, mapStore(), () => 1234))).toEqual(readFixture("photo-kit.json"));
  });

  it.skipIf(!haveF1Photo)("matches f1-game's PhotoKit bit for bit", () => {
    const vm = f1Vm(null, ["js/core/mat4.js", "js/camera/photo-kit.js"], { Log: { info() {} }, Date: { now: () => 1234 } });
    const want = kitScript(vm.get<typeof PK>("PhotoKit"), mapStore());
    const got = kitScript(PK, mapStore(), () => 1234);
    expect(bitDiff(got, want)).toEqual([]);
    maybeWriteFixture("photo-kit.json", asJson(want));
  });
});

// ---- photo mode's keys and hold buttons (photomode-hold.test.mjs) -----------

function boot(): { pm: PhotoModeMount; panel: HTMLElement; S: { dbgCam: FreeCamView | null } } {
  const panel = document.createElement("div"); panel.id = "ps-panel"; document.body.appendChild(panel);
  const S = { dbgCam: null as FreeCamView | null };
  const pm = mountPhotoMode(document.body, {
    gameCamera: () => ({ eye: [0, 0, 0], target: [0, 0, -1], fov: 60 }),
    setDbgCam: (c) => { S.dbgCam = c; }, dbgCam: () => S.dbgCam,
  });
  mounted.push(pm);
  return { pm, panel, S };
}
const ev = (code: string, type: "keydown" | "keyup" = "keydown"): KeyboardEvent => new KeyboardEvent(type, { code, cancelable: true });
const send = (code: string, type: "keydown" | "keyup"): void => { window.dispatchEvent(ev(code, type)); };

describe("photo mode keys and holds (photomode-hold.test.mjs)", () => {
  it("Photo Studio buttons keep activation and arrows while WASD still flies and keyups release", () => {
    const { pm, panel } = boot();
    pm.enterPhotoMode();
    const button = document.createElement("button"); panel.appendChild(button); button.focus();
    for (const code of ["Space", "Enter", "NumpadEnter", "ArrowUp", "ArrowLeft"]) {
      const e = ev(code); window.dispatchEvent(e); expect(e.defaultPrevented, code).toBe(false);
    }
    const k = pm.input.keys;
    expect(k.up || k.pu || k.yl || k.w).toBe(false);
    const move = ev("KeyW"); window.dispatchEvent(move); pm.updatePhotoCam(0.05);
    expect(move.defaultPrevented).toBe(true);
    expect(pm.photoCam.pos[2]).toBeLessThan(-1);
    const field = document.createElement("input"); panel.appendChild(field); field.focus();
    k.w = false;
    const editing = ev("KeyW"); window.dispatchEvent(editing);
    expect(editing.defaultPrevented).toBe(false);
    expect(k.w).toBe(false);
    k.w = true; k.up = true;
    send("KeyW", "keyup"); send("Space", "keyup");
    expect(k.w).toBe(false); expect(k.up).toBe(false);
    const escape = ev("Escape"); window.dispatchEvent(escape); expect(escape.defaultPrevented).toBe(false);
  });

  it("either UP key can be released while its other physical alias keeps flying upward", () => {
    for (const first of ["KeyR", "Space"]) {
      const { pm } = boot(), second = first === "KeyR" ? "Space" : "KeyR";
      pm.enterPhotoMode();
      send(first, "keydown"); send(first, "keydown"); send(second, "keydown");
      send(first, "keyup");
      pm.updatePhotoCam(0.1);
      expect(pm.photoCam.pos[1]).toBeGreaterThan(0);
      send(second, "keyup");
      const height = pm.photoCam.pos[1]; pm.updatePhotoCam(0.1);
      expect(pm.photoCam.pos[1]).toBe(height);
      mounted.pop()!.unmount();
    }
  });

  it("either Shift can be released while the other keeps the photo camera boosted", () => {
    for (const first of ["ShiftLeft", "ShiftRight"]) {
      const { pm } = boot(), second = first === "ShiftLeft" ? "ShiftRight" : "ShiftLeft";
      pm.enterPhotoMode();
      send("KeyW", "keydown"); send(first, "keydown"); send(first, "keydown"); send(second, "keydown");
      send(first, "keyup"); pm.updatePhotoCam(0.1);
      const held = -pm.photoCam.pos[2];
      send(second, "keyup"); pm.updatePhotoCam(0.1);
      const normal = -pm.photoCam.pos[2] - held;
      expect(held).toBeGreaterThan(normal * 2);
      mounted.pop()!.unmount();
    }
  });

  it("ignored Studio Space and stale alias keyups do not cancel a different held key", () => {
    const { pm, panel } = boot();
    pm.enterPhotoMode(); send("KeyR", "keydown");
    const button = document.createElement("button"); panel.appendChild(button); button.focus();
    send("Space", "keydown"); send("Space", "keyup"); pm.updatePhotoCam(0.1);
    expect(pm.photoCam.pos[1]).toBeGreaterThan(0);
    send("ShiftLeft", "keydown"); send("ShiftRight", "keydown");
    window.dispatchEvent(new Event("blur"));
    expect(pm.input.keys.up).toBe(false); expect(pm.input.keys.boost).toBe(false);
    send("ShiftLeft", "keydown"); send("ShiftLeft", "keyup");
    expect(pm.input.keys.boost).toBe(false);
    button.blur(); send("Space", "keydown"); send("KeyR", "keyup");
    const before = pm.photoCam.pos[1]; pm.updatePhotoCam(0.1);
    expect(pm.photoCam.pos[1]).toBeGreaterThan(before);
    pm.exitPhotoMode(); pm.enterPhotoMode();
    send("KeyR", "keydown"); send("KeyR", "keyup");
    const reset = pm.photoCam.pos[1]; pm.updatePhotoCam(0.1);
    expect(pm.photoCam.pos[1]).toBe(reset);
  });

  it("fly-cam UP hold survives the boundary pointerleave and a capture steal; a hidden button releases", () => {
    const { pm } = boot();
    const el = document.getElementById("pc-up")!;
    const pe = (type: string, pointerId: number): Event => new PointerEvent(type, { pointerId, cancelable: true });
    el.dispatchEvent(pe("pointerdown", 7));
    expect(pm.input.alt).toBe(1);
    el.dispatchEvent(pe("pointerleave", 7));
    expect(pm.input.alt).toBe(1);
    el.dispatchEvent(pe("lostpointercapture", 7));
    expect(pm.input.alt).toBe(1);
    el.hidden = true;
    el.dispatchEvent(pe("lostpointercapture", 7));
    expect(pm.input.alt).toBe(0);
    el.hidden = false;
    el.dispatchEvent(pe("pointerdown", 8));
    expect(pm.input.alt).toBe(1);
    el.dispatchEvent(pe("pointerup", 8));
    expect(pm.input.alt).toBe(0);
  });

  it("opposite altitude holds cancel together and releasing either preserves the other pointer", () => {
    for (const first of ["up", "down"]) {
      const { pm } = boot(), second = first === "up" ? "down" : "up";
      const pe = (type: string, pointerId: number): Event => new PointerEvent(type, { pointerId });
      document.getElementById("pc-" + first)!.dispatchEvent(pe("pointerdown", 1));
      document.getElementById("pc-" + second)!.dispatchEvent(pe("pointerdown", 2));
      expect(pm.input.alt).toBe(0);
      document.getElementById("pc-" + first)!.dispatchEvent(pe("pointerup", 1));
      expect(pm.input.alt).toBe(second === "up" ? 1 : -1);
      document.getElementById("pc-" + second)!.dispatchEvent(pe("pointercancel", 2));
      expect(pm.input.alt).toBe(0);
      mounted.pop()!.unmount();
    }
  });

  it("a thumbstick drives its vector from the pointer and lets go when the stick is taken away", () => {
    const { pm } = boot();
    const stick = document.getElementById("pc-move")!;
    stick.getBoundingClientRect = () => ({ left: 100, top: 200, width: 118, height: 118, right: 218, bottom: 318, x: 100, y: 200, toJSON() { return {}; } });
    stick.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 3, clientX: 159 + 59, clientY: 259 }));
    expect(pm.input.move.x).toBe(1); expect(pm.input.move.y).toBe(0);
    stick.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientX: 159, clientY: 259 + 300 }));
    expect(pm.input.move.y).toBe(1);
    stick.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 3 }));
    expect(pm.input.move.x).toBe(0); expect(pm.input.move.y).toBe(0);
  });

  it("the canvas drag belongs to one pointer and feeds the look", () => {
    const canvas = document.createElement("canvas"); canvas.id = "game"; document.body.appendChild(canvas);
    const { pm } = boot();
    pm.enterPhotoMode();
    canvas.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 10, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, clientX: 500, clientY: 500 }));
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 30, clientY: 5 }));
    expect(pm.input.mouse.dx).toBe(20); expect(pm.input.mouse.dy).toBe(-5);
    window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 2 }));
    expect(pm.input.mouse.drag).toBe(true);
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    expect(pm.input.mouse.drag).toBe(false);
  });

  it("integratePhotoCam: the vertical ramp starts at 12% and reaches full speed after 2.2 s", () => {
    const cam = { pos: [0, 0, 0] as [number, number, number], yaw: 0, pitch: 0, fov: 60 };
    const inp = createPhotoInput();
    inp.keys.up = true;
    integratePhotoCam(cam, inp, 10, 0.1);
    expect(cam.pos[1]).toBeCloseTo(10 * 0.1 * (0.12 + 0.88 * Math.pow(0.1 / 2.2, 1.6)), 12);
    integratePhotoCam(cam, inp, 10, 3);
    expect(inp.vertT).toBeCloseTo(3.1, 12);
    inp.keys.up = false;
    integratePhotoCam(cam, inp, 10, 0.1);
    expect(inp.vertT).toBe(0);
  });
});
