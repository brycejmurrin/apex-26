/** CamGroups (src/camera/cam-groups.ts). Assertions ported from f1-game
 *  tests/unit/hud-layout.test.mjs:741-751 (the CamGroups block). */
import { describe, expect, it } from "vitest";
import { CamGroups, COCKPIT_LAYOUT, HELMET_LAYOUT, ONBOARD, isOnboard, layoutSet, usesCockpitLayout } from "../../../src/camera/cam-groups";
import { f1Cam, hasCam } from "./f1-cam-vm";

describe("cam-groups", () => {
  it("one onboard table, a wheel-only cockpit-layout table, a helmet table", () => {
    expect(Object.keys(ONBOARD).sort()).toEqual(["cockpit", "helmet", "hood", "tcam", "visor"]);
    expect(Object.keys(COCKPIT_LAYOUT)).toEqual(["cockpit"]);
    expect(Object.keys(HELMET_LAYOUT)).toEqual(["helmet"]);
    for (const id in Object.assign({}, COCKPIT_LAYOUT, HELMET_LAYOUT)) expect(isOnboard(id), id + ": a wheel camera is onboard").toBe(true);
    expect(["cockpit", "helmet", "visor", "chase"].map(layoutSet)).toEqual(["cockpit", "helmet", "other", "other"]);
    for (const id of ["chase", "far", "heli", "tv", "rear"]) expect(isOnboard(id)).toBe(false);
    expect(Object.isFrozen(ONBOARD) && Object.isFrozen(COCKPIT_LAYOUT) && Object.isFrozen(CamGroups)).toBe(true);
    expect(usesCockpitLayout("cockpit")).toBe(true);
    expect(usesCockpitLayout("helmet")).toBe(false);
    expect(isOnboard("toString"), "prototype keys are not cameras").toBe(false);
  });

  it.skipIf(!hasCam)("matches f1-game cam-groups.js for every camera id", () => {
    const G = f1Cam<{ isOnboard(id: string): boolean; usesCockpitLayout(id: string): boolean; layoutSet(id: string): string; ONBOARD: object }>(["cam-groups.js"], "CamGroups");
    expect(Object.keys(ONBOARD)).toEqual(Object.keys(G.ONBOARD));
    for (const id of ["chase", "far", "drift", "cockpit", "hood", "overhead", "heli", "reverse", "side", "cinematic", "low", "tcam", "rear", "visor", "trackside", "rival", "pitwall", "drone", "tv", "helmet"]) {
      expect([isOnboard(id), usesCockpitLayout(id), layoutSet(id)]).toEqual([G.isOnboard(id), G.usesCockpitLayout(id), G.layoutSet(id)]);
    }
  });
});
