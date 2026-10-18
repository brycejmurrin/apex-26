/**
 * One driving script for the engine parity test: the same calls, in the same
 * order, at the same audio clock, against f1-game's GameAudio (in a Node VM,
 * tools/audio/gen-engine-trace.ts) and against src/audio/engine.ts.
 *
 * No imports and only erasable TypeScript (see fake-ctx.ts).
 */

/** The GameAudio methods the script drives. Loose on purpose: both sides satisfy it. */
export interface ScriptAudio {
  init(): void;
  setVoice(name: string): void;
  setVenue(def: { street?: boolean; theme?: string }): unknown;
  startEngine(): void;
  stopEngine(): void;
  setEngine(rev: number, boost: number, offroad: boolean, speed01: number, gear: number, ph: Record<string, number | boolean>): void;
  setSkid(x: number, wet?: boolean): void;
  setCarSfx(o: { scrub: number; lock: number; surface: number; pitLim: number; wet: boolean }): void;
  setRivals(list: { lat: number; arc: number; rev: number; approach: number; voice?: string; slot?: number; net?: boolean; key?: number; wx?: number; wz?: number }[]): void;
  setGridIdle(player: { rpm: number; gear: number; energy: number; ersDeploy: number }, o: { wet: boolean }): void;
  brakeCue(u: number): void;
  driveBrakeTone(u: number): void;
  cornerCall(side: string): void;
  shift(up: boolean): void;
  fieldContact(kind: string, impact: number, wx: number, wz: number, key: number): unknown;
  collision(impact: number, scrape: boolean, side: number): void;
  deployBoost(): void;
  overtakeReady(): void;
  xMode(on: boolean): void;
  lightOn(i: number): void;
  lightsOut(): void;
  lap(): void;
  finish(): void;
  penalty(): void;
  offtrack(): void;
  rumble(): void;
  thunder(near: number): void;
  pitGun(tighten: boolean): void;
  uiTick(): void;
  uiSelect(): void;
  uiReject(): void;
  setTune(p: Record<string, number>): unknown;
  setProfile(name: string): unknown;
  setLayer(name: string, on: boolean): unknown;
  setCameraMix(id: string): unknown;
  setRadioDuck(on: boolean, src?: string): unknown;
  setRadioFocusDb(db: number): unknown;
  setVoiceFocusHold(on: boolean, owner: string): unknown;
  setSfxVolume(v: number): unknown;
  setSfxEnabled(b: boolean): unknown;
  setEnabled(b: boolean): void;
  startRain(g?: number): void;
  stopRain(): void;
  feedReplayScrub(player: unknown, scrubbing: boolean, cars: unknown[], gearOf: (v: number) => number, rpmFor: (g: number, v: number) => number, rivalAudio: unknown, isWet: boolean, vTop: number): void;
  resetReplayScrub(): void;
  rivalState(): unknown;
  fieldContactState(): unknown;
  kerbSpray(): unknown;
  carSfx(): unknown;
  mixDuck(): unknown;
  tune(): unknown;
  profile(): unknown;
  shiftState(): unknown;
  boostState(): unknown;
  wastegateState(): unknown;
  overrunState(): unknown;
  brakeCueState(): unknown;
  limiterHeld(): unknown;
  harvestCoastLevel(): unknown;
  harvestBrakeLevel(): unknown;
}

export interface ScriptBasis { x: number; z: number; rightX: number; rightZ: number; fwdX: number; fwdZ: number; external: boolean }

export interface ScriptHost {
  trace: (string | number | boolean | null)[][];
  /** Set the audio clock (seconds) and the performance.now() clock with it. */
  setTime(t: number): void;
  flushTimers(): void;
  /** Let pending promise chains (fetch -> decode) run. */
  settle(): Promise<void>;
  setBasis(b: ScriptBasis | null): void;
}

const DT = 1 / 60;

function mark(h: ScriptHost, label: string): void { h.trace.push(["@", label]); }
function snap(h: ScriptHost, name: string, v: unknown): void { h.trace.push(["r", name, JSON.stringify(v)]); }

