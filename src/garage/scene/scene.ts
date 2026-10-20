/**
 * GarageScene: the room the setup preview happens in. Bay shell, roof truss,
 * LED fixtures, pit equipment, the floor and the light rig — everything in
 * the garage that is not the car.
 *
 * Ported verbatim from f1-game js/garage/scene.js:1-1419 (GarageScene). Float
 * operation order, draw order and the stride-15 light records are f1-game's.
 *
 * Two layers:
 * - PURE BUILDERS, exported as functions (buildShell, buildTruss, buildProps,
 *   buildPropsLite, buildLed, buildApron, buildPitLane, buildBayFloor,
 *   buildStatic, framingHull, recentre, mk, mirrorSheen …). Deterministic:
 *   same inputs, same arrays, bit for bit. `buildStatic` is the
 *   src/track/scenery/core.ts `GarageCore` the trackside pit row bakes.
 * - THE LIVE ROOM, createGarageScene(deps): f1-game's IIFE module state (the
 *   single-slot mesh caches, the two atlases, the light rig, the preview LRU)
 *   as one instance, with f1-game's public API (init, draw, live, lights,
 *   prepare, prepared, release, previewMesh, spot, pulse, …). It draws through
 *   an injected renderer facade (types.ts GarageGfx; ./three.ts implements it
 *   on three.js).
 *
 * Differences from the IIFE, none of which change a number:
 * - Every global it read is an injected dep (createGarageScene's SceneDeps):
 *   LiveryTex, Parts, Career, GameStore, GarageExperience, Tracks, Log,
 *   performance, document. GarageCrew / GarageDress are this module family's
 *   own ports (crew.ts, dress.ts), one per scene.
 * - BACKDROP is per instance (f1-game mutated one module array that game.js
 *   read each frame); buildApron takes it as a parameter. As in f1-game the
 *   apron is built BEFORE rebuild() writes the new night/day backdrop, so it
 *   fades to the previous room's clear colour (scene.js:1003-1007).
 * - M4.mulTo (recentre) is src/xr/mat4.ts mulTo, the same verbatim port.
 */
import { mulTo } from "../../xr/mat4";
import { Parts, type PartSetup, type PartsTeam } from "../../car/parts";
import { log as dataLog } from "../../data/log";
import { BANDS, BAY, BOX_LEN } from "../../track/core/pit";
import {
  acc, block, CEIL_Y, css, cyl, DARK, HALF_W, MAT, PANEL, panelGrid, pushMat, rgb, scale, smooth, STEEL, tile, tube,
  Z_BACK, Z_DOOR, type MeshAcc, type V3,
} from "./prims";
import { build as buildEquipment, FAN, RUBBER } from "./equipment";
import { build as buildLiveQuads, LIVE, paintLive, paintTrace, type LiveSide } from "./live";
import { createGarageCrew, type GarageCrewApi } from "./crew";
import { boardKey, createGarageDress, type BoardInfo, type GarageDressApi, type GetParts } from "./dress";
import type {
  ArrivalPose, CanvasFactory, DrawOpts, GarageCanvas, GarageCareer, GarageCtx, GarageExperienceApi, GarageGfx,
  GarageLivery, GarageLiveryTex, GarageLog, GarageParts, GarageStoreRev, GarageTeam, GarageTrack, GfxMesh,
  GfxTexture, Groups, Side, TexGroups, TrackResident,
} from "./types";

// The frame clear colour (gfx reads fogColor as the clear) — the "outside" the
// bay is silhouetted against, and what the apron disc's rim fades into.
// scene.js:8-10. The initial value; each scene instance owns a mutable copy.
export const BACKDROP0: V3 = [0.035, 0.038, 0.046];

// SKYLIGHT replaces the preview's old sunColor:[1,1,1]. It has to come down for
// this room to work at all: a lamp's shading is att = win^2/(distC^2+1) with
// distC = max(dist, uLampNearClamp) and the clamp defaulting to 4, so NO lamp
// can ever contribute more than 1/17 = 0.059 of albedo. The preview's old rig
// (energy 0.88) was therefore delivering ~5% of the picture and the sun was
// delivering the rest — which is exactly why it read as a product shot on a
// seamless rather than a room. Ten fixtures at ~10x that energy, against a sun
// dimmed to a roof-light fill, is what puts the lighting back in the lamps.
// scene.js:12-21
export const SKYLIGHT: V3 = [0.55, 0.55, 0.58];
export const AMB_SKY: V3 = [0.200, 0.215, 0.250], AMB_GROUND: V3 = [0.130, 0.125, 0.118];

const DEF_C1: V3 = [0.30, 0.32, 0.36];

// ── the bay shell ──────────────────────────────────────────────────────────
// A CLOSED six-sided room whose every face is wound to be seen from INSIDE.
// That one decision is what lets the preview camera keep its full range: it
// orbits to SP_DIST_MAX (15 m) and to SP_EL_MAX (1.30 rad, eye y ~ 14.9 m), so
// it spends real time outside any room small enough to read as a pit bay. With
// inward faces, a wall the eye has passed is simply back-facing and culls, and
// what you get is a doll's-house cutaway rather than a black screen. The
// transition costs nothing and cannot pop, because the eye crosses a face's
// plane exactly when that face is edge-on and covers zero pixels.
// scene.js:28-140
export function buildShell(out: MeshAcc, liv: GarageLivery | null | undefined): void {
  const c1 = rgb(liv && liv.c1, DEF_C1);
  const c2 = rgb(liv && (liv.accent || liv.stripe || liv.c2), [0.55, 0.57, 0.62]);
  const dado = scale(c1, 0.45), stripe = scale(c2, 0.8);
  // Wall colour by ABSOLUTE height. The walls are three stacked grids whose
  // seams ARE the band edges, so a vertex row exists at each by construction:
  // one uniform grid (nv 6 over a 5 m wall, rows at 0, 0.833, 1.667, 2.5,
  // 3.333, 4.167, 5.0) puts no row in the 1.50-1.62 accent band, and the team
  // dado reads as an 83 cm wash instead of a line.
  // The upper band is the LARGEST surface in the room — 3.38 m of every wall,
  // ~143 m2 across four — so it takes the team tint too, not one frozen grey
  // above a livery dado. A bay should read as the team's from any camera, not
  // only below waist height. Held to 12% of c1 over the grey: it has to stay a
  // BACKDROP for a car that is itself team-coloured, and a saturated wall would
  // fight the thing it is behind.
  const panelC: V3 = [PANEL[0] + (c1[0] - PANEL[0]) * 0.12,
                      PANEL[1] + (c1[1] - PANEL[1]) * 0.12,
                      PANEL[2] + (c1[2] - PANEL[2]) * 0.12];
  const wallAt = (y: number): V3 => (y < 1.4995 ? dado : y < 1.6205 ? stripe : panelC);
  // Battens are BAKED INTO THE WALL's vertex colour rather than modelled as
  // solid posts. A solid post is a prop, and props do not cull with the shell:
  // stood outside the bay you would see a row of dark bars hanging in front of
  // the room whose wall had already culled away. Shading them into the wall
  // means they are the wall, and they come and go exactly when it does.
  //
  // This never worked in its first form: it was keyed on `u * n` where n was
  // the grid's OWN column count, and panelGrid samples u at i/nu — so `u * n`
  // was always an integer and the bright branch was unreachable. Key it off
  // the column INDEX instead, which is what it meant to say.
  const seamed = (col: V3, u: number, n: number): V3 => (Math.round(u * n) % 2 ? scale(col, 0.62) : col);
  // walls: [origin, uVec, vVec, inward normal, u-divisions]
  const W = HALF_W;
  const walls: readonly (readonly [V3, V3, V3, V3, number])[] = [
    [[-W, 0, Z_BACK], [W * 2, 0, 0], [0, CEIL_Y, 0], [0, 0, 1], 8],
    [[-W, 0, Z_DOOR], [W * 2, 0, 0], [0, CEIL_Y, 0], [0, 0, -1], 8],
    [[-W, 0, Z_BACK], [0, 0, Z_DOOR - Z_BACK], [0, CEIL_Y, 0], [1, 0, 0], 9],
    [[W, 0, Z_BACK], [0, 0, Z_DOOR - Z_BACK], [0, CEIL_Y, 0], [-1, 0, 0], 9],
  ];
  // Three stacked bands per wall — dado / accent / panel — instead of one grid
  // with a colour ramp. The seams ARE the band edges, so the accent line is a
  // line rather than an 83 cm gradient between whichever rows happened to fall
  // either side of it. Column count doubled so a batten is a batten and not a
  // half-wall-wide stripe: with 8 columns the alternation reads as panelling.
  const BANDS3 = [[0, 1.50, 2], [1.50, 1.62, 1], [1.62, CEIL_Y, 4]] as const;
  const wallBands = (o0: V3, uVec: V3, nu: number, nrm: V3, y0Lo: number, y1Hi: number): void => {
    for (const [y0, y1, nv] of BANDS3) {
      if (y1 <= y0Lo || y0 >= y1Hi) continue;
      const a = Math.max(y0, y0Lo), b = Math.min(y1, y1Hi);
      panelGrid(out, [o0[0], o0[1] + a, o0[2]], uVec, [0, b - a, 0], nu, nv, nrm,
        (u, v) => seamed(wallAt(a + (b - a) * v), u, nu), MAT.CONCRETE);
    }
  };
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i]!;
    if (i === 1) continue;                       // the door wall, below
    wallBands(w[0], w[1], w[4] * 2, w[3], 0, CEIL_Y);
  }
  // THE DOOR IS A HOLE. The roller shutter is modelled parked half open; as a
  // full-height opaque grid the "opening" under the slats would be interior
  // wall paint — on the REAR preset, whose entire backdrop is this wall, 23%
  // of the frame.
  //
  // The aperture edges sit on COLUMN BOUNDARIES (pitch 10.8/16 = 0.675 m) and
  // each jamb is an EVEN number of columns, so the batten alternation keeps its
  // phase across the split instead of stepping at the seam. y stops at 4.80,
  // just under the parked slats' 4.77, so the shutter reads as filling the top
  // of its own opening.
  const APX = BAY.doorW / 2, APY = BAY.doorH;   // the model's door: 5.4 x 4.8 m of clear air
  for (const sx of [-1, 1])
    wallBands([sx > 0 ? APX : -W, 0, Z_DOOR], [W - APX, 0, 0], 4, walls[1]![3], 0, CEIL_Y);
  wallBands([-APX, 0, Z_DOOR], [APX * 2, 0, 0], 8, walls[1]![3], APY, CEIL_Y);
  // THE OPENING HAD NO THICKNESS. The wall is a zero-thickness grid, so the
  // aperture edge was a bare polygon boundary — no reveal, no lintel, no jamb
  // return, no threshold — and it is the backdrop of the REAR preset, seen
  // through 5.4 x 4.8 m of clear air. A door in a real building is a hole in
  // something 30 cm thick, and that returned edge is the single strongest "this
  // is a building" cue in the room. 0.30 m of reveal, in the shell so it culls
  // with its own wall.
  const RV = 0.30, revC = scale(PANEL, 0.72);
  for (const sx of [-1, 1])                                  // jamb returns
    block(out, sx * APX, APY / 2, Z_DOOR - RV / 2, 0.02, APY / 2, RV / 2, revC);
  block(out, 0, APY, Z_DOOR - RV / 2, APX, 0.02, RV / 2, revC);   // lintel soffit
  // Threshold: a raised sill across the opening, the join between the resin bay
  // floor and the pit apron 4 cm below it.
  block(out, 0, 0.022, Z_DOOR - 0.10, APX, 0.022, 0.10, scale(STEEL, 0.62), MAT.METAL);
  // No material id: the ceiling is HORIZONTAL, and every wall-like id (CONCRETE
  // included) keys its UV off world Y, which is constant here — see the note in
  // buildBayFloor. It is also dark, culled from `top` and above the frame in
  // `front`/`rear`, so there is nothing to gain by finding it a flat-keyed one.
  panelGrid(out, [-W, CEIL_Y, Z_BACK], [W * 2, 0, 0], [0, 0, Z_DOOR - Z_BACK], 4, 4,
    [0, -1, 0], () => DARK);
  // Roof truss is its own mesh (buildTruss): the TOP preset looks down through
  // the ceiling, and the cross-members laid over the car have to hide there.
}
/** scene.js:141-146 */
export function buildTruss(out: MeshAcc): void {
  for (let s = -1; s <= 1; s += 2)
    block(out, s * 2.6, CEIL_Y - 0.42, 0, 0.06, 0.06, (Z_DOOR - Z_BACK) / 2, STEEL, MAT.METAL);
  for (let i = 0; i <= 4; i++)
    block(out, 0, CEIL_Y - 0.42, Z_BACK + (Z_DOOR - Z_BACK) * (i / 4), 2.7, 0.05, 0.06, STEEL, MAT.METAL);
}

