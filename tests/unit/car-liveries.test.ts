import type vm from "node:vm";
import { describe, expect, it } from "vitest";
import { BY_TEAM, FIELDS, Liveries, UNIVERSAL, forTeam, migratePaint } from "../../src/car/liveries";
import type { Livery, LiveryField, LiveryTeam, Rgb } from "../../src/car/liveries";
import { CustomLiveries, create } from "../../src/car/custom-liveries";
import type { CareerIdentity, CustomLiveriesApi, LiveryStore, PaintJob } from "../../src/car/custom-liveries";
import { DEFAULT_CUSTOM, LIST } from "../../src/car/teams";
import { haveF1, inF1, loadF1, plain } from "./car-f1-vm";

// Compile-time: every LiveryField, exactly once (a missing or extra key fails tsc).
const ALL_FIELDS: Record<LiveryField, true> = {
  stripe: true, noseStripe: true, accent: true, nose: true, pod: true, wing: true, fin: true, finArt: true,
  logo: true, logo2: true, logo3: true, halo: true, finish: true, numFont: true, sponsors: true, finStyle: true,
  finBadge: true, spineLogo: true, finShape: true, tcam: true, coverVents: true, spineHeight: true, spineSide: true,
  cover: true, spineTint: true, sideTint: true, sunTint: true, bandTint2: true, plateTint: true, saddleTint: true,
  coverBind: true, finHandoff: true, rearWing: true, wingCarbon: true, bodySplit: true, lower: true, upper: true,
  patternTint: true, patternSecond: true, patternPlacement: true, patternSide: true, patternWidth: true,
  patternRepeat: true, patternOffset: true, patternTaper: true, patternOpacity: true, patternRotation: true,
  patternStretch: true, patternWeight: true, coverFinish: true, wingFinish: true, haloFinish: true,
  mirrorTint: true, rimTint: true, caliperTint: true, sidewallInk: true, helmetBase: true, helmetAccent: true,
  podFinish: true, finFinish: true, mirrorFinish: true, helmetStyle: true,
};

const CARBON: Rgb = [0.055, 0.056, 0.062]; // f1-game js/car/car-materials.js:34

/** f1-game's store contract in miniature: get/set by short key, `rev` bumps on set. */
interface MemStore extends Omit<LiveryStore, "rev"> { m: Map<string, unknown>; rev: number }
function memStore(): MemStore {
  const m = new Map<string, unknown>();
  return {
    m, rev: 0,
    get<T>(k: string, d: T): T { return m.has(k) ? (structuredClone(m.get(k)) as T) : d; },
    set(k: string, v: unknown): boolean { m.set(k, structuredClone(v)); this.rev++; return true; },
  };
}

/** A Career stub; `on` / `flavour` steer identityOwner's branches. */
function careerStub(on: boolean, flavour: string): CareerIdentity & { m: Map<string, unknown>; rev: number } {
  const m = new Map<string, unknown>();
  return {
    m, rev: 0,
    inCareer: () => on,
    data: () => ({ flavour }),
    identityValue<T>(k: string, d: T): T { return m.has(k) ? (structuredClone(m.get(k)) as T) : d; },
    setIdentityValue(k: string, v: unknown): boolean { m.set(k, structuredClone(v)); this.rev++; return true; },
    identityRevision() { return this.rev; },
  };
}

const MY_TEAM: LiveryTeam = { ...plain(DEFAULT_CUSTOM) };
const TEAMS: LiveryTeam[] = [
  ...LIST, MY_TEAM,
  { id: "nolivery", color: [0.1, 0.2, 0.3], color2: [0.4, 0.5, 0.6] },
  { id: "mercedes", color: [0, 0, 0], color2: [1, 1, 1], livery: {} },
];

function migrateInputs(): unknown[] {
  return [
    null, undefined, 0, "x", [], {},
    { ridgeTint: [0.1, 0.2, 0.3] },
    { ridgeTint: [0.1, 0.2, 0.3], spineTint: [0.9, 0.9, 0.9] },
    { ridgeTint: null, airboxTint: [1, 0, 0], crestInk: [0, 1, 0], plateInk: [0, 0, 1], cover: [0.5, 0.5, 0.5] },
    { ridgeTint: 0, airboxTint: "", crestInk: false, plateInk: 0 },
    ...UNIVERSAL.slice(0, 5).map((l) => ({ ...plain(l), ridgeTint: [0.2, 0.2, 0.2], airboxTint: [0.3, 0.3, 0.3] })),
  ];
}

