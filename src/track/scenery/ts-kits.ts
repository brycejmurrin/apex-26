/**
 * The TS scenery kits as one `SceneryKits` for build-props (the f1-game globals
 * build-props.js reads, each replaced by its port with `core` bound).
 *
 * Each kit types its own ctx from what it reads; build-props assembles one
 * shared ctx (`BuildCtx`). Where a kit's declared ctx and BuildCtx disagree in
 * TS only, the adapter casts at this one seam; runtime values are identical,
 * and tests/unit/scenery/ts-kits.test.ts holds the whole assembly bit-exact
 * against f1-game.
 * TODO(scenery): converge each kit's Ctx/Api types with ctx.ts and drop the casts.
 */
import type { SceneryCore } from "./core";
import type { SceneryKits } from "./kits";
import * as Models from "./models";
import * as Graph from "./graph";
import * as Themes from "./themes";
import * as Landmark from "./landmark-kit";
import * as CircuitKitMod from "./circuit-kit";
import * as Guards from "./guards";
import * as Nature from "./nature";
import * as Structures from "./structures";
import * as Identity from "./identity";
import * as Venue from "./venue";
import * as City from "./city";
import * as Pits from "./pits";
import * as Data from "./data";

export function createTsKits(
  core: SceneryCore,
  shell: Pick<SceneryKits, "Tracks" | "TrackScenery" | "LightTune" | "GLX">,
): SceneryKits {
  const k: SceneryKits = {
    TrackModels: {
      scratch: Models.scratch,
      sealGeometry: Models.sealGeometry,
      create: (ctx) => Models.create(ctx as never, core) as never,
      drapeKit: (api) => Models.drapeKit(api as never),
    },
    TrackGraph: { create: (ctx) => Graph.create(ctx as never) as never },
    SceneryThemes: { resolve: Themes.resolve },
    LandmarkKit: { create: (p) => Landmark.create(p as never) },
    CircuitKit: { create: (d) => CircuitKitMod.create(d as never, core) },
    SceneryGuards: { create: (ctx) => Guards.create(ctx as never) as never },
    SceneryNature: { create: (ctx) => Nature.create(ctx as never, core) as never },
    SceneryStructures: { create: (ctx) => Structures.create(ctx as never, core) as never },
    SceneryIdentity: { create: (ctx) => Identity.create(ctx as never) as never },
    SceneryVenue: {
      build: (ctx, theme, excluded) => Venue.build(ctx as never, theme as never, excluded as never, core),
    },
    SceneryCity: { create: (ctx) => City.create(ctx as never, core) as never },
    SceneryPits: { build: (ctx) => Pits.build(ctx as never, core) as never },
    TrackSceneryData: Data,
    Tracks: shell.Tracks,
    TrackScenery: shell.TrackScenery ?? null,
    LightTune: shell.LightTune ?? null,
    GLX: shell.GLX ?? null,
  };
  return k;
}
