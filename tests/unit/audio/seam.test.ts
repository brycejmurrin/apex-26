/** The AudioSeam adapter: frames and events reach the ported engine as game.js drove GameAudio. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioFrame } from "../../../src/contracts/audio";
import { createAudio } from "../../../src/audio";
import { createFakeAudio, createTimers, seeded, type TraceEntry } from "./fake-ctx";

function boot() {
  const trace: TraceEntry[] = [];
  const fake = createFakeAudio(trace, { decode: "reject" });
  const timers = createTimers(() => fake.clock.t * 1000);
  vi.stubGlobal("setTimeout", timers.setTimeout);
  const noop = (): void => {};
  const audio = createAudio({
    AudioContext: fake.AudioContext as unknown as new () => AudioContext,
    fetch: fake.fetch as unknown as (url: string) => Promise<Response>,
    rand: seeded(1), lowPower: () => false,
    document: { hidden: false, addEventListener: noop }, window: { addEventListener: noop },
  });
  return { audio, trace, fake };
}

const race: AudioFrame = {
  phase: "race", rpm: 12500, gear: 6, speed01: 0.7, throttle: 1, brake: 0, ax: 4, axStd: 4,
  slip: 1, skid: 0.4, offroad: false, onKerb: true, wet: true, tow: 0, deploying: true,
  energy: 0.8, ersDeploy: 0.5, regen: 0.5,
  rivals: [{ lat: 2, arc: 5, rev: 0.6, approach: 3, voice: "Ferrari", slot: 0, key: 1 }],
  carSfx: { scrub: 0.5, lock: 0, surface: 0, pitLim: 0 },
};

afterEach(() => { vi.unstubAllGlobals(); });

describe("createAudio", () => {
  it("drives the engine from a race frame", () => {
    const { audio, fake } = boot();
    audio.init();
    audio.setVoice("Ferrari");
    audio.startEngine();
    fake.clock.t = 0.1;
    audio.update(race);
    const e = audio.engine;
    expect(e.debug().engineOn).toBe(true);
    expect(e.engineLevel()).toBeGreaterThan(0);
    expect(e.kerbSpray().kerbLive).toBe(true);
    expect(e.kerbSpray().spray).toBeGreaterThan(0);
    expect(e.skidLevel()).toBeGreaterThan(0);
    expect(e.rivalState()[0]?.gain).toBeGreaterThan(0);
    expect(e.carSfx().scrub).toBe(0.5);
  });

  it("idles on the grid and dispatches events", () => {
    const { audio, fake } = boot();
    audio.init();
    audio.startEngine();
    fake.clock.t = 0.05;
    audio.update({ ...race, phase: "grid", rpm: 7000, gear: 1 });
    expect(audio.engine.engineLevel()).toBeGreaterThan(0);
    audio.event("shift", true);
    audio.event("shift", false);
    expect(audio.engine.shiftState().fired).toBe(2);
    audio.event("deployBoost");
    expect(audio.engine.boostState().fired).toBe(1);
    audio.event("collision", 0.9, false, 1);
    expect(audio.engine.lastPlayerContactPan()).toBe(1);
    audio.event("pitGun", true);
    expect(audio.engine.carSfx().pitGuns).toBe(1);
  });

  it("is silent and does not throw without an AudioContext", () => {
    const audio = createAudio({ AudioContext: null });
    audio.init();
    audio.startEngine();
    audio.update(race);
    audio.event("lap");
    audio.startMusic(0);
    expect(audio.engine.debug().contextState).toBe("uninitialised");
  });
});
