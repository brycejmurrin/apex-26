/**
 * GarageCrew: the pit crew in the garage on an arrival and the RACE!
 * drive-out. Two mechanics beside the car's nose who step back as the shutter
 * lifts, and a lollipop man out in the working lane on the camera's side who
 * holds his board across the car's path and lifts it as the car rolls. Built
 * from the room's own primitives, in the team's overalls, and drawn only
 * while a pose is playing — a parked setup preview has no crew.
 *
 * Ported verbatim from f1-game js/garage/scene-crew.js:1-98 (GarageCrew). The
 * IIFE's module state (gfx, the colour key, the three meshes, the matrix
 * scratch) is one instance per createGarageCrew() call; GarageScene owns one.
 */
import { acc, block, cyl, rgb, scale, tube, type MeshAcc, type V3 } from "./prims";
import type { ArrivalPose, DrawOpts, GarageGfx, GarageLivery, GfxMesh } from "./types";

const OPTS: DrawOpts = { roughness: 0.9, metalness: 0.02, specular: 0.12, clearcoat: 0 };
const SKIN: V3 = [0.62, 0.47, 0.38], BOOT: V3 = [0.06, 0.06, 0.07], VISOR: V3 = [0.05, 0.06, 0.08];
// WHERE THEY STAND (bay metres: x right, z toward the door at 6.4). scene-crew.js:16-19
const MECH_X0 = 1.55, MECH_X1 = 2.9, MECH_Z0 = 2.6, MECH_Z1 = 3.0;   // beside the nose → stepped back
const LOLLI_X = 2.2, LOLLI_Z = 8.6;                                 // working lane, camera side
export const RAISED = 1.35, LOWERED = 0.05;                         // board pole angle above horizontal

/** The facade members the crew uses (scene-crew.js only creates, frees and draws). */
export type CrewGfx = Pick<GarageGfx, "createMesh" | "draw"> & Partial<Pick<GarageGfx, "freeMesh">>;

/** layout()'s answer: [x, z, yaw] per mechanic, and the lollipop man. */
export interface CrewLayout {
  mechanics: [number, number, number][];
  lollipop: { x: number; z: number; yaw: number; raise: number };
}

// A standing figure about the origin, facing +z: boots, legs, team overalls,
// arms at the sides, a helmet with a visor. `arms` false leaves the right arm
// off for the lollipop man, whose arm is the pole mesh. scene-crew.js:27-44
export function figure(out: MeshAcc, c1: V3, c2: V3, arms: boolean): void {
  for (const s of [-1, 1]) {
    block(out, s * 0.10, 0.05, 0.03, 0.07, 0.05, 0.12, BOOT);
    block(out, s * 0.10, 0.48, 0, 0.075, 0.38, 0.085, scale(c1, 0.8));
  }
  block(out, 0, 1.13, 0, 0.21, 0.30, 0.13, c1);                       // overalls
  block(out, 0, 1.30, 0.135, 0.15, 0.04, 0.006, scale(c2, 0.95));     // chest panel
  for (const s of arms ? [-1, 1] : [-1]) {
    block(out, s * 0.27, 1.13, 0, 0.055, 0.29, 0.065, c1);
    block(out, s * 0.27, 0.80, 0, 0.05, 0.05, 0.05, scale(SKIN, 0.9)); // glove
  }
  cyl(out, 0, 1.43, 0, 0.06, 0.07, SKIN, 8);                          // neck
  block(out, 0, 1.62, 0, 0.13, 0.14, 0.14, scale(c2, 0.9));           // helmet
  block(out, 0, 1.62, 0.135, 0.10, 0.045, 0.01, VISOR);
}

/** The lollipop arm and board along local +x from the shoulder. scene-crew.js:55-61 */
export function pole(out: MeshAcc, c1: V3): void {
  block(out, 0.16, 0, 0, 0.16, 0.05, 0.06, c1);                          // upper arm
  tube(out, [0.30, 0, 0], [1.75, 0, 0], 0.016, [0.85, 0.85, 0.88], 6);   // pole
  tube(out, [1.95, 0, -0.012], [1.95, 0, 0.012], 0.24, [0.95, 0.95, 0.96], 16);   // board
  tube(out, [1.95, 0, -0.016], [1.95, 0, 0.016], 0.17, [0.86, 0.10, 0.08], 16);   // its red face
}

const ease = (x: number): number => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };

/** Where everyone stands for a pose: pure, so it is testable. `cam` is the
 *  side of the bay the camera stands on (sign of the eye's x). scene-crew.js:82-91 */
