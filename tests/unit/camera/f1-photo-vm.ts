/**
 * f1-game's photo-mode / free-camera / flyby-editor / extra-rigs modules in a
 * Node VM over f1-game's own tests/helpers/mini-dom.mjs (the DOM its
 * free-cam.test.mjs and photomode-hold.test.mjs boot these files on), for the
 * bit-exact parity checks in this folder; plus the committed-fixture helpers
 * that keep a parity check in CI where f1-game is absent (docs/FLEET.md rule 5:
 * local node:vm parity AND small committed fixtures).
 *
 * Reads f1-game only when present: gate callers on `haveF1Photo`.
 * Fixtures: `A26_WRITE_FIXTURES=1 npx vitest run tests/unit/camera` rewrites
 * them from the PORT's output, and only after the same run's VM parity passed
 * (each writer asserts parity first).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext, runInThisContext } from "node:vm";
import { F1_ROOT } from "../data/f1-vm";

export const haveF1Photo = ["js/camera/free-cam.js", "js/camera/photo-cam.js", "js/camera/photo-kit.js", "js/camera/flyby-editor.js",
  "js/camera/flyby-panel.js", "js/camera/extra-rigs.js", "tests/helpers/mini-dom.mjs"].every((f) => existsSync(path.join(F1_ROOT, f)));

/** f1-game's mini-dom (tests/helpers/mini-dom.mjs), loosely typed. */
export interface MiniEl {
  id: string; hidden: boolean; value: string; textContent: string; children: MiniEl[];
  dataset: Record<string, string>; style: Record<string, unknown>;
  click(): void; focus(): void;
  [k: string]: unknown;
}
export interface MiniDom {
  document: Record<string, unknown> & { body: MiniEl };
  body: MiniEl;
  byId(id: string): MiniEl;
  dispatch(el: MiniEl, ev: Record<string, unknown>): boolean;
}

/** Evaluated from source (an ES module outside the project root, which the
 *  test runner's resolver will not import); `export` is its only module syntax. */
export function miniDom(): MiniDom {
  const src = readFileSync(path.join(F1_ROOT, "tests/helpers/mini-dom.mjs"), "utf8").replace(/^export /gm, "");
  const makeDom = runInThisContext("(function () {\n" + src + "\nreturn makeDom;\n})", { filename: "mini-dom.mjs" }) as () => () => MiniDom;
  return makeDom()();
}

export interface F1Vm {
  readonly sb: Record<string, unknown>;
  /** window listeners by type (the sandbox is the window). */
  readonly wl: Record<string, ((e: unknown) => void)[]>;
  run(rel: string): void;
  get<T>(name: string): T;
}

/** A sandbox with the ambient globals these modules touch, `document` from mini-dom, and `files` evaluated. */
export function f1Vm(dom: MiniDom | null, files: readonly string[], globals: Record<string, unknown> = {}): F1Vm {
  const wl: Record<string, ((e: unknown) => void)[]> = {};
  const sb: Record<string, unknown> = {
    Math, console, Object, Array, Number, String, JSON, Map, Set, WeakMap, Promise, Date, Error, parseFloat, parseInt, isFinite, Symbol,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, requestAnimationFrame: () => 0,
    navigator: {}, getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    addEventListener(t: string, fn: (e: unknown) => void) { (wl[t] = wl[t] || []).push(fn); },
    removeEventListener(t: string, fn: (e: unknown) => void) { if (wl[t]) wl[t] = wl[t]!.filter((f) => f !== fn); },
    ...(dom ? { document: dom.document } : {}),
    ...globals,
  };
  sb["window"] = sb;
  const ctx = createContext(sb);
  const run = (rel: string): void => {
    runInContext(readFileSync(path.join(F1_ROOT, rel), "utf8").replace(/^const\b/gm, "var"), ctx, { filename: rel });
  };
  for (const f of files) run(f);
  return { sb, wl, run, get: <T>(name: string) => runInContext(name, ctx) as T };
}

/** Re-home a VM-realm value as plain data, keeping every number's bits (-0 included). */
export function plainDeep(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
  if (Array.isArray(v)) return v.map(plainDeep);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x !== "function" && x !== undefined) out[k] = plainDeep(x);
  }
  return out;
}

/** As JSON would store it: what a committed fixture can hold (-0 becomes 0). */
export const asJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null)) as unknown;

const FIX = path.resolve(import.meta.dirname, "../../fixtures/camera");
export const fixturePath = (name: string): string => path.join(FIX, name);
export const writeFixtures = process.env["A26_WRITE_FIXTURES"] === "1";

export function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as unknown;
}
/** Write `data` as fixture `name` when A26_WRITE_FIXTURES=1 (callers assert parity first). */
export function maybeWriteFixture(name: string, data: unknown): void {
  if (!writeFixtures) return;
  mkdirSync(FIX, { recursive: true });
  writeFileSync(fixturePath(name), JSON.stringify(data) + "\n");
}
