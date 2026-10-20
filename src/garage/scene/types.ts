/**
 * The garage scene's typed seams: the livery, team and frame context the room
 * reads (f1-game passes untyped objects), the renderer facade it draws through
 * (f1-game's `_gfx`, js/render/gfx.js "THE BACKEND INTERFACE CONTRACT"), and
 * the narrow interfaces of every cross-lane module the garage scene calls but
 * does not own. Each injected interface names the f1-game global it replaces
 * and the lane that will provide the real one.
 *
 * Sources: js/garage/scene.js (GarageScene), scene-dress.js, scene-live.js,
 * scene-crew.js, pit-signs.js, prebuild.js, experience.js:103-180.
 */
import type { ColIn, MeshAcc, TexAcc, V3 } from "./prims";

// ── what the room reads ─────────────────────────────────────────────────────

/**
 * A livery as the bay reads it (scene.js rgb(liv.c1 …) and roomKeys): body
 * colours, the accent chain `accent || stripe || c2`, the crest slots and the
 * sponsor pack id. Every member is optional: the bay draws with no livery.
 */
export interface GarageLivery {
  readonly c1?: ColIn;
  readonly c2?: ColIn;
  readonly accent?: ColIn;
  readonly stripe?: ColIn;
  readonly logo?: ColIn;
  readonly logo2?: ColIn;
  readonly logo3?: ColIn;
  readonly sponsors?: string | null | undefined;
}

/** A seat on a team's entry list (team.drivers[i], Career.driverOverride). */
export interface GarageDriver {
  readonly num?: number | string | null | undefined;
  readonly code?: string | null | undefined;
  readonly name?: string | null | undefined;
}

/** A team's stat line (team.stats, GarageExperience.statsOf). */
export type GarageStats = Readonly<Record<string, number | undefined>>;

/** A team as the bay reads it: a Teams.LIST row (src/car/teams.ts) or MY TEAM / LEGENDS. */
export interface GarageTeam {
  readonly id?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly short?: string | null | undefined;
  readonly legend?: string | null | undefined;
  readonly drivers?: readonly (GarageDriver | null | undefined)[] | null | undefined;
  readonly stats?: GarageStats | null | undefined;
}

/** The circuit the next race runs at (a Tracks.LIST entry; `points` may throw on a stub). */
export interface GarageTrack {
  readonly id: string;
  readonly name?: string | null | undefined;
  readonly country?: string | null | undefined;
  readonly points?: readonly (readonly number[])[] | null | undefined;
}

/** The career's achievements block (experience.js:142-180). */
export interface GarageAchievements {
  readonly active?: boolean | undefined;
  readonly facility?: number | undefined;
  readonly facilityMax?: number | undefined;
  readonly wins?: number | undefined;
  readonly podiums?: number | undefined;
  readonly titles?: number | undefined;
}

/**
 * What the ROOM shows of the game beyond the car (scene.js:1080-1083 ctxKey,
 * :1094 draw): the selected circuit, the weather and time of day, the career's
 * tally, plus the per-frame fields setup-camera.js writes (sceneNow, ambient,
 * spin, door). Every field is optional: the bay draws without a career and
 * without a track selection.
 */
export interface GarageCtx {
  readonly track?: GarageTrack | null | undefined;
  readonly weather?: string | null | undefined;
  readonly tod?: string | null | undefined;
  readonly wins?: number | undefined;
  readonly night?: boolean | undefined;
  readonly career?: boolean | undefined;
  readonly round?: number | undefined;
  readonly last?: { readonly dnf?: string | false | null | undefined; readonly p?: number | undefined; readonly pts?: number | undefined } | null | undefined;
  readonly sponsor?: { readonly label?: string | null | undefined } | null | undefined;
  readonly studio?: boolean | undefined;
  readonly achievements?: GarageAchievements | null | undefined;
  readonly unlimited?: boolean | undefined;
  /** The scene clock (ms) setup-camera.js freezes under reduced motion. */
  readonly sceneNow?: number | undefined;
  /** false stops every ambient animation (flicker, pass, traces). */
  readonly ambient?: boolean | undefined;
  /** The auto-turntable is running: the work lamp parks. */
  readonly spin?: boolean | undefined;
  /** Shutter lift 0..1 on an arrival / drive-out (scene.js:637). */
  readonly door?: number | undefined;
}

