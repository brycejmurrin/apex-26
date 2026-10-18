// Car surface ids, finish remaps, palette colours and paint helpers.
// Ported verbatim from f1-game js/car/car-materials.js:1-116 (Teams lookup in
// tcamColour takes the team list as an argument; the 2026 grid lands with ./teams).
import { CarMaterialShade } from "./material-shade";
import type { MeshOut, Vec3 } from "./types";

// car-materials.js:4
export const SURFACES = Object.freeze({
  custom: 0, paint: 20, carbon: 21, rubber: 22,
  metal: 23, glass: 24, visor: 32,   // 32 is glass-like but DIELECTRIC, not chrome
  emissive: 25, functionalEmissive: 25, panel: 26, mirror: 27, sidewall: 33,   // 33: satin tyre sidewall
});
export type Surfaces = typeof SURFACES;

// car-materials.js:22. A livery FINISH is a surface-id remap on painted vertices,
// not a material uniform: the car shader classifies ids 20-37 and branches per id.
export const FINISH_SURFACE = Object.freeze({
  satin: 26, chrome: 27, matte: 28, carbon: 31, brushed: 29, pearl: 30,
  flake: 34, candy: 35, tinted: 36, chameleon: 37,
});
export type FinishId = keyof typeof FINISH_SURFACE;
// car-materials.js:30
export const FINISH_RESERVED = Object.freeze({ flake: 34, candy: 35, tinted: 36, chameleon: 37 });

// car-materials.js:31-46. Identity matters: geometry.ts surfaceOf compares by ===.
export const DARK: Vec3 = [0.05, 0.05, 0.05];
export const CARBON: Vec3 = [0.055, 0.056, 0.062];
export const VISOR: Vec3 = [0.08, 0.08, 0.09];
export const PANEL: Vec3 = [0.82, 0.82, 0.86];
export const TYRE: Vec3 = [0.06, 0.06, 0.07];
export const RIM: Vec3 = [0.11, 0.11, 0.13];
export const HUB: Vec3 = [0.28, 0.28, 0.31];
export const INTAKE: Vec3 = [0.03, 0.03, 0.04];
export const HALO: Vec3 = [0.22, 0.225, 0.245];
export const EXHAUST: Vec3 = [0.14, 0.13, 0.12];
export const TYRE_BAND: Readonly<Record<0 | 1 | 2, Vec3>> = { 0: [0.92, 0.92, 0.90], 1: [0.85, 0.10, 0.08], 2: [0.95, 0.15, 0.05] };
export const BRAKE_CALIPER: Readonly<Record<0 | 1 | 2, Vec3 | null>> = { 0: null, 1: null, 2: [0.75, 0.08, 0.05] };
export const TCAM_IDS = Object.freeze(["team", "auto", "black", "yellow"] as const);
const TCAM_BLACK: Vec3 = Object.freeze([0.05, 0.05, 0.06] as const);
const TCAM_YELLOW: Vec3 = Object.freeze([0.96, 0.78, 0.08] as const);

/** The slice of f1-game's Teams.LIST that tcamColour reads. */
export interface TeamDrivers {
  id: string;
  drivers?: readonly { num: number }[];
}

// car-materials.js:47
export function tcamColour(
  pick: string | undefined,
  teamId: string | undefined,
  num: number | undefined,
  accent: Vec3,
  teams: readonly TeamDrivers[] = [],
): Vec3 {
  if (pick === "black") return TCAM_BLACK;
  if (pick === "yellow") return TCAM_YELLOW;
  if (pick === "auto") {
    const t = teams.find((x) => x.id === teamId);
    const first = t && t.drivers && t.drivers[0] ? t.drivers[0].num : null;
    return (first != null && num != null && num !== first) ? TCAM_YELLOW : TCAM_BLACK;
  }
  return accent;
}

