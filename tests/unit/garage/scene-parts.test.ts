// The garage scene's component modules against f1-game's originals in a Node
// VM: GaragePrims (prims.ts), GarageEquipment (equipment.ts), GarageCrew
// (crew.ts), GarageLive (live.ts), GarageDress (dress.ts) and PitSigns
// (pit-signs.ts). Geometry compares by Float64-bit hash, painters by their 2D
// op logs. Ported f1-game assertions (scene-live, garage-crew, pit-signs) and
// spot values run without f1-game.
import { describe, expect, it } from "vitest";
import * as P from "../../../src/garage/scene/prims";
import { build as buildEquipment, FAN, SCREEN } from "../../../src/garage/scene/equipment";
import { createGarageCrew, layout, LOWERED, RAISED } from "../../../src/garage/scene/crew";
import * as Live from "../../../src/garage/scene/live";
import { buildDress, createGarageDress, boardKey, D_CREST, uvOf } from "../../../src/garage/scene/dress";
import { cellRect, createPitSigns, crestRect, uvRect, type PitSignTrack } from "../../../src/garage/scene/pit-signs";
import { CAR_PARTS, FIXTURES, groups, SIDES } from "../../../src/garage/scene/scene";
import { SIGN } from "../../../src/track/core/pit";
import type { GarageCanvas, GarageCtx, GarageExperienceApi, GarageParts } from "../../../src/garage/scene/types";
import { f1Scene, fnv, hasF1Scene, LIV, LIV2, liveryStub, recordingCanvas, recordingGfx, SCENE_FILES, summary, TEAM, TEAM2 } from "./scene-vm";

type AnyFn = (...a: unknown[]) => unknown;
type Mod = Record<string, AnyFn> & Record<string, unknown>;
const f1 = (globals: Record<string, unknown> = {}, extra: string[] = []) => f1Scene(globals, [...SCENE_FILES, ...extra]);
const sumAll = (g: Record<string, object>) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, summary(v as never)]));
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const as = <T>(v: unknown) => v as T;

