// @vitest-environment happy-dom
// The GARAGE sheet (src/garage/setup-sheet.ts).
// - DOM parity: f1-game's js/garage/setup-sheet.js (SetupUI.create) runs in a
//   Node VM over this happy-dom document, beside the port, over the same
//   #carsetup markup and the same team, parts and store; every tab's rail,
//   option pane and stat bars, and the paint creator, must serialise to the
//   same HTML. Skipped where /home/f1-game is absent.
// - Behaviour, ported from f1-game tests/unit/garage-sheet-round2.test.mjs
//   (G2/G5/G6/G7, identity locks, focus after replacement),
//   setup-screens-state.test.mjs:642-716 (the draft dies with the screen,
//   aria-busy before the deferred build) and garage-followups.test.mjs:103-116
//   (stale deferred builds), with a recording stub for the shell's G.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { Car3D } from "../../../src/car/car3d";
import { Liveries, type Livery } from "../../../src/car/liveries";
import { Parts, type PartSetup } from "../../../src/car/parts";
import { Teams, type Team } from "../../../src/car/teams";
import { armConfirm, arrToHex, buildCarsetup, cssCol, hexToArr } from "../../../src/garage/index";
import { createSetupSheet, draftSkipsMesh, livDraftFrom, livDraftTo, tabSub, type SetupSheetDeps, type SetupSheetHost, type SheetCareer } from "../../../src/garage/setup-sheet";
import { createSetupTune } from "../../../src/garage/setup-tune";
import type { LiveryDesignLike } from "../../../src/garage/livery-design-editor";
import { F1_ROOT, hasF1 } from "../data/f1-vm";
import { mapStore } from "./f1-garage-vm";

const hasSheet = hasF1 && (() => { try { readFileSync(path.join(F1_ROOT, "js/garage/setup-sheet.js")); return true; } catch { return false; } })();
const read = (f: string): string => readFileSync(path.join(F1_ROOT, f), "utf8");
const LOG = { info() {}, warn() {}, error() {}, debug() {}, enabled: () => false };
const LIVERY_TEX = { NUM_FONT_IDS: ["default", "block"], SPONSOR_PACK_IDS: ["default", "clean"],
  FILL_SURFACES: [{ key: "spineTint", label: "BAND", why: "No band" }, { key: "sideTint", label: "FLANK FILL", why: "No flank" }],
  fillInert: (k: string, d: { spineLogo?: string }) => k === "sideTint" || d.spineLogo === "logo", contrast: () => 2.5, MARK_FLOOR: 4.2,
  SPINE_LOGO_IDS: ["logo", "none", "wordmark", "stripe", "ribbon", "contours"], SPINE_SIDE_IDS: ["none", "number", "wordmark", "duo"] };
const HELMETS = ["team", "solid", "cap", "band", "stripe", "chevron"];

interface Fixture {
  container: HTMLElement;
  $: (id: string) => HTMLElement;
  G: SetupSheetHost & { saved: string[]; picks: number; edits: number; store: ReturnType<typeof mapStore> };
  parts: PartSetup;
}