// ── props ──────────────────────────────────────────────────────────────────
// Grouped BY WALL, and each group is drawn only while the eye is on the inside
// of its wall. The shell gets this for free from back-face culling; a solid
// prop does not, so without the grouping a tyre stack would hang in mid-air in
// front of a wall that had already culled away. The test is one sign compare.
//
// Everything at FLOOR level sits outboard of x +/-3.6: SP_FIT_HALF_W (3.10) is
// the framing radius the auto-turntable holds, so anything inside that band
// crops into the car's frame at the default distance. It is a floor rule, not
// an absolute one — the ceiling LED housings reach x 2.70 and are fine, because
// they sit at y 4.3, above the top of the frame. scene.js:148-170
export const SIDES: readonly Side[] = ["nx", "px", "back", "door", "mid", "shutter", "barrier"];
/** A fresh set of per-wall accumulators. */
export function groups(): Groups {
  const g = {} as Groups;
  for (let i = 0; i < SIDES.length; i++) g[SIDES[i]!] = acc();
  return g;
}
// The two props the trackside bay (buildPropsLite) shares with the full one.
const COMPOUND: readonly V3[] = [[0.85, 0.12, 0.12], [0.92, 0.80, 0.10], [0.88, 0.88, 0.90]];
function tyreStack(out: MeshAcc, x: number, z: number, seed: number): void {
  for (let t = 0; t < 4; t++) {
    const y = t * 0.345;
    cyl(out, x, y, z, 0.36, 0.33, [0.045, 0.045, 0.050], 14);
    cyl(out, x, y + 0.30, z, 0.305, 0.025, COMPOUND[(seed + t) % 3]!, 14);
  }
}
function toolChest(out: MeshAcc, x: number, z: number, c1: V3): void {
  const sgn = x > 0 ? -1 : 1;
  block(out, x, 0.62, z, 0.36, 0.52, 0.80, scale(c1, 0.55));
  block(out, x, 1.16, z, 0.38, 0.03, 0.82, STEEL);
  for (let d = 0; d < 4; d++) {
    block(out, x + sgn * 0.37, 0.26 + d * 0.24, z, 0.012, 0.09, 0.72, scale(STEEL, 0.8));
    block(out, x + sgn * 0.39, 0.26 + d * 0.24, z, 0.010, 0.02, 0.20, scale(STEEL, 1.15));   // drawer pull
  }
  for (let w = 0; w < 4; w++)
    cyl(out, x + (w % 2 ? 0.26 : -0.26), 0, z + (w < 2 ? 0.6 : -0.6), 0.05, 0.10, DARK, 6);
}
// THE TRACKSIDE BAY'S FURNITURE — what reads from the lane at twenty metres:
// tyre stacks in both door corners and two more OUT on the apron in front of
// the jambs (the set going on, the set that came off), a wheel trolley beside
// them, a tool chest each side, the front jack. A subset of buildProps on
// purpose: twelve of these ride every circuit's static buffer, and the
// pit-complex tests pin a bay's vertex count. scene.js:190-206
export function buildPropsLite(g: Groups, liv: GarageLivery | null | undefined): void {
  const c1 = rgb(liv && liv.c1, DEF_C1);
  tyreStack(g.nx, -4.55, 5.30, 0); tyreStack(g.px, 4.55, 4.6, 2);
  toolChest(g.nx, -4.92, 3.6, c1); toolChest(g.px, 4.92, -1.5, c1);
  tyreStack(g.door, -4.3, Z_DOOR + 0.55, 1); tyreStack(g.door, 4.3, Z_DOOR + 0.55, 0);
  block(g.door, -3.15, 0.30, Z_DOOR + 0.62, 0.55, 0.03, 0.34, STEEL);   // the wheel trolley
  for (let w = 0; w < 4; w++)
    cyl(g.door, -3.15 + (w % 2 ? 0.42 : -0.42), 0, Z_DOOR + 0.62 + (w < 2 ? 0.24 : -0.24), 0.05, 0.27, scale(STEEL, 0.7), 6);
  block(g.mid, 1.55, 0.12, 4.35, 0.55, 0.05, 0.12, scale(STEEL, 0.8));   // the front jack, beside the nose
  cyl(g.mid, 1.55, 0.12, 4.55, 0.03, 0.85, STEEL, 6);
}
/** scene.js:207-413 */
export function buildProps(g: Groups, liv: GarageLivery | null | undefined): void {
  const c1 = rgb(liv && liv.c1, DEF_C1);
  const stack = tyreStack;
  const toolbox = (out: MeshAcc, x: number, z: number): void => toolChest(out, x, z, c1);
  // -X wall: the engineers' monitor bank and desk, plus a tyre stack.
  toolbox(g.nx, -4.92, 3.6);
  // The -X stacks stand in the DOOR corner, not the deep bay: at z -5.4 and
  // -3.1 they were 0.46 m in front of the BUDGET board (y 0.69-1.44, z
  // -5.4..-2.4) at exactly its height, and the SIDE preset read the board
  // with a tyre stack over each end (the sign-occlusion test holds it).
  stack(g.nx, -4.55, 5.30, 0); stack(g.nx, -4.55, 6.02, 2);
  block(g.nx, -5.30, 1.90, 0.6, 0.05, 0.80, 1.60, DARK);
  for (let m = 0; m < 6; m++)
    block(g.nx, -5.22, 1.45 + (m < 3 ? 0 : 0.90), 0.6 + ((m % 3) - 1) * 0.98, 0.03, 0.36, 0.46, scale(STEEL, 0.55));
  block(g.nx, -5.02, 0.86, 0.6, 0.30, 0.03, 1.30, scale(STEEL, 0.9));
  for (let s = -1; s <= 1; s += 2) cyl(g.nx, -5.02, 0, 0.6 + s * 1.15, 0.04, 0.86, STEEL, 6);
  // +X wall: the tool trolleys.
  toolbox(g.px, 4.92, -3.4); toolbox(g.px, 4.92, -1.5); toolbox(g.px, 4.92, 0.4);
  stack(g.px, 4.55, -5.4, 1); stack(g.px, 4.55, 4.6, 2);
  // Back wall: the pit board.
  cyl(g.back, 4.70, 0, -6.15, 0.03, 1.80, STEEL, 6);
  block(g.back, 4.70, 2.30, -6.12, 0.45, 0.62, 0.03, DARK);
  // The back wall is 41% of the FRONT preset's frame and carried 56 triangles:
  // one pit board and a radio post, both on +X, with the whole -X half bare.
  // Mirror the board, then run a cable ladder across at truss height with a
  // junction box under each hanger — the two things every real garage wall has
  // and the cheapest way to give 41% of a frame something to look at.
  cyl(g.back, -4.70, 0, -6.15, 0.03, 1.80, STEEL, 6);
  // Landscape, not a mirror of the +X board: this one carries the strategy
  // strip (D_STRAT), which is 4:1, and a portrait panel would letterbox it.
  block(g.back, -4.70, 2.42, -6.12, 0.52, 0.20, 0.03, DARK);
  block(g.back, -4.70, 1.92, -6.12, 0.44, 0.16, 0.025, scale(STEEL, 0.45));
  block(g.back, 0, 4.22, -6.20, 5.10, 0.035, 0.10, scale(STEEL, 0.8));
  block(g.back, 0, 4.34, -6.20, 5.10, 0.030, 0.08, scale(STEEL, 0.65));
  for (let i = -4; i <= 4; i++) {
    block(g.back, i * 1.15, 4.28, -6.20, 0.025, 0.10, 0.085, scale(STEEL, 0.55));
    if (i % 2) block(g.back, i * 1.15, 3.92, -6.17, 0.16, 0.20, 0.09, scale(STEEL, 0.45));
  }
  // Door wall: the roller shutter, parked half open. 22 m2, and the entire
  // backdrop of the REAR preset — it was grey steel for every team with one
  // wordmark decal floating on it. The slats now alternate steel and a dark
  // team tint, which is what a sponsored roller door actually looks like and
  // costs nothing but a colour.
  const shutA = scale(STEEL, 0.75), shutB: V3 = [
    STEEL[0] * 0.42 + c1[0] * 0.34, STEEL[1] * 0.42 + c1[1] * 0.34, STEEL[2] * 0.42 + c1[2] * 0.34];
  for (let i = 0; i < 11; i++)
    block(g.shutter, 0, 2.05 + i * 0.26, Z_DOOR - 0.10, HALF_W * 0.72, 0.12,
          (i % 2) ? 0.035 : 0.05, (i % 3) ? shutA : shutB, MAT.METAL);
  block(g.shutter, 0, 1.98, Z_DOOR - 0.10, HALF_W * 0.74, 0.07, 0.07, scale(STEEL, 1.1));
  // Guide rails up both jambs, so the shutter runs in something. In g.door with
  // the wall, not in g.mid: a rail left standing after its wall culled is the
  // floating-strip defect this file already fixed once for the dado lights.
  for (const sx of [-1, 1]) {
    block(g.door, sx * 2.79, 2.50, Z_DOOR - 0.10, 0.09, 5.00, 0.13, scale(STEEL, 0.9));
    block(g.door, sx * 2.79, 0.10, Z_DOOR - 0.16, 0.13, 0.20, 0.26, scale(STEEL, 0.6));
  }
  // The upper side walls carry 2.2 m2 of wordmark over 29 m2 of wall, and that
  // band is 22% of the SIDE preset — the one view that looks straight at them.
  // A service gantry per side: a shelf, its brackets, and a rail. ABOVE the
  // wordmark band (y 3.10-3.60): a shelf at 3.42 with clips at z 0 hides every
  // wordmark's top third from the SIDE preset and notches the middle one with
  // a clip. Brackets from 3.62, shelf at 3.84, rail and clips to 4.24 — under
  // the fill fixtures' 4.32 housings.
  for (const sd of [-1, 1]) {
    const w = sd < 0 ? g.nx : g.px, x = sd * 5.20;
    block(w, x, 3.84, 0, 0.20, 0.04, 5.00, scale(STEEL, 0.7));
    block(w, x - sd * 0.20, 4.02, 0, 0.03, 0.16, 5.00, scale(STEEL, 0.5));
    for (let i = -2; i <= 2; i++) {
      block(w, x - sd * 0.09, 3.71, i * 2.30, 0.11, 0.09, 0.05, scale(STEEL, 0.45));
      if (i % 2 === 0)
        block(w, x - sd * 0.06, 4.06, i * 2.30, 0.14, 0.18, 0.34, scale(STEEL, 0.55));
    }
  }

  // Spare front wings on a rack — the most recognisable thing in a real bay
  // after the tyres, and the reason a garage reads as a WORKSHOP.
  const wingRack = (out: MeshAcc, x: number, z: number, sgn: number): void => {
    for (let r = 0; r < 2; r++) cyl(out, x, 0, z + (r ? 0.85 : -0.85), 0.035, 1.15, STEEL, 6);
    block(out, x, 1.16, z, 0.05, 0.03, 0.95, STEEL);
    for (let w = 0; w < 2; w++) {                      // two wings leaning on it
      const y = 0.52 + w * 0.46;
      block(out, x + sgn * 0.16, y, z, 0.30, 0.02, 0.86, scale(c1, 0.62));
      block(out, x + sgn * 0.34, y + 0.10, z, 0.06, 0.09, 0.84, scale(c1, 0.45));
      for (let e = -1; e <= 1; e += 2)                 // endplates
        block(out, x + sgn * 0.16, y + 0.07, z + e * 0.84, 0.26, 0.13, 0.02, DARK);
    }
  };
  wingRack(g.nx, -4.30, 1.2, 1);
  wingRack(g.px, 4.30, 2.6, -1);
  // Wheel guns on a wall rack, hoses coiled on a reel above them.
  for (let i = 0; i < 3; i++) {
    const z = -1.9 + i * 0.55;
    // The gun bodies were a hard yellow on all eleven grids. Real crews run
    // them in team colours, and they sit 1.3 m up on the wall the SIDE preset
    // looks straight at.
    block(g.px, 5.16, 1.34, z, 0.07, 0.07, 0.10, scale(c1, 0.92));
    cyl(g.px, 5.16, 0.98, z, 0.045, 0.34, scale(STEEL, 0.7), 6, MAT.METAL);
  }
  block(g.px, 5.20, 1.62, -1.35, 0.06, 0.03, 1.15, STEEL);
  for (let i = 0; i < 2; i++) {
    cyl(g.px, 5.14, 2.30 + i * 0.02, 0.9 + i * 0.8, 0.22, 0.10, scale(DARK, 1.5), 10);
    cyl(g.px, 5.14, 2.28 + i * 0.02, 0.9 + i * 0.8, 0.07, 0.14, STEEL, 6);
  }
  // Shelving of parts crates and a workbench. These live on the DOOR wall, not
  // the back wall: the back wall is where the information boards go, and a
  // prop stood 0.3 m proud of a board is a prop that hides it.
  for (let sh = 0; sh < 3; sh++) {
    const y = 0.95 + sh * 0.62;
    block(g.door, -4.02, y, 6.15, 1.25, 0.025, 0.22, STEEL);
    for (let bx = 0; bx < 3; bx++)
      block(g.door, -5.07 + bx * 0.86, y + 0.17, 6.15, 0.32, 0.15, 0.17,
        scale(bx % 2 ? c1 : STEEL, bx % 2 ? 0.5 : 0.75));
  }
  block(g.door, -4.02, 0.42, 6.05, 1.30, 0.04, 0.32, scale(STEEL, 0.85));
  for (let lg = -1; lg <= 1; lg += 2) cyl(g.door, -4.02 + lg * 1.15, 0, 6.05, 0.035, 0.42, DARK, 6);
  // Fire extinguishers — every real garage wall has a pair.
  for (let f = 0; f < 2; f++) {
    cyl(g.nx, -5.22, 0.32, -4.4 + f * 0.42, 0.075, 0.44, [0.72, 0.09, 0.07], 8);
    cyl(g.nx, -5.22, 0.76, -4.4 + f * 0.42, 0.028, 0.09, scale(STEEL, 0.6), 6);
  }
  // A bin and a wheeled stool by the desk.
  cyl(g.nx, -4.75, 0, 4.7, 0.20, 0.52, scale(STEEL, 0.5), 8);
  cyl(g.nx, -4.10, 0.52, 3.0, 0.20, 0.06, scale(c1, 0.5), 8);
  cyl(g.nx, -4.10, 0, 3.0, 0.045, 0.52, STEEL, 6);
  // Barrier stanchions across the pit-lane opening, chain height only.
  for (let i = -1; i <= 1; i += 2) {
    cyl(g.barrier, i * 2.2, 0, Z_DOOR - 0.55, 0.05, 0.95, scale(STEEL, 0.8), 8);
    cyl(g.barrier, i * 2.2, 0.95, Z_DOOR - 0.55, 0.075, 0.05, [0.80, 0.70, 0.12], 8);
  }
  block(g.barrier, 0, 0.92, Z_DOOR - 0.55, 2.2, 0.02, 0.02, [0.80, 0.70, 0.12]);
  // Overhead cable tray running the length of the bay, under the truss.
  for (let sd = -1; sd <= 1; sd += 2)
    block(g.mid, sd * 4.6, 3.62, 0, 0.16, 0.05, 6.2, scale(STEEL, 0.6));
  // Fuel rig and a wheel trolley in the +X/door corner (x 3.6..5.4, z 5.0..6.4),
  // the emptiest floor in the bay.
  block(g.px, 4.55, 0.62, 5.55, 0.42, 0.62, 0.36, scale(c1, 0.5));
  block(g.px, 4.55, 1.28, 5.55, 0.44, 0.05, 0.38, STEEL);
  cyl(g.px, 4.55, 1.30, 5.55, 0.14, 0.46, scale(STEEL, 0.75), 8);
  for (let w = 0; w < 4; w++)
    cyl(g.px, 4.55 + (w % 2 ? 0.3 : -0.3), 0, 5.55 + (w < 2 ? 0.26 : -0.26), 0.05, 0.10, DARK, 6);
  block(g.px, 4.30, 0.30, 4.35, 0.55, 0.03, 0.34, STEEL);          // wheel trolley
  for (let w = 0; w < 4; w++)
    cyl(g.px, 4.30 + (w % 2 ? 0.42 : -0.42), 0, 4.35 + (w < 2 ? 0.24 : -0.24), 0.05, 0.27, scale(STEEL, 0.7), 6);
  // Laptop bench beside the engineers' desk, in the -X mid-wall gap.
  block(g.nx, -5.00, 0.74, -1.85, 0.32, 0.04, 0.62, scale(STEEL, 0.9));
  for (let l = -1; l <= 1; l += 2) cyl(g.nx, -5.00, 0, -1.85 + l * 0.5, 0.035, 0.74, DARK, 6);
  for (let l = 0; l < 2; l++) {
    block(g.nx, -4.94, 0.78, -2.10 + l * 0.5, 0.16, 0.012, 0.14, scale(STEEL, 1.05));
    block(g.nx, -4.80, 0.90, -2.10 + l * 0.5, 0.015, 0.11, 0.14, DARK);
  }
  // Jack stands and a floor fan in the extinguisher run.
  for (let j = 0; j < 2; j++) {
    cyl(g.nx, -4.60, 0, -4.6 + j * 0.7, 0.16, 0.09, scale(STEEL, 0.65), 6);
    cyl(g.nx, -4.60, 0.09, -4.6 + j * 0.7, 0.05, 0.40, STEEL, 6);
  }
  cyl(g.nx, -4.35, 0, -3.05, 0.26, 0.06, DARK, 10);                 // fan base
  cyl(g.nx, -4.35, 0.06, -3.05, 0.05, 0.46, scale(STEEL, 0.7), 6);
  cyl(g.nx, -4.35, 0.52, -3.05, 0.30, 0.12, scale(STEEL, 0.55), 10);
  // Radio post at the deep end, and ceiling ducting above the truss.
  cyl(g.back, -4.60, 0, -5.95, 0.04, 1.45, STEEL, 6);
  block(g.back, -4.60, 1.45, -5.95, 0.18, 0.12, 0.10, DARK);
  // OUTBOARD, at x +/-4.4 beside the cable trays. At x +/-1.55 these ran
  // straight between an overhead camera and the car, and g.mid is drawn
  // unconditionally (unlike the per-wall groups), so the TOP preset had two
  // grey bars laid across the bay. Ceiling clutter has to live outside the
  // framing radius for the same reason floor clutter does.
  for (let d = -1; d <= 1; d += 2)
    block(g.mid, d * 4.40, 4.80, 0, 0.26, 0.18, 6.10, scale(STEEL, 0.5));
  // Floor level, inboard of every wall, so it is never on the wrong side of one.
  for (let s = -1; s <= 1; s += 2) {
    block(g.mid, s * 3.9, 0.035, 0.5, 0.09, 0.035, 5.4, DARK);
    block(g.mid, s * 4.6, 0.035, -5.9, 0.75, 0.035, 0.09, DARK);
  }
  // Front jack, parked outboard of the FRONT corridor. At x 1.55 the pole
  // still sat in the FRONT preset as a thin frame beside the nose.
  block(g.mid, 2.85, 0.12, 4.55, 0.55, 0.05, 0.12, scale(STEEL, 0.8));
  cyl(g.mid, 2.85, 0.12, 4.75, 0.03, 0.85, STEEL, 6);
}