describe.skipIf(!hasF1Scene)("prims, equipment and crew match f1-game", () => {
  let cached: ((name: string) => unknown) | null = null;
  const get = (name: string) => (cached || (cached = f1()))(name);
  const GPs = () => get("GaragePrims") as Mod;

  it("constants", () => {
    const GP = GPs();
    for (const k of ["HALF_W", "Z_BACK", "Z_DOOR", "CEIL_Y", "PANEL", "STEEL", "DARK", "BOX_F", "WALL_KEYED"] as const)
      expect(plain((P as unknown as Record<string, unknown>)[k])).toEqual(plain(GP[k]));
    expect(P.MAT).toEqual(plain(GP["MAT"]));
    expect([0.3, 1.2, 0.7].map((v) => P.css([v, v / 2, -v]))).toEqual([0.3, 1.2, 0.7].map((v) => (GP["css"] as AnyFn)([v, v / 2, -v])));
  });

  it("block, cyl, tube, hose, panelGrid and tile, bit for bit", () => {
    const GP = GPs();
    const run = (M: Mod | typeof P) => {
      const m = P.acc(), call = (n: string, ...a: unknown[]) => (M as unknown as Record<string, AnyFn>)[n]!(m, ...a);
      for (const mid of [undefined, 0, 1, 4, 16]) {
        call("block", 0.3, 1.1, -2.2, 0.4, 0.05, 0.9, [0.2, 0.3, 0.4], mid);
        call("cyl", -1, 0.2, 3.3, 0.21, 0.6, [0.5, 0.5, 0.5], mid === 4 ? 0 : 7, mid);
        call("tube", [0, 0, 0], [0.3, 1.9, -0.4], 0.07, [0.1, 0.2, 0.3], 9, mid);
        call("tube", [1, 2, 3], [1, 2.5, 3], 0.2, [0.1, 0.2, 0.3], undefined, mid);
        call("hose", [[0, 0, 0], [1, 1, 0], [1, 1, 1], [2, 0.5, 1]], 0.03, [0.9, 0.1, 0.1], 5, mid);
        call("panelGrid", [-1, 0, 2], [2, 0, 0], [0, 3, 0.1], 3, 2, [0, 0, -1], (u: number, v: number) => [u, v, u * v], mid);
        call("panelGrid", [-1, 0, 2], [2, 0, 0], [0, 3, 0.1], 2, 2, [0, 0, 1], () => [1, 1, 1], mid);
        call("tile", -1, 2, -3, 4, [0.4, 0.5, 0.6], mid ? 0.01 : undefined, mid);
      }
      return summary(m);
    };
    expect(run(P)).toEqual(run(GP));
  });

  it("equipment.build for dry, wet and a trophy-laden career", () => {
    const GE = get("GarageEquipment") as Mod;
    expect([...FAN]).toEqual(plain(GE["FAN"])); expect([...SCREEN]).toEqual(plain(GE["SCREEN"]));
    for (const liv of [LIV, LIV2, null]) for (const ctx of [null, { weather: "wet" }, { weather: "rain", wins: 7 }, { wins: 30 }]) {
      const a = groups(), b = groups();
      buildEquipment(a, liv, ctx);
      (GE["build"] as AnyFn)(b, liv, ctx);
      expect(sumAll(a)).toEqual(sumAll(b));
    }
  });

  it("the crew: meshes, draws and layouts", () => {
    const g = f1({}, []), C = g("GarageCrew") as Mod;
    const ra = recordingGfx(), rb = recordingGfx();
    const mine = createGarageCrew();
    mine.init(ra.gfx); (C["init"] as AnyFn)(rb.gfx);
    const poses = [{ door: 0 }, { door: 0.5, z: 0.1 }, { door: 1, z: 2 }, { door: 0.8, z: 0, x: -0.6 }];
    for (const liv of [LIV, LIV2]) for (const eye of [[-3, 2, 1], [4, 2, -1]]) for (const p of poses) {
      mine.draw(liv, eye, p); (C["draw"] as AnyFn)(liv, eye, p);
      for (const cam of [-1, 1]) expect(layout(p, cam)).toEqual(plain((C["layout"] as AnyFn)(p, cam)));
    }
    mine.draw(LIV, [0, 0, 0], null); (C["draw"] as AnyFn)(LIV, [0, 0, 0], null);
    mine.free(); (C["free"] as AnyFn)();
    expect(ra.log).toEqual(rb.log);
    expect(ra.log.filter((l) => l.startsWith("draw")).length).toBe(2 * 2 * 4 * 4);
  });
});

describe("crew (garage-crew.test.mjs, always run)", () => {
  it("mechanics step back as the shutter lifts, clear of the car's path", () => {
    const shut = layout({ door: 0, z: 0 }, -1), open = layout({ door: 1, z: 0 }, -1);
    for (let i = 0; i < 2; i++) {
      expect(Math.abs(open.mechanics[i]![0])).toBeGreaterThan(Math.abs(shut.mechanics[i]![0]) + 1);
      expect(Math.abs(open.mechanics[i]![0]) - 0.3).toBeGreaterThan(1.3);
    }
    expect(shut.mechanics[0]![0]).toBeLessThan(0); expect(shut.mechanics[1]![0]).toBeGreaterThan(0);
  });
  it("the lollipop man stands on the camera's side, board down while parked, up once it rolls", () => {
    for (const cam of [-1, 1]) {
      const a = layout({ door: 1, z: 0 }, cam).lollipop, b = layout({ door: 1, z: 2 }, cam).lollipop;
      expect(Math.sign(a.x)).toBe(cam);
      expect(a.z).toBeGreaterThan(6.4); expect(a.z).toBeLessThan(6.4 + 5.5);
      expect(a.raise).toBe(LOWERED); expect(b.raise).toBe(RAISED);
    }
  });
  it("drawn only while a pose plays: three figures and one pole", () => {
    const r = recordingGfx(), c = createGarageCrew();
    c.init(r.gfx);
    c.draw(LIV, [-3.8, 2.1, -4.8], null);
    expect(r.log.length).toBe(0);
    c.draw(LIV, [-3.8, 2.1, -4.8], { door: 1, z: 2 });
    expect(r.log.filter((l) => l.startsWith("draw")).length).toBe(4);
  });
});

