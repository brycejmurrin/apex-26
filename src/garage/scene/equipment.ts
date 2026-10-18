/**
 * GarageEquipment: the pit equipment standing in the bay. The rear jack, the
 * wheel guns on their hose reels, the tyre trolleys, floor boxes, the fan, the
 * trophy cabinet and the timing-screen housing, built into the per-wall
 * groups by build(g, liv, ctx).
 *
 * Ported verbatim from f1-game js/garage/scene-equipment.js:1-170
 * (GarageEquipment). Float operation order is f1-game's.
 */
import type { GarageCtx, GarageLivery, Groups } from "./types";
import { block, cyl, DARK, hose, MAT, rgb, scale, STEEL, tile, tube, Z_BACK, type MeshAcc, type V3 } from "./prims";

export const RUBBER: V3 = [0.045, 0.045, 0.050];
export const HOSE: V3 = [0.12, 0.14, 0.20];
export const FAN = [4.5, 3.32] as const;
export const SCREEN = [2.9, 3.30, 5.15] as const;   // shared with the blades and the live atlas quad
export const COMPOUND: readonly V3[] = [[0.85, 0.12, 0.12], [0.92, 0.80, 0.10], [0.88, 0.88, 0.90],
                                        [0.10, 0.60, 0.25], [0.15, 0.35, 0.85]];   // S M H, inter, wet

