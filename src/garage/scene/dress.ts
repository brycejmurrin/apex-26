/**
 * GarageDress: the team dress of the garage bay. The 1024 atlas painters
 * (paintDress, paintBoards), the board data (boardInfo, boardKey,
 * seatDriverAt) and the wall-quad geometry that places the atlas (buildDress).
 *
 * Ported verbatim from f1-game js/garage/scene-dress.js:1-497 (GarageDress).
 * Differences from the IIFE, none of which change a pixel or a vertex:
 * - The globals it read — Career, Parts, GameStore, LiveryTex,
 *   GarageExperience, Log, `document` — are an injected DressDeps
 *   (see ./types.ts for each interface's TODO owner).
 * - The module state (the stamped boardInfo cache and the last painted spec)
 *   is one instance per createGarageDress() call; GarageScene owns one.
 */
import { css, HALF_W, rgb, scale, Z_BACK, Z_DOOR, type TexAcc, type V3 } from "./prims";
import type {
  CanvasFactory, CanvasRect, GarageCanvas, GarageCareer, GarageCtx, GarageDriver, GarageExperienceApi, GarageLivery,
  GarageLiveryTex, GarageLog, GarageParts, GarageStoreRev, GarageTeam, TexGroups,
} from "./types";

/** The atlas size and its regions (scene-dress.js:93-113). */
export const DRESS = 1024;
export const D_CREST: CanvasRect = { x: 0, y: 0, w: 512, h: 512 };
export const D_WORD: CanvasRect  = { x: 512, y: 0, w: 512, h: 128 };
export const D_BOARD: CanvasRect = { x: 512, y: 160, w: 256, h: 352 };
export const D_SCREEN: CanvasRect = { x: 0, y: 512, w: 512, h: 256 };
// The information boards. Everything a player is deciding on lived only in the
// 2D panel; these put it in the room, on the wall you are already looking at.
export const D_STATS: CanvasRect  = { x: 512, y: 512, w: 512, h: 256 };
export const D_DRIVER: CanvasRect = { x: 768, y: 128, w: 256, h: 256 };
export const D_SPEC: CanvasRect   = { x: 0, y: 768, w: 512, h: 256 };
export const D_BUDGET: CanvasRect = { x: 512, y: 768, w: 512, h: 128 };
// The free 256x128 block below DRIVER: a wide team wordmark for the floor and
// the lit sign over the door, drawn light-on-dark so it works on both.
export const D_SIGN: CanvasRect = { x: 768, y: 384, w: 256, h: 128 };
// The last free block, 512x128 under BUDGET. The -X pit board has existed since
// the back wall was mirrored but no dress quad was ever placed on it, so a
// team-branded panel rendered as a blank dark box in 41% of the FRONT frame.
// It gets its OWN graphic rather than a second copy of the driver board: two
// identical boards on one wall read as a copy-paste, and a real garage's second
// board is the strategy call, not the drivers again.
export const D_STRAT: CanvasRect = { x: 512, y: 896, w: 512, h: 128 };

/** What the boards report (scene-dress.js:72-73). */
export interface BoardInfo {
  stats: { value: number; delta: number }[];
  spec: { cat: string; label: string }[];
  driver: GarageDriver;
  budget: number;
  unlimited: boolean;
  left: number;
}

/** The parts handle the boards read: career mode substitutes its own fitted set. */
export type GetParts = (teamId: string | null | undefined) => unknown;

/** Everything GarageDress reads from outside the garage. */
export interface DressDeps {
  /** LiveryTex (f1-game js/car/liverytex.js). TODO(lane-car). */
  readonly livery?: GarageLiveryTex | null | undefined;
  /** Parts (f1-game js/car/parts.js); scene.ts passes CAR_PARTS (src/car/parts.ts). */
  readonly parts?: GarageParts | null | undefined;
  /** Career. TODO(lane-race). */
  readonly career?: GarageCareer | null | undefined;
  /** GarageExperience.statsOf. TODO(lane-data): js/garage/experience.js. */
  readonly experience: Pick<GarageExperienceApi, "statsOf">;
  /** GameStore.store (its `rev`). TODO(lane-data): src/garage/store.ts. */
  readonly store?: GarageStoreRev | null | undefined;
  readonly log: GarageLog;
  /** `document.createElement("canvas")`. */
  readonly createCanvas: CanvasFactory;
}

/** The wall groups the dress quads are sorted into (scene.ts SIDES). */
export type DressGroups<K extends string> = TexGroups<K>;

export interface GarageDressApi {
  seatDriverAt(team: GarageTeam | null | undefined, idx: number): GarageDriver | null;
  boardInfo(team: GarageTeam | null | undefined, getParts: GetParts | null | undefined, driverIdx: number,
    ctx: GarageCtx | null | undefined): BoardInfo | null;
  boardKey(info: BoardInfo | null | undefined): string;
  paintDress(team: GarageTeam, liv: GarageLivery | null | undefined, info?: BoardInfo | null): { canvas: GarageCanvas };
  paintBoards(cv: GarageCanvas, team: GarageTeam, liv: GarageLivery | null | undefined, info: BoardInfo | null | undefined): void;
  buildDress<K extends string>(SIDES: readonly K[]): DressGroups<K>;
  resetSpec(): void;
  releaseDress(): void;
}