// ── LED ceiling fixtures ───────────────────────────────────────────────────
// The VISIBLE source for every lamp in the rig that has a glare weight. A halo
// painted where there is no lamp reads as a smudge on the lens, which is what
// drawGlow's per-record glareW field exists to prevent — so fixture geometry
// and light record are built from ONE table. scene.js:426-459
const KEY_TINT: V3 = [1.16, 1.00, 0.78];    // ~3200 K
const FILL_TINT: V3 = [0.86, 0.95, 1.14];   // ~5600 K
const WASH_TINT: V3 = [0.90, 0.97, 1.10];
/** [x, y, z, tint, energy, radius, aimX, aimY, aimZ, cosIn, cosOut, bleed, glareW, wide] */
export type Fixture = readonly [number, number, number, V3, number, number, number, number, number, number, number, number, number, number];
export const FIXTURES: readonly Fixture[] = [
  [ 0.00, 4.30,  1.60, KEY_TINT, 15.0, 11, 0, -1, 0,      0.72, 0.28, 0.10, 0.45, 1],
  [ 0.00, 4.30, -1.10, KEY_TINT, 15.0, 11, 0, -1, 0,      0.72, 0.28, 0.10, 0.45, 1],
  [-3.90, 4.25,  3.40, FILL_TINT, 9.5, 12, 0.62, -0.62, -0.48, 0.80, 0.42, 0.14, 0.35, 1],
  [ 3.90, 4.25,  3.40, FILL_TINT, 9.5, 12, -0.62, -0.62, -0.48, 0.80, 0.42, 0.14, 0.35, 1],
  [-3.90, 4.25, -3.40, FILL_TINT, 9.5, 12, 0.62, -0.62, 0.48, 0.80, 0.42, 0.14, 0.35, 1],
  [ 3.90, 4.25, -3.40, FILL_TINT, 9.5, 12, -0.62, -0.62, 0.48, 0.80, 0.42, 0.14, 0.35, 1],
  // Back-wall washers. Pulled forward to z -5.20 on purpose: at -6.05 the N.L
  // on the wall (normal +Z) is ~0.10, a dead graze; here it is ~0.31, which is
  // what gives the branded wall a top-down gradient instead of flat fill.
  [-2.60, 4.60, -5.20, WASH_TINT, 8.0,  9, -0.10, -0.72, -0.69, 0.86, 0.50, 0.06, 0, 0],
  [ 2.60, 4.60, -5.20, WASH_TINT, 8.0,  9, 0.10, -0.72, -0.69, 0.86, 0.50, 0.06, 0, 0],
  // Door-end pair. Everything past z +4 — shutter, shelving, workbench, jack,
  // stanchions and the new lit sign — sat on spill only: the fills are at
  // z 3.40 and aim AWAY from the door, and the keys are 5 m off against a
  // 1/d^2 falloff.
  [-2.60, 4.55,  5.10, WASH_TINT, 7.5,  9, -0.08, -0.70, 0.71, 0.86, 0.50, 0.08, 0, 0],
  [ 2.60, 4.55,  5.10, WASH_TINT, 7.5,  9, 0.08, -0.70, 0.71, 0.86, 0.50, 0.08, 0, 0],
];
export const E = 0.55;   // the same physical energy factor the track lamps use
const LED_DROP = 0.06;   // light record sits under its panel so the halo clears the housing

// PER SIDE, like the props and the dress, and for the same reason: a wall the
// eye is outside of is not drawn, and anything mounted ON that wall must go
// with it: as one unculled blob, stepping the camera outside a side wall would
// leave its dado strip hanging in mid-air across the frame, in front of the
// car — a glowing bar attached to nothing. Ceiling fixtures stay in `mid`:
// they hang from the truss, not from a wall. scene.js:462-540
export function buildLed(g: Groups, liv: GarageLivery | null | undefined): void {
  const out = g.mid;
  // THE CREST LIGHTBOX. The comment by the dress atlas says a modern garage's
  // crest wall IS a lightbox; it was one flat quad flush to the wall. The bezel
  // belongs HERE, in the LED group, not in the shell: dress quads draw through
  // drawDecal at glow 0.62 while this mesh draws emissive 1.0, so a bezel built
  // as ordinary lit geometry would be shaded by the back-wall washers and read
  // as a different material from the crest sitting inside it.
  //
  // Depth is the trap. The dress plane is only 3 cm proud of the wall, and
  // drawDecal depth-TESTS without depth-writing, so anything in front of the
  // crest quad deletes it silently — the shutter slats did exactly that to a
  // door-wall quad once. The frame is therefore built at the WALL, stopping
  // short of the crest's own z.
  {
    const c1 = rgb(liv && liv.c1, DEF_C1);
    const zf = Z_BACK + 0.015;                 // behind the dress plane at +0.03
    const X = 1.60, Y0 = 1.24, Y1 = 3.56, T = 0.06;
    const FRAME = scale(c1, 1.15), WELL: V3 = [0.03, 0.032, 0.038];
    // Recessed well first, so the crest reads as sitting IN something.
    block(g.back, 0, (Y0 + Y1) / 2, Z_BACK + 0.008, X, (Y1 - Y0) / 2, 0.008, WELL);
    // Sill 1.21-1.27, clear of the wordmark's 1.15 top; head 3.53-3.59, under
    // the 3.76 frame edge. Measured, not eyeballed — the first pass put the
    // sill at 1.05 and it landed inside the wordmark band.
    for (const sy of [-1, 1])                  // head and sill
      block(g.back, 0, sy > 0 ? Y1 : Y0, zf, X + T, T / 2, 0.05, FRAME);
    for (const sx of [-1, 1])                  // jambs
      block(g.back, sx * X, (Y0 + Y1) / 2, zf, T / 2, (Y1 - Y0) / 2 + T, 0.05, FRAME);
  }
  for (let i = 0; i < FIXTURES.length; i++) {
    const F = FIXTURES[i]!, x = F[0], y = F[1] + LED_DROP, z = F[2];
    const hw = F[13] ? 1.20 : 0.26, hd = F[13] ? 0.17 : 0.12;
    block(out, x, y + 0.06, z, hw, 0.05, hd, scale(STEEL, 0.55));   // housing
    // The lit face must be brighter than 1.0 or the shader's glow gate
    // (smoothstep(0.50, 0.95, max(albedo)) plus an HDR push on max(bright-1,0))
    // never fires and it reads as white plastic instead of a light.
    block(out, x, y, z, hw * 0.95, 0.02, hd * 0.8, scale(F[3], 1.14));
    for (let s = -1; s <= 1; s += 2)
      block(out, x + s * hw * 0.8, y + 0.30, z, 0.02, 0.26, 0.02, STEEL);
  }
  // Team-colour dado uplights: cans grazing up the side walls. These are what
  // make the bay read as THIS team's garage before you notice any logo. Three
  // per side now — one pair at z 0 left the walls past |z| 3 on spill only.
  const c1 = rgb(liv && liv.c1, [0.4, 0.45, 0.55]);
  for (let s = -1; s <= 1; s += 2) {
    const w = s < 0 ? g.nx : g.px;          // mounted on THAT wall, culled with it
    for (let i = -1; i <= 1; i++) {
      cyl(w, s * 5.05, 0.02, i * 3.5, 0.11, 0.22, scale(STEEL, 0.6), 8);
      cyl(w, s * 5.05, 0.24, i * 3.5, 0.09, 0.02, scale(c1, 1.5), 8);
    }
    // The dado line. This was ONE bare emissive bar 12.6 m long standing 0.07
    // proud of a near-black wall, and it read as a floating line rather than as
    // a light — there was no fixture around it and nothing to give it a length.
    // Now it is four segments in a recessed channel, which is what a real bay
    // has: the housing is dark enough that the shader's glow gate
    // (smoothstep(0.50, 0.95, max(albedo))) never fires on it, so it can share
    // this emissive mesh with the lit face, exactly as the ceiling fixtures do.
    for (let k = 0; k < 4; k++) {
      const cz = -4.65 + k * 3.10;
      block(w, s * 5.37, 1.56, cz, 0.05, 0.085, 1.475, scale(STEEL, 0.5));   // channel
      block(w, s * 5.34, 1.56, cz, 0.03, 0.038, 1.44, scale(c1, 1.35));      // lit face
      // End caps, so a segment terminates in a fitting instead of just stopping.
      for (let e = -1; e <= 1; e += 2)
        block(w, s * 5.36, 1.56, cz + e * 1.50, 0.045, 0.075, 0.035, scale(STEEL, 0.7));
    }
  }
  // Lit fascia over the door, behind the D_SIGN wordmark (the quad sits 5 mm
  // in front of this block's face — keep that order or the sign vanishes).
  block(g.door, 0, 4.89, Z_DOOR - 0.14, 3.05, 0.13, 0.05, scale(c1, 0.55));
}
export const LED_OPTS: DrawOpts = { emissive: 0.62, roughness: 1.0, specular: 0, noAlphaWrite: true };

// ── the animated layer constants ──────────────────────────────────────────
// Record indices in the rig (scene.js:575-577).
export const GANTRY_AT = FIXTURES.length + 2, LAMP_AT = GANTRY_AT + 4;
const GANTRY_TINT: V3 = [1.0, 0.93, 0.78];
// Where the work lamp stands for each preset, and what it looks at. Each
// stand is OUTSIDE that preset's frame (the fit is +/-3.1 m across the view
// axis at the car) and never on the eye-to-car line — the first pass put the
// SIDE lamp at x 2.9, z 0.4, which is a tripod planted in front of the car
// in the one view that exists to show its flank. scene.js:581-594
/** [standX, standZ, aimX, aimY, aimZ] */
export const SPOTS: Readonly<Record<string, readonly [number, number, number, number, number]>> = {
  hero: [-2.6, -3.6, 0, 0.7, -1.4], bay: [-2.5, -3.8, 0, 0.7, -1.2],
  bayFront: [2.8, 4.2, 0.4, 0.6, 1.2],
  wingRear: [-2.2, -4.2, 0, 0.9, -2.7], rear: [-3.4, -4.6, 0, 0.6, -2.6],
  side: [2.6, 4.3, 0.8, 0.4, 0.6], front: [-3.4, 4.6, 0, 0.5, 2.4], wingFront: [-2.6, 4.4, 0, 0.5, 2.9],
};
const PARK = [-4.0, 2.2] as const;
const LIVE_DECAL_SIDES: readonly LiveSide[] = ["mid", "nx", "px", "door"];

