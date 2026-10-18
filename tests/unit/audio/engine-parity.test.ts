/**
 * src/audio/engine.ts against f1-game js/audio/engine.js, call for call.
 *
 * tests/fixtures/audio/engine-trace-*.json is every node, connection,
 * property write and AudioParam call f1-game's GameAudio made under
 * engine-script.ts (regenerate: tools/audio/gen-engine-trace.ts). The port is
 * driven by the same script over the same recording context and must
 * reproduce it exactly: same graph, same targets bit for bit (Object.is via
 * the -0/NaN-safe encoding), same times.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../../../src/audio/engine";
import { createFakeAudio, createMusicRecorder, createTimers, seeded, type TraceEntry } from "./fake-ctx";
import { runEngineScript, type ScriptAudio, type ScriptBasis } from "./engine-script";

interface Fixture { f1game: string; scenario: string; trace: TraceEntry[] }

function fixture(scenario: string): Fixture {
  return JSON.parse(readFileSync(new URL(`../../fixtures/audio/engine-trace-${scenario}.json`, import.meta.url), "utf8")) as Fixture;
}

async function runPort(scenario: "desktop" | "mobile"): Promise<TraceEntry[]> {
  const trace: TraceEntry[] = [];
  const fake = createFakeAudio(trace, { decode: scenario === "desktop" ? "synth" : "reject" });
  const timers = createTimers(() => fake.clock.t * 1000);
  vi.stubGlobal("setTimeout", timers.setTimeout);
  vi.stubGlobal("clearTimeout", timers.clearTimeout);
  vi.spyOn(performance, "now").mockImplementation(() => fake.clock.t * 1000);
  let basis: ScriptBasis | null = null;
  const noop = (): void => {};
  const ga = createEngine({
    AudioContext: fake.AudioContext as unknown as new () => AudioContext,
    fetch: fake.fetch as unknown as (url: string) => Promise<Response>,
    engineUrl: "assets/sfx/f1_engine.mp3",
    rand: seeded(26),
    lowPower: () => scenario === "mobile",
    listener: () => basis,
    createMusic: () => createMusicRecorder(trace),
    document: { hidden: false, addEventListener: noop },
    window: { addEventListener: noop },
  });
  await runEngineScript(ga as unknown as ScriptAudio, {
    trace,
    setTime: (t) => { fake.clock.t = t; },
    flushTimers: () => timers.flush(),
    settle: async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); },
    setBasis: (b) => { basis = b; },
  }, scenario);
  return trace;
}

/** First differing call, with a little context, so a failure reads as a diff. */
function firstDiff(want: TraceEntry[], got: TraceEntry[]): string | null {
  const n = Math.max(want.length, got.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(want[i]) !== JSON.stringify(got[i])) {
      const ctx = (tr: TraceEntry[]) => tr.slice(Math.max(0, i - 4), i + 3).map((e, k) => `${i - Math.min(4, i) + k}: ${JSON.stringify(e)}`).join("\n");
      let at = "";
      for (let j = i; j >= 0; j--) { const e = want[j]; if (e && e[0] === "@") { at = String(e[1]); break; } }
      return `call #${i} (after @${at})\n--- f1-game\n${ctx(want)}\n--- port\n${ctx(got)}`;
    }
  }
  return null;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("engine parity with f1-game GameAudio", () => {
  for (const scenario of ["desktop", "mobile"] as const) {
    it(`reproduces the ${scenario} trace call for call`, async () => {
      const want = fixture(scenario).trace;
      const got = await runPort(scenario);
      expect(firstDiff(want, got)).toBeNull();
      expect(got.length).toBe(want.length);
    });
  }
});
