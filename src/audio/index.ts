/**
 * The audio lane's entry point: `createAudio()` returns the `AudioSeam` the
 * shell drives, over the ported GameAudio engine (./engine).
 *
 * `update(frame)` does what f1-game js/game.js:4585-4610 does on the last
 * physics step of a frame (setEngine with `_engArg`, setSkid, brakeCue,
 * setRivals) plus carSfx (game.js:4612), and game.js:4446 on the countdown
 * (setGridIdle). `event(kind, ...)` is one GameAudio one-shot per kind.
 */
import type {
  AudioEventArgs, AudioEventKind, AudioFrame, AudioListenerBasis, AudioSeam, AudioVenue,
} from "../contracts/audio";
import { createEngine, type EngineOptions, type EnginePhysics, type GameAudioEngine } from "./engine";

export type { GameAudioEngine } from "./engine";

/** f1-game js/physics/consts.js:210. TODO(lane-physics): import from src/physics. */
const IDLE_RPM = 5000, MAX_RPM = 15000;

/**
 * Phone-class device, as f1-game js/render/shared/glx-facade.js:11-14 decides
 * GLX.isMobile (audio follows the device, not the graphics tier: engine.js:115-118).
 */
export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  let force = false;
  try { force = typeof localStorage !== "undefined" && localStorage.getItem("a26.forceMobileTier") === "1"; } catch { /* storage blocked */ }
  const ua = navigator.userAgent || "";
  const touch = navigator.maxTouchPoints || 0;
  return force || /iPhone|iPad|iPod|Android/i.test(ua) || (touch > 1 && /Mac/.test(ua));
}

export interface Audio extends AudioSeam {
  /** The full ported GameAudio surface (tuner, mixer, test hooks). */
  readonly engine: GameAudioEngine;
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

export function createAudio(opts: EngineOptions = {}): Audio {
  let listener: AudioListenerBasis | null = null;
  const engine = createEngine({
    engineUrl: `${import.meta.env.BASE_URL}audio/f1_engine.mp3`,
    lowPower: isMobileDevice,
    listener: () => listener,
    ...opts,
  });

  // Reused every frame, like game.js:4335 `_engArg`: setEngine reads it synchronously.
  const ph: EnginePhysics = {
    slip: 1, ax: 0, axStd: 0, onKerb: false, wet: false, tow: 0,
    deploy: 0, energy: 1, ersDeploy: 0.5, throttle: 1, brake: 0, regen: 0.5,
  };
  const grid = { rpm: IDLE_RPM, gear: 1, energy: 1, ersDeploy: 0.5 };
  const gridOpts = { wet: false };

  function update(f: AudioFrame): void {
    if (f.listener !== undefined) listener = f.listener;
    if (f.phase === "grid") {
      grid.rpm = f.rpm; grid.gear = f.gear; grid.energy = f.energy; grid.ersDeploy = f.ersDeploy;
      gridOpts.wet = f.wet;
      engine.setGridIdle(grid, gridOpts);
      return;
    }
    const revFrac = clamp01((f.rpm - IDLE_RPM) / (MAX_RPM - IDLE_RPM));
    ph.slip = f.slip; ph.ax = f.ax; ph.axStd = f.axStd;
    ph.onKerb = f.onKerb; ph.wet = f.wet; ph.tow = f.tow;
    ph.deploy = f.deploying ? 1 : 0; ph.energy = f.energy; ph.ersDeploy = f.ersDeploy;
    ph.throttle = f.throttle; ph.brake = f.brake; ph.regen = f.regen;
    ph.boostOn = f.boostOn; ph.otOn = f.otOn;
    engine.setEngine(revFrac, f.deploying ? 1 : 0, f.offroad, clamp01(f.speed01), f.gear, ph);
    // Squeal from the CAR's slip, never the road's curvature (game.js:4595-4599).
    engine.setSkid(f.skid, f.wet);
    if (f.brakeCue !== undefined) engine.brakeCue(f.brakeCue);
    engine.setRivals(f.rivals ?? []);
    if (f.carSfx) engine.setCarSfx(f.carSfx);
  }

  const handlers: { [K in AudioEventKind]: (...a: AudioEventArgs[K]) => void } = {
    shift: (up) => engine.shift(up),
    lightOn: (i) => engine.lightOn(i),
    lightsOut: () => engine.lightsOut(),
    lap: () => engine.lap(),
    finish: () => engine.finish(),
    penalty: () => engine.penalty(),
    offtrack: () => engine.offtrack(),
    rumble: () => engine.rumble(),
    collision: (impact, scrape, side) => engine.collision(impact, scrape, side),
    fieldContact: (kind, impact, wx, wz, key) => { engine.fieldContact(kind, impact, wx, wz, key); },
    deployBoost: () => engine.deployBoost(),
    overtakeReady: () => engine.overtakeReady(),
    xMode: (on) => engine.xMode(on),
    thunder: (near) => engine.thunder(near),
    pitGun: (tighten) => engine.pitGun(tighten),
    uiTick: () => engine.uiTick(),
    uiSelect: () => engine.uiSelect(),
    uiReject: () => engine.uiReject(),
  };

  return {
    engine,
    init: () => engine.init(),
    update,
    event<K extends AudioEventKind>(kind: K, ...args: AudioEventArgs[K]): void {
      (handlers[kind] as (...a: AudioEventArgs[K]) => void)(...args);
    },
    startEngine: () => engine.startEngine(),
    stopEngine: () => engine.stopEngine(),
    setVoice: (name: string | undefined) => engine.setVoice(name),
    setVenue: (v: AudioVenue | null | undefined) => { engine.setVenue(v); },
    setCameraMix: (id: string) => { engine.setCameraMix(id); },
    startRain: (gain?: number) => engine.startRain(gain),
    stopRain: () => engine.stopRain(),
    startMusic: (trackIdx: number) => engine.music.startMusic(trackIdx),
    stopMusic: () => engine.music.stopMusic(),
  };
}
