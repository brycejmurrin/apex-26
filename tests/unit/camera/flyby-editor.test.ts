// @vitest-environment happy-dom
/**
 * The FLYBY SHOT EDITOR panel (src/camera/flyby-editor.ts) driven through its
 * DOM with f1-game's ids: open / close, the live preview's verdict line, the
 * persistence funnel, the list operations' buttons, COPY VALUES, the track
 * card and announcer rows, the FREE CAMERA sub-mode (f1-game
 * tests/unit/flyby-panel.test.mjs "SET SHOT START from a 110° free-camera
 * view"), a mount/unmount leak check — and one scripted editing session whose
 * resulting shot list and saved value are held bit for bit against f1-game's
 * own FlybyEditor (node:vm over its mini-dom) and a committed fixture.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT, type FlybyShot } from "../../../src/camera/flyby-seq";
import { mountFlybyEditor, type CardDef, type FlybyCamResult, type FlybyDevApi, type FlybyEditorMount } from "../../../src/camera/flyby-editor";
import * as FP from "../../../src/camera/flyby-panel";
import type { FreeCamCmd } from "../../../src/camera/free-cam";
import { setDataLog } from "../../../src/data/log";
import { mapStore } from "./f1-cam-vm";
import { bitDiff } from "./f1-flyby-vm";
import { asJson, f1Vm, haveF1Photo, maybeWriteFixture, miniDom, plainDeep, readFixture, type MiniDom } from "./f1-photo-vm";
import { leakProbe } from "./leak";

const mounted: { unmount(): void }[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
  document.body.replaceChildren(); document.body.className = "";
  vi.useRealTimers();
});
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error("#" + id);
  return e as T;
};

interface SetupOpts { saved?: unknown; api?: FlybyDevApi | null; card?: boolean; ann?: boolean; freeCam?: { enterFrom(o: FreeCamCmd): boolean } }
function setup(o: SetupOpts = {}) {
  const pm = document.createElement("div"); pm.id = "pmsettings"; document.body.appendChild(pm);
  const disp = document.createElement("div"); disp.id = "pm-panel-display"; pm.appendChild(disp);
  const btn = document.createElement("button"); btn.id = "pm-flyby"; disp.appendChild(btn);
  const store = mapStore(o.saved !== undefined ? { flybyShots: o.saved } : {});
  const S = { snaps: 0, views: [] as string[], copied: [] as string[], held: 0, stops: 0, card: { scale: 1, x: 0.5, y: 0.2 } as Record<string, number>, said: 0, paused: true };
  const api: FlybyDevApi | null = o.api === undefined ? null : o.api;
  if (api) api.view = (m: string) => { S.views.push(m); };
  const CARD: Record<string, CardDef> = { scale: { label: "CARD SIZE", min: 0.6, max: 1.6, step: 0.05, unit: "×" }, x: { label: "CARD X", min: 0, max: 1, step: 0.01, unit: "" }, y: { label: "CARD Y", min: 0, max: 1, step: 0.01, unit: "" } };
  const ls = {
    setCard: (g: Record<string, number>) => { for (const k in g) S.card[k] = Math.min(CARD[k]!.max, g[k]!); return { ...S.card }; },
    resetCard: () => { S.card = { scale: 1, x: 0.5, y: 0.2 }; return { ...S.card }; },
    card: () => ({ ...S.card }), hold: () => { S.held++; }, stop: () => { S.stops++; },
  };
  const ann = { scriptFor: () => ["Welcome to Monza.", "Fifty-three laps."], preview: () => { S.said++; return false; }, available: () => true, stop: () => { S.stops++; } };
  const m = mountFlybyEditor(document.body, {
    store, flyby: { DEFAULT },
    devApi: () => api, snapGameCam: () => { S.snaps++; }, paused: () => S.paused,
    dbgCam: () => ({ eye: [0, 5, 0], target: [0, 0, 50], fov: 110 }),
    clipboard: (t) => { S.copied.push(t); return Promise.resolve(true); },
    ...(o.card ? { loadingScreen: () => ls, cardDefs: () => CARD, cardKeys: () => ["scale", "x", "y"], loadingInfo: () => ({ id: "monza" }) } : {}),
    ...(o.ann ? { announcer: () => ann, loadingInfo: () => ({ id: "monza" }) } : {}),
    ...(o.freeCam ? { freeCam: o.freeCam } : {}),
  });
  mounted.push(m);
  return { m, store, S, pm, disp, btn };
}
const set = (id: string, v: string | number, type: "input" | "change"): void => { const e = $<HTMLInputElement>(id); e.value = String(v); e.dispatchEvent(new Event(type)); };

describe("FLYBY SHOT EDITOR panel", () => {
  it("builds f1-game's shell DOM and opens docked over the live view", () => {
    const s = setup();
    for (const id of ["flyby", "flyby-inner", "fb-rail", "fb-head", "fb-freecam", "fb-profile", "fb-status", "fb-scrub", "fb-u", "fb-u-val", "fb-shots", "fb-ops", "fb-add", "fb-dup", "fb-del", "fb-up", "fb-down", "fb-norm", "fb-rows", "fb-json", "fb-reset", "fb-copy", "fb-close"]) expect(document.getElementById(id), id).not.toBe(null);
    expect(s.m.isOpen()).toBe(false);
    s.btn.click();
    expect(s.m.isOpen()).toBe(true);
    expect(document.body.classList.contains("lt-open")).toBe(true);
    expect(s.pm.hidden && s.disp.hidden).toBe(true);
    expect($("fb-shots").children.length).toBe(DEFAULT.length);
    expect($("fb-tab-0").getAttribute("aria-selected")).toBe("true");
    expect($("fb-shots").getAttribute("aria-labelledby")).toBe("fb-tab-0");
    expect($("fb-profile").textContent).toMatch(new RegExp("^" + DEFAULT.length + " shots  ·  durations sum "));
    expect($("fb-status").textContent).toBe("preview unavailable — loading the dev API…");
    expect($<HTMLInputElement>("fb-in-dur").value).toBe(String(DEFAULT[0]!.dur));
    $("fb-close").click();
    expect(s.m.isOpen()).toBe(false);
    expect(document.body.classList.contains("lt-open")).toBe(false);
    expect(s.pm.hidden || s.disp.hidden).toBe(false);
    expect(s.S.snaps).toBe(1);
  });

  it("closing a panel that was never open releases nothing", () => {
    const s = setup();
    s.m.closeFlyby(true);
    expect(s.S.snaps).toBe(0);
  });

  it("the preview's verdict line: which shot, where the eye is, and whether it is INSIDE something", () => {
    let res: FlybyCamResult = { u: 0.0625, shot: "wide", index: 0, eye: [1, 2, 3], fov: 40, lift: 0, onRoad: false, inside: null };
    const calls: [number, FlybyShot[]][] = [];
    const s = setup({ api: { flybyCam: (u, shots) => { calls.push([u, shots]); return res; } } });
    s.m.openFlyby();
    expect($("fb-status").textContent).toBe("u 0.063  ·  wide [0]  ·  eye 1, 2, 3  ·  fov 40  ·  clear");
    res = { ...res, inside: { kind: "grandstand" }, lift: 21.04 };
    set("fb-u", 500, "input");
    expect(calls.at(-1)![0]).toBe(0.5);
    expect($("fb-status").textContent).toBe("u 0.063  ·  wide [0]  ·  eye 1, 2, 3  ·  fov 40  ·  lifted 21.0 m  ·  INSIDE A GRANDSTAND — move this eye");
    expect($("fb-status").classList.contains("fb-inside")).toBe(true);
    res = { ...res, onRoad: true, lat: -14.25, index: 3 };
    set("fb-u", 600, "input");
    expect($("fb-status").textContent).toMatch(/ON-ROAD SHOT 14\.3 m OFF THE ROAD — move this eye$/);
    expect($("fb-tab-3").getAttribute("aria-selected")).toBe("true");   // the scrub selected the shot it landed in
    // The preview flies a COPY re-taken when the list's contents change.
    const first = calls.at(-1)![1];
    set("fb-u", 610, "input");
    expect(calls.at(-1)![1]).toBe(first);
    set("fb-in-fov0", 33, "input");
    expect(calls.at(-1)![1]).not.toBe(first);
    $("fb-close").click();
    expect(s.S.views).toEqual(["chase"]);
  });

  it("every edit is saved; a list back at the shipped DEFAULT clears the key", () => {
    const s = setup();
    s.m.openFlyby();
    set("fb-in-fov1", 44.5, "input");
    const saved = s.store.disk.get("flybyShots") as FP.SavedShots;
    expect(saved.v).toBe(FP.SHOTS_VERSION);
    expect(saved.shots[0]!.fov![1]).toBe(44.5);
    expect(s.m.loadSaved()![0]!.fov![1]).toBe(44.5);
    $("fb-reset").click();
    expect(s.store.disk.get("flybyShots")).toBe(null);
    expect(s.m.list()).toEqual(JSON.parse(JSON.stringify(DEFAULT)));
  });

  it("a saved edit seeds the list; switching an anchor shows only the rows it reads", () => {
    const list = FP.normaliseDurs(JSON.parse(JSON.stringify(DEFAULT.slice(0, 3))) as FlybyShot[]);
    const s = setup({ saved: FP.savedForm(list) });
    s.m.openFlyby();
    expect($("fb-shots").children.length).toBe(3);
    set("fb-in-eye0-at", "centre", "change");
    expect(s.m.list()[0]!.eye[0]!.at).toBe("centre");
    expect($("fb-row-eye0-distR").style.display).toBe("");
    expect($("fb-row-eye0-off").style.display).toBe("none");
    expect($("fb-row-eye0-n").style.display).toBe("none");
    expect($("fb-row-eye0-y").querySelector(".tune-label")!.firstChild!.nodeValue).toBe("EYE FROM HEIGHT OFFSET ");
    set("fb-in-eye0-at", "corner", "change");
    expect($("fb-row-eye0-n").style.display).toBe("");
    set("fb-in-eye0-n", "7", "change");
    expect(s.m.list()[0]!.eye[0]!.n).toBe(7);
    set("fb-in-eye0-n", "slowest", "change");
    expect(s.m.list()[0]!.eye[0]!.n).toBe("slowest");
  });

  it("ADD / DUPE / UP / DOWN / NORM edit the list; DEL refuses the last shot and says so on the button", async () => {
    vi.useFakeTimers();
    const s = setup({ saved: FP.savedForm(FP.normaliseDurs([JSON.parse(JSON.stringify(DEFAULT[0])) as FlybyShot])) });
    s.m.openFlyby();
    $("fb-del").click();
    expect($("fb-del").textContent).toBe("NEED ONE");
    vi.advanceTimersByTime(1800);
    expect($("fb-del").textContent).toBe("DEL");
    $("fb-add").click();
    expect(s.m.list().map((x) => x.id)).toEqual([DEFAULT[0]!.id, "shot"]);
    expect($("fb-tab-1").getAttribute("aria-selected")).toBe("true");
    $("fb-dup").click();
    expect(s.m.list().map((x) => x.id)).toEqual([DEFAULT[0]!.id, "shot", "shot-2"]);
    $("fb-up").click();
    expect(s.m.list().map((x) => x.id)).toEqual([DEFAULT[0]!.id, "shot-2", "shot"]);
    $("fb-down").click();
    expect(s.m.list().map((x) => x.id)).toEqual([DEFAULT[0]!.id, "shot", "shot-2"]);
    expect($("fb-profile").textContent).toMatch(/press NORMALISE/);
    $("fb-norm").click();
    expect($("fb-profile").textContent).toBe("3 shots  ·  durations sum 1.000");
    // chip keyboard: End / Home / arrows wrap.
    $("fb-tab-2").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect($("fb-tab-0").getAttribute("aria-selected")).toBe("true");
    $("fb-tab-0").dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect($("fb-tab-2").getAttribute("aria-selected")).toBe("true");
  });

  it("COPY VALUES writes the bake blob, warns when it will not bake, and flashes the result", async () => {
    vi.useFakeTimers();
    const s = setup();
    s.m.openFlyby();
    $("fb-copy").click();
    await Promise.resolve(); await Promise.resolve();
    expect($<HTMLTextAreaElement>("fb-json").value).toBe(FP.toBlob(DEFAULT));
    expect($("fb-json").hidden).toBe(false);
    expect(s.S.copied).toEqual([FP.toBlob(DEFAULT)]);
    expect($("fb-copy").textContent).toBe("COPIED ✓");
    vi.advanceTimersByTime(1800);
    expect($("fb-copy").textContent).toBe("COPY VALUES");
    set("fb-in-dur", 0.9, "input");
    $("fb-copy").click();
    await Promise.resolve(); await Promise.resolve();
    expect($<HTMLTextAreaElement>("fb-json").value).toMatch(/^\/\/ THIS LIST WILL NOT BAKE:\n\/\/ durations sum to /);
    expect($("fb-copy").textContent).toBe("COPIED (INVALID)");
  });

  it("the TRACK CARD rows write through the loading screen's clamp; the ANNOUNCER prints its script", () => {
    const s = setup({ card: true, ann: true });
    s.m.openFlyby();
    expect(s.S.held).toBe(1);
    expect($<HTMLInputElement>("fb-in-card-scale").value).toBe("1");
    set("fb-in-card-scale", 1.8, "input");
    expect($<HTMLInputElement>("fb-in-card-scale").value).toBe("1.6");      // the clamp, not the thumb
    expect($("fb-v-card-scale").textContent).toBe("1.60×");
    $("fb-card-reset").click();
    expect($<HTMLInputElement>("fb-in-card-scale").value).toBe("1");
    expect($("fb-ann-script").textContent).toBe("Welcome to Monza. Fifty-three laps.");
    $("fb-ann-play").click();
    expect($("fb-ann-play").textContent).toBe("SOUND OFF");
    s.m.closeFlyby(false);
    expect(s.S.stops).toBe(2);                                              // the card and the voice go with the panel
  });

  it("SET SHOT START from a 110° free-camera view saves a shot that passes shotErrors", () => {
    let entered: FreeCamCmd | null = null;
    const s = setup({ saved: FP.savedForm(FP.normaliseDurs(JSON.parse(JSON.stringify(DEFAULT.slice(0, 2))) as FlybyShot[])), freeCam: { enterFrom: (o) => { entered = o; return true; } } });
    s.m.openFlyby();
    $("fb-freecam").click();
    expect(s.m.isOpen()).toBe(false);
    const e = entered as FreeCamCmd | null;
    expect(e && e.actions && e.lens).toBe("flyby");
    expect(e!.eye).toEqual([0, 5, 0]); expect(e!.fov).toBe(110);
    const msg = e!.actions![0]!.run({ shot: { eye: [{ at: "start", off: 0, x: 0, y: 5 }], look: [{ at: "start", off: 50, x: 0, y: 1 }], fov: [110] }, err: { eye: 0, look: 0 } });
    expect(msg).toBe("Shot 1 starts here (round trip: eye 0 m, look 0 m).");
    const list = FP.fromSaved(s.store.disk.get("flybyShots"))!;
    expect(list[0]!.fov![0]).toBe(FP.FOV.max);
    expect(FP.shotErrors(list)).toEqual([]);
    e!.back!();
    expect(s.m.isOpen()).toBe(true);
  });

  it("a refused FREE CAMERA hands straight back to the editor", () => {
    const s = setup({ freeCam: { enterFrom: () => false } });
    s.m.openFlyby(); $("fb-freecam").click();
    expect(s.m.isOpen()).toBe(true);
  });

  it("the dev-API loader is asked once, on open, and a failure says so", async () => {
    const prev = setDataLog({ info() {}, warn() {} });
    try {
      const s = setup();
      let asked = 0;
      s.m.setApiLoader(() => { asked++; return Promise.reject(new Error("blocked")); });
      expect(asked).toBe(0);
      s.m.openFlyby();
      expect(asked).toBe(1);
      await Promise.resolve(); await Promise.resolve();
      expect($("fb-status").textContent).toBe("the dev API did not load — preview unavailable");
      s.m.closeFlyby(false); s.m.openFlyby();
      expect(asked).toBe(1);
    } finally { setDataLog(prev); }
  });

  it("mount / unmount leaves no listener, timer or door behind", () => {
    const probe = leakProbe();
    try {
      vi.useFakeTimers();
      const s = setup({ card: true, ann: true });
      mounted.pop();
      s.m.openFlyby();
      $("fb-del").click(); $("fb-ann-play").click();     // two pending flashes
      s.m.unmount();
      expect(probe.liveListeners()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(s.btn.onclick).toBe(null);
      expect(document.getElementById("flyby")).toBe(null);
      expect(document.body.classList.contains("lt-open")).toBe(false);
    } finally { probe.restore(); }
  });
});

// ---- one editing session, bit for bit ----------------------------------------

type Act = ["click", string] | ["input" | "change", string, string | number];
const SESSION: Act[] = [
  ["click", "fb-tab-2"],
  ["input", "fb-in-dur", 0.2],
  ["change", "fb-in-ease", "out"],
  ["change", "fb-in-eye0-at", "centre"],
  ["input", "fb-in-eye0-distR", 2.1],
  ["input", "fb-in-eye0-bear", -1.23],
  ["change", "fb-in-look1-at", "corner"],
  ["change", "fb-in-look1-n", "5"],
  ["input", "fb-in-look1-x", 12.5],
  ["click", "fb-add"],
  ["input", "fb-in-fov0", 30],
  ["input", "fb-in-eye1-y", 12.35],
  ["click", "fb-dup"],
  ["click", "fb-up"],
  ["click", "fb-down"],
  ["change", "fb-in-look0-at", "landmark"],
  ["change", "fb-in-look0-rank", "3"],
  ["input", "fb-in-look0-yK", 1.15],
  ["click", "fb-tab-0"],
  ["change", "fb-in-eye1-at", "slot"],
  ["input", "fb-in-eye1-off", -37],
  ["click", "fb-tab-5"],
  ["click", "fb-del"],
  ["click", "fb-norm"],
  ["input", "fb-u", 730],
  ["change", "fb-in-look0-at", "grid"],
  ["input", "fb-in-fov1", 89.5],
];
interface Driver { open(): void; click(id: string): void; val(id: string, v: string, type: string): void; selected(): string; list(): unknown; saved(): unknown; status(): string }
function runSession(d: Driver): unknown {
  d.open();
  const steps: unknown[] = [];
  for (const a of SESSION) {
    if (a[0] === "click") d.click(a[1]); else d.val(a[1], String(a[2]), a[0]);
    steps.push(d.selected());
  }
  return plainDeep({ steps, list: d.list(), saved: d.saved(), status: d.status() });
}

function portSession(): unknown {
  const s = setup();
  return runSession({
    open: () => s.m.openFlyby(),
    click: (id) => $(id).click(),
    val: (id, v, type) => { const e = $<HTMLInputElement>(id); e.value = v; e.dispatchEvent(new Event(type)); },
    selected: () => s.m.list().findIndex((_x, i) => $("fb-tab-" + i).getAttribute("aria-selected") === "true") + ":" + $("fb-profile").textContent,
    list: () => s.m.list(),
    saved: () => s.store.disk.get("flybyShots"),
    status: () => $("fb-status").textContent || "",
  });
}
function f1Session(): unknown {
  const dom: MiniDom = miniDom();
  dom.byId("flyby").hidden = true; dom.byId("fb-json").hidden = true;
  const store = mapStore();
  const vm = f1Vm(dom, ["js/camera/flyby-panel.js", "js/camera/flyby-editor.js"], {
    Log: { info() {}, warn() {} }, FlybySeq: { DEFAULT: JSON.parse(JSON.stringify(DEFAULT)) as unknown },
  });
  const G = { $: (id: string) => dom.byId(id), els: { pmsettings: dom.byId("pmsettings") }, store, snapGameCam() {}, paused: true };
  const ed = vm.get<{ create(G: unknown): { openFlyby(): void; list(): unknown } }>("FlybyEditor").create(G);
  return runSession({
    open: () => ed.openFlyby(),
    click: (id) => dom.byId(id).click(),
    val: (id, v, type) => { const e = dom.byId(id); e.value = v; dom.dispatch(e, { type }); },
    // mini-dom's textContent does not drop children, so read the chips by id (the newest owns it).
    selected: () => (ed.list() as unknown[]).findIndex((_x, i) => (dom.byId("fb-tab-" + i)["getAttribute"] as (k: string) => string | null)("aria-selected") === "true") + ":" + dom.byId("fb-profile").textContent,
    list: () => ed.list(),
    saved: () => store.disk.get("flybyShots"),
    status: () => dom.byId("fb-status").textContent,
  });
}

describe("an editing session: the resulting shot list", () => {
  it("matches the committed f1-game reference (tests/fixtures/camera/flyby-edits.json)", () => {
    expect(asJson(portSession())).toEqual(readFixture("flyby-edits.json"));
  });

  it.skipIf(!haveF1Photo)("matches f1-game's FlybyEditor bit for bit", () => {
    const want = f1Session();
    const got = portSession();
    expect(bitDiff(got, want)).toEqual([]);
    maybeWriteFixture("flyby-edits.json", asJson(want));
  });
});
