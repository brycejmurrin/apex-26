/**
 * CircuitKit: reusable circuit infrastructure (pit building, hospitality,
 * race control, camera crane, marshal shelter, recovery bay, service
 * compound, track signs, pedestrian bridge), each emitted atomically through
 * TrackModels (`modelGroup` / `overheadSpan`) and the LandmarkKit forms.
 *
 * Port of f1-game js/track/scenery/circuit-kit.js:1-432 (`CircuitKit`),
 * verbatim apart from types. The `Log.info` trace at circuit-kit.js:65 is
 * dropped: it has no effect on the output. The one engine global it reads,
 * `TrackGeom.MAT` (circuit-kit.js:302), comes from the injected `core`.
 * build-props.js:705-714 supplies the dependencies.
 */
import type { Basis, RVec3, SceneryBuffer, SceneryFrame, SceneryTheme } from "../../contracts/scenery";
import type { SceneryCore } from "./core";
import type { LandmarkKitApi } from "./landmark-kit";

type V3 = [number, number, number];

const DEFAULT_SIZE = {
  pitBuilding: [18, 10, 72],
  hospitality: [16, 9, 36],
  raceControl: [12, 24, 14],
  cameraCrane: [6, 16, 6],
  marshalShelter: [6, 3, 5],
  recoveryBay: [12, 5, 18],
  serviceCompound: [24, 6, 36],
  trackSigns: [3, 3, 48],
} satisfies { readonly [method: string]: V3 };
type Method = keyof typeof DEFAULT_SIZE;
const BUDGET_KIND = {
  pitBuilding: "facility",
  hospitality: "facility",
  raceControl: "hero",
  cameraCrane: "repeated",
  marshalShelter: "repeated",
  recoveryBay: "repeated",
  serviceCompound: "facility",
  trackSigns: "repeated",
} as const satisfies { readonly [M in Method]: keyof SceneryTheme["budgets"] };

/** `modelGroup` bounds as `placement` builds them (circuit-kit.js:104-108). */
export interface KitBounds {
  readonly center: RVec3;
  readonly size: RVec3;
  readonly basis: Basis;
}

/** `modelGroup` options as `route` passes them (circuit-kit.js:174-177). */
export interface KitModelGroupOpts {
  readonly required: boolean;
  readonly maxVertices: number;
  readonly kind: string;
}

/** `overheadSpan` spec as `pedestrianBridge` builds it (circuit-kit.js:402-412). */
export interface KitBridgeSpec {
  readonly id: string;
  readonly frac: number;
  readonly clearance: number;
  readonly minimumClearance: number;
  span?: number | undefined;
  readonly thickness: number;
  readonly depth: number;
  readonly color: RVec3;
  readonly required: boolean;
}

/** A suppressed-model diagnostics record (circuit-kit.js:213-215). */
export interface KitSuppressedRecord {
  readonly id: string;
  readonly required: boolean;
  readonly reason: string;
}

/** The TrackModels members the kit calls (models.js:620-623). All optional: circuit-kit.js:67 takes `deps.models || {}`. */
export interface CircuitKitModels {
  readonly box?: (stage: SceneryBuffer, c: RVec3, size: RVec3, color: RVec3, basis: Basis) => unknown;
  readonly modelGroup?: (
    id: string, bounds: KitBounds, emit: (stage: SceneryBuffer) => boolean, opts: KitModelGroupOpts,
  ) => unknown;
  readonly overheadSpan?: (spec: KitBridgeSpec) => unknown;
  readonly diagnostics?: { readonly suppressed?: KitSuppressedRecord[] };
}

/** `create`'s dependencies (build-props.js:707-713). Every member is optional (circuit-kit.js:66-71). */
export interface CircuitKitCtx {
  readonly models?: CircuitKitModels;
  readonly landmarks?: Partial<LandmarkKitApi>;
  readonly theme?: {
    readonly palette?: { readonly [name: string]: RVec3 | undefined };
    readonly budgets?: { readonly [K in keyof SceneryTheme["budgets"]]?: number };
  };
  readonly frameAt?: (frac: number) => SceneryFrame;
  readonly groundHeight?: (k: number, dist: number) => number;
  /** Passed by build-props.js:709; the kit never reads it. */
  readonly hash?: (i: number) => number;
  /** The engine built the garages (`track.pit.hasBays`), so `pitBuilding` is a recorded no-op. */
  readonly pitBuilt?: boolean;
}

/**
 * A kit call's spec (docs/SCENERY-API.md §kits). `validIdAndFraction` checks
 * `id`/`frac`; the rest are validated where f1-game validates them.
 */
