import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CrestPaths } from "../../src/car/crest-paths";
import { LiveryCrests } from "../../src/car/crest-draw";
import { LiveryDesign } from "../../src/car/livery-design";
import {
  DEFAULT_DEPS, LiveryTex, configureLiveryTex, _internals, type LiveryImage, type LiveryTexDeps, type TexLivery,
} from "../../src/car/liverytex";
import { carDecalData, createDecalMaterial, createLiveryTexture, decalGeometry, buildDecalMesh, type DecalData } from "../../src/car/livery-texture";
import { Car3D, build, configureCar3D, type BuildOptions, type CarMesh, type LiveryTexHooks, type PartTiers } from "../../src/car/car3d";
import { CarShade } from "../../src/car/shade";
import { LIST } from "../../src/car/teams";
import { forTeam } from "../../src/car/liveries";
import type { LiveryCanvas, LiveryCtx2D } from "../../src/car/livery-canvas";
import type { MeshOut, Vec3 } from "../../src/car/types";
import { haveF1, loadF1Car } from "../helpers/f1-car-vm";
import { createRecorder, firstDiff, hashLog, type LogEntry, type Recorder } from "../helpers/fake-canvas";

// LiveryTex (f1-game js/car/liverytex.js + crest-paths / crest-draw / livery-graphics /
// livery-design) and carDecalData (car-mesh.js). Against the VM-loaded originals, the
// atlas is compared as a DRAW LOG: both sides paint into the same recording fake 2D
// context (tests/helpers/fake-canvas.ts), and every call and argument must match,
// numbers by Object.is. Pure functions and the decal quads are compared bit for bit,
// and so is a Car3D.build that consults LiveryTex through configureCar3D. CI has no
// f1-game, so tests/fixtures/car/liverytex.json pins hashes recorded from the VM.
// Regenerate with UPDATE_LIVERYTEX_FIXTURES=1 npx vitest run tests/unit/car-liverytex.test.ts.

// Compile-time: LiveryTex is car3d's LiveryTexHooks, and both DOM canvases are LiveryCanvas.
const _hooks: LiveryTexHooks = LiveryTex;
type DomCanvasOk = [HTMLCanvasElement extends LiveryCanvas ? true : false, OffscreenCanvas extends LiveryCanvas ? true : false];
const _domOk: DomCanvasOk = [true, true];
type CtxOk = CanvasRenderingContext2D extends LiveryCtx2D ? true : false;
const _ctxOk: CtxOk = true;
void _hooks; void _domOk; void _ctxOk;

const FILE = path.resolve(import.meta.dirname, "../fixtures/car/liverytex.json");

const clone = <T>(v: T): T => structuredClone(v);

// ---------------------------------------------------------------------------
// Atlas cases.

interface AtlasCase { name: string; teamId: string; liv: TexLivery; num?: number | string | null; isPlayer?: boolean; hiRes?: boolean }

const TEAM_IDS = LIST.map((t) => t.id);
const teamDefault = (id: string): TexLivery => clone(forTeam(LIST.find((t) => t.id === id)!)[0]!) as TexLivery;