/** A deterministic race frame for step i. */
function frame(i: number, wetFrom: number) {
  const rev = Math.min(1, Math.max(0, 0.55 + 0.5 * Math.sin(i * 0.11)));
  const gear = 1 + (Math.floor(i / 9) % 8);
  const speed01 = Math.min(1, 0.05 + i * 0.006);
  const phase = i % 48;
  const ax = phase < 34 ? 6.5 : phase < 39 ? -3 : phase < 44 ? -14 : 0.2;
  const brake = phase >= 39 && phase < 44 ? 0.8 : 0;
  const throttle = phase < 34 ? 1 : phase < 44 ? 0 : 0.5;
  return {
    rev, gear, speed01,
    boost: i % 31 < 6 ? 1 : 0,
    offroad: i % 37 > 33,
    ph: {
      slip: 1 - 0.3 * Math.max(0, Math.sin(i * 0.3)), ax, axStd: ax * 0.9, onKerb: i % 17 > 13,
      wet: i >= wetFrom, tow: (i % 50) / 50, deploy: i % 31 < 6 ? 1 : 0, energy: Math.max(0.05, 1 - i * 0.004),
      ersDeploy: 0.6, throttle, brake, regen: 0.55,
    },
  };
}

function rivals(i: number) {
  return [
    { lat: 2 + Math.sin(i * 0.2), arc: 12 - i * 0.3, rev: 0.7, approach: 8, voice: "Mercedes", slot: 1, key: 11 },
    { lat: -3, arc: -20 + i * 0.1, rev: 0.4 + 0.3 * Math.sin(i * 0.5), approach: -4, voice: "Honda", slot: 0, net: true, key: 12, wx: 40, wz: 10 + i },
    { lat: 0.5, arc: 60, rev: 0.9, approach: 30, voice: "Audi", slot: 1, key: 13 },
    { lat: 8, arc: 200, rev: 0.5, approach: 0, key: 14 },
  ];
}

async function race(ga: ScriptAudio, h: ScriptHost, from: number, to: number, t0: number, wetFrom: number): Promise<number> {
  let t = t0;
  let lastGear = -1;
  for (let i = from; i < to; i++) {
    t += DT;
    h.setTime(t);
    const f = frame(i, wetFrom);
    if (lastGear > 0 && f.gear !== lastGear) ga.shift(f.gear > lastGear);
    lastGear = f.gear;
    if (i % 40 === 20) h.setBasis({ x: 0, z: 0, rightX: 1, rightZ: 0, fwdX: 0, fwdZ: 1, external: i % 80 === 20 });
    ga.setEngine(f.rev, f.boost, f.offroad, f.speed01, f.gear, f.ph);
    ga.setSkid(Math.max(0, Math.sin(i * 0.17)) * 0.6, !!f.ph.wet);
    ga.setCarSfx({ scrub: (i % 13) / 13, lock: i % 29 > 25 ? 0.8 : 0, surface: f.offroad ? 0.7 : 0, pitLim: i % 61 > 50 ? 1 : 0, wet: !!f.ph.wet });
    ga.brakeCue(i % 19 < 6 ? 0.2 + (i % 19) * 0.12 : 0);
    ga.setRivals(rivals(i));
    if (i % 23 === 5) ga.fieldContact(["bump", "scrape", "squeal"][i % 3] as string, 0.7, 30, 20, 3 + (i % 2));
    if (i % 23 === 6) ga.fieldContact("bump", 0.5, 30, 20, 3);
    if (i % 41 === 7) ga.collision(0.8, i % 2 === 0, i % 3 - 1);
    if (i % 31 === 0) ga.deployBoost();
  }
  return t;
}

