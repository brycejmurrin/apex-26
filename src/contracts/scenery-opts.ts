/**
 * Option bags of the scenery `api` emitters, typed from their implementations
 * (the kit ports in src/track/scenery/, each a verbatim port of the f1-game
 * emitter cited there). SceneryApi (./scenery.ts) names these instead of the
 * open `SceneryOpts` record. A type-only seam: no runtime import.
 *
 * Each is `Loose<>`: callers (the track designer, src/editor/track-themes.ts)
 * forward possibly-undefined fields, and every f1-game emitter reads an
 * undefined option as absent (`o.x != null`, `o.x || default`).
 */
import type {
  PineOpts as KPineOpts, TreeOpts as KTreeOpts, BushOpts as KBushOpts, ForestEdgeOpts as KForestEdgeOpts, CypressOpts as KCypressOpts, StonePineOpts as KStonePineOpts, BroadleafFallOpts as KBroadleafFallOpts,
  AcaciaOpts as KAcaciaOpts, PlaneOpts as KPlaneOpts, MountainOpts as KMountainOpts, RidgeOpts as KRidgeOpts, SpectatorHillOpts as KSpectatorHillOpts, GrandstandOpts as KGrandstandOpts,
} from "../track/scenery/nature";
import type {
  FenceOpts as KFenceOpts, GuardrailOpts as KGuardrailOpts, TyreWallOpts as KTyreWallOpts, GantryOpts as KGantryOpts, MarshalPostOpts as KMarshalPostOpts, CameraTowerOpts as KCameraTowerOpts,
  SponsorHoardingOpts as KSponsorHoardingOpts, BleacherOpts as KBleacherOpts, ScaffoldStandOpts as KScaffoldStandOpts, TerraceOpts as KTerraceOpts, TieredBowlOpts as KTieredBowlOpts,
} from "../track/scenery/structures";
import type {
  BuildingOpts as KBuildingOpts, CityFrontOpts as KCityFrontOpts, HouseOpts as KHouseOpts, MotorhomeOpts as KMotorhomeOpts, CityTowerOpts as KCityTowerOpts, BillboardOpts as KBillboardOpts,
} from "../track/scenery/city";
import type {
  MastLampSpec as KMastLampSpec, UnderpassPortalOpts as KUnderpassPortalOpts, FloodMastOpts as KFloodMastOpts, FloodMastRingOpts as KFloodMastRingOpts, LedFacadeBandsOpts as KLedFacadeBandsOpts,
  ConcreteCanyonOpts as KConcreteCanyonOpts, SailCanopyOpts as KSailCanopyOpts, GridshellCanopyOpts as KGridshellCanopyOpts, BankedKerbStripOpts as KBankedKerbStripOpts, BowlSeatWallOpts as KBowlSeatWallOpts,
  BroadcastCompoundOpts as KBroadcastCompoundOpts, PastelStreetRowOpts as KPastelStreetRowOpts,
} from "../track/scenery/identity";

/** Every key optional and `undefined`-tolerant (exactOptionalPropertyTypes). */
export type Loose<T> = { readonly [K in keyof T]?: T[K] | undefined };

export type PineOpts = Loose<KPineOpts>;
export type TreeOpts = Loose<KTreeOpts>;
export type BushOpts = Loose<KBushOpts>;
export type ForestEdgeOpts = Loose<KForestEdgeOpts>;
export type CypressOpts = Loose<KCypressOpts>;
export type StonePineOpts = Loose<KStonePineOpts>;
export type BroadleafFallOpts = Loose<KBroadleafFallOpts>;
export type AcaciaOpts = Loose<KAcaciaOpts>;
export type PlaneOpts = Loose<KPlaneOpts>;
export type MountainOpts = Loose<KMountainOpts>;
export type RidgeOpts = Loose<KRidgeOpts>;
export type SpectatorHillOpts = Loose<KSpectatorHillOpts>;
export type GrandstandOpts = Loose<KGrandstandOpts>;
export type FenceOpts = Loose<KFenceOpts>;
export type GuardrailOpts = Loose<KGuardrailOpts>;
export type TyreWallOpts = Loose<KTyreWallOpts>;
export type GantryOpts = Loose<KGantryOpts>;
export type MarshalPostOpts = Loose<KMarshalPostOpts>;
export type CameraTowerOpts = Loose<KCameraTowerOpts>;
export type SponsorHoardingOpts = Loose<KSponsorHoardingOpts>;
export type BleacherOpts = Loose<KBleacherOpts>;
export type ScaffoldStandOpts = Loose<KScaffoldStandOpts>;
export type TerraceOpts = Loose<KTerraceOpts>;
export type TieredBowlOpts = Loose<KTieredBowlOpts>;
export type BuildingOpts = Loose<KBuildingOpts>;
export type CityFrontOpts = Loose<KCityFrontOpts>;
export type HouseOpts = Loose<KHouseOpts>;
export type MotorhomeOpts = Loose<KMotorhomeOpts>;
export type CityTowerOpts = Loose<KCityTowerOpts>;
export type BillboardOpts = Loose<KBillboardOpts>;
export type MastLampSpec = Loose<KMastLampSpec>;
export type UnderpassPortalOpts = Loose<KUnderpassPortalOpts>;
export type FloodMastOpts = Loose<KFloodMastOpts>;
export type FloodMastRingOpts = Loose<KFloodMastRingOpts>;
export type LedFacadeBandsOpts = Loose<KLedFacadeBandsOpts>;
export type ConcreteCanyonOpts = Loose<KConcreteCanyonOpts>;
export type SailCanopyOpts = Loose<KSailCanopyOpts>;
export type GridshellCanopyOpts = Loose<KGridshellCanopyOpts>;
export type BankedKerbStripOpts = Loose<KBankedKerbStripOpts>;
export type BowlSeatWallOpts = Loose<KBowlSeatWallOpts>;
export type BroadcastCompoundOpts = Loose<KBroadcastCompoundOpts>;
export type PastelStreetRowOpts = Loose<KPastelStreetRowOpts>;
