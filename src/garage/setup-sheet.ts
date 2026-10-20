/**
 * The GARAGE screen UI (#carsetup): everything about WHO you are and WHAT you
 * drive. Stat bars, the tab column (TEAM & DRIVER, the twelve PARTS
 * categories, SETUP, LIVERY), the part rows with their comparison, the livery
 * grid and the paint creator.
 *
 * Port of f1-game js/garage/setup-sheet.js:1-1407, verbatim: create :5,
 * renderStatBars :20-64, the tab state :66-78, the livery draft shape
 * :80-216, tabs :218-319, TEAM & DRIVER :328-443, buildSetup :445-736,
 * statDeltaChips :738-776, livSwatch :778-803, SETUP :805-807, the livery grid
 * :809-937, the paint creator :939-1280, the live preview :1282-1351,
 * openSetup :1353-1379, the draft teardown :1381-1402, the API :1403.
 *
 * `SetupUI.create(G)` becomes `createSetupSheet(host, deps)`:
 * - `host` (SetupSheetHost) is a typed facade of exactly the f1-game G members
 *   this module reads and writes (driverIdx, soundOn, livDraftOverride,
 *   _spMeshKey, setupPreviewOn); keep it live (getters/setters), as game.js's
 *   G is.
 * - every global the IIFE read is an import (Parts, Teams, Car3D, Liveries,
 *   PhysicsConsts, SetupTune, SetupExperiments, GarageExperience,
 *   GarageSurfaceInspection, the livery design editor) or, where another lane
 *   owns it, an injected dep (SetupSheetDeps) with its TODO owner. An absent
 *   optional dep is f1-game's `typeof X === "undefined"` branch.
 * Deviations: M4.clamp is a local `clamp` (js/core/mat4.js:5, same
 * expression); `G.els` and `#vsfriend` are guarded (the shell may not have
 * those screens); dispose() disconnects the #carsetup observer and cancels
 * the pending preview timer (f1-game's sheet lived for the page). The screen
 * CSS is ./garage.css, imported after the UI foundation.
 */
import "../styles";
import "./garage.css";
import { Car3D } from "../car/car3d";
import { Liveries, type Livery, type Rgb } from "../car/liveries";
import { Parts, type OwnedSet, type PartCategory, type PartOption, type PartSetup, type PartsTeam } from "../car/parts";
import { Teams, type Team } from "../car/teams";
import type { LivDraft, PaintJob } from "../car/custom-liveries";
import { PhysicsConsts } from "../physics/consts";
import { log as dataLog } from "../data/log";
import { createGarageExperience, type ExperienceTeam, type GarageExperienceFull } from "./experience";
import { createLiveryDesignEditor, type AttachedEditor, type LiveryDesignLike, type LiveryDraft } from "./livery-design-editor";
import { create as createExperiments, type ExperimentsDeps, type ExperimentsHost } from "./setup-experiments";
import { GarageSurfaceInspection, type InspectionControls, type SurfaceInspectionApi } from "./surface-inspection";
import { SetupTune, type SetupTuneApi } from "./setup-tune";
import type { GarageCareer, GarageLog } from "./scene/types";
import type { GarageAudioLike } from "./setup-camera";

/** A Teams.LIST row as GarageExperience reads it (TeamStats is an interface, so it needs the widening). */
const asExpTeam = (t: Team): ExperienceTeam => t as unknown as ExperienceTeam;
/** M4.clamp (js/core/mat4.js:5). */
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** A seat on another player's machine (VS FRIEND, G.peerSeats). */
export interface PeerSeat { readonly team: string; readonly driver: number }

/**
 * The members of f1-game's G (js/game.js façade) the GARAGE sheet reads, and
 * the five it writes. The shell keeps it live (getters / setters).
 */
export interface SetupSheetHost extends ExperimentsHost {
  $: (id: string) => HTMLElement | null;
  /** els.select / els.overlay: the screens openSetup hides. Optional here (guarded). */
  readonly els?: { readonly select?: HTMLElement | null | undefined; readonly overlay?: HTMLElement | null | undefined } | undefined;
  cssCol(c: readonly number[]): string;
  arrToHex(a: readonly number[]): string;
  hexToArr(h: string): Rgb;
  getTeamParts(teamId: string): PartSetup;
  saveTeamParts(teamId: string, parts: PartSetup): void;
  getLiveryId(teamId: string): string;
  saveLiveryId(teamId: string, id: string): void;
  getCustomLiveries(teamId: string): Livery[];
  setCustomLiveries(teamId: string, list: Livery[]): void;
  getLiveries(team: Team): Livery[];
  /** car-draw invalidateDecalTextures(teamId). TODO(lane-render). */
  readonly invalidateDecalTextures?: ((teamId: string) => void) | null | undefined;
  readonly teamIdx: number;
  driverIdx: number;
  soundOn?: boolean | undefined;
  /** "race" while WORK ON CAR pauses a race. */
  readonly state?: string | undefined;
  /** The MY TEAM / grid picker dialog. TODO(lane-shell). */
  setTeamPicker(open: boolean): void;
  /** EDIT MY TEAM (js/career/custom-team.js). TODO(lane-race). */
  openCustomize(): void;
  /** The team's swatch chip (game.js teamSwatch). */
  teamSwatch(team: Team): HTMLElement;
  /** VS FRIEND seats taken by the other player. TODO(lane-net). */
  readonly peerSeats?: (() => readonly PeerSeat[]) | undefined;
  /** The career's owned-part set, or null/false outside a career (G.careerOwned). TODO(lane-race). */
  careerOwned(): OwnedSet | null | false | undefined;
  readonly unlimitedBudget?: boolean | undefined;
  /** game.js armConfirm: arm-then-confirm for a destructive button. */
  armConfirm(btn: HTMLElement, armedText: string, action: () => void): boolean;
  /** CustomLiveries.livDraftOverride (the creator's unsaved paint on the player's team). */
  livDraftOverride: LivDraft | null;
  /** Setting "" busts the setup camera's preview mesh (setupCam.meshKey). */
  _spMeshKey: string;
  setupPreviewOn: boolean;
}

/** The slice of Career the sheet reads (budget, balance, research). TODO(lane-race). */
export interface SheetCareer extends GarageCareer {
  inCareer?(): boolean;
  budget(): number;
  data(): { readonly money: number; readonly tdev?: Readonly<Record<string, number>> | null | undefined };
  research(opt: PartOption): boolean;
  researchCost(opt: PartOption): number;
  planning?(): { cash?(cost: number): { unlimited?: boolean; afterPurchase: number; wages: number; low: number } | null | undefined } | null | undefined;
}

/** A design fill row (LiveryTex.FILL_SURFACES). */
export interface FillSurface { readonly key: string; readonly label: string; readonly why: string }

/** The slice of LiveryTex (f1-game js/car/liverytex.js) the sheet reads. TODO(lane-car): src/car/liverytex.ts. */
export interface SheetLiveryTex {
  paintSwatch?(ctx: CanvasRenderingContext2D, teamId: string, liv: Livery, w: number, h: number): void;
  readonly FILL_SURFACES?: readonly FillSurface[] | undefined;
  fillInert?(key: string, design: { spineLogo?: string | undefined; spineSide?: string | undefined; coverBind?: string | undefined }): boolean;
  markSlots?(teamId: string): readonly { readonly key: string; readonly label: string }[];
  contrast?(a: readonly number[], b: readonly number[]): number;
  readonly MARK_FLOOR?: number | undefined;
  readonly NUM_FONT_IDS?: readonly string[] | undefined;
  readonly SPONSOR_PACK_IDS?: readonly string[] | undefined;
  readonly TAIL_STYLE_IDS?: readonly string[] | undefined;
  readonly FIN_BADGE_IDS?: readonly string[] | undefined;
  readonly SPINE_LOGO_IDS?: readonly string[] | undefined;
  readonly SPINE_SIDE_IDS?: readonly string[] | undefined;
}

/** Car3D's id tables the pill rows list (src/car/car3d.ts). */
export interface SheetCar3D {
  readonly FINISH_SURFACE: Readonly<Record<string, unknown>>;
  readonly FIN_SHAPE_IDS?: readonly string[] | undefined;
  readonly TCAM_IDS?: readonly string[] | undefined;
  readonly COVER_VENT_IDS?: readonly string[] | undefined;
  readonly SPINE_HEIGHT_IDS?: readonly string[] | undefined;
}

/** Everything createSetupSheet reads beyond `host`. */
export interface SetupSheetDeps {
  /** Teams.LIST (with MY TEAM / LEGENDS spliced in by the shell). Default src/car/teams.ts. */
  teams?: readonly Team[] | undefined;
  /** SetupTune. Default the page's (./setup-tune.ts). */
  tune?: SetupTuneApi | undefined;
  /** SetupExperiments' deps (presets, trials, tracks, uiTick…). */
  experiments?: ExperimentsDeps | undefined;
  /** GarageExperience. Default ./experience.ts over `career`. */
  experience?: GarageExperienceFull | undefined;
  /** Career. TODO(lane-race). Absent = never in a career. */
  career?: SheetCareer | null | undefined;
  /** GameAudio. TODO(lane-audio). */
  audio?: GarageAudioLike | null | undefined;
  /** LiveryTex. TODO(lane-car). */
  liveryTex?: SheetLiveryTex | null | undefined;
  /** LiveryDesign. TODO(lane-car): src/car/livery-design.ts. Absent = no design tools in the creator. */
  liveryDesign?: LiveryDesignLike | null | undefined;
  /** Car3D's id tables. Default src/car/car3d.ts. */
  car3d?: SheetCar3D | undefined;
  /** Helmets.STYLES. TODO(lane-car): not on src/car/helmets.ts yet. Absent = ["team"]. */
  helmetStyles?: readonly string[] | null | undefined;
  /** SettingsExport.garageRow (js/ui/settings-export.js). TODO(lane-shell). */
  settingsExport?: { garageRow(): HTMLElement | null | undefined } | null | undefined;
  /** ShareCode (js/ui/share-code.js). TODO(lane-shell). */
  shareCode?: { encode(kind: string, payload: unknown): { ok: boolean; code: string } } | null | undefined;
  /** ApexClipboard (js/ui/clipboard.js). TODO(lane-shell). */
  clipboard?: { write(text: string): Promise<unknown> } | null | undefined;
  /** GarageScene.pulse: the bay acknowledges a fitted part. */
  scene?: { pulse(): void } | null | undefined;
  /** GarageSurfaceInspection. Default the page's instance; null = absent. */
  surfaceInspection?: SurfaceInspectionApi | null | undefined;
  log?: GarageLog | undefined;
}

export interface SetupSheetApi {
  buildSetup(): void;
  openSetup(): void;
  /** Disconnect the #carsetup observer and drop pending work. Not in f1-game (page lifetime). */
  dispose(): void;
}

// The stat list and the display curve now live in Parts, because the in-world
// stats board on the garage wall reads the same numbers and a second copy of
// the curve would let the two disagree.
const CS_STATS = Parts.STAT_KEYS;
const displayStat = Parts.displayStat;

export const PSEUDO_CATS: readonly string[] = ["team", "tune", "livery"];
export const SECONDARY_CATS: ReadonlySet<string> = new Set(["floor", "cockpit", "wheels", "tune", "livery"]);

// ONE DRAFT SHAPE, THREE DOORS INTO THE EDITOR. New, edit-in-place and
// "customize a copy" share one field list, because hand-spelled copies drift
// silently: a copy missing the eight structural fields (finStyle, finBadge,
// spineLogo, finShape, tcam, coverVents, spineHeight, spineSide) fails
// nothing — pillRow falls back to `dflt` when a key is absent, so the editor
// shows STANDARD/NONE, and the save writes a field only when it differs from
// that default — yet hands back a team's own paint job with a shark fin and a
// flat spine (every team sets finShape "none" + spineHeight "dorsal" in
// js/data/teams.js), with the editor agreeing.
// The save's own `if (d.x && d.x !== <default>)` chain and Liveries.forTeam's
// copy list are the other two spellings of these keys; team-livery.test.mjs
// holds all three together.
export const LIV_DRAFT_COLORS: readonly string[] = ["stripe", "noseStripe", "accent", "nose", "pod", "lower", "upper", "wing", "halo",
                          "rearWing", "cover", "spineTint", "saddleTint",
                          "sideTint", "sunTint",
                          "bandTint2", "plateTint",
                          "fin", "finArt", "logo", "logo2", "logo3", "patternTint", "patternSecond",
                          "mirrorTint", "rimTint", "caliperTint", "sidewallInk", "helmetBase", "helmetAccent"];