export interface CircuitKitSpec {
  readonly id?: string;
  readonly frac?: number;
  readonly side?: number;
  readonly gap?: number;
  readonly size?: RVec3;
  readonly required?: boolean;
  readonly style?: string;
  readonly detail?: string;
  readonly levels?: number;
  readonly garages?: unknown;
  readonly modules?: unknown;
  readonly vehicles?: unknown;
  readonly count?: unknown;
  readonly clearance?: number;
  readonly span?: number;
  readonly thickness?: number;
  readonly depth?: number;
}

type ValidSpec = CircuitKitSpec & { readonly id: string; readonly frac: number };

/** The kit `create` returns (circuit-kit.js:417-427). */
export interface CircuitKitApi {
  pitBuilding(spec?: CircuitKitSpec | null): boolean;
  hospitality(spec?: CircuitKitSpec | null): boolean;
  raceControl(spec?: CircuitKitSpec | null): boolean;
  pedestrianBridge(spec?: CircuitKitSpec | null): boolean;
  cameraCrane(spec?: CircuitKitSpec | null): boolean;
  marshalShelter(spec?: CircuitKitSpec | null): boolean;
  recoveryBay(spec?: CircuitKitSpec | null): boolean;
  serviceCompound(spec?: CircuitKitSpec | null): boolean;
  trackSigns(spec?: CircuitKitSpec | null): boolean;
}

/** `placement()` result (circuit-kit.js:100-109). */
interface Place {
  readonly frame: SceneryFrame;
  readonly size: V3;
  readonly center: V3;
  readonly bounds: KitBounds;
}

/** A LandmarkKit spec as `landmark()` receives it, before the centre/colour/basis are resolved. */
interface LandmarkCall {
  readonly offset: RVec3;
  readonly size: RVec3;
  readonly kind?: string;
  readonly levels?: number;
  readonly colorName?: string;
}

function finiteVector(value: unknown, length: number): value is RVec3 {
  return Array.isArray(value) && value.length === length &&
    value.every(Number.isFinite);
}

function validSize(value: unknown): value is RVec3 {
  return finiteVector(value, 3) && value.every((part) => part > 0);
}

function validIdAndFraction(spec: CircuitKitSpec | null | undefined): spec is ValidSpec {
  return !!spec && typeof spec === "object" &&
    typeof spec.id === "string" && spec.id.trim().length > 0 &&
    Number.isFinite(spec.frac) && spec.frac! >= 0 && spec.frac! <= 1;
}

function boundedCount(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const rounded = Math.round(numeric);
  return rounded > 0 && rounded <= maximum ? rounded : 0;
}

function validFrame(frame: SceneryFrame | null | undefined): frame is SceneryFrame {
  return !!frame && finiteVector(frame.c, 3) &&
    finiteVector(frame.r, 3) && finiteVector(frame.u, 3) &&
    finiteVector(frame.t, 3) && Number.isFinite(frame.hw) && frame.hw >= 0;
}

function addScaled(base: RVec3, a: RVec3, aScale: number, b: RVec3, bScale: number): V3 {
  return [
    base[0] + a[0] * aScale + b[0] * bScale,
    base[1] + a[1] * aScale + b[1] * bScale,
    base[2] + a[2] * aScale + b[2] * bScale,
  ];
}

