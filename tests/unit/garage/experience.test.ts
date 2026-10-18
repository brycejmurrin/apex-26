// @vitest-environment happy-dom
// GarageExperience (src/garage/experience.ts) against f1-game's
// js/garage/experience.js. Behaviour assertions are ported from f1-game
// tests/unit/garage-mesh.test.mjs:62-112 (clock, homeSession, homeShot) and
// garage-sheet-round2.test.mjs:113-125 (statsOf / compare); the pure maths
// (freePane, fitHome, compare, buildFacility, paintCareer) is compared with
// the original in a Node VM bit for bit, skipped where /home/f1-game is absent.
import { describe, expect, it } from "vitest";
import {
  buildFacility, canOrbit, careerKey, clock, createGarageExperience, fitHome, freePane, GarageExperience, homeSession, homeShot,
  paintCareer, type HomePose, type HomeShotName,
} from "../../../src/garage/experience";
import { Parts, type PartOption } from "../../../src/car/parts";
import { Teams } from "../../../src/car/teams";
import { createGarageScene } from "../../../src/garage/scene/scene";
import type { GarageCanvas, GarageCtx, GarageTeam, Groups } from "../../../src/garage/scene/types";
import { hasF1Scene, recordingCanvas, recordingGfx, SCENE_FILES } from "./scene-vm";
import { f1Load } from "./f1-garage-vm";

type Fn = (...a: unknown[]) => unknown;
const F1_FILES = ["js/core/mat4.js", "js/physics/consts.js", "js/car/parts.js", "js/data/teams.js", ...SCENE_FILES];
const LOG = { info() {}, warn() {}, error() {}, debug() {}, enabled: () => false };
function f1Exp(globals: Record<string, unknown> = {}): Record<string, Fn> {
  return f1Load(F1_FILES, { Log: LOG, ...globals })("GarageExperience") as Record<string, Fn>;
}
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const bits = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x: unknown) => typeof x === "number" ? `n:${Object.is(x, -0) ? "-0" : x}` : x));

describe("clock and home session (garage-mesh.test.mjs:62-112)", () => {
  it("garage ambient clock freezes fans and light time without a resume jump", () => {
    const c = clock(1000);
    expect(c.step(1050, true)).toBe(1050);
    expect(c.step(2050, false)).toBe(1050);
    expect(c.step(3050, false)).toBe(1050);
    expect(c.step(3075, true)).toBe(1075);
    c.reset(5000); expect(c.value).toBe(5000);
  });

  it("home camera owns one reversible session and respects effective reduced motion", () => {
    const saved = { az: 2.1, spin: true, aim: [0, 1, 2] };
    const restored: unknown[] = [], views: string[] = []; let reducing = false, captures = 0;
    const home = homeSession({ capture() { captures++; return saved; },
      restore(s) { restored.push(s); }, view(v) { views.push(v); } }, () => reducing);
    expect(home.begin("invalid")).toBe(false);
    expect(home.begin("garage", { motion: "ambient" })).toBe(true);
    expect(home.moving).toBe(true);
    reducing = true; expect(home.moving).toBe(false);
    home.begin("studio", { motion: "still" });
    expect(captures, "changing a scene must not replace the original owner snapshot").toBe(1);
    expect(home.moving).toBe(false); expect(home.mode).toBe("studio");
    expect(views).toEqual(["hero", "side"]);
    expect(home.end()).toBe(true); expect(restored[0]).toBe(saved);
    expect(home.active).toBe(false); expect(home.end()).toBe(false);
  });

  it("selected home shots stay composed under reduced motion and restore the original camera", () => {
    const original = { az: 1.2, el: 0.4, dist: 6.8, spin: true, pan: [1, 0, 2] };
    let pose: unknown = original, snapshots = 0;
    const home = homeSession<typeof original>({ capture() { snapshots++; return original; },
      restore(s) { pose = s; }, view(name: HomeShotName, shot: HomePose) { pose = { name, ...shot }; } }, () => true);
    const angles = new Set<number>();
    for (const name of ["hero", "front", "side", "rear"] as const) {
      expect(home.begin("night", { shot: name, motion: "ambient" })).toBe(true);
      expect(home.state()!.shot).toBe(name);
      expect(home.state()!.motion, "effective reduced motion keeps the selected shot still").toBe("still");
      expect(home.moving).toBe(false);
      const p = pose as { name: string; az: number; dist: number };
      expect(p.name).toBe(name); angles.add(p.az);
      expect(p.dist >= 6.4 && p.dist <= 10.2, "whole-car shots keep a safe orbit distance").toBe(true);
      const fixed = pose; home.state(); home.state();
      expect(pose, "reading state never rotates or reselects a shot").toBe(fixed);
    }
    expect(angles.size, "every selected view has a distinct azimuth").toBe(4);
    expect(snapshots, "changing a shot never replaces the original owner").toBe(1);
    home.end(); expect(pose).toBe(original);
    expect(homeShot("garage", "invalid").name).toBe("hero");
    expect(homeShot("studio", "invalid").name).toBe("side");
  });

  it("canOrbit: the garage always, Home only with the photo studio, never while blocked", () => {
    expect(canOrbit(true, false, false, false)).toBe(true);
    expect(canOrbit(false, true, false, false)).toBe(false);
    expect(canOrbit(false, true, true, false)).toBe(true);
    expect(canOrbit(true, true, true, true)).toBe(false);
  });
});

