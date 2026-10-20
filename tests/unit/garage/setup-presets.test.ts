// @vitest-environment happy-dom
/* Named mechanical setups. Assertions ported from f1-game
 * tests/unit/player-tools-ui.test.mjs:113-141, :183-187, :281-296 and
 * tests/unit/garage-followups.test.mjs:219-226, plus a bit-exact comparison of
 * the pure library functions against f1-game's js/garage/setup-presets.js. */
import { describe, expect, it } from "vitest";
import { createSetupPresets } from "../../../src/garage/setup-presets";
import { createSetupTune } from "../../../src/garage/setup-tune";
import { f1Load, hasF1Garage, plain, revStore } from "./f1-garage-vm";

function presets() {
  const state = revStore();
  const tune = createSetupTune(state.store), api = createSetupPresets(tune);
  return { ...state, tune, api };
}
const buttons = (root: Element): HTMLButtonElement[] => Array.from(root.querySelectorAll("button"));

describe("SetupPresets (f1-game js/garage/setup-presets.js)", () => {
  it("named presets are per team, bounded, full validated tunes, and non-applying on save", () => {
    const h = presets(), original = h.tune.get("mercedes");
    const result = h.api.save(h.store, "mercedes", "Monza dry", { ...original, arbF: 9 }, "monza");
    expect(result.ok).toBe(true); expect(h.tune.get("mercedes").arbF).toBe(original.arbF); expect(h.api.list(h.store, "ferrari").length).toBe(0);
    expect(h.api.save(h.store, "mercedes", "MONZA DRY", original).reason).toBe("name");
    for (let i = 1; i < 12; i++) expect(h.api.save(h.store, "mercedes", "Setup " + i, original).ok).toBe(true);
    expect(h.api.save(h.store, "mercedes", "overflow", original).reason).toBe("full");
    expect(h.api.save(h.store, "ferrari", "bad", { ...original, arbF: 999 }).reason).toBe("invalid");
    expect(h.api.save(h.store, "ferrari", "bad", { ...original, brakeBias: NaN }).reason).toBe("invalid");
  });

  it("preset confirmation refuses newer local or foreign setup/library changes", () => {
    const h = presets(), current = h.tune.get("mercedes"), row = h.api.save(h.store, "mercedes", "Quick", { ...current, arbF: 9 }).row!;
    const p = h.api.preview(h.store, "mercedes", row.id)!; expect(p.changes.length).toBe(1);
    h.tune.set("mercedes", { arbR: 8 }); expect(h.api.apply(h.store, "mercedes", p).reason).toBe("changed");
    const fresh = h.api.preview(h.store, "mercedes", row.id); h.api.save(h.store, "mercedes", "Other", current);
    expect(h.api.apply(h.store, "mercedes", fresh).reason).toBe("changed");
    const latest = h.api.preview(h.store, "mercedes", row.id); h.changes.length = 0;
    expect(h.api.apply(h.store, "mercedes", latest).ok).toBe(true); expect(h.changes).toEqual(["setup.mercedes"]); expect(h.tune.get("mercedes").arbF).toBe(9);
  });

  it("preset delete leaves fitted setup unchanged and unsupported libraries untouched", () => {
    const h = presets(), current = h.tune.get("mercedes"), row = h.api.save(h.store, "mercedes", "Test", current).row!;
    h.api.remove(h.store, "mercedes", row.id); expect(h.api.list(h.store, "mercedes").length).toBe(0); expect({ ...h.tune.get("mercedes") }).toEqual({ ...current });
    h.store.write("setupPresets.mercedes", { v: 2, items: [{ unknown: true }] }); const before = h.store.get("setupPresets.mercedes", undefined);
    expect(h.api.save(h.store, "mercedes", "Other", current).reason).toBe("incompatible"); expect(h.store.get("setupPresets.mercedes", undefined)).toEqual(before);
  });

  it("preset writes disclose session-only durability rather than claiming durable storage", () => {
    const h = presets(); h.store.durable = false;
    const result = h.api.save(h.store, "mercedes", "Quota", h.tune.get("mercedes")); expect(result.ok).toBe(true); expect(result.durable).toBe(false);
  });

  it("confirmed deletion refuses a library changed by another tab", () => {
    const h = presets(), row = h.api.save(h.store, "mercedes", "One", h.tune.get("mercedes")).row!;
    const revision = h.store.keyRevision("setupPresets.mercedes"); h.api.save(h.store, "mercedes", "Two", h.tune.get("mercedes"));
    expect(h.api.remove(h.store, "mercedes", row.id, revision).reason).toBe("changed"); expect(h.api.list(h.store, "mercedes").length).toBe(2);
  });

  it("a store without write/keyRevision (set only) still saves and applies", () => {
    const values = new Map<string, unknown>();
    const store = { get: (k: string, d: unknown) => (values.has(k) ? structuredClone(values.get(k)) : d), set: (k: string, v: unknown) => { values.set(k, v); return true; } };
    const tune = createSetupTune(store), api = createSetupPresets(tune);
    const row = api.save(store, "haas", "Plain", { ...tune.get("haas"), arbR: 9 });
    expect(row).toMatchObject({ ok: true, durable: true, reason: null });
    const p = api.preview(store, "haas", row.row!.id)!;
    expect(p.setupRevision).toBeNull();
    expect(api.apply(store, "haas", p)).toEqual({ ok: true, durable: true, reason: null });
    expect(tune.get("haas").arbR).toBe(9);
  });

  it("preset contexts normalize bounded provenance, preserve old libraries and preview precise part differences", () => {
    const h = presets(), baseline = h.tune.get("haas");
    const row = h.api.save(h.store, "haas", "Dry", baseline, "monza", { v: 1, physics: "rev1", track: "monza", parts: { engine: "a" }, note: "x".repeat(300) }).row!;
    expect(row.context!.note.length).toBe(160);
    const normalized = h.api.normalize(JSON.parse(JSON.stringify({ v: 1, items: [row] }))); expect(normalized.items[0]!.context!.parts["engine"]).toBe("a");
    const same = h.api.preview(h.store, "haas", row.id, { v: 1, physics: "rev1", track: "monza", parts: { engine: "a" } })!; expect(same.contextChanges.length).toBe(0);
    const changed = h.api.preview(h.store, "haas", row.id, { v: 1, physics: "rev1", track: "monza", parts: { engine: "b" } })!; expect(changed.contextChanges.join(" ")).toMatch(/Part engine: a → b/);
    delete row.context; h.store.write("setupPresets.haas", { v: 1, items: [row] }); const legacy = h.api.preview(h.store, "haas", row.id)!;
    expect(legacy.contextChanges.join(" ")).toMatch(/unknown/); expect(h.api.apply(h.store, "haas", legacy).ok).toBe(true);
  });

  it("preset preview reveals proposed differences before confirmation and retains keyboard focus without applying", () => {
    const h = presets(), current = h.tune.get("mercedes"), preset = h.api.save(h.store, "mercedes", "Phone preview", { ...current, arbF: 9, brakeBias: 58 }).row!;
    const container = document.createElement("section"); document.body.appendChild(container);
    const ui = h.api.mount(container, { teamId: "mercedes", store: h.store });
    const pick = ui.section.querySelector("select")!, differences = ui.section.querySelector("ul")!, actions = ui.section.querySelector(".player-tool-row")!, status = ui.section.querySelector('[role="status"]')!;
    const apply = buttons(actions).find((b) => b.textContent === "PREVIEW APPLY")!;
    pick.value = preset.id; pick.onchange!(new Event("change")); apply.focus();
    const scrolls: ScrollIntoViewOptions[] = []; differences.scrollIntoView = ((options: ScrollIntoViewOptions) => { scrolls.push(options); }) as never; h.changes.length = 0;
    apply.click();
    const kids = Array.from(ui.section.children);
    expect(kids.indexOf(differences)).toBeLessThan(kids.indexOf(actions));
    expect(kids.indexOf(status)).toBeLessThan(kids.indexOf(actions));
    expect(differences.children.length).toBe(2); expect(differences.children[0]!.textContent).toMatch(/FRONT ANTI-ROLL BAR:.*→ 9/);
    expect(scrolls.length).toBe(1); expect(scrolls[0]!.block).toBe("start"); expect(document.activeElement).toBe(apply);
    expect(apply.textContent).toBe("CONFIRM APPLY"); expect(h.changes).toEqual([]); expect(h.tune.get("mercedes").arbF).toBe(current.arbF);
    apply.click();
    expect(h.changes).toEqual(["setup.mercedes"]); expect(h.tune.get("mercedes").arbF).toBe(9);
    expect(status.textContent).toBe("Mechanical setup applied");
    container.remove();
  });
});