// A signature of everything the boards render, for the dress cache key. Without
// the parts and the seat in here the numbers freeze the instant you fit a part
// — the texture would never be repainted. scene-dress.js:82-91
export function boardKey(info: BoardInfo | null | undefined): string {
  if (!info) return "-";
  let k = `${info.unlimited ? "U" : info.left}|${info.driver.num == null ? "-" : info.driver.num}`;
  for (let i = 0; i < info.stats.length; i++) k += `|${info.stats[i]!.value}`;
  for (let i = 0; i < info.spec.length; i++) k += `|${info.spec[i]!.label}`;
  return k;
}

// UV rect for an atlas region. v is flipped because createTexture uploads with
// FLIP_Y, exactly as carDecalData's uvOf does — but U is NOT pre-flipped here:
// that flip exists to un-mirror the car, which draws through MAT_REFLECT_X
// (det -1). These quads are world-space on the identity, so flipping U would
// mirror every logo in the bay. scene-dress.js:356-363
export function uvOf(r: CanvasRect): { uL: number; uR: number; vT: number; vB: number } {
  return { uL: r.x / DRESS, uR: (r.x + r.w) / DRESS, vT: 1 - r.y / DRESS, vB: 1 - (r.y + r.h) / DRESS };
}
/** corners in [BL, BR, TR, TL] as seen from the front of the quad. scene-dress.js:364-374 */
export function dquad(out: TexAcc, c: readonly V3[], n: V3, region: CanvasRect): void {
  const u = uvOf(region), i = out.pos.length / 3;
  const uvs = [[u.uL, u.vB], [u.uR, u.vB], [u.uR, u.vT], [u.uL, u.vT]] as const;
  for (let k = 0; k < 4; k++) {
    out.pos.push(c[k]![0], c[k]![1], c[k]![2]);
    out.nrm.push(n[0], n[1], n[2]);
    out.uv.push(uvs[k]![0], uvs[k]![1]);
  }
  out.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
}

