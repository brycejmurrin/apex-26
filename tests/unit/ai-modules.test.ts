// The AI module ports (src/sim/ai/) against f1-game's own output, bit for bit.
// tests/goldens/ai-modules.json.gz is written by tools/oracle/ai-modules.mjs,
// which runs f1-game's real ai-drive / ai-band / ai-corridor in a Node VM on
// seeded random inputs; every case is replayed here with Object.is.
import { describe, expect, it } from "vitest";
import * as AiBand from "../../src/sim/ai/ai-band";
import * as AiCorridor from "../../src/sim/ai/ai-corridor";
import * as A from "../../src/sim/ai/ai-drive";
import { firstDiff, readGolden } from "../goldens/decode";

interface FnCase {
  fn: string;
  args: unknown[];
  out: unknown;
}
const golden = readGolden<{ meta: { f1Sha: string }; fns: FnCase[]; strat: unknown }>("ai-modules.json.gz");

type F = (...a: never[]) => unknown;
const call = (f: F, args: unknown[]): unknown => (f as unknown as (...a: unknown[]) => unknown)(...args);
/** JSON turned `undefined` args into null; these positions are optional in f1-game and must read undefined. */
const und = (v: unknown): unknown => (v === null ? undefined : v);

const FNS: Record<string, (args: unknown[]) => unknown> = {
  traits: ([c]) => ({ ...A.traits(c as A.RatedCar) }),
  houseStyle: ([t, s, st]) => ({ ...call(A.houseStyle, [t, und(s), st]) as object }),
  ordersMul: (a) => call(A.ordersMul, [a[0], und(a[1]), a[2], a[3]]),
  followGap: (a) => call(A.followGap, [a[0], a[1], a[2], a[3], a[4], und(a[5]), a[6], a[7], a[8]]),
  towGain: (a) => call(A.towGain, [a[0], und(a[1])]),
  passHunger: (a) => call(A.passHunger, a),
  coverConcede: (a) => call(A.coverConcede, a),
  queueBrake: (a) => call(A.queueBrake, a),
  queueReach: (a) => call(A.queueReach, a),
  defendOnce: (a) => ({ ...A.defendOnce(a[0] as number, a[1] as number, { defend: 0, side: 0 }) }),
  contactGive: (a) => call(A.contactGive, a),
  otFireRate: (a) => call(A.otFireRate, a),
  wantBoost: (a) => call(A.wantBoost, a),
  wantX: ([c]) => {
    const x = { ...(c as Record<string, unknown>) };
    if (x["armed"] === null) delete x["armed"];
    if (x["seat"] === null) delete x["seat"];
    return A.wantX(x as A.WantXCtx);
  },
  lateralScale: (a) => call(A.lateralScale, a),
  yawScale: (a) => call(A.yawScale, a),
  cornerSpeed: (a) => call(A.cornerSpeed, a),
  brakeDecision: ([ctx, samples]) => {
    A.beginLook();
    for (const s of samples as unknown[][]) A.pushLook(s[0] as number, s[1] as number, s[2] as number, und(s[3]) as number | undefined);
    const c = { ...(ctx as Record<string, unknown>) };
    if (c["errMul"] === null) delete c["errMul"];
    if (c["seat"] === null) delete c["seat"];
    return { ...A.brakeDecision({ ...(c as unknown as A.BrakeCtx), samples: A.endLook() }) };
  },
  adaptLane: (a) => call(A.adaptLane, a),
  otPull: (a) => call(A.otPull, a),
  otWant: (a) => call(A.otWant, a),
  latchLate: (a) => call(A.latchLate, a),
  attackOK: (a) => call(A.attackOK, a),
  passReach: (a) => call(A.passReach, a),
  otSide: (a) => call(A.otSide, a),
  passSideBonus: (a) => call(A.passSideBonus, a),
  launchPlan: (a) => call(A.launchPlan, a),
  launchMul: (a) => call(A.launchMul, a),
  launchDone: (a) => call(A.launchDone, a),
  startCalm: (a) => call(A.startCalm, [a[0], und(a[1]), a[2]]),
  pacePhase: (a) => call(A.pacePhase, a),
  passTarget: (a) => call(A.passTarget, a),
  passSideClosed: (a) => call(A.passSideClosed, a),
  passHold: (a) => call(A.passHold, a),
  repassLock: (a) => call(A.repassLock, a),
  attemptRoll: (a) => call(A.attemptRoll, a),
  runExtra: (a) => call(A.runExtra, a),
  cornerK: (a) => call(A.cornerK, a),
  sbsCommitT: (a) => call(A.sbsCommitT, a),
  sbsEase: (a) => call(A.sbsEase, a),
  queueTime: (a) => call(A.queueTime, [und(a[0]), a[1], a[2]]),
  mistakeChance: (a) => call(A.mistakeChance, a),
  mistakePhase: (a) => call(A.mistakePhase, [und(a[0])]),
  tyreClass: (a) => call(A.tyreClass, a),
  tyrePace: (a) => call(A.tyrePace, a),
  humanYieldT: (a) => call(A.humanYieldT, a),
  aimIntrudes: (a) => call(A.aimIntrudes, a),
  mirrorReach: (a) => call(A.mirrorReach, a),
  defendPull: (a) => call(A.defendPull, a),
  isBoxed: (a) => call(A.isBoxed, a),
  digOutEscalated: (a) => call(A.digOutEscalated, a),
  letPassCase: (a) => call(A.letPassCase, a),
  minLatGap: (a) => call(A.minLatGap, a),
  lineFollow: (a) => call(A.lineFollow, a),
  bandFactor: (a) => call(AiBand.factor, a),
  bandApply: (a) => call(AiBand.applyVmax, a),
  stintPlan: ([sp]) => {
    const { life, ...rest } = sp as A.StintPlanCtx & { life?: Record<string, number> };
    return { ...A.stintPlan(life ? { ...rest, lifeLaps: (cls) => life[cls] as number } : rest) };
  },
  splitStints: (a) => call(A.splitStints, [a[0], a[1], und(a[2])]),
  degCost: (a) => call(A.degCost, a),
  compoundFor: ([left, t]) => A.compoundFor(left as number, (cls) => (t as Record<string, number>)[cls] as number),
  strategyTemper: ([c]) => ({ ...A.strategyTemper(c as A.RatedCar) }),
  tasteRoll: (a) => call(A.tasteRoll, a),
  wornPays: (a) => call(A.wornPays, a),
  pitNow: (a) => call(A.pitNow, a),
  corridor: ([ctx, cars, clear]) => {
    const cs = cars as AiCorridor.CorridorCar[];
    return AiCorridor.choose(ctx as AiCorridor.CorridorCtx, cs[0] as AiCorridor.CorridorCar, cs[1] as AiCorridor.CorridorCar, cs, 5793, clear as number);
  },
};
describe(`AI modules vs f1-game ${golden.meta.f1Sha.slice(0, 9)}`, () => {
  const byFn = new Map<string, FnCase[]>();
  for (const c of golden.fns) byFn.set(c.fn, [...(byFn.get(c.fn) ?? []), c]);
  for (const [name, cases] of byFn) {
    if (name === "paceSample") continue; // its vmax/free/dt inputs are not recorded; covered by the race goldens
    it(`${name}: ${cases.length} cases bit-exact`, () => {
      const f = FNS[name];
      expect(f, `no port mapping for ${name}`).toBeDefined();
      cases.forEach((c, i) => {
        const got = (f as (a: unknown[]) => unknown)(structuredClone(c.args));
        const d = firstDiff(got === undefined ? null : got, c.out);
        expect(d, `${name}[${i}] args=${JSON.stringify(c.args).slice(0, 400)}`).toBeNull();
      });
    });
  }
  it("STRAT constants match", () => {
    expect(firstDiff(structuredClone(A.STRAT), golden.strat)).toBeNull();
  });
});