/** The #carsetup screen and a G over a map store (garage-sheet-round2.test.mjs harness). */
function fixture(o: { team?: string; tab?: string; stored?: PartSetup; career?: boolean; unlimited?: boolean; liveries?: Livery[]; teams?: readonly Team[] } = {}): Fixture {
  const container = document.createElement("div");
  container.appendChild(buildCarsetup());
  document.body.appendChild(container);
  const $ = (id: string): HTMLElement => container.querySelector<HTMLElement>(`[id="${id}"]`)!;
  const teams = o.teams || Teams.LIST;
  const team = teams.find((t) => t.id === (o.team || "mercedes"))!;
  const store = mapStore({ garageTab: o.tab || "team" });
  const parts: PartSetup = JSON.parse(JSON.stringify(o.stored || {})) as PartSetup;
  let fitted = "default";
  const customs: Livery[] = [];
  const owned = o.career ? new Set(Parts.CATALOG.flatMap((c) => c.options.map((x) => x.id))) : null;
  const G = {
    $, els: {}, cssCol, arrToHex, hexToArr, armConfirm, store,
    getTeamParts: () => parts,
    saveTeamParts: (_id: string, p: PartSetup) => { G.saved.push(JSON.stringify(p)); if (p !== parts) { for (const k of Object.keys(parts)) delete parts[k as keyof PartSetup]; Object.assign(parts, p); } },
    getLiveryId: () => fitted, saveLiveryId: (_t: string, id: string) => { fitted = id; },
    getCustomLiveries: () => customs.slice(), setCustomLiveries: (_t: string, l: Livery[]) => { customs.length = 0; customs.push(...l); },
    getLiveries: (t: Team) => (o.liveries || Liveries.forTeam(t)).concat(customs),
    invalidateDecalTextures: null, teamIdx: teams.indexOf(team), driverIdx: 0, soundOn: false, state: "menu",
    careerOwned: () => owned, unlimitedBudget: !!o.unlimited, peerSeats: () => [],
    teamSwatch: () => document.createElement("span"), setTeamPicker: () => { G.picks++; }, openCustomize: () => { G.edits++; },
    livDraftOverride: null, _spMeshKey: "x", setupPreviewOn: false, saved: [] as string[], picks: 0, edits: 0,
  };
  return { container, $, G: G as unknown as Fixture["G"], parts };
}
function career(tdev = 0): SheetCareer {
  return {
    inCareer: () => true, budget: () => 4000, data: () => ({ money: 9999, tdev: {} }), research: () => true, researchCost: () => 10,
    teamStats: (t) => { if (!tdev) return t.stats; const out: Record<string, number> = {}; for (const k in t.stats) out[k] = (t.stats[k] as number) + tdev; return out; },
  };
}
function sheetDeps(f: Fixture, extra: SetupSheetDeps = {}): SetupSheetDeps {
  return { teams: Teams.LIST, tune: createSetupTune(f.G.store), experiments: { presets: null, trials: null, tracks: [] },
    liveryTex: LIVERY_TEX, helmetStyles: HELMETS, surfaceInspection: null, log: LOG, ...extra };
}

afterEach(() => { document.body.replaceChildren(); });

// ── DOM parity with f1-game ─────────────────────────────────────────────────
function loadDesign(): LiveryDesignLike {
  const ctx = createContext({}); runInContext(read("js/car/livery-design.js"), ctx);
  return runInContext("LiveryDesign", ctx) as LiveryDesignLike;
}
function f1Sheet(f: Fixture, design: LiveryDesignLike): { buildSetup(): void } {
  const ctx = createContext({ document, Log: LOG, setTimeout, clearTimeout, GameAudio: {}, Car3D, Liveries, LiveryTex: LIVERY_TEX,
    Helmets: { STYLES: HELMETS }, GameStore: { store: f.G.store }, LiveryDesign: design, matchMedia: () => ({ matches: false }) });
  (ctx as { window?: unknown }).window = ctx;
  for (const file of ["js/core/mat4.js", "js/physics/consts.js", "js/car/parts.js", "js/data/teams.js", "js/garage/experience.js",
    "js/garage/setup-tune.js", "js/garage/setup-experiments.js", "js/garage/livery-design-editor.js", "js/garage/setup-sheet.js"])
    runInContext(read(file).replace(/^const\b/gm, "var"), ctx, { filename: file });
  return (runInContext("SetupUI", ctx) as { create(G: unknown): { buildSetup(): void } }).create(f.G);
}
const html = (f: Fixture): string[] => ["cs-team", "cs-budget", "cs-tabs", "cs-options", "cs-stats-inner"].map((id) => id + ":" + f.$(id).outerHTML);

