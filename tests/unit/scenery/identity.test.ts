import { describe, expect, it } from "vitest";
import type { SceneryApi } from "../../../src/contracts/scenery";
import * as Identity from "../../../src/track/scenery/identity";
import * as Structures from "../../../src/track/scenery/structures";
import { createF1Vm, diffDigests, haveF1 } from "./f1vm";

// Compile-time: every kit member stays assignable to its SceneryApi signature.
type ApiPart = Pick<SceneryApi, keyof Identity.IdentityApi & keyof SceneryApi>;
export const apiCheck = (a: Identity.IdentityApi): ApiPart => a;

// The identity helpers are opt-in per circuit (grep js/circuits/scenery):
// floodMast/Ring (bahrain, qatar, abudhabi, albert_park, jeddah), ledFacadeBands
// (bahrain, miami), sailCanopy (abudhabi), concreteCanyon (jeddah), runoffApron
// and bankedKerbStrip (miami, zandvoort, qatar), bowlSeatWall (zandvoort,
// albert_park), pastelStreetRow (monaco), broadcastCompound (bahrain, monaco).
const CIRCUITS = ["bahrain", "qatar", "abudhabi", "jeddah", "miami", "zandvoort", "albert_park", "monaco"];

/** Helpers no circuit calls (underpassPortal, gridshellCanopy) and unused option branches. */
const sweep = (api: SceneryApi): void => {
  const { K } = api;
  api.underpassPortal(0.31, { h: 6, depth: 10 });
  api.underpassPortal(0.62);
  const f = api.frameAt(0.5);
  const at = (side: number, d: number) => api.vadd(f.c, f.r, side * (f.hw + d));
  api.gridshellCanopy(at(1, 60), [f.r, f.u, f.t], { rows: 3, cols: 4 });
  api.gridshellCanopy(at(-1, 70), [f.r, f.u, f.t]);
  api.sailCanopy(at(1, 40), [f.r, f.u, f.t], { ribs: 5, rx: 9 });
  api.ledFacadeBands(at(-1, 45), 30, { bands: 6, basis: [f.r, f.u, f.t] });
  api.concreteCanyon(0.7, 0.74, 1, 8, { stripeCol: [0.1, 0.6, 0.2], stripeEvery: 3 });
  api.floodMast(K(0.2), 1, 20, { cool: false, arms: 3, pool: false });
  api.floodMast(K(0.22), -1, 20, { light: false, arms: 1 });
  api.runoffApron(K(0.8), 1, 3, 12, [0.3, 0.4, 0.6]);
  api.runoffApron(K(0.82), -1, 3, [10, 0.4, 18], [0.3, 0.4, 0.6]);
  api.bankedKerbStrip(0.85, 0.88, 1, { safer: false });
  api.bowlSeatWall(0.9, 0.93, -1, 30, { thick: 2.3 });
  api.pastelStreetRow(0.94, 0.99, 1, 25, { lit: false, floor: 4 });
  api.broadcastCompound(K(0.12), 1, 40, { vans: 5, dishes: 3 });
};

describe.skipIf(!haveF1)("SceneryIdentity port vs f1-game", () => {
  const f1 = haveF1 ? createF1Vm() : null;
  const port = (mutate?: (api: Identity.IdentityApi) => Identity.IdentityApi) => ({
    SceneryIdentity: {
      ...Identity,
      create: (ctx: Identity.IdentityCtx) => {
        const api = Identity.create(ctx);
        return mutate ? mutate(api) : api;
      },
    },
  });

  it("builds every circuit identically with the port swapped in", () => {
    for (const id of CIRCUITS) {
      const base = f1!.build(id);
      expect(diffDigests(base, f1!.build(id, port())), id).toEqual([]);
    }
  }, 300_000);

  it("matches on the uncalled helpers and option branches (sweep over monza and bahrain)", () => {
    const scenery = f1!.global<Record<string, (api: SceneryApi) => void>>("TrackScenery");
    for (const id of ["monza", "bahrain"]) {
      const orig = scenery[id]!;
      const TrackScenery = { ...scenery, [id]: (api: SceneryApi) => { orig(api); sweep(api); } };
      const base = f1!.build(id, { TrackScenery });
      expect(diffDigests(base, f1!.build(id, { TrackScenery, ...port() })), id).toEqual([]);
      if (id === "monza") expect(diffDigests(base, f1!.build(id))).toContain("propsGeo");
    }
  }, 120_000);

  it("matches with both structures and identity ported (identity on the port's along)", () => {
    const both = {
      ...port(),
      SceneryStructures: {
        ...Structures,
        create: (ctx: Structures.StructuresCtx) => Structures.create(ctx, f1!.core),
      },
    };
    for (const id of ["jeddah", "zandvoort"]) {
      expect(diffDigests(f1!.build(id), f1!.build(id, both)), id).toEqual([]);
    }
  }, 120_000);

  it("negative control: a 1e-9 m flood-mast height change is detected", () => {
    const base = f1!.build("bahrain");
    const bumped = f1!.build("bahrain", port((api) => ({
      ...api,
      floodMast: (k, side, dist, opts) => api.floodMast(k, side, dist, { ...opts, h: (opts && opts.h != null ? opts.h : 36) + 1e-9 }),
    })));
    expect(diffDigests(base, bumped)).not.toEqual([]);
  }, 60_000);
});
