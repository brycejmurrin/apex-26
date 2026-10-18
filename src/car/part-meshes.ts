// Garage readiness: a team's car, built from its resolved parts recipe.
//
// Ports only f1-game's parts -> Car3D.build resolution path, buildCarData in
// js/car/car-draw.js:137-154:
//   liv   = resolveLivery(team)                         (js/car/custom-liveries.js:42-61)
//   setup = extra.setup || Parts.getFactorySetup(team)  (car-draw.js:143)
//   Car3D.build(liv.c1, liv.c2, { livery: liv, teamId: team.id,
//     num: extra.num ?? team.drivers[0].num, helmetKey: legendLid(team),
//     parts: Parts.getVisualTiers(setup, team), noWheels, field: noWheels, silhouette })
// The garage turntable and setup camera feed the same shape (js/garage/setup-camera.js:533,
// with G.getTeamParts(team.id) as the setup). A FACTORY_PRESET is the default setup;
// a SIGNATURE (or any) selection is passed as `setup` and resolved through the same
// lock fallback (Parts._resolve: equivalent, then DEFAULTS).
//
// Deviations: the GLTF car-model override (car-draw.js:139-142) is not ported, and
// legendLid (:131-135) reads G.driverIdx, so `helmetKey` is a caller option instead.
// The default livery is resolveLivery over an empty store (the team's own paint job,
// what f1-game draws with no saved choice); pass `livery` to override it.
import type { BuildOptions, Livery } from "./car3d";
import { CustomLiveries } from "./custom-liveries";
import type { LiveryTeam, Rgb } from "./liveries";
import { CARBON } from "./materials";
import { getFactorySetup, getVisualTiers, type PartSetup, type PartsTeam, type VisualTiers } from "./parts";
import { buildCar, type CarModel } from "./three";
import type { Vec3 } from "./types";

/** The team fields this path reads: livery (id, colours, livery block), parts lock
 *  (id, engine, factory) and the default car number (drivers[0].num). */
export type PartsCarTeam = LiveryTeam & Exclude<PartsTeam, string | null | undefined> & {
  readonly drivers?: readonly { readonly num?: number | undefined }[] | undefined;
};

export interface PartsCarOptions {
  /** extra.setup: a requested setup (a FACTORY_PRESET, a SIGNATURE pick, a save).
   *  Unset or null: the team's works build, Parts.getFactorySetup(team). */
  setup?: PartSetup | null | undefined;
  /** A resolved livery; default resolveLivery(team) with nothing saved. */
  livery?: Livery | null | undefined;
  /** extra.num; default team.drivers[0].num. */
  num?: number | null | undefined;
  helmetKey?: string | undefined;
  /** car-draw.js:150-151: noWheels also selects the field body. */
  noWheels?: boolean | undefined;
  silhouette?: boolean | undefined;
}

/** What Car3D.build receives for this team (car-draw.js:144-152). */
export interface PartsBuild {
  color: Vec3;
  color2: Vec3;
  /** The resolved `opts.parts` (Parts.getVisualTiers). */
  parts: VisualTiers;
  opts: BuildOptions;
}

const emptyStore = { get: <T>(_k: string, fallback: T): T => fallback, set: (): boolean => false, rev: 0 };
let liveries: ReturnType<typeof CustomLiveries.create> | null = null;

/** f1-game's default resolveLivery(team): no stored id, no draft, no career. */
export function defaultLivery(team: LiveryTeam): Livery {
  liveries ??= CustomLiveries.create({ store: emptyStore, CarMaterials: { CARBON: [...CARBON] as Rgb } });
  // ResolvedLivery carries every LIVERY_FIELDS row as value-or-null, the bag build() reads.
  return liveries.resolveLivery(team) as Livery;
}

/** The setup f1-game builds this team's car from (car-draw.js:143). */
export function resolvePartsSetup(team: PartsCarTeam, setup?: PartSetup | null): PartSetup {
  return setup || getFactorySetup(team);
}

/** Car3D.build's arguments for this team and selection (car-draw.js:137-154). */
export function partsBuild(team: PartsCarTeam, o: PartsCarOptions = {}): PartsBuild {
  const liv = o.livery || defaultLivery(team);
  const setup = resolvePartsSetup(team, o.setup);
  const parts = getVisualTiers(setup, team);
  const d0 = team.drivers && team.drivers[0];
  const num = o.num != null ? o.num : (d0 && d0.num);
  const opts: BuildOptions = {
    livery: liv,
    teamId: team.id,
    num,
    helmetKey: o.helmetKey,
    parts,
    noWheels: !!o.noWheels,
    field: !!o.noWheels,
    silhouette: !!o.silhouette,
  };
  return { color: liv["c1"] as Vec3, color2: liv["c2"] as Vec3, parts, opts };
}

/** The team's car as a three.js model (./three.ts buildCar), plus what it was built from. */
export function buildPartsCar(team: PartsCarTeam, o: PartsCarOptions = {}): CarModel & { build: PartsBuild } {
  const b = partsBuild(team, o);
  // buildCar instances the wheels itself and always builds the body without them.
  const model = buildCar({ color: b.color, color2: b.color2, build: b.opts, noWheels: !!o.noWheels });
  return Object.assign(model, { build: b });
}