describe("statsOf / compare (garage-sheet-round2.test.mjs:113-125)", () => {
  const team = Teams.LIST.find((t) => t.id === "mercedes")!;
  const gTeam = team as unknown as GarageTeam;
  const career = { teamStats: (t: GarageTeam) => Object.fromEntries(Object.entries(t.stats || {}).map(([k, v]) => [k, (v as number) + 4])) };
  it("reads Career.teamStats in a career, team.stats outside one", () => {
    const E = createGarageExperience({ career });
    expect(E.statsOf(gTeam)!["speed"]).toBe(team.stats.speed + 4);
    expect(GarageExperience.statsOf(gTeam), "no Career at all: the base stats").toBe(team.stats);
    const cat = Parts.CATALOG.find((c) => c.id === "engine")!;
    const [a, b] = cat.options.filter((o) => Parts.isOptionAvailable(o, team)) as [PartOption, PartOption];
    const dev = E.compare(gTeam, {}, cat, a, b, null, 1000).deltas;
    const flat = createGarageExperience({ career: { teamStats: (t) => t.stats } }).compare(gTeam, {}, cat, a, b, null, 1000).deltas;
    expect(dev.length).toBe(flat.length);
  });

  it("partSummary shows the fitted part and a candidate's cost, cap and stat deltas", () => {
    const host = document.createElement("div");
    const cat = Parts.CATALOG.find((c) => c.id === "aero")!;
    const opts = cat.options.filter((o) => Parts.isOptionAvailable(o, team));
    let framed = 0;
    const show = GarageExperience.partSummary(host, gTeam, {}, cat, opts[0], null, 780, () => { framed++; });
    const box = host.querySelector(".cs-inspection")!;
    expect(box.getAttribute("aria-label")).toBe("Part comparison");
    expect(box.querySelector("p")!.textContent).toBe("Fitted · inspect the car or compare another option.");
    const pricey = opts.find((o) => o.cost > (opts[0]!.cost || 0))!;
    show(pricey);
    expect(box.querySelector("strong")!.textContent).toBe(pricey.label);
    expect(box.querySelector("p")!.textContent).toMatch(/^\+\d+ cr vs fitted · -?\d+ cr remaining/);
    show(pricey);
    GarageExperience.partSummary(host, gTeam, {}, cat, opts[0], null, Infinity, () => {})(pricey);
    expect(host.querySelectorAll(".cs-inspection")[1]!.querySelector("p")!.textContent).toContain("Free build");
    (box.querySelector("button") as HTMLButtonElement).click();
    expect(framed).toBe(1);
    expect(box.querySelector("button")!.textContent).toBe("INSPECT AERO");
  });

  it("careerKey is '-' without active achievements, and the scene keys its room on it by default", () => {
    expect(careerKey(null)).toBe("-");
    expect(careerKey({ achievements: { active: false, facility: 3 } })).toBe("-");
    const ach = { active: true, facility: 5, facilityMax: 8, wins: 3, podiums: 6, titles: 1 };
    expect(careerKey({ achievements: ach })).toBe("5:3:6:1");
    const scene = createGarageScene({ createCanvas: null, crew: null });
    expect(scene.ctxKey({ achievements: ach }).endsWith("|5:3:6:1")).toBe(true);
  });

  it("the scene's default experience builds the research facility (not NO_EXPERIENCE)", () => {
    const rec = recordingGfx();
    const ctx: GarageCtx = { achievements: { active: true, facility: 4, facilityMax: 8, wins: 2, podiums: 3, titles: 0 } };
    const withCareer = createGarageScene({ createCanvas: null, crew: null }), without = createGarageScene({ createCanvas: null, crew: null });
    withCareer.init(rec.gfx as never);
    withCareer.prepare(gTeam, null, null, 0, ctx);
    const n = rec.meshes.length;
    const rec2 = recordingGfx();
    without.init(rec2.gfx as never);
    without.prepare(gTeam, null, null, 0, {});
    const sum = (m: { pos?: ArrayLike<number> }[]) => m.reduce((a, x) => a + (x.pos ? x.pos.length : 0), 0);
    expect(rec.meshes.length).toBe(n);
    expect(sum(rec.meshes), "facility geometry joins the back wall").toBeGreaterThan(sum(rec2.meshes));
  });
});

