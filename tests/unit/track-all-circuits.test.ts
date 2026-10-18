// Every one of the 52 circuits builds with the ported core, and its buffers are well formed.
// Per-circuit parity against f1-game lands with the remaining goldens.
import { describe, expect, it } from "vitest";
import { CIRCUITS } from "../../src/circuits/index";
import { buildTrack, defById, validateGeometry } from "../../src/track/core/tracks";

describe.each(CIRCUITS.map((c) => c.id))("buildTrack %s", (id) => {
  it("builds valid buffers", () => {
    const t = buildTrack(defById(id)!);
    expect(t.n).toBeGreaterThanOrEqual(200);
    for (const [k, g] of Object.entries(t.geo!)) expect(validateGeometry(g).ok, k).toBe(true);
    expect(t.geo!.road.idx.length).toBeGreaterThan(0);
    expect(t.geo!.terrain.idx.length).toBeGreaterThan(0);
  });
});
