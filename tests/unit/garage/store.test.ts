import { describe, expect, it } from "vitest";
import { GarageDefaults } from "../../../src/data/garage-defaults";
import { SettingsDefaults } from "../../../src/data/settings-defaults";
import { createGarageStore, memoryStorage, PREFIX, type StorageLike } from "../../../src/garage/store";

describe("garage store (f1-game js/core/store.js get/set/write/raw)", () => {
  it("keys live under a26., never f1-game's apex26.", () => {
    const disk = memoryStorage(), store = createGarageStore(disk);
    expect(PREFIX).toBe("a26.");
    store.set("setup.haas", { arbF: 3 });
    expect([...disk.data.keys()]).toEqual(["a26.setup.haas"]);
    expect(JSON.parse(disk.data.get("a26.setup.haas") as string)).toEqual({ arbF: 3 });
    disk.data.set("apex26.garageArrival", JSON.stringify({ speed: 2 }));
    expect(store.get("garageArrival", "dflt")).toBe("dflt");
  });

  it("set(k, undefined) REMOVES the key; null is a stored value", () => {
    const disk = memoryStorage(), store = createGarageStore(disk);
    store.set("x", 1);
    expect(store.set("x", undefined)).toBe(true);
    expect(disk.data.has("a26.x")).toBe(false);
    expect(store.get("x", "d")).toBe("d");
    store.set("x", null);
    expect(disk.data.get("a26.x")).toBe("null");
    expect(store.get("x", "d")).toBeNull();
    expect(createGarageStore(disk).get("x", "d")).toBeNull();
  });

  it("a miss reads the shipped garage, then settings defaults, before the call-site default — as a copy", () => {
    const store = createGarageStore(memoryStorage());
    expect(GarageDefaults.has("setup.mercedes")).toBe(true);
    const shipped = store.get("setup.mercedes", null) as Record<string, number>;
    expect(shipped).toEqual(GarageDefaults.get("setup.mercedes"));
    shipped["arbF"] = 99;
    expect((store.get("setup.mercedes", null) as Record<string, number>)["arbF"]).not.toBe(99);
    const sk = SettingsDefaults.keys()[0] as string;
    expect(store.get(sk, "call-site")).toBe(SettingsDefaults.get(sk));
    expect(store.get("not.a.default", "call-site")).toBe("call-site");
    // A stored value outranks the shipped one; removal brings the shipped one back.
    store.set("setup.mercedes", { arbF: 2 });
    expect(store.get("setup.mercedes", null)).toEqual({ arbF: 2 });
    store.set("setup.mercedes", undefined);
    expect(store.get("setup.mercedes", null)).toEqual(GarageDefaults.get("setup.mercedes"));
    expect(store.getStored("setup.mercedes")).toBeUndefined();
  });

  it("a corrupt or non-finite stored value is one key: dropped and served as a miss", () => {
    const disk = memoryStorage();
    disk.data.set("a26.bad", "{oops");
    disk.data.set("a26.inf", "1e309");
    const store = createGarageStore(disk);
    expect(store.get("bad", 7)).toBe(7);
    expect(disk.data.has("a26.bad")).toBe(false);
    expect(store.get("inf", 3)).toBe(3);
    expect(store.broken).toBeNull();
  });

  it("a failed disk write is still usable this session (ok, not durable); a blocked read serves the default", () => {
    const throwing: StorageLike = {
      getItem() { throw Object.assign(new Error("no"), { name: "SecurityError" }); },
      setItem() { throw Object.assign(new Error("full"), { name: "QuotaExceededError" }); },
      removeItem() { throw new Error("no"); },
    };
    const store = createGarageStore(throwing);
    expect(store.get("k", "d")).toBe("d");
    expect(store.broken).toBe("SecurityError");
    const r = store.write("k", { a: 1 });
    expect(r.ok).toBe(true);
    expect(r.durable).toBe(false);
    expect(r.reason).toBe("SecurityError");
    expect(store.get("k", "d")).toEqual({ a: 1 });
    expect(createGarageStore(null).set("k", 1)).toBe(false);
  });

  it("unserialisable values are refused whole: no cache, no revision", () => {
    const store = createGarageStore(memoryStorage());
    store.set("k", 1);
    const rev = store.keyRevision("k");
    expect(store.write("k", () => 1)).toMatchObject({ ok: false, durable: false });
    const cyc: Record<string, unknown> = {}; cyc["self"] = cyc;
    expect(store.write("k", cyc).ok).toBe(false);
    expect(store.get("k", 0)).toBe(1);
    expect(store.keyRevision("k")).toBe(rev);
  });

  it("keyRevision counts writes per key, accepting the prefix either way", () => {
    const store = createGarageStore(memoryStorage());
    const a = store.keyRevision("setup.haas");
    store.set("setup.haas", {});
    expect(store.keyRevision("setup.haas")).not.toBe(a);
    expect(store.keyRevision("a26.setup.haas")).toBe(store.keyRevision("setup.haas"));
    expect(store.keyRevision("other")).toBe(a);
    const before = store.rev;
    store.write("x", 1);
    expect(store.rev).toBe(before + 1);
  });

  it("the raw lane stores bare strings and substitutes only settings defaults", () => {
    const disk = memoryStorage(), store = createGarageStore(disk);
    expect(store.raw("flag")).toBeNull();
    expect(store.rawSet("flag", 1)).toBe(true);
    expect(disk.data.get("a26.flag")).toBe("1");
    expect(store.raw("a26.flag")).toBe("1");
    expect(store.rawDel("flag")).toBe(true);
    expect(store.raw("flag")).toBeNull();
    const sk = SettingsDefaults.keys()[0] as string;
    expect(store.raw(sk)).toBe(String(SettingsDefaults.get(sk)));
  });
});
