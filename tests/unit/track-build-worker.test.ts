// The worker round trip: build -> pack -> structuredClone with transfer (what postMessage does)
// -> unpack yields a track whose queries and buffers equal a direct build, and every buffer is transferred.
import { describe, expect, it } from "vitest";
import { handleBuild } from "../../src/track/build/build-worker";
import { unpackBuilt, type WorkerReply } from "../../src/track/build/protocol";
import { trackQuery } from "../../src/track/build/query";
import { buildTrack, defById } from "../../src/track/core/tracks";
import type { TrackSample } from "../../src/contracts/track";
import type { TrackGeometry } from "../../src/track/core/types";

describe("track build worker", () => {
  it.each(["monza", "zandvoort"])("%s round-trips bit-exactly", (id) => {
    let reply: WorkerReply | null = null;
    handleBuild({ type: "build", seq: 1, id }, (msg, transfer) => {
      reply = structuredClone(msg, { transfer });
      for (const b of transfer) expect(b.byteLength).toBe(0);   // detached: transferred, not copied
    });
    const r = reply as WorkerReply | null;
    if (!r || r.type !== "built") throw new Error("no build");
    const viaWorker = unpackBuilt(r, defById(id)!);
    const direct = buildTrack(defById(id)!);
    // The hidden-face strip / compaction stats (`_hidden`, `_compact`) are build diagnostics with a
    // wall-clock `ms`; the protocol carries geometry only, so compare the buffers without them.
    const buffers = (geo: TrackGeometry | undefined) => geo && Object.fromEntries(Object.entries(geo).map(([k, g]) => {
      const { _hidden: _h, _compact: _c, ...rest } = g;
      return [k, rest];
    }));
    expect(buffers(viaWorker.geo)).toEqual(buffers(direct.geo));
    expect(viaWorker.px).toEqual(direct.px);
    const a = trackQuery(viaWorker), b = trackQuery(direct);
    const sa: TrackSample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 }, sb: TrackSample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };
    const ba = { dy: 0, roll: 0 }, bb = { dy: 0, roll: 0 };
    for (let s = 0; s < direct.total; s += 7.3) {
      expect(a.sample(s, sa)).toEqual(b.sample(s, sb));
      for (const x of [-9, -4, 0, 4, 9]) {
        expect(a.banking(s, x, ba)).toEqual(b.banking(s, x, bb));
        expect(a.inPitLane(s, x)).toBe(b.inPitLane(s, x));
        expect(a.onKerb(s, x)).toBe(b.onKerb(s, x));
      }
    }
    expect(viaWorker.surface!.heightAt(10, 30, 1)).toBe(direct.surface!.heightAt(10, 30, 1));
  }, 30_000);   // two full builds: slow under a fully loaded parallel run

  it("reports an unknown id as an error reply", () => {
    let reply: WorkerReply | null = null;
    handleBuild({ type: "build", seq: 2, id: "nope" }, (msg) => { reply = msg; });
    expect((reply as WorkerReply | null)?.type).toBe("error");
  });
});
