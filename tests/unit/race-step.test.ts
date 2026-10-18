// The AI half of updateCar and the field tick (src/sim/ai/race-step.ts) vs
// f1-game: two 3-car Monza runs (player + 2 AI with car-to-car contact; three AI
// from a standing start) replayed with the track served from each golden's
// tape. Gate as T1.6: Object.is on every recorded field of every active car
// (and the sim RNG state) for 300 steps, drift <= 1e-4 at 600, first
// divergence reported.
import { describe, expect, it } from "vitest";
import { RACES, replayRace } from "../goldens/race-replay";

describe("race step vs f1-game race goldens", () => {
  for (const name of RACES) {
    it(`${name}: bit-exact for 300 steps, drift <= 1e-4 at 600`, () => {
      const r = replayRace(name);
      const where = r.firstDiff < 0 ? "never diverges" : `first divergence at step ${r.firstDiff}: ${r.firstDiffField}`;
      console.log(`${name}: ${where}; ${r.steps} steps replayed; end drift ${r.endDrift.toExponential(2)}`);
      expect(r.tapeError, where).toBeNull();
      expect(r.firstDiff === -1 || r.firstDiff >= 300, where).toBe(true);
      expect(r.steps, where).toBe(600);
      expect(r.endDrift, where).toBeLessThanOrEqual(1e-4);
    });
  }
});
