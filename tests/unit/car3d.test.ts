import { describe, expect, it } from "vitest";
import { Car3D, TEAM_STYLE, build, buildComplete, type BuildOptions, type CarMesh, type Livery, type PartTiers } from "../../src/car/car3d";
import { CarShade } from "../../src/car/shade";
import type { Vec3 } from "../../src/car/types";
import { haveF1, loadF1Car, plain } from "../helpers/f1-car-vm";

// The procedural car (f1-game js/car/car3d.js). Bit-exact against the VM-loaded
// original over a spread of configs; skipped where f1-game is absent.

type BuildFn = (c1?: Vec3 | null, c2?: Vec3 | null, opts?: BuildOptions | null) => CarMesh;
interface Case { name: string; c1?: Vec3 | null; c2?: Vec3 | null; opts?: BuildOptions | null }

const LIVERIES: Record<string, { c1: Vec3; c2: Vec3; liv: Livery }> = {
  mercedes: { c1: [0.04, 0.04, 0.05], c2: [0.0, 0.82, 0.72], liv: { accent: [0.75, 0.76, 0.78], cover: [0.70, 0.71, 0.74], finish: "satin" } },
  ferrari: { c1: [0.86, 0.0, 0.0], c2: [1, 1, 1], liv: { cover: [0.95, 0.95, 0.95], wingCarbon: "carbon", nose: [1, 1, 1], tcam: "auto" } },
  mclaren: { c1: [1.0, 0.45, 0.0], c2: [0.06, 0.06, 0.07], liv: { pod: [0.06, 0.06, 0.07], wing: [0.06, 0.06, 0.07], wingCarbon: "carbon", tcam: "yellow" } },
  redbull: { c1: [0.08, 0.10, 0.30], c2: [0.95, 0.10, 0.12], liv: { accent: [1.0, 0.80, 0.0], nose: [1.0, 0.80, 0.0], finish: "matte", stripe: [0.95, 0.10, 0.12] } },
  alpine: { c1: [0.02, 0.18, 0.55], c2: [1.0, 0.45, 0.70], liv: { halo: [1.0, 0.45, 0.70], noseStripe: [1, 1, 1], coverVents: "gills", finShape: "none" } },
  racingbulls: { c1: [0.95, 0.95, 0.97], c2: [0.15, 0.30, 0.85], liv: { rearWing: [0.15, 0.30, 0.85], spineTint: [0.9, 0.1, 0.1], coverVents: "spine", spineLogo: "none" } },
  haas: { c1: [0.92, 0.92, 0.93], c2: [0.85, 0.05, 0.08], liv: { lower: [0.10, 0.10, 0.12], tcam: "black", coverFinish: "chrome" } },
  williams: { c1: [0.03, 0.12, 0.45], c2: [0.0, 0.60, 0.95], liv: { upper: [0.0, 0.60, 0.95], mirrorTint: [0.0, 0.60, 0.95], mirrorFinish: "pearl", finish: "pearl" } },
  audi: { c1: [0.50, 0.50, 0.52], c2: [0.85, 0.15, 0.10], liv: { spineHeight: "high", spineSide: "number", rimTint: [0.8, 0.1, 0.1], caliperTint: [0.9, 0.8, 0.1] } },
  astonmartin: { c1: [0.0, 0.33, 0.25], c2: [0.80, 0.95, 0.10], liv: { fin: [0.80, 0.95, 0.10], wingFinish: "satin", haloFinish: "chrome", podFinish: "matte", finFinish: "carbon" } },
  cadillac: { c1: [0.05, 0.05, 0.06], c2: [0.95, 0.95, 0.96], liv: { bodySplit: "lr", halo: [0.6, 0.6, 0.62], finShape: "stepped", coverVents: "spine" } },
};

const ALL0 = { engine: 0, aero: 0, suspension: 0, brakes: 0, tyres: 0, ers: 0, gearbox: 0, fuel: 0 };
const ALL2 = { engine: 2, aero: 2, suspension: 2, brakes: 2, tyres: 2, ers: 2, gearbox: 2, fuel: 2 };
const MIXED = { engine: 2, aero: 0, suspension: 1, brakes: 2, tyres: 0, ers: 2, gearbox: 1, fuel: 0 };

