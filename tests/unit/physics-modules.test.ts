// T1.5: every physics module port against f1-game's own output, bit for bit.
// tests/goldens/physics-modules.json is written by tools/oracle/modules.mjs,
// which runs f1-game's real modules in a Node VM on seeded random inputs; each
// case here replays the same inputs through the TS port and requires
// Object.is on every number. A failure names the case and the first field.
import { describe, expect, it } from "vitest";
import type { PhysCar } from "../../src/physics/car";
import * as Collide from "../../src/physics/collide";
import * as CG from "../../src/physics/contact-geometry";
import * as GripSteer from "../../src/physics/grip-steer";
import * as PlayerForces from "../../src/physics/player-forces";
import * as SetupAxle from "../../src/physics/setup-axle";
import type { PhysicsTrack } from "../../src/physics/track";
import * as Tyre from "../../src/physics/tyre-model";
import * as WallClamp from "../../src/physics/wall-clamp";
import { firstDiff, readGolden } from "../goldens/decode";
import {
  fakePostLimits,
  fakeSample,
  fakeWallAt,
  fakeWorldFromTrack,
  fakeWrapS,
  makeFakeTrack,
  newSample,
  type FakeTrack,
} from "../goldens/fake-track";

type Rec = Record<string, unknown>;
interface FnCase {
  fn: string;
  args: unknown[];
  out: unknown;
}
interface Golden {
  meta: { f1Sha: string };
  fns: FnCase[];
  tyreStint: {
    G: { raceTyreWear: "real"; track: { total: number; def: { id: string; tyreSeverity: number } }; raceWeather: string; lapsTarget: number; session: string; LAT_MAX: number; aTop: number; vTop: number };
    fit: Tyre.TyreOption;
    steps: { inputs: Rec[]; arc: Rec | null; out: Rec[] }[];
  };
  playerForces: { G: PlayerForces.PlayerForcesTunables; level: number; wear: boolean; carIn: Rec; ctx: Rec; out: Rec }[];
  wallClamp: { which: string; carIn: Rec; ctx: { dt: number; steer: number; soundOn: boolean }; out: Rec; smp: unknown; fx: string[] }[];
  collide: { which: string; PACE: number; carsIn: Rec[]; steps: number; outs: Rec[][]; fx: number }[];
}

const golden = readGolden<Golden>("physics-modules.json");

const tracks: Record<string, FakeTrack> = {
  plain: makeFakeTrack(false, false),
  pit: makeFakeTrack(true, false),
  street: makeFakeTrack(true, true),
};
function physTrack(raw: FakeTrack): PhysicsTrack {
  const wl = {
    total: raw.total,
    n: raw.n,
    hw: raw.hw,
    pit: raw.pit,
    posts: raw.posts,
    wallAt: fakeWallAt,
    postLimits: (s: number, x: number, out: { r: number; l: number; minOut: number; side: number }) => fakePostLimits(raw, s, x, out),
  };
  return {
    length: raw.total,
    street: raw.street,
    sample: (s, out) => fakeSample(s, out),
    banking: () => null,
    onKerb: () => 0,
    inPitLane: () => false,
    wallAt: fakeWallAt,
    wrapS: fakeWrapS,
    wallLimits: (s, x, out, postLim, previous) => CG.wallLimitsOf(wl, s, x, out, postLim, previous),
  };
}
const ptracks: Record<string, PhysicsTrack> = {
  plain: physTrack(tracks["plain"] as FakeTrack),
  pit: physTrack(tracks["pit"] as FakeTrack),
  street: physTrack(tracks["street"] as FakeTrack),
};

