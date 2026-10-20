// @vitest-environment happy-dom
/** CockpitOpts (src/camera/cockpit-opts.ts). Assertions ported from f1-game
 *  tests/unit/cockpit-wheels.test.mjs:66-130, :410-419, :543-555 and
 *  camera-defaults.test.mjs:178-213 (turn chasing); parity against f1-game
 *  cockpit-opts.js in a VM (layouts with Object.is, stored values with the
 *  a26. ↔ apex26. key swap). */
import { describe, expect, it } from "vitest";
import { createCockpitOpts, mountCockpitOpts, parseLead, type CockpitOpts } from "../../../src/camera/cockpit-opts";
import { f1Cam, hasCam, mapStore } from "./f1-cam-vm";

function loadOpts(disk: Record<string, string> = {}, search = ""): { opts: CockpitOpts; store: ReturnType<typeof mapStore> } {
  const store = mapStore(disk);
  return { opts: createCockpitOpts({ store, search: () => search }), store };
}

describe("CockpitOpts", () => {
  it("each choice defaults to what shipped, persists, falls back, and takes a URL override", () => {
    const { opts, store } = loadOpts({});
    expect([...opts.CHOICES.wheel.values]).toEqual(["f1", "gt", "butterfly", "yoke", "endurance", "retro", "round", "none"]);
    expect([...opts.CHOICES.seat.values]).toEqual(["std", "low", "high", "fwd"]);
    expect([...opts.CHOICES.interior.values]).toEqual(["carbon", "team", "suede", "ribbed", "classic"]);
    expect([opts.wheel(), opts.seat(), opts.interior(), opts.haloSize()]).toEqual(["f1", "std", "carbon", 2]);
    opts.setWheel("retro"); opts.setSeat("high"); opts.setInterior("team");
    expect([store.disk.get("a26.cockpitWheel"), store.disk.get("a26.cockpitSeat"), store.disk.get("a26.cockpitInterior")]).toEqual(["retro", "high", "team"]);
    expect(loadOpts({ "a26.cockpitSeat": "low" }).opts.seat()).toBe("low");
    expect(loadOpts({ "a26.cockpitWheel": "unknown" }).opts.wheel()).toBe("f1");
    expect(opts.setInterior("banana")).toBe("carbon");
    const url = loadOpts({ "a26.cockpitWheel": "retro" }, "?ckwheel=none&ckseat=fwd&ckint=classic").opts;
    expect([url.wheel(), url.seat(), url.interior()]).toEqual(["none", "fwd", "classic"]);
  });

  it("HALO has four sizes plus a faired style and still reads the old ON/OFF switch", () => {
    expect([...loadOpts().opts.HALO_VALUES]).toEqual(["0", "slim", "1", "thick", "fairing"]);
    expect(["0", "slim", "1", "thick", "fairing"].map((v) => loadOpts({ "a26.cockpitHalo": v }).opts.haloSize())).toEqual([0, 1, 2, 3, 4]);
    expect(loadOpts({ "a26.cockpitHalo": "0" }).opts.halo()).toBe(false);
    expect(loadOpts({ "a26.cockpitHalo": "1" }).opts.halo()).toBe(true);
    expect(loadOpts({}, "?halo=off").opts.haloSize()).toBe(0);
    expect(loadOpts({}, "?halo=thick").opts.haloSize()).toBe(3);
    expect(loadOpts({}, "?halo=fairing").opts.haloSize()).toBe(4);
    const { opts, store } = loadOpts({});
    opts.setHalo(false); expect(store.disk.get("a26.cockpitHalo")).toBe("0");
    opts.setHalo("slim"); expect(opts.haloSize()).toBe(1);
  });

  it("a seat moves the eye and the wheel together; every wheel stays clear of the near plane", () => {
    const { opts } = loadOpts({});
    const std = opts.layout("f1", "std");
    expect([std.eyeF, std.eyeU, std.wheelY, std.wheelZ, std.wheelS]).toEqual([-0.20, 0.82, 0.70, 0.26, 0.80]);
    for (const w of opts.CHOICES.wheel.values) {
      const base = opts.layout(w, "std");
      for (const s of opts.CHOICES.seat.values) {
        const L = opts.layout(w, s);
        expect(Math.abs((L.wheelZ - L.eyeF) - (base.wheelZ - base.eyeF))).toBeLessThan(1e-9);
        expect(Math.abs((L.wheelY - L.eyeU) - (base.wheelY - base.eyeU))).toBeLessThan(1e-9);
        expect(L.wheelZ - L.eyeF).toBeGreaterThanOrEqual(0.40);
      }
    }
    expect(opts.layout("f1", "low").eyeU < std.eyeU && opts.layout("f1", "high").eyeU > std.eyeU && opts.layout("f1", "fwd").eyeF > std.eyeF).toBe(true);
    expect(opts.layout("f1", "high")).toBe(opts.layout("f1", "high"));
    expect(opts.layout("toString", "valueOf")).toBe(opts.layout("f1", "std"));
  });

  it("all modern wheels carry the readouts, and a change reaches listeners until unsubscribed", () => {
    const { opts } = loadOpts({});
    expect([...opts.CHOICES.wheel.values].map((w) => opts.wheelHasScreen(w))).toEqual([true, true, true, true, true, true, false, false]);
    const seen: string[] = [];
    const off = opts.onWheel((name, v) => seen.push(name + ":" + v));
    opts.setWheel("round"); opts.setSeat("low");
    expect(opts.wheelHasScreen()).toBe(false);
    expect(seen).toEqual(["wheel:round", "seat:low"]);
    off(); opts.setSeat("std");
    expect(seen.length).toBe(2);
  });

  it("body designs persist and take URL overrides without changing the default", () => {
    const { opts, store } = loadOpts({});
    expect(opts.body()).toBe("standard");
    opts.setBody("wide");
    expect(store.disk.get("a26.cockpitBody")).toBe("wide");
    expect(loadOpts({ "a26.cockpitBody": "wide" }).opts.body()).toBe("wide");
    expect(loadOpts({ "a26.cockpitBody": "wide" }, "?ckbody=sculpted").opts.body()).toBe("sculpted");
    expect(opts.setBody("unknown")).toBe("standard");
  });

  it("coordinated presets preserve independent choices and saved halo values", () => {
    const { opts, store } = loadOpts({});
    expect(opts.preset()).toBe("custom");
    expect(opts.setPreset("modern")).toBe("modern");
    expect([opts.body(), opts.interior(), opts.wheel(), opts.seat(), opts.haloSize()]).toEqual(["sculpted", "carbon", "f1", "std", 4]);
    opts.setSeat("low"); expect(opts.preset()).toBe("custom");
    expect(opts.setPreset("historic")).toBe("historic");
    expect([opts.body(), opts.interior(), opts.wheel(), opts.haloSize()]).toEqual(["tapered", "classic", "round", 0]);
    expect(loadOpts(Object.fromEntries(store.disk) as Record<string, string>).opts.preset()).toBe("historic");
    const before = [opts.body(), opts.wheel(), opts.haloSize()];
    opts.setPreset("custom"); opts.setPreset("unknown");
    expect([opts.body(), opts.wheel(), opts.haloSize()]).toEqual(before);
  });

  it("cockpit turn chasing is a 0–1 look-ahead blend, shipped at 0.4", () => {
    const { opts } = loadOpts();
    expect(opts.LEAD_DEFAULT).toBe(0.4);
    expect(opts.KEY_LEAD).toBe("a26.cockpitTurnChaseLead");
    expect(parseLead("1", null)).toBe(1);
    expect(parseLead("0", null)).toBe(0);
    expect(parseLead("0.8", null)).toBe(0.8);
    expect(parseLead("80", null)).toBe(0.8);
    expect(parseLead(null, "1")).toBe(0.35);
    expect(parseLead(null, "100")).toBe(1);
    expect(parseLead(null, null)).toBe(null);
    expect(loadOpts({ "a26.cockpitTurnChase": "1" }).opts.turnChaseLead()).toBe(0.35);
    expect(loadOpts({ "a26.cockpitTurnChase": "0" }).opts.turnChaseLead()).toBe(0);
    expect(loadOpts({ "a26.cockpitTurnChaseLead": "0.8", "a26.cockpitTurnChase": "0" }).opts.turnChaseLead()).toBe(0.8);
    expect(loadOpts({}).opts.turnChaseLead()).toBe(0.4);
    expect(loadOpts({}, "?turnchase=off").opts.turnChase()).toBe(false);
    const { opts: o2, store } = loadOpts();
    expect(o2.setTurnChaseLead(0.456)).toBe(0.456);
    expect(store.disk.get("a26.cockpitTurnChaseLead")).toBe("0.46");
  });

  it("mountCockpitOpts builds the SETTINGS › COCKPIT fold with f1-game's ids and writes through", () => {
    const { opts, store } = loadOpts({});
    const panel = document.createElement("div");
    const tools = document.createElement("details"); tools.id = "pm-visual-tuners";
    panel.appendChild(tools);
    document.body.appendChild(panel);
    let clicks = 0, previews = 0;
    const m = mountCockpitOpts(panel, { opts, uiSelect: () => { clicks++; },
      preview: (content) => { previews++; const s = document.createElement("section"); s.id = "ckpreview"; content.appendChild(s); return { unmount: () => s.remove() }; } });
    const fold = document.getElementById("pm-cockpit");
    expect(fold?.nextElementSibling).toBe(tools);
    expect(document.getElementById("pm-cockpit-sum")?.textContent).toBe("COCKPIT · F1 2026");
    for (const id of ["pm-ckpreset", "pm-ckwheel", "pm-ckbody", "pm-ckseat", "pm-halo", "pm-ckint", "pm-turnchase"]) expect(document.getElementById(id), id).not.toBe(null);
    const wheel = document.getElementById("pm-ckwheel-sel") as HTMLSelectElement;
    wheel.value = "round"; wheel.dispatchEvent(new Event("change"));
    expect(opts.wheel()).toBe("round");
    expect(store.disk.get("a26.cockpitWheel")).toBe("round");
    expect(clicks).toBe(1);
    expect(document.getElementById("pm-cockpit-sum")?.textContent).toBe("COCKPIT · CLASSIC");
    (document.getElementById("pm-halo-prev") as HTMLButtonElement).click();
    expect(opts.haloSetting()).toBe("slim");
    opts.setPreset("historic");
    expect((document.getElementById("pm-ckwheel-sel") as HTMLSelectElement).value).toBe("round");
    expect((document.getElementById("pm-ckpreset-sel") as HTMLSelectElement).value).toBe("historic");
    const lead = document.getElementById("pm-turnchase") as HTMLInputElement;
    expect(lead.value).toBe("40");
    lead.value = "75"; lead.dispatchEvent(new Event("input"));
    expect(opts.turnChaseLead()).toBe(0.75);
    expect(document.getElementById("pm-turnchase-v")?.textContent).toBe("75%");
    expect(previews).toBe(1);
    expect(document.getElementById("ckpreview")).not.toBe(null);
    m.unmount();
    expect(document.getElementById("pm-cockpit")).toBe(null);
    expect(document.getElementById("ckpreview")).toBe(null);
    opts.setWheel("gt");   // unsubscribed listeners do not touch removed DOM
    panel.remove();
  });

  it.skipIf(!hasCam)("bit-exact against f1-game cockpit-opts.js: layouts, choices, presets, stored values", () => {
    const toVm = (k: string): string => k.replace(/^a26\./, "apex26.");
    const run = (disk: Record<string, string>, search: string): { a: CockpitOpts; b: CockpitOpts; sa: ReturnType<typeof mapStore>; sb: ReturnType<typeof mapStore> } => {
      const sb = mapStore(Object.fromEntries(Object.entries(disk).map(([k, v]) => [toVm(k), v])));
      const b = f1Cam<CockpitOpts>(["cockpit-opts.js"], "CockpitOpts", { GameStore: { store: sb }, location: { search } });
      const { opts: a, store: sa } = loadOpts(disk, search);
      return { a, b, sa, sb };
    };
    for (const search of ["", "?ckwheel=round&ckseat=low", "?halo=on&turnchase=55", "?turnchase=%E0%A4%A"]) {
      const { a, b, sa, sb } = run({ "a26.cockpitInterior": "suede", "a26.cockpitTurnChase": "1" }, search);
      for (const w of [...a.CHOICES.wheel.values, "bogus"]) for (const s of [...a.CHOICES.seat.values, "bogus"]) {
        const L = a.layout(w, s), M = b.layout(w, s);
        for (const k of ["eyeF", "eyeU", "wheelY", "wheelZ", "wheelS"] as const) expect(Object.is(L[k], M[k])).toBe(true);
      }
      expect([a.wheel(), a.seat(), a.body(), a.interior(), a.haloSize(), a.turnChaseLead(), a.preset()])
        .toEqual([b.wheel(), b.seat(), b.body(), b.interior(), b.haloSize(), b.turnChaseLead(), b.preset()]);
      for (const p of ["historic", "modern", "custom"]) expect(a.setPreset(p)).toBe(b.setPreset(p));
      for (const v of [0, 0.333, 1, 37, 101, "x", -2]) expect(Object.is(a.setTurnChaseLead(v), b.setTurnChaseLead(v))).toBe(true);
      expect(a.setHalo(true)).toBe(b.setHalo(true));
      expect([...sa.disk].map(([k, v]) => [toVm(k), v])).toEqual([...sb.disk]);
    }
  });
});
