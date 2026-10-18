#!/usr/bin/env node
// Physics goldens from f1-game's real js/game.js, booted headless in a Node vm
// (f1-game tools/lib/game-vm.cjs). Run by the coordinator (lane sessions may not
// execute f1-game code); the physics lane consumes the output.
//
//   node tools/oracle/physics-dump.cjs --f1 ../f1-game --out tests/goldens
//
// For each scenario (the 4 recipes of f1-game tests/unit/physics-characterization-vm.test.mjs,
// verbatim) and each field mode:
//   field — exactly the characterization run (AI field present; matches f1-game's
//           committed browser baseline at 1e-4, asserted below)
//   solo  — every AI car retired first, so the player step can be ported in isolation
// writes tests/goldens/physics-<mode>-<slug>.json.gz:
//   { header, carKeys, steps: [{ i, input, phys, car }] }
// phys = __apex.physState() (some fields rounded by f1-game itself), car = every numeric /
// boolean own field of G.player as raw doubles, in carKeys order, AFTER the step.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execSync } = require("child_process");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const F1 = path.resolve(opt("--f1", process.env.F1_GAME || path.join(__dirname, "../../../f1-game")));
const OUT = path.resolve(opt("--out", path.join(__dirname, "../../tests/goldens")));

const SCENARIOS = [
  { name: "straight-line accel", seed: 7, frac: 0.05, speed: 20,
    steps: [{ n: 120, in: { throttle: true, steer: 0 } }] },
  { name: "steady corner load", seed: 7, frac: 0.28, speed: 55,
    steps: [{ n: 90, in: { throttle: true, steer: 0.6 } }] },
  { name: "trail brake into rotation", seed: 11, frac: 0.28, speed: 70,
    steps: [{ n: 45, in: { brake: true, steer: 0.5 } }, { n: 45, in: { throttle: true, steer: 0.3 } }] },
  { name: "off-track recovery", seed: 3, frac: 0.5, speed: 45, x: 11,
    steps: [{ n: 90, in: { throttle: true, steer: -0.4 } }] },
];
const slug = (s) => s.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
const R = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);

async function main() {
  const { createGame } = require(path.join(F1, "tools/lib/game-vm.cjs"));
  const baseline = JSON.parse(fs.readFileSync(path.join(F1, "tests/data/physics-baseline.json"), "utf8"));
  let sha = "unknown";
  try { sha = execSync("git rev-parse HEAD", { cwd: F1 }).toString().trim(); } catch (_) {}
  fs.mkdirSync(OUT, { recursive: true });

  for (const mode of ["field", "solo"]) {
    const g = await createGame({ track: "monza", wx: "dry" });
    const a = g.apex, G = g.G;
    a.weather("dry");
    a.step(0, 1);
    for (const s of SCENARIOS) {
      a.weather("dry");
      a.step(0, 1);
      a.seed(s.seed);
      a.reset(s.frac, s.speed, s.x || 0);
      if (mode === "solo") G.cars.forEach((c, i) => { if (c !== G.player && !c.retired) a.retire(i, "oracle"); });
      const carKeys = Object.keys(G.player).filter((k) => typeof G.player[k] === "number" || typeof G.player[k] === "boolean").sort();
      const init = Object.fromEntries(carKeys.map((k) => [k, G.player[k]]));
      const steps = [];
      const coarse = [];
      let i = 0;
      for (const stage of s.steps) {
        a.setInput(stage.in);
        for (let k = 0; k < stage.n; k++, i++) {
          a.step(1 / 60, 1);
          const p = a.physState();
          steps.push({ i, input: stage.in, phys: p, car: carKeys.map((key) => G.player[key]) });
          if (k % 15 === 0) coarse.push([p.s, p.x, p.speed, p.slipDeg, p.head, p.prog].map(R));
        }
      }
      a.clearInput();
      if (mode === "field") {
        const ok = JSON.stringify(coarse) === JSON.stringify(baseline[s.name]);
        if (!ok) throw new Error(`field run of "${s.name}" no longer matches f1-game's browser baseline`);
      }
      const doc = {
        header: { source: "f1-game", sha, track: "monza", mode, scenario: s, fixedDt: 1 / 60,
          aiActive: G.cars.filter((c) => c !== G.player && !c.retired).length,
          physRevision: (g.ctx && g.ctx.PhysicsConsts && g.ctx.PhysicsConsts.REVISION) || null },
        carKeys, init, steps,
      };
      const file = path.join(OUT, `physics-${mode}-${slug(s.name)}.json.gz`);
      fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(doc), { level: 9 }));
      console.log(`${mode} ${s.name}: ${steps.length} steps, ${carKeys.length} car fields, ai=${doc.header.aiActive} → ${path.basename(file)} ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
    }
    g.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