const num = (v: unknown): number => v as number;
const FNS: Record<string, (...a: unknown[]) => unknown> = {
  lateralCurve: (x) => Tyre.lateralCurve(num(x)),
  lateralCurveR: (x) => Tyre.lateralCurve(num(x), Tyre.CURVE_FLOOR_R, Tyre.CURVE_FALL_W_R, Tyre.CURVE_HOLD_R),
  tyreSat: (cs, a, mu) => PlayerForces.tyreSat(num(cs), num(a), num(mu)),
  brakeBeta: (p, ru, dt) => Tyre.brakeBeta(p as number | null, ru as number | undefined, num(dt)),
  brakeFront: (b, lf, lr) => Tyre.brakeFront(num(b), num(lf), num(lr)),
  gripFor: (w) => Tyre.gripFor(w as number | undefined),
  longFor: (w) => Tyre.longFor(w as number | undefined),
  deriveLife: (c) => Tyre.deriveLife(c),
  tempGrip: (ts, life) => Tyre.tempGrip(ts as number | null, life as number | null),
  optTemp: (life) => Tyre.optTemp(life as number | null),
  coolFor: (life) => Tyre.coolFor(life as number | null),
  warmRate: (life) => Tyre.warmRate(life as number | null),
  defectGrip: (g, b) => Tyre.defectGrip(num(g), num(b)),
  weatherGrip: (t, w) => Tyre.weatherGrip(t, num(w)),
  aquaplane: (s, w, t) => Tyre.aquaplane(num(s), num(w), t),
  aquaplaneSafeV: (w, t) => Tyre.aquaplaneSafeV(num(w), t),
  stepTemp: (ts, tb, load, vF, amb, trk, life, sl) =>
    Tyre.stepTemp(num(ts), num(tb), { load: num(load), vFrac: num(vF), amb: num(amb), track: trk as number | null, life: life as number | null, slide: num(sl), dt: 1 / 60 }),
  humanLoad: (c, l) => Tyre.humanLoad(c as Tyre.TyreCar, num(l)),
  aiLoad: (c, a) => Tyre.aiLoad(c as Tyre.TyreCar, num(a)),
  longSigned: (c, a) => Tyre.longSigned(c as Tyre.TyreCar, num(a)),
  axleShare: (c, a) => Tyre.axleShare(c as Tyre.TyreCar, num(a)),
  fuelFrac: (c, l) => Tyre.fuelFrac(c as Tyre.TyreCar, num(l)),
  axleGrip: (b, l, f) => ({ ...SetupAxle.axleGrip(b as number, num(l), f == null ? undefined : num(f)) }),
  bbScales: (b) => SetupAxle.bbScales(b as number | null),
  gripSteerApply: (dd, st, k) => ({ ...GripSteer.apply(num(dd), { ...(st as Rec) } as Partial<GripSteer.GripSteerState>, num(k)) }),
  overlap: (dx, dy, a, b) => {
    const o = CG.overlap(num(dx), num(dy), num(a), num(b), {});
    return o ? { depth: o.depth, nx: o.nx, ny: o.ny } : null;
  },
  sweep: (x0, y0, x1, y1, a, b) => {
    const o = CG.sweep(num(x0), num(y0), num(x1), num(y1), num(a), num(b), {});
    return o ? { time: o.time, nx: o.nx, ny: o.ny, depth: o.depth } : null;
  },
  impulse: (A, B, dx, dy, ct) => ({
    ...CG.impulse(A as CG.ContactBody, B as CG.ContactBody, num(dx), num(dy), ct as { nx: number; ny: number }, {}),
  }),
  wallLimits: (which, s, x, prev) => {
    const out = { r: 0, l: 0, laneMin: 0, side: 0 };
    (ptracks[which as string] as PhysicsTrack).wallLimits(num(s), num(x), out, { r: 0, l: 0, minOut: 0, side: 0 }, prev as { s: number; x: number } | null);
    return out;
  },
};