describe.skipIf(!hasSheet)("DOM parity with f1-game js/garage/setup-sheet.js", () => {
  for (const team of ["mercedes", "mclaren", "haas"]) {
    it(`${team}: every tab and the paint creator serialise identically`, () => {
      const stored: PartSetup = { engine: "hybrid_max", aero: "low_drag" };
      const tabs = ["team", ...Parts.CATALOG.map((c) => c.id), "tune", "livery"];
      const run = (side: "f1" | "ts"): string[] => {
        const f = fixture({ team, stored }), design = loadDesign();
        const ui = side === "f1" ? f1Sheet(f, design) : createSetupSheet(f.G, sheetDeps(f, { liveryDesign: design }));
        const out: string[] = [];
        for (const tab of tabs) { (f.G.store.stored as Map<string, unknown>).set("garageTab", tab); f.$(`cs-tab-${tab}`)?.click(); if (!f.$(`cs-tab-${tab}`)) ui.buildSetup(); out.push(tab, ...html(f)); }
        // a part fitted through the row, then the creator
        f.$("cs-tab-brakes").click();
        (f.$("cs-options").querySelectorAll<HTMLElement>(".cs-opt")[1] as HTMLElement).click(); out.push(...html(f), f.G.saved.join(";"));
        f.$("cs-tab-livery").click();
        (f.$("cs-options").querySelector(".cs-liv-create") as HTMLElement).click(); out.push(...html(f));
        out.push(JSON.stringify(f.G.livDraftOverride));
        f.container.remove();
        return out;
      };
      const a = run("f1"), b = run("ts");
      expect(b.length).toBe(a.length);
      const all = a.join("\n");
      for (const needle of ['class="cs-opt', 'class="cs-stat-row"', 'class="cs-tune-editor"', 'class="cs-liv-editor"', 'data-liv-section="SPINE TOP',
        'class="team-card"', 'cs-inspection', "RAKE ", "MIDNIGHT ELECTRIC"]) expect(all, needle).toContain(needle);
      for (let i = 0; i < a.length; i++) expect(b[i], `[${i}] ${a[i]!.slice(0, 40)}`).toBe(a[i]);
    });
  }
});

