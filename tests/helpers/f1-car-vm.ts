// Loads f1-game's procedural car scripts (index.html:3608-3615 order) into a Node VM so
// unit tests can compare the TS port against the original, value for value. Skipped
// where f1-game is absent (CI): set F1_GAME or keep f1-game beside the repo.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const F1_DIR = process.env["F1_GAME"] ?? path.resolve(ROOT, "../f1-game");
export const haveF1 = fs.existsSync(path.join(F1_DIR, "js/car/car3d.js"));

/** index.html:3608-3615 load order. */
export const CAR_SCRIPTS = [
  "js/car/helmets.js",
  "js/car/car-geometry.js",
  "js/car/car-wheels.js",
  "js/car/car-material-shade.js",
  "js/car/car-materials.js",
  "js/car/car-shade.js",
  "js/car/car-body-geom.js",
  "js/car/car3d.js",
] as const;

/** Globals the car scripts define. Values are f1-game's untyped objects. */
export const CAR_GLOBALS = [
  "Helmets", "CarGeometry", "CarWheels", "CarMaterialShade", "CarMaterials", "CarShade", "CarBodyGeom", "Car3D",
] as const;

export type F1CarGlobals = Record<(typeof CAR_GLOBALS)[number], unknown>;

const noop = (): void => {};

/** Fresh context per call: CarShade keeps a module-level pref. `extra` adds scripts after the car set. */
export function loadF1Car(opts: { extra?: readonly string[]; globals?: readonly string[]; sandbox?: Record<string, unknown> } = {}): Record<string, unknown> {
  const store = new Map<string, string>();
  const ctx = vm.createContext({
    console,
    Log: { info: noop, warn: noop, error: noop, debug: noop },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
    ...opts.sandbox,
  });
  vm.runInContext("globalThis.window = globalThis;", ctx);
  for (const rel of [...CAR_SCRIPTS, ...(opts.extra ?? [])]) {
    const file = path.join(F1_DIR, rel);
    vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
  }
  // Top-level `const X` lives in the context's script scope, not on globalThis.
  const names = [...CAR_GLOBALS, ...(opts.globals ?? [])];
  return vm.runInContext(`({ ${names.join(", ")} })`, ctx) as Record<string, unknown>;
}

/** Plain-JSON copy of a VM value (arrays from another realm fail toEqual's prototype check). */
export function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
