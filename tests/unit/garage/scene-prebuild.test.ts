// GaragePrebuild (src/garage/scene/prebuild.ts), ported from f1-game
// tests/unit/garage-prebuild.test.mjs: the pure gate (blockers/plan), the keyed
// sequence behind the menu's idle gate and the tap-to-first-frame measure.
// The pure gate is also swept against f1-game's js/garage/prebuild.js in a VM.
import { describe, expect, it } from "vitest";
import {
  blockers, create, homeKind, instance, packSettled, plan, readSwitch, saveData, SWITCH_KEY,
  type PackState, type PrebuildEnvSnapshot, type PrebuildGame, type Want,
} from "../../../src/garage/scene/prebuild";
import { f1Scene, hasF1Scene } from "./scene-vm";

const GO: PrebuildEnvSnapshot = {
  want: "title", kind: "none", off: false, state: "menu", setupOpen: false, starting: false, tabHidden: false, headless: false,
  surface: "title", intro: false, saveData: false, packSettled: true, worldReady: false, homePainted: false,
  worldWarm: false, warming: false,
};
const why = (patch: Partial<PrebuildEnvSnapshot>) => blockers({ ...GO, ...patch });

describe("the pure gate", () => {
  it("blockers: an idle title with nothing in the way goes", () => { expect(blockers(GO)).toEqual([]); });
  it("blockers: never on a race start, with the garage open, a hidden tab or headless", () => {
    expect(why({ state: "race" })).toEqual(["state"]);
    expect(why({ starting: true })).toEqual(["race-start"]);
    expect(why({ setupOpen: true })).toEqual(["garage-open"]);
    expect(why({ tabHidden: true })).toEqual(["tab-hidden"]);
    expect(why({ headless: true })).toEqual(["headless"]);
    expect(why({ surface: "" })).toEqual(["surface"]);
    expect(why({ worldWarm: true })).toEqual(["world-warm"]);
    expect(why({ warming: true })).toEqual(["world-warm"]);
  });
  it("blockers: the title is speculative — Save-Data, the intro and the world all gate it", () => {
    expect(why({ saveData: true })).toEqual(["save-data"]);
    expect(why({ packSettled: false })).toEqual([]);
    expect(why({ intro: true })).toEqual(["title-intro"]);
    expect(why({ kind: "track" })).toEqual(["world-build"]);
    expect(why({ kind: "track", worldReady: true })).toEqual([]);
    expect(why({ kind: "garage" })).toEqual(["home-unpainted"]);
    expect(why({ kind: "garage", homePainted: true })).toEqual([]);
  });
  it("blockers: race settings keeps its old gates", () => {
    const settings = { ...GO, want: "settings" as Want, surface: "settings", saveData: true, packSettled: false, intro: true };
    expect(blockers(settings)).toEqual([]);
    expect(blockers({ ...settings, surface: "title" })).toEqual(["surface"]);
  });
  it("plan: only a hidden canvas gets hidden frames; a Home garage keeps its own room", () => {
    expect(plan("settings", "none")).toEqual({ car: true, room: true, frames: true });
    expect(plan("title", "none")).toEqual({ car: true, room: true, frames: true });
    expect(plan("title", "track")).toEqual({ car: true, room: true, frames: false });
    expect(plan("title", "garage")).toEqual({ car: true, room: false, frames: false });
    expect(plan("title", "studio")).toEqual({ car: true, room: false, frames: false });
  });
  it("homeKind, packSettled and saveData read the real signals", () => {
    expect(homeKind(null)).toBe("none");
    expect(homeKind({ home: false, world: { active: false } })).toBe("none");
    expect(homeKind({ home: false, world: { active: true } })).toBe("track");
    expect(homeKind({ home: true, scene: { mode: "garage" }, world: {} })).toBe("garage");
    expect(homeKind({ home: true, scene: { mode: "night" }, world: {} })).toBe("garage");
    expect(homeKind({ home: true, scene: { mode: "studio" }, world: {} })).toBe("studio");
    expect(packSettled({ supported: true, uploaded: false, error: null, tier: null })).toBe(false);
    expect(packSettled({ supported: true, uploaded: true })).toBe(true);
    expect(packSettled({ supported: true, uploaded: false, error: "no-pack" })).toBe(true);
    expect(packSettled({ supported: false })).toBe(true);
    expect(saveData({ connection: { saveData: true } }, null)).toBe(true);
    expect(saveData({}, (q) => ({ matches: q === "(prefers-reduced-data: reduce)" }))).toBe(true);
    expect(saveData({ connection: { saveData: false } }, () => ({ matches: false }))).toBe(false);
    expect(saveData({}, () => { throw new Error("no media queries"); })).toBe(false);
  });
  it("the A/B switch reads a26.garagePrewarm", () => {
    const store = (v: string | null) => ({ getItem: (k: string) => (k === SWITCH_KEY ? v : null) });
    expect(SWITCH_KEY).toBe("a26.garagePrewarm");
    expect(readSwitch(store(null))).toBe(true);
    for (const v of ["off", '"off"', "0", "false"]) expect(readSwitch(store(v))).toBe(false);
    expect(readSwitch({ getItem() { throw new Error("blocked storage"); } })).toBe(true);
    expect(blockers({ ...GO, off: true })).toEqual(["off"]);
    expect(blockers({ ...GO, off: true, want: "settings", surface: "settings" })).toEqual([]);
  });
});