export const LIV_DRAFT_PILLS: Readonly<Record<string, string>> = { wingCarbon: "paint", finish: "gloss", numFont: "default",
                          sponsors: "default", finStyle: "team", finBadge: "logo",
                          spineLogo: "logo", finShape: "standard", tcam: "team",
                          coverVents: "none", spineHeight: "standard", spineSide: "none",
                          coverBind: "independent", finHandoff: "match", bodySplit: "off",
                          patternPlacement: "crown", patternSide: "both", patternWidth: "70", patternRepeat: "6",
                          patternOffset: "0", patternTaper: "20", patternOpacity: "100",
                          patternRotation: "0", patternStretch: "100", patternWeight: "100",
                          coverFinish: "inherit", wingFinish: "inherit", haloFinish: "inherit",
                          podFinish: "inherit", finFinish: "inherit", mirrorFinish: "inherit", helmetStyle: "team" };
// WHAT EACH ROW ACTUALLY PAINTS. Every label named a colour and none of them
// named a SURFACE, so the sheet could not answer its own first question: what
// does this change? Worse, two rows read as a pair and are not one — ACCENT is
// the second BASE colour (`c2`) that a dozen other rows fall back to, while
// DETAIL is a THIRD colour (`accent`) that overrides c2 on six small trim
// pieces. The labels invert the field names, so even the source misleads.
//
// A row that only INHERITS says so, because "already coloured" and "set" look
// identical on the car: leave WINGS alone and it is c2, and the player has no
// way to tell that from having chosen it. Surfaces are read from car3d.js —
// keep them true to the code, not to the label.
export const LIV_ROW_HINT: Readonly<Record<string, string>> = {
  c1: "PRIMARY — the bodywork itself: monocoque, nose, sidepods, engine cover.",
  c2: "ACCENT — the second BASE colour. Unset optional rows fall back to this or PRIMARY — not to each other.",
  accent: "DETAIL — trim only (pinstripe, sidepod flash, nose flank spans, floor-edge lip, fin strip) and the keyline round the race number (nose, SPINE SIDE number / code / lockup). The colour you pick is used as-is. Unset = ACCENT, contrast-checked beside the number. Does not recolour stripe, saddle, sun, plate, or marks.",
  stripe: "BODY STRIPE — full spine, nose tip to engine cover. This row only.",
  noseStripe: "NOSE STRIPE — the nose crown only, tip to bulkhead. Layers on top of BODY STRIPE.",
  nose: "NOSE CAP — a painted nose cone. Unset = the bodywork colour.",
  pod: "SIDEPOD — the sidepod panel, both sides. Unset = the bodywork colour.",
  lower: "LOWER BODY — the bodywork below a line along the sidepods at the sponsor board's top edge, carried forward along the chassis side to the nose (pod flanks and undersides, lower chassis; the nose stays PRIMARY). Only bare PRIMARY paint changes: the accent band, board, stripes and caps keep theirs. Ignored under BODY SPLIT L/R. Unset = PRIMARY.",
  upper: "UPPER BODY — the bodywork ABOVE that same sidepod board line (upper chassis / pod flanks above the board; the nose stays PRIMARY). The W17's silver-over-black split. Only bare PRIMARY paint changes. Ignored under BODY SPLIT L/R. Unset = PRIMARY (today's single-colour body above the line).",
  cover: "ENGINE COVER — airbox, roll hoop, cover loft and snorkel. Unset = the bodywork colour. (AIRBOX had its own row and no longer does: it painted a strict subset of these surfaces.)",
  spineTint: "BAND — the SPINE TOP graphic fill on the cover crown, the tail top, the centreline RIDGE, and the saddle's flank half when SADDLE is unset. The colour you pick is used as-is. Unset = SECONDARY, else PRIMARY, checked against ENGINE COVER — never BODY STRIPE or DETAIL.",
  saddleTint: "SADDLE — the shoulder shelf and upper-flank saddle block, and the SPINE SIDE shoulder / rake fills. The colour you pick is used as-is. Unset = BAND under SADDLE or SADDLE WRAP.",
  sideTint: "FLANK FILL — every SPINE SIDE colour FILL on the cover flank (BAND, SASH, RIBBON strip, SLASH, RAKE, SHOULDER, STARFIELD dots), ALONE. A separate zone from BAND: with SPINE TOP on SADDLE the band paints the flank these sit on, so one colour cannot serve both. The colour you pick is used as-is. Unset = derived against the flank; RAKE and SHOULDER borrow SADDLE first.",
  sunTint: "SUN — the WRAP design's sun disc, over the crown, both cover flanks and the airbox. Its own row because BAND used to paint it too: one field meant a band on most SPINE TOP designs and the sun on WRAP. The colour you pick is used as-is. Unset = the mark's plate / SECONDARY against ENGINE COVER.",
  bandTint2: "2ND BAND — the TRICOLOUR design's second band. Only one of its two bands was ever choosable and the other was derived, which is how a tricolour could come out one colour repeated. The colour you pick is used as-is. Unset = derived against the cover and the first band.",
  plateTint: "PLATE — the board SPINE SIDE's PLATE / TITLE designs paint on. The colour you pick is used as-is. Unset = SECONDARY, contrast-checked against the flank — never BODY STRIPE. Lettering auto-inks.",
  wing: "WINGS — the front and rear FLAPS. Unset = ACCENT.",
  rearWing: "REAR WING — the rear mainplane block. Unset = ACCENT.",
  fin: "TAIL FIN — the shark-fin plate. The colour you pick is used as-is (even under FIN HANDOFF CONTRAST). Unset = ACCENT, or a contrast-derived colour when HANDOFF is CONTRAST. Needs a FIN SHAPE other than NONE.",
  finArt: "TAIL GRAPHIC — fin motif / badge ink. The colour you pick is used as-is. Unset = first base colour that clears the fin plate.",
  halo: "HALO — the cockpit halo loop.",
  logo: "TEAM LOGO — the dominant shape of the team mark everywhere it is drawn: crown, fin badge, SPINE SIDE logo/emblem/lockup, the WRAP design's flank bull, the livery tile, garage wall. The colour you pick is used as-is (no contrast override). Lettering (numbers, wordmarks) auto-contrasts; it is not this row.",
  logo2: "LOGO DETAIL — the mark's second shape (shield, disc, traced layer, or island), named per team. One-loop marks have no such row. The colour you pick is used as-is. Authored plates reach the flank logo/emblem too.",
  logo3: "OUTLINE — a rim around the mark only, in the colour you pick. Off by default.",
  patternPlacement: "DESIGN AREA — new spine patterns cover the crown/tail or continue over the shoulders.",
  patternSide: "WRAP SIDES — both cover flanks, or just the chosen side; crown remains painted.",
  patternWidth: "DESIGN WIDTH — coverage across the crown and flank, as a percentage.",
  patternRepeat: "REPEATS — density of repeated shapes or lines on the cover.",
  patternOffset: "SIDE OFFSET — shift the new spine pattern across the cover.",
  patternTaper: "TAIL TAPER — narrow the pattern toward the rear of the cover.",
  patternOpacity: "OPACITY — transparency of the new spine artwork over its base paint.",
  patternRotation: "ROTATION — turn the artwork within its painted area. Wrap sides remain aligned with the crown.",
  patternStretch: "LENGTH STRETCH — compress or extend the artwork along the engine cover.",
  patternWeight: "LINE WEIGHT — thickness of contour, honeycomb, wave, herringbone, circuit and speed-line strokes.",
  patternTint: "DESIGN COLOUR — adjustable artwork on the crown and selected cover flanks. Unset = ACCENT.",
  patternSecond: "SECOND DESIGN COLOUR — two-colour patterns, including gradients, waves, sunbursts, scallops, herringbone, circuits, shards and pixel fade. Unset = PRIMARY.",
  coverFinish: "COVER FINISH — painted engine cover and airbox; INHERIT uses FINISH. Carbon and intake surfaces stay unchanged.",
  wingFinish: "WING FINISH — painted front and rear wing assemblies, including moving flaps. Carbon stays carbon.",
  haloFinish: "HALO FINISH — the painted halo; INHERIT uses FINISH.",
  podFinish: "SIDEPOD FINISH — the painted sidepods; INHERIT uses FINISH. Carbon and intake surfaces stay unchanged.",
  finFinish: "FIN FINISH — the painted shark fin; INHERIT uses FINISH. Needs a FIN SHAPE other than NONE.",
  mirrorFinish: "MIRROR FINISH — the painted mirror housings; INHERIT uses FINISH. Mirror glass is untouched.",
  mirrorTint: "MIRROR HOUSING — the painted mirror stalks and housings. Unset = the stock dark carbon housing.",
  rimTint: "RIM — the wheel rim colour on all four wheels. Unset = the BRAKES part's rim colour.",
  caliperTint: "CALIPER — the brake caliper colour on all four wheels. Unset = the BRAKES part's caliper colour.",
  sidewallInk: "SIDEWALL INK — the lettering ink on the tyre sidewall; the compound band keeps its colour. Unset = the stock dark lettering.",
  helmetBase: "HELMET BASE — the helmet shell colour. Unset = the driver's own design.",
  helmetAccent: "HELMET ACCENT — the helmet's stripe and cap colour. Unset = the driver's own design.",
  helmetStyle: "HELMET — TEAM keeps the driver's own design; other styles repaint it from HELMET BASE and ACCENT.",
  finish: "FINISH — the paint surface: gloss, satin, matte, chrome, brushed, pearl, carbon, flake (metallic sparkle), candy (deep saturated), tinted (chrome that keeps the livery hue) or chameleon (a strong colour-shift pearl).",
  wingCarbon: "WING FLAPS — paint, or exposed carbon on every flap front and rear. Carbon overrides the WINGS and REAR WING colours.",
  numFont: "NUMBER FONT — the race number's typeface, on the nose and wherever a badge carries it.",
  sponsors: "SPONSORS — which set of names the car carries. CLEAN paints none, which also greys every spine design that writes a sponsor name (TOP wordmark, SIDE wordmark/duo/title).",
  finShape: "FIN SHAPE — the shark-fin blade. NONE removes it, and with it the fin's paint, graphic, style and badge. Every 2026 team car runs NONE.",
  finStyle: "TAIL STYLE — the motif painted on the fin.",
  finBadge: "FIN BADGE — what the fin carries: the mark, the race number, the driver code, or nothing.",
  spineLogo: "SPINE TOP — what the engine-cover CROWN carries, painted on bare body colour.",
  coverBind: "COVER BIND — how crown and flank zones couple. INDEPENDENT = each zone free; SADDLE WRAP = saddle block spans crown shoulders and upper flanks; SPINE ONLY = crown/ridge accent only, shoulders stay cover.",
  finHandoff: "FIN HANDOFF — how the fin meets the cover block. MATCH = fin uses TAIL FIN (or ACCENT); CONTRAST = when TAIL FIN is unset, derive a colour that clears the crown/saddle block (authored TAIL FIN still wins); HARD CUT = fin ignores crown graphic continuation at the fin root.",
  tcam: "T-CAM — the camera housing colour. AUTO is the real rule: car 1 black, car 2 yellow.",
  coverVents: "COVER VENTS — cooling slits cut into the engine cover. Geometry, not paint.",
  spineHeight: "SPINE HEIGHT — how tall the cover crown runs behind the roll hoop. DORSAL is the fin-less 2026 look every team uses.",
  spineSide: "SPINE SIDE — what the cover FLANK carries, both sides: number, mark, code, number plate, wordmark, duo, ribbon, lockup, title board, emblem, or a colour fill (band, sash, slash, rake, shoulder, starfield — SIDE TINT paints those).",
  bodySplit: "BODY SPLIT — paint the body LEFT (primary) / RIGHT (secondary). Cadillac's black/white launch car.",
};

// `liv` is a saved livery for edit/copy, or a bare {c1,c2} for a new one: an
// absent colour becomes "" (no paint) and an absent pill its own default.
// setup-sheet.js:185-194. `arrToHex` is the host's.
export function livDraftFrom(liv: Readonly<Record<string, unknown>> | null | undefined, name: string,
  arrToHex: (a: readonly number[]) => string): LiveryDraft {
  const src = Liveries.migratePaint(Object.assign({}, liv || {})) as Record<string, unknown>;
  const d: LiveryDraft = { name, c1: arrToHex(src["c1"] as readonly number[]), c2: arrToHex(src["c2"] as readonly number[]) };
  for (const k of LIV_DRAFT_COLORS) d[k] = src[k] ? arrToHex(src[k] as readonly number[]) : "";
  for (const k in LIV_DRAFT_PILLS) d[k] = (src[k] as string) || (LIV_DRAFT_PILLS[k] as string);
  return d;
}