describe.skipIf(!hasF1Garage)("SetupPresets' pure library matches f1-game's setup-presets.js", () => {
  type Lib = {
    normalize(raw: unknown): unknown; cleanContext(raw: unknown): unknown; contextDiff(a: unknown, b: unknown): unknown;
    diff(a: unknown, b: unknown): unknown;
  };
  const vmApi = (): Lib => {
    const store = { get: (_k: string, d: unknown) => d, set: () => true };
    const get = f1Load(["js/core/mat4.js", "js/physics/consts.js", "js/garage/setup-tune.js", "js/garage/setup-presets.js"], { GameStore: { store } });
    return get("SetupPresets") as Lib;
  };
  const tune = { arbF: 6, arbR: 6, rideF: 25, rideR: 60, brakeBias: 56 };
  const contexts: unknown[] = [null, undefined, 1, "x", {}, { v: 2 }, { v: 1 }, { v: 1, physics: "rev\x01one ", track: "  monza\n", parts: { engine: "a", "bad key!": "b", z: 3, Aero: "x".repeat(200) }, note: "y".repeat(300) },
    { v: 1, physics: 7, track: null, parts: null, note: "" }, { v: 1, parts: Object.fromEntries(Array.from({ length: 40 }, (_, i) => ["p" + i, "o" + i])) }];
  const libraries: unknown[] = [null, 5, { v: 2, items: [] }, { v: 1, items: "x" }, { v: 1, items: [] },
    { v: 1, items: [null, 3, { id: "a", name: "A", tune }, { id: "a", name: "dup", tune }, { id: "b", name: "  padded name that is far too long for the cap  ", tune, trackId: "t".repeat(200), at: 12, context: contexts[7] },
      { id: "bad id", name: "x", tune }, { id: "c", name: " ", tune }, { id: "d", name: "D", tune: { ...tune, arbF: 6.5 } }, { id: "e", name: "E", tune: { ...tune, brakeBias: "56" } },
      { id: "f", name: "F", tune, at: Infinity, context: null }, { id: "g", name: "G", tune, trackId: 4 }] },
    { v: 1, items: Array.from({ length: 15 }, (_, i) => ({ id: "r" + i, name: "R" + i, tune })) }];

  it("normalize over valid, damaged and oversized libraries", () => {
    const A = vmApi(), B = createSetupPresets(createSetupTune({ get: (_k, d) => d, set: () => true }));
    for (const lib of libraries) expect(B.normalize(lib), JSON.stringify(lib)).toEqual(plain(A.normalize(lib)));
  });

  it("cleanContext and contextDiff over every pair of contexts", () => {
    const A = vmApi(), B = createSetupPresets(createSetupTune({ get: (_k, d) => d, set: () => true }));
    for (const a of contexts) {
      expect(B.cleanContext(a)).toEqual(plain(A.cleanContext(a)) ?? null);
      for (const b of contexts) expect(B.contextDiff(a, b), JSON.stringify([a, b])).toEqual(plain(A.contextDiff(a, b)));
    }
  });

  it("diff names the same fields, labels and units", () => {
    const A = vmApi(), B = createSetupPresets(createSetupTune({ get: (_k, d) => d, set: () => true }));
    const next = { arbF: 9, arbR: 6, rideF: 20, rideR: 60, brakeBias: 58.5 };
    expect(B.diff(tune, next)).toEqual(plain(A.diff(tune, next)));
    expect(B.diff(tune, tune)).toEqual([]);
  });
});