// Grouped by wall, exactly like the props and for a sharper reason: drawDecal
// calls setCull(false), so a decal is DOUBLE-SIDED and does NOT cull with the
// wall it is painted on. Without this split, standing outside the bay you read
// the near wall's wordmark through the culled-away wall, mirrored.
// scene-dress.js:375-487. `SIDES` must include back, nx, px, mid, door, shutter.
export function buildDress<K extends string>(SIDES: readonly K[]): DressGroups<K> {
  const g = {} as Record<string, TexAcc>;
  for (let i = 0; i < SIDES.length; i++) g[SIDES[i]!] = { pos: [], nrm: [], uv: [], idx: [] };
  const grp = (k: string): TexAcc => g[k]!;
  const zb = Z_BACK + 0.03, zd = Z_DOOR - 0.03, xw = HALF_W - 0.03;
  // Back wall: the crest lightbox, the wordmark under it, and the pit board.
  // Height is framing, not decoration, and the ceiling here is MEASURED, not
  // guessed. The FRONT preset puts the eye at (0, 2.08, 8.28) looking at
  // SP_CAR_CTR through a 36 deg vertical fov; solving NDC.y = 1 on the plane
  // z = Z_BACK gives y = 3.76 as the exact top of the frame. A crest topped at
  // 3.75 is therefore touching the edge — its border reads as cut off — which
  // is what three successive "lower it a bit" passes kept rediscovering.
  // 3.40 is the same mark with a visible margin above it, and a fully visible
  // crest reads BIGGER than a taller one whose frame is sliced.
  // Raised 1.20-3.40 -> 1.30-3.50 to open a gap for the lightbox sill. The
  // wordmark below tops out at 1.15 and the FRONT frame tops out at 3.76, so
  // this is the whole budget: 15 cm under the crest, 26 cm over it.
  dquad(grp("back"), [[-1.45, 1.30, zb], [1.45, 1.30, zb], [1.45, 3.50, zb], [-1.45, 3.50, zb]], [0, 0, 1], D_CREST);
  dquad(grp("back"), [[-2.6, 0.42, zb], [2.6, 0.42, zb], [2.6, 1.15, zb], [-2.6, 1.15, zb]], [0, 0, 1], D_WORD);
  // ON the pit-board panel (x 4.25..5.15, y 1.68..2.92, front face z -6.09).
  // The panel moved from x 3.3 to x 4.70 and this quad did not follow it, so the
  // graphic hung 0.29 m proud of the wall in open air AND covered the right
  // third of the driver board next to it.
  dquad(grp("back"), [[4.30, 1.74, -6.085], [5.10, 1.74, -6.085], [5.10, 2.86, -6.085], [4.30, 2.86, -6.085]], [0, 0, 1], D_BOARD);
  // The -X board, which carried no graphic at all until now. Inset inside the
  // 0.52 x 0.20 half-extent panel above, front face at z -6.09.
  dquad(grp("back"), [[-5.16, 2.26, -6.085], [-4.24, 2.26, -6.085], [-4.24, 2.58, -6.085], [-5.16, 2.58, -6.085]], [0, 0, 1], D_STRAT);
  // Side walls: the wordmark repeated. Corner order is built per side so the
  // text reads the right way round from inside each wall.
  // Side-wall wordmarks, in the y 3.10-3.60 band that both walls have free.
  // At y 2.42-2.92 the -X one would sit behind the monitor bank (0.19 m
  // proud). The deep bay (z -5.40..-2.40) is left to the data boards, so the
  // wordmarks only take the two bays forward of that.
  const wordZ = [[-4.6, -2.4], [-1.1, 1.1], [2.4, 4.6]] as const;
  for (let i = 0; i < wordZ.length; i++) {
    const z0 = wordZ[i]![0], z1 = wordZ[i]![1];
    // i 0 is the deep bay, which now carries a data board on EACH wall.
    if (i > 0) dquad(grp("nx"), [[-xw, 3.10, z1], [-xw, 3.10, z0], [-xw, 3.60, z0], [-xw, 3.60, z1]], [1, 0, 0], D_WORD);
    if (i > 0) dquad(grp("px"), [[xw, 3.10, z0], [xw, 3.10, z1], [xw, 3.60, z1], [xw, 3.60, z0]], [-1, 0, 0], D_WORD);
  }
  // The information boards. Back-wall boards sit in the SAME y 1.3-3.8 band as
  // the crest for the same reason it does: the preview's vertical half-FOV is
  // 18 deg about an aim point at y 0.45 and the back wall is ~14 m out, so a
  // board above ~y 4 is already cropped by the top of the frame.
  // PERFORMANCE DATA ON THE SIDE WALL, IDENTITY ON THE BACK WALL: boards
  // flanking the crest leave the mark ~100 px tall on a 1000 px canvas with a
  // board hard against each side of it.
  // STATS goes on the -X wall, not stacked above SPEC on +X. Solving the FRONT
  // preset's frustum on the plane x = HALF_W puts NDC.y = 1 at about y 3.2
  // there, so a board at y 3.28..4.78 shows nothing but its bottom edge; and
  // the two walls are not symmetric in this framing either, because the docked
  // sheet shifts the visible centre to the LEFT, which pulls -X content toward
  // the middle of the frame and pushes +X content off its right edge. The SIDE
  // preset also looks straight at this wall (the eye is outside +X, which culls
  // it), so the live stats get the one dead-on reading in the whole set.
  dquad(grp("nx"), [[-xw, 1.60, -2.40], [-xw, 1.60, -5.40], [-xw, 3.10, -5.40], [-xw, 3.10, -2.40]], [1, 0, 0], D_STATS);
  // BUDGET and FITTED SPEC stay off +X, which NO camera preset frames: `side`
  // puts the eye at x +11.1 and back-face culls +X entirely, `front` projects
  // that wall to NDC.x ~ +0.43 which is behind the docked setup sheet, and
  // `hero` is ~84 deg off axis — boards a player reads while spending money
  // would be reachable only by spinning the turntable. BUDGET goes under STATS
  // on -X (the wall `side` looks straight at), FITTED SPEC onto the bare left
  // half of the back wall, which is 41% of the `front` frame and already
  // carries the crest and driver boards.
  dquad(grp("nx"), [[-xw, 0.69, -2.40], [-xw, 0.69, -5.40], [-xw, 1.44, -5.40], [-xw, 1.44, -2.40]], [1, 0, 0], D_BUDGET);
  // Square, because D_DRIVER is a square atlas region and a stretched quad would
  // squash the number.
  dquad(grp("back"), [[1.70, 1.75, zb], [3.70, 1.75, zb], [3.70, 3.75, zb], [1.70, 3.75, zb]], [0, 0, 1], D_DRIVER);
  dquad(grp("back"), [[-4.10, 2.15, zb], [-1.70, 2.15, zb], [-1.70, 3.35, zb], [-4.10, 3.35, zb]], [0, 0, 1], D_SPEC);
  // FLOOR WORDMARK at the deep end — the TOP framing is a bare grey expanse and
  // it is the one view where every wall mark is edge-on. D_SIGN, not D_CREST:
  // the crest carries a dark team-colour FIELD, and a dark field on a dark
  // floor lit only by sun+ambient+glow (drawDecal never sees the lamps) is
  // invisible, which is exactly how it rendered. D_SIGN is bright letters on
  // transparent, so it reads as paint on concrete the way a real bay does.
  // y 0.004 clears the floor (0) and the expansion joints (0.002).
  dquad(grp("mid"), [[-2.30, 0.004, -4.15], [2.30, 0.004, -4.15], [2.30, 0.004, -5.95], [-2.30, 0.004, -5.95]],
    [0, 1, 0], D_SIGN);
  // A SECOND floor mark at the door end. The deep-end one reads in the FRONT
  // framing (NDC.y about +0.14, on the floor behind the car) but not in the TOP
  // one: there the camera's right axis is -Z, so negative z lands on the RIGHT
  // of the canvas, under the docked sheet. z +4.1..+5.9 maps to NDC.x about
  // -0.57 — the open floor to the left of the car, which is the one part of the
  // TOP framing that was still bare grey. Corner order keeps U along +X and V
  // along -Z exactly as above, so the winding stays +Y-facing and the letters
  // run the same way; naively translating the first quad forward flips both.
  dquad(grp("mid"), [[-2.30, 0.004, 5.90], [2.30, 0.004, 5.90], [2.30, 0.004, 4.10], [-2.30, 0.004, 4.10]],
    [0, 1, 0], D_SIGN);
  // Lit team sign over the garage door, above the shutter travel (slats top at
  // y 4.77) — the first thing the REAR and door-side framings see.
  // 5 mm in front of the lit fascia's face (z 6.21; the block runs 6.21-6.31,
  // and at z 6.30 this quad was INSIDE it, drawn to nothing), inside the guide
  // rails (x 2.70-2.88) and above the lintel soffit (y 4.78-4.82).
  dquad(grp("door"), [[2.66, 4.83, 6.205], [-2.66, 4.83, 6.205], [-2.66, 4.99, 6.205], [2.66, 4.99, 6.205]], [0, 0, -1], D_SIGN);
  // Engineer screens above the desk, and the notice board by the door.
  dquad(grp("nx"), [[-5.18, 1.10, 2.15], [-5.18, 1.10, -0.95], [-5.18, 2.65, -0.95], [-5.18, 2.65, 2.15]], [1, 0, 0], D_SCREEN);
  // Clear of the shelving (x -4.87..-2.51, up to y 2.06) and the shutter rail.
  dquad(grp("door"), [[4.20, 1.40, zd], [5.20, 1.40, zd], [5.20, 2.75, zd], [4.20, 2.75, zd]], [0, 0, -1], D_BOARD);
  // A wordmark ON THE SHUTTER, not on the wall behind it. The REAR preset puts
  // the eye behind the back wall (which culls), so the door wall is the whole
  // backdrop from there — but the shutter slats stand at z 6.25..6.35 and the
  // dress plane is z 6.37, so a quad on the wall is depth-tested away by the
  // slats and was never visible. z 6.24 puts it on the roller door's face,
  // which is where a real garage brands it anyway.
  // y 2.60..3.20, not 3.30..3.90: the REAR preset's eye is (0, 2.28, -7.95) and
  // the same frustum solve on the plane z = Z_DOOR tops the frame out at y 3.62,
  // so the taller band lost its upper third off the top of the canvas.
  dquad(grp("shutter"), [[2.3, 2.60, 6.24], [-2.3, 2.60, 6.24], [-2.3, 3.20, 6.24], [2.3, 3.20, 6.24]], [0, 0, -1], D_WORD);
  return g as DressGroups<K>;
}