describe("liveries: catalog", () => {
  it("lists every paint field exactly once", () => {
    expect(new Set(FIELDS).size).toBe(FIELDS.length);
    expect([...FIELDS].sort()).toEqual(Object.keys(ALL_FIELDS).sort());
  });

  it("has unique ids across the catalog, keyed by real team ids", () => {
    const ids = [...UNIVERSAL, ...Object.values(BY_TEAM).flat()].map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("default");
    const teamIds = new Set(LIST.map((t) => t.id));
    for (const k of Object.keys(BY_TEAM)) expect(teamIds.has(k), k).toBe(true);
    for (const l of [...UNIVERSAL, ...Object.values(BY_TEAM).flat()]) {
      for (const c of [l.c1, l.c2]) expect(c, l.id).toHaveLength(3);
    }
  });

  it("forTeam synthesizes the team default first, then specials, universal, legends", () => {
    const fer = LIST.find((t) => t.id === "ferrari")!;
    const list = forTeam(fer);
    expect(list[0]).toMatchObject({ id: "default", name: "Team Livery", c1: fer.color, c2: fer.color2, finShape: "stepped" });
    expect(list.length).toBe(1 + (BY_TEAM["ferrari"]?.length ?? 0) + UNIVERSAL.length);
    const legend: Livery = { id: "leg_x", name: "Legend", c1: [1, 1, 1], c2: [0, 0, 0] };
    expect(forTeam(fer, { Legends: { liveries: () => [legend] } }).at(-1)).toBe(legend);
    expect(forTeam(fer, { Legends: {} })).toHaveLength(list.length);
  });

  it("migratePaint folds ridge into the band and drops the retired keys", () => {
    expect(migratePaint({ ridgeTint: [1, 0, 0] })).toEqual({ spineTint: [1, 0, 0] });
    expect(migratePaint({ ridgeTint: [1, 0, 0], spineTint: [0, 1, 0], airboxTint: [0, 0, 1] })).toEqual({ spineTint: [0, 1, 0] });
    expect(migratePaint(null)).toBe(null);
  });

  it("freezes the Liveries record with f1-game's members", () => {
    expect(Object.isFrozen(Liveries)).toBe(true);
    expect(Object.keys(Liveries)).toEqual(["UNIVERSAL", "BY_TEAM", "FIELDS", "forTeam", "migratePaint"]);
    expect(Object.isFrozen(CustomLiveries)).toBe(true);
  });
});

describe("custom liveries", () => {
  it("persists the chosen id and the player's own paint jobs through the store", () => {
    const store = memStore();
    const cl = create({ store });
    const mer = LIST[0]!;
    expect(cl.getLiveryId("mercedes")).toBe("default");
    const mine: Livery = { id: "mine", name: "Mine", c1: [0.1, 0.1, 0.1], c2: [0.9, 0.9, 0.9], stripe: [1, 0, 0] };
    cl.setCustomLiveries("mercedes", [mine]);
    expect(cl.getLiveries(mer).at(-1)).toEqual(mine);
    cl.saveLiveryId("mercedes", "mine");
    expect(store.m.get("livery.mercedes")).toBe("mine");
    expect(cl.resolveLivery(mer)).toMatchObject({ id: "mine", c1: mine.c1, stripe: [1, 0, 0], accent: null });
  });

  it("memoizes per store.rev and falls back to the team default for a dangling id", () => {
    const store = memStore();
    const cl = create({ store });
    const fer = LIST[1]!;
    const a = cl.resolveLivery(fer);
    expect(cl.resolveLivery(fer)).toBe(a);
    cl.saveLiveryId("ferrari", "gone");
    const b = cl.resolveLivery(fer);
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
    expect(b.id).toBe("default");
  });

  it("lets the creator draft override one team", () => {
    const cl = create({ store: memStore() });
    const draft: PaintJob = { c1: [0, 0, 1], c2: [1, 1, 0], ridgeTint: [0.5, 0.5, 0.5] } as PaintJob;
    cl.livDraftOverride = { teamId: "haas", liv: draft };
    expect(cl.resolveLivery(LIST[6]!)).toMatchObject({ id: null, c1: [0, 0, 1], spineTint: [0.5, 0.5, 0.5] });
    expect("ridgeTint" in draft).toBe(true); // migrateLivery copies, never mutates the draft
  });

  it("wingColorOf follows Car3D's wing chain", () => {
    const cl = create({ store: memStore(), CarMaterials: { CARBON } });
    const rb = LIST.find((t) => t.id === "racingbulls")!;
    expect(cl.wingColorOf(rb)).toBe(CARBON);
    const fer = LIST.find((t) => t.id === "ferrari")!;
    expect(cl.wingColorOf(fer)).toEqual([0.06, 0.06, 0.07]);
    expect(() => create({ store: memStore() }).wingColorOf(rb)).toThrow(ReferenceError);
  });

  it("routes MY TEAM through a My Team career's identity, and only then", () => {
    const store = memStore();
    const career = careerStub(true, "myteam");
    const cl = create({ store, Career: career });
    cl.saveLiveryId("custom", "stealth");
    expect(career.m.get("livery.custom")).toBe("stealth");
    expect(store.m.size).toBe(0);
    expect(cl.resolveLivery(MY_TEAM).id).toBe("stealth");
    cl.saveLiveryId("mercedes", "mer_black");
    expect(store.m.get("livery.mercedes")).toBe("mer_black");
    const driverCareer = create({ store: memStore(), Career: careerStub(true, "driver") });
    driverCareer.saveLiveryId("custom", "x");
    expect(driverCareer.getLiveryId("custom")).toBe("x");
  });
});

