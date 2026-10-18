import { afterEach, describe, expect, it } from "vitest";
import {
  FieldLod, T, castsShadow, d2, flame, flapsM, init, lensK2, mirrorCap, nearest, parts, setEnabled, tier, wheelsLite,
} from "../../src/car/field-lod";
import type { FieldLodStore, LodCar } from "../../src/car/field-lod";
import { haveF1, inF1, loadF1, plain } from "./car-f1-vm";

afterEach(() => setEnabled(true));

const FOVS: (number | undefined)[] = [undefined, NaN, -1, 0, 0.01, 0.0101, 0.3142, 0.5, Math.PI / 3, 1.2, 2, 3.0999, 3.1, 3.5];
const DISTS_M = [0, 1, 10, 35, 44.9, 45, 45.5, 49.9, 50, 50.1, 55, 55.1, 59.9, 60, 61, 79.9, 80, 81, 108, 119.9, 120, 120.1, 132, 133, 150, 151, 260, 1000];
const DIST2S = DISTS_M.map((m) => m * m);

/** A deterministic LCG, so the nearest() spread is the same every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

describe("field LOD", () => {
  it("keeps f1-game's threshold table, frozen", () => {
    expect(T).toEqual({ WHEEL_EXTRAS_M: 50, FLAPS_M: 80, FLAME_M: 60, NO_DECAL_M: 120, SHADOW_CAST_M: 50, MIRROR_CARS: 6, LEGACY_FLAPS_M: 150 });
    expect(Object.isFrozen(T)).toBe(true);
    expect(Object.isFrozen(FieldLod)).toBe(true);
  });

  it("init turns off only for 0 / '0' / false, and survives a throwing store", () => {
    const st = (v: unknown): FieldLodStore => ({ get: () => v });
    expect(init(st(0))).toBe(false);
    expect(FieldLod.on).toBe(false);
    expect(init(st("0"))).toBe(false);
    expect(init(st(false))).toBe(false);
    for (const v of [1, "1", true, null, undefined, "", "off"]) expect(init(st(v)), String(v)).toBe(true);
    expect(init(undefined)).toBe(true);
    expect(init({})).toBe(true);
    expect(init({ get: () => { throw new Error("blocked"); } })).toBe(true);
  });

  it("tiers by distance, through the lens, with hysteresis on a car", () => {
    expect(tier(49 * 49)).toBe(0);
    expect(tier(51 * 51)).toBe(1);
    expect(tier(121 * 121)).toBe(2);
    // An 18° TV lens: a rival 130 m away is a 60°-lens 36 m away.
    expect(tier(130 * 130, (18 * Math.PI) / 180)).toBe(0);
    const car: LodCar = {};
    expect(tier(52 * 52, undefined, car)).toBe(1);
    expect(tier(48 * 48, undefined, car)).toBe(1); // inside 50 but not inside -10 %
    expect(tier(44 * 44, undefined, car)).toBe(0);
    expect(tier(54 * 54, undefined, car)).toBe(0); // past 50 but not past +10 %
    expect(car._lodTier).toBe(0);
    setEnabled(false);
    expect(tier(1e9)).toBe(0);
  });

  it("gates flaps, flame, shadows and the mirror, and the off switch restores the legacy gates", () => {
    expect(flapsM()).toBe(80);
    expect(flame(59 * 59)).toBe(true);
    expect(flame(61 * 61)).toBe(false);
    expect(castsShadow(51 * 51)).toBe(false);
    expect(mirrorCap()).toBe(6);
    expect(wheelsLite(51 * 51)).toBe(true);
    setEnabled(0);
    expect(FieldLod.on).toBe(false);
    expect(flapsM()).toBe(150);
    expect(flame(1e9)).toBe(true);
    expect(castsShadow(1e9)).toBe(true);
    expect(mirrorCap()).toBe(Infinity);
    expect(wheelsLite(1e9)).toBe(false);
  });

  it("d2 is the squared camera distance, 0 for the player", () => {
    expect(d2([3, 4, 12], [0, 0, 0])).toBe(169);
    expect(d2([3, 4, 12], [0, 0, 0], true)).toBe(0);
    expect(d2(new Float32Array([1, 2, 3]), [1, 2, 3])).toBe(0);
  });

  it("nearest keeps the cap closest, the forced index first", () => {
    const keep = new Uint8Array(8);
    expect(nearest([9, 1, 8, 2, 7, 3, 6, 4], 8, 3, keep, -1)).toBe(3);
    expect([...keep]).toEqual([0, 1, 0, 1, 0, 1, 0, 0]);
    expect(nearest([9, 1, 8, 2, 7, 3, 6, 4], 8, 3, keep, 0)).toBe(3);
    expect([...keep]).toEqual([1, 1, 0, 1, 0, 0, 0, 0]);
    expect(nearest([1, 2], 2, 6, keep, -1)).toBe(2);
  });

  it("parts: the player keeps everything; far rivals drop to the cheap body", () => {
    const far = parts(200 * 200);
    expect(far).toMatchObject({ tier: 2, cheapBody: true, decal: false, fixedWheels: false, spinDisc: false, compound: false });
    const me = parts(200 * 200, true);
    expect(me).toMatchObject({ tier: 0, cheapBody: false, decal: true, spinDisc: true, compound: true, flaps: true, flame: true, castsShadow: true });
  });
});

// ---- Round trip against f1-game, loaded in a VM. Skipped where it is absent. ----

type F1Lod = typeof FieldLod;

describe.skipIf(!haveF1)("field LOD round trip vs f1-game", () => {
  const fresh = (): F1Lod => inF1<{ FieldLod: F1Lod }>(loadF1(["js/car/field-lod.js"]), "({ FieldLod })").FieldLod;

  it("exports the same members and table", () => {
    const f1 = fresh();
    expect(Object.keys(FieldLod)).toEqual(Object.keys(f1));
    expect(T).toEqual(plain(f1.T));
    expect(Object.isFrozen(f1.T)).toBe(true);
  });

  it("init agrees for every stored value and store shape", () => {
    const f1 = fresh();
    const stores: (FieldLodStore | null | undefined)[] = [
      undefined, null, {}, { get: () => { throw new Error("blocked"); } },
      ...[0, "0", false, 1, "1", true, null, undefined, "", "off", 0.0, -0, NaN, [], {}].map((v) => ({ get: () => v })),
    ];
    for (const s of stores) {
      expect(init(s), String(s?.get)).toBe(f1.init(s));
      expect(FieldLod.on).toBe(f1.on);
    }
  });

  it("lensK2 and d2 agree bit for bit", () => {
    const f1 = fresh();
    for (const f of FOVS) expect(lensK2(f), String(f)).toBe(f1.lensK2(f));
    const rnd = lcg(7);
    for (let i = 0; i < 200; i++) {
      const p = [rnd() * 400 - 200, rnd() * 20, rnd() * 400 - 200], e = [rnd() * 400 - 200, rnd() * 5, rnd() * 400 - 200];
      expect(d2(p, e)).toBe(f1.d2(p, e));
      expect(d2(p, e, true)).toBe(f1.d2(p, e, true));
    }
  });

  for (const enabled of [true, false]) {
    it(`every selector agrees over a distance x lens grid (enabled=${enabled})`, () => {
      const f1 = fresh();
      setEnabled(enabled); f1.setEnabled(enabled);
      expect(FieldLod.on).toBe(f1.on);
      expect(flapsM()).toBe(f1.flapsM());
      expect(mirrorCap()).toBe(f1.mirrorCap());
      for (const x of DIST2S) {
        expect(flame(x), String(x)).toBe(f1.flame(x));
        expect(castsShadow(x), String(x)).toBe(f1.castsShadow(x));
        for (const isPlayer of [undefined, false, true]) {
          expect(parts(x, isPlayer), `${x} ${String(isPlayer)}`).toEqual(plain(f1.parts(x, isPlayer)));
        }
        for (const f of FOVS) {
          expect(tier(x, f), `${x} ${String(f)}`).toBe(f1.tier(x, f));
          expect(wheelsLite(x, f), `${x} ${String(f)}`).toBe(f1.wheelsLite(x, f));
        }
      }
    });

    it(`hysteresis agrees on a car swept out and back (enabled=${enabled})`, () => {
      const f1 = fresh();
      setEnabled(enabled); f1.setEnabled(enabled);
      for (const f of [undefined, (18 * Math.PI) / 180, Math.PI / 3]) {
        for (const start of [undefined, 0, 1, 2, 3, -1]) {
          const ours: LodCar = start === undefined ? {} : { _lodTier: start };
          const theirs: LodCar = { ...ours };
          const sweep = [...DISTS_M, ...[...DISTS_M].reverse(), 48, 52, 56, 44, 115, 125, 133, 107, 132];
          for (const m of sweep) {
            expect(tier(m * m, f, ours), `${m} ${String(f)} ${String(start)}`).toBe(f1.tier(m * m, f, theirs));
            expect(ours._lodTier).toBe(theirs._lodTier);
          }
        }
        expect(tier(1, f, null)).toBe(f1.tier(1, f, null));
      }
    });
  }

  it("nearest agrees over random fields, caps and forced subjects", () => {
    const f1 = fresh();
    const rnd = lcg(42);
    for (let trial = 0; trial < 300; trial++) {
      const n = Math.floor(rnd() * 23);
      const dist2s = Array.from({ length: n }, () => (rnd() < 0.1 ? Infinity : Math.floor(rnd() * 50) * 100));
      const cap = [0, 1, 6, 22, Infinity][Math.floor(rnd() * 5)]!;
      const force = Math.floor(rnd() * (n + 3)) - 2;
      const ka = new Uint8Array(22).fill(7), kb = new Uint8Array(22).fill(7);
      expect(nearest(dist2s, n, cap, ka, force)).toBe(f1.nearest(dist2s, n, cap, kb, force));
      expect([...ka]).toEqual([...kb]);
    }
    const fa = new Float32Array([5, 3, 9, 1]), ka: number[] = [], kb: number[] = [];
    expect(nearest(fa, 4, 2, ka, 2)).toBe(f1.nearest(fa, 4, 2, kb, 2));
    expect(ka).toEqual(kb);
  });
});