function atlasCases(): AtlasCase[] {
  const out: AtlasCase[] = [];
  // Every livery every team can pick (its own default, its specials, the universal set).
  for (const t of LIST) {
    for (const liv of forTeam(t)) out.push({ name: `team/${t.id}/${liv.id}`, teamId: t.id, liv: clone(liv) as TexLivery, isPlayer: true });
  }
  // The custom team (generic monogram) and an unknown id.
  out.push({ name: "custom/default", teamId: "custom", liv: { id: "default", c1: [0.2, 0.3, 0.8], c2: [0.95, 0.85, 0.1] }, num: 7 });
  out.push({ name: "unknown/bare", teamId: "nope", liv: {} });
  // Every SPINE TOP design (incl. the LiveryDesign patterns) on three teams and the custom team.
  for (const top of LiveryTex.SPINE_LOGO_IDS) {
    for (const id of ["redbull", "ferrari", "mercedes", "custom"]) {
      const liv = id === "custom" ? { id: "x", c1: [0.1, 0.1, 0.12] as Vec3, c2: [0.9, 0.2, 0.3] as Vec3 } : teamDefault(id);
      out.push({ name: `top/${top}/${id}`, teamId: id, liv: { ...liv, spineLogo: top } });
    }
  }
  // Every SPINE SIDE design: on a plain crown, under the wrap (traced bull / lockup badge) and under the saddle.
  for (const side of LiveryTex.SPINE_SIDE_IDS) {
    for (const id of ["haas", "williams"]) out.push({ name: `side/${side}/${id}`, teamId: id, liv: { ...teamDefault(id), spineLogo: "logo", spineSide: side } });
    for (const id of ["redbull", "haas"]) out.push({ name: `side/${side}/wrap/${id}`, teamId: id, liv: { ...teamDefault(id), spineLogo: "wrap", spineSide: side } });
    out.push({ name: `side/${side}/saddle/ferrari`, teamId: "ferrari", liv: { ...teamDefault("ferrari"), spineLogo: "saddle", spineSide: side } });
    out.push({ name: `side/${side}/bind/cadillac`, teamId: "cadillac", liv: { ...teamDefault("cadillac"), spineLogo: "cap", coverBind: "saddleWrap", spineSide: side, saddleTint: [0.9, 0.8, 0.2] } });
  }
  for (const badge of LiveryTex.FIN_BADGE_IDS) out.push({ name: `finBadge/${badge}`, teamId: "mclaren", liv: { ...teamDefault("mclaren"), finBadge: badge, finShape: "standard" }, num: 81 });
  for (const st of [...LiveryTex.TAIL_STYLE_IDS, "bogus"]) out.push({ name: `finStyle/${st}`, teamId: "alpine", liv: { ...teamDefault("alpine"), finStyle: st } });
  for (const f of [...LiveryTex.NUM_FONT_IDS, "bogus"]) out.push({ name: `numFont/${f}`, teamId: "audi", liv: { ...teamDefault("audi"), numFont: f, spineSide: "number", spineLogo: "number" } });
  for (const p of LiveryTex.SPONSOR_PACK_IDS) out.push({ name: `sponsors/${p}`, teamId: "astonmartin", liv: { ...teamDefault("astonmartin"), sponsors: p } });
  for (const b of ["independent", "saddleWrap", "spineOnly"]) {
    for (const top of ["cap", "stripe", "saddle"]) out.push({ name: `bind/${b}/${top}`, teamId: "cadillac", liv: { ...teamDefault("cadillac"), coverBind: b, spineLogo: top, spineTint: top === "cap" ? [0.2, 0.7, 0.9] : null } });
  }
  for (const h of ["match", "contrast", "hardCut"]) {
    out.push({ name: `finHandoff/${h}`, teamId: "racingbulls", liv: { ...teamDefault("racingbulls"), finHandoff: h, spineLogo: "stripe" } });
    out.push({ name: `finHandoff/${h}/saddle`, teamId: "ferrari", liv: { ...teamDefault("ferrari"), finHandoff: h, spineLogo: "saddle" } });
  }
  // Authored mark rows, a weak authored band, the trim path, partial liveries.
  for (const id of ["ferrari", "redbull", "mercedes", "audi", "racingbulls", "haas", "cadillac", "mclaren", "custom"]) {
    const base = id === "custom" ? { id: "x", c1: [0.3, 0.3, 0.3] as Vec3, c2: [0.8, 0.8, 0.8] as Vec3 } : teamDefault(id);
    out.push({ name: `marks/${id}`, teamId: id, liv: { ...base, logo: [0.9, 0.1, 0.5], logo2: [0.1, 0.8, 0.3], logo3: [1, 1, 0] } });
    out.push({ name: `marks2/${id}`, teamId: id, liv: { ...base, id: "custom-x", logo2: [0.2, 0.2, 0.9] }, num: "XX" });
  }
  for (const top of ["stripe", "twin", "saddle", "panel", "streaks", "wedge", "rungs", "tricolour", "chevron"]) {
    out.push({ name: `weak/${top}`, teamId: "alpine", liv: { ...teamDefault("alpine"), spineLogo: top, spineTint: [1.0, 0.529, 0.737], cover: [0.0, 0.576, 0.8] } });
  }
  out.push({ name: "partial/wrap", teamId: "redbull", liv: { spineLogo: "wrap" } });
  out.push({ name: "partial/none", teamId: "haas", liv: { spineLogo: "none", spineSide: "plate" } });
  out.push({ name: "tints/all", teamId: "williams", liv: {
    ...teamDefault("williams"), spineLogo: "tricolour", spineSide: "title", stripe: [0.9, 0.9, 0.1], accent: [0.2, 0.9, 0.9],
    wing: [0.4, 0.1, 0.1], finArt: [0.1, 0.9, 0.4], fin: [0.3, 0.3, 0.9], plateTint: [0.95, 0.5, 0.1], bandTint2: [0.6, 0.1, 0.6],
    sideTint: [0.1, 0.1, 0.1], sunTint: [1, 0.8, 0], finShape: "swept", spineHeight: "high" } });
  for (const sh of ["standard", "raised", "high", "dorsal", "bogus"]) out.push({ name: `spineHeight/${sh}`, teamId: "ferrari", liv: { ...teamDefault("ferrari"), spineSide: "logo", spineHeight: sh } });
  // Pattern artwork: wrap placement, one side, every slider (strings too), rotation / stretch.
  for (const p of LiveryDesign.PATTERNS) {
    out.push({ name: `pattern/${p}/wrap`, teamId: "mclaren", liv: { ...teamDefault("mclaren"), spineLogo: p, patternPlacement: "wrap", patternTint: [0.1, 0.2, 0.9], patternSecond: [0.9, 0.9, 0.1], spineSide: "wordmark" } });
  }
  out.push({ name: "pattern/sliders", teamId: "williams", liv: { ...teamDefault("williams"), spineLogo: "honeycomb", patternPlacement: "wrap", patternSide: "left",
    patternWidth: "35", patternRepeat: "9", patternOffset: "-12", patternTaper: "60", patternOpacity: "70", patternRotation: "30", patternStretch: "150", patternWeight: "180" } });
  out.push({ name: "pattern/right-hardcut", teamId: "haas", liv: { ...teamDefault("haas"), spineLogo: "circuit", patternPlacement: "wrap", patternSide: "right", finHandoff: "hardCut", spineSide: "band" } });
  // Tiers: AI (div 4), player preview (div 2), player hi-res (div 1).
  for (const [isPlayer, hiRes] of [[false, false], [true, false], [true, true]] as const) {
    out.push({ name: `tier/${isPlayer ? "player" : "ai"}${hiRes ? "-hires" : ""}`, teamId: "redbull", liv: teamDefault("redbull"), isPlayer, hiRes, num: 1 });
  }
  return out;
}

const ATLAS = atlasCases();

