// Structural checks on the physics tape goldens (tools/oracle/physics.mjs):
// the header pins the recipe, every trace has 600 steps with a tape, and the
// player state chains (each step's prog advances by about speed·dt). The
// player-step replay itself is tests/unit/player-step.test.ts (T1.6).
import { describe, expect, it } from "vitest";
import { readGolden } from "../goldens/decode";

interface Tape {
  header: { schema: string; trace: string; steps: number; FIXED_DT: number; REVISION: string };
  initial: { car: Record<string, unknown>; world: Record<string, unknown> };
  steps: { input: Record<string, unknown>; state: Record<string, number | boolean | null>; raceT: number; tape: unknown[][] }[];
}

const TRACES = ["straight-line-accel", "steady-corner-load", "trail-brake-into-rotation", "off-track-recovery"];

describe("physics tape goldens", () => {
  for (const id of TRACES) {
    it(`${id}: 600 steps, every step taped, state chains`, () => {
      const g = readGolden<Tape>(`physics-tape-${id}.json.gz`);
      expect(g.header.schema).toBe("apex-26-physics-golden/1");
      expect(g.header.trace).toBe(id);
      expect(g.steps).toHaveLength(600);
      expect(g.initial.world["ROAD_FOLLOW"]).toBe(0);
      let prog = g.initial.car["prog"] as number;
      for (const [i, st] of g.steps.entries()) {
        expect(st.tape.length, `step ${i} tape`).toBeGreaterThan(0);
        expect(st.tape.some((e) => String(e[0]).startsWith("UNTAPED")), `step ${i} untaped call`).toBe(false);
        const p = st.state["prog"] as number;
        expect(Math.abs(p - prog), `step ${i} prog jump`).toBeLessThan(3);
        prog = p;
      }
    });
  }
});