// ---- Round trip against f1-game, loaded in a VM. Skipped where it is absent. ----

type F1Liveries = typeof Liveries;
const LIV_FILES = ["js/data/teams.js", "js/car/liveries.js"];

describe.skipIf(!haveF1)("liveries round trip vs f1-game", () => {
  const ctx = haveF1 ? loadF1(LIV_FILES) : null;
  const f1 = (): F1Liveries => inF1<{ Liveries: F1Liveries }>(ctx!, "({ Liveries })").Liveries;

  it("exports the same members", () => {
    expect(Object.keys(Liveries)).toEqual(Object.keys(f1()));
  });

  it("deep-equals UNIVERSAL, BY_TEAM and FIELDS", () => {
    expect(UNIVERSAL).toEqual(plain(f1().UNIVERSAL));
    expect(BY_TEAM).toEqual(plain(f1().BY_TEAM));
    expect([...FIELDS]).toEqual(plain(f1().FIELDS));
    expect(JSON.stringify(UNIVERSAL)).toBe(JSON.stringify(f1().UNIVERSAL));
    expect(JSON.stringify(BY_TEAM)).toBe(JSON.stringify(f1().BY_TEAM));
  });

  it("forTeam agrees for every team, without Legends", () => {
    for (const t of TEAMS) expect(JSON.stringify(forTeam(t)), t.id).toBe(JSON.stringify(f1().forTeam(t)));
  });

  it("forTeam agrees with a Legends global", () => {
    const legends: Livery[] = [{ id: "leg_senna", name: "Senna", c1: [0.9, 0.9, 0.9], c2: [0.9, 0.1, 0.1], stripe: [1, 1, 0] }];
    for (const Legends of [{ liveries: () => legends }, {}]) {
      const c = loadF1(LIV_FILES, { Legends });
      const theirs = inF1<{ Liveries: F1Liveries }>(c, "({ Liveries })").Liveries;
      for (const t of TEAMS) expect(JSON.stringify(forTeam(t, { Legends })), t.id).toBe(JSON.stringify(theirs.forTeam(t)));
    }
  });

  it("migratePaint agrees, result and mutation", () => {
    const ins = migrateInputs();
    const outs = migrateInputs();
    for (let i = 0; i < ins.length; i++) {
      const a = ins[i], b = outs[i];
      expect(JSON.stringify(migratePaint(a)), JSON.stringify(a)).toBe(JSON.stringify(f1().migratePaint(b)));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

const CL_FILES = [...LIV_FILES, "js/car/custom-liveries.js"];

/** Run `script` against both implementations and compare every recorded step. */
function bothWays(script: (cl: CustomLiveriesApi, log: (v: unknown) => void) => void,
  opts: { career?: () => CareerIdentity; carbon?: boolean } = {}): void {
  const run = (cl: CustomLiveriesApi): string[] => {
    const out: string[] = [];
    script(cl, (v) => out.push(v === undefined ? "undefined" : JSON.stringify(v)));
    return out;
  };
  const ourCareer = opts.career?.(), theirCareer = opts.career?.();
  const ours = run(create({
    store: memStore(),
    ...(ourCareer ? { Career: ourCareer } : {}),
    ...(opts.carbon ? { CarMaterials: { CARBON } } : {}),
  }));
  const g: Record<string, unknown> = {};
  if (theirCareer) g["Career"] = theirCareer;
  if (opts.carbon) g["CarMaterials"] = { CARBON };
  const c: vm.Context = loadF1(CL_FILES, g);
  const F1CL = inF1<{ CustomLiveries: typeof CustomLiveries }>(c, "({ CustomLiveries })").CustomLiveries;
  const theirs = run(F1CL.create({ store: memStore() }));
  expect(ours).toEqual(theirs);
}

function exercise(cl: CustomLiveriesApi, log: (v: unknown) => void): void {
  for (const t of TEAMS) {
    log(cl.getLiveryId(t.id));
    log(cl.getCustomLiveries(t.id));
    log(cl.getLiveries(t));
    log(cl.resolveLivery(t));
    log(cl.wingColorOf(t));
  }
  for (const t of TEAMS) {
    const list = cl.getLiveries(t);
    for (const id of [list[1]?.id ?? "x", "stealth", "mirrorlake", "gone", "default"]) {
      log(cl.saveLiveryId(t.id, id));
      log(cl.getLiveryId(t.id));
      log(cl.resolveLivery(t));
      log(cl.wingColorOf(t));
    }
  }
  const mine: Livery[] = [
    { id: "mine1", name: "Mine", c1: [0.1, 0.1, 0.1], c2: [0.9, 0.9, 0.9], stripe: [1, 0, 0] },
    { id: "mine2", name: "Old file", c1: [0.2, 0.2, 0.2], c2: [0.3, 0.3, 0.3], wingCarbon: "carbon",
      ...({ ridgeTint: [0.4, 0.4, 0.4], airboxTint: [0.5, 0.5, 0.5], crestInk: [1, 1, 1] } as object) },
  ];
  for (const t of [LIST[0]!, MY_TEAM]) {
    log(cl.setCustomLiveries(t.id, mine));
    for (const id of ["mine1", "mine2"]) {
      log(cl.saveLiveryId(t.id, id));
      log(cl.resolveLivery(t));
      log(cl.wingColorOf(t));
    }
  }
  const draft = { c1: [0, 0, 1], c2: [1, 1, 0], wing: [0.3, 0.2, 0.1], ridgeTint: [0.5, 0.5, 0.5], bogus: 1 } as PaintJob;
  cl.livDraftOverride = { teamId: "haas", liv: draft };
  log(cl.livDraftOverride);
  for (const t of TEAMS) { log(cl.resolveLivery(t)); log(cl.wingColorOf(t)); }
  cl.livDraftOverride = null;
  log(cl.resolveLivery(LIST[6]!));
  log(cl.pickLivery({ c1: [1, 0, 0], c2: [0, 1, 0], stripe: [0, 0, 0], finish: "", pod: [1, 1, 1] }));
  log(cl.migrateLivery({ ridgeTint: [1, 1, 1], plateInk: [0, 0, 0], c1: [0, 0, 0] }));
}

describe.skipIf(!haveF1)("custom liveries round trip vs f1-game", () => {
  it("agrees outside a career", () => bothWays(exercise, { carbon: true }));
  it("agrees in a My Team career", () => bothWays(exercise, { carbon: true, career: () => careerStub(true, "myteam") }));
  it("agrees in a driver career and with the career off", () => {
    bothWays(exercise, { carbon: true, career: () => careerStub(true, "driver") });
    bothWays(exercise, { carbon: true, career: () => careerStub(false, "myteam") });
  });
  it("agrees with a partial Career (no inCareer / no data)", () => {
    bothWays(exercise, { carbon: true, career: () => { const c = careerStub(true, "myteam"); delete c.inCareer; return c; } });
    bothWays(exercise, { carbon: true, career: () => { const c = careerStub(true, "myteam"); delete c.data; return c; } });
  });
  it("memoizes the same way", () => {
    bothWays((cl, log) => {
      const t = LIST[2]!;
      const a = cl.resolveLivery(t);
      log(cl.resolveLivery(t) === a);
      cl.saveLiveryId("ferrari", "fer_x");
      log(cl.resolveLivery(t) === a);
    });
  });
});