/** A track whose `points` getter throws, as a LAZY_CIRCUIT meta stub does (scene-live.test.mjs). */
const stub = () => {
  const e = { id: "spa", name: "Spa-Francorchamps", country: "Belgium" };
  Object.defineProperty(e, "points", { get() { throw new Error('Tracks: circuit "spa" has no path'); } });
  return e;
};
const LIVE_CTXS: (GarageCtx | null)[] = [
  null, { weather: "dry" }, { track: stub(), weather: "dry" },
  { track: { id: "x", name: "X", country: "UK", points: [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]] }, night: true, weather: "wet" },
  { track: { id: "suzuka", country: "Japan", points: [[0, 0, 0], [50, 0, -10], [90, 0, 70], [10, 0, 50], [-5, 0, 20]] }, career: true, round: 3, last: { p: 2, pts: 18 }, sponsor: { label: "Acme" } },
  { track: { id: "mtl", name: "Montreal", country: "Canada" }, career: true, last: { dnf: "gearbox" } },
  { track: { id: "nowhere", name: "Nowhere", country: "Atlantis" }, career: true },
];

describe.skipIf(!hasF1Scene)("live and dress atlases match f1-game", () => {
  it("paintLive, paintTrace and the live quads", () => {
    const ca = recordingCanvas(), cb = recordingCanvas();
    const get = f1(), GL = get("GarageLive") as Mod;
    const vmGet = f1Scene({ LiveryTex: liveryStub([]) }, SCENE_FILES), GLS = vmGet("GarageLive") as Mod;
    const tex = liveryStub([]);
    for (const team of [TEAM, TEAM2, { id: "unknown" }]) for (const liv of [LIV, LIV2, null]) for (const ctx of LIVE_CTXS) {
      Live.paintLive(as<GarageCanvas>(ca.createCanvas(512, 512)), team, liv, ctx, tex);
      (GLS["paintLive"] as AnyFn)(cb.createCanvas(512, 512), team, liv, ctx);
    }
    for (const t of [0, 1500, 98765.4]) {
      Live.paintTrace(as<GarageCanvas>(ca.createCanvas(512, 512)), LIV, t);
      (GL["paintTrace"] as AnyFn)(cb.createCanvas(512, 512), LIV, t);
    }
    expect(ca.ops.length).toBeGreaterThan(1000);
    expect(ca.ops).toEqual(cb.ops);
    expect(sumAll(Live.build(FIXTURES) as never)).toEqual(sumAll((GL["build"] as AnyFn)(FIXTURES) as never));
    for (const k of ["LIVE", "L_MAP", "L_TRACE", "L_SHADOW", "L_POOL", "L_BANNER", "L_FLAG", "L_RACE", "FLAGS"])
      expect(plain((Live as unknown as Record<string, unknown>)[k])).toEqual(plain(GL[k]));
  });

  it("paintDress, paintBoards, boardInfo and buildDress", () => {
    const ca = recordingCanvas(), cb = recordingCanvas();
    const career = {
      owned: (id: string) => id === "ferrari", budget: () => 1200, data: () => ({ tdev: { ferrari: 2 } }),
      driverOverride: (id: string, i: number) => (id === "ferrari" && i === 0 ? { name: "You", code: "YOU", num: 7 } : null),
      teamStats: (t: { stats?: object }) => t.stats || null,
    };
    const get = f1Scene({ document: cb.document, LiveryTex: liveryStub(cb.ops), Career: career }, [...SCENE_FILES, "js/car/parts.js"]);
    const GD = get("GarageDress") as Mod;
    const experience = get("GarageExperience") as GarageExperienceApi;
    const dress = createGarageDress({
      livery: liveryStub(ca.ops) as never, parts: CAR_PARTS, career: career as never, experience,
      log: { info() {}, warn() {} }, createCanvas: ca.createCanvas as never,
    });
    const parts = (id: unknown) => (id === "ferrari" ? { engine: "turbo", brakes: "carbon", tyres: "soft" } : {});
    const res: unknown[][] = [[], []];
    for (const [team, liv] of [[TEAM, LIV], [TEAM2, LIV2], [{ id: "x", name: "Xteam" }, null]] as const)
      for (const ctx of [null, { unlimited: true }, { unlimited: false }]) for (const seat of [0, 1]) {
        const ia = dress.boardInfo(team as never, parts, seat, ctx);
        const ib = (GD["boardInfo"] as AnyFn)(team, parts, seat, ctx) as never;
        res[0]!.push(ia, boardKey(ia), dress.seatDriverAt(team as never, seat));
        res[1]!.push(ib, (GD["boardKey"] as AnyFn)(ib), (GD["seatDriverAt"] as AnyFn)(team, seat));
        const cva = dress.paintDress(team as never, liv).canvas;
        const cvb = ((GD["paintDress"] as AnyFn)(team, liv) as { canvas: unknown }).canvas;
        dress.paintBoards(cva, team as never, liv, ia);
        (GD["paintBoards"] as AnyFn)(cvb, team, liv, ib);
      }
    dress.resetSpec(); (GD["resetSpec"] as AnyFn)();
    expect(res[0]).toEqual(plain(res[1]));
    expect(res[0]!.filter((x) => x && typeof x === "object" && "stats" in (x as object)).length).toBeGreaterThan(5);
    expect(ca.ops.length).toBeGreaterThan(2000);
    expect(ca.ops).toEqual(cb.ops);
    expect(sumAll(buildDress(SIDES) as never)).toEqual(sumAll((GD["buildDress"] as AnyFn)(SIDES) as never));
  });
});

