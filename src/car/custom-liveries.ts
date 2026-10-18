/* Apex 26 — CustomLiveries: persist / resolve / live-draft paint jobs out of
   js/game.js. Catalog entries stay in Liveries (js/car/liveries.js); this module
   owns the player-created list, the chosen id, resolveLivery's store.rev cache,
   the creator's unsaved draft override, and wingColorOf. One
   CustomLiveries.create({ store }) at boot — deps seam, not a widened G.

   apex-26 port of f1-game js/car/custom-liveries.js:1-120 (the `CustomLiveries`
   IIFE global), verbatim: create :9-116, identityOwner/identityValue/
   setIdentityValue :12-24, the stored lists :25-32, the draft :33-38,
   resolveLivery :39-61, LIVERY_FIELDS :62-78, migrateLivery :79-90,
   pickLivery :91-95, wingColorOf :97-108.

   Deviations (globals become optional `deps` members):
   - Career (js/car/custom-liveries.js:12-15): `deps.Career`; absent = the
     `typeof Career === "undefined"` branch (global GP paint from the store).
   - Liveries (:88-89) is this lane's own module, imported, so the
     `typeof Liveries !== "undefined"` guard is always the loaded branch.
   - CarMaterials.CARBON (:107) is unguarded in f1-game: `deps.CarMaterials`;
     absent, a `wingCarbon: "carbon"` livery throws the ReferenceError the
     f1-game global would have.
   No localStorage is touched here: the store owns its key prefix (`a26.`). */

import { Liveries } from "./liveries";
import type { Livery, LiveryField, LiveryPaint, LiveryTeam, Rgb } from "./liveries";

/** The slice of f1-game's `store` (js/core/store.js:34, :51, :105) this module uses. */
export interface LiveryStore {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): boolean;
  /** Bumped on every set; resolveLivery's memo keys off it. */
  readonly rev: number;
}

/** The slice of f1-game's `Career` (js/career/career.js:133-140, :1997-2010) this module uses. */
export interface CareerIdentity {
  inCareer?: () => boolean;
  data?: () => { flavour?: string } | null | undefined;
  identityValue<T>(key: string, fallback: T): T;
  setIdentityValue(key: string, value: unknown): boolean;
  identityRevision(): number;
}

// TODO(lane-car): import from ./materials once T1.8 merges (f1-game js/car/car-materials.js:34).
export interface CarMaterialsLike {
  readonly CARBON: Rgb;
}

export interface CustomLiveriesDeps {
  store: LiveryStore;
  Career?: CareerIdentity;
  CarMaterials?: CarMaterialsLike;
}

/** A paint job as the creator drafts it: a Livery whose id / name may be unset. */
export type PaintJob = { id?: string; name?: string; c1: Rgb; c2: Rgb } & LiveryPaint;

/** resolveLivery's shape: id, c1, c2 and every LIVERY_FIELDS row (null when unset). */
export type ResolvedLivery =
  & { id: string | null; c1: Rgb; c2: Rgb }
  & { [K in LiveryField]?: Exclude<LiveryPaint[K], undefined> | null };

export interface LivDraft {
  teamId: string;
  liv: PaintJob;
}

export interface CustomLiveriesApi {
  getLiveryId(teamId: string): string;
  saveLiveryId(teamId: string, id: string): boolean;
  getCustomLiveries(teamId: string): Livery[];
  setCustomLiveries(teamId: string, arr: Livery[]): boolean;
  getLiveries(team: LiveryTeam): Livery[];
  resolveLivery(team: LiveryTeam): ResolvedLivery;
  wingColorOf(team: LiveryTeam): Rgb;
  pickLivery(l: PaintJob): ResolvedLivery;
  migrateLivery<T extends object>(l: T): T;
  livDraftOverride: LivDraft | null;
}

