#!/usr/bin/env node
// codemod-circuits: port f1-game's circuit defs (js/circuits/<id>.js) to typed
// TypeScript modules under src/circuits/ (T1.1, docs/PLAN.md).
//
//   node tools/codemod-circuits.mjs [--f1 <path>] [--check]
//
// f1-game is found at --f1, else $F1_GAME, else ../f1-game beside the repo root.
// Each def file is an IIFE doing `(window.TrackDefs ||= []).push({...})`; they
// are evaluated in a node:vm context with a stub `window`, in the curated order
// of tools/manifest.cjs `CIRCUITS` (== Tracks.LIST == picker order; load-bearing).
// Defs are pure data (no functions, JSON-safe), so the emitted literal is exact:
// numbers print via JSON.stringify, which round-trips every double.
//
// --check re-derives every output in memory and exits 1 on any difference
// (changed, missing or stale files), so the codemod is safely re-runnable.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "src/circuits");
const DEFS_DIR = path.join(OUT_DIR, "defs");

function parseArgs(argv) {
  const opts = { f1: process.env.F1_GAME || path.resolve(ROOT, "../f1-game"), check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opts.check = true;
    else if (a === "--f1") {
      const v = argv[++i];
      if (!v) throw new Error("--f1 needs a path");
      opts.f1 = path.resolve(v);
    } else if (a.startsWith("--f1=")) opts.f1 = path.resolve(a.slice(5));
    else if (a === "-h" || a === "--help") {
      process.stdout.write("usage: node tools/codemod-circuits.mjs [--f1 <path>] [--check]\n");
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

/** Resolve f1-game's HEAD commit by reading .git directly (no git subprocess). */
function gitSha(repo) {
  let gitDir = path.join(repo, ".git");
  if (fs.statSync(gitDir).isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, "utf8"));
    if (!m) throw new Error(`unreadable ${gitDir}`);
    gitDir = path.resolve(repo, m[1].trim());
  }
  const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  if (!head.startsWith("ref: ")) return head;
  const ref = head.slice(5);
  // A linked worktree keeps refs in the common dir.
  const commonFile = path.join(gitDir, "commondir");
  const common = fs.existsSync(commonFile)
    ? path.resolve(gitDir, fs.readFileSync(commonFile, "utf8").trim()) : gitDir;
  for (const dir of [gitDir, common]) {
    const loose = path.join(dir, ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, "utf8").trim();
  }
  const packed = path.join(common, "packed-refs");
  if (fs.existsSync(packed)) {
    for (const line of fs.readFileSync(packed, "utf8").split("\n")) {
      const [sha, name] = line.split(" ");
      if (name === ref && sha) return sha;
    }
  }
  throw new Error(`cannot resolve ${ref} in ${gitDir}`);
}

/** Evaluate every circuit def in a VM; returns [{ id, file, def }] in curated order. */
export function loadDefs(f1) {
  const require = createRequire(import.meta.url);
  const { CIRCUITS } = require(path.join(f1, "tools/manifest.cjs"));
  if (!Array.isArray(CIRCUITS) || !CIRCUITS.length) throw new Error("manifest.cjs exports no CIRCUITS");
  const window = {};
  const ctx = vm.createContext({ window });
  const out = [];
  for (const id of CIRCUITS) {
    const file = `js/circuits/${id}.js`;
    const before = (window.TrackDefs || []).length;
    vm.runInContext(fs.readFileSync(path.join(f1, file), "utf8"), ctx, { filename: file });
    const defs = window.TrackDefs || [];
    if (defs.length !== before + 1) throw new Error(`${file} pushed ${defs.length - before} defs, expected 1`);
    const def = defs[defs.length - 1];
    if (def.id !== id) throw new Error(`${file} pushed id "${def.id}"`);
    out.push({ id, file, def });
  }
  return out;
}

const camel = (id) => id.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const IDENT = /^[A-Za-z_$][\w$]*$/;
const isPrim = (v) => v === null || typeof v !== "object";

function num(n) {
  if (!Number.isFinite(n)) throw new Error(`non-finite number ${n}`);
  return Object.is(n, -0) ? "-0" : JSON.stringify(n);
}

function prim(v) {
  if (v === null) return "null";
  switch (typeof v) {
    case "number": return num(v);
    case "string": return JSON.stringify(v);
    case "boolean": return String(v);
    default: throw new Error(`unsupported value of type ${typeof v}`);
  }
}

const key = (k) => (IDENT.test(k) ? k : JSON.stringify(k));

/** Inline form when the value is flat enough (primitives or primitive arrays); else null. */
function inline(v) {
  if (isPrim(v)) return prim(v);
  if (Array.isArray(v)) return v.every(isPrim) ? `[${v.map(prim).join(", ")}]` : null;
  const parts = [];
  for (const [k, x] of Object.entries(v)) {
    const s = isPrim(x) ? prim(x) : Array.isArray(x) && x.every(isPrim) ? inline(x) : null;
    if (s == null) return null;
    parts.push(`${key(k)}: ${s}`);
  }
  return parts.length ? `{ ${parts.join(", ")} }` : "{}";
}

/** Deterministic TS literal: keys keep source order; flat values stay on one line. */
function literal(v, indent = "") {
  const one = inline(v);
  if (one != null && (isPrim(v) || Array.isArray(v) || one.length + indent.length <= 100)) return one;
  const inner = indent + "  ";
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return `[\n${v.map((x) => inner + literal(x, inner) + ",").join("\n")}\n${indent}]`;
  }
  const entries = Object.entries(v);
  for (const [, x] of entries) if (x === undefined) throw new Error("undefined value");
  return `{\n${entries.map(([k, x]) => `${inner}${key(k)}: ${literal(x, inner)},`).join("\n")}\n${indent}}`;
}