// ── behaviour ───────────────────────────────────────────────────────────────
describe("garage sheet behaviour (garage-sheet-round2.test.mjs)", () => {
  it("G2: an era ban never erases a fitted part; the installed ruleset is put back", () => {
    const stored: PartSetup = { engine: "hybrid_max", ers: "overcharge", fuel: "custom_formula" };
    const f = fixture({ stored, career: true });
    const ban = (opt: { id: string }) => opt.id !== "overcharge";
    Parts.setLegality(ban, "powertrain");
    try {
      createSetupSheet(f.G, sheetDeps(f, { career: career() })).buildSetup();
      expect(f.G.saved.length, "opening the garage under the ban saves nothing").toBe(0);
      expect({ ...f.parts }).toEqual(stored);
      expect(Parts.legalityKey()).toBe("powertrain");
    } finally { Parts.setLegality(null, ""); }
  });

  it("G5: the stat bars read Career.teamStats (development), not the base team.stats", () => {
    const vals = (tdev: number): number[] => {
      const f = fixture({ career: true });
      createSetupSheet(f.G, sheetDeps(f, { career: career(tdev) })).buildSetup();
      const out = Array.from(f.$("cs-stats-inner").querySelectorAll(".cs-stat-val")).map((v) => Number(v.textContent));
      f.container.remove(); return out;
    };
    const team = Teams.LIST.find((t) => t.id === "mercedes")!, mods = Parts.getMods({}, team, null);
    const dev = vals(6);
    expect(dev).toEqual(Parts.STAT_KEYS.map(({ key }) => Math.round(Parts.displayStat((team.stats[key] + 6) * mods[key]))));
    expect(dev, "development moves the bars").not.toEqual(vals(0));
  });

  it("G6: a signature part row carries ONE SIGNATURE badge", () => {
    const f = fixture({ tab: "aero" });
    createSetupSheet(f.G, sheetDeps(f)).buildSetup();
    const sig = Array.from(f.$("cs-options").querySelectorAll<HTMLElement>(".cs-opt")).filter((r) => /^sig_/.test(r.dataset["csOpt"] || ""));
    expect(sig.length, "the aero tab lists signature parts").toBeGreaterThan(0);
    for (const r of sig) {
      const text = r.querySelector(".cs-opt-tag")?.textContent || "";
      expect(text.split(" · ").filter((w) => w === "SIGNATURE").length, text).toBe(1);
    }
  });

  it("G7: legends' driver chips drop the placeholder #1 but keep real numbers", () => {
    const legends = { ...Teams.LIST[0]!, id: "legends", legends: true, drivers: [{ name: "Michael Schumacher", code: "SCH", num: 1 }, { name: "Ayrton Senna", code: "SEN", num: 12 }] } as Team;
    const teams = [...Teams.LIST, legends];
    const f = fixture({ team: "legends", teams });
    createSetupSheet(f.G, sheetDeps(f, { teams })).buildSetup();
    expect(Array.from(f.$("cs-driver").querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Michael Schumacher", "#12 Ayrton Senna"]);
    f.container.remove();
    const real = fixture();
    createSetupSheet(real.G, sheetDeps(real)).buildSetup();
    expect(real.$("cs-driver").querySelector("button")!.textContent).toMatch(/^#\d+ /);
  });

  for (const state of ["race", "menu"]) {
    it("garage identity is locked only during pit work: " + state, () => {
      const f = fixture();
      (f.G as { state: string }).state = state;
      const ui = createSetupSheet(f.G, sheetDeps(f));
      ui.buildSetup();
      const card = f.$("cs-team-card") as HTMLButtonElement, edit = f.$("cs-customize") as HTMLButtonElement;
      const driver = f.$("cs-driver").children[1] as HTMLButtonElement;
      expect(card.disabled).toBe(state === "race"); expect(driver.disabled).toBe(state === "race"); expect(edit.disabled).toBe(state === "race");
      const call = (el: HTMLElement): void => { (el.onclick as (e: Event) => void)(new Event("click")); };
      call(card); call(edit); call(driver);
      expect(f.G.picks).toBe(state === "race" ? 0 : 1);
      expect(f.G.edits).toBe(state === "race" ? 0 : 1);
      expect(f.G.driverIdx).toBe(state === "race" ? 0 : 1);
      (f.G as { state: string }).state = "menu"; ui.buildSetup();
      expect((f.$("cs-team-card") as HTMLButtonElement).disabled, "return to title unlocks identity").toBe(false);
    });
  }

  it("career contract still locks team and driver at the title garage; the budget reads the balance", () => {
    const f = fixture({ career: true });
    createSetupSheet(f.G, sheetDeps(f, { career: career() })).buildSetup();
    expect((f.$("cs-team-card") as HTMLButtonElement).disabled).toBe(true);
    expect((f.$("cs-driver").children[1] as HTMLButtonElement).disabled).toBe(true);
    expect(f.$("cs-budget").textContent).toMatch(/^BALANCE 9,999 cr · FITTED \d+ \/ 4,000 cr$/);
    expect(f.$("cs-unlimited").hidden).toBe(true);
  });

  it("FREE BUILD reads as unlimited and the fill collapses", () => {
    const f = fixture({ unlimited: true });
    createSetupSheet(f.G, sheetDeps(f)).buildSetup();
    expect(f.$("cs-budget").textContent).toBe("FREE BUILD — no budget limit");
    expect(f.$("cs-budget-fill").style.transform).toBe("scaleX(0)");
    expect(f.$("cs-unlimited").textContent).toBe("∞ FREE BUILD: ON");
  });

  it("driver confirmation and a fitted livery restore focus to the replaced choice", () => {
    const f = fixture();
    createSetupSheet(f.G, sheetDeps(f)).buildSetup();
    const old = f.$("cs-options").querySelector<HTMLElement>('[data-cs-driver="1"]')!; old.focus(); old.click();
    const selected = f.$("cs-options").querySelector<HTMLElement>('[data-cs-driver="1"]')!;
    expect(old).not.toBe(selected);
    expect(document.activeElement).toBe(selected); expect(selected.getAttribute("aria-pressed")).toBe("true");
    f.container.remove();
    const liveries = [{ id: "default", name: "Works", c1: [0, 0, 0], c2: [1, 1, 1] }, { id: 'paint"[]#', name: "Imported", c1: [1, 0, 0], c2: [0, 0, 1] }] as Livery[];
    const g = fixture({ tab: "livery", liveries });
    createSetupSheet(g.G, sheetDeps(g)).buildSetup();
    const find = (): HTMLElement => Array.from(g.$("cs-options").querySelectorAll<HTMLElement>("[data-cs-livery]")).find((e) => e.dataset["csLivery"] === liveries[1]!.id)!;
    const was = find(); was.focus(); was.click();
    const now = find();
    expect(now).not.toBe(was); expect(document.activeElement).toBe(now); expect(now.getAttribute("aria-pressed")).toBe("true");
  });

  it("tabs: arrow keys move between categories and persist the choice", () => {
    const f = fixture();
    createSetupSheet(f.G, sheetDeps(f)).buildSetup();
    const tab = f.$("cs-tab-team");
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }));
    expect(f.G.store.stored.get("garageTab")).toBe(Parts.CATALOG[0]!.id);
    expect(document.activeElement).toBe(f.$(`cs-tab-${Parts.CATALOG[0]!.id}`));
    f.$("cs-tab-team").dispatchEvent(new KeyboardEvent("keydown", { key: "End", cancelable: true }));
    expect(f.G.store.stored.get("garageTab")).toBe("livery");
    expect(f.$("cs-options").classList.contains("cs-liv-grid")).toBe(true);
  });

  it("the SETUP tab's sliders write SetupTune and retitle the tab", () => {
    const f = fixture({ tab: "tune" });
    const tune = createSetupTune(f.G.store);
    createSetupSheet(f.G, sheetDeps(f, { tune })).buildSetup();
    const arb = f.$("cs-options").querySelector<HTMLInputElement>('input[data-cs-tune="arbF"]')!;
    arb.value = "9"; arb.dispatchEvent(new Event("input"));
    expect(tune.get("mercedes").arbF).toBe(9);
    expect(f.$("cs-tab-tune").querySelector(".cs-tab-cur")!.textContent).toBe("TUNED");
  });
});