function create(deps: CustomLiveriesDeps): CustomLiveriesApi {
  const { store } = deps;

  function identityOwner(teamId: string): CareerIdentity | null {
    const Career = deps.Career;
    if (teamId !== "custom" || Career === undefined || !Career.inCareer || !Career.inCareer()) return null;
    return Career.data && Career.data() && Career.data()?.flavour === "myteam" ? Career : null;
  }
  function identityValue<T>(teamId: string, key: string, fallback: T): T {
    const owner = identityOwner(teamId);
    return owner ? owner.identityValue(key, fallback) : store.get(key, fallback);
  }
  function setIdentityValue(teamId: string, key: string, value: unknown): boolean {
    const owner = identityOwner(teamId);
    // A refused slot write must never fall through into the global GP paint.
    return owner ? owner.setIdentityValue(key, value) : store.set(key, value);
  }
  function getLiveryId(teamId: string): string { return identityValue(teamId, "livery." + teamId, "default"); }
  function saveLiveryId(teamId: string, id: string): boolean { return setIdentityValue(teamId, "livery." + teamId, id); }
  // Player-created liveries, stored per team as [{id,name,c1,c2,stripe?}].
  function getCustomLiveries(teamId: string): Livery[] { return identityValue<Livery[]>(teamId, "livery.custom." + teamId, []); }
  function setCustomLiveries(teamId: string, arr: Livery[]): boolean { return setIdentityValue(teamId, "livery.custom." + teamId, arr); }
  // Full paint-job list for a team: catalog (default + specials + universal) + the
  // player's own creations.
  function getLiveries(team: LiveryTeam): Livery[] { return Liveries.forTeam(team).concat(getCustomLiveries(team.id)); }
  // Resolve a team's chosen paint job -> { c1, c2, stripe } bodywork colours (its
  // own team colours for "default"). Everything that builds a car mesh paints with
  // these.
  // Transient un-saved paint job previewed live in the creator: { teamId, liv }.
  // Overrides the resolved livery for that one team while the creator is open.
  let livDraftOverride: LivDraft | null = null;
  // Memoized per team.id, invalidated by store.rev — during a race this resolves to
  // a cached object with zero localStorage access and zero per-frame allocation.
  const _livResolveCache = new Map<string, { val: ResolvedLivery; rev: number; identityRev: number }>();
  function resolveLivery(team: LiveryTeam): ResolvedLivery {
    // The live creator draft wins while it is open — through the same field list
    // as a saved livery, so no editor row can stop short of the atlas or mesh.
    // migratePaint folds the retired keys (ridge, airbox) and drops the retired
    // inks on the way in, so ONE list is still the only thing the atlas reads.
    if (livDraftOverride && livDraftOverride.teamId === team.id) return pickLivery(migrateLivery(livDraftOverride.liv));
    const owner = identityOwner(team.id), identityRev = owner ? owner.identityRevision() : 0;
    const c = _livResolveCache.get(team.id);
    if (c && c.rev === store.rev && c.identityRev === identityRev) return c.val;
    // A STORED ID THAT NO LONGER RESOLVES FALLS BACK TO THE TEAM'S OWN PAINT JOB.
    // list[0] is Liveries.forTeam's "default", carrying the team's whole livery
    // block; the bare `{ c1, c2 }` else-branch below dropped finShape/spineHeight/
    // spineSide, so a dangling id grew a shark fin instead of the car the team
    // races. Reachable via an imported garage file (js/ui/settings-export.js).
    const list = getLiveries(team);
    const liv = list.find((l) => l.id === getLiveryId(team.id)) || list[0];
    const val: ResolvedLivery = liv ? pickLivery(migrateLivery(liv)) : { id: "default", c1: team.color, c2: team.color2, stripe: null, accent: null };
    _livResolveCache.set(team.id, { val, rev: store.rev, identityRev });
    return val;
  }
  // The resolved paint-job shape, from a catalog entry or the creator's draft.
  // Optional detail colours are additive. Every live LIV_DRAFT_COLORS tint must be
  // listed. Dead keys (crestInk / plateInk / ridgeTint / airboxTint) are stripped
  // by Liveries.migratePaint before this runs — do not put them back.
  // A COPY of `Liveries.FIELDS` that had drifted by one row: `bodySplit`
  // (Cadillac's L/R body) was published and painted but missing here, so every
  // resolveLivery came back single-colour. team-livery.test.mjs now asserts the
  // two lists are the same set — the only thing that keeps a copy honest.
  const LIVERY_FIELDS: readonly LiveryField[] = ["stripe", "accent", "nose", "pod", "wing", "halo", "fin", "finArt", "logo", "logo2",
    "logo3", "noseStripe", "finish", "numFont", "sponsors", "finStyle", "finBadge", "spineLogo", "finShape",
    "tcam", "coverVents", "spineHeight", "spineSide", "rearWing", "wingCarbon", "cover", "spineTint", "sideTint",
    "sunTint", "bandTint2", "plateTint",
    "saddleTint", "coverBind", "finHandoff", "bodySplit", "lower", "upper",
  "patternTint", "patternSecond", "patternPlacement", "patternSide", "patternWidth", "patternRepeat",
  "patternOffset", "patternTaper", "patternOpacity", "patternRotation", "patternStretch", "patternWeight", "coverFinish", "wingFinish", "haloFinish",
  "mirrorTint", "rimTint", "caliperTint", "sidewallInk", "helmetBase", "helmetAccent",
  "podFinish", "finFinish", "mirrorFinish", "helmetStyle"];
  // A stored garage file may still carry the four RETIRED keys, so every read
  // path folds them once, here, and the list above never mentions them again:
  // RIDGE was the crown's centreline only and is now the BAND it always fell
  // back to; CREST INK and PLATE INK are auto-inked (see Liveries.migratePaint).
  // AIRBOX is DROPPED rather than folded onto `cover`: it painted the roll hoop
  // and intake lips ALONE, while `cover` paints the whole loft AND is the surface
  // the atlas inks the crest and every spine design against — promoting it would
  // repaint the cover and flip the crown ink on any file that set it.
  function migrateLivery<T extends object>(l: T): T {
    return Liveries.migratePaint(Object.assign({}, l));
  }
  function pickLivery(l: PaintJob): ResolvedLivery {
    const v: ResolvedLivery = { id: l.id || null, c1: l.c1, c2: l.c2 };
    for (let i = 0; i < LIVERY_FIELDS.length; i++) { const k = LIVERY_FIELDS[i] as LiveryField; (v as Record<string, unknown>)[k] = l[k] || null; }
    return v;
  }

  // The colour a team's WING FLAP elements are painted — the same fallback chain
  // Car3D uses for `wingC` when it builds the baked front/rear wing planes, so the
  // moveable active-aero flap drawn over the crown matches the wing it belongs to
  // instead of being a differently-coloured bolt-on.
  function wingColorOf(team: LiveryTeam): Rgb {
    const liv = resolveLivery(team);
    // The moveable elements ARE the wing's own top flaps, so they take the wing's
    // own colour — Car3D paints the baked cascade with exactly this fallback
    // chain (`wingC`). Tinting them to stand out would make the car two-tone
    // at rest.
    return liv.wingCarbon === "carbon" ? carbon() : (liv.wing || liv.c2 || team.color2);
  }
  function carbon(): Rgb {
    if (!deps.CarMaterials) throw new ReferenceError("CarMaterials is not defined");
    return deps.CarMaterials.CARBON;
  }

  return {
    getLiveryId, saveLiveryId, getCustomLiveries, setCustomLiveries,
    getLiveries, resolveLivery, wingColorOf, pickLivery, migrateLivery,
    get livDraftOverride() { return livDraftOverride; },
    set livDraftOverride(v) { livDraftOverride = v; },
  };
}

export { create };

/** The f1-game `CustomLiveries` global's members, frozen as it was (js/car/custom-liveries.js:118-120). */
export const CustomLiveries = Object.freeze({ create });