// Catalog-style recipes that reach the recipe-gated branches the tiers never do.
const VISUAL_A: PartTiers = {
  engine: 2, aero: 2, suspension: 2, brakes: 2, tyres: 1, ers: 2, gearbox: 2, fuel: 2,
  _visual: {
    engine: { outlet: 3, scoopLip: 2, servicePanel: 3, heatShield: 1, inlet: 3, chimney: 2, twin: 1 },
    fuel: { filler: 2, hatch: 1, vent: 1, breather: 2, line: 1, flame: [1.2, 0.5, 0.2] },
    ers: { cells: 5, blister: 2, conduit: 2, coolerIntake: 2, pack: 1.2 },
    aero: { slot: 1, duct: 2, board: 2, swan: 1, tvane: 1, beam: 1, drs: 1, plate: 3, arch: 1, gill: 2, casc: 2, vane: 3 },
    floor: { fences: 4, fenceH: 1.3, edgeLip: 1, gurney: 1, scroll: 1, skid: 2, plank: 1 },
    cockpit: { headrest: 2, halo: 2, haloBlade: 2, haloWing: 1, camPods: 2, screen: 1, mirror: 1.2 },
    exhaust: { pipes: 3, bore: 1.2, flare: 0.6, wastegate: 2, wrap: 1, lip: 2, shield: 1 },
    gearbox: { strakes: 3, fin: 1, casing: 3, louvres: 2, heat: 1, heatFins: 4, ribs: 2, caseWidth: 1.2 },
    suspension: { rocker: 2, heave: 1, push: 1, pull: 1 },
    wheels: { deflector: 2 },
  },
};
const VISUAL_B: PartTiers = {
  engine: 1, aero: 1, suspension: 0, brakes: 1, tyres: 2, ers: 1, gearbox: 0, fuel: 1,
  _visual: {
    engine: { outlet: 2, scoopLip: 1, servicePanel: 4, inlet: 0, snork: 1 },
    fuel: { filler: 1, breather: 1 },
    ers: { blister: 1, conduit: 1, coolerIntake: 1, led: [0.2, 0.9, 1.4] },
    aero: { duct: 1, board: 1, tvane: 0, drs: 0, lvl: 4, plate: 2, vane: 2 },
    floor: { fences: 1, edgeLip: 0.5, skid: 1 },
    cockpit: { headrest: 1, halo: 1, haloBlade: 1, camPods: 1 },
    exhaust: { pipes: 1, flare: 1, wastegate: 1, wrap: 1, lip: 2, shield: 1 },
    gearbox: { louvres: 3, ribs: 1, heatFins: 1 },
    suspension: { rocker: 1, heave: 1, push: 1 },
    wheels: { deflector: 1 },
  },
};

function cases(): Case[] {
  const out: Case[] = [
    { name: "default (no args)" },
    { name: "colours, no opts", c1: [0.1, 0.4, 0.9], c2: [0.9, 0.2, 0.1] },
    { name: "noWheels", opts: { noWheels: true } },
    { name: "field", opts: { field: true, teamId: "redbull", num: 1 } },
    { name: "silhouette", opts: { silhouette: true, teamId: "ferrari", smooth: true } },
    { name: "noDriver", opts: { noDriver: true } },
    { name: "smooth true", opts: { smooth: true, teamId: "mclaren", num: 4 } },
    { name: "smooth false", opts: { smooth: false, teamId: "mclaren", num: 81 } },
    { name: "measure", opts: { measure: true, teamId: "williams" } },
    { name: "measure smooth", opts: { measure: true, smooth: true } },
    { name: "parts all 0", opts: { parts: ALL0 } },
    { name: "parts all 2", opts: { parts: ALL2 } },
    { name: "parts mixed", opts: { parts: MIXED, teamId: "haas" } },
    { name: "parts all 2 smooth", opts: { parts: ALL2, smooth: true } },
    { name: "visual A", opts: { parts: VISUAL_A, teamId: "alpine" } },
    { name: "visual A smooth", opts: { parts: VISUAL_A, teamId: "alpine", smooth: true } },
    { name: "visual B", opts: { parts: VISUAL_B, teamId: "audi" } },
    { name: "visual B smooth", opts: { parts: VISUAL_B, teamId: "cadillac", smooth: true } },
    { name: "ownHalo", opts: { ownHalo: true, halo: 2 } },
    { name: "helmet key custom", opts: { teamId: "custom", num: 27 } },
    { name: "helmet key explicit", opts: { teamId: "legends", num: 3, helmetKey: "SEN" } },
    { name: "helmet legends (no Legends dep)", opts: { teamId: "legends", num: 5 } },
  ];
  for (const body of [undefined, "standard", "sculpted", "wide", "tapered", "stepped", "bogus"]) {
    out.push({ name: `cockpit ${body ?? "-"}`, c1: [0.86, 0, 0], c2: [1, 1, 1],
      opts: { cockpit: true, teamId: "ferrari", ...(body ? { cockpitBody: body } : {}), livery: LIVERIES["ferrari"]!.liv } });
  }
  for (const halo of [0, 1, 2, 3, 4, true] as const) {
    out.push({ name: `cockpit halo ${String(halo)}`, opts: { cockpit: true, halo, parts: MIXED, livery: { halo: [0.9, 0.9, 0.9], accent: [0.95, 0.95, 0.9] } } });
  }
  out.push({ name: "cockpit visual A", opts: { cockpit: true, parts: VISUAL_A, halo: 4, cockpitBody: "wide" } });
  for (const [id, L] of Object.entries(LIVERIES)) {
    out.push({ name: `team ${id}`, c1: L.c1, c2: L.c2, opts: { teamId: id, num: 10, livery: L.liv } });
    out.push({ name: `team ${id} smooth`, c1: L.c1, c2: L.c2, opts: { teamId: id, num: 44, livery: L.liv, smooth: true, parts: MIXED } });
  }
  return out;
}