// One recorder per atlas; both sides' canvas factories draw into whichever is current.
let current: Recorder = createRecorder();
const factory = () => current.createCanvas();

function record(fn: () => unknown): LogEntry[] {
  current = createRecorder();
  fn();
  return current.log;
}

const DEPS: LiveryTexDeps = { ...DEFAULT_DEPS, createCanvas: factory };
configureLiveryTex(DEPS);
afterAll(() => configureLiveryTex());

const mineAtlas = (c: AtlasCase) => record(() => LiveryTex.buildAtlas(c.teamId, clone(c.liv), c.num, c.isPlayer, c.hiRes));

// ---------------------------------------------------------------------------
// Decal and Car3D cases.

const ALL2: PartTiers = { engine: 2, aero: 2, suspension: 2, brakes: 2, tyres: 2, ers: 2, gearbox: 2, fuel: 2 };
const VISUAL: PartTiers = {
  engine: 2, aero: 2, suspension: 1, brakes: 2, tyres: 1, ers: 2, gearbox: 2, fuel: 2,
  _visual: { aero: { drs: 1, plate: 3, fin: 1.3, lvl: 4 }, engine: { inlet: 3, servicePanel: 2 } },
};
interface DecalCase { name: string; aLvl: number; parts: PartTiers | null; legacy: boolean; teamId: string; fin: string; spine: string | undefined; smooth: string }
function decalCases(): DecalCase[] {
  const out: DecalCase[] = [];
  const fins = [...Car3D.FIN_SHAPE_IDS, "none"];
  let i = 0;
  for (const smooth of ["1", "0"]) {
    for (const teamId of TEAM_IDS) {
      for (const aLvl of [0, 2, 4]) {
        const fin = fins[i % fins.length]!, spine = Car3D.SPINE_HEIGHT_IDS[i % Car3D.SPINE_HEIGHT_IDS.length];
        const parts = [null, ALL2, VISUAL][i % 3]!;
        out.push({ name: `${smooth}/${teamId}/${aLvl}/${fin}/${spine}/${i % 3}`, aLvl, parts, legacy: false, teamId, fin, spine, smooth });
        i++;
      }
    }
    out.push({ name: `${smooth}/legacy`, aLvl: 2, parts: VISUAL, legacy: true, teamId: "ferrari", fin: "standard", spine: undefined, smooth });
  }
  return out;
}
const DECAL = decalCases();
const mineDecal = (c: DecalCase): DecalData => {
  CarShade.set(c.smooth);
  try { return carDecalData(c.aLvl, clone(c.parts), c.legacy, c.teamId, c.fin, c.spine); } finally { CarShade.set(null); }
};

interface CarCase { name: string; c1: Vec3; c2: Vec3; opts: BuildOptions }
function carCases(): CarCase[] {
  const out: CarCase[] = [];
  for (const id of TEAM_IDS) {
    const liv = teamDefault(id);
    const c1 = liv.c1 as Vec3, c2 = liv.c2 as Vec3;
    out.push({ name: `${id}/default`, c1, c2, opts: { teamId: id, num: 5, livery: liv as BuildOptions["livery"] } });
  }
  for (const [id, extra] of [
    ["redbull", { spineLogo: "wrap", spineSide: "duo" }], ["haas", { spineLogo: "wrap" }], ["ferrari", { spineLogo: "wrap", sunTint: [0.9, 0.1, 0.1] }],
    ["mercedes", { finHandoff: "contrast", finShape: "standard" }], ["cadillac", { finHandoff: "contrast", spineLogo: "saddle", finShape: "swept" }],
    ["alpine", { spineSide: "number" }], ["williams", { spineSide: "starfield", spineLogo: "fade" }], ["audi", { spineSide: "bogus" }],
    ["astonmartin", { fin: [0.9, 0.9, 0.1], finShape: "stub" }],
  ] as const) {
    const liv = { ...teamDefault(id), ...clone(extra) } as TexLivery;
    out.push({ name: `${id}/${Object.values(extra).join("-")}`, c1: liv.c1 as Vec3, c2: liv.c2 as Vec3, opts: { teamId: id, num: 9, livery: liv as BuildOptions["livery"] } });
  }
  return out;
}
const CARS = carCases();
function mineCar(c: CarCase): CarMesh {
  configureCar3D({ liveryTex: LiveryTex, teams: LIST });
  try { return build(clone(c.c1), clone(c.c2), clone(c.opts)); } finally { configureCar3D(); }
}

// ---------------------------------------------------------------------------
// Hashing and cross-realm comparison helpers.

function fnv(a: ArrayLike<number>): string {
  const dv = new DataView(new ArrayBuffer(8));
  let h = 0x811c9dc5;
  for (let k = 0; k < a.length; k++) {
    dv.setFloat64(0, a[k]!);
    for (let i = 0; i < 8; i++) h = Math.imul(h ^ dv.getUint8(i), 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
const decalHash = (d: DecalData) => [d.pos, d.nrm, d.uv, d.idx].map(fnv).join("-") + "/" + d.idx.length;
const carHash = (m: MeshOut) => [m.pos, m.nrm, m.col, m.mat, m.idx].map(fnv).join("-") + "/" + m.idx.length;

/** A realm-independent, Object.is-faithful copy: -0 / NaN / ±Infinity tagged, extra array props kept, functions named. */
function canon(v: unknown): unknown {
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : Number.isNaN(v) ? "NaN" : v === Infinity ? "+Inf" : v === -Infinity ? "-Inf" : v;
  if (typeof v === "function") return "<fn>";
  if (Array.isArray(v)) {
    const arr = v.map(canon);
    const extra = Object.keys(v).filter((k) => !/^\d+$/.test(k));
    return extra.length ? { arr, ...Object.fromEntries(extra.map((k) => [k, canon((v as unknown as Record<string, unknown>)[k])])) } : arr;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canon(o[k])]));
  }
  return v;
}