describe.skipIf(!hasF1Scene)("the pure gate matches f1-game js/garage/prebuild.js", () => {
  it("blockers, plan, homeKind and packSettled over a sweep", () => {
    const GP = f1Scene({ setTimeout: () => 0, clearTimeout() {}, Promise }, ["js/garage/prebuild.js"])("GaragePrebuild") as Record<string, (...a: unknown[]) => unknown>;
    const bools = ["off", "setupOpen", "starting", "tabHidden", "headless", "intro", "saveData", "worldReady", "homePainted", "worldWarm", "warming"] as const;
    for (let mask = 0; mask < 1 << bools.length; mask += 37) for (const want of ["title", "settings"] as const)
      for (const kind of ["none", "track", "garage", "studio"] as const) for (const surface of ["title", "settings", ""]) {
        const e: PrebuildEnvSnapshot = { ...GO, want, kind, surface, state: mask & 1 ? "race" : "menu" };
        bools.forEach((b, i) => { (e as unknown as Record<string, boolean>)[b] = !!(mask & (1 << i)); });
        expect(blockers(e)).toEqual(Array.from(GP["blockers"]!(e) as string[]));
        expect(plan(want, kind)).toEqual({ ...(GP["plan"]!(want, kind) as object) });
      }
    const packs: (PackState | null)[] = [null, { supported: false }, { uploaded: true }, { error: "x" }, { tier: "off" }, { supported: true }];
    for (const s of packs) expect(packSettled(s)).toBe(GP["packSettled"]!(s));
  });
});

// A scripted page (garage-prebuild.test.mjs:107-150): the gate, the camera's
// prebuild surface and an explicit slice clock (each menuSlice resolves when
// the test calls flush()).
function page({ kind = "none", painted = true, surface = "title", worldWarm = 0 } = {}) {
  let t = 0, team = "mclaren", meshKey = "", warms = 0;
  const slices: (() => void)[] = [];
  const built: string[] = [], logs: string[] = [];
  const els: Record<string, { hidden: boolean; inert?: boolean; hasAttribute?: () => boolean }> = {
    overlay: { hidden: surface !== "title", inert: false, hasAttribute: () => false },
    "race-settings": { hidden: surface !== "settings" },
  };
  const G = {
    state: "menu", setupPreviewOn: false, headlessMode: false, $: (id: string) => els[id],
    loadingScreen: { active: () => false },
    gfx: { warm() { warms++; }, warming: () => false },
  };
  const gate = { warm: worldWarm, garageWarm: 0, garageReady: false, garageKey: "" };
  const cam = {
    previewKey: () => team + ":parts:4",
    prebuildKey: () => team + ":parts:4|monza|day",
    prebuild(part: "car" | "room") { built.push(part); if (part === "car") meshKey = team + ":parts:4"; return true; },
    roomReady: () => built.includes("room"),
    get meshKey() { return meshKey; }, set meshKey(v: string) { meshKey = v; },
    released: 0,
    release() { if (G.setupPreviewOn) return false; cam.released++; meshKey = ""; built.length = 0; return true; },
  };
  const home = { home: kind === "garage" || kind === "studio", painted, scene: { mode: kind === "studio" ? "studio" : "garage" },
    world: { active: kind === "track" } };
  const env = { nav: {} as object, pack: { supported: true, uploaded: true } as PackState };
  const pre = create(G as PrebuildGame, {
    gate, setupCam: cam, ui: () => ({ state: () => home }), studio: () => null, worldReady: () => true,
    menuIdle: async (current) => current(),
    menuSlice: () => new Promise<void>((r) => slices.push(r)),
  }, {
    now: () => t, setTimeout: () => 0, clearTimeout() {}, hidden: () => false,
    navigator: () => env.nav, matchMedia: () => () => ({ matches: false }), assetsState: () => env.pack, storage: null,
    log: { info: (m: string) => logs.push("game: " + m), warn: (m: string) => logs.push("warn " + m) },
  });
  return {
    G, gate, cam, pre, built, logs, els, env,
    warms: () => warms, setTeam(v: string) { team = v; },
    advance(ms: number) { t += ms; },
    async flush(n = 1) {
      const settle = async () => { for (let k = 0; k < 20; k++) await Promise.resolve(); };
      await settle();
      for (let i = 0; i < n; i++) { for (const r of slices.splice(0)) r(); await settle(); }
    },
  };
}
type Page = ReturnType<typeof page>;
const owned = (h: Page) => () => h.G.state === "menu" && !h.G.setupPreviewOn;

