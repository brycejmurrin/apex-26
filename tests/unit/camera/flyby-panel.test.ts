// @vitest-environment happy-dom
/**
 * FLYBY SHOT EDITOR — the half that is data, not pixels (src/camera/flyby-panel.ts),
 * and the guarded lazy doors both camera editors open through (+ the CAMERA
 * TUNER boot, src/camera/cam-tuner-boot.ts). Ported from f1-game
 * tests/unit/flyby-panel.test.mjs (the list algebra, the validators, the saved
 * list, the deferred-door races); the bake tool's half (tools/gen/bake-flyby.mjs)
 * is not ported and its cases are not either. The list operations are held bit
 * for bit against f1-game's FlybyPanel (node:vm) and a committed fixture.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT, type FlybyShot } from "../../../src/camera/flyby-seq";
import * as FP from "../../../src/camera/flyby-panel";
import { createCamTunerBoot } from "../../../src/camera/cam-tuner-boot";
import { setDataLog } from "../../../src/data/log";
import { mapStore } from "./f1-cam-vm";
import { bitDiff } from "./f1-flyby-vm";
import { asJson, f1Vm, haveF1Photo, maybeWriteFixture, plainDeep, readFixture } from "./f1-photo-vm";

/** A minimal list that passes everything, as the starting point for each case. */
function goodList(): FlybyShot[] {
  const shot = (id: string, at: string): FlybyShot => ({
    id, dur: 0.5, ease: "inOut",
    eye: [{ at, off: -40, x: 8, y: 6 }, { at, off: 10, x: 6, y: 5 }],
    look: [{ at, off: 0, x: 0, y: 0.8 }, { at, off: 40, x: 0, y: 0.8 }],
    fov: [36, 40],
  });
  return [shot("one", "start"), shot("two", "corner")];
}
type Loose = Record<string, unknown>;
const loose = (v: unknown): Loose[] => v as Loose[];

function withLog<T>(fn: (warned: string[]) => T): T {
  const warned: string[] = [];
  const prev = setDataLog({ info() {}, warn: (m) => { warned.push(String(m)); } });
  try { return fn(warned); } finally { setDataLog(prev); }
}