describe.skipIf(!hasF1Scene)("bit-exact against f1-game js/garage/experience.js", () => {
  it("freePane over landscape / portrait docks on either side", () => {
    const F = f1Exp();
    const R = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
    const canvas = R(0, 0, 1440, 900), port = R(10, 0, 393, 852);
    for (const [p, c] of [[R(1030, 0, 410, 900), canvas], [R(0, 0, 410, 900), canvas], [R(0, 0, 393, 500), port], [R(10, 400, 393, 452), port], [R(-50, 0, 2000, 900), canvas]] as const) {
      expect(bits(freePane(p, c))).toEqual(bits(plain(F["freePane"]!(p, c))));
    }
  });

  it("fitHome bisects to the same distance and lens shift", () => {
    const F = f1Exp();
    // a car-sized hull, deterministic
    const hull: number[] = [];
    for (let i = 0; i < 60; i++) hull.push(Math.sin(i * 1.7) * 0.95, 0.1 + Math.abs(Math.cos(i * 0.9)) * 0.9, Math.sin(i * 0.37) * 2.8 + 0.2);
    const panes = [{ left: 0, right: 0.6, top: 0, bottom: 1 }, { left: 0.4, right: 1, top: 0, bottom: 1 }, { left: 0, right: 1, top: 0.55, bottom: 1 }];
    for (const pane of panes) for (const az of [0.3, Math.PI * 0.78, 2.9]) for (const [aspect, fov] of [[1.6, 36], [0.46, 72], [1.33, 54]] as const) {
      const rig = { az, el: 0.3, center: [0, 0.45, 0.245], aspect, fov, minDist: 4.6, maxDist: 11 };
      expect(bits(fitHome(hull, rig, pane))).toEqual(bits(plain(F["fitHome"]!(hull, rig, pane))));
    }
    expect(fitHome([1, 2], { az: 0, el: 0, center: [0, 0, 0], aspect: 1, fov: 36, minDist: 1, maxDist: 2 }, panes[0]!)).toBeNull();
  });

  it("compare matches for every category, in and out of a career", () => {
    for (const tdev of [0, 6]) {
      const career = { teamStats: (t: { stats: Record<string, number> }) => { if (!tdev) return t.stats; const o: Record<string, number> = {}; for (const k in t.stats) o[k] = t.stats[k]! + tdev; return o; } };
      const F = f1Exp(tdev ? { Career: career } : {});
      const E = createGarageExperience(tdev ? { career: career as never } : {});
      for (const team of Teams.LIST.slice(0, 4)) for (const cat of Parts.CATALOG) {
        const opts = cat.options.filter((o) => Parts.isOptionAvailable(o, team));
        for (const cand of opts.slice(0, 4)) {
          const ts = E.compare(team as never, { brakes: "carbon" }, cat, opts[0], cand, { cornering: 1.01 }, 780);
          const f1 = F["compare"]!(team, { brakes: "carbon" }, cat, opts[0], cand, { cornering: 1.01 }, 780);
          expect(bits(ts)).toEqual(bits(plain(f1)));
        }
      }
    }
  });

  it("buildFacility and paintCareer write the same geometry and canvas ops", () => {
    const F = f1Exp();
    const acc = () => ({ pos: [] as number[], nrm: [] as number[], col: [] as number[], mat: [] as number[], idx: [] as number[] });
    for (const a of [{ active: true, facility: 7, facilityMax: 8, wins: 9, podiums: 12, titles: 2 }, { active: true, facility: 1, facilityMax: 8, wins: 0, podiums: 0, titles: 0 }, { active: false, facility: 8 }]) {
      const liv = { c1: [0.1, 0.2, 0.3], c2: [0.9, 0.4, 0.05] };
      const g1 = { back: acc() } as unknown as Groups, g2 = { back: acc() };
      buildFacility(g1, liv, { achievements: a });
      F["buildFacility"]!(g2, liv, { achievements: a });
      expect(bits(g1.back)).toEqual(bits(plain(g2.back)));
      const c1 = recordingCanvas(), c2 = recordingCanvas();
      paintCareer(c1.createCanvas(512, 512) as unknown as GarageCanvas, { achievements: a });
      F["paintCareer"]!(c2.createCanvas(512, 512), { achievements: a });
      expect(c1.ops).toEqual(c2.ops);
      expect(careerKey({ achievements: a })).toBe(F["careerKey"]!({ achievements: a }));
    }
  });
});