describe("live atlas on a hydrating circuit (scene-live.test.mjs, always run)", () => {
  const fake = () => {
    const texts: string[] = [], strokes = { n: 0 };
    const c2d = new Proxy({} as Record<string, unknown>, {
      get(t, k: string) {
        if (k === "fillText") return (s: unknown) => texts.push(String(s));
        if (k === "stroke") return () => { strokes.n++; };
        if (k === "createRadialGradient") return () => ({ addColorStop() {} });
        return k in t ? t[k] : () => {};
      },
      set(t, k: string, v) { t[k] = v; return true; },
    });
    return { cv: as<GarageCanvas>({ width: 512, height: 512, getContext: () => c2d }), texts, strokes };
  };
  it("paintLive on an unhydrated stub paints the rest of the atlas instead of throwing", () => {
    const { cv, texts, strokes } = fake();
    expect(() => Live.paintLive(cv, TEAM, LIV, { track: stub() as never, weather: "dry" })).not.toThrow();
    expect(texts.some((t) => /SPA-FRANCORCHAMPS GP/.test(t))).toBe(true);
    expect(texts.some((t) => /BELGIUM/.test(t))).toBe(true);
    expect(strokes.n).toBe(0);
  });
  it("paintLive still draws the map once the circuit has points", () => {
    const { cv, strokes } = fake();
    Live.paintLive(cv, TEAM, LIV, { track: { id: "x", name: "X", country: "UK", points: [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]] } });
    expect(strokes.n).toBeGreaterThanOrEqual(2);
  });
  it("atlas spot values", () => {
    expect(uvOf(D_CREST)).toEqual({ uL: 0, uR: 0.5, vT: 1, vB: 0.5 });
    expect(fnv(Live.build(FIXTURES).floor.pos)).toBe(SPOT_LIVE_FLOOR);
    expect(fnv(buildDress(SIDES).back.uv)).toBe(SPOT_DRESS_BACK_UV);
  });
});

// ── pit signs ───────────────────────────────────────────────────────────────
const boxes = Array.from({ length: 12 }, (_, i) => ({
  team: ["mercedes", "ferrari", "mclaren"][i % 3]!, name: ["Mercedes", "Ferrari", "McLaren AMG Long Name"][i % 3]!,
  short: ["MER", "FER", ""][i % 3]!, col: i % 4 ? [0.1 * (i % 10), 0.5, 0.2] : null, col2: [0.9, 0.9, 0.2], logo3: i === 5 ? [1, 0, 0] : null,
}));
const quads = () => ({ pos: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], nrm: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], uv: [0, 0, 1, 0, 1, 1, 0, 1], idx: [0, 1, 2, 0, 2, 3], centre: [100, 0, 50], anchors: [[600, 0, 50]] });
const track = (signal = true): PitSignTrack & { meshes: Record<string, unknown> } => ({
  pitSigns: quads(), pitSignal: signal ? quads() : null, meshes: {},
  pit: { row: { boxes }, side: -1, limitKph: 60 }, def: { id: "silverstone" },
});

