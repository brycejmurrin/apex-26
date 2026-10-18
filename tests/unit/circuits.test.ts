import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { CIRCUITS, CIRCUIT_IDS, SEASON, circuitById } from "../../src/circuits";
import type { CircuitDef } from "../../src/circuits/types";

// Snapshot of f1-game's curated order (tools/manifest.cjs CIRCUITS ==
// Tracks.LIST == picker order). A stored track index is positional, so a
// reorder is a save-breaking change and must fail here.
const ORDER = [
  "bahrain", "monaco", "silverstone", "spa", "monza", "suzuka", "singapore", "cota",
  "interlagos", "vegas", "madrid", "zandvoort", "jeddah", "albert_park", "shanghai", "miami",
  "imola", "montreal", "redbull", "hungaroring", "baku", "mexico", "qatar", "abudhabi",
  "hockenheim", "nurburgring", "catalunya", "sepang", "istanbul", "paul_ricard", "portimao", "sochi",
  "mugello", "magny_cours", "estoril", "kyalami", "watkins_glen", "indianapolis", "buenos_aires", "jacarepagua",
  "fuji", "okayama", "korea", "jerez", "donington", "anderstorp", "brands_hatch", "zolder",
  "dijon", "buddh", "mont_tremblant", "mosport",
];

const REQUIRED = [
  "id", "reverse", "name", "gp", "country", "night", "theme", "lengthKm", "baseHW",
  "sceneryCoordinates", "pal", "sectors", "turns", "furniture", "kit", "standSet", "path",
] as const satisfies readonly (keyof CircuitDef)[];

describe("circuit defs", () => {
  it("has 52 circuits with unique ids", () => {
    expect(CIRCUITS).toHaveLength(52);
    expect(new Set(CIRCUITS.map((c) => c.id)).size).toBe(52);
  });

  it("keeps the curated order", () => {
    expect(CIRCUITS.map((c) => c.id)).toEqual(ORDER);
    expect([...CIRCUIT_IDS]).toEqual(ORDER);
  });

  it("carries every required key", () => {
    for (const c of CIRCUITS) {
      for (const k of REQUIRED) expect(c, `${c.id}.${k}`).toHaveProperty(k);
    }
  });

  it("has a closed path of at least 3 finite points and a positive length", () => {
    for (const c of CIRCUITS) {
      expect(c.path.pts.length, c.id).toBeGreaterThanOrEqual(3);
      for (const p of c.path.pts) {
        expect(p, c.id).toHaveLength(2);
        expect(Number.isFinite(p[0]) && Number.isFinite(p[1]), c.id).toBe(true);
      }
      expect(c.lengthKm, c.id).toBeGreaterThan(0);
      expect(c.path.len, c.id).toBeGreaterThan(0);
    }
  });

  it("forms a 24-circuit season from the non-classic defs", () => {
    expect(SEASON).toHaveLength(24);
    expect(SEASON).toEqual(CIRCUITS.filter((c) => !c.classic));
  });

  it("looks circuits up by id", () => {
    expect(circuitById("monza")?.name).toBe("MONZA");
    expect(circuitById("nope")).toBeUndefined();
  });
});

// Round trip against the source of truth. Skipped where f1-game is absent (CI):
// set F1_GAME or keep f1-game beside the repo to run it.
const ROOT = path.resolve(import.meta.dirname, "../..");
const F1 = process.env["F1_GAME"] ?? path.resolve(ROOT, "../f1-game");
const haveF1 = fs.existsSync(path.join(F1, "tools/manifest.cjs"));

describe.skipIf(!haveF1)("round trip vs f1-game", () => {
  it("each generated def deep-equals the VM-loaded f1-game def", () => {
    const window: { TrackDefs?: unknown[] } = {};
    const ctx = vm.createContext({ window });
    for (const id of ORDER) {
      const file = path.join(F1, "js/circuits", `${id}.js`);
      vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
    }
    // Re-parse to drop the VM realm's prototypes; the defs are JSON-safe.
    const src = JSON.parse(JSON.stringify(window.TrackDefs)) as unknown[];
    expect(src).toHaveLength(CIRCUITS.length);
    CIRCUITS.forEach((c, i) => expect(c, c.id).toStrictEqual(src[i]));
  });
});