/** scene-equipment.js:13-166 */
export function build(g: Groups, liv: GarageLivery | null | undefined, ctx: GarageCtx | null | undefined): void {
  const c1 = rgb(liv && liv.c1, [0.30, 0.32, 0.36]);
  const team = scale(c1, 0.85);
  const dark = scale(STEEL, 0.55);
  // REAR JACK: the T-bar quick-lift, parked in the deep +X corner so the REAR
  // preset is a clear look at the gearbox, not a handle across the tail.
  block(g.mid, 2.85, 0.13, -4.55, 0.36, 0.05, 0.09, team);              // lifting head
  for (const sx of [-1, 1]) cyl(g.mid, 2.85 + sx * 0.34, 0, -4.55, 0.06, 0.10, RUBBER, 8);
  tube(g.mid, [2.85, 0.20, -4.62], [3.55, 0.62, -5.55], 0.03, STEEL, 6, MAT.METAL);   // handle
  block(g.mid, 3.55, 0.62, -5.58, 0.24, 0.025, 0.025, team);           // T grip
  // WHEEL GUNS on their hoses. A boom off each cable tray carries a reel over
  // the box with its hose RETRACTED — the first pass ran a hose from each reel
  // straight down to each gun, and four 5 m diagonals crossing the car read
  // as guy-lines in every preset. Between stops the guns lie by their wheels
  // on a coil of hose from a floor manifold at the box edge, which is what a
  // real bay looks like and keeps everything below knee height.
  // z -1.75, in the gap between the side walls' wordmark bays (z -1.1..1.1
  // and -2.4..-4.6): at z 0.1 the reel and its drop hung straight in front of
  // the middle wordmark, which the SIDE preset reads as a sign cut in two.
  const BZ = -1.75;
  for (const sd of [-1, 1]) {
    const bx = sd * 2.3;
    tube(g.mid, [sd * 4.6, 4.40, BZ], [bx, 4.40, BZ], 0.045, dark, 6, MAT.METAL);   // boom
    for (let i = 0; i < 3; i++)
      block(g.mid, sd * (2.9 + i * 0.6), 4.40, BZ, 0.02, 0.09, 0.02, STEEL);        // hangers
    cyl(g.mid, bx, 4.05, BZ, 0.20, 0.16, scale(DARK, 1.5), 10);                      // reel drum
    cyl(g.mid, bx, 4.21, BZ, 0.06, 0.20, STEEL, 6);                                  // spindle
    hose(g.mid, [[bx, 4.05, BZ], [bx, 3.50, BZ]], 0.025, HOSE, 6);                   // retracted drop
    block(g.mid, bx, 3.46, BZ, 0.04, 0.05, 0.04, STEEL);                             // coupling
    block(g.mid, sd * 2.36, 0.08, BZ, 0.10, 0.08, 0.24, dark);                       // floor manifold
    for (const wz of [1.7, -1.6]) {
      const gx = sd * 2.65;
      const gz = wz + (wz > 0 ? 0.55 : -0.55);
      const cz = wz * 0.55;
      // The coil: six short legs zig-zagging at floor level beside the manifold.
      const pts: V3[] = [[sd * 2.36, 0.08, BZ + (wz > 0 ? 0.14 : -0.14)]];
      for (let k = 0; k < 6; k++)
        pts.push([sd * (2.05 + (k % 2 ? 0.22 : -0.02)), 0.035 + (k % 3) * 0.02, cz + (k - 2.5) * 0.11]);
      pts.push([gx + sd * 0.12, 0.05, gz]);
      hose(g.mid, pts, 0.024, HOSE, 6);
      block(g.mid, gx, 0.10, gz, 0.06, 0.06, 0.13, team);                            // gun body
      tube(g.mid, [gx, 0.10, gz + (wz > 0 ? -0.13 : 0.13)], [gx, 0.10, gz + (wz > 0 ? -0.30 : 0.30)], 0.035, scale(STEEL, 0.7), 6, MAT.METAL);   // socket
      block(g.mid, gx + sd * 0.09, 0.14, gz, 0.02, 0.09, 0.03, dark);                // trigger grip
    }
  }
  // STARTER CART and its umbilical into the gearbox: the one prop that touches
  // the car, and the reason a parked car in a real bay never looks abandoned.
  {
    const cx = -1.95;
    const cz = -4.75;
    block(g.mid, cx, 0.40, cz, 0.30, 0.24, 0.24, scale(c1, 0.55));               // cabinet
    block(g.mid, cx, 0.66, cz, 0.31, 0.02, 0.25, STEEL);
    block(g.mid, cx + 0.12, 0.72, cz - 0.05, 0.06, 0.04, 0.04, [0.75, 0.15, 0.10]); // start button
    for (let w = 0; w < 4; w++)
      cyl(g.mid, cx + (w % 2 ? 0.24 : -0.24), 0, cz + (w < 2 ? 0.18 : -0.18), 0.06, 0.12, RUBBER, 8);
    tube(g.mid, [cx - 0.3, 0.16, cz], [cx - 0.55, 0.95, cz], 0.02, STEEL, 6, MAT.METAL);   // push handle
    tube(g.mid, [cx - 0.55, 0.95, cz - 0.18], [cx - 0.55, 0.95, cz + 0.18], 0.02, STEEL, 6, MAT.METAL);
    hose(g.mid, [[cx + 0.2, 0.62, cz], [cx + 0.55, 0.22, cz + 0.28], [cx + 0.40, 0.08, cz + 0.08], [cx + 0.75, 0.08, cz + 0.42]],
         0.02, [0.48, 0.22, 0.06], 6);                                             // umbilical, parked at the cart
  }
  // TYRE TROLLEYS at the deep end: four wheels upright under their blankets,
  // a cable to the control box, and the compound sticker on each blanket. The
  // wheel is an oriented tube along X: rubber, then a slightly fatter and
  // shorter tube of team colour over the tread for the blanket.
  const trolley = (out: MeshAcc, x: number, z: number, comps: readonly number[]): void => {
    for (const sx of [-1, 1]) tube(out, [x + sx * 0.42, 0.58, z - 1.3], [x + sx * 0.42, 0.58, z + 1.3], 0.025, STEEL, 6, MAT.METAL);
    for (const ez of [-1.3, 1.3]) tube(out, [x - 0.42, 0.58, z + ez], [x + 0.42, 0.58, z + ez], 0.025, STEEL, 6, MAT.METAL);
    for (let w = 0; w < 4; w++)
      cyl(out, x + (w % 2 ? 0.38 : -0.38), 0, z + (w < 2 ? 1.2 : -1.2), 0.05, 0.10, RUBBER, 6);
    for (let i = 0; i < 4; i++) {
      const wz = z - 1.0 + i * 0.68;
      tube(out, [x - 0.17, 0.44, wz], [x + 0.17, 0.44, wz], 0.34, RUBBER, 14);
      tube(out, [x - 0.19, 0.44, wz], [x + 0.19, 0.44, wz], 0.36, scale(c1, 0.6), 14);   // blanket
      tube(out, [x - 0.10, 0.44, wz], [x - 0.20, 0.44, wz], 0.20, scale(STEEL, 0.9), 10, MAT.METAL);   // rim face
      block(out, x + 0.20, 0.62, wz, 0.012, 0.08, 0.12, COMPOUND[comps[i]!]!);          // sticker
      hose(out, [[x + 0.19, 0.30, wz], [x + 0.30, 0.20, wz + 0.1], [x + 0.30, 0.20, z + 1.45]], 0.012, HOSE, 5);
    }
    block(out, x + 0.30, 0.42, z + 1.50, 0.10, 0.14, 0.06, dark);                     // blanket controller
    for (let l = 0; l < 4; l++) block(out, x + 0.30 + (l % 2 ? 0.04 : -0.04), 0.50 + (l < 2 ? 0.04 : -0.02), z + 1.565, 0.012, 0.012, 0.005, l % 3 ? [0.2, 0.9, 0.3] : [0.9, 0.5, 0.1]);   // status LEDs
  };
  const wet = ctx && (ctx.weather === "wet" || ctx.weather === "rain");
  trolley(g.back, 3.65, -4.85, wet ? [3, 3, 4, 4] : [0, 0, 1, 1]);
  trolley(g.back, -3.65, -4.85, wet ? [3, 4, 1, 1] : [1, 2, 2, 0]);
  // FLOOR: a painted box at each wheel and the hazard hatch at the threshold.
  const PAINT: V3 = [0.66, 0.67, 0.70];
  const HAZ: V3 = [0.80, 0.68, 0.10];
  for (const w of [[0.79, 1.7], [-0.79, 1.7], [0.76, -1.6], [-0.76, -1.6]] as const) {
    const x = w[0];
    const z = w[1];
    const hx = 0.30;
    const hz = 0.46;
    const t = 0.035;
    tile(g.mid, x - hx, x + hx, z - hz, z - hz + t, PAINT, 0.003, MAT.ASPHALT);
    tile(g.mid, x - hx, x + hx, z + hz - t, z + hz, PAINT, 0.003, MAT.ASPHALT);
    tile(g.mid, x - hx, x - hx + t, z - hz, z + hz, PAINT, 0.003, MAT.ASPHALT);
    tile(g.mid, x + hx - t, x + hx, z - hz, z + hz, PAINT, 0.003, MAT.ASPHALT);
  }
  for (let i = -7; i <= 7; i++)
    tile(g.mid, i * 0.40 - 0.13, i * 0.40 + 0.13, 5.62, 5.98, i % 2 ? HAZ : DARK, 0.003, MAT.ASPHALT);
  // CONDUIT drops off the cable trays to a junction box on each side wall.
  for (const sd of [-1, 1]) {
    const w = sd < 0 ? g.nx : g.px;
    for (const z of [-2.3, 2.3]) {
      hose(w, [[sd * 4.6, 3.60, z], [sd * 5.30, 3.40, z], [sd * 5.30, 2.05, z]], 0.03, scale(STEEL, 0.5), 6, MAT.METAL);
      block(w, sd * 5.30, 1.92, z, 0.05, 0.11, 0.09, scale(STEEL, 0.45));
    }
  }
  // EXTRACTOR FAN housing, high on the back wall; the blades are a separate
  // mesh so they can turn (fanMesh, drawn in draw()).
  // At y 3.32, r 0.36 (top at 3.68): the FRONT preset's frame tops out at
  // y 3.76 on this wall and cut it at 3.75 and again at 3.45; the pit board
  // below tops out at 2.92.
  tube(g.back, [FAN[0], FAN[1], Z_BACK + 0.02], [FAN[0], FAN[1], Z_BACK + 0.22], 0.36, scale(STEEL, 0.7), 16, MAT.METAL);
  tube(g.back, [FAN[0], FAN[1], Z_BACK + 0.10], [FAN[0], FAN[1], Z_BACK + 0.24], 0.32, [0.03, 0.032, 0.038], 16);   // the dark throat
  for (let i = 0; i < 3; i++) {                                                  // guard bars
    const a = i * Math.PI / 3;
    const dx = Math.cos(a) * 0.33;
    const dy = Math.sin(a) * 0.33;
    tube(g.back, [FAN[0] - dx, FAN[1] - dy, Z_BACK + 0.27], [FAN[0] + dx, FAN[1] + dy, Z_BACK + 0.27], 0.012, STEEL, 5, MAT.METAL);
  }
  // TROPHY CABINET, counter height under the +X pit board: a glass case the
  // career fills. Empty in free play it still holds the two helmets.
  {
    const cx = 4.55;
    const cz = Z_BACK + 0.32;
    const wins = Math.min(8, ((ctx && ctx.wins) as number) | 0);
    block(g.back, cx, 0.55, cz, 0.62, 0.55, 0.30, scale(c1, 0.45));               // plinth
    block(g.back, cx, 1.40, cz, 0.64, 0.30, 0.32, DARK);                           // case back
    block(g.back, cx, 1.40, cz + 0.30, 0.64, 0.30, 0.008, [0.22, 0.26, 0.32]);     // glass (dark, reflective look)
    block(g.back, cx, 1.24, cz, 0.60, 0.012, 0.28, scale(STEEL, 0.9));             // shelf
    for (let i = 0; i < wins; i++) {                                               // trophies
      const tx = cx - 0.50 + (i % 4) * 0.33;
      const ty = i < 4 ? 1.25 : 1.55;
      cyl(g.back, tx, ty, cz, 0.05, 0.03, [0.85, 0.70, 0.25], 8, MAT.METAL);
      cyl(g.back, tx, ty + 0.03, cz, 0.018, 0.10, [0.92, 0.78, 0.30], 6, MAT.METAL);
      cyl(g.back, tx, ty + 0.13, cz, 0.045, 0.08, [0.95, 0.82, 0.32], 8, MAT.METAL);
    }
    if (wins < 5) block(g.back, cx, 1.55, cz, 0.60, 0.012, 0.28, scale(STEEL, 0.9));   // upper shelf
    for (const hx of [-0.42, 0.42]) {                                              // the drivers' helmets
      cyl(g.back, cx + hx, wins < 5 ? 1.565 : 1.25, cz, 0.11, 0.16, scale(c1, 1.1), 10);
      cyl(g.back, cx + hx, (wins < 5 ? 1.565 : 1.25) + 0.16, cz, 0.09, 0.05, scale(c1, 1.1), 10);
      block(g.back, cx + hx, (wins < 5 ? 1.565 : 1.25) + 0.10, cz + 0.10, 0.07, 0.03, 0.02, [0.06, 0.06, 0.07]);   // visor
    }
  }
  // TIMING SCREEN over the door end, hung from the truss and facing the car —
  // the REAR and HERO presets look straight at it. The face is a dress quad
  // from the live atlas (live.ts build); this is only the housing and its hangers.
  // Off-centre (x +2.9, top-left from the REAR preset) so the shutter's
  // wordmark stays readable behind it, and at y 3.3 because that preset's
  // frame tops out at y 3.62 on the door wall.
  block(g.mid, SCREEN[0], SCREEN[1], SCREEN[2], 0.92, 0.72, 0.05, DARK);
  block(g.mid, SCREEN[0], SCREEN[1], SCREEN[2] + 0.04, 0.96, 0.76, 0.02, scale(STEEL, 0.5));   // bezel
  for (const hx of [-0.7, 0.7]) tube(g.mid, [SCREEN[0] + hx, SCREEN[1] + 0.72, SCREEN[2]], [SCREEN[0] + hx, 4.98, SCREEN[2]], 0.02, STEEL, 6, MAT.METAL);
}
