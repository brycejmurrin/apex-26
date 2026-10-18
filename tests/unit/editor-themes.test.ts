// Editor lane: TrackThemes (f1-game js/editor/track-themes.js) and
// TrackDesignerProps (js/editor/props.js) ports. The props cases follow f1-game
// tests/unit/designer-props.test.mjs:10-115 (codec / CustomTracks parts omitted).
import { describe, expect, it } from "vitest";
import type { SceneryApi } from "../../src/contracts/scenery";
import * as T from "../../src/editor/track-themes";
import * as P from "../../src/editor/props";

const plain = <V>(v: V): V => JSON.parse(JSON.stringify(v)) as V;
const asApi = (o: object): SceneryApi => o as unknown as SceneryApi;

/** An ellipse control polygon of `n` points (f1-game tests/helpers/editor-vm.mjs ellipse). */
function ellipse(n: number, a: number, b: number): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2; pts.push([Math.cos(t) * a, Math.sin(t) * b]); }
  return pts;
}

/** A recording SceneryApi stand-in: real track arrays, every other member a no-op. */
function mockApi(calls: string[]): SceneryApi {
  const n = 1000, R = 800, total = 2 * Math.PI * R;
  const px = new Float32Array(n), pz = new Float32Array(n), rx = new Float32Array(n), rz = new Float32Array(n);
  const hw = new Float32Array(n).fill(6), curv = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2;
    px[k] = Math.cos(t) * R; pz[k] = Math.sin(t) * R; rx[k] = Math.cos(t); rz[k] = Math.sin(t);
    // Four corners on a straight-dominated lap.
    curv[k] = (k % 250) >= 150 && (k % 250) < 200 ? 0.01 * Math.sin(((k % 250) - 150) / 50 * Math.PI) * (k < 500 ? 1 : -1) : 0;
  }
  const track = { total, n, px, pz, rx, rz, hw, curv };
  const base: Record<string, unknown> = {
    track, n, ds: total / n, px, pz, hw, pyMin: 0,
    def: { id: "custom-test", palette: {} },
    out: { _mat: 0 },
    MAT: new Proxy({}, { get: () => 1 }),
    K: (f: number) => Math.round((((f % 1) + 1) % 1) * n) % n,
    lapBounds: () => ({ cx: 0, cz: 0, radius: R }),
    anchor: () => ({ c: [0, 0, 0], r: [1, 0, 0], u: [0, 1, 0], t: [0, 0, 1], k: 0 }),
    onTrack: () => false,
    waterSurface: () => true,
    modelDiagnostics: { suppressed: [] },
  };
  return new Proxy(base, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      return (..._args: unknown[]) => { calls.push(key); };
    },
  }) as unknown as SceneryApi;
}

