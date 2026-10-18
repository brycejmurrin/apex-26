import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build, buildComplete, type BuildOptions } from "../../src/car/car3d";
import type { MeshOut, Vec3 } from "../../src/car/types";
import { haveF1, loadF1Car } from "../helpers/f1-car-vm";
import { summary, type MeshSummary } from "../helpers/mesh-summary";

// Car3D.build summaries recorded from f1-game (Node VM) so CI, which has no f1-game,
// still pins the port: vertex/index counts, bounding box, per-surface vertex counts
// and an FNV-1a hash over each array's Float64 bits. Regenerate with
// UPDATE_CAR_FIXTURES=1 npx vitest run tests/unit/car-fixtures.test.ts (needs f1-game).
const FILE = path.resolve(import.meta.dirname, "../fixtures/car/car3d.json");

interface Config { name: string; complete?: boolean; c1?: Vec3; c2?: Vec3; opts?: BuildOptions }
const CONFIGS: Config[] = [
  { name: "default" },
  { name: "default-complete", complete: true },
  { name: "noWheels", opts: { noWheels: true } },
  { name: "field", opts: { field: true, noWheels: true } },
  { name: "silhouette", opts: { field: true, silhouette: true, noDriver: true, noWheels: true, livery: {}, smooth: false } },
  { name: "flat", opts: { smooth: false } },
  { name: "cockpit", opts: { cockpit: true, noWheels: true, noDriver: true } },
  ...["mercedes", "ferrari", "mclaren", "redbull", "alpine", "racingbulls", "haas", "williams", "audi", "astonmartin", "cadillac"]
    .map((teamId): Config => ({ name: "team-" + teamId, complete: true, c1: [0.1, 0.2, 0.6], c2: [0.95, 0.95, 0.95], opts: { teamId, num: 16 } })),
  { name: "parts-0", opts: { parts: { engine: 0, aero: 0, suspension: 0, brakes: 0, tyres: 0, ers: 0, gearbox: 0, fuel: 0 } } },
  { name: "parts-2", opts: { parts: { engine: 2, aero: 2, suspension: 2, brakes: 2, tyres: 2, ers: 2, gearbox: 2, fuel: 2 } } },
  { name: "livery-finishes", opts: { teamId: "cadillac", livery: { finish: "satin", bodySplit: "lr", wingCarbon: "carbon", coverFinish: "chrome" } } },
];

type Summary = MeshSummary;
const mine = (c: Config) => summary((c.complete ? buildComplete : build)(c.c1, c.c2, c.opts));

describe("Car3D fixtures (recorded from f1-game)", () => {
  if (haveF1 && process.env["UPDATE_CAR_FIXTURES"]) {
    const ref = loadF1Car()["Car3D"] as Record<"build" | "buildComplete", (a: unknown, b: unknown, o: unknown) => MeshOut>;
    const out: Record<string, Summary> = {};
    for (const c of CONFIGS) out[c.name] = JSON.parse(JSON.stringify(summary((c.complete ? ref.buildComplete : ref.build)(c.c1, c.c2, c.opts)))) as Summary;
    fs.writeFileSync(FILE, JSON.stringify(out, null, 1) + "\n");
  }
  const fixtures = JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, Summary>;
  it("covers every config", () => expect(Object.keys(fixtures).sort()).toEqual(CONFIGS.map((c) => c.name).sort()));
  for (const c of CONFIGS) {
    it(c.name, () => expect(JSON.parse(JSON.stringify(mine(c)))).toEqual(fixtures[c.name]));
  }
});