describe(`physics modules vs f1-game ${golden.meta.f1Sha.slice(0, 9)}`, () => {
  const byFn = new Map<string, FnCase[]>();
  for (const c of golden.fns) byFn.set(c.fn, [...(byFn.get(c.fn) ?? []), c]);
  for (const [name, cases] of byFn) {
    it(`${name}: ${cases.length} cases bit-exact`, () => {
      const f = FNS[name];
      expect(f, `no port mapping for ${name}`).toBeDefined();
      cases.forEach((c, i) => {
        const d = firstDiff((f as (...a: unknown[]) => unknown)(...structuredClone(c.args)), c.out);
        expect(d, `${name}[${i}] args=${JSON.stringify(c.args)}`).toBeNull();
      });
    });
  }

  it(`TyreModel instance: ${golden.tyreStint.steps.length}-step stint bit-exact (wear real, dry→rain arc)`, () => {
    const g = golden.tyreStint.G;
    const ctx = {
      raceTyreWear: g.raceTyreWear,
      track: { length: g.track.total, def: g.track.def },
      weatherArc: null as Tyre.TyreCtx["weatherArc"],
      raceWeather: g.raceWeather,
      lapsTarget: g.lapsTarget,
      session: g.session,
      LAT_MAX: g.LAT_MAX,
      aTop: () => g.aTop,
      vTop: () => g.vTop,
    };
    const tyres = Tyre.create(ctx);
    const cars: Tyre.TyreCar[] = [
      { human: true, speed: 0, yawRateCur: 0, lap: 1, prog: 0, s: 0, tread: 0 },
      { human: false, speed: 0, consistency: 0.6, lap: 1, prog: 0, s: 0, tread: null, tyreClass: "soft" },
    ];
    tyres.fit(cars[0], Tyre.optionRecord(golden.tyreStint.fit));
    golden.tyreStint.steps.forEach((row, i) => {
      ctx.weatherArc = row.arc as Tyre.TyreCtx["weatherArc"];
      row.inputs.forEach((inp, k) => Object.assign(cars[k] as Tyre.TyreCar, inp));
      cars.forEach((c, k) => {
        tyres.update(c, 1 / 60);
        const ax = tyres.axleSplit(c);
        const got = {
          tyreWear: c.tyreWear,
          tyreWearF: c.tyreWearF,
          tyreWearR: c.tyreWearR,
          tyreTs: c.tyreTs,
          tyreTb: c.tyreTb,
          tyreGrain: c.tyreGrain,
          tyreBlister: c.tyreBlister,
          load: c._tyreLoad,
          grip: tyres.gripMul(c),
          traction: tyres.tractionMul(c),
          axF: ax.f,
          axR: ax.r,
          fuelA: tyres.fuelAccelMul(c),
          fuelV: tyres.fuelVmaxMul(c),
          lapsOn: tyres.lapsOn(c),
          lapsLeft: tyres.lapsLeft(c),
          ambient: tyres.ambient(),
          trackTemp: tyres.trackTemp(),
        };
        expect(firstDiff(got, row.out[k]), `step ${i} car ${k}`).toBeNull();
      });
    });
  });

  it(`PlayerForces.step: ${golden.playerForces.length} random cars/contexts bit-exact`, () => {
    const wearCtx: Tyre.TyreCtx = {
      raceTyreWear: "real",
      track: { length: 5793, def: {} },
      weatherArc: null,
      raceWeather: "dry",
      lapsTarget: 10,
      session: "race",
      LAT_MAX: 22,
      aTop: () => 7.3,
      vTop: () => 75.2,
    };
    golden.playerForces.forEach((tc, i) => {
      const gs = GripSteer.create();
      gs.setLevel(tc.level);
      const pf = PlayerForces.create(tc.G, { gripSteer: gs });
      const tyres = Tyre.create(tc.wear ? wearCtx : { ...wearCtx, raceTyreWear: "off" });
      const car = structuredClone(tc.carIn) as unknown as PhysCar;
      pf.step(car, { ...(tc.ctx as unknown as PlayerForces.PlayerForcesCtx), tyres });
      const got = Object.fromEntries(Object.keys(tc.out).map((k) => [k, (car as unknown as Rec)[k]]));
      expect(firstDiff(got, tc.out), `case ${i}`).toBeNull();
    });
  });

  it(`WallClamp.apply: ${golden.wallClamp.length} random contacts bit-exact (pit wall, posts, end faces)`, () => {
    golden.wallClamp.forEach((tc, i) => {
      const car = structuredClone(tc.carIn) as unknown as PhysCar;
      const smp = newSample();
      const wf = { x: 0, z: 0 };
      const fx: string[] = [];
      WallClamp.apply(car, {
        track: ptracks[tc.which] as PhysicsTrack,
        dt: tc.ctx.dt,
        steer: tc.ctx.steer,
        postLim: { r: 0, l: 0, minOut: 0, side: 0 },
        smp,
        wrapS: fakeWrapS,
        worldFromTrack: (s, x, out) => fakeWorldFromTrack(s, x, out, wf),
        soundOn: tc.ctx.soundOn,
        addShake: () => fx.push("shake"),
        audio: { collision: () => fx.push("collision"), fieldContact: () => fx.push("fieldContact") },
        haptics: { rumble: () => fx.push("rumble"), vibrate: () => fx.push("vibrate") },
        teamIds: ["redbull", "mclaren", "ferrari"],
      });
      const got = Object.fromEntries(Object.keys(tc.out).map((k) => [k, (car as unknown as Rec)[k]]));
      expect(firstDiff(got, tc.out), `case ${i}`).toBeNull();
      expect(firstDiff(smp, tc.smp), `case ${i} smp`).toBeNull();
      expect(fx, `case ${i} fx`).toEqual(tc.fx);
    });
  });

  it(`Collide.resolveCollisions: ${golden.collide.length} packed fields bit-exact`, () => {
    golden.collide.forEach((tc, i) => {
      const cars = structuredClone(tc.carsIn) as unknown as PhysCar[];
      const track = ptracks[tc.which] as PhysicsTrack;
      const wf = { x: 0, z: 0 };
      const G = {
        wrapS: fakeWrapS,
        track,
        player: cars.find((c) => c.isPlayer) ?? null,
        netPlay: { owns: () => false },
        raceT: 0,
        PACE: tc.PACE,
        worldFromTrack: (s: number, x: number) => fakeWorldFromTrack(s, x, newSample(), wf),
      };
      let fx = 0;
      const col = Collide.create(G, () => fx++);
      for (let st = 0; st < tc.steps; st++) {
        G.raceT = st / 60;
        if (st > 0)
          for (const c of cars) {
            c.s = fakeWrapS(c.s + c.speed / 60);
            c.prog += c.speed / 60;
          }
        col.resolveCollisions(cars, 1 / 60);
        const want = tc.outs[st] as Rec[];
        const got = cars.map((c) => Object.fromEntries(Object.keys(want[0] as Rec).map((k) => [k, (c as unknown as Rec)[k]])));
        expect(firstDiff(got, want), `case ${i} step ${st}`).toBeNull();
      }
      expect(fx, `case ${i} fx count`).toBe(tc.fx);
    });
  });
});