// THE REVERSE, and the ONLY one: the SAVE and livePreviewDraft both build
// through it, so the car you are LOOKING at while dragging a colour and the
// livery you get on SAVE & FIT cannot be assembled by different code.
//
// One rule, two callers. A colour is written when it is set; a pill when it
// differs from its own default — which is what keeps a saved livery sparse
// (and the garage file small). `keepNull` is the only difference: the live
// preview needs every key PRESENT so resolveLivery's draft branch can read a
// null and paint the fallback, while the stored livery omits them.
// setup-sheet.js:196-216
export function livDraftTo(d: LiveryDraft, keepNull: boolean, hexToArr: (h: string) => Rgb): Record<string, Rgb | string | null> {
  const out: Record<string, Rgb | string | null> = {};
  for (const k of LIV_DRAFT_COLORS) {
    const v = d[k] ? hexToArr(d[k]) : null;
    if (v || keepNull) out[k] = v;
  }
  for (const k in LIV_DRAFT_PILLS) {
    const v = d[k] && d[k] !== LIV_DRAFT_PILLS[k] ? d[k] : null;
    if (v || keepNull) out[k] = v;
  }
  return out;
}

export function csTabId(id: string): string { return `cs-tab-${String(id).replace(/[^a-z0-9_-]/gi, "-")}`; }

// SHOW THE PART YOU JUST FITTED. Every catalog category changes the mesh
// (js/car/parts.js: each option carries a `visual` recipe), but a turntable
// left at whatever angle it is on makes an airbox swapped on a car facing away,
// or a caliper changed behind a sidepod, read as "nothing happened". One preset per
// category, chosen for where its parts live on the car; the existing camera
// bar presets, so a pick lands on exactly what SIDE or REAR would. Same idiom
// as the LIVERY tab framing FRONT: the preset stops the turntable, and SPIN or
// RESET hands it back. TEAM, SETUP and LIVERY are not parts and have no entry.
export const CAT_VIEW: Readonly<Record<string, string>> = {
  engine: "hero",        // airbox, sidepods, engine cover: rear three-quarter
  aero: "wingRear",      // the flap and DRS, orbiting the rear wing
  suspension: "front",   // arms, pushrods and wishbones read head-on
  brakes: "side",        // calipers, ducts, rotors
  tyres: "side",
  wheels: "side",
  ers: "hero",           // LEDs, pack blister and conduit on the cover
  gearbox: "rear",       // casing strakes, fin, louvres
  fuel: "hero",          // filler, breather and hatch on the spine
  exhaust: "rear",
  floor: "side",         // fences, plank, edge lip
  cockpit: "front",      // halo, screen, mirrors
};

/* A SIGNATURE part's name is its works (a place) and then the part:
   "Enstone Aero Kit", "Neuburg Brake Pack". Under a tab that already says AERO
   or BRAKES the place is the one word the rail can spare, and a width that
   ellipsises the subtitle kept exactly that word: a full signature build read
   "Kannapolis…" under every tab (layout audit, desktop-narrow / iPad
   landscape, 2026-09-30). The rail shows the part; the tab's aria-label and
   the option list keep the full name. */
export function tabSub(opt: PartOption | null | undefined): string {
  if (!opt) return "";
  const words = String(opt.label || "").split(" ");
  return opt.tag === "SIGNATURE" && words.length > 1 ? words.slice(1).join(" ") : opt.label;
}

const CS_DELTA_DEFS = [
  { key: "speed",     label: "TOP" },
  { key: "accel",     label: "ACCEL" },
  { key: "cornering", label: "GRIP" },
  { key: "braking",   label: "BRAKE" },
] as const;
/** setup-sheet.js:738-776 */
export function statDeltaChips(opt: PartOption): HTMLDivElement | null {
  const wrap = document.createElement("div");
  wrap.className = "cs-opt-deltas";
  let any = false;
  for (const d of CS_DELTA_DEFS) {
    const v = opt[d.key];
    if (v == null || v === 1) continue;
    any = true;
    const chip = document.createElement("span");
    chip.className = "cs-delta " + (v > 1 ? "up" : "down");
    // The magnitude, not just the direction. `tyres/branded_wall` (+2% grip,
    // 30 cr) and `tyres/hypersoft` (+36% grip, 200 cr) both rendered one plain
    // "▲GRIP", so the whole ladder read as a flat list of the same upgrade and
    // the only number on the row was its price.
    const pct = Math.round(Math.abs(v - 1) * 100);
    chip.textContent = (v > 1 ? "▲" : "▼") + d.label + " " + (v > 1 ? "+" : "−") + pct + "%";
    wrap.appendChild(chip);
  }
  // Rain grip is the entire reason the wet compounds exist and it is not one of
  // the four stats, so without this chip the garage shows a full wet as four
  // penalties and nothing else — which is exactly how it read while the physics
  // ignored the compound too. Against the slick column of the same table the
  // physics uses, so the number on the row is the number in the model.
  if (opt.wetTread) {
    const rain = PhysicsConsts.WET_GRIP.rain;
    const chip = document.createElement("span");
    chip.className = "cs-delta up";
    chip.textContent = "▲RAIN +" + Math.round(((rain[opt.wetTread] as number) / (rain[0] as number) - 1) * 100) + "%";
    wrap.appendChild(chip);
    any = true;
  }
  return any ? wrap : null;
}

// These never land in Car3D.build. A drag still invalidates the decal atlas;
// it must not also throw away the preview mesh (a full car rebuild on a phone).
export const MESH_FREE_DRAFT: Readonly<Record<string, 1>> = { logo: 1, logo2: 1, logo3: 1, sponsors: 1, numFont: 1, finStyle: 1, finBadge: 1, name: 1, patternTint: 1, patternSecond: 1, patternPlacement: 1, patternSide: 1,
  patternWidth: 1, patternRepeat: 1, patternOffset: 1, patternTaper: 1, patternOpacity: 1, patternRotation: 1, patternStretch: 1, patternWeight: 1 };
/** setup-sheet.js:1291-1305 */
export function draftSkipsMesh(prev: LiveryDraft | null, next: LiveryDraft): boolean {
  if (!prev) return false;
  const seen: Record<string, 1> = Object.create(null) as Record<string, 1>;
  const keys = Object.keys(prev).concat(Object.keys(next));
  let any = false;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i] as string;
    if (seen[k]) continue;
    seen[k] = 1;
    if (prev[k] === next[k]) continue;
    any = true;
    if (!MESH_FREE_DRAFT[k]) return false;
  }
  return any;
}