// ---------------------------------------------------------------------------
// The f1-game VMs.

const TEX_SCRIPTS = [
  "js/data/teams.js", "js/car/liveries.js", "js/car/crest-paths.js", "js/car/livery-design.js", "js/car/livery-graphics.js",
  "js/car/crest-draw.js", "js/car/liverytex.js", "js/car/car-mesh.js",
];
const TEX_GLOBALS = ["LiveryTex", "CrestPaths", "LiveryDesign", "LiveryGraphics", "LiveryCrests", "CarMesh", "Teams", "Liveries"];
type Fn = (...a: unknown[]) => unknown;
type VmTex = Record<string, unknown> & { buildAtlas: Fn };
interface Vm { tex: VmTex; carMesh: { carDecalData: Fn }; car3d: { build: Fn }; shade: { set(v: unknown): unknown }; g: Record<string, unknown> }

function loadVm(sandbox: Record<string, unknown> = {}): Vm {
  const g = loadF1Car({
    extra: TEX_SCRIPTS, globals: TEX_GLOBALS,
    sandbox: { document: { createElement: () => factory() }, ...sandbox },
  });
  return {
    tex: g["LiveryTex"] as VmTex, carMesh: g["CarMesh"] as Vm["carMesh"], car3d: g["Car3D"] as Vm["car3d"],
    shade: g["CarShade"] as Vm["shade"], g,
  };
}

const refAtlas = (vm: Vm, c: AtlasCase) => record(() => vm.tex.buildAtlas(c.teamId, clone(c.liv), c.num, c.isPlayer, c.hiRes));
const refDecal = (vm: Vm, c: DecalCase): DecalData => {
  vm.shade.set(c.smooth);
  try { return vm.carMesh.carDecalData(c.aLvl, clone(c.parts), c.legacy, c.teamId, c.fin, c.spine) as DecalData; } finally { vm.shade.set(null); }
};
const refCar = (vm: Vm, c: CarCase) => vm.car3d.build(clone(c.c1), clone(c.c2), clone(c.opts)) as CarMesh;

// ---------------------------------------------------------------------------

