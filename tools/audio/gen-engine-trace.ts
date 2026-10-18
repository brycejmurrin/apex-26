// Regenerate the engine parity fixtures from f1-game.
//
//   node --experimental-strip-types tools/audio/gen-engine-trace.ts [path/to/f1-game]
//
// Loads f1-game's js/audio/{tone-model,ers-layer,signal,engine}.js into a Node
// VM over the recording AudioContext in tests/unit/audio/fake-ctx.ts, drives
// it with tests/unit/audio/engine-script.ts, and writes every recorded call to
// tests/fixtures/audio/engine-trace-<scenario>.json. The unit test drives
// src/audio/engine.ts with the same script and compares call for call.
//
// The soundtrack and radio modules are stubbed (their own ports carry their
// own tests); RivalAudio, RealRace and GameCams-beyond-the-basis are absent,
// exactly as engine.js's typeof guards allow.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createFakeAudio, createMusicRecorder, createTimers, enc, seeded, type TraceEntry } from "../../tests/unit/audio/fake-ctx.ts";
import { runEngineScript, type ScriptAudio, type ScriptBasis } from "../../tests/unit/audio/engine-script.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const F1 = resolve(process.argv[2] || process.env.F1_GAME || join(ROOT, "../f1-game"));
const FILES = ["js/audio/tone-model.js", "js/audio/ers-layer.js", "js/audio/signal.js", "js/audio/engine.js"];

async function run(scenario: "desktop" | "mobile"): Promise<TraceEntry[]> {
  const trace: TraceEntry[] = [];
  const fake = createFakeAudio(trace, { decode: scenario === "desktop" ? "synth" : "reject" });
  const timers = createTimers(() => fake.clock.t * 1000);
  let basis: ScriptBasis | null = null;
  const noop = () => {};
  const sandbox: Record<string, unknown> = {
    console,
    Log: { debug: noop, info: noop, warn: noop },
    M4: { clamp: (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v) },
    PhysicsConsts: { ACCEL: 7, BRAKE: 22, GEARS: 8, IDLE_RPM: 5000, MAX_RPM: 15000 },
    GameCams: { getListenerBasis: () => basis },
    GameAudioSoundtrack: { create: () => createMusicRecorder(trace) },
    GameAudioRadioFx: {
      create: () => ({ decodeClip: noop, radioVoice: noop, radioSting: noop, radioStingStop: noop, setRadioFx: noop, resetContext: noop }),
    },
    window: { AudioContext: fake.AudioContext, addEventListener: noop },
    document: { hidden: false, addEventListener: noop },
    navigator: {},
    fetch: fake.fetch,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    performance: { now: () => fake.clock.t * 1000 },
  };
  if (scenario === "mobile") sandbox.GLX = { isMobile: true };
  vm.createContext(sandbox);
  vm.runInContext(`Math.random = __rand;`, Object.assign(sandbox, { __rand: seeded(26) }));
  for (const f of FILES) vm.runInContext(readFileSync(join(F1, f), "utf8"), sandbox, { filename: f });
  const ga = vm.runInContext("GameAudio", sandbox) as ScriptAudio;
  await runEngineScript(ga, {
    trace,
    setTime: (t) => { fake.clock.t = t; },
    flushTimers: () => timers.flush(),
    settle: async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); },
    setBasis: (b) => { basis = b; },
  }, scenario);
  return trace;
}

// Pure curves on a grid: ERS pitch/gain, squeal, wind, tone-model naming.
function curves(): unknown {
  const sandbox: Record<string, unknown> = {
    M4: { clamp: (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v) },
    Log: {}, window: {}, document: { hidden: false }, navigator: {},
    GameAudioSoundtrack: { create: () => ({}) }, GameAudioRadioFx: { create: () => ({}) },
  };
  vm.createContext(sandbox);
  for (const f of FILES) vm.runInContext(readFileSync(join(F1, f), "utf8"), sandbox, { filename: f });
  type Fn = (...a: unknown[]) => unknown;
  const E = vm.runInContext("ErsLayer", sandbox) as Record<string, Fn>;
  const G = vm.runInContext("GameAudio", sandbox) as Record<string, Fn>;
  const T = vm.runInContext("GameAudioToneModel", sandbox) as Record<string, Fn | Record<string, unknown>>;
  const grid = [-0.5, 0, 0.03, 0.1, 0.19, 0.2, 0.37, 0.5, 0.81, 1, 1.4];
  const out: Record<string, unknown[]> = { ers: [], squeal: [], wind: [], tune: [] };
  for (const a of grid) for (const b of grid) {
    for (const o of [undefined, { speed: b, boostTune: 1.12, partBias: 0.9 }, { layerOn: false }, { ersOn: false, boostTune: 0 }]) {
      out.ers!.push([a, b, o ?? null, E.deployHz!(a, b), E.harvestHz!(a), E.deployGain!(a, b, o), E.harvestGain!(a, b, a * 0.1, o), E.sustainGain!(a > 0.3, b, o)].map(enc));
    }
    out.squeal!.push([a, b, G.squealFromSlip!(a, b, false), G.squealFromSlip!(a, b, true)].map((v) => (typeof v === "object" ? v : enc(v))));
  }
  for (const a of grid) out.wind!.push([enc(a), G.windFromSpeed!(a)]);
  const profiles = ["team", "broadcast", "trackside", "cockpit", "v10"];
  const def = T.TUNE_DEF as Record<string, number>, sp = T.SOUND_PROFILES as Record<string, Record<string, number> | null>;
  for (const p of profiles) for (const cur of [...profiles, "custom"]) {
    const tune = Object.assign({}, def, sp[p] || {});
    const patched = Object.assign({}, tune);
    (T.patchTune as Fn)(patched, { pitch: 9, idle: -1, curve: NaN, sub: 2.5, bogus: 1 });
    out.tune!.push([p, cur, (T.nameForTune as Fn)(tune, cur), patched, (T.nameForTune as Fn)(patched, cur)]);
  }
  return out;
}

const rev = execFileSync("git", ["-C", F1, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
mkdirSync(join(ROOT, "tests/fixtures/audio"), { recursive: true });
for (const scenario of ["desktop", "mobile"] as const) {
  const trace = await run(scenario);
  const out = join(ROOT, `tests/fixtures/audio/engine-trace-${scenario}.json`);
  writeFileSync(out, JSON.stringify({ f1game: rev, files: FILES, scenario, trace }) + "\n");
  console.log(`${scenario}: ${trace.length} calls -> ${out}`);
}
writeFileSync(join(ROOT, "tests/fixtures/audio/curves.json"), JSON.stringify({ f1game: rev, ...(curves() as object) }) + "\n");
console.log("curves -> tests/fixtures/audio/curves.json");