/** SetupUI.create (setup-sheet.js:5-1404). */
export function createSetupSheet(G: SetupSheetHost, deps: SetupSheetDeps = {}): SetupSheetApi {
  const Log = deps.log || dataLog;
  Log.info("ui", "SetupUI.create");
  const Teams_LIST: readonly Team[] = deps.teams || Teams.LIST;
  const SetupTuneApi = deps.tune || SetupTune;
  const Career = deps.career || null;
  const GameAudio = deps.audio || null;
  const GarageExperience = deps.experience || createGarageExperience({ career: Career });
  const GarageSurfaceInspectionApi = deps.surfaceInspection === undefined ? GarageSurfaceInspection : deps.surfaceInspection;
  const LiveryTex = deps.liveryTex || null;
  const Car3DIds: SheetCar3D = deps.car3d || Car3D;
  const GarageLiveryDesignEditor = createLiveryDesignEditor(deps.liveryDesign);
  const sfx = (name: "uiTick" | "uiSelect" | "uiReject"): void => { const f = GameAudio && GameAudio[name]; if (f) f.call(GameAudio); };
  const experimentsDeps: ExperimentsDeps = Object.assign({ tune: SetupTuneApi }, deps.experiments || {});
  if (!experimentsDeps.uiTick && GameAudio && GameAudio.uiTick) experimentsDeps.uiTick = () => sfx("uiTick");
  const tuneExperiments = createExperiments(G, (team) => renderStatBars(G.$("cs-stats-inner") as HTMLElement, team as Team), experimentsDeps);
  let surfaceControls: InspectionControls | null = null;
  function clearSurfaceControls(): void { if (surfaceControls) surfaceControls.dispose(); surfaceControls = null; }
  // Stable helpers from the game.js closure.
  const { $, cssCol, store, arrToHex, hexToArr,
          getTeamParts, saveTeamParts, getLiveryId, saveLiveryId,
          getCustomLiveries, setCustomLiveries, getLiveries, invalidateDecalTextures } = G;
  const els = G.els || {};

  function renderStatBars(container: HTMLElement, team: Team): void {
    const stats = GarageExperience.statsOf(asExpTeam(team)) || { speed: 85, accel: 85, cornering: 85, braking: 85 };
    const tune = SetupTuneApi.mods(team.id);
    const mods = Parts.getMods(getTeamParts(team.id), team, tune);   // the bars move with the SETUP sheet too
    container.textContent = "";
    for (const { key, label } of CS_STATS) {
      const base = stats[key] || 75;
      const effective = Math.round(displayStat(base * mods[key]));
      const delta = effective - base;

      const row = document.createElement("div");
      row.className = "cs-stat-row";

      const lbl = document.createElement("span");
      lbl.className = "cs-stat-label";
      lbl.textContent = label;

      const barWrap = document.createElement("div");
      barWrap.className = "cs-stat-bar-wrap";

      const baseBar = document.createElement("div");
      baseBar.className = "cs-stat-base";
      baseBar.style.width = Math.min(base, 100) + "%";

      const boostBar = document.createElement("div");
      boostBar.className = "cs-stat-boost" + (delta < 0 ? " penalty" : "");
      if (delta >= 0) {
        const b = Math.min(base, 100);
        boostBar.style.left = b + "%";
        boostBar.style.width = Math.min(delta, 100 - b) + "%";   // fill to the wrap edge; the number carries the exact value
      } else {
        boostBar.style.left = Math.max(0, base + delta) + "%";
        boostBar.style.width = Math.min(-delta, base) + "%";
      }

      barWrap.append(baseBar, boostBar);

      const val = document.createElement("span");
      val.className = "cs-stat-val" + (delta > 0 ? " up" : delta < 0 ? " down" : "");
      val.textContent = String(effective);

      row.append(lbl, barWrap, val);
      container.appendChild(row);
    }
  }

  // Persisted like the settings tab and the circuit filter (the other two
  // tab-strips), and defaulting to TEAM: opening on the first PARTS category
  // shows a player coming to change their team FRONT WING options, with the
  // rail's selected tab not the first one and LIVERY 14th behind a horizontal scroll.
  let csVisitGeneration = 0;
  let csActiveCat: string | null = null;   // id of the tab currently open in the GARAGE
  let csLivCreating = false; // livery creator panel open?
  let csLivDraft: LiveryDraft | null = null;     // { name, c1, c2, stripe } while editing a new paint job
  let csLivEditId: string | null = null;    // id of the custom livery being edited in-place (null = creating new)
  let csLivTeamId: string | null = null;    // the team the draft belongs to: a team change discards it

  function framePreset(name: string): void {
    // click() rather than a direct camera call: a display:none stack (narrow
    // landscape) still runs the handler, so the preset works on every layout.
    const stack = $("cs-stack");
    const b = stack && stack.querySelector<HTMLElement>(`[data-cs-view="${name}"]`);
    if (!b) return;
    // But click() replays that button's WHOLE handler, its uiTick included — so
    // fitting a part sounded twice: uiSelect for the fit, then uiTick for the
    // camera that followed it. The camera move is a CONSEQUENCE of the click, not a second
    // click, so it gets no voice of its own. Muting across the synthetic click
    // beats deleting the handler's uiTick: a REAL press of that button still has
    // to sound. click() dispatches synchronously, so the window is one statement.
    const was = G.soundOn;
    try { G.soundOn = false; b.click(); } finally { G.soundOn = was; }
  }
  function activateCsCat(id: string, focus: boolean): void {
    if (csActiveCat !== id) {
      csActiveCat = id;
      store.set("garageTab", id);
      if (G.soundOn) sfx("uiTick");
      buildSetup();
      const pane = $("cs-options"); if (pane) pane.scrollTop = 0;
      // LIVERY is about the wall crest as much as the paint chips: frame FRONT
      // on the category change only, never again while the tab stays open.
      if (id === "livery") framePreset("front");
      else if (CAT_VIEW[id]) framePreset(CAT_VIEW[id]);
    }
    if (focus) {
      const tab = $(csTabId(id));
      if (tab) {
        tab.focus();
        tab.scrollIntoView({ block: "nearest", inline: "center" });
      }
    }
  }

  function csTabKey(id: string, e: KeyboardEvent): void {
    const tabs = Array.from(($("cs-tabs") as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]'));
    const at = tabs.findIndex((tab) => tab.dataset["csCat"] === id);
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (at + 1) % tabs.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (at - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next == null || !tabs[next]) return;
    e.preventDefault(); e.stopPropagation();
    activateCsCat((tabs[next] as HTMLElement).dataset["csCat"] as string, true);
  }

  function pseudoTab(id: string, label: string, sub: string, flagged?: boolean, spoken?: string): HTMLButtonElement {
    const tab = document.createElement("button");
    tab.className = "cs-tab" + (csActiveCat === id ? " active" : "") + (flagged ? " upgraded" : "");
    tab.dataset["csCat"] = id;
    tab.id = csTabId(id);
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "cs-options");
    tab.setAttribute("aria-selected", csActiveCat === id ? "true" : "false");
    tab.tabIndex = csActiveCat === id ? 0 : -1;
    const lbl = document.createElement("span"); lbl.className = "cs-tab-lbl"; lbl.textContent = label;
    const cur = document.createElement("span"); cur.className = "cs-tab-cur"; cur.textContent = sub || "";
    tab.append(lbl, cur);
    tab.setAttribute("aria-label", (spoken || sub) ? label + " — " + (spoken || sub) : label);
    tab.onclick = () => activateCsCat(id, false);
    tab.onkeydown = (e) => csTabKey(id, e);
    return tab;
  }

  function csLabel(text: string): HTMLHeadingElement {
    const h = document.createElement("h3");
    h.className = "sel-label";
    h.textContent = text;
    return h;
  }

  // TEAM & DRIVER — who the car belongs to.
  //
  // The garage owns this, so the title-screen GARAGE route can say whose car it
  // is, not only fit parts and choose a paint job, and "who you are" is not
  // buried inside a track picker. Both controls write straight to the store on
  // click, as the select screen does — picking here IS picking your entry for
  // the next race.
  function buildTeamOptions(optsEl: HTMLElement, team: Team): void {
    // WORK ON CAR pauses the running race without changing its state.
    const pitLocked = (): boolean => G.state === "race";
    const careerLocked = !!Career && !!Career.inCareer && Career.inCareer();
    const identityLocked = (): boolean => pitLocked() || careerLocked;
    const lockReason = pitLocked() ? "Race identity is fixed while working on the active car" : "Your team is fixed by your active career contract";
    optsEl.appendChild(csLabel("TEAM"));

    const card = document.createElement("button");
    card.className = "team-card";
    card.id = "cs-team-card";
    card.setAttribute("aria-haspopup", "dialog");
    card.disabled = !!identityLocked();
    if (identityLocked()) card.title = lockReason;
    const body = document.createElement("span"); body.className = "tm-body";
    const name = document.createElement("span"); name.className = "tm-name"; name.textContent = team.name;
    const sub = document.createElement("span"); sub.className = "tm-sub";
    sub.textContent = [team.short, team.engine].filter(Boolean).join(" · ");
    body.append(name, sub);
    const chev = document.createElement("span");
    chev.className = "tm-chev"; chev.textContent = "▾"; chev.setAttribute("aria-hidden", "true");
    card.append(G.teamSwatch(team), body, chev);
    card.onclick = () => { if (identityLocked()) return; if (G.soundOn) sfx("uiSelect"); G.setTeamPicker(true); };
    optsEl.appendChild(card);

    optsEl.appendChild(csLabel("DRIVER"));
    const row = document.createElement("div");
    row.className = "chip-row"; row.id = "cs-driver";
    row.setAttribute("role", "group"); row.setAttribute("aria-label", "Driver");
    team.drivers.forEach((d, i) => {
      const b = document.createElement("button");
      const taken = (G.peerSeats ? G.peerSeats() : [])
        .some((s) => s.team === team.id && s.driver === i);
      b.className = "sel-chip" + (i === G.driverIdx ? " active" : "");
      b.disabled = taken || !!identityLocked();
      if (taken) b.title = "Taken by the other player";
      else if (identityLocked()) b.title = lockReason;
      b.setAttribute("aria-pressed", i === G.driverIdx ? "true" : "false");
      b.dataset["csDriver"] = String(i);
      // Legends park an unsourced number at 1 (select-screen driverLabel's rule): no "#1" there.
      const num = team.legends && !(d.num > 1) ? "" : `#${d.num} `;
      b.textContent = `${num}${d.name}${taken ? "  · TAKEN" : ""}`;
      b.onclick = () => {
        if (taken || identityLocked() || i === G.driverIdx) return;
        G.driverIdx = i; store.set("driver", i);
        if (G.soundOn) sfx("uiTick");
        buildSetup();
        const again = $("cs-options")?.querySelector<HTMLElement>(`[data-cs-driver="${i}"]`);
        if (again) again.focus({ preventScroll: true });
      };
      row.appendChild(b);
    });
    optsEl.appendChild(row);

    const editRow = document.createElement("div"); editRow.className = "sel-edit-row";
    const edit = document.createElement("button");
    edit.className = "sel-edit"; edit.id = "cs-customize";
    edit.textContent = "✎ EDIT MY TEAM";
    edit.disabled = pitLocked();
    if (pitLocked()) edit.title = lockReason;
    edit.onclick = () => { if (pitLocked()) return; if (G.soundOn) sfx("uiSelect"); G.openCustomize(); };
    editRow.appendChild(edit);
    optsEl.appendChild(editRow);

    // THE GARAGE FILE — parts, liveries, setup sheets and an invented team, for
    // every team, saved out and read back in. It lives HERE rather than beside
    // the settings file in SETTINGS because this is where a player manages the
    // things it carries. The row is built fresh on every rebuild of this tab
    // (js/ui/settings-export.js garageRow), which is why nothing is cached.
    if (deps.settingsExport && deps.settingsExport.garageRow) {
      const row = deps.settingsExport.garageRow();
      if (row) { optsEl.appendChild(csLabel("GARAGE FILE")); optsEl.appendChild(row); }
    }
    // Share-a-code (player-a11y slice 4): pasteable APXS/APXL for this team's
    // setup sheet and active livery. JS-built chips — no new shell nodes.
    const ShareCode = deps.shareCode;
    if (ShareCode && ShareCode.encode) {
      const team = Teams_LIST[G.teamIdx];
      if (team) {
        optsEl.appendChild(csLabel("SHARE CODE"));
        const shareRow = document.createElement("div");
        shareRow.className = "sel-edit-row";
        shareRow.id = "cs-share-code-row";
        const mk = (id: string, label: string, kind: string): HTMLButtonElement => {
          const b = document.createElement("button");
          b.type = "button"; b.className = "sel-chip"; b.id = id; b.textContent = label;
          b.onclick = () => {
            let payload: unknown = null;
            if (kind === "setup") {
              payload = { team: team.id, tune: SetupTuneApi.get(team.id) };
            } else if (kind === "livery") {
              const idLiv = G.getLiveryId ? G.getLiveryId(team.id) : "default";
              const customs = G.getCustomLiveries ? (G.getCustomLiveries(team.id) || []) : [];
              const liv = customs.find((l) => l && l.id === idLiv) || null;
              payload = { team: team.id, id: idLiv, livery: liv || undefined };
            }
            const encoded = ShareCode.encode(kind, payload);
            if (!encoded.ok) { b.textContent = "UNAVAILABLE"; return; }
            const done = (ok: boolean): void => { b.textContent = ok ? "COPIED" : encoded.code; };
            if (deps.clipboard && deps.clipboard.write) {
              deps.clipboard.write(encoded.code).then(() => done(true), () => done(false));
            } else done(false);
          };
          return b;
        };
        shareRow.append(mk("cs-share-setup", "COPY SETUP CODE", "setup"),
          mk("cs-share-livery", "COPY LIVERY CODE", "livery"));
        optsEl.appendChild(shareRow);
      }
    }
  }

  // BACK stays only when DONE is a different door (RACE SETUP from #select).
  // Title / career / pit / lobby: the labelled dismiss is the one foot action.
  function syncGarageExitChrome(): void {
    const root = $("carsetup"), done = $("cs-done");
    if (!root || !done) return;
    if (done.textContent === "RACE SETUP") root.removeAttribute("data-cs-exit");
    else root.setAttribute("data-cs-exit", "one");
  }

  function buildSetup(): void {
    clearSurfaceControls();
    if (GarageSurfaceInspectionApi) GarageSurfaceInspectionApi.end();
    syncGarageExitChrome();
    const team = Teams_LIST[G.teamIdx] as Team;
    // A draft is ONE team's paint: after a team pick it would SAVE & FIT onto the new team.
    if (csLivCreating && csLivTeamId !== team.id) discardLivDraft();
    tuneExperiments.capture(team);
    const parts = getTeamParts(team.id);

    // Remap any saved exclusive option this team can't use onto its universal
    // equivalent (Parts._resolve's peer). Deleting fell through to DEFAULTS and
    // made a locked sig_rb_street photograph as medium instead of supersoft.
    // Only the PERMANENT locks (supplier / team) remap: an era ban is read with the
    // legality suspended (CareerAiDev.worksSetup's pattern), so opening the garage
    // under a ban never deletes a fitted part that comes back when the era lapses.
    let partsChanged = false;
    const legalFn = Parts.legality ? Parts.legality() : null, legalKey = legalFn ? Parts.legalityKey() : "";
    if (legalFn) Parts.setLegality(null, "");
    try {
      for (const cat of Parts.CATALOG) {
        const selId = parts[cat.id];
        if (selId) {
          const opt = cat.options.find((o) => o.id === selId);
          if (opt && !Parts.isOptionAvailable(opt, team)) {
            const eq = opt.equivalent
              && cat.options.find((o) => o.id === opt.equivalent
                && Parts.isOptionAvailable(o, team));
            if (eq) parts[cat.id] = eq.id;
            else delete parts[cat.id];
            partsChanged = true;
          }
        }
      }
    } finally { if (legalFn) Parts.setLegality(legalFn, legalKey); }
    if (partsChanged) saveTeamParts(team.id, parts);

    const owned = G.careerOwned();
    const cap = owned ? Career!.budget() : Parts.BUDGET;
    const unlimited = !owned && G.unlimitedBudget;

    const spent = Parts.getCost(parts, team);
    const remaining = cap - spent;

    ($("cs-team") as HTMLElement).textContent = team.name.toUpperCase();


    const budgetEl = $("cs-budget");
    const budgetFill = $("cs-budget-fill");
    const unlimitedBtn = $("cs-unlimited");
    if (budgetEl) {
      if (unlimited) {
        budgetEl.textContent = "FREE BUILD — no budget limit";
        budgetEl.className = "unlimited";
      } else if (owned) {
        budgetEl.textContent = `BALANCE ${Career!.data().money.toLocaleString()} cr · FITTED `
                             + `${spent.toLocaleString()} / ${cap.toLocaleString()} cr`;
        budgetEl.className = remaining < 0 ? "over" : remaining < 100 ? "tight" : "";
      } else {
        budgetEl.textContent = `BUDGET: ${remaining} / ${cap} cr remaining`;
        budgetEl.className = remaining < 0 ? "over" : remaining < 100 ? "tight" : "";
      }
    }
    if (budgetFill) {
      budgetFill.style.transform = unlimited ? "scaleX(0)" : `scaleX(${clamp(spent / cap, 0, 1)})`;
    }
    if (unlimitedBtn) {
      unlimitedBtn.hidden = !!owned;
      unlimitedBtn.textContent = unlimited ? "∞ FREE BUILD: ON" : "∞ FREE BUILD";
      unlimitedBtn.className = "cs-unlimited-btn" + (unlimited ? " on" : "");
    }

    if (!csActiveCat) csActiveCat = store.get("garageTab", "team") as string;
    if (!PSEUDO_CATS.includes(csActiveCat as string) && !Parts.CATALOG.some((c) => c.id === csActiveCat)) csActiveCat = "team";
    const activeCat = Parts.CATALOG.find((c) => c.id === csActiveCat) as PartCategory;

    // Resolve the currently-fitted option for a category (respecting supplier lock).
    // Mirror Parts._resolve: a locked SIGNATURE shows its equivalent's name
    // (what is actually fitted), not the category default and not the foreign
    // signature label.
    const resolveOpt = (cat: PartCategory): PartOption | undefined => {
      const id = parts[cat.id] || Parts.DEFAULTS[cat.id];
      const sel = cat.options.find((o) => o.id === id);
      if (sel && Parts.isOptionAvailable(sel, team)) return sel;
      if (sel && sel.equivalent) {
        const eq = cat.options.find((o) => o.id === sel.equivalent
          && Parts.isOptionAvailable(o, team));
        if (eq) return eq;
      }
      return cat.options.find((o) => o.id === Parts.DEFAULTS[cat.id]);
    };

    const tabs = $("cs-tabs") as HTMLElement;
    tabs.textContent = "";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Garage categories");
    const primaryTabs = document.createElement("div");
    primaryTabs.className = "cs-tab-row";
    primaryTabs.setAttribute("role", "group");
    primaryTabs.setAttribute("aria-label", "Performance categories");
    const secondaryTabs = document.createElement("div");
    secondaryTabs.className = "cs-tab-row";
    secondaryTabs.setAttribute("role", "group");
    secondaryTabs.setAttribute("aria-label", "Finishing and setup categories");
    tabs.append(primaryTabs, secondaryTabs);
    const appendTab = (id: string, tab: HTMLElement): HTMLElement => (SECONDARY_CATS.has(id) ? secondaryTabs : primaryTabs).appendChild(tab);
    {
      const d = team.drivers[G.driverIdx] || team.drivers[0];
      appendTab("team", pseudoTab("team", "TEAM", d ? d.name.split(" ").pop() as string : team.short));
    }
    for (const cat of Parts.CATALOG) {
      const cur = resolveOpt(cat);
      appendTab(cat.id, pseudoTab(cat.id, cat.tab || cat.label, tabSub(cur),
                                  !!cur && cur.id !== Parts.DEFAULTS[cat.id], cur ? cur.label : ""));
    }
    appendTab("tune", pseudoTab("tune", "SETUP", SetupTuneApi.isDefault(team.id) ? "WORKS" : "TUNED",
                                !SetupTuneApi.isDefault(team.id)));
    {
      const custom = getLiveryId(team.id) !== "default";
      appendTab("livery", pseudoTab("livery", "LIVERY", custom ? "CUSTOM" : "DEFAULT", custom));
    }

    const optsEl = $("cs-options") as HTMLElement;
    optsEl.textContent = "";
    optsEl.setAttribute("role", "tabpanel");
    optsEl.setAttribute("aria-labelledby", csTabId(csActiveCat as string));
    optsEl.tabIndex = 0;
    // LIVERY adds this grid; TEAM and the part cats must not inherit it.
    // Measured 2026-08-18 Playwright MCP: switching LIVERY → TEAM left
    // `cs-liv-grid` on #cs-options, so #cs-team-card painted 91×64 with
    // `.tm-name` at 14px (`McLaren` / `MCL · Mercedes` truncated).
    optsEl.classList.remove("cs-liv-grid");
    const statsEl = $("cs-stats-inner") as HTMLElement;
    if (csActiveCat === "team")   { buildTeamOptions(optsEl, team);   renderStatBars(statsEl, team); return; }
    if (csActiveCat === "livery") { buildLiveryOptions(optsEl, team); renderStatBars(statsEl, team); return; }
    if (csActiveCat === "tune")   { buildTuneOptions(optsEl, team);   renderStatBars(statsEl, team); return; }
    const curOpt = resolveOpt(activeCat);
    const curCost = curOpt ? (curOpt.cost || 0) : 0;
    const showComparison = GarageExperience.partSummary(optsEl, asExpTeam(team), parts, activeCat, curOpt,
      SetupTuneApi.mods(team.id), unlimited ? Infinity : cap,
      () => framePreset(CAT_VIEW[activeCat.id] || "hero"));
    const factorySetup = Parts.getFactorySetup(team);
    // Cheapest first, so a category reads as the ladder it now is. The CATALOG
    // is in authoring order — McLaren's aero tab ran 0, 80, 40, 60, 0, 50 … 110,
    // 95, 185, and its own signature wing was row 18 of 18. Stable within a
    // price: `slice()` first, and ties keep authoring order.
    const shownOpts = activeCat.options.slice()
      .sort((a, b) => (a.cost || 0) - (b.cost || 0));
    for (const opt of shownOpts) {
      if (!Parts.isOptionAvailable(opt, team)) continue;
      const locked = !Parts.isOptionAvailable(opt, team, owned || null);
      const active = curOpt && curOpt.id === opt.id;
      const costDelta = (opt.cost || 0) - curCost;
      const wouldExceed = !active && !unlimited && (spent + costDelta > cap);

      const row = document.createElement("button");
      const restricted = opt.supplier || opt.suppliers || opt.team || opt.teams;
      row.className = "cs-opt" + (active ? " active" : "") + (wouldExceed ? " over-budget" : "")
                    + (locked ? " locked" : "") + (restricted ? " exclusive" : "");
      row.setAttribute("aria-pressed", active ? "true" : "false");
      row.dataset["csOpt"] = opt.id;
      row.dataset["csCat"] = activeCat.id;
      row.addEventListener("focus", () => showComparison(opt));
      row.addEventListener("pointerenter", (ev) => {
        if (ev.pointerType === "touch") return;
        if (typeof matchMedia === "function" && matchMedia("(hover: none)").matches) return;
        showComparison(opt);
      });

      const dot = document.createElement("span"); dot.className = "cs-opt-dot"; row.appendChild(dot);

      const main = document.createElement("div"); main.className = "cs-opt-main";
      const nameRow = document.createElement("div"); nameRow.className = "cs-opt-name";
      nameRow.appendChild(document.createTextNode(opt.label));
      const badges: string[] = [];
      // Leads the row: on a wet compound it is the only badge that explains why
      // all four stat chips are pointing down.
      if (opt.wetTread) badges.push(opt.wetTread > 1 ? "WET" : "INTER");
      if (opt.tag) badges.push(opt.tag);
      if (opt.supplier || opt.suppliers) badges.push("SUPPLIER");
      if ((opt.team || opt.teams) && opt.tag !== "SIGNATURE") badges.push("SIGNATURE");   // the tag already says it
      if (!restricted && !opt.tag) badges.push("UNIVERSAL");
      if (factorySetup[activeCat.id] === opt.id) badges.push("FACTORY SETUP");
      if (badges.length) {
        const tg = document.createElement("span");
        tg.className = "cs-opt-tag";
        const band = opt.wetTread && opt.visual && opt.visual["band"] as readonly number[] | null | undefined;
        if (band && band.length >= 3) {
          const r = Math.round(band[0]! * 255), g = Math.round(band[1]! * 255), b = Math.round(band[2]! * 255);
          tg.style.color = "rgb(" + r + "," + g + "," + b + ")";
          tg.style.background = "rgba(" + r + "," + g + "," + b + ",0.18)";
        }
        tg.textContent = badges.join(" · ");
        nameRow.appendChild(tg);
      }
      main.appendChild(nameRow);
      const deltas = statDeltaChips(opt);
      if (deltas) main.appendChild(deltas);
      // The description shows before the part is FITTED: once fitted is the one
      // moment the player no longer needs it to decide.
      if (opt.desc) { const d = document.createElement("div"); d.className = "cs-opt-desc"; d.textContent = opt.desc; main.appendChild(d); }
      row.appendChild(main);

      const cost = document.createElement("span");
      cost.className = "cs-opt-cost" + (locked ? " research" : opt.cost > 0 ? "" : " free");
      cost.textContent = locked ? "RESEARCH · " + Career!.researchCost(opt).toLocaleString() + " cr"
                       : opt.cost > 0 ? opt.cost + " cr" : "FREE";
      row.appendChild(cost);
      const fitted = getTeamParts(team.id), replacing = resolveOpt(activeCat);
      const shortfall = unlimited ? 0 : Math.max(0, Parts.getCost(fitted, team) - (replacing ? replacing.cost || 0 : 0) + (opt.cost || 0) - cap);
      if (locked && shortfall > 0) {
        const why = document.createElement("div"); why.className = "cs-opt-desc";
        why.textContent = "Research only — cannot fit within current cap (" + shortfall.toLocaleString() + " cr short).";
        main.appendChild(why);
      }
      // A saved career can exist outside career play; only its active round
      // belongs in this purchase decision. Legacy planning APIs remain optional.
      if (locked && typeof Career!.inCareer === "function" && Career!.inCareer() && typeof Career!.planning === "function") {
        const planning = Career!.planning();
        const cash = planning && typeof planning.cash === "function" ? planning.cash(Career!.researchCost(opt)) : null;
        if (cash && !cash.unlimited && [cash.afterPurchase, cash.wages, cash.low].every(Number.isFinite)) {
          const advisory = document.createElement("div"); advisory.className = "cs-opt-desc";
          advisory.textContent = cash.afterPurchase.toLocaleString() + " cr after research · " + cash.wages.toLocaleString()
            + " cr upcoming wages · conservative next-round balance " + cash.low.toLocaleString() + " cr before income (floors at zero). "
            + (cash.afterPurchase < cash.wages ? "Upcoming wages exceed the remaining cash. " : "")
            + "Sponsor income is not guaranteed; this estimate does not block research.";
          main.appendChild(advisory);
        }
      }

      const reject = (): void => {
        row.classList.add("budget-reject");
        row.addEventListener("animationend", () => row.classList.remove("budget-reject"), { once: true });
        // uiReject, not uiTick: with the blip a successful fit plays, only the
        // shake distinguishes a refused purchase, and only if you are looking
        // at that row.
        if (G.soundOn) sfx("uiReject");
      };

      row.onclick = () => {
        if (active) return;
        // ONE CLICK, ONE SOUND. Researching a locked part then fitting it is two
        // steps of one action, and uiSelect on both is an audible double blip on
        // every locked row. Deleting the first is
        // wrong: the unlock can succeed and the fit still refuse on budget below,
        // which returns early, and that blip is the only feedback that path has.
        let _blipped = false;
        if (locked) {
          if (!Career!.research(opt)) { reject(); return; }
          if (G.soundOn) { sfx("uiSelect"); _blipped = true; }
        }
        const p = getTeamParts(team.id);
        // The RESOLVED part's cost — what Parts.getCost counted — not the stored id's
        // (a locked signature costs as its fitted equivalent).
        const co = resolveOpt(activeCat);
        const cc = co ? (co.cost || 0) : 0;
        if (!unlimited && (Parts.getCost(p, team) - cc + (opt.cost || 0)) > cap) {
          if (locked) {
            buildSetup();
            const notice = document.createElement("p"); notice.className = "adv-help";
            notice.setAttribute("role", "status");
            notice.textContent = "Unlocked, not fitted — " + (Parts.getCost(p, team) - cc + (opt.cost || 0) - cap).toLocaleString() + " cr over the fitted cap.";
            ($("cs-options") as HTMLElement).appendChild(notice);
            return;
          }
          reject();
          return;
        }
        p[activeCat.id] = opt.id;
        saveTeamParts(team.id, p);
        if (G.soundOn && !_blipped) sfx("uiSelect");
        buildSetup();
        if (CAT_VIEW[activeCat.id]) framePreset(CAT_VIEW[activeCat.id] as string);   // show the part
        if (deps.scene && deps.scene.pulse) deps.scene.pulse();    // and the bay acknowledges it
        // The rebuild destroyed the focused row; without this a pad/keyboard
        // player's next arrow landed on the category TAB (first .active).
        const again = $("cs-options") && ($("cs-options") as HTMLElement).querySelector<HTMLElement>('[data-cs-opt="' + opt.id + '"]');
        if (again) { try { again.focus({ preventScroll: true }); } catch { again.focus(); } }
      };
      optsEl.appendChild(row);
    }

    renderStatBars(statsEl, team);
  }

  function livSwatch(team: Team, liv: Livery, tags: readonly string[]): HTMLSpanElement {
    const sw = document.createElement("span"); sw.className = "cs-liv-swatch";
    if (LiveryTex && LiveryTex.paintSwatch) {
      const c = document.createElement("canvas");
      c.width = 112; c.height = 80;
      c.setAttribute("aria-hidden", "true");
      LiveryTex.paintSwatch(c.getContext("2d") as CanvasRenderingContext2D, team.id, liv, c.width, c.height);
      sw.appendChild(c);
    } else {
      sw.style.background = "linear-gradient(120deg, " + cssCol(liv.c1) + " 0 56%, " + cssCol(liv.c2) + " 56% 100%)";
      if (liv.stripe) {
        const st = document.createElement("span"); st.className = "cs-liv-stripe";
        st.style.background = cssCol(liv.stripe);
        sw.appendChild(st);
      }
    }
    if (tags && tags.length) {
      for (const label of tags) {
        const tg = document.createElement("span");
        tg.className = "cs-opt-tag";
        tg.textContent = label;
        sw.appendChild(tg);
      }
    }
    return sw;
  }

  // SETUP — the mechanical sheet (./setup-tune.ts): five sliders on the
  // tuner's .tune-row markup (DOM only, no new classes), a RAKE readout, and a
  // coach (./setup-experiments.ts).
  function buildTuneOptions(container: HTMLElement, team: Team): void { tuneExperiments.build(container, team); }

  function buildLiveryOptions(container: HTMLElement, team: Team): void {
    if (csLivCreating) {
      container.classList.remove("cs-liv-grid");
      buildLiveryCreator(container, team);
      return;
    }
    container.classList.add("cs-liv-grid");
    const cur = getLiveryId(team.id);
    const customIds = new Set(getCustomLiveries(team.id).map((l) => l.id));

    // ＋ CREATE row (top so it's always reachable without scrolling the list)
    {
      const row = document.createElement("button");
      row.className = "cs-opt cs-liv cs-liv-create";
      const dot = document.createElement("span"); dot.className = "cs-opt-dot"; row.appendChild(dot);
      const sw = document.createElement("span"); sw.className = "cs-liv-swatch cs-liv-plus"; sw.textContent = "＋"; row.appendChild(sw);
      const main = document.createElement("div"); main.className = "cs-opt-main";
      const nameRow = document.createElement("div"); nameRow.className = "cs-opt-name"; nameRow.textContent = "Create livery";
      main.appendChild(nameRow);
      row.appendChild(main);
      const tag = document.createElement("span"); tag.className = "cs-opt-cost free"; tag.textContent = "NEW"; row.appendChild(tag);
      row.onclick = () => {
        // A blank canvas is blank PAINT, not a different car. Every pill defaults
        // to the plain 2020s shape — a standard shark fin on a standard spine —
        // and no 2026 team runs that: teams.js puts every one of them on
        // finShape "none" + spineHeight "dorsal". So NEW starts on the TEAM'S
        // OWN shape (its livery pills) with none of its detail paint, not a
        // silhouette the player never chose and could only discover by comparing
        // it with the grid: the only thing a new paint job changes is the paint.
        const shape: Record<string, unknown> = {};
        const tl = team.livery as Readonly<Record<string, unknown>> | undefined;
        if (tl) for (const k in LIV_DRAFT_PILLS) if (tl[k]) shape[k] = tl[k];
        csLivDraft = livDraftFrom(Object.assign({ c1: team.color, c2: team.color2 }, shape), "", arrToHex);
        csLivEditId = null;
        csLivCreating = true; csLivTeamId = team.id;
        if (G.soundOn) sfx("uiSelect");
        buildSetup();
      };
      container.appendChild(row);
    }

    for (const liv of getLiveries(team)) {
      const active = liv.id === cur;
      const isCustom = customIds.has(liv.id);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cs-opt cs-liv" + (active ? " active" : "") + (isCustom ? " cs-liv-custom" : "");
      row.dataset["csLivery"] = liv.id;
      row.setAttribute("aria-label", "Select " + liv.name + " livery");
      row.title = liv.name;
      row.setAttribute("aria-pressed", active ? "true" : "false");
      const rowWrap = document.createElement("div");
      rowWrap.className = "cs-liv-row";
      rowWrap.appendChild(row);

      const dot = document.createElement("span"); dot.className = "cs-opt-dot"; row.appendChild(dot);
      const tags: string[] = [];
      if (isCustom) tags.push("MINE");
      if (liv.finish && liv.finish !== "gloss") tags.push(liv.finish.toUpperCase());
      row.appendChild(livSwatch(team, liv, tags));

      const main = document.createElement("div"); main.className = "cs-opt-main";
      const nameRow = document.createElement("div"); nameRow.className = "cs-opt-name";
      nameRow.appendChild(document.createTextNode(liv.name));
      main.appendChild(nameRow);
      row.appendChild(main);

      if (isCustom) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "cs-liv-edit"; edit.textContent = "✎";
        edit.title = "Edit this livery";
        edit.setAttribute("aria-label", "Edit " + liv.name + " livery");
        edit.onclick = () => {
          csLivDraft = livDraftFrom(liv, liv.name || "", arrToHex);
          csLivEditId = liv.id;
          csLivCreating = true; csLivTeamId = team.id;
          if (G.soundOn) sfx("uiSelect");
          buildSetup();
        };
        rowWrap.appendChild(edit);
        const del = document.createElement("button");
        del.type = "button";
        del.className = "cs-liv-del"; del.textContent = "✕";
        del.title = "Delete this livery";
        del.setAttribute("aria-label", "Delete " + liv.name + " livery");
        del.onclick = () => {
          // Arm-then-confirm (G.armConfirm, the career DELETE? idiom): this was
          // one tap from destroying a one-of-a-kind paint job with no undo.
          if (G.soundOn) sfx("uiTick");
          G.armConfirm(del, "✕?", () => {
            setCustomLiveries(team.id, getCustomLiveries(team.id).filter((l) => l.id !== liv.id));
            if (active) saveLiveryId(team.id, "default");
            buildSetup();
          });
        };
        rowWrap.appendChild(del);
      } else {
        const tag = document.createElement("span");
        tag.className = "cs-opt-cost free";
        tag.textContent = active ? "FITTED" : "PAINT";
        row.appendChild(tag);
        const dup = document.createElement("button");
        dup.type = "button";
        dup.className = "cs-liv-edit"; dup.textContent = "⧉";
        dup.title = "Customize a copy of this livery";
        dup.setAttribute("aria-label", "Customize a copy of " + liv.name);
        dup.onclick = () => {
          csLivDraft = livDraftFrom(liv, (liv.name || "Custom").slice(0, 14) + " MK2", arrToHex);
          csLivEditId = null;   // create-new: never overwrites the stock scheme
          csLivCreating = true; csLivTeamId = team.id;
          if (G.soundOn) sfx("uiSelect");
          buildSetup();
        };
        rowWrap.appendChild(dup);
      }

      row.onclick = () => {
        if (active) return;
        saveLiveryId(team.id, liv.id);
        if (G.soundOn) sfx("uiSelect");
        buildSetup();
        // IDs can come from imported paint jobs: compare data, never interpolate
        // an untrusted id into a CSS selector.
        const choices = $("cs-options")?.querySelectorAll<HTMLElement>("[data-cs-livery]") || [];
        for (const choice of Array.from(choices)) if (choice.dataset["csLivery"] === liv.id) { choice.focus({ preventScroll: true }); break; }
      };
      container.appendChild(rowWrap);
    }
  }

  function buildLiveryCreator(container: HTMLElement, team: Team): void {
    const d = csLivDraft as LiveryDraft;   // colours held as hex strings; "" stripe = none
    const wrap = document.createElement("div");
    wrap.className = "cs-liv-editor";

    const head = document.createElement("div"); head.className = "cs-liv-ed-head"; head.textContent = csLivEditId ? "EDIT PAINT JOB" : "NEW PAINT JOB";
    wrap.appendChild(head);

    // Live swatch preview of the current draft (built from hex strings directly).
    const prev = document.createElement("span"); prev.className = "cs-liv-swatch cs-liv-ed-prev";
    wrap.appendChild(prev);

    // CONDITIONAL ROWS. A field that paints onto a part the draft does not have
    // is greyed out, not hidden: FIN SHAPE "none" builds no blade and no fin
    // decal quads (car3d, car-mesh), so TAIL FIN, TAIL GRAPHIC, TAIL STYLE and
    // FIN BADGE all paint nothing until a fin is back. The row keeps its value —
    // choose a fin again and the earlier badge returns — and every control in it
    // is `disabled` for real, so a tap does nothing rather than editing a field
    // the car cannot show. Registered by the row builders; synced on every edit,
    // after refreshPalettes has rebuilt the palette chips it also disables.
    // A dep is a ROW (every control in it) or one PILL (a value that paints
    // nothing under the current draft — SPINE TOP "wordmark" with SPONSORS at
    // "clean" has no name to write). The audit behind the rules, from
    // liverytex.js: TAIL GRAPHIC is the fin motif's wash AND the ink of a number
    // or code badge, so it is dead only when the motif is off and the badge is
    // not a number; NUMBER FONT and the mark colours are always live (the nose
    // number and its crest head paint on every car), so they carry no dep.
    type Dep = { row?: HTMLElement; pill?: HTMLButtonElement; when: () => boolean; why: string };
    const deps_: Dep[] = [];
    let designTools: AttachedEditor | null = null;
    const needFin = (): boolean => (d["finShape"] || "standard") !== "none";
    const NO_FIN = "Needs a tail fin — pick a FIN SHAPE other than NONE";
    const finArtLive = (): boolean => needFin() && ((d["finStyle"] || "team") !== "none" || d["finBadge"] === "number" || d["finBadge"] === "code");
    const NO_ART = "Nothing to colour — TAIL STYLE is NONE and FIN BADGE is not a number or code";
    const haveNames = (): boolean => (d["sponsors"] || "default") !== "clean";
    const NO_NAMES = "Needs sponsor names — SPONSORS is CLEAN";
    const syncDeps = (): void => {
      markAdvice();
      for (const dep of deps_) {
        const off = !dep.when();
        if (dep.pill) { dep.pill.disabled = off; dep.pill.title = off ? dep.why : ""; continue; }
        const row = dep.row as HTMLElement;
        row.setAttribute("aria-disabled", String(off));
        row.title = off ? dep.why : "";
        const ctl = row.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input");
        for (let i = 0; i < ctl.length; i++) (ctl[i] as HTMLButtonElement | HTMLInputElement).disabled = off;
      }
    };
    const applyPreview = (defer3d?: boolean): void => {
      if (designTools) designTools.changed(defer3d);
      prev.style.background = "linear-gradient(120deg, " + d["c1"] + " 0 56%, " + d["c2"] + " 56% 100%)";
      prev.textContent = "";
      if (d["stripe"]) { const st = document.createElement("span"); st.className = "cs-liv-stripe"; st.style.background = d["stripe"]; prev.appendChild(st); }
      const restorePaletteFocus = refreshPalettes();   // a slot's new colour becomes matchable from every other slot
      syncDeps();
      if (restorePaletteFocus && !restorePaletteFocus.disabled) restorePaletteFocus.focus({ preventScroll: true });
      if (defer3d) scheduleLivPreview(team, d); else livePreviewDraft(team, d);
    };

    // MATCHING PALETTE. Twelve slots paint one car, and most paint jobs reuse the
    // same three or four colours across them — but every slot was a bare OS colour
    // dialog, so "the same red as the nose" meant eyeballing hex by hand and
    // getting it nearly right. These chips are the colours already in play: every
    // distinct value in the draft, then the team's own two stock colours. Click
    // one and the slot takes it EXACTLY.
    // The matching chips offer every colour already ON this car, design fills
    // included — from LiveryTex's own list, so a new fill row joins the chips
    // without a second copy of the key names here.
    const PAL_KEYS = ["c1", "c2", "stripe", "noseStripe", "accent", "nose", "pod",
                      "wing", "rearWing", "cover",
                      ...(((LiveryTex && LiveryTex.FILL_SURFACES) || [])
                        .map((f) => f.key)),   // design fills, from the painters' own list
                      "fin", "finArt", "logo", "logo2", "logo3", "halo", "patternTint", "patternSecond"];
    const paletteColours = (): string[] => {
      const seen: string[] = [];
      const add = (v: string | undefined): void => {
        if (!/^#[0-9a-fA-F]{6}$/.test(v || "")) return;
        const u = (v as string).toLowerCase();
        if (seen.indexOf(u) < 0) seen.push(u);
      };
      for (let i = 0; i < PAL_KEYS.length; i++) add(d[PAL_KEYS[i] as string]);
      add(arrToHex(team.color)); add(arrToHex(team.color2));
      return seen;
    };
    const palRows: { el: HTMLElement; key: string; label: string; set: (hex: string) => void }[] = [];   // rebuilt on every edit: the palette IS the other slots
    const refreshPalettes = (): HTMLButtonElement | null => {
      const cols = paletteColours();
      const focused = document.activeElement as HTMLElement | null;
      let replacement: HTMLButtonElement | null = null;
      for (let i = 0; i < palRows.length; i++) {
        const pr = palRows[i]!;
        const ownedFocus = !!focused && pr.el.contains(focused);
        const focusColour = ownedFocus && (focused as HTMLElement).dataset["csColour"];
        pr.el.textContent = "";
        for (let c = 0; c < cols.length; c++) {
          const col = cols[c] as string;
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "cs-liv-ed-none";
          chip.style.background = col;
          chip.dataset["csColour"] = col;
          chip.title = "Use " + col;
          chip.setAttribute("aria-label", "Use colour " + col + " for " + pr.label);
          if ((d[pr.key] || "").toLowerCase() === col) chip.classList.add("active");
          chip.onclick = () => { pr.set(col); };
          pr.el.appendChild(chip);
          if (ownedFocus && (col === focusColour || (!cols.includes(focusColour as string) && col === (d[pr.key] || "").toLowerCase()))) replacement = chip;
        }
      }
      return replacement;
    };

    surfaceControls = GarageSurfaceInspectionApi ? GarageSurfaceInspectionApi.controls(wrap) : null;
    const colorRow = (label: string, key: string, allowNone: boolean): HTMLLabelElement => {
      const r = document.createElement("label"); r.className = "cs-liv-ed-row";
      if (LIV_ROW_HINT[key]) { r.title = LIV_ROW_HINT[key]; r.setAttribute("aria-description", LIV_ROW_HINT[key]); }
      const lb = document.createElement("span"); lb.className = "cs-liv-ed-lbl"; lb.textContent = label; r.appendChild(lb);
      const inp = document.createElement("input"); inp.type = "color";
      inp.dataset["livField"] = key; inp.setAttribute("aria-label", label);
      inp.value = /^#[0-9a-fA-F]{6}$/.test(d[key] as string) ? d[key] as string : "#000000";
      if (allowNone && !d[key]) inp.classList.add("cs-liv-off");
      inp.oninput = () => { d[key] = inp.value; inp.classList.remove("cs-liv-off"); applyPreview(true); };
      inp.onchange = () => { applyPreview(); flushLivPreview(); };
      r.appendChild(inp);
      if (allowNone) {
        const off = document.createElement("button"); off.type = "button"; off.className = "cs-liv-ed-none"; off.textContent = "NONE";
        off.onclick = () => { d[key] = ""; inp.classList.add("cs-liv-off"); applyPreview(); };
        r.appendChild(off);
      }
      const pal = document.createElement("span"); pal.className = "cs-liv-pal";
      palRows.push({ el: pal, key, label,
        set: (hex) => { d[key] = hex; inp.value = hex; inp.classList.remove("cs-liv-off"); applyPreview(); } });
      r.appendChild(pal);
      if (surfaceControls) surfaceControls.row(r, label, key);
      return r;
    };
    // GROUPED BY THE ZONE EACH ROW PAINTS. The sheet is twenty-three colour rows
    // now, and a flat list that long stops being a list — "which of these is the
    // one on the cover crown?" is a question the order should answer, not the
    // hover text. The headings are inert labels, so nothing about focus order,
    // the draft or the save changes; only the reading does.
    const section = (label: string): HTMLDivElement => {
      const r = document.createElement("div"); r.className = "cs-liv-ed-sec";
      r.textContent = label; r.setAttribute("role", "presentation");
      return r;
    };
    wrap.appendChild(section("BODY"));
    const bodyRow = colorRow("PRIMARY", "c1", false); wrap.appendChild(bodyRow);
    wrap.appendChild(colorRow("ACCENT", "c2", false));
    wrap.appendChild(colorRow("BODY STRIPE", "stripe", true));      // full spine: nose → engine cover
    wrap.appendChild(colorRow("NOSE STRIPE", "noseStripe", true));  // nose crown only: tip → bulkhead
    wrap.appendChild(colorRow("DETAIL", "accent", true));   // tertiary paint on flashes/trim/pinstripe
    wrap.appendChild(colorRow("NOSE CAP", "nose", true));
    wrap.appendChild(colorRow("SIDEPOD", "pod", true));
    wrap.appendChild(colorRow("LOWER BODY", "lower", true));   // below the sidepod board's top edge: the two-tone body
    wrap.appendChild(colorRow("UPPER BODY", "upper", true));   // above that line: W17 silver chassis band
    wrap.appendChild(section("ENGINE COVER"));
    wrap.appendChild(colorRow("ENGINE COVER", "cover", true));   // the airbox, roll hoop and cover top
    // Design fills — greyed until the current TOP/SIDE/BIND paints that surface.
    // DESIGN FILLS — the rows that only exist while a design paints their
    // surface. WHICH design paints WHICH fill is LiveryTex's to say (it owns the
    // painters, see FILL_SURFACES): the sheet asks, so a design added to
    // SPINE_LOGO_IDS cannot leave a colour row nobody can spend, and a row
    // cannot go on offering a colour the atlas throws away. The labels and the
    // greyed-out reason come from the same table.
    const LTX = LiveryTex;
    const LT_FILLS = (LTX && LTX.FILL_SURFACES) || [];
    const fillRows = LT_FILLS.map((f) => ({ f, row: colorRow(f.label, f.key, true) }));
    for (const { row } of fillRows) wrap.appendChild(row);
    const designNow = (): { spineLogo: string | undefined; spineSide: string | undefined; coverBind: string | undefined } =>
      ({ spineLogo: d["spineLogo"], spineSide: d["spineSide"], coverBind: d["coverBind"] });
    for (const { f, row } of fillRows) {
      deps_.push({ row, when: () => !LTX || !LTX.fillInert!(f.key, designNow()), why: f.why });
    }
    // WINGS is the flap colour, front and rear; REAR WING is the rear mainplane
    // block (the SF-26's IBM blue). Both paint nothing when the flaps are carbon.
    wrap.appendChild(section("WINGS & TAIL"));
    const wingRow = colorRow("WINGS", "wing", true), rearWingRow = colorRow("REAR WING", "rearWing", true);
    wrap.appendChild(wingRow); wrap.appendChild(rearWingRow);
    const flapsPainted = (): boolean => (d["wingCarbon"] || "paint") !== "carbon";
    const NO_PAINT = "Nothing to colour — WING FLAPS is CARBON";
    deps_.push({ row: wingRow, when: flapsPainted, why: NO_PAINT }, { row: rearWingRow, when: flapsPainted, why: NO_PAINT });
    const finRow = colorRow("TAIL FIN", "fin", true), finArtRow = colorRow("TAIL GRAPHIC", "finArt", true);
    wrap.appendChild(finRow); wrap.appendChild(finArtRow);
    deps_.push({ row: finRow, when: needFin, why: NO_FIN }, { row: finArtRow, when: finArtLive, why: NO_ART });
    // Per-team mark rows: LiveryTex.markSlots names the shape each picker paints
    // on THIS mark, so a player choosing Racing Bulls sees RB LETTERS, BULL and
    // OUTLINE rather than rows that could mean anything. The LENGTH is the mark's
    // to decide — two rows for a single-loop silhouette that has no second shape,
    // three for a mark that does — so this loops rather than indexing.
    const mSlots = (LiveryTex && LiveryTex.markSlots)
      ? LiveryTex.markSlots(team.id)
      : [{ key: "logo", label: "TEAM LOGO" }, { key: "logo2", label: "LOGO DETAIL" },
         { key: "logo3", label: "OUTLINE" }];
    wrap.appendChild(section("TEAM MARK"));
    for (const slot of mSlots) wrap.appendChild(colorRow(slot.label, slot.key, true));
    // ADVISE, NEVER OVERRIDE. The colour you pick for the mark is painted as
    // picked, with no hidden re-pick to a readable colour, so this note is the
    // only thing between a pale pick on a
    // pale cover and a car with no visible mark. It names the surface, the ratio
    // and the fix (an OUTLINE, the same row team data uses for the same job).
    const markNote = document.createElement("div");
    markNote.className = "cs-opt-desc";   // the sheet's existing small-text style (no new class)
    markNote.setAttribute("aria-live", "polite");
    markNote.hidden = true;
    wrap.appendChild(markNote);
    function markAdvice(): void {
      const LTn = LiveryTex;
      if (!LTn || !LTn.contrast || !d["logo"]) { markNote.hidden = true; return; }
      const logo = hexToArr(d["logo"]);
      const field = hexToArr(d["cover"] || d["c1"] as string);
      const ratio = LTn.contrast(logo, field);
      const rim = d["logo3"] ? LTn.contrast(hexToArr(d["logo3"]), field) : 0;
      const weak = ratio < (LTn.MARK_FLOOR || 4.2) && rim < (LTn.MARK_FLOOR || 4.2);
      markNote.hidden = !weak;
      if (weak) {
        markNote.textContent = "TEAM LOGO reads " + ratio.toFixed(1) + ":1 on ENGINE COVER — it is painted as picked. "
          + (d["logo3"] ? "The OUTLINE does not separate either; pick a darker or lighter one."
                        : "Add an OUTLINE to keep it legible.");
      }
    }
    wrap.appendChild(section("COCKPIT"));
    wrap.appendChild(colorRow("HALO", "halo", true));
    wrap.appendChild(colorRow("RIM", "rimTint", true)); wrap.appendChild(colorRow("CALIPER", "caliperTint", true)); wrap.appendChild(colorRow("SIDEWALL INK", "sidewallInk", true));   // WHEELS & BRAKES section (livery-design-editor.ts)
    wrap.appendChild(colorRow("MIRROR HOUSING", "mirrorTint", true));
    // HELMET section rows: appended like every other row (the editor only collects rows that are on the page)
    const lidStyled = (): boolean => (d["helmetStyle"] || "team") !== "team";
    const NO_LID = "Needs a HELMET style other than TEAM";
    const lidBaseRow = colorRow("HELMET BASE", "helmetBase", true), lidAccentRow = colorRow("HELMET ACCENT", "helmetAccent", true);
    wrap.appendChild(lidBaseRow); wrap.appendChild(lidAccentRow);
    deps_.push({ row: lidBaseRow, when: lidStyled, why: NO_LID });
    deps_.push({ row: lidAccentRow, when: () => lidStyled() && d["helmetStyle"] !== "solid", why: "Needs a HELMET style with a stripe, cap, band or chevron" });
    // One pill row per single-choice field: FINISH (Car3D's surface set — this
    // array and FINISH_SURFACE were two copies and the specs held a third),
    // NUMBER FONT and SPONSORS (LiveryTex's id lists). Same nodes and classes.
    const pillRow = (label: string, key: string, values: readonly string[], dflt: string): HTMLDivElement => {
      const r = document.createElement("div"); r.className = "cs-liv-ed-row";
      if (LIV_ROW_HINT[key]) { r.title = LIV_ROW_HINT[key]; r.setAttribute("aria-description", LIV_ROW_HINT[key]); }
      const lb = document.createElement("span"); lb.className = "cs-liv-ed-lbl"; lb.textContent = label; r.appendChild(lb);
      const group = document.createElement("span"); group.className = "cs-liv-ed-finish";
      group.setAttribute("role", "group"); group.setAttribute("aria-label", label);
      const btns: HTMLButtonElement[] = [];
      for (const f of values) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "cs-liv-ed-none" + ((d[key] || dflt) === f ? " active" : "");
        if (key === "finish") b.dataset["csFinish"] = f; else b.dataset["csPill"] = key + ":" + f;
        b.textContent = GarageLiveryDesignEditor.label(f).toUpperCase();
        b.setAttribute("aria-pressed", String((d[key] || dflt) === f));
        b.onclick = () => {
          d[key] = f;
          for (const other of btns) {
            const on = other === b;
            other.classList.toggle("active", on);
            other.setAttribute("aria-pressed", String(on));
          }
          applyPreview();
        };
        btns.push(b);
        group.appendChild(b);
      }
      r.appendChild(group);
      wrap.appendChild(r);
      return r;
    };
    pillRow("FINISH", "finish", ["gloss", ...Object.keys(Car3DIds.FINISH_SURFACE)], "gloss");
    for (const [label, key] of [["COVER FINISH", "coverFinish"], ["WING FINISH", "wingFinish"], ["HALO FINISH", "haloFinish"],
      ["SIDEPOD FINISH", "podFinish"], ["FIN FINISH", "finFinish"], ["MIRROR FINISH", "mirrorFinish"]] as const)
      pillRow(label, key, ["inherit", "gloss", ...Object.keys(Car3DIds.FINISH_SURFACE)], "inherit");
    pillRow("WING FLAPS", "wingCarbon", ["paint", "carbon"], "paint");
    const LT = LiveryTex;
    pillRow("NUMBER FONT", "numFont", LT && LT.NUM_FONT_IDS || ["default"], "default");
    pillRow("SPONSORS", "sponsors", LT && LT.SPONSOR_PACK_IDS || ["default"], "default");
    // The tail DESIGN: what the fin is shaped like, what is painted on it, what it
    // carries, and whether the crest also repeats on the spine. Four single-choice
    // fields, so four pill rows — the same node shape as FINISH above.
    pillRow("FIN SHAPE", "finShape", Car3DIds.FIN_SHAPE_IDS || ["standard"], "standard");
    deps_.push({ row: pillRow("TAIL STYLE", "finStyle", LT && LT.TAIL_STYLE_IDS || ["team"], "team"), when: needFin, why: NO_FIN });
    deps_.push({ row: pillRow("FIN BADGE", "finBadge", LT && LT.FIN_BADGE_IDS || ["logo"], "logo"), when: needFin, why: NO_FIN });
    const spineRow = pillRow("SPINE TOP", "spineLogo", LT && LT.SPINE_LOGO_IDS || ["logo"], "logo");
    pillRow("COVER BIND", "coverBind", ["independent", "saddleWrap", "spineOnly"], "independent");
    pillRow("FIN HANDOFF", "finHandoff", ["match", "contrast", "hardCut"], "match");
    // Body details: the T-cam housing colour (the real car-1 / car-2 code) and
    // the engine-cover cooling vents. Both are mesh, so their id lists are Car3D's.
    pillRow("T-CAM", "tcam", Car3DIds.TCAM_IDS || ["team"], "team");
    pillRow("COVER VENTS", "coverVents", Car3DIds.COVER_VENT_IDS || ["none"], "none");
    // How tall the engine-cover crown runs behind the hoop — the no-fin dorsal look.
    pillRow("SPINE HEIGHT", "spineHeight", Car3DIds.SPINE_HEIGHT_IDS || ["standard"], "standard");
    // What the cover's FLANK carries — the number, the mark or the driver code.
    pillRow("SPINE SIDE", "spineSide", LT && LT.SPINE_SIDE_IDS || ["none"], "none");
    pillRow("BODY SPLIT", "bodySplit", ["off", "lr"], "off");
    pillRow("HELMET", "helmetStyle", deps.helmetStyles || ["team"], "team");
    // The pills that write a sponsor name: dead under the CLEAN pack.
    for (const k of ["spineLogo:wordmark", "spineSide:wordmark", "spineSide:duo", "spineSide:title"]) {
      const b = wrap.querySelector<HTMLButtonElement>('[data-cs-pill="' + k + '"]');
      if (b) deps_.push({ pill: b, when: haveNames, why: NO_NAMES });
    }

    const nameRow = document.createElement("label"); nameRow.className = "cs-liv-ed-row";
    const nlb = document.createElement("span"); nlb.className = "cs-liv-ed-lbl"; nlb.textContent = "NAME"; nameRow.appendChild(nlb);
    const name = document.createElement("input"); name.type = "text"; name.className = "cs-liv-ed-name";
    name.maxLength = 18; name.placeholder = "My Livery"; name.value = d["name"] as string;
    name.dataset["livField"] = "name";
    name.oninput = () => { d["name"] = name.value; if (designTools) designTools.changed(true); };
    name.onchange = () => { if (designTools) designTools.changed(false); };
    nameRow.appendChild(name);
    wrap.appendChild(nameRow);

    const btns = document.createElement("div"); btns.className = "cs-liv-ed-btns";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "cs-liv-ed-cancel"; cancel.textContent = "CANCEL";
    cancel.onclick = () => { csLivCreating = false; csLivDraft = null; csLivEditId = null; endLivPreview(team); if (G.soundOn) sfx("uiTick"); buildSetup(); };
    const save = document.createElement("button"); save.type = "button"; save.className = "cs-liv-ed-save"; save.textContent = "SAVE & FIT";
    save.onclick = () => {
      const now = Teams_LIST[G.teamIdx];
      if (team.id !== csLivTeamId || !now || now.id !== csLivTeamId) { discardLivDraft(); buildSetup(); return; }   // the team changed under the editor
      // ALWAYS a fresh id, edits included: every body-mesh and decal-atlas
      // cache keys on the livery id, so reusing it on edit served the pre-edit
      // meshes with the new atlas — a mismatched car with no error. A new id
      // makes every id-keyed cache miss naturally; bounded caches evict the
      // orphans, and saveLiveryId below re-points the selection.
      const id = "custom_" + livIdCounter();
      const liv = { id, name: (d["name"] || "").trim() || "Custom", c1: hexToArr(d["c1"] as string), c2: hexToArr(d["c2"] as string) } as Livery;
      Object.assign(liv, livDraftTo(d, false, hexToArr));
      const existing = getCustomLiveries(team.id);
      // Edit-in-place replaces the entry that carried the OLD id; create appends.
      setCustomLiveries(team.id, csLivEditId ? existing.map((l) => (l.id === csLivEditId ? liv : l)) : existing.concat([liv]));
      saveLiveryId(team.id, id);
      csLivCreating = false; csLivDraft = null; csLivEditId = null; endLivPreview(team);
      if (G.soundOn) sfx("uiSelect");
      buildSetup();
    };
    btns.append(cancel, save);
    wrap.appendChild(btns);

    if (deps.liveryDesign) designTools = GarageLiveryDesignEditor.attach(wrap, d, {
      changed: applyPreview, flush: flushLivPreview, preview: (value) => livePreviewDraft(team, value),
      pillRow, spineRow, bodyRow, nameRow, markNote, saveRow: btns,
    });
    container.appendChild(wrap);
    applyPreview();
    // Spine / logo edits need the crown in the car gap the sheet leaves — the
    // default front az puts the nose toward camera and the cover under the
    // panel. Hero is the rear three-quarter the CAMERA presets already use.
    framePreset("hero");   // silent: the editor opening is the action, not the camera
  }

  let _livSeq = 0;
  function livIdCounter(): string { _livSeq = (_livSeq + 1) % 1000; return String(Date.now()) + _livSeq; }

  let _livPreviewKey = "";
  let _livPrevDraft: LiveryDraft | null = null;
  let _livPreviewTimer: ReturnType<typeof setTimeout> | null = null, _livPreviewPending: { team: Team; d: LiveryDraft } | null = null;
  function cancelLivPreview(): void {
    if (_livPreviewTimer != null) clearTimeout(_livPreviewTimer);
    _livPreviewTimer = null;
    _livPreviewPending = null;
  }
  function scheduleLivPreview(team: Team, d: LiveryDraft): void {
    if (_livPreviewTimer != null) clearTimeout(_livPreviewTimer);
    _livPreviewPending = { team, d };
    _livPreviewTimer = setTimeout(() => {
      const p = _livPreviewPending;
      _livPreviewTimer = null;
      _livPreviewPending = null;
      if (p) livePreviewDraft(p.team, p.d);
    }, 75);
  }
  function flushLivPreview(): void {
    const p = _livPreviewPending;
    cancelLivPreview();
    if (p) livePreviewDraft(p.team, p.d);
  }
  function livePreviewDraft(team: Team, d: LiveryDraft): void {
    // A paint/design edit invalidates the transient contour's source atlas.
    if (GarageSurfaceInspectionApi && GarageSurfaceInspectionApi.field()) GarageSurfaceInspectionApi.end();
    const key = team.id + "|" + JSON.stringify(d);
    if (key === _livPreviewKey) return;
    const skipMesh = draftSkipsMesh(_livPrevDraft, d);
    _livPreviewKey = key;
    _livPrevDraft = Object.assign({}, d);
    if (invalidateDecalTextures) invalidateDecalTextures(team.id);
    // id:"default" keeps brand plates / markOnField on while editing — a draft
    // without an id skipped the plated-mark path and looked like a bare car.
    G.livDraftOverride = { teamId: team.id,
      liv: Object.assign({ id: "default", c1: hexToArr(d["c1"] as string), c2: hexToArr(d["c2"] as string) }, livDraftTo(d, true, hexToArr)) as PaintJob };
    if (!skipMesh) G._spMeshKey = "";   // bust the setup-preview mesh cache so it repaints
  }

  function endLivPreview(team: Team): void {
    if (GarageSurfaceInspectionApi) GarageSurfaceInspectionApi.end();
    cancelLivPreview();
    _livPreviewKey = "";
    _livPrevDraft = null;
    G.livDraftOverride = null;
    if (invalidateDecalTextures) invalidateDecalTextures(team.id);
    G._spMeshKey = "";
  }

  function openSetup(): void {
    Log.info("ui", "SetupUI.openSetup");
    // A picker left from an earlier garage visit must not sit over pit work.
    if (G.state === "race") G.setTeamPicker(false);
    // Show the garage sheet first, then build its DOM off the click stack.
    // Change Car used to call buildSetup() before unhiding #carsetup, so the
    // select/season screen froze with no sheet (and Back stopped responding).
    if (els.select) els.select.hidden = true;
    if (els.overlay) els.overlay.hidden = true;
    const vs = $("vsfriend"); if (vs) vs.hidden = true;
    const cs = $("carsetup") as HTMLElement;
    const generation = ++csVisitGeneration;
    tuneExperiments.visit(Teams_LIST[G.teamIdx]);
    cs.hidden = false;
    G.setupPreviewOn = true;
    cs.setAttribute("aria-busy", "true");
    const finish = (): void => {
      if (generation !== csVisitGeneration || cs.hidden) return;
      try { buildSetup(); }
      finally { if (generation === csVisitGeneration) cs.removeAttribute("aria-busy"); }
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(finish));
    } else {
      finish();
    }
  }

  // THE PAINT EDITOR DOES NOT OUTLIVE THE GARAGE. Only CANCEL and SAVE & FIT
  // cleared the draft, so BACK/DONE (game.js leaveGarage) — or the race start
  // hiding every .screen under a VS FRIEND guest — left csLivCreating set and
  // G.livDraftOverride live. resolveLivery() reads that override for the
  // player's team, so the next race painted the UNSAVED draft on the car, and the
  // next garage visit re-opened the editor on it. Watching the screen's own
  // `hidden` attribute (the js/ui/sheet-shape.js idiom) needs no new hook in game.js
  // and catches every exit, including the ones that never call this module.
  function discardLivDraft(): void {
    if (!csLivCreating) return;
    csLivCreating = false; csLivDraft = null; csLivEditId = null;
    // The DRAFT's team, not the current one: after a team pick the current one
    // is the new team, and the old team's draft atlas stayed cached (car-draw).
    const team = Teams_LIST.find((t) => t.id === csLivTeamId) || Teams_LIST[G.teamIdx];
    csLivTeamId = null;
    if (team) endLivPreview(team);
  }
  let observer: MutationObserver | null = null;
  function onHidden(): void {
    const cs = $("carsetup");
    if (cs && cs.hidden) { ++csVisitGeneration; cs.removeAttribute("aria-busy"); clearSurfaceControls(); if (GarageSurfaceInspectionApi) GarageSurfaceInspectionApi.end(); discardLivDraft(); tuneExperiments.close(); }
  }
  if (typeof MutationObserver === "function") {
    const cs = $("carsetup");
    if (cs) { observer = new MutationObserver(onHidden); observer.observe(cs, { attributes: true, attributeFilter: ["hidden"] }); }
  }
  function dispose(): void {
    if (observer) { observer.disconnect(); observer = null; }
    ++csVisitGeneration;
    cancelLivPreview();
    clearSurfaceControls();
    discardLivDraft();
    tuneExperiments.close();
  }
  return { buildSetup, openSetup, dispose };
}

export const SetupUI = Object.freeze({ create: createSetupSheet });