describe.skipIf(!hasF1Scene)("PitSigns matches f1-game js/garage/pit-signs.js", () => {
  it("paintAtlas, desktop and phone, both sides", () => {
    const ca = recordingCanvas(), cb = recordingCanvas();
    const get = f1Scene({ document: cb.document, LiveryTex: liveryStub(cb.ops) }, ["js/track/core/pit.js", "js/garage/pit-signs.js"]);
    const PS = get("PitSigns") as Mod;
    const mine = createPitSigns({ livery: liveryStub(ca.ops) as never, createCanvas: ca.createCanvas as never });
    for (const opts of [undefined, { mobile: true, side: -1, limitKph: 60 }, { side: 1 }]) {
      const a = mine.paintAtlas(boxes, opts), b = (PS["paintAtlas"] as AnyFn)(boxes, opts) as { width: number; height: number };
      expect([a.width, a.height]).toEqual([b.width, b.height]);
    }
    expect(ca.ops.length).toBeGreaterThan(300);
    expect(ca.ops).toEqual(cb.ops);
    for (let i = 0; i < 16; i++) {
      expect(cellRect(i)).toEqual(plain((PS["cellRect"] as AnyFn)(i)));
      expect(uvRect(i)).toEqual(plain((PS["uvRect"] as AnyFn)(i)));
    }
  });
});