function assertData(v, at) {
  if (isPrim(v)) {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`${at}: non-finite`);
    if (!["number", "string", "boolean"].includes(typeof v) && v !== null) throw new Error(`${at}: ${typeof v}`);
    return;
  }
  const proto = Object.getPrototypeOf(v);
  if (!Array.isArray(v) && proto !== null && Object.getPrototypeOf(proto) !== null) throw new Error(`${at}: non-plain object`);
  for (const [k, x] of Object.entries(v)) assertData(x, `${at}.${k}`);
}

function render(f1) {
  const sha = gitSha(f1);
  const defs = loadDefs(f1);
  const files = new Map();
  const warn = "// GENERATED by tools/codemod-circuits.mjs: do not edit; re-run the codemod.";
  for (const { id, file, def } of defs) {
    assertData(def, id);
    files.set(path.join(DEFS_DIR, `${id}.ts`), [
      warn,
      `// Source: f1-game ${file} @ ${sha}`,
      `import type { CircuitDef } from "../types";`,
      "",
      `export const ${camel(id)}: CircuitDef = ${literal(def)};`,
      "",
    ].join("\n"));
  }
  const ids = defs.map((d) => d.id);
  files.set(path.join(OUT_DIR, "index.ts"), [
    warn,
    `// Source: f1-game tools/manifest.cjs CIRCUITS @ ${sha}`,
    "// Order is f1-game's curated Tracks.LIST (== picker order); a stored track index is",
    "// positional, so never sort or reorder it.",
    `import type { CircuitDef } from "./types";`,
    ...ids.map((id) => `import { ${camel(id)} } from "./defs/${id}";`),
    "",
    "export type { CircuitDef } from \"./types\";",
    "",
    "/** Every circuit id, in curated order. */",
    `export const CIRCUIT_IDS = [\n${ids.map((id) => `  ${JSON.stringify(id)},`).join("\n")}\n] as const;`,
    "",
    "export type CircuitId = (typeof CIRCUIT_IDS)[number];",
    "",
    "/** Every circuit def, in curated order (f1-game Tracks.LIST). */",
    `export const CIRCUITS: readonly CircuitDef[] = [\n${ids.map((id) => `  ${camel(id)},`).join("\n")}\n];`,
    "",
    "/** The championship calendar: f1-game `Tracks.SEASON = LIST.filter((t) => !t.classic)`. */",
    "export const SEASON: readonly CircuitDef[] = CIRCUITS.filter((c) => !c.classic);",
    "",
    "const BY_ID: ReadonlyMap<string, CircuitDef> = new Map(CIRCUITS.map((c) => [c.id, c]));",
    "",
    "/** Look a circuit up by id; undefined when no circuit has that id. */",
    "export function circuitById(id: string): CircuitDef | undefined {",
    "  return BY_ID.get(id);",
    "}",
    "",
  ].join("\n"));
  return { sha, files };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(opts.f1, "tools/manifest.cjs"))) {
    throw new Error(`f1-game not found at ${opts.f1} (pass --f1 <path> or set F1_GAME)`);
  }
  const { sha, files } = render(opts.f1);
  const existing = fs.existsSync(DEFS_DIR)
    ? fs.readdirSync(DEFS_DIR).filter((f) => f.endsWith(".ts")).map((f) => path.join(DEFS_DIR, f)) : [];
  const stale = existing.filter((f) => !files.has(f));
  const rel = (f) => path.relative(ROOT, f);
  if (opts.check) {
    const diffs = [];
    for (const [f, text] of files) {
      if (!fs.existsSync(f)) diffs.push(`missing ${rel(f)}`);
      else if (fs.readFileSync(f, "utf8") !== text) diffs.push(`differs ${rel(f)}`);
    }
    for (const f of stale) diffs.push(`stale   ${rel(f)}`);
    if (diffs.length) {
      process.stderr.write(`codemod-circuits --check: ${diffs.length} difference(s) vs f1-game @ ${sha}\n  ${diffs.join("\n  ")}\n`);
      process.exit(1);
    }
    process.stdout.write(`codemod-circuits --check: OK, ${files.size} files match f1-game @ ${sha}\n`);
    return;
  }
  fs.mkdirSync(DEFS_DIR, { recursive: true });
  let written = 0;
  for (const [f, text] of files) {
    if (fs.existsSync(f) && fs.readFileSync(f, "utf8") === text) continue;
    fs.writeFileSync(f, text);
    written++;
  }
  for (const f of stale) fs.rmSync(f);
  process.stdout.write(`codemod-circuits: ${files.size} files (${written} written, ${stale.length} removed) from f1-game @ ${sha}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`codemod-circuits: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
