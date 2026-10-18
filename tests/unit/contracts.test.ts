// Compile-time checks on src/contracts/. `npm run typecheck` (tsc) is the
// real gate: every `@ts-expect-error` below must still be an error, and every
// `Expect<...>` must resolve to `true`. Vitest runs the one runtime check.
import { describe, expect, it } from "vitest";
import type {
  ArcFree,
  ArcKey,
  AssistInput,
  CarState,
  PhysicsTrack,
  PlayerInput,
  RenderSeam,
  SceneryApi,
  SimCtx,
  TrackQuery,
} from "../../src/contracts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const input: PlayerInput = {
  steer: 0,
  throttle: true,
  brake: false,
  throttleLevel: 1,
  brakeLevel: 0,
  shiftUp: false,
  shiftDown: false,
  aero: false,
  aeroToggle: false,
  overtake: false,
  boost: false,
};

// The arc must not reach the driver (f1-game AGENTS.md §Physics).
const withCurvature: PlayerInput = {
  ...input,
  // @ts-expect-error PlayerInput has no curvature field
  curvature: 0.01,
};
const withLine: PlayerInput = {
  ...input,
  // @ts-expect-error PlayerInput has no racing-line field
  racingLineX: 1.5,
};
// A wider object smuggled through a variable is caught where ArcFree guards the entry.
const smuggled = { ...input, curvature: 0.01 };
// @ts-expect-error ArcFree<PlayerInput> rejects a curvature key even on a non-literal
const guarded: ArcFree<PlayerInput> = smuggled;

// No ArcKey is a key of PlayerInput; AssistInput is where they live.
export type NoArcOnPlayer = Expect<Equal<Extract<keyof PlayerInput, ArcKey>, never>>;
export type ArcOnAssist = Expect<Equal<Extract<keyof AssistInput, ArcKey>, "curvature" | "racingLineX">>;

// The physics only reads SimCtx: every member is readonly.
export type SimCtxReadonly = Expect<Equal<SimCtx, Readonly<SimCtx>>>;
const assignTrack = (ctx: SimCtx): void => {
  // @ts-expect-error SimCtx members are readonly
  ctx.raceT = 1;
};

// TrackQuery stays curvature-free too.
export type NoCurvatureOnTrack = Expect<Equal<Extract<keyof TrackQuery, "curvature">, never>>;
// …and so does the physics track that extends it.
export type NoArcOnPhysicsTrack = Expect<Equal<Extract<keyof PhysicsTrack, "curvature" | "bankAngle" | "lineAt" | "pathK">, never>>;
export type PhysicsTrackIsTrackQuery = Expect<PhysicsTrack extends TrackQuery ? true : false>;

// steerSm keeps f1-game's undefined-until-seeded semantics.
export type SteerSmSeed = Expect<Equal<CarState["steerSm"], number | undefined>>;

export type RenderHasCore = Expect<
  Equal<
    Extract<keyof RenderSeam, "init" | "resize" | "uploadTrackMesh" | "addCar" | "setCamera" | "renderFrame">,
    "init" | "resize" | "uploadTrackMesh" | "addCar" | "setCamera" | "renderFrame"
  >
>;

// f1-game tests/unit/scenery-api-contract.test.mjs:25-48, verbatim (CONTRACT_SIZE = 114).
const SCENERY_CONTRACT = [
  "ATM", "COL", "K", "MAT",
  "acacia", "addBox", "addCone", "addCyl", "addFrustum", "addMountain", "addPrism", "addPyramid",
  "along", "anchor", "backdrop", "bakedModel", "bankedKerbStrip",
  "billboard", "bleacher", "bowlSeatWall",
  "broadcastCompound", "broadleafFall", "building", "bush", "cameraTower", "cantilever", "circuitKit",
  "cityFront", "concreteCanyon", "conifer",
  "cross", "cypress", "def", "drape", "drapeRun", "ds", "every", "fence", "ferrisWheel", "floodMast",
  "floodMastRing", "forestEdge", "foundation", "frameAt", "gantry", "grandstand", "grandstandEx",
  "gridshellCanopy",
  "groundPatch", "groundPlane", "groundUnder", "groundYAt", "groundedSegments", "guardrail",
  "hash", "hedge", "house", "hw", "indexSolid", "lampPost", "landmarkKit", "lapBounds", "ledFacadeBands", "lerp",
  "marshalPost", "modelDiagnostics", "modelGroup", "motorhome", "mountain",
  "n", "night", "norm", "onTrack", "out", "overheadSpan", "pal", "palm",
  "pastelStreetRow", "peak", "pine", "place", "plane", "prop", "px", "py", "pyMin",
  "pz", "recordBarrier", "ridge", "runoffApron", "sailCanopy", "scaffoldStand",
  "sceneryTheme", "seat",
  "signBoard", "signDigit", "spectatorHill", "sponsorHoarding", "stonePine", "terrace", "terrainYAt", "theme",
  "tieredBowl", "tower", "track", "tree",
  "tyreWall",
  "underpassPortal", "upOf", "vadd", "wall", "waterBand", "waterField", "waterSurface",
] as const;

export type SceneryKeysMatchF1Game = Expect<Equal<keyof SceneryApi, (typeof SCENERY_CONTRACT)[number]>>;

describe("contracts", () => {
  it("SceneryApi mirrors f1-game's frozen 114-member scenery contract", () => {
    expect(SCENERY_CONTRACT.length).toBe(114);
    expect(new Set(SCENERY_CONTRACT).size).toBe(114);
    expect([...SCENERY_CONTRACT]).toEqual([...SCENERY_CONTRACT].sort());
  });

  it("keeps the compile-time fixtures referenced", () => {
    expect([withCurvature, withLine, guarded, assignTrack].length).toBe(4);
  });
});