export function create(dependencies: CircuitKitCtx | null | undefined, core: SceneryCore): CircuitKitApi {
  const deps: CircuitKitCtx = dependencies || {};
  const models: CircuitKitModels = deps.models || {};
  const landmarks: Partial<LandmarkKitApi> = deps.landmarks || {};
  const theme: NonNullable<CircuitKitCtx["theme"]> = deps.theme || {};
  const palette: { readonly [name: string]: RVec3 | undefined } = theme.palette || {};
  const budgets: { readonly [name: string]: number | undefined } = theme.budgets || {};

  function color(name: string, fallback: string): RVec3 | null {
    const value = palette[name] || palette[fallback];
    return finiteVector(value, 3) ? value : null;
  }

  function placement(spec: CircuitKitSpec | null | undefined, method: Method): Place | null {
    if (!validIdAndFraction(spec) ||
        (spec.side !== -1 && spec.side !== 1) ||
        !Number.isFinite(spec.gap) || spec.gap! < 0) return null;
    const size = spec.size === undefined ? DEFAULT_SIZE[method] : spec.size;
    if (!validSize(size) || typeof deps.frameAt !== "function" ||
        typeof deps.groundHeight !== "function") return null;
    let frame;
    let ground;
    try {
      frame = deps.frameAt(spec.frac);
      if (!validFrame(frame)) return null;
      if (frame.k === undefined) return null;
      ground = deps.groundHeight(frame.k, spec.gap! + size[0] / 2);
    } catch (_error) {
      return null;
    }
    if (!Number.isFinite(ground)) return null;
    const lateral = spec.side * (frame.hw + spec.gap! + size[0] / 2);
    const base: RVec3 = [frame.c[0], ground, frame.c[2]];
    const center = addScaled(base, frame.r, lateral, frame.u, size[1] / 2);
    if (!finiteVector(center, 3)) return null;
    return {
      frame,
      size: size.slice() as V3,
      center,
      bounds: {
        center,
        size: size.slice() as V3,
        basis: [frame.r.slice() as V3, frame.u.slice() as V3, frame.t.slice() as V3],
      },
    };
  }

  function call<A extends unknown[]>(callback: ((...args: A) => unknown) | undefined, args: A): boolean {
    if (typeof callback !== "function") return false;
    try {
      return callback(...args) !== false;
    } catch (_error) {
      return false;
    }
  }

  function localCenter(place: Place, x: number, y: number, z: number): V3 {
    return addScaled(
      addScaled(place.center, place.frame.r, x, place.frame.u, y),
      place.frame.t, z, place.frame.u, 0,
    );
  }

  function box(stage: SceneryBuffer, place: Place, offset: RVec3, size: RVec3, shade: string): boolean {
    const tint = color(shade, "shell");
    return !!tint && call(models.box, [
      stage,
      localCenter(place, offset[0], offset[1], offset[2]),
      size,
      tint,
      place.bounds.basis,
    ]);
  }

  function boxRgb(stage: SceneryBuffer, place: Place, offset: RVec3, size: RVec3, tint: unknown): boolean {
    return finiteVector(tint, 3) && call(models.box, [
      stage,
      localCenter(place, offset[0], offset[1], offset[2]),
      size,
      tint,
      place.bounds.basis,
    ]);
  }

  function landmark(method: keyof LandmarkKitApi, stage: SceneryBuffer, place: Place, spec: LandmarkCall): boolean {
    const tint = color(spec.colorName || "shell", "shell");
    if (!tint) return false;
    return call(landmarks[method], [stage, {
      ...spec,
      center: localCenter(place, spec.offset[0], spec.offset[1], spec.offset[2]),
      color: tint,
      basis: place.bounds.basis,
      offset: undefined,
      colorName: undefined,
    }]);
  }

  function route(method: Method, spec: CircuitKitSpec | null | undefined, emit: (stage: SceneryBuffer, place: Place) => boolean): boolean {
    const place = placement(spec, method);
    const budgetKind = BUDGET_KIND[method];
    const maximum = budgets[budgetKind];
    if (!place || typeof models.modelGroup !== "function" ||
        !Number.isFinite(maximum) || maximum! < 0) return false;
    // placement() returned non-null, so spec passed validIdAndFraction.
    const valid = spec as ValidSpec;
    try {
      return models.modelGroup(
        valid.id,
        place.bounds,
        (stage) => emit(stage, place),
        {
          required: !!valid.required,
          maxVertices: maximum!,
          kind: method,
        },
      ) === true;
    } catch (_error) {
      return false;
    }
  }

  // circuit-kit.js:184-191: THE ENGINE BUILDS THE GARAGES NOW (pits.js), so
  // a circuit's pitBuilding() is a no-op wherever that complex exists
  // (deps.pitBuilt). Below is the generic hall for a harness or a circuit
  // that opted its bays out: one modelGroup, no team colours.
  const PIT_DOOR: RVec3 = [0.10, 0.11, 0.13];
  const PIT_LINTEL: RVec3 = [0.62, 0.64, 0.68];
  const PIT_GLASS: RVec3 = [0.20, 0.30, 0.40];
  function pitBuilding(spec?: CircuitKitSpec | null): boolean {
    if (deps.pitBuilt) {
      // circuit-kit.js:197-211: RECORD the no-op so a required pit building
      // shows in diagnostics (same wording as models.js's pit verdict).
      if (models.diagnostics && models.diagnostics.suppressed && spec && spec.id) {
        models.diagnostics.suppressed.push({
          id: spec.id, required: false, reason: "superseded by the pit complex",
        });
      }
      return true;
    }
    const garages = boundedCount(spec && spec.garages, 12, 24);
    if (!garages) return false;
    return route("pitBuilding", spec, (stage, place) => {
      const W = place.size[0], H = place.size[1], L = place.size[2];
      const bay = L / garages;
      const inner = -spec!.side! * (W * 0.48);
      // One hall so the kit reads as a pit building, not N separate boxes.
      if (!box(stage, place, [0, -H * 0.10, 0], [W, H * 0.68, L * 0.995], "shell")) {
        return false;
      }
      if (!boxRgb(stage, place, [0, H * 0.26, 0],
        [W * 0.90, H * 0.26, L * 0.97], PIT_GLASS)) return false;
      // Thin canopy hanging over the inner lane (the TV shot).
      if (!box(stage, place, [inner * 0.55, H * 0.10, 0],
        [W * 0.28, 0.16, L * 0.98], "roof")) return false;
      for (let i = 0; i < garages; i++) {
        const z = -L / 2 + bay * (i + 0.5);
        if (!boxRgb(stage, place, [inner, -H * 0.20, z],
          [0.22, H * 0.40, Math.max(2.4, bay * 0.58)], PIT_DOOR)) return false;
        if (!boxRgb(stage, place, [inner, H * 0.06, z],
          [0.26, 0.20, Math.max(2.8, bay * 0.70)], PIT_LINTEL)) return false;
        if (i > 0) {
          const zP = -L / 2 + bay * i;
          if (!box(stage, place, [inner, -H * 0.14, zP],
            [0.28, H * 0.46, Math.max(0.32, Math.min(0.55, bay * 0.08))],
            "service")) return false;
        }
      }
      return landmark("roof", stage, place, {
        offset: [0, H * 0.46, 0],
        size: [W * 1.06, H * 0.08, L],
        kind: spec!.style || "flat",
        colorName: "roof",
      });
    });
  }

  function hospitality(spec?: CircuitKitSpec | null): boolean {
    const modules = boundedCount(spec && spec.modules, 4, 12);
    if (!modules) return false;
    return route("hospitality", spec, (stage, place) => {
      const moduleDepth = place.size[2] / modules;
      for (let i = 0; i < modules; i++) {
        const z = -place.size[2] / 2 + moduleDepth * (i + 0.5);
        if (!box(stage, place, [0, -place.size[1] * 0.08, z],
          [place.size[0], place.size[1] * 0.84, moduleDepth * 0.86],
          i % 2 ? "service" : "shell")) return false;
      }
      return landmark("canopy", stage, place, {
        offset: [0, place.size[1] * 0.38, 0],
        size: [place.size[0] * 1.05, place.size[1] * 0.24, place.size[2]],
        colorName: "roof",
      });
    });
  }

  function raceControl(spec?: CircuitKitSpec | null): boolean {
    return route("raceControl", spec, (stage, place) =>
      landmark("tower", stage, place, {
        offset: [0, 0, 0],
        size: place.size,
        levels: spec!.levels || 6,
        kind: spec!.style || "lattice",
        colorName: "shell",
      }));
  }

  function cameraCrane(spec?: CircuitKitSpec | null): boolean {
    return route("cameraCrane", spec, (stage, place) => {
      if (!box(stage, place, [0, 0, 0],
        [place.size[0] * 0.16, place.size[1], place.size[2] * 0.16],
        "service")) return false;
      return box(stage, place,
        [0, place.size[1] * 0.42, place.size[2] * 0.32],
        [place.size[0] * 0.2, place.size[1] * 0.08, place.size[2] * 0.8],
        "accent");
    });
  }

  function marshalShelter(spec?: CircuitKitSpec | null): boolean {
    return route("marshalShelter", spec, (stage, place) => {
      if (spec!.detail === "structure") {
        const [W, H, L] = place.size;
        // circuit-kit.js:302 `typeof TrackGeom !== "undefined" ? TrackGeom.MAT : {}`.
        const materials: { readonly [name: string]: number | undefined } = core.geom.MAT;
        const previous = stage._mat;
        // The full size is the envelope, including the overhang and posts.
        // Dark solid panels are recessed behind the posts, not glass-pass
        // geometry. All parts stay in this facility's atomic staging buffer.
        try {
          stage._mat = materials["CONCRETE"] || 0;
          if (!box(stage, place, [0, -H * 0.14, 0], [W * 0.82, H * 0.72, L * 0.82], "shell")) return false;
          stage._mat = materials["METAL"] || 0;
          for (const x of [-0.43, 0.43]) for (const z of [-0.43, 0.43]) {
            if (!box(stage, place, [W * x, -H * 0.04, L * z],
              [W * 0.08, H * 0.92, L * 0.08], "service")) return false;
          }
          if (!box(stage, place, [0, H * 0.46, 0], [W * 0.98, H * 0.08, L * 0.98], "roof")) return false;
          stage._mat = materials["FLAT"] || 0;
          const shade = color("glass", "service");
          if (!shade) return false;
          const dark = shade.map((value) => value * 0.35);
          return boxRgb(stage, place, [-spec!.side! * W * 0.416, -H * 0.01, 0],
            [W * 0.014, H * 0.26, L * 0.58], dark) &&
            boxRgb(stage, place, [0, -H * 0.01, L * 0.416],
              [W * 0.58, H * 0.26, L * 0.014], dark);
        } finally {
          stage._mat = previous;
        }
      }
      if (!box(stage, place, [0, -place.size[1] * 0.08, 0],
        [place.size[0], place.size[1] * 0.84, place.size[2]], "shell")) return false;
      // Seated on the shell (top 0.34 H), lapping it by 0.01 H so the two
      // faces never share a plane (circuit-kit.js:330-331).
      return landmark("roof", stage, place, {
        offset: [0, place.size[1] * 0.37, 0],
        size: [place.size[0] * 1.12, place.size[1] * 0.08, place.size[2] * 1.12],
        kind: spec!.style || "flat",
        colorName: "roof",
      });
    });
  }

  function recoveryBay(spec?: CircuitKitSpec | null): boolean {
    return route("recoveryBay", spec, (stage, place) => {
      if (!box(stage, place, [0, -place.size[1] * 0.35, 0],
        [place.size[0], place.size[1] * 0.3, place.size[2]], "service")) return false;
      return landmark("canopy", stage, place, {
        offset: [0, place.size[1] * 0.05, 0],
        size: [place.size[0], place.size[1] * 0.9, place.size[2]],
        colorName: "roof",
      });
    });
  }

  function serviceCompound(spec?: CircuitKitSpec | null): boolean {
    const vehicles = boundedCount(spec && spec.vehicles, 6, 16);
    if (!vehicles) return false;
    return route("serviceCompound", spec, (stage, place) => {
      const columns = 4;
      const rows = Math.ceil(vehicles / columns);
      const cellX = place.size[0] / columns;
      const cellZ = place.size[2] / rows;
      for (let i = 0; i < vehicles; i++) {
        const column = i % columns;
        const row = Math.floor(i / columns);
        const x = -place.size[0] / 2 + cellX * (column + 0.5);
        const z = -place.size[2] / 2 + cellZ * (row + 0.5);
        if (!box(stage, place, [x, -place.size[1] * 0.28, z],
          [cellX * 0.7, place.size[1] * 0.44, cellZ * 0.62],
          i % 2 ? "service" : "accent")) return false;
      }
      return true;
    });
  }

  function trackSigns(spec?: CircuitKitSpec | null): boolean {
    const signs = boundedCount(spec && spec.count, 8, 64);
    if (!signs) return false;
    return route("trackSigns", spec, (stage, place) => {
      const spacing = place.size[2] / signs;
      for (let i = 0; i < signs; i++) {
        const z = -place.size[2] / 2 + spacing * (i + 0.5);
        if (!box(stage, place, [0, 0, z],
          [place.size[0], place.size[1], Math.min(0.35, spacing * 0.4)],
          i % 2 ? "shell" : "accent")) return false;
      }
      return true;
    });
  }

  function pedestrianBridge(spec?: CircuitKitSpec | null): boolean {
    if (!validIdAndFraction(spec) || typeof models.overheadSpan !== "function")
      return false;
    const clearance = spec.clearance === undefined ? 5.5 : spec.clearance;
    const span = spec.span;
    const thickness = spec.thickness === undefined ? 0.9 : spec.thickness;
    const depth = spec.depth === undefined ? 2 : spec.depth;
    if (!Number.isFinite(clearance) || clearance < 4.8 ||
        (span !== undefined && (!Number.isFinite(span) || span <= 0)) ||
        !Number.isFinite(thickness) || thickness <= 0 ||
        !Number.isFinite(depth) || depth <= 0) return false;
    const shell = color("shell", "shell");
    if (!shell) return false;
    const bridge: KitBridgeSpec = {
      id: spec.id,
      frac: spec.frac,
      clearance,
      minimumClearance: 4.8,
      span,
      thickness,
      depth,
      color: shell,
      required: !!spec.required,
    };
    if (span === undefined) delete bridge.span;
    return call(models.overheadSpan, [bridge]);
  }

  return {
    pitBuilding,
    hospitality,
    raceControl,
    pedestrianBridge,
    cameraCrane,
    marshalShelter,
    recoveryBay,
    serviceCompound,
    trackSigns,
  };
}