// car-materials.js:59. Smooth a curved skin by averaging coincident face normals.
export function smoothSkin(out: MeshOut, start: number): void {
  const normals = new Map<string, [number, number, number]>();
  for (let i = start; i < out.pos.length / 3; i++) {
    const k = out.pos.slice(i * 3, i * 3 + 3).join(","), n = normals.get(k) || [0, 0, 0];
    for (let j = 0; j < 3; j++) n[j]! += out.nrm[i * 3 + j]!;
    normals.set(k, n);
  }
  for (let i = start; i < out.pos.length / 3; i++) {
    const n = normals.get(out.pos.slice(i * 3, i * 3 + 3).join(","))!, L = Math.hypot(...n);
    for (let j = 0; j < 3; j++) out.nrm[i * 3 + j] = n[j]! / (L || 1);
  }
}

// car-materials.js:71
export function applyBodySplit(out: MeshOut, i0: number, i1: number, leftC: Vec3, rightC: Vec3): void {
  for (let i = i0; i < i1; i++) {
    if (out.mat[i] !== SURFACES.paint) continue;
    const c = out.pos[i * 3]! < 0 ? leftC : rightC;
    out.col[i * 3] = c[0]; out.col[i * 3 + 1] = c[1]; out.col[i * 3 + 2] = c[2];
  }
}

/** The finish fields applyFinish reads off a livery. */
export interface FinishLivery {
  finish?: string | null | undefined;
  coverFinish?: string | undefined;
  wingFinish?: string | undefined;
  haloFinish?: string | undefined;
  podFinish?: string | undefined;
  finFinish?: string | undefined;
  mirrorFinish?: string | undefined;
}

export interface Section {
  name: string;
  from: number;
  to: number;
}

function finishSurfaceOf(id: string | null | undefined): number | undefined {
  return id != null && Object.hasOwn(FINISH_SURFACE, id) ? FINISH_SURFACE[id as FinishId] : undefined;
}

// car-materials.js:78
export function finishOf(livery: FinishLivery | null | undefined, field: keyof FinishLivery | undefined): string | null {
  const value = livery && field ? livery[field] : undefined;
  return value === "gloss" || (value != null && Object.hasOwn(FINISH_SURFACE, value)) ? value! : livery && livery.finish || null;
}

// car-materials.js:82
export function applyFinish(out: MeshOut, finish: string | null | undefined, sections: readonly Section[] | null, livery: FinishLivery | null): void {
  if (sections && livery && [livery.coverFinish, livery.wingFinish, livery.haloFinish, livery.podFinish, livery.finFinish, livery.mirrorFinish].some((v) => v && v !== "inherit")) {
    const fields: Record<string, keyof FinishLivery> = { engineCover: "coverFinish", frontWing: "wingFinish", rearAssembly: "wingFinish", halo: "haloFinish",
      sidepods: "podFinish", sharkFin: "finFinish", mirrors: "mirrorFinish" };
    for (const section of sections) {
      const choice = finishOf(livery, fields[section.name]), local = finishSurfaceOf(choice) || SURFACES.paint;
      for (let i = section.from; i < section.to; i++) if (out.mat[i] === SURFACES.paint) out.mat[i] = local;
    }
    return;
  }
  const finishSurface = finishSurfaceOf(finish);
  if (finishSurface) {
    for (let i = 0; i < out.mat.length; i++) {
      if (out.mat[i] === SURFACES.paint) out.mat[i] = finishSurface;
    }
  }
}

// car-materials.js:103
export const SHADE = CarMaterialShade;

export const CarMaterials = Object.freeze({
  SURFACES, FINISH_SURFACE, FINISH_RESERVED, SHADE, finishOf,
  DARK, CARBON, VISOR, PANEL, TYRE, RIM, HUB, INTAKE, HALO, EXHAUST,
  TYRE_BAND, BRAKE_CALIPER,
  TCAM_IDS, tcamColour,
  smoothSkin, applyBodySplit, applyFinish,
});
