// @vitest-environment happy-dom
/* Camera-only surface inspection. Assertions ported from f1-game
 * tests/unit/player-tools-ui.test.mjs:142-149, :297-317. */
import { describe, expect, it } from "vitest";
import { DURATION_MS, VIEWS, create, createSurfaceInspection, type InspectionCamera } from "../../../src/garage/surface-inspection";
import { f1Load, hasF1Garage, plain } from "./f1-garage-vm";

const cam = <S>(o: Partial<InspectionCamera<S>>): InspectionCamera<S> =>
  ({ capture: () => ({}) as S, show() {}, restore() {}, ...o });

describe("GarageSurfaceInspection (f1-game js/garage/surface-inspection.js)", () => {
  it("camera-only surface inspection captures once, switches immediately and restores the exact snapshot", () => {
    const before = { az: 2, pan: [1, 2, 3], spin: true }, shots: string[] = [], restores: unknown[] = [];
    let captures = 0;
    const inspection = create(cam({ capture: () => { captures++; return before; }, show: (s) => shots.push(s), restore: (s) => restores.push(s), eligible: () => true, schedule: () => 1, cancel() {} }));
    expect(inspection.inspect("cover")).toBe(true); expect(inspection.inspect("nose")).toBe(true); expect(captures).toBe(1); expect(shots).toEqual(["hero", "front"]);
    expect(inspection.end()).toBe(true); expect(restores[0]).toBe(before); expect(inspection.end()).toBe(false); expect(inspection.inspect("unknown")).toBe(false);
    expect(create(cam({ eligible: () => false })).inspect("cover")).toBe(false);
  });

  it("an inherited Object key is not a surface", () => {
    const inspection = create(cam({ schedule: () => 1 }));
    for (const k of ["constructor", "toString", "__proto__"]) expect(inspection.inspect(k)).toBe(false);
  });

  it("inspection outlines are steady, replace the previous surface and expire with exact camera restoration", () => {
    const jobs = new Map<number, () => void>(), highlights: (string | null)[] = [], restored: unknown[] = [], camera = { az: 2, el: 0.3, dist: 7, pan: [1, 2, 3], spin: false };
    let serial = 0, captures = 0, changes = 0;
    const inspection = create(cam({ capture: () => { captures++; return camera; }, restore: (s) => restored.push(s),
      highlight: (field) => { highlights.push(field); return field === "saddleTint" || field === "sideTint"; },
      schedule: (fn, ms) => { expect(ms).toBe(5000); jobs.set(++serial, fn); return serial; }, cancel: (id) => jobs.delete(id as number) }));
    inspection.onChange(() => changes++);
    inspection.inspect("saddleTint"); expect(inspection.outlined()).toBe(true); const oldTimeout = jobs.get(serial)!;
    inspection.inspect("sideTint"); expect(captures).toBe(1); expect(highlights).toEqual([null, "saddleTint", null, "sideTint"]); expect(jobs.size).toBe(1);
    oldTimeout(); expect(inspection.field()).toBe("sideTint");
    jobs.get(serial)!(); expect(inspection.field()).toBeNull(); expect(inspection.outlined()).toBe(false); expect(highlights.at(-1)).toBeNull(); expect(restored[0]).toBe(camera); expect(restored.length).toBe(1); expect(jobs.size).toBe(0); expect(changes).toBe(3);
    inspection.inspect("cover"); expect(inspection.outlined()).toBe(false); inspection.end(); expect(highlights.at(-1)).toBeNull();
  });

  it("inspection timeout updates semantic controls and disposal stops detached editor updates", () => {
    const api = createSurfaceInspection(); let timeout: () => void = () => {};
    api.bind(cam({ highlight: (field) => field === "saddleTint", schedule: (fn) => { timeout = fn; return 1; }, cancel() {} }));
    const wrap = document.createElement("section"), row = document.createElement("label"); wrap.appendChild(row); document.body.replaceChildren(wrap);
    const controls = api.controls(wrap); controls.row(row, "SADDLE", "saddleTint");
    const button = row.querySelector("button")!; button.click(); expect(button.getAttribute("aria-pressed")).toBe("true"); expect(wrap.querySelector("p")!.textContent).toMatch(/affected paint region outlined for five seconds/);
    timeout(); expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(Array.from(wrap.querySelectorAll("button")).find((b) => b.textContent === "RESTORE INSPECTION CAMERA")!.disabled).toBe(true);
    expect(wrap.querySelector("p")!.textContent).toMatch(/previous camera restored/);
    controls.dispose(); api.inspect("saddleTint"); expect(button.getAttribute("aria-pressed")).toBe("false"); api.end();
  });

  it("without a schedule hook the inspection expires on the real timer", async () => {
    let restored = 0;
    const inspection = create(cam({ restore: () => { restored++; } }));
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      inspection.inspect("halo");
      vi.advanceTimersByTime(DURATION_MS - 1); expect(inspection.field()).toBe("halo");
      vi.advanceTimersByTime(1); expect(inspection.field()).toBeNull(); expect(restored).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});

describe.skipIf(!hasF1Garage)("VIEWS matches f1-game", () => {
  it("same field → shot table", () => {
    const get = f1Load(["js/garage/surface-inspection.js"], { setTimeout, clearTimeout });
    expect(VIEWS).toEqual(plain((get("GarageSurfaceInspection") as { VIEWS: unknown }).VIEWS));
    expect(DURATION_MS).toBe((get("GarageSurfaceInspection") as { DURATION_MS: number }).DURATION_MS);
  });
});
