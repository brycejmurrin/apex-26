// Load f1-game IIFE modules into one Node VM context, read-only.
// F1_GAME (default ../f1-game next to this repo) is the reference checkout.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(process.env.F1_GAME || path.join(__dirname, "../../../f1-game"));

function rev() {
  try {
    const head = fs.readFileSync(path.join(ROOT, ".git/HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head;
    const ref = head.slice(5);
    const p = path.join(ROOT, ".git", ref);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
    const packed = fs.readFileSync(path.join(ROOT, ".git/packed-refs"), "utf8");
    const line = packed.split("\n").find((l) => l.endsWith(" " + ref));
    return line ? line.split(" ")[0] : "unknown";
  } catch { return "unknown"; }
}

/** A context holding `globals`, with js/core/log.js loaded (silent). */
function context(globals = {}) {
  const ctx = vm.createContext(Object.assign({ Math, JSON, Object, Array, String, Number, isNaN, isFinite, console: { log() {}, info() {}, warn() {}, error() {}, debug() {} } }, globals));
  load(ctx, "js/core/log.js");
  return ctx;
}

/** Evaluate an f1-game file (top-level const → var, so names land on the context). */
function load(ctx, rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/^const\b/gm, "var");
  vm.runInContext(src, ctx, { filename: rel });
  return ctx;
}

/** Deterministic PRNG for scenario inputs (mulberry32). */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** JSON that keeps Infinity/NaN/-0 and undefined distinguishable. */
function encode(v) {
  return JSON.stringify(v, (_k, x) => {
    if (typeof x === "number") {
      if (Number.isNaN(x)) return { $n: "NaN" };
      if (x === Infinity) return { $n: "Inf" };
      if (x === -Infinity) return { $n: "-Inf" };
      if (Object.is(x, -0)) return { $n: "-0" };
    }
    if (x === undefined) return { $u: 1 };
    return x;
  });
}

function write(name, data) {
  const out = path.join(__dirname, "../../tests/fixtures/race", name + ".json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encode({ source: "f1-game@" + rev(), generator: "tools/race-fixtures/gen.cjs", data }) + "\n");
  console.log("wrote", path.relative(process.cwd(), out));
}

module.exports = { ROOT, context, load, rng, write, rev };