describe("TrackThemes", () => {
  it("ORDER has 30 unique ids, each with a preset and dressers", () => {
    expect(T.ORDER.length).toBe(30);
    expect(new Set(T.ORDER).size).toBe(30);
    expect(T.ORDER.slice(0, 3)).toEqual(["parkland", "alpine", "oasis"]);
    expect(T.ORDER[29]).toBe("redwood");
    for (const id of T.ORDER) {
      expect(T.has(id), id).toBe(true);
      expect(T.PRESETS[id], id).toBeDefined();
      expect(Array.isArray(T.DRESS[id]), id).toBe(true);
    }
    expect(Object.keys(T.PRESETS).sort()).toEqual([...T.ORDER].sort());
  });

  it("get falls back to the first id", () => {
    expect(T.get("nope")).toBe(T.PRESETS.parkland);
    expect(T.get(undefined)).toBe(T.PRESETS[T.ORDER[0]!]);
    expect(T.get("toString")).toBe(T.PRESETS.parkland);   // own-property check, not `in`
    expect(T.get("marina")).toBe(T.PRESETS.marina);
    expect(T.has("constructor")).toBe(false);
  });

  it("swatchCss splits the preset's pair at 135°", () => {
    expect(T.swatchCss("parkland")).toBe("linear-gradient(135deg,#2e7d32 50%,#9ccc65 50%)");
    expect(T.swatchCss("nope")).toBe(T.swatchCss("parkland"));
  });

  it("sanitizeLook / lookOf defaults", () => {
    expect(T.sanitizeLook(null)).toBeNull();
    expect(T.sanitizeLook("night")).toBeNull();
    expect(T.sanitizeLook({})).toBeNull();
    expect(T.sanitizeLook({ time: "auto", trees: "normal", crowd: "normal" })).toBeNull();
    expect(T.sanitizeLook({ time: "night" })).toEqual({ time: "night", trees: "normal", crowd: "normal" });
    expect(T.sanitizeLook({ time: "noon", trees: "many", crowd: 3 })).toEqual({ time: "auto", trees: "many", crowd: "normal" });
    expect(T.lookOf(null)).toEqual({ time: "auto", trees: "normal", crowd: "normal" });
    expect(T.lookOf({ look: { crowd: "packed" } })).toEqual({ time: "auto", trees: "normal", crowd: "packed" });
    expect(T.LOOK.time).toEqual(["auto", "day", "dusk", "night"]);
    expect(Object.isFrozen(T.LOOK) && Object.isFrozen(T.LOOK.crowd)).toBe(true);
  });

  it("defFields returns the documented fields for each theme", () => {
    const base = ["theme", "sceneryTheme", "night", "street", "pal", "terrainOuter", "flatTerrain", "furniture", "standSet"];
    for (const id of T.ORDER) {
      const p = T.PRESETS[id]!;
      const f = T.defFields(id);
      const want = [...base];
      if (p.cityStyle) want.push("cityStyle");
      if (p.pit) want.push("pit");
      if (p.terrainMat) want.push("terrainMat");
      expect(Object.keys(f).sort(), id).toEqual(want.sort());
      expect(f.theme, id).toBe(p.theme);
      expect(f.night, id).toBe(p.night);
      expect(f.pal, id).toEqual(plain(p.pal));
      expect(f.pal, id).not.toBe(p.pal);              // cloned
      expect(f.furniture, id).not.toBe(p.furniture);
    }
  });

  it("defFields applies the look: day / dusk / night / few trees", () => {
    const day = T.defFields("marina", { look: { time: "day" } });
    expect(day.night).toBe(false);
    expect(day.theme).toBe("street_day");
    expect(day.pal).toEqual(plain(T.PRESETS.marina!.dayPal));

    const dusk = T.defFields("parkland", { look: { time: "dusk" } });
    expect(dusk.night).toBe(false);
    expect(dusk.pal.sunDir).toEqual([0.8, 0.16, 0.3]);
    expect(dusk.pal.grass![0]).toBe(0.20 * 0.85);

    const night = T.defFields("parkland", { look: { time: "night" } });
    expect(night.night).toBe(true);
    expect(night.furniture.lamp).toBe("post");
    expect(night.furniture.lc).toEqual([1.0, 0.92, 0.78]);
    expect(T.PRESETS.parkland!.furniture.lamp).toBe("none");   // preset untouched

    expect(T.defFields("parkland", { look: { trees: "few" } }).furniture.sparse).toBe(true);
  });

  it("cityGaps thins long street laps; defFields carries them", () => {
    expect(T.cityGaps(3000, 3600)).toBeNull();
    expect(T.cityGaps(7000, 0)).toBeNull();
    const g = T.cityGaps(7200, 3600)!;
    expect(g.length).toBe(5);
    expect(g[0]).toEqual({ kind: "city", s0: 0.05, s1: 0.15 });
    expect(T.defFields("harbour", { lengthM: 7200 }).dressingExclusions).toEqual(g);
    expect(T.defFields("harbour", { lengthM: 3000 }).dressingExclusions).toBeUndefined();
    // Marina is a night street: no gaps at night, the day city's at day.
    expect(T.defFields("marina", { lengthM: 7200 }).dressingExclusions).toBeUndefined();
    expect(T.defFields("marina", { lengthM: 7200, look: { time: "day" } }).dressingExclusions).toEqual(g);
  });

  it("lapM: stored lengthM, else the control polygon", () => {
    expect(T.lapM(null)).toBe(0);
    expect(T.lapM({ lengthM: 4321 })).toBe(4321);
    expect(T.lapM({ pts: [[0, 0], [3, 4], [3, 0]] })).toBe(12);
  });

  it("sceneryFor returns a function that survives a bad api", () => {
    const fn = T.sceneryFor({ theme: "alpine", seed: 7 });
    expect(typeof fn).toBe("function");
    expect(typeof T.sceneryFor(null)).toBe("function");
    expect(() => fn(asApi({}))).not.toThrow();   // survey fails: generic dressing only
  });

  it("every theme's dressers run against a recording api", () => {
    for (const id of T.ORDER) {
      const calls: string[] = [];
      const api = mockApi(calls);
      const sv = T.survey(api);
      expect(sv.straights.length, id).toBeGreaterThan(0);
      expect(sv.slow.length, id).toBeGreaterThan(0);
      sv.look = T.lookOf({ look: { time: "night", trees: "many", crowd: "packed" } });
      for (const [name, dress] of T.DRESS[id]!) {
        expect(() => dress(api, sv, () => 0.5), id + ":" + name).not.toThrow();
      }
      T.sceneryFor({ theme: id, seed: 3, props: [{ kind: "stand", s: 0.3 }] })(api);
      expect(calls, id).toContain("grandstandEx");
      expect(calls, id).toContain("cameraTower");   // trackside kit
    }
  });
});