describe("the keyed sequence", () => {
  it("the title builds the car, then the room, then arms two hidden frames after ONE warm request", async () => {
    const h = page();
    const done = h.pre.run(owned(h), "title");
    await h.flush(0); expect(h.built).toEqual(["car"]);
    await h.flush(); expect(h.built).toEqual(["car", "room"]);
    await h.flush();
    expect(h.warms()).toBe(1);
    expect(h.gate.garageWarm).toBe(2);
    expect(h.gate.garageKey).toBe("mclaren:parts:4|monza|day");
    h.advance(40); h.gate.garageWarm = 0; h.gate.garageReady = true;
    await h.flush();
    expect(await done).toBe(true);
    const st = h.pre.state();
    expect(st.ready).toBe(true);
    expect(st.last!.result).toBe("ready");
    expect(st.last!.kind).toBe("none");
    expect(st.blockers).toEqual([]);
    expect(h.logs.some((l) => /^game: garage prewarm ready in \d+ ms \(title, home none: car \d+ ms, room \d+ ms, frames \d+ ms\)$/.test(l))).toBe(true);
    expect(instance()).toBe(h.pre);
  });
  it("ready is keyed: a team pick or a livery bust re-arms it, and the warm is never asked twice", async () => {
    const h = page();
    const go = async () => { const p = h.pre.run(owned(h), "title"); await h.flush(2); h.gate.garageReady = true; await h.flush(); return p; };
    expect(await go()).toBe(true);
    expect(await h.pre.run(owned(h), "title")).toBe(false);
    expect(h.built.length).toBe(2);
    h.setTeam("ferrari");
    expect(h.pre.state().ready).toBe(false);
    expect(await go()).toBe(true);
    expect(h.gate.garageKey).toBe("ferrari:parts:4|monza|day");
    h.cam.meshKey = "";
    expect(h.pre.state().ready).toBe(false);
    expect(await go()).toBe(true);
    expect(h.built.filter((p) => p === "car").length).toBe(3);
    expect(h.warms()).toBe(1);
  });
  it("the menu world's hidden frames are waited for, never stolen", async () => {
    const h = page({ worldWarm: 2, surface: "settings" });
    const done = h.pre.run(owned(h), "settings");
    await h.flush(3); expect(h.built).toEqual([]);
    h.gate.warm = 0;
    await h.flush(3); expect(h.built).toEqual(["car", "room"]);
    h.gate.garageReady = true; await h.flush();
    expect(await done).toBe(true);
  });
  it("a tap mid-sequence supersedes it: no room, no frames", async () => {
    const h = page();
    const done = h.pre.run(owned(h), "title");
    await h.flush(0);
    h.G.setupPreviewOn = true;
    await h.flush();
    expect(await done).toBe(false);
    expect(h.built).toEqual(["car"]);
    expect(h.gate.garageWarm).toBe(0);
    expect(h.pre.state().last!.result).toBe("superseded");
  });
  it("a Home garage already draws the room: car only, ready without a hidden frame", async () => {
    const h = page({ kind: "garage" });
    const done = h.pre.run(owned(h), "title");
    await h.flush();
    expect(await done).toBe(true);
    expect(h.built).toEqual(["car"]);
    expect(h.warms()).toBe(0);
    expect(h.pre.state().ready).toBe(true);
  });
  it("a frameless title prebuild never stands in for race settings' hidden frames", async () => {
    for (const kind of ["track", "garage"]) {
      const h = page({ kind });
      const title = h.pre.run(owned(h), "title");
      await h.flush(2);
      expect(await title).toBe(true);
      expect(h.gate.garageReady).toBe(false);
      h.els["race-settings"]!.hidden = false; h.els["overlay"]!.hidden = true;
      const settings = h.pre.run(owned(h), "settings");
      await h.flush(2);
      expect(h.gate.garageWarm).toBe(2);
      expect(h.warms()).toBe(1);
      expect(h.built).toEqual(["car", "room"]);
      h.gate.garageWarm = 0; h.gate.garageReady = true;
      await h.flush();
      expect(await settings).toBe(true);
      expect(await h.pre.run(owned(h), "settings")).toBe(false);
    }
  });
  it("blocked runs build nothing: Save-Data on the title, a race start anywhere", async () => {
    const h = page();
    h.env.nav = { connection: { saveData: true } };
    expect(await h.pre.run(owned(h), "title")).toBe(false);
    expect(h.pre.state().blockers).toEqual(["save-data"]);
    h.env.nav = {};
    h.G.loadingScreen.active = () => true;
    expect(await h.pre.run(owned(h), "title")).toBe(false);
    expect(h.built).toEqual([]);
  });
  it("car and room build while the pack is still uploading; frames wait for packSettled", async () => {
    const h = page();
    h.env.pack = { supported: true, uploaded: false, error: null, tier: null };
    const done = h.pre.run(owned(h), "title");
    await h.flush(2);
    expect(h.built).toEqual(["car", "room"]);
    expect(h.gate.garageWarm).toBe(0);
    h.env.pack = { supported: true, uploaded: true, tier: "high" };
    await h.flush(2);
    expect(h.warms()).toBe(1);
    h.gate.garageWarm = 0; h.gate.garageReady = true;
    await h.flush();
    expect(await done).toBe(true);
  });
  it("the tap-to-first-frame measure counts only the visible garage", async () => {
    const h = page({ kind: "garage" });
    let ok = false;
    const frame = h.pre.timed(() => { h.advance(30); return ok; });
    frame(0.016);
    expect(h.pre.state().firstFrame).toBeNull();
    h.pre.markOpen("menu");
    h.G.setupPreviewOn = true;
    frame(0.016);
    ok = true; h.advance(10); frame(0.016);
    expect(h.pre.state().firstFrame).toEqual({ from: "menu", visit: 1, tapMs: 70, workMs: 60, calls: 2, prebuilt: false });
    expect(h.logs).toContain("game: garage first frame 70 ms after the tap (60 ms in 2 frame call(s), prebuilt false)");
    h.G.setupPreviewOn = false;
    const p = h.pre.run(owned(h), "title"); await h.flush(); await p;
    h.pre.markOpen("menu"); h.G.setupPreviewOn = true; frame(0.016);
    expect(h.pre.state().firstFrame!.prebuilt).toBe(true);
  });
  it("setEnabled(false) stops the title prebuild; true re-arms", async () => {
    const h = page();
    expect(h.pre.setEnabled(false)).toBe(false);
    expect(await h.pre.run(owned(h), "title")).toBe(false);
    expect(h.pre.state().blockers).toEqual(["off"]);
    expect(h.pre.setEnabled(true)).toBe(true);
    const p = h.pre.run(owned(h), "title"); await h.flush(2); h.gate.garageReady = true; await h.flush();
    expect(await p).toBe(true);
    h.pre.setEnabled(true);
    expect(h.pre.state().ready).toBe(false);
    expect(h.pre.state().last).toBeNull();
  });
  it("release at race start frees the garage and re-arms the next title prebuild", async () => {
    const h = page();
    const go = async () => { const p = h.pre.run(owned(h), "title"); await h.flush(2); h.gate.garageReady = true; await h.flush(); return p; };
    expect(await go()).toBe(true);
    h.G.setupPreviewOn = true;
    expect(h.pre.release()).toBe(false);
    h.G.setupPreviewOn = false; h.G.state = "count";
    expect(h.pre.release()).toBe(true);
    expect(h.cam.released).toBe(1);
    expect([h.gate.garageReady, h.gate.garageKey]).toEqual([false, ""]);
    expect(h.logs).toContain("game: garage released for the race");
    expect(await h.pre.run(owned(h), "title")).toBe(false);
    h.G.state = "menu";
    expect(await go()).toBe(true);
    expect(h.built).toEqual(["car", "room"]);
  });
});