export async function runEngineScript(ga: ScriptAudio, h: ScriptHost, scenario: "desktop" | "mobile"): Promise<void> {
  let t = 0;
  h.setTime(t);
  mark(h, "init");
  ga.init();
  ga.setVoice(scenario === "desktop" ? "Ferrari" : "Red Bull Ford");
  ga.setVenue(scenario === "desktop" ? { theme: "green-hills" } : { street: true });
  mark(h, "grid");
  ga.startEngine();
  for (let i = 0; i < 5; i++) {
    t += DT; h.setTime(t);
    ga.setGridIdle({ rpm: 6000 + i * 500, gear: 1, energy: 0.9, ersDeploy: 0.5 }, { wet: false });
    ga.lightOn(i);
  }
  ga.lightsOut();
  mark(h, "race-synth");
  t = await race(ga, h, 0, 40, t, 1e9);
  mark(h, "decode");
  await h.settle();
  mark(h, "race-samples");
  t = await race(ga, h, 40, 110, t, 80);
  snap(h, "rivalState", ga.rivalState());
  snap(h, "fieldContactState", ga.fieldContactState());
  snap(h, "kerbSpray", ga.kerbSpray());
  snap(h, "carSfx", ga.carSfx());

  mark(h, "limiter");
  for (let i = 0; i < 90; i++) {
    t += DT; h.setTime(t);
    ga.setEngine(1, 0, false, 0.95, 8, { slip: 1, ax: 0.1, axStd: 0.1, throttle: 1, brake: 0, energy: 0.5, deploy: 0, regen: 0.5 });
    if (i % 30 === 0) snap(h, "limiterHeld", ga.limiterHeld());
  }

  mark(h, "tune");
  snap(h, "setTune", ga.setTune({ pitch: 1.2, limRate: 1.5, detune: 2, sub: 1.5, bogus: 3, reverb: 9 }));
  snap(h, "profile", ga.profile());
  snap(h, "setProfile", ga.setProfile("v10"));
  snap(h, "layersOff", ga.setLayer("rivals", false));
  ga.setLayer("reverb", false);
  ga.setLayer("limiter", false);
  t = await race(ga, h, 110, 130, t, 80);
  ga.setLayer("rivals", true); ga.setLayer("reverb", true); ga.setLayer("limiter", true);
  snap(h, "setCameraMix", ga.setCameraMix("tv"));
  t = await race(ga, h, 130, 140, t, 80);
  ga.setCameraMix("cockpit");
  ga.setProfile("cockpit");

  mark(h, "mix");
  ga.setRadioDuck(true, "eng");
  ga.setRadioFocusDb(8);
  ga.setVoiceFocusHold(true, "spot");
  t = await race(ga, h, 140, 150, t, 80);
  ga.setRadioDuck(false, "eng");
  ga.setVoiceFocusHold(false, "spot");
  ga.setRadioFocusDb(0);
  ga.setSfxVolume(0.7);
  ga.setEnabled(false); ga.setEnabled(true);
  snap(h, "mixDuck", ga.mixDuck());

  mark(h, "events");
  t += 0.2; h.setTime(t);
  ga.overtakeReady(); ga.xMode(true); ga.xMode(false); ga.lap(); ga.penalty(); ga.offtrack();
  ga.rumble(); ga.thunder(0.8); ga.pitGun(false); ga.pitGun(true);
  ga.driveBrakeTone(0.5); ga.cornerCall("L"); ga.cornerCall("R");
  ga.uiTick(); t += 0.1; h.setTime(t); ga.uiSelect(); t += 0.1; h.setTime(t); ga.uiReject(); ga.uiTick();
  ga.collision(0.3, false, 0); ga.collision(0.9, true, 0);
  snap(h, "states", [ga.shiftState(), ga.boostState(), ga.wastegateState(), ga.overrunState(), ga.brakeCueState(), ga.harvestCoastLevel(), ga.harvestBrakeLevel(), ga.tune()]);

  mark(h, "stop");
  ga.stopEngine();
  ga.setSkid(0.5);
  ga.finish();
  h.flushTimers();

  mark(h, "rain");
  ga.startRain(0.1);
  t += 0.5; h.setTime(t);
  ga.stopRain();
  ga.startRain();
  h.flushTimers();
  ga.setSfxEnabled(false);
  ga.setSfxEnabled(true);
  ga.stopRain();
  h.flushTimers();

  mark(h, "replay");
  const gearOf = (v: number): number => Math.max(1, Math.min(8, 1 + Math.floor(v / 12)));
  const rpmFor = (g: number, v: number): number => 5000 + (v * 1000) / g;
  const cars = [{ speed: 30 }, { speed: 55 }];
  const player = { rpm: 9000, speed: 40, energy: 0.7, ersRegen: 0.5, offroad: false, gear: 4 };
  const rivalAudio = { collect: () => rivals(5) };
  for (let i = 0; i < 6; i++) {
    t += DT; h.setTime(t);
    player.speed = 40 + i * 3;
    ga.feedReplayScrub(player, true, cars, gearOf, rpmFor, rivalAudio, i > 2, 90);
  }
  ga.feedReplayScrub(player, false, cars, gearOf, rpmFor, rivalAudio, false, 90);
  ga.resetReplayScrub();
  h.flushTimers();

  mark(h, "restart");
  ga.setVoice("Mercedes");
  ga.startEngine();
  t = await race(ga, h, 150, 160, t, 80);
  ga.stopEngine();
  h.flushTimers();
  mark(h, "end");
}