/** One GarageDress (scene-dress.js:3-497). */
export function createGarageDress(deps: DressDeps): GarageDressApi {
  const { career, experience, log } = deps;
  const LiveryTex: GarageLiveryTex = deps.livery || {};

  // ── team dress ─────────────────────────────────────────────────────────────
  // One canvas atlas, one texture, one texMesh, one drawDecal: the same shape as
  // the car's own decal path (js/car/car-mesh.js carDecalData), which is what
  // keeps this to a single extra draw call however many branded surfaces there
  // are. The crest is the real team PNG where LiveryTex has one and its
  // hand-drawn vector crest where it does not — which is also the permanent path
  // for a custom MY TEAM entry, since those never have a PNG.
  // Everything the boards report, gathered in one place from the SAME calls the
  // 2D panel makes. getParts is passed in rather than read from the store because
  // career mode substitutes its own fitted set (js/game.js getTeamParts), and a
  // direct store read would quietly show the wrong car.
  // The race paints Career.driverOverride (MY TEAM seat 0 is you, seat 1 is
  // the hire). The turntable, the wall board and the pit board have to name
  // the same person, not the shipped team.drivers row. scene-dress.js:21-30
  function seatDriverAt(team: GarageTeam | null | undefined, idx: number): GarageDriver | null {
    if (!team) return null;
    const i = idx | 0;
    const over = (career && career.driverOverride)
      ? career.driverOverride(team.id, i) : null;
    if (over) return over;
    const seats = (career && career.gridDrivers)
      ? (career.gridDrivers(team) || team.drivers) : team.drivers;
    return (seats && seats[i]) || (seats && seats[0]) || null;
  }
  // boardInfo used to run Parts.resolveSetup + two .map()s on EVERY garage draw
  // (rebuild early-returns after the key check, but the key needs boardInfo first).
  // Cache on a cheap stamp: team, seat, store.rev (parts/livery), career budget.
  // scene-dress.js:31-81
  let _boardInfo: BoardInfo | null = null, _boardInfoKey = "";
  function boardInfo(team: GarageTeam | null | undefined, getParts: GetParts | null | undefined, driverIdx: number,
    ctx: GarageCtx | null | undefined): BoardInfo | null {
    const Parts = deps.parts;
    if (!Parts || typeof getParts !== "function") return null;
    const rev = deps.store ? deps.store.rev : 0;
    const owned = !!career && !!career.owned && !!team && career.owned(team.id);
    const unlimited = !owned && !!(ctx && ctx.unlimited);
    // tdev folds into the stat bars (Career.teamStats), so a development winter repaints the board.
    const tdev = owned && career!.data ? (((career!.data().tdev || {}) as Record<string, number>)[team!.id as string] || 0) : 0;
    const capStamp = owned ? ("C" + career!.budget!() + ":" + tdev) : unlimited ? "U" : "F";
    const stamp = (team && team.id) + "|" + ((driverIdx as number) | 0) + "|" + rev + "|" + capStamp;
    if (_boardInfo && stamp === _boardInfoKey) return _boardInfo;
    try {
      // ONE resolveSetup call carries everything: it already returns the stat
      // `mods`, the total `cost`, and `options` (the RESOLVED option per category,
      // which is what a supplier-locked fallback actually fitted — not the id the
      // save asked for).
      const t = team!;
      const r = Parts.resolveSetup(getParts(t.id), t);
      const base = experience.statsOf(t) || { speed: 85, accel: 85, cornering: 85, braking: 85 };
      const stats = Parts.STAT_KEYS.map((k) => {
        const b = base[k.key] || 75;
        const value = Math.round(Parts.displayStat(b * r.mods[k.key]!));
        return { value, delta: value - b };
      });
      const spec = Parts.CATALOG.map((cat) => {
        const opt = r.options[cat.id];
        return { cat: String(cat.label || cat.id).toUpperCase(), label: (opt && opt.label) || "Stock" };
      });
      const drv = seatDriverAt(t, driverIdx) || {};
      // THE CAREER CAP, not the free-play constant. js/garage/setup-sheet.js resolves this the
      // same way and enforces against it, but the BUDGET board on the garage wall
      // read Parts.BUDGET (780) unconditionally — so a career at any team whose
      // factory build costs more than that showed "0 cr OF 780 REMAINING" with an
      // empty bar, two metres from a DOM panel reading the true figure, and it
      // stayed at 0 however much was unfitted. Four of the seven starter teams are
      // over 780 on the factory build alone, and MY TEAM is 900.
      const cap = owned ? career!.budget!() : Parts.BUDGET;
      // FREE BUILD has no cap to spend against (the DOM sheet says so): the board
      // prints it instead of "0 cr OF 780 REMAINING" over an empty bar.
      _boardInfo = { stats, spec, driver: drv, budget: cap, unlimited,
               left: unlimited ? 0 : Math.max(0, cap - (r.cost || 0)) };
      _boardInfoKey = stamp;
      return _boardInfo;
    } catch (e) {
      log.warn(`GarageScene boardInfo failed: ${e && (e as Error).message}`);
      _boardInfo = null; _boardInfoKey = "";
      return null;
    }
  }

  // The decal shader sees sun + ambient + uGlow only — never the point lights. So
  // rather than fight that, everything here is painted as SIGNAGE and lit by
  // glow: a modern garage's crest wall IS a lightbox, the pit board IS an LED
  // panel and the monitors ARE emissive. Relative brightness between surfaces is
  // baked into the canvas, because glow is per-draw and there is only one draw.
  // scene-dress.js:115-263
  function paintDress(team: GarageTeam, liv: GarageLivery | null | undefined): { canvas: GarageCanvas } {
    const cv = deps.createCanvas(DRESS, DRESS);
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, DRESS, DRESS);
    const c1 = rgb(liv && liv.c1, [0.30, 0.32, 0.36]);
    const c2 = rgb(liv && (liv.accent || liv.stripe || liv.c2), [0.6, 0.62, 0.66]);
    // ONE team signature, shared by everything on this atlas that must differ
    // between bays but has no data of its own to differ by — the strategy board's
    // stint plan and the engineers' trace shapes. team.id is already in the dress
    // cache key, so nothing extra has to be folded in.
    let sig = 0;
    for (let i = 0; i < String(team && team.id || "").length; i++)
      sig = (sig * 31 + String(team.id).charCodeAt(i)) & 0xffff;
    // Crest lightbox. The FIELD is chosen for contrast against the mark, and a
    // halo is added ONLY when the mark still lacks separation — the same rule
    // buildAtlas applies on the car. The first version passed the team's own c1
    // as the halo unconditionally, which put a same-hue glow behind a mark
    // sitting on a c1-derived field and softened it instead of separating it.
    const img = LiveryTex.LOGOS && LiveryTex.LOGOS[team.id as string];
    // What LANDS on this field, whichever path draws the mark: the uploaded PNG's
    // average for the custom team, else LiveryTex.markOnField — which answers
    // with the BACKING when the mark has one. Asking markBase (the horse, the
    // bulls) was the older question and the wrong one for a plated mark: Ferrari
    // returned a near-black horse, the flip below chose a white lightbox, and a
    // white field then rejected Ferrari's own yellow shield at 1.07 against the
    // 1.6 plate floor — so the wall showed a white horse on a RED shield while
    // the car showed the real black-on-yellow.
    // Keying this on img._avg ALONE is what made the flip below dead code the
    // moment the roster stopped shipping logo PNGs — it would be null for every
    // team, the ternary would always take `tinted`, and every crest would land on
    // a dark field whether or not that is the readable choice.
    const onField: readonly (readonly number[])[] | null = (img && img._avg) ? [img._avg]
      : (LiveryTex.markOnField ? LiveryTex.markOnField(team.id, liv) : null);
    const tinted = scale(c1, 0.30);
    // A dark team field reads best, unless what sits on it is dark against it.
    // WORST-case over the list: a disc-backed mark hands back both the sun and
    // the bulls, because the bulls hang off the sun and land here too.
    const worstOn = (f: V3): number => onField!.reduce(
      (m, c) => Math.min(m, LiveryTex.contrast!(c, f)), Infinity);
    const field = (onField && onField.length && LiveryTex.contrast && worstOn(tinted) < 2.2)
      ? (LiveryTex.inkOn ? LiveryTex.inkOn(onField) as unknown as V3 : [0.93, 0.94, 0.96] as V3) : tinted;
    ctx.fillStyle = css(field); ctx.fillRect(D_CREST.x, D_CREST.y, D_CREST.w, D_CREST.h);
    ctx.strokeStyle = css(c2); ctx.lineWidth = 9;
    ctx.strokeRect(D_CREST.x + 12, D_CREST.y + 12, D_CREST.w - 24, D_CREST.h - 24);
    const inner = { x: D_CREST.x + 40, y: D_CREST.y + 40, w: D_CREST.w - 80, h: D_CREST.h - 80 };
    if (LiveryTex.paintTeamMark) {
      const halo = (img && img._avg && LiveryTex.contrast && LiveryTex.contrast(img._avg, field) < 2.6 && LiveryTex.inkOn)
        ? LiveryTex.inkOn([img._avg]) : null;
      // ONE mark path for the lightbox — same logo / logo2 / logo3 routing as the
      // parts tile and fin badge, scored against the field the crest lands on.
      LiveryTex.paintTeamMark(ctx, team.id, liv, inner, field, { fullLockup: true, halo });
    }
    // Team wordmark strip — the same lockup as the lightbox, left of the name.
    ctx.fillStyle = css(scale(c1, 0.55)); ctx.fillRect(D_WORD.x, D_WORD.y, D_WORD.w, D_WORD.h);
    ctx.fillStyle = css(c2); ctx.fillRect(D_WORD.x, D_WORD.y + D_WORD.h - 9, D_WORD.w, 9);
    const wordMark = { x: D_WORD.x + 12, y: D_WORD.y + 16, w: 96, h: 96 };
    if (LiveryTex.paintTeamMark) {
      LiveryTex.paintTeamMark(ctx, team.id, liv, wordMark, [c1, c2], {});
    }
    ctx.fillStyle = "#f2f3f5";
    ctx.font = "700 48px system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(String(team.name || team.short || "").toUpperCase(),
      D_WORD.x + 120, D_WORD.y + D_WORD.h / 2 - 4, D_WORD.w - 136);
    // Pit board: team header, then the two drivers' numbers and codes.
    ctx.fillStyle = "#0a0b0d"; ctx.fillRect(D_BOARD.x, D_BOARD.y, D_BOARD.w, D_BOARD.h);
    ctx.fillStyle = css(c1); ctx.fillRect(D_BOARD.x, D_BOARD.y, D_BOARD.w, 56);
    ctx.fillStyle = "#f4f5f7"; ctx.font = "700 34px system-ui, sans-serif";
    ctx.fillText(String(team.short || ""), D_BOARD.x + D_BOARD.w / 2, D_BOARD.y + 29);
    const drv = [seatDriverAt(team, 0), seatDriverAt(team, 1)];
    for (let i = 0; i < 2; i++) {
      const d: GarageDriver = drv[i] || {}, top = D_BOARD.y + 78 + i * 140;
      ctx.fillStyle = "#f4f5f7"; ctx.font = "700 88px system-ui, sans-serif";
      ctx.fillText(d.num == null ? "--" : String(d.num), D_BOARD.x + D_BOARD.w / 2, top + 46);
      ctx.fillStyle = css(c2); ctx.font = "700 30px system-ui, sans-serif";
      ctx.fillText(String(d.code || ""), D_BOARD.x + D_BOARD.w / 2, top + 108);
    }
    // Engineer screens: six tiles of plausible telemetry.
    ctx.fillStyle = "#05070a"; ctx.fillRect(D_SCREEN.x, D_SCREEN.y, D_SCREEN.w, D_SCREEN.h);
    for (let t = 0; t < 6; t++) {
      const tx = D_SCREEN.x + (t % 3) * (D_SCREEN.w / 3), ty = D_SCREEN.y + ((t / 3) | 0) * (D_SCREEN.h / 2);
      const tw = D_SCREEN.w / 3 - 6, th = D_SCREEN.h / 2 - 6;
      ctx.fillStyle = "#0b1016"; ctx.fillRect(tx + 3, ty + 3, tw, th);
      // Six identical sine traces in two fixed colours, for eleven teams. The
      // engineers' bank is the -X wall's centrepiece and the SIDE preset looks
      // straight at it, so every bay was quoting the same telemetry. One trace
      // colour now comes from the livery accent, and the waveform is seeded off
      // the team id: same idiom as the strategy board above, and the reason is
      // the same — a shared graphic is a bay that could belong to anyone.
      const tSeed = (sig + t * 7) % 32;
      ctx.strokeStyle = t % 2 ? css(c2) : "#e2a33c"; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let k = 0; k <= 22; k++) {
        const px = tx + 8 + (tw - 16) * (k / 22);
        const py = ty + th * 0.55
          - Math.sin(k * (0.55 + tSeed * 0.035) + t + tSeed) * th * 0.20
          - Math.sin(k * 0.31 + tSeed) * th * 0.07
          - (k % (3 + (tSeed % 4))) * 1.4;
        if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.stroke();
      ctx.strokeStyle = "rgba(120,150,175,0.22)"; ctx.lineWidth = 1;
      for (let gl = 1; gl < 4; gl++) {
        ctx.beginPath(); ctx.moveTo(tx + 6, ty + th * (gl / 4)); ctx.lineTo(tx + tw, ty + th * (gl / 4)); ctx.stroke();
      }
    }
    // Strategy strip: the stint plan, in the team's own colours. Three rows of
    // compound + laps, which is what the second board in a real bay shows.
    {
      const R = D_STRAT;
      ctx.fillStyle = "#07090c"; ctx.fillRect(R.x, R.y, R.w, R.h);
      ctx.fillStyle = css(c1); ctx.fillRect(R.x, R.y, R.w, 26);
      // Light-on-dark or dark-on-light by luminance. The older boards here pin a
      // fixed near-white, which disappears on a pale livery (Haas is white).
      const hi = c1[0] * 0.30 + c1[1] * 0.59 + c1[2] * 0.11 > 0.55;
      ctx.fillStyle = hi ? "#0a0b0d" : "#f4f5f7";
      ctx.font = "700 18px system-ui, sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText("RACE PLAN", R.x + 12, R.y + 13);
      ctx.textAlign = "right";
      ctx.fillText(String(team.short || team.name || "").toUpperCase(), R.x + R.w - 12, R.y + 13);
      const h = sig;
      const COMP = [["SOFT", "#d8443c"], ["MED", "#d8b23c"], ["HARD", "#d8d8d8"]] as const;
      for (let r = 0; r < 3; r++) {
        const y = R.y + 44 + r * 28, c = COMP[(h + r * 2 + (r === 1 ? 1 : 0)) % 3]!;
        ctx.fillStyle = "#101720"; ctx.fillRect(R.x + 10, y - 11, R.w - 20, 22);
        ctx.fillStyle = c[1]; ctx.beginPath(); ctx.arc(R.x + 28, y, 8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#c8d4de"; ctx.font = "600 15px system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(`STINT ${r + 1}   ${c[0]}`, R.x + 46, y);
        ctx.textAlign = "right"; ctx.fillStyle = css(c2);
        ctx.fillText(`${12 + ((h >> (r * 3)) & 7) * 3} LAPS`, R.x + R.w - 18, y);
      }
    }
    // SIGN — the team wordmark on its own, for the floor mark and the lit sign
    // over the door. Transparent field so it reads on whatever it is laid on.
    ctx.clearRect(D_SIGN.x, D_SIGN.y, D_SIGN.w, D_SIGN.h);
    ctx.fillStyle = "#e9ecef"; ctx.font = "700 30px system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(team.name || team.short || "").toUpperCase(),
      D_SIGN.x + D_SIGN.w / 2, D_SIGN.y + D_SIGN.h / 2, D_SIGN.w - 16);
    return { canvas: cv };
  }

  // ── information boards ─────────────────────────────────────────────────────
  // `info` is what the player is actually deciding on. Null (no parts handle
  // yet, or Parts absent) leaves these regions transparent, and the quads then
  // paint nothing rather than showing a board full of zeroes.
  //
  // A SEPARATE PASS over the SAME canvas, because these four regions are the only
  // part of the atlas a part pick changes. One paintDress keyed on everything
  // would repaint the crest lightbox, the wordmarks, the pit board, six
  // telemetry screens and the strategy strip on every brake-duct fit to arrive
  // at the same pixels — and rebuild() would throw the whole bay's geometry away
  // with it. The boards repaint over their own opaque panels, so no clear
  // is needed between passes. scene-dress.js:264-353
  let lastSpec: string[] | null = null;
  function paintBoards(cv: GarageCanvas, _team: GarageTeam, liv: GarageLivery | null | undefined, info: BoardInfo | null | undefined): void {
    if (!info) return;
    const Parts = deps.parts!;
    const ctx = cv.getContext("2d")!;
    const c1 = rgb(liv && liv.c1, [0.30, 0.32, 0.36]);
    const c2 = rgb(liv && (liv.accent || liv.stripe || liv.c2), [0.6, 0.62, 0.66]);
    const panel = (R: CanvasRect, title: string): void => {
      ctx.fillStyle = "#0a0c10"; ctx.fillRect(R.x, R.y, R.w, R.h);
      ctx.fillStyle = css(scale(c1, 0.75)); ctx.fillRect(R.x, R.y, R.w, 44);
      ctx.fillStyle = "#f2f3f5"; ctx.font = "700 27px system-ui, sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(title, R.x + 18, R.y + 23);
      ctx.textAlign = "center";
    };
    // STATS — the same four numbers the panel quotes, from the same curve
    // (Parts.displayStat), so the wall and the panel can never disagree.
    panel(D_STATS, "CAR PERFORMANCE");
    const keys = Parts.STAT_KEYS;
    for (let i = 0; i < keys.length; i++) {
      const st = info.stats[i]!, y = D_STATS.y + 74 + i * 46;
      ctx.textAlign = "left"; ctx.fillStyle = "#9aa4b2"; ctx.font = "700 21px system-ui, sans-serif";
      ctx.fillText(keys[i]!.label, D_STATS.x + 18, y);
      const bx = D_STATS.x + 168, bw = 250;
      ctx.fillStyle = "#191d24"; ctx.fillRect(bx, y - 11, bw, 22);
      ctx.fillStyle = css(c2);
      ctx.fillRect(bx, y - 11, Math.max(2, bw * Math.min(1, st.value / 120)), 22);
      ctx.textAlign = "right"; ctx.fillStyle = "#f2f3f5"; ctx.font = "700 24px system-ui, sans-serif";
      ctx.fillText(String(st.value), D_STATS.x + D_STATS.w - 66, y);
      // The delta against the bare chassis is the whole point of a parts screen.
      ctx.font = "700 18px system-ui, sans-serif";
      ctx.fillStyle = st.delta > 0 ? "#4ad07a" : st.delta < 0 ? "#e2645a" : "#6b7480";
      ctx.fillText(st.delta > 0 ? "+" + st.delta : String(st.delta), D_STATS.x + D_STATS.w - 14, y);
      ctx.textAlign = "center";
    }
    // BUDGET — spent against the cap, with a bar that empties as you spend.
    panel(D_BUDGET, "BUDGET");
    ctx.textAlign = "left"; ctx.fillStyle = "#f2f3f5"; ctx.font = "700 40px system-ui, sans-serif";
    if (info.unlimited) {
      ctx.fillText("FREE BUILD", D_BUDGET.x + 18, D_BUDGET.y + 84);
      ctx.fillStyle = "#8f98a6"; ctx.font = "700 20px system-ui, sans-serif";
      ctx.fillText("NO BUDGET LIMIT", D_BUDGET.x + 18, D_BUDGET.y + 118);
    } else {
      ctx.fillText(`${info.left} cr`, D_BUDGET.x + 18, D_BUDGET.y + 84);
      ctx.fillStyle = "#8f98a6"; ctx.font = "700 20px system-ui, sans-serif";
      ctx.fillText(`OF ${info.budget} REMAINING`, D_BUDGET.x + 190, D_BUDGET.y + 88);
      const rw = D_BUDGET.w - 36;
      ctx.fillStyle = "#191d24"; ctx.fillRect(D_BUDGET.x + 18, D_BUDGET.y + 104, rw, 12);
      ctx.fillStyle = css(c2);
      ctx.fillRect(D_BUDGET.x + 18, D_BUDGET.y + 104, rw * Math.max(0, Math.min(1, info.left / info.budget)), 12);
    }
    ctx.textAlign = "center";
    // DRIVER — the SELECTED seat, not simply the first one on the entry list.
    panel(D_DRIVER, "DRIVER");
    ctx.fillStyle = css(c2); ctx.font = "700 96px system-ui, sans-serif";
    ctx.fillText(info.driver.num == null ? "--" : String(info.driver.num),
      D_DRIVER.x + D_DRIVER.w / 2, D_DRIVER.y + 122);
    ctx.fillStyle = "#f2f3f5"; ctx.font = "700 30px system-ui, sans-serif";
    ctx.fillText(String(info.driver.code || ""), D_DRIVER.x + D_DRIVER.w / 2, D_DRIVER.y + 180);
    ctx.fillStyle = "#9aa4b2"; ctx.font = "600 19px system-ui, sans-serif";
    ctx.fillText(String(info.driver.name || ""), D_DRIVER.x + D_DRIVER.w / 2, D_DRIVER.y + 218, D_DRIVER.w - 20);
    // SPEC — every fitted component, two columns of six. The row that CHANGED
    // since the last paint carries the accent, so the wall answers "what did I
    // just fit" without a glance back at the panel; the marker fades with the
    // next pick because a board full of highlights marks nothing.
    panel(D_SPEC, "FITTED SPEC");
    for (let i = 0; i < info.spec.length && i < 12; i++) {
      const col = i < 6 ? 0 : 1, row = i % 6;
      const sx = D_SPEC.x + 16 + col * (D_SPEC.w / 2), sy = D_SPEC.y + 74 + row * 30;
      const changed = lastSpec && lastSpec[i] !== undefined && lastSpec[i] !== info.spec[i]!.label;
      ctx.textAlign = "left";
      if (changed) { ctx.fillStyle = css(c2); ctx.fillRect(sx - 8, sy - 11, 4, 22); }
      ctx.fillStyle = changed ? css(c2) : "#79828f"; ctx.font = "700 15px system-ui, sans-serif";
      ctx.fillText(info.spec[i]!.cat, sx, sy);
      ctx.fillStyle = "#e8eaee"; ctx.font = "600 17px system-ui, sans-serif";
      ctx.fillText(info.spec[i]!.label, sx + 92, sy, D_SPEC.w / 2 - 112);
      ctx.textAlign = "center";
    }
    lastSpec = info.spec.map((s) => s.label);
  }

  // The boards repaint a changed spec line in a highlight: scene.ts forgets the previous spec on a rebuild (resetSpec) and
  // drops the stamped boardInfo cache too when the room is released. scene-dress.js:489-492
  function resetSpec(): void { lastSpec = null; }
  function releaseDress(): void { lastSpec = null; _boardInfo = null; _boardInfoKey = ""; }

  return Object.freeze({ seatDriverAt, boardInfo, boardKey, paintDress, paintBoards, buildDress, resetSpec, releaseDress });
}