describe("the paint draft (setup-screens-state.test.mjs:642-716, garage-followups.test.mjs:103-116)", () => {
  it("the paint editor and its live-preview override die with the screen", async () => {
    const f = fixture({ tab: "livery" });
    const ui = createSetupSheet(f.G, sheetDeps(f));
    ui.buildSetup();
    f.$("carsetup").hidden = false;
    (f.$("cs-options").querySelector(".cs-liv-create") as HTMLElement).click();
    expect(f.$("cs-options").querySelector(".cs-liv-editor")).toBeTruthy();
    expect(f.G.livDraftOverride && f.G.livDraftOverride.teamId).toBe("mercedes");
    expect(f.G._spMeshKey, "the first preview busts the turntable mesh").toBe("");
    f.$("carsetup").hidden = true;
    await new Promise((r) => setTimeout(r, 0));   // the MutationObserver's microtask
    expect(f.G.livDraftOverride, "the unsaved draft must not reach resolveLivery()").toBeNull();
    ui.buildSetup();
    expect(f.$("cs-options").querySelector(".cs-liv-editor"), "next visit opens the swatch grid, not the editor").toBeNull();
    expect(f.$("cs-options").classList.contains("cs-liv-grid")).toBe(true);
    ui.dispose();
  });

  it("SAVE & FIT stores a sparse livery under a fresh id and fits it", () => {
    const f = fixture({ tab: "livery" });
    const ui = createSetupSheet(f.G, sheetDeps(f));
    ui.buildSetup();
    (f.$("cs-options").querySelector(".cs-liv-create") as HTMLElement).click();
    const name = f.$("cs-options").querySelector<HTMLInputElement>(".cs-liv-ed-name")!;
    name.value = "Night Run"; name.dispatchEvent(new Event("input"));
    (f.$("cs-options").querySelector(".cs-liv-ed-save") as HTMLElement).click();
    const saved = f.G.getCustomLiveries("mercedes");
    expect(saved.length).toBe(1);
    expect(saved[0]!.name).toBe("Night Run");
    expect(saved[0]!.id).toMatch(/^custom_\d+$/);
    expect(f.G.getLiveryId("mercedes")).toBe(saved[0]!.id);
    expect(f.G.livDraftOverride).toBeNull();
    ui.dispose();
  });

  it("openSetup shows the sheet with aria-busy and builds two frames later; a stale visit never builds", () => {
    const queue: FrameRequestCallback[] = [];
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
    try {
      const f = fixture({ tab: "livery" });
      const sel = document.createElement("div"); sel.id = "select"; f.container.appendChild(sel);
      (f.G as { els: unknown }).els = { select: sel };
      const ui = createSetupSheet(f.G, sheetDeps(f));
      ui.openSetup();
      expect(f.$("carsetup").hidden).toBe(false); expect(sel.hidden).toBe(true);
      expect(f.$("carsetup").getAttribute("aria-busy")).toBe("true"); expect(f.G.setupPreviewOn).toBe(true);
      expect(f.$("cs-options").querySelector(".cs-liv-create"), "buildSetup has not run yet").toBeNull();
      queue.shift()!(0); const stale = queue.shift()!;
      ui.openSetup(); stale(0);
      expect(f.$("cs-options").querySelector(".cs-liv-create"), "a stale visit never builds").toBeNull();
      expect(f.$("carsetup").getAttribute("aria-busy")).toBe("true");
      queue.shift()!(0); queue.shift()!(0);
      expect(f.$("carsetup").getAttribute("aria-busy")).toBeNull();
      expect(f.$("cs-options").querySelector(".cs-liv-create"), "tabs built after the sheet painted").toBeTruthy();
      ui.dispose();
    } finally { window.requestAnimationFrame = raf; }
  });

  it("draft round trip, mesh-free edits and the signature tab subtitle", () => {
    const liv = { id: "test", name: "Ribbon", c1: [0, 0, 0], c2: [1, 1, 1], spineLogo: "segments", patternTint: [1, 0, 0],
      patternPlacement: "wrap", patternWidth: "80", coverFinish: "matte" };
    const d = livDraftFrom(liv, liv.name, arrToHex);
    const back = livDraftTo(d, false, hexToArr);
    for (const k of ["spineLogo", "patternTint", "patternPlacement", "patternWidth", "coverFinish"]) expect(back[k]).toEqual(liv[k as keyof typeof liv]);
    expect("finShape" in back, "a default pill stays out of the saved livery").toBe(false);
    expect("finShape" in livDraftTo(d, true, hexToArr), "the live preview keeps every key").toBe(true);
    expect(draftSkipsMesh(d, { ...d, logo: "#ff0000", patternWidth: "60" })).toBe(true);
    expect(draftSkipsMesh(d, { ...d, finShape: "shark" })).toBe(false);
    expect(draftSkipsMesh(null, d)).toBe(false);
    expect(tabSub({ id: "x", label: "Enstone Aero Kit", cost: 0, desc: "", tag: "SIGNATURE" })).toBe("Aero Kit");
    expect(tabSub({ id: "y", label: "Low Drag", cost: 0, desc: "" })).toBe("Low Drag");
  });
});