describe.skipIf(!haveF1)("LiveryTex vs f1-game (VM)", () => {
  const vm = haveF1 ? loadVm() : (null as unknown as Vm);

  describe("atlas draw logs match call for call", () => {
    for (const c of ATLAS) {
      it(c.name, () => {
        const ref = refAtlas(vm, c), mine = mineAtlas(c);
        expect(ref.length).toBeGreaterThan(20);
        expect(firstDiff(mine, ref)).toBe(null);
      });
    }
  });

  it("phone tier (GLX.mobileTier): scratch canvas reused, div 4 / 8", () => {
    const mob = loadVm({ GLX: { mobileTier: true, isMobile: true } });
    configureLiveryTex({ ...DEPS, GLX: { mobileTier: true, isMobile: true } });
    _internals.resetScratch();
    try {
      expect(LiveryTex.IS_MOBILE).toBe(mob.tex["IS_MOBILE"]);
      expect(LiveryTex.IS_PHONE).toBe(mob.tex["IS_PHONE"]);
      // Two builds on one recorder each side: the second reuses the first's canvas.
      const run = (b: Fn) => record(() => { b("ferrari", teamDefault("ferrari"), 16, true); b("haas", teamDefault("haas"), null, false); });
      const ref = run(mob.tex.buildAtlas), mine = run(LiveryTex.buildAtlas as Fn);
      expect(ref.filter((e) => e[0] === "createCanvas")).toHaveLength(1);
      expect(firstDiff(mine, ref)).toBe(null);
    } finally {
      configureLiveryTex(DEPS);
      _internals.resetScratch();
    }
  });

  it("legends: marque crests and the legend's car name on the monogram", () => {
    const LEG: Record<string, { car: string; marque: string | null; code: string }> = {
      senna: { car: "McLaren MP4/4", marque: "mclaren", code: "SEN" },
      clark: { car: "Lotus 49", marque: null, code: "CLA" },
    };
    const Legends = { byId: (id: string) => LEG[id] ?? null, LIST: [] };
    const lvm = loadVm({ Legends });
    configureLiveryTex({ ...DEPS, Legends });
    try {
      for (const id of ["legend_senna", "legend_clark", "legend_nobody", "legends"]) {
        for (const top of ["logo", "bigmark"]) {
          const c: AtlasCase = { name: id, teamId: id, liv: { id: "default", c1: [0.9, 0.9, 0.9], c2: [0.8, 0.1, 0.1], spineLogo: top, spineSide: "emblem" } };
          expect(firstDiff(mineAtlas(c), refAtlas(lvm, c)), `${id}/${top}`).toBe(null);
        }
        expect(canon(LiveryTex.markSlots(id))).toEqual(canon((lvm.tex["markSlots"] as Fn)(id)));
      }
    } finally {
      configureLiveryTex(DEPS);
    }
  });

  it("an uploaded custom emblem (setTeamLogo): tint, halo and outline passes", () => {
    const made: LiveryImage[] = [];
    class FakeImage implements LiveryImage {
      naturalWidth = 240; naturalHeight = 120; onload: (() => void) | null = null; onerror: (() => void) | null = null; src = "";
      constructor() { made.push(this); }
    }
    const ivm = loadVm({ Image: FakeImage });
    configureLiveryTex({ ...DEPS, createImage: () => new FakeImage() });
    try {
      for (const setLogo of [ivm.tex["setTeamLogo"] as Fn, LiveryTex.setTeamLogo as Fn]) {
        const logRef = record(() => { setLogo("custom", "data:image/png;base64,AA"); made[made.length - 1]!.onload!(); });
        expect(logRef.some((e) => e[0] === "getImageData")).toBe(true);
      }
      expect(canon(LiveryTex.markSlots("custom"))).toEqual(canon((ivm.tex["markSlots"] as Fn)("custom")));
      for (const liv of [
        { id: "x", c1: [0.95, 0.95, 0.95], c2: [0.1, 0.1, 0.1], spineSide: "lockup" },
        { id: "x", c1: [0.1, 0.1, 0.1], c2: [0.9, 0.9, 0.9], logo: [0.9, 0.2, 0.1], logo3: [1, 1, 0], spineSide: "emblem", spineLogo: "bigmark" },
        { id: "x", c1: [0.5, 0.5, 0.5], c2: [0.9, 0.9, 0.9], spineSide: "logo", spineLogo: "wrap" },
      ] as TexLivery[]) {
        const c: AtlasCase = { name: "emblem", teamId: "custom", liv };
        expect(firstDiff(mineAtlas(c), refAtlas(ivm, c))).toBe(null);
        const sw = (p: Fn) => record(() => { const cv = factory(); p(cv.getContext("2d"), "custom", clone(liv), 200, 120); });
        expect(firstDiff(sw(LiveryTex.paintSwatch as Fn), sw(ivm.tex["paintSwatch"] as Fn))).toBe(null);
      }
    } finally {
      LiveryTex.setTeamLogo("custom", null);
      configureLiveryTex(DEPS);
    }
  });

  it("paintSwatch / paintTeamMark / drawCrest for every team", () => {
    for (const id of [...TEAM_IDS, "custom"]) {
      const liv = id === "custom" ? { id: "x", c1: [0.2, 0.2, 0.25], c2: [0.9, 0.5, 0.1] } as TexLivery : teamDefault(id);
      const sw = (p: Fn) => record(() => { const cv = factory(); p(cv.getContext("2d"), id, clone(liv), 160, 100); });
      expect(firstDiff(sw(LiveryTex.paintSwatch as Fn), sw(vm.tex["paintSwatch"] as Fn)), id).toBe(null);
      const tm = (p: Fn) => record(() => { const cv = factory(); p(cv.getContext("2d"), id, clone(liv), { x: 10, y: 20, w: 300, h: 180 }, [[0.9, 0.9, 0.9], [0.1, 0.1, 0.1]], { crestScale: true, noPlate: true, fullLockup: true }); });
      expect(firstDiff(tm(LiveryTex.paintTeamMark as Fn), tm(vm.tex["paintTeamMark"] as Fn)), id).toBe(null);
      const dc = (p: Fn) => record(() => { const cv = factory(); p(cv.getContext("2d"), id, { x: 0, y: 0, w: 120, h: 120 }, { liv: clone(liv), field: [0.5, 0.5, 0.5], bare: true }); });
      expect(firstDiff(dc(LiveryTex.drawCrest as Fn), dc(vm.tex["drawCrest"] as Fn)), id).toBe(null);
    }
  });

  it("pure functions match bit for bit", () => {
    const T = vm.tex as Record<string, Fn>;
    const fields: unknown[] = [[0.1, 0.1, 0.12], [[0.97, 0.97, 0.98], [0.86, 0, 0]], [undefined, undefined], null, [[0.5, 0.5, 0.5]], []];
    const livs: (TexLivery | null)[] = [null, {}];
    for (const id of TEAM_IDS) {
      livs.push(teamDefault(id));
      livs.push({ ...teamDefault(id), id: "other", logo2: [0.3, 0.6, 0.9], logo3: [0.9, 0.1, 0.1] });
    }
    let n = 0;
    for (const id of [...TEAM_IDS, "custom", "nope", undefined]) {
      for (const liv of livs) {
        for (const field of fields) {
          for (const bare of [false, true]) {
            for (const opts of [undefined, { noPlate: true }]) {
              expect(canon(LiveryTex.markPalette(id, clone(liv), clone(field), bare, opts))).toEqual(canon(T["markPalette"]!(id, clone(liv), clone(field), bare, opts)));
              n++;
            }
          }
        }
        expect(canon(LiveryTex.markBase(id, clone(liv)))).toEqual(canon(T["markBase"]!(id, clone(liv))));
        expect(canon(LiveryTex.markOnField(id, clone(liv)))).toEqual(canon(T["markOnField"]!(id, clone(liv))));
        if (liv) {
          expect(canon(LiveryTex.sunColour(id, clone(liv)))).toEqual(canon(T["sunColour"]!(id, clone(liv))));
          for (const top of ["wrap", "logo"]) {
            const l2 = { ...clone(liv), spineLogo: top };
            expect(canon(LiveryTex.airboxMeshColour(id, l2, [0.3, 0.3, 0.3]))).toEqual(canon(T["airboxMeshColour"]!(id, clone(l2), [0.3, 0.3, 0.3])));
            expect(canon(LiveryTex.airboxMeshColour(id, l2, null))).toEqual(canon(T["airboxMeshColour"]!(id, clone(l2), null)));
          }
          for (const h of ["match", "contrast", "x"]) {
            const l3 = { ...clone(liv), finHandoff: h, spineLogo: "saddle" };
            const args: [Vec3, Vec3, Vec3, Vec3] = [[0.9, 0.9, 0.9], [0.1, 0.4, 0.8], [0.8, 0.1, 0.1], [0.95, 0.95, 0.2]];
            expect(canon(LiveryTex.resolveFinPaint(id, l3, ...clone(args)))).toEqual(canon(T["resolveFinPaint"]!(id, clone(l3), ...clone(args))));
          }
        }
      }
      expect(LiveryTex.crestKeepsPlate(id)).toBe(T["crestKeepsPlate"]!(id));
      expect(LiveryTex.hasFlankBull(id)).toBe(T["hasFlankBull"]!(id));
      expect(canon(LiveryTex.markSlots(id))).toEqual(canon(T["markSlots"]!(id)));
    }
    expect(n).toBeGreaterThan(1000);
    const cols: Vec3[] = [[0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5], [0.04, 0.03, 0.05], [0.86, 0, 0], [1.2, -0.1, 0.5], [0.0405, 0.04045, 0.2]];
    for (const a of cols) {
      for (const b of cols) expect(canon(LiveryTex.contrast(a, b))).toEqual(canon(T["contrast"]!(a, b)));
      expect(canon(LiveryTex.inkOn([a]))).toEqual(canon(T["inkOn"]!([a])));
      expect(canon(LiveryTex.inkOn([a, null, cols[4]!]))).toEqual(canon(T["inkOn"]!([a, null, cols[4]])));
    }
    expect(canon(LiveryTex.inkOn([]))).toEqual(canon(T["inkOn"]!([])));
    for (const R of [undefined, { x: 3, y: 5, w: 101, h: 77 }]) expect(canon(LiveryTex.numCrestBox(R))).toEqual(canon(T["numCrestBox"]!(R)));
    for (const top of ["saddle", "logo"]) for (const sf of [0, 0.235]) for (const side of ["logo", "number"]) {
      expect(canon(LiveryTex.flankMarkStation(top, sf, side))).toEqual(canon(T["flankMarkStation"]!(top, sf, side)));
    }
    const designs: TexLivery[] = [{}, { spineLogo: "saddle" }, { spineLogo: "wrap" }, { spineSide: "rake" }, { coverBind: "saddleWrap" }, { spineLogo: "gradient" }, { spineSide: "plate", spineLogo: "tricolour" }];
    for (const f of [...LiveryTex.FILL_SURFACES.map((x) => x.key), "c1"]) for (const d of designs) expect(LiveryTex.fillInert(f, d)).toBe(T["fillInert"]!(f, clone(d)));
    for (const p of [false, true]) for (const m of [false, true]) for (const h of [false, true]) expect(LiveryTex.atlasDiv(p, m, h)).toBe(T["atlasDiv"]!(p, m, h));
    for (const m of [false, true, undefined]) expect(LiveryTex.playerHiResDeferred(m)).toBe(T["playerHiResDeferred"]!(m));
    for (const p of [false, true]) for (const t of [false, true]) for (const ph of [false, true]) expect(LiveryTex.atlasMobile(p, t, ph)).toBe(T["atlasMobile"]!(p, t, ph));
  });

  it("constant tables match", () => {
    const T = vm.tex;
    for (const k of ["SIZE", "SIZE_H", "REGIONS", "SPONSORS", "SPONSOR_PACKS", "MARK_FLOOR", "ALT_INSIDE", "FLANK", "FLANK_H", "FLANK_MARK",
      "FLANK_SEEN", "CREST_DISC", "CREST_MARGIN", "STROKE_MIN", "TEXT_MIN", "NUM_FONT_IDS", "SPONSOR_PACK_IDS", "TAIL_STYLE_IDS",
      "FIN_BADGE_IDS", "SPINE_LOGO_IDS", "SPINE_SIDE_IDS", "FILL_SURFACES", "IS_MOBILE", "IS_PHONE"] as const) {
      expect(canon((LiveryTex as Record<string, unknown>)[k]), k).toEqual(canon(T[k]));
    }
    expect(Object.keys(LiveryTex).sort()).toEqual(Object.keys(T).sort());
    expect(Object.keys(LiveryTex.CRESTS).sort()).toEqual(Object.keys(T["CRESTS"] as object).sort());
    expect(canon(CrestPaths)).toEqual(canon(vm.g["CrestPaths"]));
    const D = vm.g["LiveryDesign"] as Record<string, unknown>;
    expect(Object.keys(LiveryDesign).sort()).toEqual(Object.keys(D).sort());
    for (const k of ["PATTERNS", "SECOND_COLOR", "LINE_PATTERNS", "RANGES", "PALETTES"] as const) expect(canon(LiveryDesign[k]), k).toEqual(canon(D[k]));
    const value = D["value"] as Fn;
    for (const key of Object.keys(LiveryDesign.RANGES) as (keyof typeof LiveryDesign.RANGES)[]) {
      for (const raw of [undefined, "", " ", "12", "-500", "500", "abc", 30, "1e1", "0x10"]) {
        expect(LiveryDesign.value({ [key]: raw }, key)).toBe(value({ [key]: raw }, key));
      }
      expect(LiveryDesign.value(null, key)).toBe(value(null, key));
    }
  });

  it("LiveryDesign.history behaves the same", () => {
    const D = vm.g["LiveryDesign"] as { history: (i: unknown, l?: number) => Record<string, Fn> };
    const a = LiveryDesign.history<unknown>({ v: 0 }, 3), b = D.history({ v: 0 }, 3);
    const ops: [string, unknown?, boolean?][] = [["record", { v: 1 }], ["record", { v: 2 }, true], ["record", { v: 3 }, true], ["record", { v: 3 }],
      ["record", { v: 4 }], ["record", { v: 5 }], ["record", { v: 6 }], ["undo"], ["undo"], ["undo"], ["undo"], ["redo"], ["record", { v: 7 }], ["redo"], ["canUndo"], ["canRedo"], ["original"]];
    for (const [op, d, drag] of ops) {
      const x = (a as unknown as Record<string, Fn>)[op]!(d, drag), y = b[op]!(d, drag);
      expect(canon(x), op).toEqual(canon(y));
    }
  });

  describe("carDecalData matches bit for bit", () => {
    for (const c of DECAL) {
      it(c.name, () => {
        const ref = refDecal(vm, c), mine = mineDecal(c);
        expect(mine.idx.length).toBeGreaterThan(0);
        expect(canon(mine)).toEqual(canon(ref));
      });
    }
  });

  describe("Car3D.build with LiveryTex hooks matches bit for bit", () => {
    for (const c of CARS) {
      it(c.name, () => {
        const ref = refCar(vm, c), mine = mineCar(c);
        expect(carHash(mine)).toBe(carHash(ref));
      });
    }
    it("the hooks are live (a wrap car differs without LiveryTex)", () => {
      const c = CARS.find((x) => x.name.startsWith("redbull/wrap"))!;
      expect(carHash(build(clone(c.c1), clone(c.c2), clone(c.opts)))).not.toBe(carHash(mineCar(c)));
    });
  });
});