/** The per-wall groups every prop, LED and dress quad is sorted into (scene.js:170). */
export type Side = "nx" | "px" | "back" | "door" | "mid" | "shutter" | "barrier";
export type Groups = Record<Side, Required<MeshAcc>>;
export type TexGroups<K extends string> = Record<K, TexAcc>;

/** An arrival / drive-out pose (js/garage/arrival.js poseOut): the shutter lift and the car's offset. */
export interface ArrivalPose {
  readonly door: number;
  readonly z?: number | undefined;
  readonly x?: number | undefined;
}

// ── the renderer facade ─────────────────────────────────────────────────────

/** Opaque handles the facade hands back; the scene only stores and returns them. */
export type GfxMesh = object;
export type GfxTexture = object & { readonly _phase?: number };

/** A canvas the atlases paint into: an HTMLCanvasElement or an OffscreenCanvas. */
export interface GarageCanvas {
  width: number;
  height: number;
  getContext(kind: "2d"): GarageCtx2D | null;
}

/** A CanvasGradient. */
export interface GarageGradient {
  addColorStop(offset: number, color: string): void;
}

/**
 * The slice of CanvasRenderingContext2D the garage painters use. Narrow on
 * purpose so a test can hand in a recording stub.
 */
export interface GarageCtx2D {
  fillStyle: string | GarageGradient | object;
  strokeStyle: string | object;
  lineWidth: number;
  lineJoin: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  globalAlpha: number;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): { width: number };
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  stroke(): void;
  fill(): void;
  clip(): void;
  save(): void;
  restore(): void;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): GarageGradient;
}

/** Makes a canvas; f1-game's `document.createElement("canvas")`. */
export type CanvasFactory = (width: number, height: number) => GarageCanvas;

/** The draw-call options the garage passes (scene.js FLOOR_OPTS, SHELL_OPTS, LED_OPTS, MIRROR_RESOLVE …). */
export interface DrawOpts {
  readonly roughness?: number;
  readonly metalness?: number;
  readonly specular?: number;
  readonly clearcoat?: number;
  readonly emissive?: number;
  readonly alpha?: number;
  readonly noAlphaWrite?: boolean;
  readonly depthBias?: readonly number[];
}
/** drawDecal options (scene.js LIVE_OPTS, DRESS_OPTS; pit-signs.js `_opts`). */
export interface DecalOpts {
  readonly glow: number;
}

/**
 * f1-game's renderer facade as the garage scene calls it (js/render/gfx.js;
 * GLX createMesh glx.js:1213, createTexMesh, createTexture, draw, drawDecal).
 * The scene calls draw/drawDecal/freeMesh unguarded and feature-tests the
 * texture members, exactly as scene.js does. ./three.ts is a three.js
 * implementation. TODO(lane-render): the production garage pass (procedural
 * `mat` materials, emissive LEDs, the decal shader, the mirror resolve).
 */
export interface GarageGfx {
  createMesh(data: MeshAcc): GfxMesh;
  createTexMesh?(data: TexAcc): GfxMesh;
  createTexture?(src: GarageCanvas): GfxTexture | null;
  freeMesh(mesh: GfxMesh): void;
  freeTexture?(tex: GfxTexture): void;
  draw(mesh: GfxMesh, matrix: Float32Array, opts: DrawOpts): void;
  drawDecal(mesh: GfxMesh, matrix: Float32Array, tex: GfxTexture, opts: DecalOpts): void;
  readonly isMobile?: boolean | undefined;
  readonly mobileTier?: unknown;
}

// ── injected cross-lane modules ─────────────────────────────────────────────