describe("TrackDesignerProps", () => {
  it("KINDS / CAPS / sanitize: known kinds only, per-kind and total caps", () => {
    expect(P.KINDS.slice(0, 15).join(",")).toBe("stand,gantry,trees,water,flood,billboard,palms,hedge,pines,bushes,marshal,camera,pond,lake,river");
    expect(P.TOTAL).toBe(16);
    expect(P.KINDS.indexOf("water")).toBe(3);
    expect(P.CAPS.water).toBe(4);
    expect(P.sanitize(null)).toBeNull();
    expect(P.sanitize([])).toBeNull();
    expect(P.sanitize([{ kind: "nope", s: 0.2 }])).toBeNull();
    const one = P.sanitize([{ kind: "stand", s: 0.25, side: -1, gap: 20 }])!;
    expect(plain(one)).toEqual([{ kind: "stand", s: one[0]!.s, side: -1, gap: 20 }]);
    expect(Math.abs(one[0]!.s - 0.25)).toBeLessThan(1e-4);
    const many = [];
    for (let i = 0; i < 10; i++) many.push({ kind: "stand", s: i / 20, side: 1, gap: 18 });
    expect(P.sanitize(many)!.length).toBe(P.CAPS.stand);
    const mix: object[] = [];
    for (const k of P.KINDS) for (let i = 0; i < P.CAPS[k]; i++) mix.push({ kind: k, s: (mix.length + 1) / 40, side: 1 });
    expect(mix.length).toBeGreaterThan(P.TOTAL);
    expect(P.sanitize(mix)!.length).toBe(P.TOTAL);
  });

  it("sanitize repairs s, side and gap", () => {
    const [a, b, c] = P.sanitize([
      { kind: "trees", s: 1.25, side: 0 },
      { kind: "trees", s: -0.25, side: -3, gap: 999 },
      { kind: "trees", s: 0.5, gap: -4 },
    ])!;
    expect(a).toEqual({ kind: "trees", s: Math.round(0.25 * 65535) % 65535 / 65535, side: 1, gap: P.DEFAULT_GAP.trees });
    expect(b!.s).toBe(Math.round(0.75 * 65535) % 65535 / 65535);
    expect(b!.side).toBe(-1);
    expect(b!.gap).toBe(120);
    expect(c!.gap).toBe(0);
    expect(P.sanitize([{ kind: "trees", s: NaN }])).toBeNull();
    expect(P.sanitize([{ kind: "trees", s: 1 }])![0]!.s).toBe(0);
  });

  it("place / removeLast / canPlace respect caps and UNDO-shaped lists", () => {
    let list: P.DesignerProp[] | null = null;
    expect(P.canPlace(list, "stand")).toBe(true);
    list = P.place(list, "stand", { s: 0.1, side: 1 })!;
    expect(list.length).toBe(1);
    const prev = list;
    list = P.place(list, "billboard", { s: 0.4, side: -1, gap: 12 })!;
    expect(list.length).toBe(2);
    expect(prev.length).toBe(1);   // place does not mutate its input
    expect(P.place(list, "nope", { s: 0.5 })).toBeNull();
    let s = 0.2;
    while (P.canPlace(list, "stand")) list = P.place(list, "stand", { s: (s += 0.1) })!;
    expect(P.counts(list).stand).toBe(P.CAPS.stand);
    expect(P.place(list, "stand", { s: 0.9 })).toBeNull();
    const before = list.length;
    list = P.removeLast(list, "stand");
    expect(list.length).toBe(before - 1);
    expect(P.counts(list).stand).toBe(P.CAPS.stand - 1);
    list = P.removeLast(list, null);
    expect(list.length).toBe(before - 2);
    expect(P.removeAt(list, 99)).toEqual(list);
    expect(P.removeAt(null, 0)).toEqual([]);
  });

  it("pointFrac walks the control polygon arc", () => {
    const pts = ellipse(40, 800, 500);
    expect(P.pointFrac(pts, 0)).toBe(0);
    const mid = P.pointFrac(pts, 20);
    expect(mid > 0.4 && mid < 0.6).toBe(true);
    expect(P.pointFrac([], 3)).toBe(0);
  });

  it("batch placement distributes a wrapped range, pairs sides and refuses caps atomically", () => {
    const next = P.placeBatch([], "hedge", { start: 0.9, end: 0.1, count: 3, side: 0, gap: 1 })!;
    expect(next.length).toBe(6);
    for (let i = 0; i < 3; i++) {
      expect(next.slice(i * 2, i * 2 + 2).map((p) => p.side)).toEqual([-1, 1]);
      const expected = [0.9, 0, 0.1][i]!;
      expect(Math.abs(next[i * 2]!.s - expected)).toBeLessThan(1e-4);
      expect(next[i * 2]!.gap).toBe(P.MIN_GAP.hedge);
    }
    const before = JSON.stringify(next);
    expect(P.placeBatch(next, "hedge", { start: 0.5, count: 1 })).toBeNull();
    expect(JSON.stringify(next)).toBe(before);
    expect(P.placeBatch([], "stand", { start: 0, end: 0.5, count: 3, side: 0 })).toBeNull();
    expect(P.placeBatch([], "trees", { start: 0.2, end: 0.2, count: 2 })).toBeNull();
    expect(P.placeBatch([], "trees", { start: 0, end: 0.5, count: 2.5 })).toBeNull();
    expect(P.placeBatch([], "gantry", { start: 0, end: 0.5, count: 2, side: 0 })!.length).toBe(2);
  });

  it("updateAt edits a copy; effectiveGap floors at MIN_GAP", () => {
    const props = P.sanitize([{ kind: "palms", s: 0.25, side: -1, gap: 24 }, { kind: "gantry", s: 0.5, side: -1, gap: 30 }])!;
    const edited = P.updateAt(props, 0, { s: 1.2, side: 1, gap: 1 })!;
    expect(edited[0]!.kind).toBe("palms");
    expect(edited[0]!.gap).toBe(16);
    expect(Math.abs(edited[0]!.s - 0.2)).toBeLessThan(1e-4);
    expect(props[0]!.side).toBe(-1);
    expect(P.updateAt(props, -1, { s: 0.5 })).toBeNull();
    expect(P.updateAt(props, 0, { s: NaN })).toBeNull();
    expect(P.updateAt(props, 0, {})).toBeNull();   // unchanged
    const g = P.updateAt(props, 1, { s: 0.6 })!;
    expect(g[1]).toMatchObject({ side: 1, gap: 0 });
    expect(P.effectiveGap("gantry", 50)).toBe(0);
    expect(P.effectiveGap("stand", 2)).toBe(P.MIN_GAP.stand);
    expect(P.effectiveGap("nope", 2)).toBeNull();
  });

  it("palms and hedges dress through the existing APIs", () => {
    const props = P.sanitize([{ kind: "palms", s: 0.25, side: -1, gap: 24 }, { kind: "hedge", s: 0.5, side: 1, gap: 12 }]);
    const palms: unknown[][] = [], hedges: unknown[][] = [];
    const api = asApi({ K: (f: number) => f * 1000, palm: (...a: unknown[]) => palms.push(a), hedge: (...a: unknown[]) => hedges.push(a) });
    expect(P.dress(api, { n: 1000, total: 5000 }, props)).toBe(2);
    expect(palms.length).toBe(3); expect(hedges.length).toBe(1);
    expect(palms[0]![1]).toBe(-1); expect(palms[0]![2]).toBe(24);
    expect(Math.abs(((hedges[0]![1] as number) - (hedges[0]![0] as number)) * 5000 - 48)).toBeLessThan(1e-8);
  });

  it("new nature and venue objects dress at metre spacing and degrade without APIs", () => {
    const calls: Record<string, unknown[][]> = {};
    const api: Record<string, unknown> = { K: (f: number) => ((f % 1 + 1) % 1) * 1000 };
    for (const name of ["pine", "bush", "marshalPost", "cameraTower"]) api[name] = (...args: unknown[]) => (calls[name] ||= []).push(args);
    const props = (["pines", "bushes", "marshal", "camera"] as const).map((kind) => ({ kind, s: 0, side: -1, gap: P.DEFAULT_GAP[kind] }));
    expect(P.dress(asApi(api), { n: 1000, total: 5000 }, props)).toBe(4);
    expect(calls.pine!.length).toBe(3); expect(calls.bush!.length).toBe(5);
    expect(Math.abs((calls.pine![1]![0] as number) - (calls.pine![2]![0] as number) + 2.8)).toBeLessThan(1e-8);
    expect(Math.abs((calls.bush![3]![0] as number) - (calls.bush![4]![0] as number) + 1.2)).toBeLessThan(1e-8);
    expect(calls.marshalPost![0]![1]).toBe(-1);
    expect((calls.cameraTower![0]![3] as { h: number }).h).toBe(12);
    expect(P.dress(asApi({}), { n: 1000, total: 5000 }, props)).toBe(0);
    for (const kind of P.KINDS) expect(P.DESCRIPTIONS[kind], kind).toBeTruthy();
    for (const kind of P.KINDS) expect(P.LABELS[kind], kind).toBeTruthy();
  });

  it("flood props mast on the authored side; categories cover the terrain and water kinds", () => {
    const masts: unknown[][] = [];
    const api = asApi({ K: () => 5, floodMast: (...a: unknown[]) => masts.push(a) });
    expect(P.dress(api, { n: 1000, total: 5000 }, [{ kind: "flood", s: 0.1, side: -1 }, { kind: "flood", s: 0.2 }])).toBe(2);
    expect(masts.map((m) => m[1])).toEqual([-1, 1]);
    expect(P.CATEGORIES.terrain).toEqual(["mountain", "snowpeak", "hill", "dune", "rocks"]);
    expect(P.CATEGORIES.water).toEqual(["water", "pond", "lake", "river", "lagoon", "canal"]);
  });
});