/** Column-major T * Ry(ay) * Rz(az), written into `out`. scene.js:690-699 */
export function mk(out: Float32Array, tx: number, ty: number, tz: number, ay: number, az: number): Float32Array {
  const cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  out[0] = cy * cz;  out[1] = sz;       out[2] = -sy * cz; out[3] = 0;
  out[4] = -cy * sz; out[5] = cz;       out[6] = sy * sz;  out[7] = 0;
  out[8] = sy;       out[9] = 0;        out[10] = cy;      out[11] = 0;
  out[12] = tx;      out[13] = ty;      out[14] = tz;      out[15] = 1;
  return out;
}
export const MAT_MIRROR = new Float32Array([-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
// Floor reflection: noDepthTest + alpha drew the mirrored car into empty pixels
// below the bay slab (side/rear views showed a second car under the floor).
// Draw the room first, resolve the mirror opaque with depth bias so it depth-tests
// against floor/props, then composite a bay fade quad for contact sheen.
// scene.js:703-711
const MIRROR_BIAS = [-2, -120] as const;
export const MIRROR_RESOLVE: DrawOpts = { alpha: 1, roughness: 1, specular: 0, metalness: 0, clearcoat: 0, depthBias: MIRROR_BIAS };
export const MIRROR_SHEEN_PEAK = 0.14;
/** The mirror's contact sheen for this eye and car pose. scene.js:712-719 */
export function mirrorSheen(eye: readonly number[] | null | undefined, carMat: ArrayLike<number> | null | undefined): number {
  const cx = carMat ? carMat[12]! : 0, cz = carMat ? carMat[14]! : 0;
  const ex = eye ? eye[0]! : 0, ey = eye ? eye[1]! : 1.6, ez = eye ? eye[2]! : 5;
  const d = Math.hypot(ex - cx, ez - cz);
  const lateral = 1 / (1 + Math.max(0, d - 2.2) * 0.18);
  const height = 1 / (1 + Math.max(0, ey - 2.5) * 0.25);
  return MIRROR_SHEEN_PEAK * lateral * height;
}
// GLOW_FS peaks at (0.75 + 0.28) * uStr, and LT.glareStr ships at 0.12 for
// distant track masts. Fixtures sit IN frame here, so the base stays under the
// race default; glareScale() in setup-camera.js multiplies by LT.glareStr/0.12.
// scene.js:768-772
export const GLARE_STR = 0.08;
export function glareStr(): number { return GLARE_STR; }

// ── floor ──────────────────────────────────────────────────────────────────
// Two surfaces. The APRON is a disc at y = -0.04 whose vertex colours fade to
// exactly BACKDROP at the rim, so the ground has no visible edge — the trick
// the preview already relied on. The BAY floor is a gapless TILING at y = 0,
// which is what the wheels sit on. The 4 cm step between them is a real garage
// detail (a resin bay laid over the pit apron) and it is also why nothing here
// needs a depth bias: no two floor surfaces are ever coplanar. scene.js:774-781
export const BOX_HW = 2.20, BOX_ZF = 4.25, BOX_ZB = -4.00;
// The pit lane, seen through the open door. It lives in the FLOOR mesh, which
// draws unconditionally — the one thing it must not do is cull with the door
// wall, because you are looking through that wall's aperture exactly when the
// wall itself has back-faced away. Laid on the apron plane (y -0.04), not the
// bay floor (y 0): the 4 cm step between them is the resin bay over the pit
// apron, and through the doorway it reads as the threshold it is.
// THE FRONTAGE IS THE MODEL'S. The working lane, the corridor and the fast
// lane at pit.ts BANDS' widths, the wall beyond — so the lane seen through
// the door is the lane the car pits in (the track mesh builds the real one
// from the same numbers, and the box is the same 8 m). scene.js:782-797
const PIT_B = BANDS;
const PIT_HW = 10.5, PIT_Z0 = Z_DOOR + 0.05;
const PIT_WORK1 = PIT_Z0 + PIT_B.work, PIT_CORR1 = PIT_WORK1 + PIT_B.corridor;
export const PIT_Z1 = PIT_CORR1 + PIT_B.fast;
export const PIT_FAST_Z = (PIT_CORR1 + PIT_Z1) / 2;
/** scene.js:798-873 */
export function buildPitLane(out: MeshAcc, liv: GarageLivery | null | undefined, night: boolean): void {
  const APRON_Y = -0.04;
  // Outside at NIGHT: a darker lane under the gantry lights (lights() adds
  // them), the hoardings lit. By day the asphalt is the bright side.
  const NK = night ? 0.46 : 1;
  // LIGHTER than the bay floor, not darker. The first pass used 0.072, below
  // the apron's own 0.105, so the lane read as a black void through the
  // doorway — which is the exact failure the door risked in the first place.
  // Outside is the bright side: daylight asphalt against a dim bay is what
  // makes an open door look open.
  const ASPHALT: V3 = [0.20, 0.205, 0.215], LINE: V3 = [0.88, 0.89, 0.91];
  const WALL: V3 = [0.30, 0.31, 0.34], WALL_TOP: V3 = [0.46, 0.47, 0.50];
  const c1 = rgb(liv && liv.c1, DEF_C1);
  // 21 x 5.45 m — 114 m2, the entire backdrop of the REAR preset, seen through
  // a 5.4 x 4.8 m aperture. As ONE `tile()` (two triangles, one flat colour)
  // ten spot lights have nothing to fall on and the lane reads as a painted
  // backdrop rather than a surface. Subdivided 12 x 4 with a little
  // vertex-colour mottle, it costs 96 triangles and takes light.
  panelGrid(out, [-PIT_HW, APRON_Y + 0.004, PIT_Z0], [PIT_HW * 2, 0, 0],
    [0, 0, PIT_Z1 - PIT_Z0], 12, 4, [0, 1, 0], (u, v) => {
      // Deterministic per-vertex wear: darker in the working lane against the
      // garages, and a hash so the mottle is not a gradient.
      const h = ((u * 977 + v * 613) * 4093) % 1;
      const k = (0.94 + h * 0.10 + (1 - v) * 0.05) * NK;
      return [ASPHALT[0] * k, ASPHALT[1] * k, ASPHALT[2] * k];
    }, MAT.ASPHALT);
  // Working lane against the garages, the corridor, the fast lane by the wall
  // — the lines every pit straight has, at the model's widths.
  for (const z of [PIT_WORK1, PIT_CORR1, PIT_Z1])
    tile(out, -PIT_HW, PIT_HW, z, z + 0.13, LINE, APRON_Y + 0.008, MAT.ASPHALT);
  // THE PIT BOX. A garage without its own box painted outside the door is a
  // shed: this is the one marking that says which bay this is. Team-coloured
  // outline on the lane, centred on the door, the model's 8 m long.
  // The box sits in the WORKING lane, never across the fast lane.
  const BX0 = PIT_Z0 + 0.30, BX1 = PIT_WORK1 - 0.30, BH = BOX_LEN / 2;
  for (const q of [[-BH, -BH + 0.12, BX0, BX1], [BH - 0.12, BH, BX0, BX1],
                   [-BH, BH, BX0, BX0 + 0.12], [-BH, BH, BX1 - 0.12, BX1]] as const)
    tile(out, q[0], q[1], q[2], q[3], c1, APRON_Y + 0.010, MAT.ASPHALT);
  // Bollards along the FAR edge, between the outer line and the wall — never
  // mid-lane, which is where a car drives. The vertical marks are what give the
  // lane depth from the low REAR camera.
  for (let i = -3; i <= 3; i++)
    cyl(out, i * 2.9, APRON_Y + 0.008, PIT_Z1 - 0.08, 0.055, 0.62,
        i % 2 ? [0.80, 0.80, 0.84] : [0.72, 0.30, 0.10], 6, MAT.METAL);
  // The garages opposite: a low run of blocks with lit fascias, so the far side
  // of the lane is a row of buildings rather than the end of the mesh.
  for (let i = -3; i <= 3; i++) {
    block(out, i * 3.0, APRON_Y + 1.60, PIT_Z1 + 1.30, 1.42, 1.10, 0.60,
          scale(WALL, i % 2 ? 0.92 : 1.06), MAT.CONCRETE);
    // A fascia BAND on the front face, not a roof slab: 0.16 m deep, so its
    // horizontal caps stay small. A wide flat cap of wall-keyed metal streaks
    // for the same reason a concrete floor does.
    block(out, i * 3.0, APRON_Y + 2.78, PIT_Z1 + 0.78, 1.46, 0.10, 0.08,
          scale(WALL_TOP, 1.1), MAT.METAL);
  }
  // A wall to stop the eye. Without it the lane runs to the apron rim and
  // fades into the clear colour, which reads as fog rather than as somewhere.
  block(out, 0, APRON_Y + 0.50, PIT_Z1 + 0.18, PIT_HW, 0.50, 0.16, WALL, MAT.CONCRETE);
  block(out, 0, APRON_Y + 1.03, PIT_Z1 + 0.18, PIT_HW, 0.05, 0.20, WALL_TOP, MAT.METAL);
  // A team-coloured hoarding along it, so the far side of the lane is a place
  // rather than a grey slab.
  for (let i = -2; i <= 2; i++)
    block(out, i * 3.6, APRON_Y + 0.62, PIT_Z1 + 0.02, 1.55, 0.26, 0.05,
          scale(c1, night ? 1.25 : (i % 2 ? 0.55 : 0.9)));
}
/** The apron disc, fading to `backdrop` at its rim. scene.js:874-910 */
export function buildApron(out: MeshAcc, backdrop: V3 = BACKDROP0): void {
  const RINGS = 7, SEG = 40, R = 18, Y = -0.04;
  const HOT: V3 = [0.105, 0.107, 0.115];
  const BACKDROP = backdrop;
  const push = (x: number, z: number, t: number): void => {
    const k = smooth(t);
    out.pos.push(x, Y, z); out.nrm.push(0, 1, 0);
    out.col.push(HOT[0] + (BACKDROP[0] - HOT[0]) * k,
                 HOT[1] + (BACKDROP[1] - HOT[1]) * k,
                 HOT[2] + (BACKDROP[2] - HOT[2]) * k);
    pushMat(out, 1, MAT.ASPHALT);
  };
  const base = out.pos.length / 3;
  push(0, 0, 0);
  for (let r = 1; r <= RINGS; r++) {
    const t = r / RINGS, rad = R * t * t;
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      push(Math.cos(a) * rad, Math.sin(a) * rad, t);
    }
  }
  // CCW seen from ABOVE (gl.frontFace(CCW) + cull BACK): the ring walks +a =
  // (cos a, sin a) in (x, z), and a downward-looking camera maps world z to
  // SCREEN-DOWN, so the naive order comes out clockwise and the whole disc is
  // culled — an invisible floor that still passes every mesh assertion.
  for (let i = 0; i < SEG; i++) out.idx.push(base, base + 1 + ((i + 1) % SEG), base + 1 + i);
  for (let r = 0; r < RINGS - 1; r++) {
    const a0 = base + 1 + r * SEG, b0 = a0 + SEG;
    for (let i = 0; i < SEG; i++) {
      const j = (i + 1) % SEG;
      out.idx.push(a0 + i, b0 + j, b0 + i, a0 + i, a0 + j, b0 + j);
    }
  }
}
/** scene.js:911-970 */
export function buildBayFloor(out: MeshAcc, liv: GarageLivery | null | undefined): void {
  const SLAB: V3 = [0.088, 0.090, 0.098], IN: V3 = [0.115, 0.118, 0.126];
  const PAINT: V3 = [0.66, 0.67, 0.70], WALK: V3 = [0.70, 0.60, 0.12];
  const band = scale(rgb(liv && liv.c1, [0.3, 0.32, 0.36]), 0.7);
  const L = -HALF_W, R = HALF_W, B = Z_BACK, F = Z_DOOR, W = 0.11;
  // ASPHALT, not CONCRETE, on a HORIZONTAL surface — and this is not a naming
  // preference. f1-game's matWallLike() returns true for CONCRETE, so its
  // triplanar UV is (an.x > an.z ? z : x, worldY). On a floor the normal is
  // (0,1,0), `an.x > an.z` is false, and worldY is 0 everywhere: the UV
  // collapses to a 1-D function of x and the "concrete" renders as
  // longitudinal streaks smeared down -Z. ASPHALT is not wall-like, keys off
  // world xz, and carries the most restrained relief in the table — which is
  // what a squeegeed resin bay floor actually looks like.
  const C = MAT.ASPHALT;
  const key = rgb(liv && (liv.accent || liv.stripe || liv.c2), [0.55, 0.57, 0.62]);
  tile(out, L, R, B, B + 0.8, band, 0, C);                 // team band, deep end
  tile(out, L, R, B + 0.8, BOX_ZB - W, SLAB, 0, C);
  tile(out, L, -BOX_HW - W, BOX_ZB, BOX_ZF, SLAB, 0, C);
  tile(out, -BOX_HW, BOX_HW, BOX_ZB, BOX_ZF, IN, 0, C);    // the box itself
  tile(out, BOX_HW + W, R, BOX_ZB, BOX_ZF, SLAB, 0, C);
  tile(out, L, R, BOX_ZF + W, F, SLAB, 0, C);
  // A team keyline just outside the box edge. 130 of the 138 m2 of floor was
  // team-agnostic grey and the box — the thing the car is parked in, and 100%
  // of the TOP preset — was the greyest part of it.
  for (const q of [[L, R, BOX_ZB - W - 0.05, BOX_ZB - W], [L, R, BOX_ZF + W, BOX_ZF + W + 0.05],
                   [-BOX_HW - W - 0.05, -BOX_HW - W, BOX_ZB - W, BOX_ZF + W],
                   [BOX_HW + W, BOX_HW + W + 0.05, BOX_ZB - W, BOX_ZF + W]] as const)
    tile(out, q[0], q[1], q[2], q[3], key, 0.001, C);
  // The four pit-box edges were FLAT — a painted colour on the same plane as
  // the slab. The floor is the biggest surface in every camera preset (100% of
  // top, ~60% of hero/rear/front) and carried 36 triangles for 138 m2, so it
  // had nothing for the ten spot lights to catch. 2 cm of height turns each
  // edge into a lit top face and a shadowed side for 48 triangles total, which
  // is what makes a painted box read as a kerb instead of a decal.
  const EH = 0.02;
  block(out, 0, EH / 2, BOX_ZB - W / 2, (R - L) / 2, EH / 2, W / 2, PAINT);   // back edge
  block(out, 0, EH / 2, BOX_ZF + W / 2, (R - L) / 2, EH / 2, W / 2, PAINT);   // front edge
  for (const sx of [-1, 1])
    block(out, sx * (BOX_HW + W / 2), EH / 2, (BOX_ZB + BOX_ZF) / 2,
          W / 2, EH / 2, (BOX_ZF - BOX_ZB) / 2, PAINT);                       // side edges
  for (let s = -1; s <= 1; s += 2) {                       // walkway lines
    tile(out, s * 4.25, s * 4.25 + 0.09, B + 0.8, BOX_ZB - W, WALK);
    tile(out, s * 4.25, s * 4.25 + 0.09, BOX_ZF + W, F, WALK);
  }
  // Expansion joints, 3 cm, laid ON TOP of the tiling at +2 mm — the one place
  // a tiny lift is simpler than splitting every band again, and 2 mm at 4-15 m
  // is far above this depth buffer's resolution.
  const J: V3 = [0.042, 0.043, 0.048];
  for (let i = -2; i <= 2; i++) {
    const x = i * 2.4;
    const b2 = out.pos.length / 3;
    const p = [[x - 0.015, B], [x + 0.015, B], [x + 0.015, F], [x - 0.015, F]] as const;
    for (let k = 0; k < 4; k++) { out.pos.push(p[k]![0], 0.002, p[k]![1]); out.nrm.push(0, 1, 0); out.col.push(J[0], J[1], J[2]); }
    pushMat(out, 4, MAT.ASPHALT);
    out.idx.push(b2, b2 + 2, b2 + 1, b2, b2 + 3, b2 + 2);
  }
}

// THE BAY AS ONE PLAIN BUFFER — shell, floor, LED fixtures — for the trackside
// garages: src/track/scenery/pits.ts places it once per team. Static only: the
// dress atlas, the live screens and the moving props are the setup screen's,
// and a row of twelve bays does not need twelve fans. `props` / `equipment`
// opt the furniture in. scene.js:932-963
function appendBuf(out: Required<MeshAcc>, b: Required<MeshAcc>): void {
  const base = out.pos.length / 3;
  for (let i = 0; i < b.pos.length; i++) out.pos.push(b.pos[i]!);
  for (let i = 0; i < b.nrm.length; i++) out.nrm.push(b.nrm[i]!);
  for (let i = 0; i < b.col.length; i++) out.col.push(b.col[i]!);
  for (let i = 0; i < b.mat.length; i++) out.mat.push(b.mat[i]!);
  for (let i = 0; i < b.idx.length; i++) out.idx.push(base + b.idx[i]!);
}
/** buildStatic's options. `facility` is GarageExperience.buildFacility (f1-game ran it only in rebuild, never here). */
export interface StaticOpts {
  readonly props?: "lite" | boolean | undefined;
  readonly equipment?: boolean | undefined;
  readonly ctx?: GarageCtx | null | undefined;
}
/** The bay as one buffer (scene.js:944-963): the src/track/scenery/core.ts GarageCore. */
export function buildStatic(liv: GarageLivery | null | undefined, opts?: StaticOpts | null): Required<MeshAcc> {
  const o: StaticOpts = opts || {};
  const out = acc();
  buildShell(out, liv);
  // Trackside pit rows (SceneryPits → buildStatic) bake one bay per team into
  // propsGeo. The truss used to live inside buildShell; keep calling it here
  // so extracting it for the TOP hide does not drop 84 tris × 12 bays from
  // monaco/monza STRIP (1008 tris). The live bay draws trussMesh separately.
  buildTruss(out);
  buildBayFloor(out, liv);
  const led = groups();
  buildLed(led, liv);
  for (let i = 0; i < SIDES.length; i++) appendBuf(out, led[SIDES[i]!]);
  if (o.props) {
    const g = groups();
    if (o.props === "lite") buildPropsLite(g, liv);
    else {
      buildProps(g, liv);
      if (o.equipment) buildEquipment(g, liv, o.ctx || {});
    }
    for (let i = 0; i < SIDES.length; i++) appendBuf(out, g[SIDES[i]!]);
  }
  return out;
}

// ── preview framing ────────────────────────────────────────────────────────
// The turntable orbits and AIMS at one point, so THAT POINT is pinned on screen
// — but the car's SILHOUETTE is not. The car is 5.95 m long orbited at 8.5 m, so
// whichever end swings toward the camera is magnified by perspective and the
// silhouette centre swings with it: measured 0.158 NDC of drift, ~79 px on a
// 1000 px canvas, which is exactly what reads as "the rotation is not centred on
// the car". No choice of pivot fixes it — the drift is perspective, not a wrong
// aim point. So measure the silhouette each frame and shift the lens.
//
// framingHull is the cheap stand-in for that silhouette: the convex hull of the
// car's XZ footprint, duplicated at its Y extremes. A projected x-extreme is
// always attained on the 3D hull, and this ~32-point stack tracked the true
// centre to within 0.005 NDC (~2 px) in a sweep where the 8 bbox corners were
// out by 0.027 (~13 px). x is negated at build time because the preview draws
// the car through MAT_REFLECT_X.
//
// Sorting all ~19k points was the cost (14 ms measured, paid on every part
// pick). The Akl–Toussaint pass first finds the eight support-extreme points
// and discards everything strictly inside their octagon — a point inside it is
// inside the hull, so the answer is unchanged and the sort runs over the few
// hundred that remain. scene.js:1196-1272
export function framingHull(data: { readonly pos?: ArrayLike<number> | null } | null | undefined): number[] | null {
  const p = data && data.pos;
  if (!p || !p.length) return null;
  const P = (i: number): number => p[i]!;
  const n = p.length / 3;
  let ylo = 1e9, yhi = -1e9;
  // Eight support directions, not four: a car is a rectangle with a wheel at
  // each corner, and the axis-extreme QUAD is a diamond that leaves every
  // corner outside it (10.6k of 18.8k survived). The octagon keeps 3.6k.
  const M = 8, best = new Float64Array(M).fill(-1e9), bi = new Int32Array(M);
  const dx = new Float64Array(M), dz = new Float64Array(M);
  for (let k = 0; k < M; k++) { const a = Math.PI + 2 * Math.PI * k / M; dx[k] = Math.cos(a); dz[k] = Math.sin(a); }
  for (let i = 0; i < n; i++) {
    const x = -P(i * 3), y = P(i * 3 + 1), z = P(i * 3 + 2);
    if (y < ylo) ylo = y;
    if (y > yhi) yhi = y;
    for (let k = 0; k < M; k++) {
      const v = x * dx[k]! + z * dz[k]!;
      if (v > best[k]!) { best[k] = v; bi[k] = i; }
    }
  }
  type P2 = readonly [number, number];
  const cross2 = (o: P2, a: P2, b: P2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  // The octagon, walked counter-clockwise in the (x, z) plane. Scalar edge
  // tests, no per-point allocation — arrays are minted only for the survivors.
  // A degenerate (repeated) vertex makes its edge test 0, which keeps every
  // point: slower, never wrong.
  const qx = new Float64Array(M), qz = new Float64Array(M);
  for (let k = 0; k < M; k++) { qx[k] = -P(bi[k]! * 3); qz[k] = P(bi[k]! * 3 + 2); }
  const pts: P2[] = [];
  for (let i = 0; i < n; i++) {
    const x = -P(i * 3), z = P(i * 3 + 2);
    let inside = true;
    for (let k = 0; k < M && inside; k++) {
      const j = (k + 1) % M;
      if ((qx[j]! - qx[k]!) * (z - qz[k]!) - (qz[j]! - qz[k]!) * (x - qx[k]!) <= 0) inside = false;
    }
    if (!inside) pts.push([x, z]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (arr: readonly P2[]): P2[] => {
    const h: P2[] = [];
    for (let i = 0; i < arr.length; i++) {
      const q = arr[i]!;
      while (h.length >= 2 && cross2(h[h.length - 2]!, h[h.length - 1]!, q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  const rev = pts.slice().reverse();
  const ring = half(pts).concat(half(rev));
  const out: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    out.push(ring[i]![0], ylo, ring[i]![1]);
    out.push(ring[i]![0], yhi, ring[i]![1]);
  }
  return out;
}
// Re-centre the silhouette in the visible region by nudging the lens shift.
// proj[8] adds a CONSTANT offset to NDC.x (the clip-space term is proj[8]*z_view
// and w is -z_view, so the shift is exactly -proj[8]) — which is why one pass is
// exact rather than iterative, and why the extents' relative spacing is
// untouched. Gated on `on` (the auto-turntable) for the same reason the fit
// distance is: once a player picks a preset or pans, the framing is theirs.
// scene.js:1273-1293
export function recentre(proj: Float32Array | number[], view: ArrayLike<number>, vp: Float32Array | number[],
  panelFrac: number, on: boolean, hull: readonly number[] | null | undefined): void {
  if (!on || !hull) return;
  const V = (i: number): number => vp[i]!;
  let lo = 1e9, hi = -1e9;
  for (let i = 0; i < hull.length; i += 3) {
    const x = hull[i]!, y = hull[i + 1]!, z = hull[i + 2]!;
    const w = V(3) * x + V(7) * y + V(11) * z + V(15);
    if (w <= 0.001) continue;               // behind the eye: no screen position
    const nx = (V(0) * x + V(4) * y + V(8) * z + V(12)) / w;
    if (nx < lo) lo = nx;
    if (nx > hi) hi = nx;
  }
  if (lo > hi) return;
  proj[8] = proj[8]! + ((lo + hi) / 2 + panelFrac);     // target is -panelFrac, the visible centre
  mulTo(vp, proj, view);
}

/** The light-rig record stride (js/render/gfx.js frame.lights). */
export const RIG_STRIDE = 15;
// Daytime gantries and the parked lamp stay at energy 0. The lit shader still
// loops every record, so hand present only the ones that actually emit.
// scene.js:676-689. `into` is reused across calls.
export function litRig(src: readonly number[], into: number[]): number[] {
  into.length = 0;
  const n = (src.length / 15) | 0;
  for (let i = 0; i < n; i++) {
    const o = i * 15;
    if (src[o + 3]! + src[o + 4]! + src[o + 5]! <= 1e-4 && src[o + 14]! <= 1e-4) continue;
    for (let k = 0; k < 15; k++) into.push(src[o + k]!);
  }
  return into;
}

// ── the live room ───────────────────────────────────────────────────────────

/** A cached turntable car (scene.js:1306-1340). */
export interface PreviewEntry {
  mesh: GfxMesh;
  hull: number[] | null;
  hullKey: string;
}

/** The mesh a turntable car is built as (Car3D.build's record; any MeshAcc-shaped data). */
export type PreviewData = MeshAcc;

/** GarageScene.debug() (scene.js:1408-1411). */
export interface SceneDebug {
  bay: [number, number, number];
  lights: number;
  key: string;
  geomKey: string;
  previewMeshes: number;
  previewHulls: number;
}

/** Everything the live room reads from outside the garage scene module family. */
export interface SceneDeps {
  /** LiveryTex. Absent = no atlases (f1-game's `typeof LiveryTex === "undefined"`). TODO(lane-car). */
  readonly livery?: GarageLiveryTex | null | undefined;
  /** Parts, for the wall boards. Default CAR_PARTS (src/car/parts.ts); null = absent. */
  readonly parts?: GarageParts | null | undefined;
  /** Career. TODO(lane-race). */
  readonly career?: GarageCareer | null | undefined;
  /** GarageExperience. TODO(lane-data): js/garage/experience.js. Default NO_EXPERIENCE. */
  readonly experience?: GarageExperienceApi | undefined;
  /** GameStore.store. TODO(lane-data): src/garage/store.ts. */
  readonly store?: GarageStoreRev | null | undefined;
  /** Tracks.circuitPayloadResident. TODO(lane-track). Absent = never resident (hyd 0). */
  readonly trackResident?: TrackResident | null | undefined;
  /** Log sink; src/data/log.ts by default. */
  readonly log?: GarageLog | undefined;
  /** performance.now (ms). */
  readonly now?: (() => number) | undefined;
  /** `document.createElement("canvas")`. Absent and no `document` = no atlases. */
  readonly createCanvas?: CanvasFactory | null | undefined;
  /** The crew; null leaves it out (f1-game's `typeof GarageCrew === "undefined"`). Default: a new crew. */
  readonly crew?: GarageCrewApi | null | undefined;
}

/**
 * src/car/parts.ts as the boards read it (f1-game's `Parts` global). The
 * default `parts` dep; tests pass null for f1-game's "Parts absent" path.
 */
export const CAR_PARTS: GarageParts = Object.freeze({
  resolveSetup: (setup: unknown, team: GarageTeam) =>
    Parts.resolveSetup(setup as PartSetup | null, team as PartsTeam),
  displayStat: Parts.displayStat,
  STAT_KEYS: Parts.STAT_KEYS,
  CATALOG: Parts.CATALOG,
  BUDGET: Parts.BUDGET,
});

/** GarageExperience with no career achievements: experience.js:103-180 for an inactive career. */
export const NO_EXPERIENCE: GarageExperienceApi = Object.freeze({
  careerKey: () => "-",
  paintCareer: () => {},
  buildFacility: () => {},
  statsOf: (team: GarageTeam) => (team && team.stats) || null,
});

/** The browser canvas factory, or null where there is no DOM. */
export function domCanvas(): CanvasFactory | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  return (w, h) => {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    return cv as unknown as GarageCanvas;
  };
}

/** GarageScene's public API (scene.js:1413-1414). */
export interface GarageSceneApi {
  init(gfx: GarageGfx | null): void;
  buildStatic: typeof buildStatic;
  /** The clear colour, rewritten in place on each rebuild (night / day). */
  readonly BACKDROP: [number, number, number];
  readonly SKYLIGHT: V3;
  readonly AMB_SKY: V3;
  readonly AMB_GROUND: V3;
  lights(liv: GarageLivery | null | undefined): number[];
  live(liv: GarageLivery | null | undefined, now: number, ctx?: GarageCtx | null): number[];
  glareStr(): number;
  draw(team: GarageTeam, liv: GarageLivery | null | undefined, eye: readonly number[] | null | undefined,
    getParts: GetParts | null | undefined, driverIdx: number, ctx?: GarageCtx | null, carMesh?: GfxMesh | null,
    arrival?: ArrivalPose | null, carMat?: Float32Array | null): void;
  framingHull: typeof framingHull;
  recentre: typeof recentre;
  previewMesh(key: string, hullKey: string, build: () => PreviewData): PreviewEntry;
  dropPreviewMeshes(): void;
  pulse(): void;
  spot(name: string | null | undefined): void;
  debug(): SceneDebug;
  seatDriverAt: GarageDressApi["seatDriverAt"];
  ctxKey(ctx: GarageCtx | null | undefined): string;
  prepare(team: GarageTeam, liv: GarageLivery | null | undefined, getParts: GetParts | null | undefined,
    driverIdx: number, ctx?: GarageCtx | null): boolean;
  prepared(team: GarageTeam, liv: GarageLivery | null | undefined, getParts: GetParts | null | undefined,
    driverIdx: number, ctx?: GarageCtx | null): boolean;
  release(): number;
}

/**
 * One garage room (scene.js:2-1415). f1-game's IIFE state lives here: the
 * renderer handle, the single-slot mesh caches, both atlases, the light rig,
 * the work lamp, the preview LRU.
 */
export function createGarageScene(deps: SceneDeps = {}): GarageSceneApi {
  const log = deps.log || dataLog;
  const experience = deps.experience || NO_EXPERIENCE;
  const LiveryTex = deps.livery || null;
  const nowMs = deps.now || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const createCanvas = deps.createCanvas === undefined ? domCanvas() : deps.createCanvas;
  const crew = deps.crew === undefined ? createGarageCrew() : deps.crew;
  const dress = createGarageDress({
    livery: LiveryTex, parts: deps.parts === undefined ? CAR_PARTS : deps.parts, career: deps.career, experience, store: deps.store, log,
    createCanvas: createCanvas || (() => { throw new Error("no canvas"); }),
  });
  const { seatDriverAt, boardInfo, paintDress, paintBoards, buildDress, resetSpec, releaseDress } = dress;
  /** f1-game's `typeof LiveryTex !== "undefined"`, plus a canvas to paint on. */
  const atlases = (): boolean => !!LiveryTex && !!createCanvas;

  let _gfx: GarageGfx | null = null;            // renderer handle, set once by init()
  function init(gfx: GarageGfx | null): void { log.info("GarageScene.init"); _gfx = gfx; if (crew) crew.init(gfx); }
  const G = (): GarageGfx => _gfx!;

  // MUTATED per ctx.night in rebuild() — the caller reads this array each frame.
  const BACKDROP: [number, number, number] = [BACKDROP0[0], BACKDROP0[1], BACKDROP0[2]];

  let shellMesh: GfxMesh | null = null;
  const ledMesh: Partial<Record<Side, GfxMesh | null>> = {};

  // ── light rig ──────────────────────────────────────────────────────────────
  // Stride-15 records: [x,y,z, r,g,b, rad, dirX,dirY,dirZ, cosInner, cosOuter,
  // bleed, volW, glareW] — see js/render/gfx.js. volW stays 0 (godrays are off).
  // scene.js:543-573
  const _rig: number[] = [];
  let _rigK0 = NaN, _rigK1 = NaN, _rigK2 = NaN;
  function lights(liv: GarageLivery | null | undefined): number[] {
    const c1 = rgb(liv && liv.c1, [0.4, 0.45, 0.55]);
    // Numeric key — avoid c1.join(",") string alloc every live() frame.
    if (_rig.length && c1[0] === _rigK0 && c1[1] === _rigK1 && c1[2] === _rigK2) return _rig;
    _rig.length = 0;
    _rigK0 = c1[0]; _rigK1 = c1[1]; _rigK2 = c1[2];
    for (let i = 0; i < FIXTURES.length; i++) {
      const F = FIXTURES[i]!, e = F[4] * E, t = F[3];
      _rig.push(F[0], F[1], F[2], t[0] * e, t[1] * e, t[2] * e, F[5],
                F[6], F[7], F[8], F[9], F[10], F[11], 0, F[12]);
    }
    const m = Math.max(c1[0], c1[1], c1[2]) || 1, ue = (3.0 / m) * E;
    for (let s = -1; s <= 1; s += 2)
      _rig.push(s * 5.05, 0.25, 0, c1[0] * ue, c1[1] * ue, c1[2] * ue, 6,
                -s * 0.26, 0.97, 0, 0.90, 0.55, 0.05, 0, 0.12);
    // The pit-lane GANTRY outside: four masts along the far wall. Their energy
    // and halo are set per frame from the hour (live() below) — at night they
    // are what you see through the door, by day they are unlit steel.
    for (const gx of [-9, -3, 3, 9])
      _rig.push(gx, 3.6, PIT_Z1 + 0.2, 0, 0, 0, 9, 0, -0.85, -0.53, 0.80, 0.45, 0.10, 0, 0);
    // The inspection LAMP, aimed by spot(); off until a preset asks for it.
    _rig.push(0, 1.7, 0, 0, 0, 0, 7, 0, -1, 0, 0.92, 0.70, 0.05, 0, 0);
    return _rig;
  }
  // ── the animated layer ─────────────────────────────────────────────────────
  // Everything here is per FRAME and costs no rebuild: the light records are
  // written in place, the moving props are static meshes under a matrix.
  // scene.js:574-675
  let liveNow = 0, pulseAt = -1e9, spotName: string | null = null, nightNow = false;
  function pulse(): void { pulseAt = liveNow; }
  function spot(name: string | null | undefined): void { spotName = name || null; }
  const lampAim = [PARK[0], PARK[1], 0, 0, PARK[0], 0, PARK[1]];   // x, z, yaw, on, ax, ay, az
  const _chase: number[] = [];   // pulse chase reuses this; never allocate a fresh copy of the rig
  const _lit: number[] = [];
  const _inside: Record<Side, boolean> = { nx: true, px: true, back: true, door: true, mid: true, shutter: true, barrier: true };
  // The live records: gantry by hour, the lamp by preset, one washer that
  // flickers, and the truss chase that runs the length of the bay for two
  // seconds after a part is fitted. Returns the rig, plus the chase while it runs.
  function live(liv: GarageLivery | null | undefined, now: number, ctx?: GarageCtx | null): number[] {
    const rig = lights(liv);
    liveNow = now;
    nightNow = !!(ctx && ctx.night);
    const ge = nightNow ? 6.5 * E : 0;
    for (let i = 0; i < 4; i++) {
      const o = (GANTRY_AT + i) * 15;
      rig[o + 3] = GANTRY_TINT[0] * ge; rig[o + 4] = GANTRY_TINT[1] * ge; rig[o + 5] = GANTRY_TINT[2] * ge;
      rig[o + 14] = nightNow ? 1.2 : 0;
    }
    // THE SHUTTER SWELL: the two team-colour dado uplights rise to ~3x and fall
    // back as the door lifts on an arrival or the RACE! drive-out (ctx.door, 0..1;
    // absent or 1 on every other frame), so the team's colour floods the bay at
    // the moment it opens. Written in place: the rig is rebuilt only on a new c1.
    {
      const c1 = rgb(liv && liv.c1, [0.4, 0.45, 0.55]), m = Math.max(c1[0], c1[1], c1[2]) || 1;
      const d = ctx && Number.isFinite(ctx.door) ? Math.max(0, Math.min(1, ctx.door!)) : 1;
      const ue = (3.0 / m) * E * (1 + 2.2 * Math.sin(d * Math.PI));
      for (let k = 0; k < 2; k++) {
        const o = (FIXTURES.length + k) * 15;
        rig[o + 3] = c1[0] * ue; rig[o + 4] = c1[1] * ue; rig[o + 5] = c1[2] * ue;
      }
    }
    // TOP hides the ceiling housings, so their glare orbs must go with them.
    for (let i = 0; i < FIXTURES.length; i++)
      rig[i * 15 + 14] = spotName === "top" ? 0 : FIXTURES[i]![12];
    // Lamp: parked and dark while the turntable runs, else beside the preset's subject.
    const sp = (!ctx || !ctx.spin) && spotName && SPOTS[spotName];
    const lx = sp ? sp[0] : PARK[0], lz = sp ? sp[1] : PARK[1];
    const ax = sp ? sp[2] : lx, ay = sp ? sp[3] : 0, az = sp ? sp[4] : lz;
    const yaw = Math.atan2(ax - lx, az - lz);
    lampAim[0] = lx; lampAim[1] = lz; lampAim[2] = yaw; lampAim[3] = sp ? 1 : 0;
    lampAim[4] = ax; lampAim[5] = ay; lampAim[6] = az;
    {
      const o = LAMP_AT * 15, hx = lx + Math.sin(yaw) * 0.18, hz = lz + Math.cos(yaw) * 0.18, hy = 1.72;
      const dx = ax - hx, dy = ay - hy, dz = az - hz, dl = Math.hypot(dx, dy, dz) || 1;
      const le = sp ? 7.0 * E : 0;
      rig[o] = hx; rig[o + 1] = hy; rig[o + 2] = hz;
      rig[o + 3] = 1.10 * le; rig[o + 4] = 1.00 * le; rig[o + 5] = 0.82 * le;
      rig[o + 7] = dx / dl; rig[o + 8] = dy / dl; rig[o + 9] = dz / dl;
      rig[o + 14] = sp ? 0.6 : 0;
    }
    // One door-end washer with a tired ballast: three incommensurate sines, and
    // a drop only when they line up, so it flickers rarely rather than strobes.
    {
      const t = now / 1000, f = (Math.sin(t * 23.1) + Math.sin(t * 7.3) + Math.sin(t * 41.7)) / 3;
      const on = ctx && ctx.ambient === false ? 1 : f > 0.62 ? 0.30 : f > 0.50 ? 0.72 : 1, F = FIXTURES[8]!, e = F[4] * E * on, o = 8 * 15;
      rig[o + 3] = F[3][0] * e; rig[o + 4] = F[3][1] * e; rig[o + 5] = F[3][2] * e;
    }
    const u = (now - pulseAt) / 2200;
    if ((ctx && ctx.ambient === false) || u < 0 || u >= 1) return litRig(rig, _lit);
    const c2 = rgb(liv && (liv.accent || liv.stripe || liv.c2), [0.6, 0.62, 0.66]);
    const m = Math.max(c2[0], c2[1], c2[2]) || 1, ce = (2.6 / m) * E * Math.sin(u * Math.PI);
    const z = Z_BACK + (Z_DOOR - Z_BACK) * u;
    const chase = _chase;
    for (let i = 0; i < rig.length; i++) chase[i] = rig[i]!;
    chase.length = rig.length;
    chase.push(-4.6, 4.55, z, c2[0] * ce, c2[1] * ce, c2[2] * ce, 5, 0, -1, 0, 0.92, 0.55, 0.06, 0, 0.9);
    chase.push(4.6, 4.55, z, c2[0] * ce, c2[1] * ce, c2[2] * ce, 5, 0, -1, 0, 0.92, 0.55, 0.06, 0, 0.9);
    return litRig(chase, _lit);
  }

  let fanMesh: GfxMesh | null = null, lampMesh: GfxMesh | null = null, lampFace: GfxMesh | null = null;
  let passMesh: GfxMesh | null = null, mirrorFadeMesh: GfxMesh | null = null;
  const _mFan = new Float32Array(16), _mLamp = new Float32Array(16), _mPass = new Float32Array(16);
  const _mirrorFadeOpts = { alpha: 0.86, roughness: 0.34, metalness: 0, specular: 0.46, clearcoat: 0 };
  /** scene.js:720-726 */
  function ensureMirrorFade(): void {
    if (mirrorFadeMesh || !_gfx) return;
    const out = acc();
    // Bay box only — apron / pit lane stay opaque so a fade pass cannot open them.
    tile(out, -BOX_HW, BOX_HW, BOX_ZB, BOX_ZF, [0.115, 0.118, 0.126], 0.002, MAT.ASPHALT);
    mirrorFadeMesh = _gfx.createMesh(out);
  }
  /** The moving props: the fan blades, the work lamp, the passing car. scene.js:727-767 */
  function ensureDynamic(): void {
    if (fanMesh) return;
    const gfx = G();
    // Fan blades in the XY plane about the origin, turned about Z per frame.
    const f = acc();
    tube(f, [0, 0, -0.04], [0, 0, 0.06], 0.07, scale(STEEL, 0.8), 8, MAT.METAL);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2, r0 = 0.07, r1 = 0.30, w = 0.055;
      const P = (r: number, k: number): V3 => [Math.cos(a) * r - Math.sin(a) * k, Math.sin(a) * r + Math.cos(a) * k, 0.01];
      const o = P(r0, -w), pu = P(r1, -w), pv = P(r0, w);
      panelGrid(f, o, [pu[0] - o[0], pu[1] - o[1], 0], [pv[0] - o[0], pv[1] - o[1], 0], 1, 1, [0, 0, 1], () => scale(STEEL, 0.62));
      panelGrid(f, o, [pu[0] - o[0], pu[1] - o[1], 0], [pv[0] - o[0], pv[1] - o[1], 0], 1, 1, [0, 0, -1], () => scale(STEEL, 0.5));
    }
    fanMesh = gfx.createMesh(f);
    // The work lamp: tripod, column, head — facing +Z at the origin, yawed per preset.
    const l = acc();
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      tube(l, [0, 0.95, 0], [Math.cos(a) * 0.42, 0.02, Math.sin(a) * 0.42], 0.018, STEEL, 6, MAT.METAL);
      cyl(l, Math.cos(a) * 0.42, 0, Math.sin(a) * 0.42, 0.035, 0.03, RUBBER, 6);
    }
    cyl(l, 0, 0.3, 0, 0.025, 1.36, STEEL, 8, MAT.METAL);
    block(l, 0, 1.72, 0.10, 0.15, 0.11, 0.07, scale(STEEL, 0.55));            // head
    block(l, 0, 1.72, 0.03, 0.05, 0.05, 0.04, scale(STEEL, 0.7));             // yoke
    for (let i = 0; i < 4; i++) block(l, -0.12 + i * 0.08, 1.72, 0.18, 0.012, 0.10, 0.012, scale(STEEL, 0.8));   // guard
    lampMesh = gfx.createMesh(l);
    const lf = acc();
    block(lf, 0, 1.72, 0.172, 0.13, 0.09, 0.006, [1.35, 1.28, 1.10]);          // the lit face (emissive draw)
    lampFace = gfx.createMesh(lf);
    // A car passing in the pit lane: a dark silhouette with its light bar.
    const c = acc(), INK: V3 = [0.05, 0.05, 0.06];
    block(c, 0, 0.42, 0, 0.55, 0.16, 1.9, INK);                                  // body
    block(c, 0, 0.68, -0.3, 0.32, 0.12, 0.6, INK);                               // airbox/halo
    block(c, 0, 0.80, -2.2, 0.55, 0.05, 0.16, INK);                              // rear wing
    block(c, 0, 0.30, 2.5, 0.85, 0.03, 0.14, INK);                               // front wing
    for (const wx of [-0.7, 0.7]) for (const wz of [1.6, -1.55])
      tube(c, [wx - 0.17, 0.34, wz], [wx + 0.17, 0.34, wz], 0.34, [0.03, 0.03, 0.035], 10);
    block(c, 0, 0.55, -2.55, 0.04, 0.08, 0.02, [1.6, 0.2, 0.15]);                // rain light
    passMesh = gfx.createMesh(c);
  }

  let liveTex: GfxTexture | null = null, liveCanvas: GarageCanvas | null = null, liveFail = 0, liveRetryAt = 0;
  const liveMesh: Partial<Record<LiveSide, GfxMesh>> = {};
  const LIVE_OPTS = { glow: 0.62 }, FLOOR_DECAL_OPTS = { glow: 0 };

  // The custom team's uploaded emblem arrives asynchronously. Bump a generation
  // counter when it changes and put it in the cache key, so the wall repaints on
  // the very next frame instead of holding the previous mark. scene.js:982-987
  let logoGen = 0;
  if (LiveryTex && LiveryTex.onMarkChange) LiveryTex.onMarkChange(() => { logoGen++; });
  const DRESS_OPTS = { glow: 0.62 };

  // ── caches ─────────────────────────────────────────────────────────────────
  // Single-slot, keyed on team + EVERY livery colour the bay consumes, so a team
  // chip click or a livery edit rebuilds and the old buffers are freed on the
  // spot. One slot cannot leak more than one generation.
  //
  // The correct colours reach rebuild() on every frame — resolveLivery returns a
  // fresh object including the unsaved draft — so a key on liv.c1 ALONE would
  // throw them away and leave the whole bay (shell, props, floor band and the
  // dress atlas with the crest and boards) on its old paint after an ACCENT,
  // BODY STRIPE, DETAIL or TEAM LOGO edit, while the car repaints. A slot that
  // any future dressing reads MUST be added here too. scene.js:989-1012
  let floorMesh: GfxMesh | null = null, trussMesh: GfxMesh | null = null, cacheKey = "";
  const dressMesh: Partial<Record<Side, GfxMesh | null>> = {};
  let dressTex: GfxTexture | null = null, dressFail = 0, dressRetryAt = 0;
  // TWO keys, not one. Everything above is GEOMETRY and depends on the team and
  // its body colours; the dress atlas additionally carries the crest (logo,
  // logo2, logo3), the driver numbers and boardKey(info). Folding the crest into
  // the geometry key made a TEAM LOGO drag rebuild the shell, the LEDs, the
  // floor and every prop — the turntable hitch. Geometry survives a logo,
  // sponsor or number edit; only the atlas that reads those pixels repaints.
  let geomKey = "", liveKey = "", dressIdKey = "", dressFullKey = "", dressCanvas: GarageCanvas | null = null;
  const propMesh: Partial<Record<Side, GfxMesh | null>> = {};

  // What the ROOM shows of the game beyond the car: the selected circuit, the
  // weather and time of day the next race will run, and the career's tally.
  // game.js builds this once per frame; every field is optional, so the bay
  // draws without a career and without a track selection. scene.js:1077-1092
  function ctxKey(ctx: GarageCtx | null | undefined): string {
    if (!ctx) return "-";
    // Every field the live painters read: the career footer (round, last
    // result) and the sponsor banner too, or entering a career on the same
    // circuit kept "NEXT RACE" and the free-play footer.
    const last = ctx.last;
    // The `hydrated` bit: a LAZY_CIRCUIT stub paints no map; the key must change when it hydrates.
    const hyd = ctx.track && deps.trackResident && deps.trackResident(ctx.track) ? 1 : 0;
    return `${ctx.track ? ctx.track.id : "-"}:${hyd}|${ctx.weather || "-"}|${ctx.tod || "-"}`
           + `|${(ctx.wins as number) | 0}|${ctx.night ? 1 : 0}|${ctx.career ? 1 : 0}|${(ctx.round as number) | 0}`
           + `|${last ? (last.dnf || "") + ":" + ((last.p as number) | 0) + ":" + ((last.pts as number) | 0) : "-"}`
           + `|${ctx.sponsor && ctx.sponsor.label || "-"}|${ctx.studio ? 1 : 0}|${experience.careerKey(ctx)}`;
  }

  // The room's build identity. `geom` rebuilds meshes, `live` repaints the 512
  // screens, `dressId` repaints the crest, and `key` is the whole thing plus the
  // spec boards. rebuild() and prepared() share it. scene.js:1014-1031
  function roomKeys(team: GarageTeam, liv: GarageLivery | null | undefined, info: BoardInfo | null, ctx: GarageCtx | null | undefined) {
    const drv = [seatDriverAt(team, 0), seatDriverAt(team, 1)];
    // Same idiom as getCockpitWheel's _cockpitWheelKey (js/car/car-mesh.js): fold
    // every colour the build consumes, rounded, into one string.
    const kc = (c: readonly number[] | null | undefined | false): string => (c ? rgb(c, [0, 0, 0]).map((v) => v.toFixed(3)).join(",") : "-");
    const paint = `${kc(liv && liv.c1)}/${kc(liv && (liv.accent || liv.stripe || liv.c2))}/${kc(liv && liv.c2)}`;
    const marks = `${kc(liv && liv.logo)}/${kc(liv && liv.logo2)}/${kc(liv && liv.logo3)}`;
    const nums = `${drv[0] && drv[0].num}-${drv[1] && drv[1].num}`;
    const ck = ctxKey(ctx);
    // Shell, floor, LEDs, props and the career desks. Not the crest, the sponsor
    // banners or the pit-board numbers — those are atlas texels.
    const geom = `${team && team.id}|${(team && team.legend) || ""}|${paint}`
                 + `|${ctx && ctx.night ? 1 : 0}|${(ctx && ctx.weather) || "-"}|${experience.careerKey(ctx)}`;
    const live = `${paint}|${(liv && liv.sponsors) || "-"}|${ck}`;
    const dressId = `${team && team.id}|${(team && team.legend) || ""}|${paint}|${marks}|${logoGen}|${nums}`;
    return { geom, live, dressId, key: `${geom}|${live}|${dressId}|${boardKey(info)}` };
  }
  const uploadsOn = (): boolean => !!(_gfx && _gfx.createTexture && _gfx.createTexMesh && atlases());
  /** scene.js:1032-1052 */
  function uploadLive(team: GarageTeam, liv: GarageLivery | null | undefined, ctx: GarageCtx | null | undefined, now: number): void {
    const gfx = G();
    if (!gfx.createTexture || !gfx.createTexMesh || !atlases()) return;
    try {
      if (!liveCanvas) liveCanvas = createCanvas!(LIVE, LIVE);
      paintLive(liveCanvas, team, liv, ctx, LiveryTex!);
      experience.paintCareer(liveCanvas, ctx);
      if (liveTex && gfx.freeTexture) gfx.freeTexture(liveTex);
      liveTex = null;
      liveTex = gfx.createTexture(liveCanvas);
      if (!liveTex || liveTex._phase === 4) throw new Error("live texture upload returned no handle");
      if (!liveMesh.mid) {
        const lg = buildLiveQuads(FIXTURES);
        for (const k in lg) { const s = k as LiveSide; if (lg[s].idx.length) liveMesh[s] = gfx.createTexMesh(lg[s]); }
      }
      liveFail = 0; liveRetryAt = 0;
    } catch (e) {
      if (liveTex && gfx.freeTexture) gfx.freeTexture(liveTex);
      liveFail++; liveRetryAt = now + 1000; liveTex = null; log.warn(`GarageScene live atlas failed: ${e && (e as Error).message}`); }
  }
  /** scene.js:1053-1150 */
  function rebuild(team: GarageTeam, liv: GarageLivery | null | undefined, info: BoardInfo | null, ctx: GarageCtx | null | undefined): void {
    const gfx = G();
    const { geom, live, dressId, key } = roomKeys(team, liv, info, ctx);
    const now = nowMs();
    const uploads = uploadsOn();
    if (live !== liveKey) { liveFail = 0; liveRetryAt = 0; }
    if (key === cacheKey && shellMesh &&
        (liveTex || liveFail >= 3 || now < liveRetryAt || !uploads) &&
        (dressTex || dressFail >= 3 || now < dressRetryAt || !uploads)) return;
    if (geom !== geomKey || !shellMesh) {
      // A new team/paint/context is a fresh texture; old failed uploads must
      // not permanently remove this team's wall graphics or moving trace.
      dressFail = 0; dressRetryAt = 0; traceFail = 0;
      if (shellMesh) gfx.freeMesh(shellMesh);
      if (trussMesh) gfx.freeMesh(trussMesh);
      for (let i = 0; i < SIDES.length; i++) {
        const s = SIDES[i]!;
        if (ledMesh[s]) { gfx.freeMesh(ledMesh[s]); ledMesh[s] = null; }
      }
      if (floorMesh) gfx.freeMesh(floorMesh);
      for (let i = 0; i < SIDES.length; i++) {
        const s = SIDES[i]!;
        if (propMesh[s]) { gfx.freeMesh(propMesh[s]); propMesh[s] = null; }
      }
      const shell = acc();
      buildShell(shell, liv);
      shellMesh = gfx.createMesh(shell);
      const truss = acc();
      buildTruss(truss);
      trussMesh = gfx.createMesh(truss);
      const led = groups();
      buildLed(led, liv);
      for (let i = 0; i < SIDES.length; i++) {
        const s = SIDES[i]!;
        if (led[s].idx.length) ledMesh[s] = gfx.createMesh(led[s]);
      }
      const flr = acc();
      buildApron(flr, BACKDROP); buildPitLane(flr, liv, !!(ctx && ctx.night)); buildBayFloor(flr, liv);
      // The clear colour beyond the apron rim follows the hour outside.
      const bd = ctx && ctx.night ? [0.020, 0.022, 0.030] as const : [0.048, 0.052, 0.064] as const;
      BACKDROP[0] = bd[0]; BACKDROP[1] = bd[1]; BACKDROP[2] = bd[2];
      floorMesh = gfx.createMesh(flr);
      const g = groups();
      buildProps(g, liv);
      buildEquipment(g, liv, ctx);
      experience.buildFacility(g, liv, ctx);
      for (let i = 0; i < SIDES.length; i++) {
        const s = SIDES[i]!;
        if (g[s].idx.length) propMesh[s] = gfx.createMesh(g[s]);
      }
      for (let i = 0; i < SIDES.length; i++) {
        const s = SIDES[i]!;
        if (dressMesh[s]) { gfx.freeMesh(dressMesh[s]); dressMesh[s] = null; }
      }
      // A new team or paint: the "what changed" marker on the spec board starts
      // over — every row differs from the last team's, and a board of twelve
      // highlights marks nothing. The crest canvas itself is keyed below.
      resetSpec();
      geomKey = geom;
      liveKey = ""; liveFail = 0; liveRetryAt = 0;
      dressFullKey = "";
    }
    if (uploads && (live !== liveKey || !liveTex) && liveFail < 3 && now >= liveRetryAt) {
      uploadLive(team, liv, ctx, now);
      liveKey = live;
    }
    if (dressId !== dressIdKey) { dressCanvas = null; dressIdKey = dressId; }
    const dressFull = dressId + "|" + boardKey(info);
    if (dressFull === dressFullKey && dressTex) { cacheKey = key; return; }
    // Team dress. Three strikes then stop trying: an unbranded bay is far better
    // than a canvas that throws once a frame forever.
    if (dressTex && gfx.freeTexture) gfx.freeTexture(dressTex);
    dressTex = null;
    if (dressFail < 3 && uploads) {
      try {
        if (!dressCanvas) dressCanvas = paintDress(team, liv).canvas;
        paintBoards(dressCanvas, team, liv, info);
        dressTex = gfx.createTexture!(dressCanvas);
        if (!dressMesh.back) {
          const dg = buildDress(SIDES);
          for (let i = 0; i < SIDES.length; i++) {
            const s = SIDES[i]!;
            if (dg[s].idx.length) dressMesh[s] = gfx.createTexMesh!(dg[s]);
          }
        }
        if (!dressTex || dressTex._phase === 4) throw new Error("dress texture upload returned no handle");
        dressFail = 0; dressRetryAt = 0;
        dressFullKey = dressFull;
      } catch (e) {
        if (dressTex && gfx.freeTexture) gfx.freeTexture(dressTex);
        dressFail++; dressRetryAt = now + 1000; dressTex = null; dressCanvas = null;
        log.warn(`GarageScene dress failed: ${e && (e as Error).message}`);
      }
    }
    cacheKey = key;
  }

  // Squeegeed resin: matte enough to read as concrete, glossy enough that ten
  // real spot lights streak across it. The sheen is emergent from the lamp
  // energies above — it does not appear at a dimmer rig's levels. scene.js:1152-1157
  const FLOOR_OPTS: DrawOpts = { roughness: 0.34, metalness: 0, specular: 0.46, clearcoat: 0 };
  const SHELL_OPTS: DrawOpts = { roughness: 0.86, metalness: 0.05, specular: 0.16, clearcoat: 0 };
  const MAT_I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  let lastTrace = -1e9, traceFail = 0;
  const shutterMat = new Float32Array(MAT_I), arrivalMirror = new Float32Array(MAT_MIRROR);
  /** scene.js:1095-1194 */
  function draw(team: GarageTeam, liv: GarageLivery | null | undefined, eye: readonly number[] | null | undefined,
    getParts: GetParts | null | undefined, driverIdx: number, ctx?: GarageCtx | null, carMesh?: GfxMesh | null,
    arrival?: ArrivalPose | null, carMat?: Float32Array | null): void {
    if (!_gfx) return;
    const gfx = _gfx;
    rebuild(team, liv, boardInfo(team, getParts, driverIdx, ctx), ctx);
    ensureDynamic();
    const now = ctx && Number.isFinite(ctx.sceneNow) ? ctx.sceneNow! : nowMs();
    gfx.draw(floorMesh!, MAT_I, FLOOR_OPTS);
    const studio = !!(ctx && ctx.studio);
    // Room first so its depth is in the buffer: the reflection then depth-tests
    // against props/shell (they win) and only needs bias to clear the floor.
    const ex = eye ? eye[0]! : 0, ez = eye ? eye[2]! : 0;
    const inside = _inside;
    inside.nx = ex > -HALF_W; inside.px = ex < HALF_W; inside.back = ez > Z_BACK;
    inside.door = ez < Z_DOOR; inside.mid = true; inside.shutter = ez < Z_DOOR;
    inside.barrier = ez < Z_DOOR && !arrival;
    if (!studio) {
      gfx.draw(shellMesh!, MAT_I, SHELL_OPTS);
      // TOP looks down through the ceiling: hide the truss and the ceiling LED
      // housings so their beams do not stripe the car. Other presets restore them.
      const hideRoof = spotName === "top";
      if (trussMesh && !hideRoof) gfx.draw(trussMesh, MAT_I, SHELL_OPTS);
      // Each wall's furniture AND its lighting, only while the eye is inside that
      // wall — the same decision back-face culling makes for the wall itself. A
      // camera at SP_DIST_MAX (15 m) is outside the bay on at least one axis nearly
      // always, so this test fires constantly and is what keeps the cutaway clean.
      // Collapse the slats upward into the roller housing, anchored at the lintel.
      shutterMat[5] = arrival ? (4.77 * (1 - arrival.door) + 0.06) / 2.86 : 1;
      shutterMat[13] = arrival ? 4.77 * (1 - shutterMat[5]!) : 0;
      for (let i = 0; i < SIDES.length; i++) {
        const s = SIDES[i]!;
        if (!inside[s]) continue;
        if (propMesh[s]) gfx.draw(propMesh[s], s === "shutter" ? shutterMat : MAT_I, SHELL_OPTS);
        if (ledMesh[s] && !(hideRoof && s === "mid")) gfx.draw(ledMesh[s], MAT_I, LED_OPTS);
      }
      // Dress LAST of the environment: drawDecal depth-tests but does not depth
      // write, so every opaque surface it sits on has to be down first.
      if (dressTex)
        for (let i = 0; i < SIDES.length; i++) {
          const s = SIDES[i]!;
          if (inside[s] && dressMesh[s])
            gfx.drawDecal(dressMesh[s], s === "shutter" ? shutterMat : MAT_I, dressTex, DRESS_OPTS);
        }
      // The moving props. Fan on the back wall (its housing is in propMesh.back);
      // the lamp wherever the preset put it; the pit-lane pass every half minute.
      if (inside.back && fanMesh) gfx.draw(fanMesh, mk(_mFan, FAN[0], FAN[1], Z_BACK + 0.17, 0, now * 0.0065), SHELL_OPTS);
      // The crew (crew.ts), only while an arrival or drive-out plays.
      if (arrival && crew) crew.draw(liv, eye, arrival, SHELL_OPTS);
      if (lampMesh) {
        mk(_mLamp, lampAim[0]!, 0, lampAim[1]!, lampAim[2]!, 0);
        gfx.draw(lampMesh, _mLamp, SHELL_OPTS);
        if (lampAim[3]) gfx.draw(lampFace!, _mLamp, LED_OPTS);
      }
      {
        const cyc = (now / 1000) % 34;
        if ((!ctx || ctx.ambient !== false) && cyc < 6.5 && passMesh)
          gfx.draw(passMesh, mk(_mPass, -24 + 48 * (cyc / 6.5), -0.04, PIT_FAST_Z, Math.PI / 2, 0), SHELL_OPTS);
      }
      // The engineers' traces tick over every 1.5 s: repaint one region of the
      // live atlas and re-upload it (1 MB, a quarter of the dress). Three
      // strikes, as the dress: the atlas stays up with its last traces. Keep the
      // last working handle until the replacement uploads successfully: a
      // transient upload failure can then retry without losing the live atlas.
      // Phone: the trace is a 256×128 scribble, but the upload replaces the whole
      // 512² atlas. Stretch the hitch; desktop keeps the 1.5 s tick.
      const traceMs = (gfx.isMobile || gfx.mobileTier) ? 4000 : 1500;
      if ((!ctx || ctx.ambient !== false) && liveTex && liveCanvas && traceFail < 3 && now - lastTrace > traceMs) {
        lastTrace = now;
        try {
          paintTrace(liveCanvas, liv, now);
          const nextTex = gfx.createTexture!(liveCanvas);
          if (!nextTex || nextTex._phase === 4) throw new Error("trace texture upload returned no handle");
          if (gfx.freeTexture) gfx.freeTexture(liveTex);
          liveTex = nextTex;
          traceFail = 0;
        } catch (e) {
          traceFail++;
          log.warn(`GarageScene live trace failed: ${e && (e as Error).message}`);
        }
      }
    }
    // THE FLOOR REFLECTION: car again through MAT_MIRROR (X as the preview's
    // MAT_REFLECT_X, Y for the floor; det +1, no cull flip). Opaque resolve with
    // depthBias so under-floor fragments clear the floor and self-occlude; bay
    // fade quad restores contact sheen. After the room so props/shell clip it.
    if (carMesh) {
      if (carMat) { arrivalMirror.set(carMat); arrivalMirror[1] = -carMat[1]!; arrivalMirror[5] = -carMat[5]!; arrivalMirror[9] = -carMat[9]!; arrivalMirror[13] = -carMat[13]!; }
      else arrivalMirror.set(MAT_MIRROR);
      const sheen = mirrorSheen(eye, carMat);
      if (sheen > 0.02) {
        gfx.draw(carMesh, arrivalMirror, MIRROR_RESOLVE);
        ensureMirrorFade();
        if (mirrorFadeMesh) {
          _mirrorFadeOpts.alpha = 1 - sheen;
          gfx.draw(mirrorFadeMesh, MAT_I, _mirrorFadeOpts);
        }
      }
    }
    if (studio) return;   // car studio: floor + resolved reflection, no room dressing
    if (liveTex) {
      if (liveMesh.floor) gfx.drawDecal(liveMesh.floor, MAT_I, liveTex, FLOOR_DECAL_OPTS);
      for (let i = 0; i < LIVE_DECAL_SIDES.length; i++) {
        const k = LIVE_DECAL_SIDES[i]!;
        if (inside[k as Side] && liveMesh[k] && !(arrival && k === "door")) gfx.drawDecal(liveMesh[k], MAT_I, liveTex, LIVE_OPTS);
      }
    }
  }

  // ── the turntable's car meshes ─────────────────────────────────────────────
  // Keyed on team + resolved parts + livery id (the setup camera builds the
  // key). A garage session is A/B comparison — fit the duct, look, fit the
  // other one, look again — and a single-slot cache paid Car3D.build (~16 ms
  // here, several times that on a phone) for every return to an option already
  // seen. Six slots, least-recently-used out; the hull is kept beside its mesh
  // AND in its own map, because a colour-only repaint drops the meshes (the
  // paint is baked into the vertex colours) while the silhouette it was
  // computed from has not moved. scene.js:1295-1352
  const PREVIEW_SLOTS = 6;
  // dropPreviewMeshes keeps the hulls, so the mesh LRU alone never evicts the
  // hulls it orphaned: every repaint-then-new-part left one behind for the page.
  const HULL_SLOTS = PREVIEW_SLOTS * 2;
  const previewMeshes = new Map<string, PreviewEntry>(), previewHulls = new Map<string, number[] | null>();
  function previewMesh(key: string, hullKey: string, build: () => PreviewData): PreviewEntry {
    const gfx = G();
    let ent = previewMeshes.get(key);
    if (ent) { previewMeshes.delete(key); previewMeshes.set(key, ent); return ent; }
    const data = build();
    let hull = previewHulls.get(hullKey);
    if (hull) previewHulls.delete(hullKey);   // re-inserted below: least-recently-used first
    else hull = framingHull(data);
    previewHulls.set(hullKey, hull);
    ent = { mesh: gfx.createMesh(data), hull, hullKey };
    previewMeshes.set(key, ent);
    while (previewMeshes.size > PREVIEW_SLOTS) {
      const old = previewMeshes.keys().next().value!;
      const victim = previewMeshes.get(old)!;
      gfx.freeMesh(victim.mesh);
      previewMeshes.delete(old);
      if (victim.hullKey) {
        let used = false;
        for (const e of previewMeshes.values()) {
          if (e.hullKey === victim.hullKey) { used = true; break; }
        }
        if (!used) previewHulls.delete(victim.hullKey);
      }
    }
    if (previewHulls.size > HULL_SLOTS) {   // oldest first, never one a cached mesh still frames with
      const live = new Set([...previewMeshes.values()].map((e) => e.hullKey));
      for (const k of [...previewHulls.keys()]) {
        if (previewHulls.size <= HULL_SLOTS) break;
        if (!live.has(k)) previewHulls.delete(k);
      }
    }
    return ent;
  }
  // Every cached car is on the old paint after a livery edit — drop them all.
  // The hulls stay: presence-keyed, and a hue never moves a vertex; HULL_SLOTS
  // bounds them. scene.js:1353-1360
  function dropPreviewMeshes(): void {
    for (const ent of previewMeshes.values()) G().freeMesh(ent.mesh);
    previewMeshes.clear();
  }

  // THE ROOM WITHOUT A FRAME (prebuild.ts): the same rebuild draw() runs first,
  // so the GARAGE tap's first frame finds the room already built. Builds meshes
  // and canvases only; the programs still compile on a draw. scene.js:1362-1374
  function prepare(team: GarageTeam, liv: GarageLivery | null | undefined, getParts: GetParts | null | undefined,
    driverIdx: number, ctx?: GarageCtx | null): boolean {
    if (!_gfx) return false;
    rebuild(team, liv, boardInfo(team, getParts, driverIdx, ctx), ctx);
    ensureDynamic();
    return prepared(team, liv, getParts, driverIdx, ctx);
  }
  function prepared(team: GarageTeam, liv: GarageLivery | null | undefined, getParts: GetParts | null | undefined,
    driverIdx: number, ctx?: GarageCtx | null): boolean {
    return !!shellMesh && roomKeys(team, liv, boardInfo(team, getParts, driverIdx, ctx), ctx).key === cacheKey;
  }

  // THE RACE DOES NOT CARRY THE GARAGE: the bay, both atlases, the moving props and
  // the cached preview cars (~12.5 MB GPU, 54 k verts, plus ~5 MB of canvases) stayed
  // resident through every race after the first garage visit. Freed at race start
  // (prebuild.ts release); draw() and prepare() rebuild all of it lazily, and the
  // cleared keys make the next idle title pre-build it again. Returns the handles
  // freed. scene.js:1376-1406
  function release(): number {
    if (!_gfx) return 0;
    const gfx = _gfx;
    let n = 0;
    const fm = (m: GfxMesh | null | undefined): null => { if (m) { gfx.freeMesh(m); n++; } return null; };
    const ft = (t: GfxTexture | null): null => { if (t && gfx.freeTexture) { gfx.freeTexture(t); n++; } return null; };
    shellMesh = fm(shellMesh); floorMesh = fm(floorMesh); trussMesh = fm(trussMesh);
    for (const tbl of [ledMesh, propMesh, dressMesh, liveMesh] as Record<string, GfxMesh | null | undefined>[])
      for (const k of Object.keys(tbl)) { fm(tbl[k]); delete tbl[k]; }
    fanMesh = fm(fanMesh); lampMesh = fm(lampMesh); lampFace = fm(lampFace); passMesh = fm(passMesh);
    dressTex = ft(dressTex); liveTex = ft(liveTex);
    for (const ent of previewMeshes.values()) fm(ent.mesh);
    previewMeshes.clear(); previewHulls.clear();
    dressCanvas = null; liveCanvas = null; releaseDress();
    cacheKey = ""; geomKey = ""; liveKey = ""; dressIdKey = ""; dressFullKey = ""; dressFail = 0; dressRetryAt = 0; liveFail = 0; liveRetryAt = 0; traceFail = 0; lastTrace = -1e9;
    _rigK0 = NaN; _rigK1 = NaN; _rigK2 = NaN; _rig.length = 0; _chase.length = 0;
    return n;
  }

  /** scene.js:1408-1411 (note: lights(null) re-keys the rig cache, as in f1-game). */
  function debug(): SceneDebug {
    return { bay: [HALF_W * 2, Z_DOOR - Z_BACK, CEIL_Y], lights: lights(null).length / 15, key: cacheKey,
             geomKey, previewMeshes: previewMeshes.size, previewHulls: previewHulls.size };
  }

  return {
    init, buildStatic, BACKDROP, SKYLIGHT, AMB_SKY, AMB_GROUND, lights, live, glareStr, draw, framingHull, recentre,
    previewMesh, dropPreviewMeshes, pulse, spot, debug, seatDriverAt, ctxKey, prepare, prepared, release,
  };
}

/** The colour css() of a V3, re-exported for the setup sheet's swatches. */
export { css };
/** Re-exported for callers that type a track for ctx. */
export type { GarageTrack, GarageCanvas, TexGroups };
