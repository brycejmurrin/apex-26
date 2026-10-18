/**
 * LandmarkKit: bounded architectural forms (roof, facade, tower, stadium
 * section, arch, canopy) emitted into a caller-owned stage buffer through
 * injected primitives. Pure: no engine globals.
 *
 * Port of f1-game js/track/scenery/landmark-kit.js:1-203 (`LandmarkKit`),
 * verbatim apart from types. The `Log.info` trace at landmark-kit.js:29 is
 * dropped: it has no effect on the output. build-props.js:694-704 builds the
 * primitives from its guarded addBox/addPrism/addCyl/addFrustum.
 */
import type { Basis, LandmarkKit, RVec3 } from "../../contracts/scenery";

/**
 * The primitives `create` receives (build-props.js:696-703). Every member is
 * optional: landmark-kit.js:30 accepts `primitives || {}` and `emit` skips a
 * missing callback. `color`/`basis` are passed through unvalidated from the
 * spec, so they may be undefined.
 */
export interface LandmarkPrimitives {
  readonly box?: (stage: object, c: RVec3, size: RVec3, color: RVec3 | undefined, basis: Basis | undefined) => unknown;
  readonly prism?: (stage: object, c: RVec3, size: RVec3, color: RVec3 | undefined, basis: Basis | undefined) => unknown;
  readonly cylinder?: (
    stage: object, c: RVec3, radius: number, height: number, color: RVec3 | undefined,
    seg: number, basis: Basis | undefined,
  ) => unknown;
  readonly frustum?: (
    stage: object, c: RVec3, rBase: number, rTop: number, h: number, color: RVec3 | undefined,
    seg: number, basis: Basis | undefined,
  ) => unknown;
}

/**
 * A form's spec once `validSpec` passed: `center` and `size` are finite
 * 3-vectors with positive size. The other keys are read as-is
 * (landmark-kit.js:40-196) and validated where f1-game validates them.
 */
export interface LandmarkSpec {
  readonly center: RVec3;
  readonly size: RVec3;
  readonly color?: RVec3;
  readonly mastColor?: RVec3;
  readonly basis?: Basis;
  readonly kind?: string;
  readonly bays?: unknown;
  readonly levels?: unknown;
  readonly rows?: unknown;
  readonly postWidth?: number;
}

/** The kit `create` returns (landmark-kit.js:198); the contract's `LandmarkKit`. */
export type LandmarkKitApi = LandmarkKit;