export function layout(pose: ArrivalPose, cam: number): CrewLayout {
  // f1-game reads pose.z unguarded; an absent z compares false, as NaN does.
  const back = ease(pose.door), out = (pose.z ?? NaN) > 0.3 || Math.abs(pose.x || 0) > 0.3;
  const mx = MECH_X0 + (MECH_X1 - MECH_X0) * back, mz = MECH_Z0 + (MECH_Z1 - MECH_Z0) * back;
  return {
    mechanics: [[-mx, mz, Math.PI / 2], [mx, mz, -Math.PI / 2]],      // [x, z, yaw]: facing the car
    lollipop: { x: cam * LOLLI_X, z: LOLLI_Z, yaw: cam > 0 ? Math.PI : 0, raise: out ? RAISED : LOWERED },
  };
}

export interface GarageCrewApi {
  init(g: CrewGfx | null): void;
  draw(liv: GarageLivery | null | undefined, eye: readonly number[] | null | undefined,
    pose: ArrivalPose | null | undefined, opts?: DrawOpts): void;
  layout: typeof layout;
  free(): void;
  readonly RAISED: number;
  readonly LOWERED: number;
}

/** One crew (scene-crew.js:9-97). */
export function createGarageCrew(): GarageCrewApi {
  let gfx: CrewGfx | null = null, key = -1;
  let mechMesh: GfxMesh | null = null, bodyMesh: GfxMesh | null = null, poleMesh: GfxMesh | null = null;
  const _m = new Float32Array(16);

  function build(liv: GarageLivery | null | undefined, g: CrewGfx): void {
    const c1 = rgb(liv && liv.c1, [0.30, 0.32, 0.36]);
    const c2 = rgb(liv && (liv.accent || liv.stripe || liv.c2), [0.85, 0.86, 0.88]);
    const k = c1[0] * 1e6 + c1[1] * 1e3 + c1[2] + c2[0] * 7 + c2[1] * 11 + c2[2] * 13;
    if (k === key && mechMesh) return;
    free();
    key = k;
    const m = acc(); figure(m, c1, c2, true); mechMesh = g.createMesh(m);
    const b = acc(); figure(b, c1, c2, false); bodyMesh = g.createMesh(b);
    // The lollipop: arm and pole along local +x from the shoulder, the round
    // board at the end facing ±z (toward the car), raised by a turn about z.
    const p = acc(); pole(p, c1); poleMesh = g.createMesh(p);
  }
  function free(): void {
    if (!gfx || !gfx.freeMesh) return;
    for (const mesh of [mechMesh, bodyMesh, poleMesh]) if (mesh) gfx.freeMesh(mesh);
    mechMesh = bodyMesh = poleMesh = null; key = -1;
  }
  // Column-major T * Ry(ay) * Rz(az) into _m (scene.ts mk's convention). scene-crew.js:70-78
  function mk(tx: number, ty: number, tz: number, ay: number, az: number): Float32Array {
    const cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
    _m[0] = cy * cz; _m[1] = sz; _m[2] = -sy * cz; _m[3] = 0;
    _m[4] = -cy * sz; _m[5] = cz; _m[6] = sy * sz; _m[7] = 0;
    _m[8] = sy; _m[9] = 0; _m[10] = cy; _m[11] = 0;
    _m[12] = tx; _m[13] = ty; _m[14] = tz; _m[15] = 1;
    return _m;
  }
  function init(g: CrewGfx | null): void { if (g !== gfx) { free(); gfx = g; } }
  function draw(liv: GarageLivery | null | undefined, eye: readonly number[] | null | undefined,
    pose: ArrivalPose | null | undefined, opts?: DrawOpts): void {
    if (!gfx || !pose) return;
    build(liv, gfx);
    const L = layout(pose, eye && eye[0]! > 0 ? 1 : -1);
    for (const [x, z, yaw] of L.mechanics) gfx.draw(mechMesh!, mk(x, 0, z, yaw, 0), opts || OPTS);
    const lp = L.lollipop;
    gfx.draw(bodyMesh!, mk(lp.x, 0, lp.z, lp.yaw + Math.PI, 0), opts || OPTS);   // facing the garage
    // The pole from the right shoulder, across the car's path, lifted by `raise`.
    const sx = lp.x + (lp.yaw === 0 ? 0.25 : -0.25);
    gfx.draw(poleMesh!, mk(sx, 1.38, lp.z, lp.yaw, lp.raise), opts || OPTS);
  }
  return Object.freeze({ init, draw, layout, free, RAISED, LOWERED });
}