// ---------------------------------------------------------------------------

interface Fixtures { atlas: Record<string, string>; decal: Record<string, string>; car: Record<string, string> }

describe("LiveryTex fixtures (recorded from f1-game)", () => {
  if (haveF1 && process.env["UPDATE_LIVERYTEX_FIXTURES"]) {
    const vm = loadVm();
    const out: Fixtures = { atlas: {}, decal: {}, car: {} };
    for (const c of ATLAS) { const log = refAtlas(vm, c); out.atlas[c.name] = hashLog(log) + "/" + log.length; }
    for (const c of DECAL) out.decal[c.name] = decalHash(refDecal(vm, c));
    for (const c of CARS) out.car[c.name] = carHash(refCar(vm, c));
    fs.writeFileSync(FILE, JSON.stringify(out, null, 1) + "\n");
  }
  const fx = JSON.parse(fs.readFileSync(FILE, "utf8")) as Fixtures;
  it("covers every case", () => {
    expect(Object.keys(fx.atlas).sort()).toEqual(ATLAS.map((c) => c.name).sort());
    expect(Object.keys(fx.decal).sort()).toEqual(DECAL.map((c) => c.name).sort());
    expect(Object.keys(fx.car).sort()).toEqual(CARS.map((c) => c.name).sort());
  });
  it("atlas draw logs", () => {
    const bad: string[] = [];
    for (const c of ATLAS) { const log = mineAtlas(c); if (hashLog(log) + "/" + log.length !== fx.atlas[c.name]) bad.push(c.name); }
    expect(bad).toEqual([]);
  });
  it("decal quads", () => {
    const bad = DECAL.filter((c) => decalHash(mineDecal(c)) !== fx.decal[c.name]).map((c) => c.name);
    expect(bad).toEqual([]);
  });
  it("Car3D.build with LiveryTex", () => {
    const bad = CARS.filter((c) => carHash(mineCar(c)) !== fx.car[c.name]).map((c) => c.name);
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("LiveryTex sanity", () => {
  it("the atlas is SIZE x SIZE_H / div and paints every board", () => {
    let canvas: LiveryCanvas | null = null;
    const log = record(() => { canvas = LiveryTex.buildAtlas("ferrari", teamDefault("ferrari"), 16, true, true); });
    expect(canvas!.width).toBe(LiveryTex.SIZE);
    expect(canvas!.height).toBe(LiveryTex.SIZE_H);
    const texts = log.filter((e) => e[0] === "fillText").map((e) => e[1]);
    expect(texts).toContain("16");                      // the race number board
    expect(texts).toContain("C");                       // CAVALLO, letter by letter
    // Every save has its restore.
    expect(log.filter((e) => e[0] === "save").length).toBe(log.filter((e) => e[0] === "restore").length);
    const ai = record(() => { canvas = LiveryTex.buildAtlas("haas", {}, null, false); });
    expect(canvas!.width).toBe(LiveryTex.SIZE / 4);
    expect(ai.find((e) => e[0] === "setTransform")).toEqual(["setTransform", 0.25, 0, 0, 0.25, 0, 0]);
  });

  it("tracePath always terminates and ignores what it cannot parse", () => {
    const { tracePath } = LiveryCrests.create({
      css: () => "", fit: () => ({ X: (u) => u, Y: (v) => v, S: (d) => d }), drawWordmark: () => {}, teamShort: () => "",
      crestSpecFor: () => undefined, crestKey: (t) => String(t), legendOf: () => null, CREST_DISC: {}, CREST_MARGIN: 0.08, STROKE_MIN: 0.055, TEXT_MIN: 0.22,
    });
    for (const d of ["M0 0L1 1Z\n", "M0 0L1 1z", "M0 0L1 1Zm2 2l3 3z", "Mxyz", "M1", "L 1 , 2 3 4Z Z", "M--1 2"]) {
      const log = record(() => { tracePath(current.createCanvas().getContext("2d")!, { X: (u) => u, Y: (v) => v, S: (s) => s }, d); });
      expect(log.length, d).toBeLessThan(40);
    }
    const ok = record(() => { tracePath(current.createCanvas().getContext("2d")!, { X: (u) => u * 2, Y: (v) => v, S: (s) => s }, "M0 0L1 0.5L0.25 1Z"); });
    expect(ok.slice(-5)).toEqual([["beginPath"], ["moveTo", 0, 0], ["lineTo", 2, 0.5], ["lineTo", 0.5, 1], ["closePath"]]);
  });

  it("inks and contrast", () => {
    expect(LiveryTex.contrast([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 10);
    expect(LiveryTex.contrast([0.3, 0.4, 0.5], [0.3, 0.4, 0.5])).toBe(1);
    const none = LiveryTex.inkOn([]);
    expect([...none]).toEqual([0.97, 0.97, 0.98]);
    expect(none.worst).toBe(Infinity);
    expect([...LiveryTex.inkOn([[1, 1, 1]])]).toEqual([0.06, 0.06, 0.08]);
    // A copy every time, never the shared constant.
    expect(LiveryTex.inkOn([[1, 1, 1]])).not.toBe(LiveryTex.inkOn([[1, 1, 1]]));
  });

  it("hooks Car3D reads", () => {
    expect(LiveryTex.FLANK.zF - LiveryTex.FLANK_SEEN * LiveryTex.FLANK.zLen).toBeCloseTo(-1.4288, 10);
    expect(LiveryTex.SPINE_SIDE_IDS).toContain("number");
    expect(LiveryTex.resolveFinPaint("x", { fin: [0.1, 0.2, 0.3] }, [0, 0, 0], [1, 1, 1], [0.5, 0, 0], [0, 0.5, 0])).toEqual([0.1, 0.2, 0.3]);
    expect(LiveryTex.resolveFinPaint("x", {}, [0, 0, 0], [1, 1, 1], [0.5, 0, 0], [0, 0.5, 0])).toEqual([0, 0.5, 0]);
    expect(LiveryTex.airboxMeshColour("x", {}, null)).toEqual([0.1, 0.1, 0.12]);
    expect(LiveryTex.hasFlankBull("redbull")).toBe(true);
    expect(LiveryTex.hasFlankBull("ferrari")).toBe(false);
  });

  it("no canvas factory and no DOM: buildAtlas throws, nothing else needs one", () => {
    configureLiveryTex({ ...DEFAULT_DEPS });
    try {
      expect(() => LiveryTex.buildAtlas("haas", {})).toThrow(/canvas factory/);
      expect(LiveryTex.markPalette("haas", null, [0.1, 0.1, 0.1], false).mark).toEqual([0.97, 0.97, 0.98]);
    } finally {
      configureLiveryTex(DEPS);
    }
  });
});

describe("livery-texture (three bridge)", () => {
  it("decal quads cover every region and stay inside the atlas", () => {
    const d = carDecalData(2, null, false, "ferrari", "standard", "dorsal");
    expect(d.pos.length / 3).toBe(d.uv.length / 2);
    expect(d.idx.length % 6).toBe(0);
    for (const u of d.uv) { expect(u).toBeGreaterThanOrEqual(0); expect(u).toBeLessThanOrEqual(1); }
    const none = carDecalData(2, null, false, "ferrari", "none", "dorsal");
    expect(none.idx.length).toBeLessThan(d.idx.length);       // no fin, no fin decal
  });

  it("decalGeometry mirrors X and reverses the winding, like meshToGeometry", () => {
    const d: DecalData = { pos: [1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0], nrm: [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0], uv: [0, 0, 1, 0, 1, 1, 0, 1], idx: [0, 1, 2, 0, 2, 3] };
    const g = decalGeometry(d);
    expect(Array.from(g.getAttribute("position").array).filter((_, i) => i % 3 === 0)).toEqual([-1, -2, -2, -1]);
    expect(g.getAttribute("normal").getX(0)).toBe(-1);
    expect(Array.from(g.getIndex()!.array)).toEqual([0, 2, 1, 0, 3, 2]);
    expect(Array.from(g.getAttribute("uv").array)).toEqual(d.uv);
    const raw = decalGeometry(d, { mirrorX: false });
    expect(Array.from(raw.getIndex()!.array)).toEqual(d.idx);
  });

  it("texture and material follow glx.js createTexture / drawDecal", () => {
    let canvas: LiveryCanvas | null = null;
    record(() => { canvas = LiveryTex.buildAtlas("mclaren", teamDefault("mclaren"), 4, false); });
    const tex = createLiveryTexture(canvas!);
    expect(tex.image).toBe(canvas);
    expect(tex.flipY).toBe(true);
    expect(tex.premultiplyAlpha).toBe(true);
    expect(tex.colorSpace).toBe("srgb");
    const mat = createDecalMaterial(tex);
    expect(mat.map).toBe(tex);
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.premultipliedAlpha).toBe(true);
    const mesh = buildDecalMesh(tex, { teamId: "mclaren", finShape: "none" });
    expect(mesh.geometry.getIndex()!.count).toBe(carDecalData(2, null, false, "mclaren", "none", undefined).idx.length);
    mesh.geometry.dispose(); (mesh.material as typeof mat).dispose(); mat.dispose(); tex.dispose();
  });
});