function finiteVector(value: unknown, length: number): value is RVec3 {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function validStage(stage: unknown): stage is object {
  return stage !== null && typeof stage === "object";
}

function validSpec(spec: unknown): spec is LandmarkSpec {
  const s = spec as { center?: unknown; size?: unknown } | null | undefined;
  return !!s && typeof s === "object" &&
    finiteVector(s.center, 3) && finiteVector(s.size, 3) &&
    s.size.every((value) => value > 0);
}

function boundedCount(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const count = Math.round(numeric);
  return count > 0 && count <= maximum ? count : 0;
}

export function create(primitives?: LandmarkPrimitives | null): LandmarkKitApi {
  const p: LandmarkPrimitives = primitives || {};

  function emit<A extends unknown[]>(callback: ((...args: A) => unknown) | undefined, args: A): boolean {
    return typeof callback === "function" && callback(...args) !== false;
  }

  function ready(stage: unknown, spec: unknown): spec is LandmarkSpec {
    return validStage(stage) && validSpec(spec);
  }

  function roof(stage: object, spec: unknown): boolean {
    if (!ready(stage, spec)) return false;
    const callback = spec.kind === "sawtooth" ? p.prism : p.box;
    return emit(callback, [stage, spec.center, spec.size, spec.color, spec.basis]);
  }

  function facade(stage: object, spec: unknown): boolean {
    if (!ready(stage, spec)) return false;
    const bays = boundedCount(spec.bays, 6, 24);
    if (!bays) return false;
    for (let i = 0; i < bays; i++) {
      const offset = (i + 0.5) / bays - 0.5;
      const center: RVec3 = [
        spec.center[0],
        spec.center[1],
        spec.center[2] + offset * spec.size[2],
      ];
      const size: RVec3 = [spec.size[0], spec.size[1], spec.size[2] / bays * 0.82];
      if (!emit(p.box, [stage, center, size, spec.color, spec.basis])) return false;
    }
    return true;
  }

  // landmark-kit.js:63-66: `kind` selects a real form (tapered, drum,
  // stepped, lattice); circuit-kit.js passes `kind: spec.style`.
  function tower(stage: object, spec: unknown): boolean {
    if (!ready(stage, spec)) return false;
    const levels = boundedCount(spec.levels, 4, 12);
    if (!levels) return false;
    const kind = spec.kind || "lattice";
    if (kind === "tapered" && p.frustum) {
      // One tapered shaft plus a proud cap slab — a modern control tower.
      const half = spec.size[1] / 2;
      return emit(p.frustum, [stage,
        [spec.center[0], spec.center[1] - half, spec.center[2]],
        spec.size[0] * 0.5, spec.size[0] * 0.28, spec.size[1] * 0.88,
        spec.color, 8, spec.basis]) &&
        emit(p.box, [stage,
          [spec.center[0], spec.center[1] + half * 0.80, spec.center[2]],
          [spec.size[0] * 0.86, spec.size[1] * 0.08, spec.size[2] * 0.86],
          spec.color, spec.basis]);
    }
    if (kind === "drum" && p.cylinder) {
      const half = spec.size[1] / 2;
      return emit(p.cylinder, [stage,
        [spec.center[0], spec.center[1] - half, spec.center[2]],
        spec.size[0] * 0.46, spec.size[1] * 0.86, spec.color, 10, spec.basis]) &&
        emit(p.box, [stage,
          [spec.center[0], spec.center[1] + half * 0.74, spec.center[2]],
          [spec.size[0] * 1.05, spec.size[1] * 0.10, spec.size[2] * 1.05],
          spec.color, spec.basis]);
    }
    // landmark-kit.js:94-100: levels STACK (each base on the previous top,
    // none wider than the one below); "stepped" sets back further on every
    // odd level, never outward.
    const slot = spec.size[1] / levels;
    for (let i = 0; i < levels; i++) {
      const scale = kind === "stepped"
        ? 1 - (i + (i % 2) * 0.5) / levels * 0.35
        : 1 - i / levels * 0.35;
      const center: RVec3 = [
        spec.center[0],
        spec.center[1] - spec.size[1] / 2 + (i + 0.5) * slot,
        spec.center[2],
      ];
      const size: RVec3 = [
        spec.size[0] * scale,
        slot,
        spec.size[2] * scale,
      ];
      if (!emit(p.box, [stage, center, size, spec.color, spec.basis])) return false;
    }
    return true;
  }

  function stadiumSection(stage: object, spec: unknown): boolean {
    if (!ready(stage, spec)) return false;
    const rows = boundedCount(spec.rows, 8, 16);
    if (!rows) return false;
    for (let i = 0; i < rows; i++) {
      const offset = (i + 0.5) / rows;
      const center: RVec3 = [
        spec.center[0],
        spec.center[1] - spec.size[1] / 2 + offset * spec.size[1],
        spec.center[2] - spec.size[2] / 2 + offset * spec.size[2],
      ];
      const size: RVec3 = [spec.size[0], spec.size[1] / rows * 0.7, spec.size[2] / rows];
      if (!emit(p.box, [stage, center, size, spec.color, spec.basis])) return false;
    }
    return true;
  }

  function arch(stage: object, spec: unknown): boolean {
    if (!ready(stage, spec)) return false;
    if (spec.postWidth !== undefined &&
        (!Number.isFinite(spec.postWidth) || spec.postWidth <= 0)) return false;
    const post = Math.min(
      spec.size[0] * 0.2,
      spec.size[1] * 0.5,
      spec.postWidth === undefined ? 1.2 : spec.postWidth,
    );
    const postHeight = spec.size[1] - post;
    const centers: RVec3[] = [
      [spec.center[0] - (spec.size[0] - post) / 2,
        spec.center[1] - post / 2, spec.center[2]],
      [spec.center[0] + (spec.size[0] - post) / 2,
        spec.center[1] - post / 2, spec.center[2]],
      [spec.center[0],
        spec.center[1] + (spec.size[1] - post) / 2, spec.center[2]],
    ];
    const sizes: RVec3[] = [
      [post, postHeight, spec.size[2]],
      [post, postHeight, spec.size[2]],
      [spec.size[0], post, spec.size[2]],
    ];
    for (let i = 0; i < centers.length; i++) {
      if (!emit(p.box, [
        stage, centers[i]!, sizes[i]!, spec.color, spec.basis,
      ])) return false;
    }
    return true;
  }

  function canopy(stage: object, spec: unknown): boolean {
    if (!ready(stage, spec)) return false;
    const mastHeight = spec.size[1] * 0.8;
    const mastCenter: RVec3 = [
      spec.center[0],
      spec.center[1] - spec.size[1] / 2,
      spec.center[2],
    ];
    const radius = Math.min(spec.size[0], spec.size[2]) * 0.06;
    if (!emit(p.cylinder, [
      stage, mastCenter, radius, mastHeight,
      spec.mastColor || spec.color, 8, spec.basis,
    ])) return false;
    const ridge = spec.size[1] * 0.30;
    return emit(p.prism, [
      stage,
      [spec.center[0], spec.center[1] + spec.size[1] * 0.30, spec.center[2]],
      [spec.size[0], ridge, spec.size[2]],
      spec.color,
      spec.basis,
    ]) && emit(p.box, [
      stage,
      [spec.center[0], spec.center[1] + spec.size[1] * 0.28, spec.center[2]],
      [spec.size[0] * 1.02, spec.size[1] * 0.06, spec.size[2]],
      spec.color,
      spec.basis,
    ]);
  }

  return { roof, facade, tower, stadiumSection, arch, canopy };
}
