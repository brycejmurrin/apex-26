#!/usr/bin/env node
// Writes tests/fixtures/race/broadcast.json: f1-game js/race/broadcast.js outputs (the
// pure tower and director functions) for seeded real-race scripts, replayed by
// tests/unit/race/broadcast.test.ts.   node tools/race-fixtures/gen-broadcast.cjs
"use strict";
const vm = require("vm");
const { context, load, rng, write } = require("./vm.cjs");

const ctx = context();
load(ctx, "js/race/broadcast.js");
const B = vm.runInContext("Broadcast", ctx);
const r = rng(21);
const pick = (a) => a[Math.floor(r() * a.length)];
const round3 = (x) => Math.round(x * 1000) / 1000;
const clone = (o) => JSON.parse(JSON.stringify(o));

function script() {
  const n = 6 + Math.floor(r() * 15), laps = 3 + Math.floor(r() * 10), drivers = [];
  for (let i = 0; i < n; i++) {
    const base = 80 + r() * 4, ls = [0], lt = [];
    let t = 2 + i * 0.3;
    for (let k = 1; k <= laps; k++) { const lap = round3(base + r() * 2); lt[k - 1] = lap; t += lap; if (r() < 0.95) ls[k] = round3(t); }
    const d = { num: i + 1, code: "C" + (i + 1), grid: r() < 0.9 ? i + 1 : null, laps: lt, lapStart: ls, stints: [{ from: 1, c: pick(["SOFT", "MEDIUM", "HARD"]) }] };
    if (r() < 0.4) { const at = Math.floor(laps / 2); d.stints.push({ from: at, c: pick(["MEDIUM", "HARD", "INTER"]) }); d.pitT = [round3(80 * at)]; d.pitDur = [pick([0, 22.5, 25])]; }
    if (r() < 0.15) { d.dnf = true; d.outT = round3(r() * laps * 80); }
    if (r() < 0.05) d.dns = true;
    drivers.push(d);
  }
  return { drivers, fastest: r() < 0.8 ? { t: round3(r() * laps * 80), num: 1 + Math.floor(r() * n) } : null };
}

const towers = [];
for (let k = 0; k < 10; k++) {
  const s = script();
  const samples = [];
  for (let T = -5; T < 1000; T += 15 + Math.floor(r() * 40)) {
    const outSet = r() < 0.2 ? new Set([1 + Math.floor(r() * 5)]) : null;
    const out = outSet ? (num) => outSet.has(num) : undefined;
    const rows = clone(B.towerAt(s, T, out));
    samples.push({ T, out: outSet ? [...outSet] : null, key: B.towerSample(s, T, out), rows, gaps: rows.map((x) => [B.fmtGap(x, "gap"), B.fmtGap(x, "interval")]) });
  }
  towers.push({ script: s, samples });
}

const director = [];
for (let k = 0; k < 200; k++) {
  const n = 2 + Math.floor(r() * 12), cars = [];
  let prog = 20000;
  for (let i = 0; i < n; i++) { prog -= r() < 0.5 ? r() * 40 : r() * 400; cars.push({ key: "K" + i, prog: round3(prog), speed: pick([0, round3(r() * 90)]) }); }
  const vScale = pick([undefined, 0.5, 1.3]);
  const fights = clone(B.battles(cars, vScale));
  const follow = pick(cars.map((c) => c.key).concat(["none"]));
  const evKey = pick([null, pick(cars).key]), evKind = pick([null, "pit", "out"]);
  const running = r() < 0.7 ? cars.map((c) => ({ key: c.key })) : null;
  const events = [];
  let t = 0;
  for (let i = 0; i < 12; i++) { t += r() * 5; events.push({ t: round3(t), kind: pick(["pass", "pit", "out", "fastest", "bogus"]), num: pick([null, 1 + Math.floor(r() * 5)]) }); }
  const shown = [...new Set([Math.floor(r() * 12), Math.floor(r() * 12)])];
  const T = round3(r() * 30), lead = pick([2, 6]);
  const okSet = r() < 0.5 ? new Set([1, 2, 3]) : null;
  director.push({
    cars, vScale: vScale === undefined ? null : vScale, fights, follow, evKey, evKind, running,
    pip: B.pipPick(fights, follow, evKey, evKind, running),
    events, shown, T, lead, ok: okSet ? [...okSet] : null,
    next: B.nextEvent(events, T, new Set(shown), lead, okSet ? (num) => okSet.has(num) : undefined),
    shots: ["pass", "pit", "out", "fastest", null, "other"].map((kind) => [kind, pick([null, "side", "heli", "tcam"]), Math.floor(r() * 9)]).map(([kind, onAir, nn]) => ({ kind, onAir, n: nn, shot: B.shotFor(kind, onAir, nn) })),
  });
}
write("broadcast", { towers, director, SHOTS: B.SHOTS, SHOT_MIN_S: B.SHOT_MIN_S, SHOT_MAX_S: B.SHOT_MAX_S, MANUAL_S: B.MANUAL_S });