describe("the list algebra (flyby-panel.test.mjs)", () => {
  it("the pickers reach every corner, a normalised one-shot list, and name the height offset", () => {
    for (let n = 1; n <= 18; n++) expect(FP.CORNER_NS.includes(String(n))).toBe(true);
    const one = FP.normaliseDurs([goodList()[0]!]);
    expect(one[0]!.dur!).toBeLessThanOrEqual(FP.DUR.max);
    expect(FP.fieldLabel("centre", "y")).toBe("HEIGHT OFFSET");
    expect(FP.fieldLabel("landmark", "y")).toBe("HEIGHT OFFSET");
    expect(FP.fieldLabel("corner", "y")).toBe(FP.FIELD.y.label);
  });

  it("#1575: radius-authored editor fields display their live metre equivalent", () => {
    expect(FP.metricValue("distR", 1.2, 500)).toBe("600 m");
    expect(FP.metricValue("yR", 0.3, 500)).toBe("150 m");
    expect(FP.metricValue("x", 4, 500)).toBe(null);
  });

  it("the module freezes and exports its pure operations", () => {
    expect(Object.isFrozen(FP.FlybyPanelOps)).toBe(true);
    for (const fn of ["addShot", "duplicateShot", "deleteShot", "moveShot", "normaliseDurs", "shotErrors", "validateShots", "switchPoseAt", "toBlob"]) {
      expect(typeof (FP.FlybyPanelOps as unknown as Loose)[fn], fn).toBe("function");
    }
  });

  it("add inserts AFTER the selection and never collides an id", () => {
    const before = goodList();
    const after = FP.addShot(before, 0);
    expect(after.map((s) => s.id)).toEqual(["one", "shot", "two"]);
    expect(before.map((s) => s.id)).toEqual(["one", "two"]);
    expect(FP.validateShots(FP.normaliseDurs([after[1]!]))).toEqual([]);
  });

  it("duplicate copies the shot and renames the copy", () => {
    const out = FP.duplicateShot(goodList(), 0);
    expect(out.map((s) => s.id)).toEqual(["one", "one-2", "two"]);
    expect(out[1]!.eye).toEqual(out[0]!.eye);
    out[1]!.eye[0]!.x = 99;
    expect(out[0]!.eye[0]!.x).not.toBe(99);
  });

  it("delete removes one shot and refuses the last", () => {
    const out = FP.deleteShot(goodList(), 0);
    expect(out.map((s) => s.id)).toEqual(["two"]);
    expect(FP.deleteShot(out, 0).map((s) => s.id)).toEqual(["two"]);
  });

  it("reorder moves a shot and ignores a move off either end", () => {
    const list = goodList();
    expect(FP.moveShot(list, 1, -1).map((s) => s.id)).toEqual(["two", "one"]);
    expect(FP.moveShot(list, 0, -1).map((s) => s.id)).toEqual(["one", "two"]);
    expect(FP.moveShot(list, 1, 1).map((s) => s.id)).toEqual(["one", "two"]);
  });

  it("normalise rescales durations to sum to exactly 1", () => {
    const out = FP.normaliseDurs(goodList().map((s) => ({ ...s, dur: 0.4 })));
    const sum = out.reduce((a, s) => a + s.dur!, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
    expect(Math.abs(out[0]!.dur! - out[1]!.dur!)).toBeLessThan(1e-6);
  });

  it("switching a pose's anchor carries what the new anchor can still use", () => {
    const pose = { at: "corner", n: "first", off: -40, x: 8, y: 6 };
    const centre = FP.switchPoseAt(pose, "centre");
    expect(centre.at).toBe("centre");
    expect(centre.y).toBe(6);
    expect(centre.off).toBe(undefined);
    expect(typeof centre.distR).toBe("number");
    expect(FP.switchPoseAt(pose, "nonsense").at).toBe("corner");
  });

  it("COPY VALUES emits the one name bake-flyby.mjs accepts", () => {
    expect(FP.toBlob(FP.normaliseDurs(goodList()))).toMatch(/^window\.FlybyShots = \[/);
  });

  it("the shipped DEFAULT passes the rules the editor enforces, fields it leaves out included", () => {
    expect(FP.shotErrors(DEFAULT)).toEqual([]);
    expect(FP.validateShots(DEFAULT)).toEqual([]);
  });

  it("a present pose field must be a finite number inside its slider range", () => {
    const poison = (mut: (p: Loose) => void): string[] => { const l = goodList(); mut(l[0]!.eye[0] as Loose); return FP.shotErrors(l); };
    expect(poison((p) => { p["x"] = "abc"; })[0]).toMatch(/eye\[0\] x must be a number/);
    expect(poison((p) => { p["y"] = null; }).length).toBe(1);
    expect(poison((p) => { p["off"] = NaN; }).length).toBe(1);
    expect(poison((p) => { p["off"] = 1e9; }).length).toBe(1);
    expect(poison((p) => { p["x"] = Infinity; }).length).toBe(1);
    expect(poison((p) => { delete p["x"]; }).length).toBe(0);
  });

  it("a shot's fov must sit inside the FOV slider's range", () => {
    const fov = (v: unknown): string[] => { const l = loose(goodList()); l[0]!["fov"] = v; return FP.shotErrors(l); };
    expect(fov([FP.FOV.min, FP.FOV.max]).length).toBe(0);
    expect(fov([0, 0])[0] || "").toMatch(/fov must be from 15 to 90/);
    expect(fov([40, 1e6]).length).toBe(1);
    expect(fov([-40, 40]).length).toBe(1);
  });

  it("n and rank must name a corner, a slot and a landmark", () => {
    const one = (pose: Loose): number => { const l = goodList(); l[0]!.look[0] = pose; return FP.shotErrors(l).length; };
    expect(one({ at: "corner", n: "slowest" })).toBe(0);
    expect(one({ at: "corner", n: 7 })).toBe(0);
    expect(one({ at: "corner", n: "bogus" })).toBe(1);
    expect(one({ at: "corner", n: -5 })).toBe(1);
    expect(one({ at: "slot", n: "player" })).toBe(0);
    expect(one({ at: "slot", n: 4 })).toBe(0);
    expect(one({ at: "slot", n: -3 })).toBe(1);
    expect(one({ at: "landmark", rank: 2 })).toBe(0);
    expect(one({ at: "landmark", rank: 99 })).toBe(1);
    expect(one({ at: "landmark", rank: "0" })).toBe(1);
  });

  it("durations that do not sum to 1 are refused by the bake rule only", () => {
    const list = goodList(); list[0]!.dur = 0.9;
    expect(FP.shotErrors(list)).toEqual([]);
    expect(FP.validateShots(list)).toEqual(["durations sum to 1.4000, not 1 — press NORMALISE"]);
    const near = goodList(); near[0]!.dur = 0.505;
    expect(FP.validateShots(near)).toEqual([]);
  });
});

describe("the saved list (flyby-panel.test.mjs)", () => {
  const panelWith = (saved: unknown) => {
    const store = mapStore({ flybyShots: saved });
    return { panel: FP.createFlybyPanel({ $: () => null, state: () => "race", paused: () => true, store, createEditor: () => Promise.resolve(null), hub: { pending: null } }), store };
  };

  it("a saved fov outside the slider is clamped on load, the rest of the list kept", () => {
    const l = FP.normaliseDurs(goodList());
    l[0]!.fov = [110, 100]; l[1]!.fov = [0, 40];
    const saved = FP.savedForm(l);
    const got = panelWith(saved).panel.loadSaved()!;
    expect(got[0]!.fov).toEqual([FP.FOV.max, FP.FOV.max]);
    expect(got[1]!.fov).toEqual([FP.FOV.min, 40]);
    expect(saved.shots[0]!.fov).toEqual([110, 100]);
    const bad = loose(FP.normaliseDurs(goodList())); bad[0]!["fov"] = ["wide", 40];
    expect(withLog(() => panelWith(FP.savedForm(bad as unknown as FlybyShot[])).panel.loadSaved())).toBe(null);
  });

  it("loadSaved() refuses a damaged file instead of flying non-finite frames", () => {
    for (const mut of [(p: Loose) => { p["x"] = "abc"; }, (p: Loose) => { p["y"] = null; }]) {
      const l = FP.normaliseDurs(goodList());
      mut(l[0]!.eye[0] as Loose);
      withLog((warned) => {
        expect(panelWith(FP.savedForm(l)).panel.loadSaved()).toBe(null);
        expect(warned.join("\n")).toMatch(/unusable/);
      });
    }
  });

  it("a saved list is read back through shotErrors, not the bake's sum rule", () => {
    const l = FP.normaliseDurs(goodList()).map((s) => ({ ...s, dur: s.dur! * 3 }));
    expect(FP.shotErrors(l)).toEqual([]);
    expect(FP.validateShots(l).some((m) => /sum/.test(m))).toBe(true);
    expect(panelWith(FP.savedForm(l)).panel.loadSaved()).toBeTruthy();
  });

  it("a saved list round-trips only in the current pose meaning", () => {
    const list = FP.normaliseDurs(goodList());
    expect(panelWith(FP.savedForm(list)).panel.loadSaved()).toEqual(list);
    withLog((warned) => {
      const legacy = panelWith(list);
      expect(legacy.panel.loadSaved()).toBe(null);
      expect(warned.join("\n")).toMatch(/predate/);
      expect(legacy.store.disk.get("flybyShots")).toBeTruthy();
      expect(panelWith({ v: FP.SHOTS_VERSION + 1, shots: list }).panel.loadSaved()).toBe(null);
      expect(panelWith({ v: FP.SHOTS_VERSION, shots: [{ id: "x" }] }).panel.loadSaved()).toBe(null);
    });
    expect(panelWith(null).panel.loadSaved()).toBe(null);
  });

  it("loadSaved hands out a copy, not the store's cached object", () => {
    const saved = FP.savedForm(FP.normaliseDurs(goodList()));
    const { panel } = panelWith(saved);
    const a = panel.loadSaved()!;
    a[0]!.eye[0]!.x = 999;
    expect(saved.shots[0]!.eye[0]!.x).not.toBe(999);
    expect(panel.loadSaved()![0]!.eye[0]!.x).not.toBe(999);
  });
});

// ---- the list operations, bit for bit -----------------------------------------

type Ops = typeof FP.FlybyPanelOps;
/** Every pure operation over one script of inputs; `O` is either side's FlybyPanel. */
function opsScript(O: Ops): unknown {
  const def = JSON.parse(JSON.stringify(DEFAULT)) as FlybyShot[];
  const good = goodList();
  const out: Record<string, unknown> = {};
  const r = (k: string, v: unknown): void => { out[k] = plainDeep(v); };
  r("add", [-5, -1, 0, 3, 99, undefined].map((i) => O.addShot(def, i).map((s) => s.id)));
  r("addEmpty", [O.addShot([], 0), O.addShot(null, undefined)]);
  r("dup", [O.duplicateShot(def, 2), O.duplicateShot(O.duplicateShot(def, 2), 2).map((s) => s.id), O.duplicateShot([], 0), O.duplicateShot(good, 7)]);
  r("del", [O.deleteShot(def, 4).map((s) => s.id), O.deleteShot(good, -3), O.deleteShot(good, 9).map((s) => s.id), O.deleteShot([good[0]!], 0)]);
  r("move", [[0, 1], [3, -2], [7, 1], [8, 1], [-1, 1], [2, 0], [2.7, 1.9]].map(([i, d]) => O.moveShot(def, i!, d!).map((s) => s.id)));
  const lumpy = def.map((s, i) => ({ ...s, dur: [0.2, 0, -1, NaN, 0.33333, 1e-7, 3, 0.125, 0.01][i % 9] as number }));
  r("norm", [O.normaliseDurs(def), O.normaliseDurs(lumpy), O.normaliseDurs(def.map((s) => ({ ...s, dur: 0 }))), O.normaliseDurs([])]);
  const poses = def.flatMap((s) => [...s.eye, ...s.look]);
  r("switch", poses.slice(0, 12).map((p) => O.AT_KINDS.concat(["nonsense"]).map((at) => O.switchPoseAt(p, at))));
  const bad: unknown[] = [
    def, good, [], null, {}, [null], [[]], [{ id: "" }],
    [{ ...good[0], ease: "bounce", dur: -1 }],
    [{ ...good[0], eye: [{ at: "start", x: "abc" }, { at: "centre", distR: 99, bear: 4 }] }],
    [{ ...good[0], look: [{ at: "landmarks" }, null] }],
    [{ ...good[0], fov: [10, 95] }], [{ ...good[0], fov: [40] }], [{ ...good[0], fov: ["a", 40] }],
    [{ ...good[0], eye: [{ at: "slot", n: 2.5 }, { at: "corner", n: 0 }] }],
  ];
  r("errors", bad.map((l) => O.shotErrors(l)));
  r("validate", bad.map((l) => O.validateShots(l)).concat([O.validateShots(lumpy.map((s) => ({ ...s, dur: 0.1 })))]));
  r("blob", [O.toBlob(def), O.toBlob(good), O.toBlob([])]);
  r("saved", [O.fromSaved(O.savedForm(good)), O.fromSaved(good), O.fromSaved(null), O.fromSaved({ v: 1, shots: good }),
    O.fromSaved({ v: 2, shots: [{ ...good[0], fov: [3, 300] }, { ...good[1], fov: [40, "x"] }, null] })]);
  r("ids", [O.uniqueId(def, "wide"), O.uniqueId(def, "lm-a"), O.uniqueId(O.duplicateShot(O.duplicateShot(good, 0), 0), "one"), O.uniqueId(null, "x")]);
  r("fields", poses.map((p) => [O.poseFields(p), O.FIELD_IDS.map((f) => O.fieldLabel(p.at, f))]));
  r("metric", [["distR", 1.2, 500], ["yR", 0.333, 812.5], ["distR", "1", 500], ["distK", 1, 500], ["yR", 0.5, 0], ["distR", 2, null]].map(([f, v, rad]) => O.metricValue(f as string, v, rad as number)));
  return out;
}

describe("the list operations vs f1-game", () => {
  it("match the committed f1-game reference (tests/fixtures/camera/flyby-panel-ops.json)", () => {
    expect(asJson(opsScript(FP.FlybyPanelOps))).toEqual(readFixture("flyby-panel-ops.json"));
  });

  it.skipIf(!haveF1Photo)("match f1-game's FlybyPanel bit for bit", () => {
    const vm = f1Vm(null, ["js/camera/flyby-panel.js"], { Log: { info() {}, warn() {} } });
    const want = opsScript(vm.get<Ops>("FlybyPanel"));
    const got = opsScript(FP.FlybyPanelOps);
    expect(bitDiff(got, want)).toEqual([]);
    maybeWriteFixture("flyby-panel-ops.json", asJson(want));
  });
});

// ---- the deferred doors (flyby-panel.test.mjs deferredTool) --------------------

interface FakeEl { id: string; hidden: boolean; onclick: (() => void) | null; closest(sel: string): FakeEl | undefined }
/** A real lazy-loader race with fake MutationObservers and fake Settings pages. */
function deferredTool(kind: "camera" | "flyby") {
  const observers = new Set<Observer>();
  let delayedObserverDelivery = false, beforeCreate: (() => void) | null = null;
  const delayedObservers: (() => void)[] = [];
  class Observer {
    targets = new Set<unknown>(); records: unknown[] = [];
    constructor(public callback: (r: unknown[]) => void) { observers.add(this); }
    observe(target: unknown): void { this.targets.add(target); }
    disconnect(): void { this.targets.clear(); this.records = []; }
    takeRecords(): unknown[] { return this.records.splice(0); }
  }
  const ids = new Map<string, FakeEl>();
  function element(id: string, hidden = false): FakeEl {
    let value = hidden;
    const el: FakeEl = {
      id, onclick: null,
      closest: () => ids.get("pm-panel-visual"),
      get hidden() { return value; },
      set hidden(next: boolean) {
        if (value === !!next) return;
        value = !!next;
        for (const observer of observers) if (observer.targets.has(el)) {
          observer.records.push({ type: "attributes", attributeName: "hidden", target: el });
          const deliver = (): void => { const records = observer.takeRecords(); if (records.length) observer.callback(records); };
          if (delayedObserverDelivery) delayedObservers.push(deliver); else queueMicrotask(deliver);
        }
      },
    };
    return el;
  }
  for (const id of ["pmsettings", "pm-panel-visual", "pm-camtune", "pm-flyby"]) ids.set(id, element(id));
  ids.set("pm-panel-display", element("pm-panel-display", true));
  const G = { state: "race", paused: true };
  const opened: string[] = [], closed: string[] = [];
  let requested = 0;
  let loads: { ok(v: boolean): void; fail(e: unknown): void }[] = [];
  const bundle = FP.createCamEditorLoader(() => { requested++; return new Promise<boolean>((ok, fail) => loads.push({ ok, fail })); });
  function make(name: string, buttonId: string) {
    if (beforeCreate) { const run = beforeCreate; beforeCreate = null; run(); }
    const open = (): void => { opened.push(name); };
    ids.get(buttonId)!.onclick = open;
    return { open, close: () => { closed.push(name); } };
  }
  const hub: FP.EditorDoorHub = { pending: null };
  const door = {
    $: (id: string) => (ids.get(id) || null) as unknown as HTMLElement | null,
    state: () => G.state, paused: () => G.paused, hub, MutationObserver: Observer as unknown as typeof MutationObserver,
  };
  const camera = createCamTunerBoot({ ...door, createEditor: () => bundle().then((ok) => {
    if (!ok) return null;
    const e = make("CamTunerEditor", "pm-camtune");
    return { openCamTuner: e.open, closeCamTuner: e.close, refreshCamTunePanel() {}, isOpen: () => false };
  }) });
  const flyby = FP.createFlybyPanel({ ...door, createEditor: () => bundle().then((ok) => {
    if (!ok) return null;
    const e = make("FlybyEditor", "pm-flyby");
    return { openFlyby: e.open, closeFlyby: e.close, isOpen: () => false };
  }) });
  const button = ids.get(kind === "camera" ? "pm-camtune" : "pm-flyby")!;
  const open = (): Promise<void> => (kind === "camera" ? camera.openCamTuner() : flyby.openFlyby());
  const close = (): void => { if (kind === "camera") camera.closeCamTuner(false); else flyby.closeFlyby(false); };
  async function settle(): Promise<void> { for (let i = 0; i < 24; i++) await Promise.resolve(); }
  async function deliver(fail = false): Promise<void> {
    await settle();
    for (const l of loads.splice(0)) { if (fail) l.fail(new Error("dropped")); else l.ok(true); }
    loads = [];
    await settle();
  }
  function queueRouteChangeAtCreate(route: string): void {
    beforeCreate = () => {
      delayedObserverDelivery = true;
      ids.get(route)!.hidden = true; ids.get(route)!.hidden = false;
    };
  }
  function flushObservers(): void { delayedObserverDelivery = false; for (const cb of delayedObservers.splice(0)) cb(); }
  return { G, ids, button, open, close, settle, deliver, opened, closed, requested: () => requested, queueRouteChangeAtCreate, flushObservers, delayedObservers };
}

describe("the deferred editor doors (flyby-panel.test.mjs)", () => {
  let prevLog: ReturnType<typeof setDataLog> | null = null;
  beforeEach(() => { prevLog = setDataLog({ info() {}, warn() {} }); });
  afterEach(() => { if (prevLog) setDataLog(prevLog); });
  for (const kind of ["camera", "flyby"] as const) {
    it(`${kind} delayed UI open cannot survive close and resume`, async () => {
      await withLog(async () => {
        const h = deferredTool(kind); h.button.onclick!(); h.close(); h.G.paused = false;
        await h.deliver(); expect(h.opened.length).toBe(0);
      });
    });

    for (const route of ["pmsettings", "pm-panel-visual"]) it(`${kind} pending UI open is cancelled by ${route} hide and reopen`, async () => {
      const h = deferredTool(kind); h.button.onclick!();
      // Same-task hide/reopen: checking only the final hidden value is insufficient.
      h.ids.get(route)!.hidden = true; h.ids.get(route)!.hidden = false;
      await h.deliver(); expect(h.opened.length).toBe(0);
    });

    it(`${kind} queued route records cancel fulfillment before observer delivery`, async () => {
      const h = deferredTool(kind); h.button.onclick!();
      h.queueRouteChangeAtCreate("pm-panel-visual");
      await h.deliver();
      expect(h.ids.get("pm-panel-visual")!.hidden).toBe(false);
      expect(h.delayedObservers.length).toBeGreaterThan(0);
      expect(h.opened.length).toBe(0);
      h.flushObservers(); await h.settle();
      expect(h.opened.length).toBe(0);
    });

    it(`${kind} only the latest pending open owns the panel`, async () => {
      const h = deferredTool(kind); h.button.onclick!(); h.button.onclick!();
      await h.deliver(); expect(h.opened.length).toBe(1);
    });

    it(`${kind} cached UI opener keeps cancellation after editor handler replacement`, async () => {
      const h = deferredTool(kind); h.button.onclick!(); await h.deliver();
      expect(h.opened.length).toBe(1); const requested = h.requested();
      h.close(); h.button.onclick!(); h.close(); await h.settle();
      expect(h.opened.length).toBe(1);
      h.button.onclick!(); await h.settle();
      expect(h.opened.length).toBe(2);
      expect(h.requested()).toBe(requested);
    });

    it(`${kind} explicit API opens outside Settings remain supported and cancellable`, async () => {
      const h = deferredTool(kind); h.ids.get("pmsettings")!.hidden = true; h.ids.get("pm-panel-visual")!.hidden = true;
      h.G.state = "menu"; h.G.paused = false;
      void h.open(); h.close(); await h.deliver(); expect(h.opened.length).toBe(0);
      await h.open(); expect(h.opened.length).toBe(1);
    });

    it(`${kind} failed delayed load can be retried`, async () => {
      await withLog(async () => {
        const h = deferredTool(kind); h.button.onclick!(); await h.deliver(true);
        expect(h.opened.length).toBe(0); h.button.onclick!(); await h.deliver();
        expect(h.opened.length).toBe(1);
        expect(h.requested()).toBe(2);           // the bundle is asked for again once (f1-game: both files, 4 requests)
      });
    });
  }

  it("the latest delayed tuner UI door owns the shared editor load", async () => {
    const h = deferredTool("camera");
    h.ids.get("pm-camtune")!.onclick!(); h.ids.get("pm-flyby")!.onclick!();
    await h.deliver();
    expect(h.opened).toEqual(["FlybyEditor"]);
  });
});
