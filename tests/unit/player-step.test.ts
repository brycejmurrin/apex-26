// T1.6 gate: the TS player step replays every physics tape golden.
//   - Object.is on every recorded state field for the first 300 steps,
//   - drift <= 1e-4 at the end of the trace (600 steps),
//   - the first diverging step (and field, or track query) is reported.
// The track is served from the golden's own tape (tests/goldens/replay.ts), so
// this is independent of the track lane's port.
import { describe, expect, it } from "vitest";
import { replay, TRACES } from "../goldens/replay";

const GATE_STEPS = 300;

describe("player step vs f1-game physics goldens", () => {
  for (const name of TRACES) {
    it(`${name}: bit-exact for ${GATE_STEPS} steps, drift <= 1e-4 at 600`, () => {
      const r = replay(name);
      const where = r.firstDiff < 0 ? "never diverges" : `first divergence at step ${r.firstDiff}: ${r.firstDiffField}`;
      console.log(`${name}: ${where}; ${r.steps} steps replayed; end drift ${r.endDrift.toExponential(2)}; arc reads skipped ${r.arcSkipped}`);
      expect(r.tapeError, where).toBeNull();
      expect(r.firstDiff === -1 || r.firstDiff >= GATE_STEPS, where).toBe(true);
      expect(r.steps, where).toBe(600);
      expect(r.endDrift, where).toBeLessThanOrEqual(1e-4);
      // The arc rule, observed: f1-game read curvature every step; the port never needed it.
      expect(r.arcSkipped).toBeGreaterThan(0);
    });
  }
});
