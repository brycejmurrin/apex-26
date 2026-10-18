// The a26. save store and the one-time import of f1-game's apex26.* saves.
import { describe, expect, it } from "vitest";
import { IMPORT_KEY, MemoryStorage, SaveStore, importLegacy, type StorageLike } from "../../../src/modes/store";

class FullStorage extends MemoryStorage {
  override setItem(): void { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; }
}

describe("SaveStore", () => {
  it("prefixes keys a26., caches reads and removes on undefined", () => {
    const s = new MemoryStorage(), st = new SaveStore(s);
    expect(st.write("season", { round: 1 })).toEqual({ ok: true, durable: true, reason: null });
    expect(s.getItem("a26.season")).toBe('{"round":1}');
    expect(st.get("season", null)).toEqual({ round: 1 });
    st.write("season", undefined);
    expect(s.getItem("a26.season")).toBeNull();
    expect(st.get("season", "d")).toBe("d");
  });

  it("drops a corrupt or non-finite value instead of serving it", () => {
    const s = new MemoryStorage();
    s.setItem("a26.money", "1e999");
    s.setItem("a26.cfg", "{not json");
    const st = new SaveStore(s);
    expect(st.get("money", 0)).toBe(0);
    expect(st.get("cfg", null)).toBeNull();
    expect(s.getItem("a26.cfg")).toBeNull();
    expect(st.broken).toBeNull();
  });

  it("keeps a refused write for the session and says it is not durable", () => {
    const st = new SaveStore(new FullStorage());
    const r = st.write("season", { round: 3 });
    expect(r).toEqual({ ok: true, durable: false, reason: "QuotaExceededError" });
    expect(st.get("season", null)).toEqual({ round: 3 });
  });

  it("refuses a value JSON cannot hold, leaving the old one", () => {
    const st = new SaveStore(new MemoryStorage());
    st.write("k", 1);
    const cyclic: Record<string, unknown> = {}; cyclic["self"] = cyclic;
    expect(st.write("k", cyclic).ok).toBe(false);
    expect(st.get("k", 0)).toBe(1);
  });

  it("bumps a key's revision on local and foreign writes", () => {
    const st = new SaveStore(new MemoryStorage());
    const r0 = st.keyRevision("season");
    st.write("season", {});
    const r1 = st.keyRevision("season");
    st.foreign("a26.season");
    expect(new Set([r0, r1, st.keyRevision("season")]).size).toBe(3);
  });
});

describe("importLegacy", () => {
  const legacy = (): StorageLike => {
    const s = new MemoryStorage();
    s.setItem("apex26.season", '{"round":4}');
    s.setItem("apex26.career.driver.0", '{"year":2027}');
    s.setItem("apex26.pitPlan.monza", "1");
    s.setItem("apex26.seasonCfg", "{broken");
    s.setItem("apex26.gfxQuality", '"high"');   // not a mode save: stays f1-game's
    s.setItem("a26.careerSlot", '"myteam:1"');
    s.setItem("apex26.careerSlot", '"driver:0"');
    return s;
  };

  it("copies mode saves once, never overwriting a26. and never touching apex26.", () => {
    const s = legacy(), st = new SaveStore(s);
    const r = importLegacy(st, s, 1234);
    expect(r).toEqual({ copied: ["career.driver.0", "pitPlan.monza", "season"], skipped: ["careerSlot", "seasonCfg"], already: false });
    expect(st.get("season", null)).toEqual({ round: 4 });
    expect(st.get("careerSlot", null)).toBe("myteam:1");
    expect(s.getItem("a26.gfxQuality")).toBeNull();
    expect(s.getItem("apex26.season")).toBe('{"round":4}');
    expect(st.get(IMPORT_KEY, null)).toEqual({ from: "apex26.", at: 1234, keys: r.copied });
  });

  it("does nothing the second time, even after f1-game writes again", () => {
    const s = legacy(), st = new SaveStore(s);
    importLegacy(st, s);
    s.setItem("apex26.team", '"ferrari"');
    expect(importLegacy(new SaveStore(s), s)).toEqual({ copied: [], skipped: [], already: true });
    expect(s.getItem("a26.team")).toBeNull();
  });
});