/** A log sink: f1-game's `Log.info/warn(ns, msg)`; src/data/log.ts by default. */
export interface GarageLog {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
}

/** LiveryTex.paintTeamMark's options (js/car/liverytex.js). */
export interface TeamMarkOpts {
  readonly fullLockup?: boolean;
  readonly halo?: readonly number[] | null;
}

/** A rectangle on a canvas. */
export interface CanvasRect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/**
 * The slice of LiveryTex (f1-game js/car/liverytex.js) the garage atlases
 * paint with. Every member is optional because scene-dress.js / pit-signs.js
 * feature-test each one. TODO(lane-car): pass src/car/liverytex.ts once it is
 * on main (origin/lane-car/liverytex has these names).
 */
export interface GarageLiveryTex {
  paintTeamMark?(ctx: GarageCtx2D, teamId: string | null | undefined, liv: GarageLivery | null | undefined,
    R: CanvasRect, field: unknown, opts?: TeamMarkOpts): void;
  inkOn?(cols: readonly (readonly number[])[]): readonly number[];
  contrast?(a: readonly number[], b: readonly number[]): number;
  markOnField?(teamId: string | null | undefined, liv: GarageLivery | null | undefined): readonly (readonly number[])[];
  readonly LOGOS?: Readonly<Record<string, { readonly _avg?: readonly number[] | null | undefined } | undefined>>;
  readonly SPONSORS?: Readonly<Record<string, readonly string[] | undefined>>;
  readonly SPONSOR_PACKS?: Readonly<Record<string, readonly string[] | undefined>>;
  onMarkChange?(cb: () => void): void;
}

/**
 * The slice of Parts (f1-game js/car/parts.js) the wall boards read;
 * scene.ts CAR_PARTS adapts src/car/parts.ts to it.
 */
export interface GarageParts {
  resolveSetup(setup: unknown, team: GarageTeam): {
    readonly mods: Readonly<Record<string, number>>;
    readonly cost?: number | undefined;
    readonly options: Readonly<Record<string, { readonly label?: string | undefined } | undefined>>;
  };
  displayStat(v: number): number;
  readonly STAT_KEYS: readonly { readonly key: string; readonly label: string }[];
  readonly CATALOG: readonly { readonly id: string; readonly label?: string | undefined }[];
  readonly BUDGET: number;
}

/**
 * The slice of Career (f1-game js/career/*) the boards and seats read.
 * TODO(lane-race): career and My Team.
 */
export interface GarageCareer {
  driverOverride?(teamId: string | null | undefined, seat: number): GarageDriver | null | undefined;
  gridDrivers?(team: GarageTeam): readonly (GarageDriver | null | undefined)[] | null | undefined;
  owned?(teamId: string | null | undefined): boolean;
  data?(): { readonly tdev?: Readonly<Record<string, number>> | null | undefined };
  budget?(): number;
  teamStats?(team: GarageTeam): GarageStats | null | undefined;
}

/**
 * The slice of GarageExperience (f1-game js/garage/experience.js:103-180) the
 * scene calls; ../experience.ts implements it (createGarageExperience), and
 * createGarageScene builds one over its `career` dep by default.
 */
export interface GarageExperienceApi {
  careerKey(ctx: GarageCtx | null | undefined): string;
  paintCareer(cv: GarageCanvas, ctx: GarageCtx | null | undefined): void;
  buildFacility(g: Groups, liv: GarageLivery | null | undefined, ctx: GarageCtx | null | undefined): void;
  statsOf(team: GarageTeam): GarageStats | null | undefined;
}

/** `GameStore.store` as boardInfo reads it: only the revision stamp. TODO(lane-data): src/garage/store.ts. */
export interface GarageStoreRev {
  readonly rev?: number | undefined;
}

/** Tracks.circuitPayloadResident (f1-game js/track/tracks.js). TODO(lane-track). */
export type TrackResident = (track: GarageTrack) => boolean;

/** A V3 re-export so callers can type colours without importing prims. */
export type { V3 };