describe("PitSigns (pit-signs.test.mjs, always run)", () => {
  it("without a canvas and the livery painter: unsupported, uploads nothing, no throw", () => {
    const P0 = createPitSigns({});
    expect(P0.supported()).toBe(false);
    const calls: string[] = [];
    const G = { createTexMesh: () => { calls.push("mesh"); return {}; }, createTexture: () => { calls.push("tex"); return {}; } };
    const t = track();
    expect(P0.upload(G, t)).toBe(false);
    expect(calls).toEqual([]);
    expect(P0.draw({ drawDecal: () => calls.push("draw") }, t, new Float32Array(16), [0, 0, 0], false, false)).toBe(false);
  });
  it("paints every cell and crest, uploads one texture + the sign and signal meshes, gates the draw on distance", () => {
    const painted: { id: unknown; R: { y: number; w: number } }[] = [], texts: string[] = [];
    const cv = recordingCanvas();
    const P1 = createPitSigns({
      createCanvas: cv.createCanvas as never,
      livery: { paintTeamMark: (_c, id, _l, R) => { painted.push({ id, R }); }, inkOn: () => [0.97, 0.97, 0.98] },
    });
    expect(P1.supported()).toBe(true);
    const up: [string, unknown][] = [];
    const G = { createTexMesh: (d: unknown) => { up.push(["mesh", d]); return { id: up.length }; },
                createTexture: (c: unknown) => { up.push(["tex", c]); return { id: "t" }; } };
    const t = track();
    expect(P1.upload(G, t)).toBe(true);
    expect(painted.length).toBe(24);
    expect(painted.slice(0, 12).map((x) => x.id)).toEqual(boxes.map((b) => b.team));
    for (const x of painted.slice(12)) { expect(x.R.y).toBeGreaterThanOrEqual(SIGN.crestY); expect(x.R.w).toBeGreaterThan(SIGN.crestPx * 0.6); }
    for (const op of cv.ops) { const m = /fillText\(\["([^"]*)"/.exec(op); if (m) texts.push(m[1]!); }
    expect(texts).toContain("MER"); expect(texts).toContain("FER");
    expect(texts.some((s) => /◀ PIT ENTRY/.test(s))).toBe(true);
    expect(texts).toContain("PIT LANE 60 km/h");
    expect(up.filter((u) => u[0] === "mesh").length).toBe(2);
    const tex = up.find((u) => u[0] === "tex")![1] as { width: number; height: number };
    expect([tex.width, tex.height]).toEqual([SIGN.w, SIGN.h]);
    const drawn: number[] = [];
    const gfx = { drawDecal: (_m: unknown, _x: unknown, _t: unknown, o: { glow: number }) => { drawn.push(o.glow); }, freeMesh() {}, freeTexture() {} };
    const M = new Float32Array(16);
    expect(P1.draw(gfx, t, M, [200, 0, 50], true, false)).toBe(true);
    expect(P1.draw(gfx, t, M, [650, 0, 50], false, false, true)).toBe(true);   // near an anchor; called in
    expect(P1.draw(gfx, t, M, [3000, 0, 50], true, false)).toBe(false);
    expect(P1.draw(gfx, t, M, [100, 0, 50], false, true)).toBe(false);
    expect(drawn).toEqual([0.5, 0, 0]);
    expect(P1.stats()).toEqual({ drawn: 2, calls: 4 });
    P1.free(gfx, t);
    expect(t.meshes["pitSigns"]).toBeNull();
  });
  it("a phone (isMobile or mobileTier) gets the half-size atlas", () => {
    const cv = recordingCanvas();
    const P1 = createPitSigns({ createCanvas: cv.createCanvas as never, livery: { paintTeamMark() {}, inkOn: () => [1, 1, 1] } });
    const size = (flags: object) => {
      const up: { width: number; height: number }[] = [];
      P1.upload({ createTexMesh: () => ({}), createTexture: (c: { width: number; height: number }) => { up.push(c); return {}; }, ...flags } as never, track());
      return [up[0]!.width, up[0]!.height];
    };
    expect(size({ isMobile: false, mobileTier: false })).toEqual([SIGN.w, SIGN.h]);
    expect(size({ isMobile: true, mobileTier: false })).toEqual([SIGN.w / 2, SIGN.h / 2]);
    expect(size({ isMobile: false, mobileTier: true })).toEqual([SIGN.w / 2, SIGN.h / 2]);
  });
  it("an upload that throws after the texture landed frees the texture and the mesh it made", () => {
    const cv = recordingCanvas(), warns: string[] = [];
    const P1 = createPitSigns({ createCanvas: cv.createCanvas as never, livery: { paintTeamMark() {}, inkOn: () => [1, 1, 1] },
      log: { info() {}, warn: (m) => warns.push(m) } });
    const freed: string[] = [];
    let n = 0;
    const G = {
      createTexture: () => ({ id: "tex" }),
      createTexMesh: () => { if (++n === 2) throw new Error("device lost"); return { id: "mesh" + n }; },
      freeTexture: (h: object) => { freed.push((h as { id: string }).id); }, freeMesh: (h: object) => { freed.push((h as { id: string }).id); },
    };
    const t = track();
    expect(P1.upload(G, t)).toBe(false);
    expect(freed.sort()).toEqual(["mesh1", "tex"]);
    expect([t.meshes["pitSigns"], t.meshes["pitSignTex"], t.meshes["pitSignal"]]).toEqual([null, null, null]);
    expect(warns).toEqual(["silverstone: pit signs skipped: device lost"]);
  });
  it("crest cells sit in the atlas's lower half", () => {
    expect(crestRect(7)).toEqual({ x: 160, y: SIGN.crestY + 160, w: 160, h: 160 });
  });
});

describe("CAR_PARTS adapts src/car/parts.ts to the boards", () => {
  it("resolves a setup into stat mods, cost and option labels", () => {
    const parts: GarageParts = CAR_PARTS;
    const r = parts.resolveSetup({}, { id: "mclaren" });
    expect(Object.keys(r.mods).sort()).toEqual(["accel", "braking", "cornering", "speed"]);
    expect(parts.STAT_KEYS.map((k) => k.key)).toEqual(["speed", "accel", "cornering", "braking"]);
    expect(parts.BUDGET).toBe(780);
    expect(parts.CATALOG.every((c) => r.options[c.id])).toBe(true);
  });
});

const SPOT_LIVE_FLOOR = "9b5ee8bd";
const SPOT_DRESS_BACK_UV = "9095a795";