/** FNV-1a over the Float64 bits of every element: bit-exact, -0 and NaN included. */
function hashArr(a: ArrayLike<number>): string {
  const f = new Float64Array(1), u = new Uint32Array(f.buffer);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < a.length; i++) {
    f[0] = a[i]!;
    h1 = Math.imul(h1 ^ u[0]!, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ u[1]!, 0x01000193) >>> 0;
    h1 = Math.imul(h1 ^ h2, 0x01000193) >>> 0;
  }
  return `${a.length}:${h1.toString(16)}:${h2.toString(16)}`;
}

function digest(m: CarMesh): Record<string, unknown> {
  return {
    pos: hashArr(m.pos), nrm: hashArr(m.nrm), col: hashArr(m.col), mat: hashArr(m.mat), idx: hashArr(m.idx),
    flapInfo: plain(m.flapInfo), parts: plain(m.parts ?? null), keys: Object.keys(m).sort(),
  };
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

describe("Car3D (car3d.js port)", () => {
  it("builds a plausible car", () => {
    const m = build();
    const n = m.pos.length / 3;
    expect(n).toBeGreaterThan(10_000);
    expect(m.nrm).toHaveLength(m.pos.length);
    expect(m.col).toHaveLength(m.pos.length);
    expect(m.mat).toHaveLength(n);
    expect(m.idx.length % 3).toBe(0);
    expect(Math.max(...m.idx)).toBeLessThan(n);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < m.pos.length; i += 3) {
      x0 = Math.min(x0, m.pos[i]!); x1 = Math.max(x1, m.pos[i]!);
      y0 = Math.min(y0, m.pos[i + 1]!); y1 = Math.max(y1, m.pos[i + 1]!);
      z0 = Math.min(z0, m.pos[i + 2]!); z1 = Math.max(z1, m.pos[i + 2]!);
    }
    expect(z1 - z0).toBeGreaterThan(5.0);
    expect(z1 - z0).toBeLessThan(5.5);
    expect(x1 - x0).toBeGreaterThan(1.7);
    expect(x1 - x0).toBeLessThanOrEqual(2.0);
    expect(y0).toBeGreaterThanOrEqual(0);
    expect(y1).toBeLessThan(1.3);
    expect(m.flapInfo).not.toBeNull();
    // buildComplete appends the flaps the baked mesh leaves out.
    expect(buildComplete().pos.length).toBeGreaterThan(m.pos.length);
    expect(Object.keys(TEAM_STYLE)).toHaveLength(11);
    expect(Car3D.teamStyleOf("nope")).toBe(Car3D.teamStyleOf(undefined));
  });

  it("measure emits one record per non-empty section", () => {
    const m = build(null, null, { measure: true });
    const names = (m.parts ?? []).map((p) => p.name);
    expect(names).toContain("chassis");
    expect(names).toContain("wheels");
    for (const p of m.parts ?? []) expect(p.vertices).toBeGreaterThan(0);
  });

  describe.skipIf(!haveF1)("matches f1-game bit for bit", () => {
    const vm = haveF1 ? loadF1Car() : {};
    const ref = vm["Car3D"] as { build: BuildFn; buildComplete: BuildFn };
    const vmShade = vm["CarShade"] as { set(v: unknown): unknown };

    it("complete arrays: default and a busy livery", () => {
      expect(plain(build())).toEqual(plain(ref.build()));
      const L = LIVERIES["cadillac"]!;
      const opts: BuildOptions = { teamId: "cadillac", num: 77, livery: L.liv, parts: VISUAL_A, smooth: true, measure: true };
      expect(plain(buildComplete(L.c1, L.c2, opts))).toEqual(plain(ref.buildComplete(clone(L.c1), clone(L.c2), clone(opts))));
    });

    for (const c of cases()) {
      it(c.name, () => {
        for (const which of ["build", "buildComplete"] as const) {
          const mine = (which === "build" ? build : buildComplete)(c.c1, c.c2, c.opts);
          const theirs = ref[which](clone(c.c1), clone(c.c2), clone(c.opts));
          expect(digest(mine), which).toEqual(digest(theirs));
        }
      });
    }

    it("follows the CarShade preference (rounded body and wheels)", () => {
      try {
        for (const p of ["1", "ferrari", "0"]) {
          CarShade.set(p); vmShade.set(p);
          for (const teamId of ["ferrari", "haas"]) {
            expect(digest(build(null, null, { teamId })), `${p}/${teamId}`).toEqual(digest(ref.build(null, null, { teamId })));
          }
        }
      } finally {
        CarShade.set(null); vmShade.set(null);
      }
    });
  });
});
