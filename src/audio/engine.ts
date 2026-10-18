/**
 * GameAudio engine: the WebAudio context, the player's engine voice and its
 * continuous layers, the rival field, field contact and the race one-shots.
 *
 * Ported from f1-game js/audio/engine.js:4-3184 (`GameAudio`). The f1-game
 * module is a global IIFE that reaches for sibling globals; here every one of
 * them is an explicit dependency on `EngineOptions`:
 *   GameAudioSignal     ./signal (createSignal)
 *   ErsLayer            ./ers-layer (createErsLayer, one per engine)
 *   GameAudioToneModel  ./tone-model
 *   GameAudioSoundtrack opts.createMusic  (null music until it is ported)
 *   GameAudioRadioFx    opts.createRadio  (null radio until it is ported)
 *   RivalAudio          opts.rivalPassBy
 *   GameCams            opts.listener
 *   GLX.isMobile        opts.lowPower
 *   RealRace.status     opts.assistQuiet
 *   PhysicsConsts       PHYS below (js/physics/consts.js:13-14, 208-210)
 *   Log                 opts.log
 *   Math.random         opts.rand
 * Method names are f1-game's so the call-trace parity test
 * (tests/unit/audio/engine-parity.test.ts) can drive both with one script.
 * Line references in comments are to f1-game js/audio/engine.js.
 */
import type { AudioListenerBasis, AudioRivalRow, AudioVenue } from "../contracts/audio";
import { createErsLayer, type ErsInspect, type ErsLayer } from "./ers-layer";
import { createSignal, detectPeriod, findStableLoop, type LoopSpan, type Rand, type Signal } from "./signal";
import { tag } from "./tags";
import {
  DEFAULT_VOICE, ENGINE_VOICES, LAYER_DEF, SOUND_PROFILES, TUNE_DEF, TUNE_RANGE,
  isProfile, nameForTune, patchTune,
  type EngineVoice, type Layers, type SoundProfile, type Tune,
} from "./tone-model";

/** f1-game js/physics/consts.js:13-14, 208-210, read by engine.js through `PhysicsConsts`. */
// TODO(lane-physics): import these from src/physics once its consts module lands.
const PHYS = { ACCEL: 7, BRAKE: 22, GEARS: 8, IDLE_RPM: 5000, MAX_RPM: 15000 } as const;

export interface AudioLog {
  debug(tag: string, ...msg: unknown[]): void;
  info(tag: string, ...msg: unknown[]): void;
  warn(tag: string, ...msg: unknown[]): void;
}
const NULL_LOG: AudioLog = { debug() {}, info() {}, warn() {} };

/** What the soundtrack is given (engine.js:347-350). */
export interface MusicHost {
  context(): AudioContext | null;
  master(): GainNode | null;
  enabled(): boolean;
  engineRunning(): boolean;
  sfxOk(): boolean;
  clamp01(v: unknown): number;
  now(): number;
  resumeRejected(where: string): (err: unknown) => void;
}

/** The soundtrack surface the engine drives (engine.js:351, 779-871, 1430, 1904). */
export interface EngineMusic {
  startMusic(trackIdx: number): void;
  stopMusic(): void;
  setRadioDuck(on: boolean): number;
  duckForEngine(rev: number, t: number): void;
  releaseEngineDuck(t: number, useRadio: boolean): void;
  isPlaying(): boolean;
  lastTrack(): number;
  suspendMusic(): void;
  resumeMusic(trackIdx: number): void;
  resetContext(): void;
  musicPlaybackGeneration(): number;
  volume(): number;
}

/** What radio fx is given (engine.js:466-469). */
export interface RadioHost {
  context(): AudioContext | null;
  master(): GainNode | null;
  bus(): GainNode | null;
  enabled(): boolean;
  sfxOk(): boolean;
  now(): number;
  setSpotterDuck(on: boolean): number;
  setVoiceFocusHold(on: boolean, owner: unknown): boolean;
  setVoiceFocusSpan(owner: unknown, start: number, end: number, context: BaseAudioContext): boolean;
}

/** The radio surface the engine needs itself; the full module is held by its creator. */
export interface EngineRadio {
  resetContext(): void;
}

/** js/audio/rivals.js's pass-by layer, as engine.js reaches it (engine.js:686-699, 1439, 2514, 2615). */
export interface RivalPassBy {
  attach(ctx: AudioContext, dest: AudioNode): void;
  setMix(mix: number): void;
  silence(t?: number): void;
  sprayAhead(list: readonly AudioRivalRow[] | null | undefined): number;
}

interface DocLike { readonly hidden: boolean; addEventListener(type: string, fn: () => void): void }
interface WinLike { addEventListener(type: string, fn: (ev: Event) => void, capture?: boolean): void }

export interface EngineOptions {
  /** Context constructor; defaults to window.AudioContext / webkitAudioContext. */
  AudioContext?: (new () => AudioContext) | null | undefined;
  /** URL of the engine drone (f1-game assets/sfx/f1_engine.mp3). */
  engineUrl?: string;
  fetch?: ((url: string) => Promise<Response>) | undefined;
  rand?: Rand;
  log?: AudioLog;
  /** Phone-class device: halves the voice pools and drops the convolver (engine.js:119-124). */
  lowPower?: () => boolean;
  /** Camera listener, for external pans (GameCams.getListenerBasis). */
  listener?: () => AudioListenerBasis | null | undefined;
  /** True while a real-race replay plays (RealRace.status().watch): assist cues stay quiet. */
  assistQuiet?: () => boolean;
  rivalPassBy?: RivalPassBy | null;
  createMusic?: (host: MusicHost) => EngineMusic;
  createRadio?: (host: RadioHost, signal: Signal) => EngineRadio;
  document?: DocLike | null;
  window?: WinLike | null;
}

/** setEngine's physics extras (game.js:4335 `_engArg`). */
export interface EnginePhysics {
  slip?: number | undefined;
  ax?: number | undefined;
  axStd?: number | undefined;
  brake?: number | undefined;
  onKerb?: boolean | undefined;
  wet?: boolean | undefined;
  tow?: number | undefined;
  throttle?: number | undefined;
  deploy?: number | undefined;
  energy?: number | undefined;
  regen?: number | undefined;
  ersDeploy?: number | undefined;
  ersOn?: boolean | undefined;
  boostOn?: boolean | undefined;
  otOn?: boolean | undefined;
}

/** The player-car fields setGridIdle / feedReplayScrub read. */
export interface EngineCar {
  rpm?: number;
  gear?: number;
  speed?: number;
  energy?: number;
  ersDeploy?: number;
  ersRegen?: number;
  offroad?: boolean;
}

export interface CarSfxLevels {
  scrub?: number | undefined;
  lock?: number | undefined;
  surface?: number | undefined;
  pitLim?: number | undefined;
  wet?: boolean | undefined;
}

export type SkidExtra = { lat?: number; long?: number; slip?: number; wet?: boolean };

/** Null soundtrack: silent until js/audio/soundtrack.js is ported. */
export function nullMusic(): EngineMusic {
  return {
    startMusic() {}, stopMusic() {}, setRadioDuck: (on) => (on ? 0.35 : 1),
    duckForEngine() {}, releaseEngineDuck() {}, isPlaying: () => false, lastTrack: () => -1,
    suspendMusic() {}, resumeMusic() {}, resetContext() {}, musicPlaybackGeneration: () => 0, volume: () => 0.5,
  };
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

export type GameAudioEngine = ReturnType<typeof createEngine>;

interface RivalVoice {
  filt: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
  detune: number;
  src: AudioBufferSourceNode | null;
  oscs: OscillatorNode[] | null;
  start: () => void;
  stop: (t: number) => void;
  setPitch: (t: number, rev01: number, mul: number) => void;
}
interface ContactVoice { osc: OscillatorNode; filt: BiquadFilterNode; gain: GainNode; pan: StereoPannerNode; freeAt: number; player?: boolean }
interface CurveEvent { at: number; target: number; tau: number }
interface Curve { at: number; value: number; events: CurveEvent[] }
interface Venue { decay: number; damp: number; level: number }
interface CamMix { engine: number; cut: number; wind: number; rivals: number; reverb: number }

export function createEngine(opts: EngineOptions = {}) {
  const rand: Rand = opts.rand ?? Math.random;
  const Log: AudioLog = opts.log ?? NULL_LOG;
  const doc: DocLike | null = opts.document !== undefined ? opts.document : (typeof document !== "undefined" ? document : null);
  const win: WinLike | null = opts.window !== undefined ? opts.window : (typeof window !== "undefined" ? window : null);
  const docHidden = (): boolean => !!doc && doc.hidden;
  const fetchFn = opts.fetch ?? ((url: string) => fetch(url));
  const rivalPassBy = opts.rivalPassBy ?? null;
  const ers: ErsLayer = createErsLayer();

  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let sfxBus: GainNode | null = null;
  let limiter: DynamicsCompressorNode | null = null;   // between master and the destination
  // 0..1 mixer levels, restored by the caller from storage on boot.
  let sfxVol = 1;
  let sfxEnabled = true;      // the SOUND EFFECTS switch — music is unaffected
  let isEnabled = true;

  // Engine voice (persistent while racing)
  let engA: OscillatorNode | null = null, engB: OscillatorNode | null = null, engC: OscillatorNode | null = null;
  let engFilter: BiquadFilterNode | null = null, engGain: GainNode | null = null;
  let limOsc: OscillatorNode | null = null, limGain: GainNode | null = null;   // rev-limiter gate (audio-thread)
  // TOP-GEAR LIMITER FADE (engine.js:17-24): in top gear the cut plays
  // LIM_HOLD s at full depth, then fades over LIM_FADE s to a steady note.
  const LIM_HOLD = 0.5, LIM_FADE = 0.5;
  let limSince: number | null = null;
  let limPitch: GainNode | null = null;
  let whineOsc: OscillatorNode | null = null, whineGain: GainNode | null = null;
  let harvSrc: AudioBufferSourceNode | null = null, harvFilter: BiquadFilterNode | null = null, harvGain: GainNode | null = null;
  let lfo: OscillatorNode | null = null, lfoG: GainNode | null = null;
  let skidSrc: AudioBufferSourceNode | null = null, skidFilter: BiquadFilterNode | null = null, skidGain: GainNode | null = null;
  let skidLfo: OscillatorNode | null = null, skidLfoGain: GainNode | null = null;
  let voiceFormant: BiquadFilterNode | null = null;
  let ersOsc: OscillatorNode | null = null, ersHp: BiquadFilterNode | null = null, ersGain: GainNode | null = null;
  let windSrc: AudioBufferSourceNode | null = null, windFilter: BiquadFilterNode | null = null, windGain: GainNode | null = null;
  let subOctOsc: OscillatorNode | null = null, subOctGain: GainNode | null = null;
  let tiltEq: BiquadFilterNode | null = null;
  let gravOsc: OscillatorNode | null = null, gravGain: GainNode | null = null;
  let brakeSrc: AudioBufferSourceNode | null = null, brakeFilter: BiquadFilterNode | null = null, brakeGain: GainNode | null = null;
  let scrubSrc: AudioBufferSourceNode | null = null, scrubFilter: BiquadFilterNode | null = null, scrubGain: GainNode | null = null;
  let lockFilter: BiquadFilterNode | null = null, lockGain: GainNode | null = null;
  let surfSrc: AudioBufferSourceNode | null = null, surfFilter: BiquadFilterNode | null = null, surfGain: GainNode | null = null;
  let kerbSrc: AudioBufferSourceNode | null = null, kerbFilter: BiquadFilterNode | null = null, kerbGain: GainNode | null = null;
  let spraySrc: AudioBufferSourceNode | null = null, sprayFilter: BiquadFilterNode | null = null, sprayGain: GainNode | null = null;
  let kerbLive = false;
  let sprayAhead = 0;
  let pitLimOsc: OscillatorNode | null = null, pitLimGain: GainNode | null = null;
  let cylCutOsc: OscillatorNode | null = null, cylCutGain: GainNode | null = null;
  let revFlare = 0, revFlareT = 0;
  const carSfxLast = { scrub: 0, lock: 0, surface: 0, pitLim: 0 };
  let pitGunFired = 0, surfSched = 0;
  let pitLimLvl = 0;

  // FIELD CONTACT (engine.js:53-69).
  const CONTACT_VOICES_DESKTOP = 3, CONTACT_VOICES_MOBILE = 2;
  const CONTACT_COOLDOWN = 0.25;
  const CONTACT_RANGE = 120;
  const CONTACT_REF = 8;
  let contactVoices: ContactVoice[] = [];
  const _contactCdKeys = new Int32Array(24);
  const _contactCdUntil = new Float64Array(24);
  let _contactCdN = 0;
  let fieldArmed = false;
  let contactFired = 0, contactDeniedCd = 0, contactDeniedCap = 0, contactDeniedGate = 0;
  let _lastPlayerContactPan = 0;

  // CIRCUIT REVERB (engine.js:81-100): generated impulse responses.
  const VENUES: Readonly<Record<"street" | "modern" | "green" | "desert", Venue>> = Object.freeze({
    street: { decay: 1.9, damp: 3400, level: 0.30 },   // hard walls, close, bright
    modern: { decay: 1.5, damp: 2600, level: 0.18 },   // grandstand bowls, further off
    green:  { decay: 0.9, damp: 1500, level: 0.10 },   // trees absorb; short and dark
    desert: { decay: 1.1, damp: 2200, level: 0.09 },   // open and dry, almost nothing
  });
  let venue: Venue = VENUES.modern, venueName: keyof typeof VENUES = "modern";
  let convolver: ConvolverNode | null = null, revSend: GainNode | null = null, revReturn: GainNode | null = null;
  const _irCache = new Map<string, AudioBuffer>();

  // Audio follows the DEVICE, read lazily (engine.js:102-124).
  function lowPower(): boolean {
    try { return !!(opts.lowPower && opts.lowPower()); } catch { return false; }
  }
  const RIVAL_VOICES_DESKTOP = 4, RIVAL_VOICES_MOBILE = 2;
  let RIVAL_VOICES = RIVAL_VOICES_DESKTOP;
  const RIVAL_RANGE = 150;        // metres of arc beyond which a rival is inaudible
  const RIVAL_REF = 6;            // metres inside which a rival is at full level
  const RIVAL_DETUNE: readonly number[] = Object.freeze([-22, -8, 9, 24].map((c) => Math.pow(2, c / 1200)));
  const PAN_MAKEUP = Math.SQRT2;
  let rivalPeak = 0.28;

  // CAMERA MIX (engine.js:154-169).
  const CAM_MIX: Readonly<Record<"onboard" | "chase" | "tv", Readonly<CamMix>>> = Object.freeze({
    onboard: Object.freeze({ engine: 1.08, cut: 1.00, wind: 0.70, rivals: 1.00, reverb: 0.60 }),
    chase:   Object.freeze({ engine: 1.00, cut: 1.00, wind: 1.00, rivals: 1.00, reverb: 1.00 }),
    tv:      Object.freeze({ engine: 0.55, cut: 0.55, wind: 0.30, rivals: 1.25, reverb: 1.80 }),
  });
  const CAM_KIND: Readonly<Record<string, "onboard" | "chase" | "tv">> = Object.freeze({
    cockpit: "onboard", hood: "onboard", tcam: "onboard", rear: "onboard", visor: "onboard", helmet: "onboard",
    chase: "chase", far: "chase", drift: "chase", reverse: "chase",
    overhead: "tv", heli: "tv", side: "tv", cinematic: "tv", low: "tv", trackside: "tv",
    rival: "tv", pitwall: "tv", drone: "tv", tv: "tv",
  });
  let camMix: Readonly<CamMix> = CAM_MIX.chase, camKind: "onboard" | "chase" | "tv" = "chase";
  let rivalVoices: RivalVoice[] = [];

  let voice: EngineVoice = DEFAULT_VOICE;
  let voiceName = "default";
  let tune: Tune = Object.assign({}, TUNE_DEF);
  const layers: Layers = Object.assign({}, LAYER_DEF);
  let profileName: SoundProfile | "custom" = "team";

  // Schedule a gain target only when it has MOVED, by a 1e-4 threshold
  // (engine.js:179-200). The cache lives on the node (tag()).
  function aimGain(node: GainNode | null, target: number, t: number, tau: number): void {
    if (!node) return;
    const tg = tag(node);
    const prev = tg._apexAimTgt;
    if (prev === target || (prev !== undefined && Math.abs(prev - target) < 1e-4)) return;
    node.gain.setTargetAtTime(target, t, tau);
    tg._apexAimTgt = target;
  }
  // The same guard for a pitch or cutoff param, relative (engine.js:201-211).
  function aimParam(p: AudioParam, target: number, t: number, tau: number, rel: number): void {
    const tg = tag(p);
    const prev = tg._apexAimTgt;
    if (prev === target || (prev !== undefined && Math.abs(prev - target) <= Math.abs(target) * rel)) return;
    p.setTargetAtTime(target, t, tau);
    tg._apexAimTgt = target;
  }
  let engineOn = false;
  let engineActionGeneration = 0;
  // Node batches from stopEngine() still fading on sfxBus, one per stop (engine.js:214-242).
  const _dying: AudioNode[][] = [];
  function killNodes(nodes: readonly AudioNode[]): void {
    for (let i = 0; i < nodes.length; i++) {
      try { const n = nodes[i]; if (n && n.disconnect) n.disconnect(); } catch { /* torn down */ }
    }
  }
  function flushDying(): void {
    for (let i = 0; i < _dying.length; i++) killNodes(_dying[i] as AudioNode[]);
    _dying.length = 0;
  }
  function queueDying(nodes: readonly (AudioNode | null | undefined)[]): void {
    const batch: AudioNode[] = [];
    for (let i = 0; i < nodes.length; i++) { const n = nodes[i]; if (n) batch.push(n); }
    if (!batch.length) return;
    _dying.push(batch);
    // EACH BATCH OWNS ITS TIMER (engine.js:233-235).
    setTimeout(() => {
      const i = _dying.indexOf(batch);
      if (i < 0) return;             // already buried by flushDying()
      _dying.splice(i, 1);
      killNodes(batch);
    }, 450);
  }
  let lastSpeed = 0, lastEngT = 0, harvLevel = 0, harvBrakeLevel = 0, harvCoastLevel = 0;
  let shiftDuck = 0, shiftDuckT = 0;
  let overrunT = 0;
  let overrunFired = 0;
  let pullT = 0;
  let wasteFired = 0;
  let shiftFired = 0, shiftPeak = 0;
  let boostFired = 0, boostPeak = 0;
  let idleGainRamped = false;
  let rateFresh = false;
  let lastGearSeen = NaN;
  let cueT = 0, cueFired = 0, cueU = 0;

  let engBuf: AudioBuffer | null = null, samplesReady = false;
  let engLoop: LoopSpan | null = null, engWin: LoopSpan | null = null;
  let lastRate = 0;
  let enginePeriod = 0;

  let engSrcIdle: AudioBufferSourceNode | null = null, engGainIdle: GainNode | null = null;
  let usingSamples = false;
  let dbgAnalyser: AnalyserNode | null = null;
  const SFX_ENGINE = opts.engineUrl ?? "audio/f1_engine.mp3";

  let listenersAttached = false;
  let rebuildTries = 0;
  let lastFailedResume = 0;
  let deviceRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let deviceRebuildTimerWhy = "";
  let deviceRebuildPending = "";
  let deviceRebuildBusy = false;
  let deviceRebuildStamps: number[] = [];
  let ctxSampleRate = 0;
  const DEVICE_REBUILD_DEBOUNCE_MS = 280;
  const DEVICE_REBUILD_MAX = 3, DEVICE_REBUILD_WINDOW_MS = 30000;
  let resumeMusic: number | null = null;
  let resumeEngine: number | null = null;
  let resumeRain = false;

  function clamp01(v: unknown): number {
    return clamp(typeof v === "number" && Number.isFinite(v) ? v : 0, 0, 1);
  }

  // Slip -> tyre squeal, speed -> wind. Pure (engine.js:295-314).
  const SQUEAL_THRESH = 0.10;
  function squealFromSlip(lat01: number, long01: number, wet?: boolean): { gain: number; hz: number; lfo: number } {
    const lat = clamp01(lat01), long = clamp01(long01);
    const raw = Math.min(1, Math.sqrt(lat * lat + long * long));
    const over = raw <= SQUEAL_THRESH ? 0 : (raw - SQUEAL_THRESH) / (1 - SQUEAL_THRESH);
    return {
      gain: over * (wet ? 0.10 : 0.16),
      hz: (wet ? 480 : 760) + over * 320 + (over > 0 ? long * 120 : 0),
      lfo: over > 0 ? 60 : 0,
    };
  }
  const WIND_GATE = 0.04;
  function windFromSpeed(s01: number): { gain: number; hz: number } {
    const s = clamp01(s01);
    const u = s <= WIND_GATE ? 0 : (s - WIND_GATE) / (1 - WIND_GATE);
    return { gain: 0.036 * u * u, hz: 450 + u * 1450 };
  }

  // iOS audio session (engine.js:316-341).
  let sessionType: "playback" | "ambient" = "playback";
  function applySessionType(): void {
    try {
      const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { audioSession?: { type: string } }) : null;
      if (nav && nav.audioSession) nav.audioSession.type = sessionType;
    } catch { /* older iOS */ }
  }
  function setSessionType(t: unknown): "playback" | "ambient" {
    const v = (t === "ambient" || t === "playback") ? t : "playback";
    if (v === sessionType) return v;
    sessionType = v;
    applySessionType();
    return v;
  }

  // Services are functions so a rebuild never leaves a module holding the old context.
  const signal = createSignal({ context: () => ctx, bus: () => sfxBus, sfxOk, now }, rand);
  const { env, blip, noiseBuf, loopNoise, noisePool, bindNoise, noise, hiss, scrapeNoise } = signal;
  const soundtrack: EngineMusic = (opts.createMusic ?? nullMusic)({
    context: () => ctx, master: () => master, enabled, engineRunning: () => engineOn,
    sfxOk, clamp01, now, resumeRejected,
  });

  // TWO HOLDS, ONE DUCK, and the SFX mix duck (engine.js:352-465).
  const radioDuckHolds = new Set<string>();
  let spotterDuckHold = false;
  const MIX_DUCK_LIN = 10 ** (-8 / 20);   // ≈ 0.3981
  const MIX_DUCK_ATTACK_TAU = 0.08;
  const MIX_DUCK_RELEASE_TAU = 0.4;
  let mixDuckOn = false;
  let radioFocusDb = 0, focusBus: GainNode | null = null;
  const focusVoices = new Map<unknown, { context: BaseAudioContext; start: number; end: number }>();
  let focusCurve: Curve = { at: 0, value: 1, events: [] }, sfxCurve: Curve = { at: 0, value: 1, events: [] };
  function curveValue(curve: Curve, time: number): number {
    let value = curve.value, at = curve.at, target = value, tau = 1;
    for (const e of curve.events) {
      if (e.at > time) break;
      value = target + (value - target) * Math.exp(-(e.at - at) / tau);
      at = e.at; target = e.target; tau = e.tau;
    }
    return target + (value - target) * Math.exp(-Math.max(0, time - at) / tau);
  }
  function writeCurve(param: AudioParam, curve: Curve, events: CurveEvent[]): void {
    const c = ctx as AudioContext;
    const t = c.currentTime, value = curveValue(curve, t);
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
    else { param.cancelScheduledValues(t); param.setValueAtTime(value, t); }
    curve.at = t; curve.value = value; curve.events = events;
    for (const e of events) param.setTargetAtTime(e.target, e.at, e.tau);
  }
  function sfxBusTarget(): number {
    if (!sfxEnabled) return 0;
    return sfxVol * (!radioFocusDb && mixDuckOn ? MIX_DUCK_LIN : 1);
  }
  function writeSfx(tau: number): void {
    if (sfxBus && ctx) writeCurve(sfxBus.gain, sfxCurve,
      [{ at: ctx.currentTime, target: sfxBusTarget(), tau }]);
  }
  function refreshFocus(tau?: number): void {
    if (!focusBus || !ctx) return;
    const t = ctx.currentTime, spans: [number, number][] = [], base = sfxEnabled ? sfxVol : 0;
    if (!radioFocusDb) {
      const target = sfxBusTarget();
      if (focusCurve.events.length === 1 && (focusCurve.events[0] as CurveEvent).target === target) return;
      writeCurve(focusBus.gain, focusCurve, [{ at: t, target, tau: tau || (target < curveValue(focusCurve, t) ? MIX_DUCK_ATTACK_TAU : MIX_DUCK_RELEASE_TAU) }]);
      return;
    }
    for (const [owner, v] of focusVoices) {
      if (v.context !== ctx || v.end <= t) { focusVoices.delete(owner); continue; }
      if (radioFocusDb) spans.push([Math.max(t, v.start), v.end]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const span of spans) {
      const prev = merged[merged.length - 1];
      if (prev && span[0] <= prev[1]) prev[1] = Math.max(prev[1], span[1]);
      else merged.push([span[0], span[1]]);
    }
    const lin = base * 10 ** (-radioFocusDb / 20), events: CurveEvent[] = [];
    if (!merged.length || (merged[0] as [number, number])[0] > t) events.push({ at: t, target: base, tau: tau || MIX_DUCK_RELEASE_TAU });
    for (const span of merged) {
      events.push({ at: span[0], target: lin, tau: span[0] === t ? (tau || (lin < curveValue(focusCurve, t) ? MIX_DUCK_ATTACK_TAU : MIX_DUCK_RELEASE_TAU)) : MIX_DUCK_ATTACK_TAU });
      if (Number.isFinite(span[1])) events.push({ at: span[1], target: base, tau: MIX_DUCK_RELEASE_TAU });
    }
    writeCurve(focusBus.gain, focusCurve, events);
  }
  function setVoiceFocusSpan(owner: unknown, start: number, end: number, context: BaseAudioContext): boolean {
    if (context !== ctx || !ctx || !Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return false;
    focusVoices.set(owner, { context, start, end }); refreshFocus(); return true;
  }
  function setVoiceFocusHold(on: boolean, owner: unknown): boolean {
    if (!owner) return false;
    if (on && ctx) focusVoices.set(owner, { context: ctx, start: ctx.currentTime, end: Infinity });
    else focusVoices.delete(owner);
    refreshFocus(); return !!on && !!ctx;
  }
  function setRadioFocusDb(value: number): number {
    const db = [0, 4, 8, 12].indexOf(value) >= 0 ? value : 0;
    if (db === radioFocusDb) return radioFocusDb;   // repeated lazy/panel restore is inert
    radioFocusDb = db;
    const lowering = ctx && sfxBusTarget() < curveValue(sfxCurve, ctx.currentTime);
    writeSfx(lowering ? MIX_DUCK_ATTACK_TAU : MIX_DUCK_RELEASE_TAU);
    refreshFocus(); return radioFocusDb;
  }
  function applySfxDuck(on: boolean): boolean {
    const want = !!on, changed = want !== mixDuckOn;
    mixDuckOn = want;
    if (changed) { writeSfx(want ? MIX_DUCK_ATTACK_TAU : MIX_DUCK_RELEASE_TAU); refreshFocus(); }
    return mixDuckOn;
  }
  function applyMusicDuck(): number {
    const on = radioDuckHolds.size > 0 || spotterDuckHold;
    applySfxDuck(on);
    return soundtrack.setRadioDuck(on);
  }
  function setRadioDuck(on: boolean, src?: unknown): number {
    const id = src == null ? "radio" : String(src);
    if (on) radioDuckHolds.add(id); else radioDuckHolds.delete(id);
    return applyMusicDuck();
  }
  function setSpotterDuck(on: boolean): number {
    spotterDuckHold = !!on;
    return applyMusicDuck();
  }
  const radio: EngineRadio = opts.createRadio ? opts.createRadio({
    context: () => ctx, master: () => master, bus: () => sfxBus, enabled, sfxOk, now,
    setSpotterDuck, setVoiceFocusHold, setVoiceFocusSpan,
  }, signal) : { resetContext() {} };
  let ctxGen = 0;

  function contextCtor(): (new () => AudioContext) | null {
    if (opts.AudioContext !== undefined) return opts.AudioContext;
    const g = globalThis as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
    return g.AudioContext || g.webkitAudioContext || null;
  }

  function createCtx(): boolean {
    const AC = contextCtor();
    if (!AC) return false;

    applySessionType();

    const c = ctx = new AC();
    signal.resetContext();
    ctxGen++;   // buffers decoded on the old context are stale
    ctxSampleRate = c.sampleRate;
    c.onstatechange = () => {
      if (deviceRebuildBusy || !ctx) return;
      const st = ctx.state as AudioContextState | "interrupted";
      if (st === "closed") return;
      if (st === "interrupted" && _onInterrupted) { try { _onInterrupted(); } catch { /* a listener must not stop the resume below */ } }
      if (st === "interrupted") {
        // Session taken: release the SFX dip so a recovered graph is not stuck under a ghost line.
        applySfxDuck(false);
      }
      if (st === "running" && ctxSampleRate && ctx.sampleRate !== ctxSampleRate) {
        scheduleOutputDeviceRebuild("sampleRate");
      }
      if (st === "running") {
        ctxSampleRate = ctx.sampleRate;
        if (deviceRebuildTimer && staleStateRebuild(deviceRebuildTimerWhy)) { clearTimeout(deviceRebuildTimer); deviceRebuildTimer = null; }
        if (staleStateRebuild(deviceRebuildPending)) deviceRebuildPending = "";
        applyMusicDuck(); refreshFocus();
      }
      if (!docHidden() && (st === "interrupted" || st === "suspended")) {
        scheduleOutputDeviceRebuild("state-" + st);
      }
      if (st !== "running" && !docHidden()) resumeIfNeeded();
    };
    master = c.createGain();
    master.gain.value = isEnabled ? 0.8 : 0;
    // MASTER LIMITER (engine.js:516-524).
    limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -10; limiter.knee.value = 6; limiter.ratio.value = 12;
    limiter.attack.value = 0.003; limiter.release.value = 0.15;
    master.connect(limiter).connect(c.destination);
    sfxBus = c.createGain();
    mixDuckOn = radioDuckHolds.size > 0 || spotterDuckHold;
    sfxBus.gain.value = sfxBusTarget();
    sfxBus.connect(master);
    focusBus = c.createGain(); focusBus.gain.value = sfxBusTarget(); focusBus.connect(master);
    focusCurve = { at: c.currentTime, value: sfxBusTarget(), events: [] };
    sfxCurve = { at: c.currentTime, value: sfxBusTarget(), events: [] };
    attachRivalPassBy();
    attachErsLayer();

    // iOS Safari starts contexts suspended; resume inside the gesture, rejection guarded.
    if (c.state !== "running" && !docHidden()) { const p = c.resume(); if (p && p.catch) p.catch(resumeRejected("create")); }
    loadEngineSamples();
    return true;
  }

  // The first rejected resume() is a warn; repeats drop to debug (engine.js:543-553).
  let resumeWarned = false;
  function resumeRejected(where: string): (err: unknown) => void {
    return (err: unknown) => {
      const msg = err && typeof err === "object" && "message" in err ? (err as { message: unknown }).message : err;
      const why = "AudioContext resume rejected at " + where + " (state=" + (ctx && ctx.state) + "): " + String(msg);
      if (resumeWarned) { Log.debug("audio", why); return; }
      resumeWarned = true;
      Log.warn("audio", why + " — silent until a later gesture resumes it");
    };
  }

  function loadEngineSamples(): void {
    if (!ctx || samplesReady) return;
    const c = ctx;
    // A 404 body is an HTML page; throw on !ok so the degrade path logs WHY.
    const grab = (url: string): Promise<AudioBuffer> => fetchFn(url)
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status + " for " + url); return r.arrayBuffer(); })
      .then((ab) => new Promise<AudioBuffer>((res, rej) => { void c.decodeAudioData(ab, res, rej); }));
    // ONE sample (engine.js:562-566).
    grab(SFX_ENGINE)
      .then((e) => {
        enginePeriod = detectPeriod(e);   // on the full recording
        const w = loopWindow(e);          // the scan runs here, never on a race frame
        engBuf = w.buf; engLoop = w.loop; engWin = w.win; samplesReady = true;
        Log.debug("audio", "engine sample decoded, period=" + enginePeriod + ", kept " + engLoop.end.toFixed(2) + " of " + e.duration.toFixed(2) + " s");
      })
      .catch((err: unknown) => {
        Log.warn("audio", "engine sample load/decode failed, using synth voice: " + String(err && typeof err === "object" && "message" in err ? (err as { message: unknown }).message : err));
      });
  }

  // ONLY THE LOOP WINDOW IS EVER PLAYED (engine.js:581-596).
  function loopWindow(full: AudioBuffer): { buf: AudioBuffer; loop: LoopSpan; win: LoopSpan } {
    const li = findStableLoop(full), sr = full.sampleRate;
    const a = Math.max(0, Math.round(li.start * sr)), b = Math.min(full.length, Math.round(li.end * sr));
    if (!(b - a > 1) || !ctx || !ctx.createBuffer) return { buf: full, loop: li, win: li };
    const out = ctx.createBuffer(full.numberOfChannels, b - a, sr);
    for (let ch = 0; ch < full.numberOfChannels; ch++) {
      const seg = full.getChannelData(ch).subarray(a, b);
      if (out.copyToChannel) out.copyToChannel(seg, ch); else out.getChannelData(ch).set(seg);
    }
    return { buf: out, loop: { start: 0, end: (b - a) / sr }, win: { start: a / sr, end: b / sr } };
  }

  function stickyUserActivation(): boolean {
    try {
      const ua = typeof navigator !== "undefined" ? (navigator as Navigator & { userActivation?: { isActive: boolean; hasBeenActive: boolean } }).userActivation : undefined;
      return !!(ua && (ua.isActive || ua.hasBeenActive));
    } catch { return false; }
  }

  // A state-* request about a context that has since resumed needs no rebuild (engine.js:605-610).
  function staleStateRebuild(why: unknown): boolean {
    return typeof why === "string" && why.startsWith("state-") && !!ctx && ctx.state === "running";
  }
  function deferWhileHidden(why: string): void {
    if (!String(why).startsWith("state-")) deviceRebuildPending = why;
  }

  function scheduleOutputDeviceRebuild(why: string): void {
    if (!ctx || deviceRebuildBusy) return;
    if (docHidden()) { deferWhileHidden(why); return; }
    if (deviceRebuildTimer) clearTimeout(deviceRebuildTimer);
    deviceRebuildTimerWhy = why;
    deviceRebuildTimer = setTimeout(() => {
      deviceRebuildTimer = null;
      requestOutputDeviceRebuild(why);
    }, DEVICE_REBUILD_DEBOUNCE_MS);
  }

  function requestOutputDeviceRebuild(why: string): void {
    if (!ctx || deviceRebuildBusy) return;
    if (staleStateRebuild(why)) return;
    if (docHidden()) { deferWhileHidden(why); return; }
    if (!stickyUserActivation()) {
      deviceRebuildPending = why;
      Log.debug("audio", "output-device rebuild deferred (" + why + ") until the next gesture");
      return;
    }
    performOutputDeviceRebuild(why);
  }

  function performOutputDeviceRebuild(why: string): void {
    if (!ctx || docHidden() || deviceRebuildBusy) return;
    if (staleStateRebuild(why)) { deviceRebuildPending = ""; return; }
    deviceRebuildPending = "";
    const t = Date.now();
    deviceRebuildStamps = deviceRebuildStamps.filter((s) => t - s < DEVICE_REBUILD_WINDOW_MS);
    if (deviceRebuildStamps.length >= DEVICE_REBUILD_MAX) {
      Log.warn("audio", "output-device rebuild after " + why + " skipped: " + DEVICE_REBUILD_MAX + " rebuilds in " + (DEVICE_REBUILD_WINDOW_MS / 1000) + " s already");
      return;
    }
    deviceRebuildStamps.push(t);
    deviceRebuildBusy = true;
    Log.info("audio", "rebuilding AudioContext after " + why);
    try { rebuildCtx(); } finally { deviceRebuildBusy = false; }
  }

  function onMediaDeviceChange(): void {
    scheduleOutputDeviceRebuild("devicechange");
  }

  function attachOutputDeviceListeners(): void {
    try {
      const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
      if (!md || typeof md.addEventListener !== "function") return;
      md.addEventListener("devicechange", onMediaDeviceChange);
    } catch { /* absent in some WebViews */ }
  }

  function reapplyContextState(): void {
    if (!ctx) return;
    applyTuneNodes();
    applyVenue();
    applyMusicDuck();
    setSfxEnabled(sfxEnabled);
  }

  // Bind the rival pass-by pool to this context (engine.js:680-699).
  let rivalPassByCtx: AudioContext | null = null;
  function attachRivalPassBy(): void {
    if (!ctx || !sfxBus || !rivalPassBy) return;
    try {
      rivalPassBy.setMix(layers.rivals ? tune.rivals : 0);
      if (rivalPassByCtx === ctx) return;
      rivalPassBy.attach(ctx, focusBus as GainNode);
      rivalPassByCtx = ctx;
    } catch { /* mid-teardown */ }
  }

  function attachErsLayer(): void {
    if (!ctx || !sfxBus) return;
    try { ers.attach(ctx, sfxBus); } catch { /* mid-teardown */ }
  }

  function init(): void {
    // init is only ever called from a user gesture
    if (ctx) {
      resumeIfNeeded(true);
      attachRivalPassBy();
      attachErsLayer();
      Log.info("audio", "GameAudio.init state=" + (ctx && ctx.state));
      return;
    }
    if (!createCtx()) return;
    Log.info("audio", "GameAudio.init state=" + (ctx && (ctx as AudioContext).state));

    if (!listenersAttached) {
      listenersAttached = true;
      // iOS suspends the context on lock/app-switch and never resumes it by itself.
      const onGesture = (): void => resumeIfNeeded(true);
      if (win) {
        win.addEventListener("touchend", onGesture, true);
        win.addEventListener("pointerdown", onGesture, true);
        win.addEventListener("keydown", onGesture, true);
      }
      if (doc) doc.addEventListener("visibilitychange", onVisibility);
      attachOutputDeviceListeners();
    }
  }

  // Resume if not running; rebuild inside a LATER gesture if an earlier resume failed (engine.js:734-776).
  function resumeIfNeeded(gestureEv?: unknown): void {
    if (!ctx) return;
    const isGesture = !!gestureEv;
    if (isGesture && deviceRebuildPending && !staleStateRebuild(deviceRebuildPending)) {
      performOutputDeviceRebuild(String(deviceRebuildPending).startsWith("state-") ? deviceRebuildPending : "deferred-gesture");
      return;
    }
    if (ctx.state === "running") {
      rebuildTries = 0;
      lastFailedResume = 0;
      return;
    }
    if (isGesture && lastFailedResume &&
        Date.now() - lastFailedResume > 700 && rebuildTries < 3) {
      rebuildTries++;
      lastFailedResume = 0;
      rebuildCtx();
      return;
    }
    if (isGesture) lastFailedResume = Date.now();
    const p = ctx.resume();
    if (p && p.then) {
      p.then(() => {
        // RESOLVED IS NOT RUNNING: WebKit resolves on an "interrupted" context (engine.js:765-769).
        if (!ctx || ctx.state !== "running") return;
        rebuildTries = 0;
        lastFailedResume = 0;
        Log.info("audio", "GameAudio.resume state=" + (ctx && ctx.state));
      }).catch(resumeRejected("gesture"));
    }
  }

  function rebuildCtx(): void {
    const wasMusic = soundtrack.isPlaying();
    const wasTrack = soundtrack.lastTrack();
    const wasEngine = engineOn;
    if (wasMusic) soundtrack.suspendMusic();
    engineOn = false;               // old nodes died with the old context
    // close() REJECTS on an already-closed context; chain .catch (engine.js:784-797).
    try {
      const dying = ctx;
      if (dying) dying.onstatechange = null;
      const p = dying && dying.close();
      if (p && p.catch) p.catch((e: unknown) => { Log.debug("audio", "old context close rejected on rebuild:", e); });
    } catch { /* already closed */ }
    ers.detach();
    ctx = null;
    master = null;
    sfxBus = null; focusBus = null; focusVoices.clear();
    limiter = null;
    rainStopping = false;
    rainPending = null;
    rainSrc = null; rainGain = null; rainHp = null; rainLp = null;
    soundtrack.resetContext();
    engBuf = engLoop = engWin = null; samplesReady = false; // ctx-bound; reload for new ctx
    _irCache.clear();
    radio.resetContext();
    // Old radio callbacks never fire on a closed context — drop both holds.
    radioDuckHolds.clear();
    spotterDuckHold = false;
    mixDuckOn = false;
    revFlare = 0; revFlareT = 0; limSince = null;
    signal.resetContext();
    dbgAnalyser = null;
    if (!createCtx()) return;
    reapplyContextState();
    if (wasMusic) soundtrack.resumeMusic(wasTrack);
    if (wasEngine) startEngineGraph();
    if (rainWanted) startRain();
  }

  function onVisibility(): void {
    if (docHidden()) {
      resumeMusic = soundtrack.isPlaying() ? soundtrack.musicPlaybackGeneration() : null;
      resumeEngine = engineOn ? engineActionGeneration : null;
      resumeRain = rainWanted;
      soundtrack.suspendMusic();
      if (engineOn) stopEngineGraph();
      if (rainWanted) stopRain(true);
      // SUSPEND THE CONTEXT, not only its sources (engine.js:838-856).
      try {
        if (ctx && ctx.state === "running" && ctx.suspend) {
          const p = ctx.suspend(); if (p && p.catch) p.catch((e: unknown) => { Log.debug("audio", "context suspend on hide rejected:", e); });
        }
      } catch { /* a context mid-teardown must not break the hide path */ }
    } else {
      if (deviceRebuildPending && !staleStateRebuild(deviceRebuildPending)) requestOutputDeviceRebuild(deviceRebuildPending);
      resumeIfNeeded();
      if (resumeMusic !== null && resumeMusic === soundtrack.musicPlaybackGeneration()) soundtrack.resumeMusic(soundtrack.lastTrack());
      if (resumeEngine !== null && resumeEngine === engineActionGeneration) startEngineGraph();
      if (resumeRain) startRain();
      resumeMusic = resumeEngine = null; resumeRain = false;
    }
  }

  // A LEVEL CHANGE IS A GLIDE, NOT A STEP (engine.js:875-889).
  const LEVEL_TAU = 0.02;
  function glideLevel(param: AudioParam | null, v: number): void {
    if (!param || !ctx) return;
    const t = ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setTargetAtTime(v, t, LEVEL_TAU);
  }

  function setEnabled(b: boolean): void {
    isEnabled = !!b;
    if (master) glideLevel(master.gain, isEnabled ? 0.8 : 0);
  }

  function enabled(): boolean {
    return isEnabled;
  }

  function sfxOk(): boolean {
    return !!ctx && isEnabled && sfxEnabled;
  }

  // THE PITCH CURVE IS A FUNCTION OF RPM ALONE (engine.js:904-921).
  const RATE_IDLE = 0.17, RATE_SPAN = 0.5115;
  function baseRate(revC: number): number { return RATE_IDLE * tune.idle + revC * RATE_SPAN * tune.revRange; }
  // A rate jump at or above this is a gear discontinuity: snap (engine.js:922-931).
  const RATE_SNAP_JUMP = 0.08;
  function snapParam(p: AudioParam, target: number, t: number): void {
    p.cancelScheduledValues(t);
    p.setValueAtTime(target, t);
    tag(p)._apexAimTgt = target;
  }

  function now(): number { return ctx ? ctx.currentTime : 0; }

  let keepFade = false;   // set only by the sample upgrade in setEngine
  function startEngineBody(): void {
    const c = ctx as AudioContext;
    const fBus = focusBus as GainNode, sBus = sfxBus as GainNode;
    if (!keepFade) flushDying();
    if (sfxOk()) noisePool();   // existing one-shot buffer, prepared before green

    // shared lowpass + master gain for the engine core (samples or synth)
    const eFilter = engFilter = c.createBiquadFilter();
    const eGain = engGain = c.createGain();
    // Rev-limiter gate: a 13 Hz square into engGain.gain, limRate folded in here (engine.js:948-958).
    const lOsc = limOsc = c.createOscillator(); lOsc.type = "square";
    lOsc.frequency.value = 13 * (tune.limRate != null ? tune.limRate : 1);
    const lGain = limGain = c.createGain(); lGain.gain.value = 0;
    lOsc.connect(lGain).connect(eGain.gain);
    // The cut's PITCH SAG: the same square, in cents, into the core's detune.
    const lPitch = limPitch = c.createGain(); lPitch.gain.value = 0;
    lOsc.connect(lPitch);
    lOsc.start();
    // GRAVEL: crank-rate AM into engGain.gain (engine.js:965-978).
    const gOsc = gravOsc = c.createOscillator(); gOsc.type = "sine"; gOsc.frequency.value = 40;
    const gGain = gravGain = c.createGain(); gGain.gain.value = 0;
    gOsc.connect(gGain).connect(eGain.gain);
    gOsc.start();
    // PIT LIMITER: an 11 Hz square into engGain.gain.
    const pOsc = pitLimOsc = c.createOscillator(); pOsc.type = "square"; pOsc.frequency.value = 11;
    const pGain = pitLimGain = c.createGain(); pGain.gain.value = 0;
    pOsc.connect(pGain).connect(eGain.gain);
    pOsc.start();
    // Hybrid harvest clip / part-throttle ICE: a faster, shallower chop.
    const cOsc = cylCutOsc = c.createOscillator(); cOsc.type = "square"; cOsc.frequency.value = 24;
    const cGain = cylCutGain = c.createGain(); cGain.gain.value = 0;
    cOsc.connect(cGain).connect(eGain.gain);
    cOsc.start();
    eFilter.type = "lowpass";
    eFilter.frequency.value = 600;
    eGain.gain.value = 0;

    // REV TILT: a high shelf that lifts as the ratio falls (engine.js:996-1010).
    const tEq = tiltEq = c.createBiquadFilter();
    tEq.type = "highshelf";
    tEq.frequency.value = 1400;
    tEq.gain.value = 0;

    if (voice.formantGain > 0) {
      const vf = voiceFormant = c.createBiquadFilter();
      vf.type = "peaking";
      vf.frequency.value = voice.formantHz;
      vf.Q.value = 1.1;
      vf.gain.value = voice.formantGain;
      eFilter.connect(vf).connect(tEq).connect(eGain).connect(fBus);
    } else {
      voiceFormant = null;
      eFilter.connect(tEq).connect(eGain).connect(fBus);
    }

    usingSamples = !!(samplesReady && engBuf);
    engA = engB = engC = null;
    engSrcIdle = engGainIdle = null;
    idleGainRamped = false;   // new gain node, so the fade-in must happen again
    rateFresh = false;
    let idleSrc: AudioBufferSourceNode | null = null;
    if (usingSamples) {
      const li = engLoop as LoopSpan;
      const src = idleSrc = engSrcIdle = c.createBufferSource(); src.buffer = engBuf; src.loop = true;
      // Voice detune + the player's detune trim, folded in at start (engine.js:1036-1041).
      src.detune.value = sampleDetuneCents();
      // Seed the rate so the first audible frame is already in-family (engine.js:1042-1053).
      const seedRate = lastRate > 0.02
        ? lastRate
        : RATE_IDLE * tune.idle * voice.rateTrim * tune.pitch;
      src.playbackRate.value = seedRate;
      tag(src.playbackRate)._apexAimTgt = seedRate;
      src.loopStart = li.start; src.loopEnd = li.end;
      const gi = engGainIdle = c.createGain();
      if (lastRate > 0.02) { gi.gain.value = 0.9; idleGainRamped = true; }
      else gi.gain.value = 0;
      src.connect(gi).connect(eFilter);
      rateFresh = true;   // first setEngine snaps to the live rate
    } else {
      // synth fallback: two detuned saws + a square
      const a = engA = c.createOscillator();
      const b = engB = c.createOscillator();
      const s = engC = c.createOscillator();
      a.type = "sawtooth";
      b.type = "sawtooth";
      s.type = "square";
      a.frequency.value = 70;
      b.frequency.value = 70.7;
      s.frequency.value = 35;
      a.connect(eFilter);
      b.connect(eFilter);
      const sub = c.createGain();
      sub.gain.value = voice.subLvl * tune.sub;   // same restart reason as detune above
      s.connect(sub).connect(eFilter);
      tag(s)._apexSubGain = sub;
    }

    // SUB-OCTAVE under the recording's own fundamental, sample core only (engine.js:1083-1099).
    if (usingSamples) {
      const so = subOctOsc = c.createOscillator();
      const sg = subOctGain = c.createGain();
      so.type = "sine";
      so.frequency.value = 60;
      sg.gain.value = 0;
      so.connect(sg).connect(fBus);
    }

    // REVERB SEND, never on a phone (engine.js:1101-1117).
    if (c.createConvolver && !lowPower()) {
      const conv = convolver = c.createConvolver();
      const rs = revSend = c.createGain(); rs.gain.value = 1;
      const rr = revReturn = c.createGain(); rr.gain.value = 0;
      rs.connect(conv).connect(rr).connect(fBus);
      eGain.connect(rs);
      applyVenue();
    }

    // Rival voices on whichever core is running (engine.js:1119-1194).
    rivalPeak = usingSamples ? 0.28 : 0.055;
    RIVAL_VOICES = lowPower() ? RIVAL_VOICES_MOBILE : RIVAL_VOICES_DESKTOP;
    rivalVoices = [];
    _rivalRevSm.length = 0;
    _rivalRevSmT = 0;
    if (c.createStereoPanner) {
      for (let i = 0; i < RIVAL_VOICES; i++) {
        const filt = c.createBiquadFilter();
        filt.type = "lowpass"; filt.frequency.value = 2000;
        const gain = c.createGain(); gain.gain.value = 0;
        const pan = c.createStereoPanner(); pan.pan.value = 0;
        filt.connect(gain).connect(pan).connect(fBus);
        if (revSend) pan.connect(revSend);   // a rival in a tunnel echoes too
        let v: RivalVoice;
        const detune = RIVAL_DETUNE[i % RIVAL_DETUNE.length] as number;
        if (usingSamples) {
          const src = c.createBufferSource();
          src.buffer = engBuf; src.loop = true;
          const li = engLoop as LoopSpan;
          src.loopStart = li.start; src.loopEnd = li.end;
          src.playbackRate.value = 0.4;
          src.connect(filt);
          // Each voice starts a different fraction into the loop: decorrelated from the first sample.
          const off = li.start + (li.end - li.start) * (i / RIVAL_VOICES);
          v = {
            filt, gain, pan, detune, src, oscs: null,
            start: () => src.start(0, off),
            stop: (t) => src.stop(t),
            setPitch: (t, rev01, mul) => {
              // mul carries Doppler, the slot's detune and THEIR maker's trim.
              const rate = baseRate(Math.pow(rev01, tune.curve)) * tune.pitch * mul;
              const tg = tag(src.playbackRate);
              if (Math.abs((tg._apexRate ?? -1) - rate) > 0.002) {
                src.playbackRate.setTargetAtTime(rate, t, 0.06);
                tg._apexRate = rate;
              }
            },
          };
        } else {
          // Two saws a hair apart — the player's fallback shape.
          const a = c.createOscillator(), b = c.createOscillator();
          a.type = "sawtooth"; b.type = "sawtooth";
          a.frequency.value = 160; b.frequency.value = 160;
          b.detune.value = 14;                 // ~1.008x, the fallback's spread
          a.connect(filt); b.connect(filt);
          v = {
            filt, gain, pan, detune, src: null, oscs: [a, b],
            start: () => { a.start(); b.start(); },
            stop: (t) => { a.stop(t); b.stop(t); },
            setPitch: (t, rev01, mul) => {
              // No gear for someone else's car: the unknown-gear defaults (95 Hz idle, 700 Hz span).
              const f = (95 + rev01 * 700) * mul;
              const tg = tag(a.frequency);
              if (Math.abs((tg._apexHz ?? -1) - f) > 0.5) {
                a.frequency.setTargetAtTime(f, t, 0.06);
                b.frequency.setTargetAtTime(f, t, 0.06);
                tg._apexHz = f;
              }
            },
          };
        }
        rivalVoices.push(v);
      }
    }

    // turbo whine: faint high sine riding above the core
    const wOsc = whineOsc = c.createOscillator();
    const wGain = whineGain = c.createGain();
    wOsc.type = "sine";
    wOsc.frequency.value = 1500;
    wGain.gain.value = 0;
    wOsc.connect(wGain).connect(fBus);

    // MGU-K harvest whirr: resonant noise, gated in by deceleration
    const hSrc = harvSrc = c.createBufferSource();
    hSrc.buffer = loopNoise("harvest", 0.7);
    hSrc.loop = true;
    const hFilter = harvFilter = c.createBiquadFilter();
    hFilter.type = "bandpass";
    hFilter.frequency.value = 900;
    hFilter.Q.value = 6;
    const hGain = harvGain = c.createGain();
    hGain.gain.value = 0;
    hSrc.connect(hFilter).connect(hGain).connect(fBus);

    // ERS deploy whine (legacy; muted while the ErsLayer runs).
    const eOsc = ersOsc = c.createOscillator();
    const eHp = ersHp = c.createBiquadFilter();
    const eG = ersGain = c.createGain();
    eOsc.type = "sine";
    eOsc.frequency.value = 720;
    eHp.type = "lowpass";
    eHp.frequency.value = 1800;
    eHp.Q.value = 0.5;
    eG.gain.value = 0;
    eOsc.connect(eHp).connect(eG).connect(fBus);

    // offroad wobble: 8 Hz LFO into oscillator detune (cents)
    const lf = lfo = c.createOscillator();
    const lfG = lfoG = c.createGain();
    lf.type = "sine";
    lf.frequency.value = 8;
    lfG.gain.value = 0;
    lf.connect(lfG);
    if (usingSamples && idleSrc) {
      lfG.connect(idleSrc.detune);
      lPitch.connect(idleSrc.detune);
    } else if (engA && engB && engC) {
      lfG.connect(engA.detune);
      lfG.connect(engB.detune);
      lfG.connect(engC.detune);
      lPitch.connect(engA.detune);
      lPitch.connect(engB.detune);
      lPitch.connect(engC.detune);
    }

    // tire screech: looped noise through a bandpass, silent until setSkid
    const kSrc = skidSrc = c.createBufferSource();
    kSrc.buffer = loopNoise("skid", 0.5);
    kSrc.loop = true;
    const kFilter = skidFilter = c.createBiquadFilter();
    kFilter.type = "bandpass";
    kFilter.frequency.value = 900;
    kFilter.Q.value = 1.4;
    const kGain = skidGain = c.createGain();
    kGain.gain.value = 0;
    kSrc.connect(kFilter).connect(kGain).connect(sBus);
    // ~4.8 Hz centre wobble on the audio thread (engine.js:1259-1266).
    const kLfo = skidLfo = c.createOscillator();
    kLfo.type = "sine";
    kLfo.frequency.value = 30 / (2 * Math.PI);
    const kLfoGain = skidLfoGain = c.createGain();
    kLfoGain.gain.value = 0;
    kLfo.connect(kLfoGain).connect(kFilter.frequency);

    // CAR SFX: scrub and lock share one noise loop; surface its own (engine.js:1268-1289).
    const scSrc = scrubSrc = c.createBufferSource();
    scSrc.buffer = loopNoise("scrub", 0.5);
    scSrc.loop = true;
    const scFilter = scrubFilter = c.createBiquadFilter();
    scFilter.type = "bandpass"; scFilter.frequency.value = 520; scFilter.Q.value = 0.9;
    const scGain = scrubGain = c.createGain(); scGain.gain.value = 0;
    const lkFilter = lockFilter = c.createBiquadFilter();
    lkFilter.type = "bandpass"; lkFilter.frequency.value = 1900; lkFilter.Q.value = 7;
    const lkGain = lockGain = c.createGain(); lkGain.gain.value = 0;
    scSrc.connect(scFilter).connect(scGain).connect(sBus);
    scSrc.connect(lkFilter).connect(lkGain).connect(sBus);
    const suSrc = surfSrc = c.createBufferSource();
    suSrc.buffer = loopNoise("surface", 0.5);
    suSrc.loop = true;
    const suFilter = surfFilter = c.createBiquadFilter();
    suFilter.type = "lowpass"; suFilter.frequency.value = 180; suFilter.Q.value = 0.7;
    const suGain = surfGain = c.createGain(); suGain.gain.value = 0;
    suSrc.connect(suFilter).connect(suGain).connect(sBus);

    // KERB RUMBLE: speed-keyed loop that owns rumble() while onKerb (engine.js:1291-1302).
    const kbSrc = kerbSrc = c.createBufferSource();
    kbSrc.buffer = loopNoise("kerb", 0.45);
    kbSrc.loop = true;
    kbSrc.playbackRate.value = 0.85;
    const kbFilter = kerbFilter = c.createBiquadFilter();
    kbFilter.type = "bandpass"; kbFilter.frequency.value = 320; kbFilter.Q.value = 0.85;
    const kbGain = kerbGain = c.createGain(); kbGain.gain.value = 0;
    kbSrc.connect(kbFilter).connect(kbGain).connect(sBus);

    // WET TYRE SPRAY: gain ~ speed², never a pitch trim (engine.js:1304-1313).
    const spSrc = spraySrc = c.createBufferSource();
    spSrc.buffer = loopNoise("spray", 0.55);
    spSrc.loop = true;
    const spFilter = sprayFilter = c.createBiquadFilter();
    spFilter.type = "bandpass"; spFilter.frequency.value = 2200; spFilter.Q.value = 0.7;
    const spGain = sprayGain = c.createGain(); spGain.gain.value = 0;
    spSrc.connect(spFilter).connect(spGain).connect(sBus);

    // AIRFLOW: broadband noise through a bandpass that opens with speed.
    const wiSrc = windSrc = c.createBufferSource();
    wiSrc.buffer = loopNoise("wind", 0.5);
    wiSrc.loop = true;
    const wiFilter = windFilter = c.createBiquadFilter();
    wiFilter.type = "bandpass";
    wiFilter.frequency.value = 450;
    wiFilter.Q.value = 0.7;                 // wide: air, not a whistle
    const wiGain = windGain = c.createGain();
    wiGain.gain.value = 0;
    wiSrc.connect(wiFilter).connect(wiGain).connect(sBus);

    // BRAKES: carbon-disc roar that gain-follows deceleration (engine.js:1331-1346).
    const bSrc = brakeSrc = c.createBufferSource();
    bSrc.buffer = loopNoise("brakes", 0.6);
    bSrc.loop = true;
    const bFilter = brakeFilter = c.createBiquadFilter();
    bFilter.type = "bandpass";
    bFilter.frequency.value = 900;
    bFilter.Q.value = 0.9;
    const bGain = brakeGain = c.createGain();
    bGain.gain.value = 0;
    bSrc.connect(bFilter).connect(bGain).connect(sBus);

    if (usingSamples && idleSrc) idleSrc.start(0, idleSrc.loopStart);
    else if (engA && engB && engC) { engA.start(); engB.start(); engC.start(); }
    wOsc.start();
    if (subOctOsc) subOctOsc.start();
    for (const v of rivalVoices) v.start();
    hSrc.start();
    eOsc.start();
    lf.start();
    kLfo.start();
    kSrc.start();
    scSrc.start();
    suSrc.start();
    kbSrc.start();
    spSrc.start();
    wiSrc.start();
    bSrc.start();
    // FIELD CONTACT pool: osc + filter + gain + panner, mobile 2 / desktop 3 (engine.js:1364-1384).
    contactVoices = [];
    _contactCdN = 0;
    contactFired = contactDeniedCd = contactDeniedCap = contactDeniedGate = 0;
    if (c.createStereoPanner && sfxOk()) {
      const nContact = lowPower() ? CONTACT_VOICES_MOBILE : CONTACT_VOICES_DESKTOP;
      for (let ci = 0; ci < nContact; ci++) {
        const co = c.createOscillator();
        co.type = "sawtooth"; co.frequency.value = 120;
        const cf = c.createBiquadFilter();
        cf.type = "bandpass"; cf.frequency.value = 900; cf.Q.value = 1.2;
        const cg = c.createGain(); cg.gain.value = 0;
        const cp = c.createStereoPanner(); cp.pan.value = 0;
        co.connect(cf).connect(cg).connect(cp).connect(sBus);
        contactVoices.push({ osc: co, filt: cf, gain: cg, pan: cp, freeAt: 0 });
        co.start(0);
      }
    }

    lastSpeed = 0;
    lastEngT = 0;
    harvLevel = 0; harvBrakeLevel = 0; harvCoastLevel = 0;
    shiftDuck = 0;
    shiftDuckT = 0;
    pullT = 0;
    overrunT = 0;   // an AudioContext stamp: a rebuilt ctx restarts near 0
  }
  // THE FLAG GATES ITS OWN TEARDOWN: arm first, tear down a partial build (engine.js:1395-1421).
  function startEngine(): void {
    ++engineActionGeneration; resumeEngine = null;
    startEngineGraph();
  }
  function startEngineGraph(): void {
    if (!ctx || engineOn) return;
    engineOn = true;
    try { startEngineBody(); }
    catch (e) { try { stopEngine(); } catch { /* teardown of a half-graph */ } engineOn = false; throw e; }
  }

  function stopEngine(): void {
    ++engineActionGeneration; resumeEngine = null;
    stopEngineGraph();
  }
  function stopEngineGraph(): void {
    if (!engineOn) return;
    const t0 = now();
    soundtrack.releaseEngineDuck(t0, true);   // a line still on air keeps its own duck
    // Every node is guarded: this runs on a HALF-built graph too (engine.js:1431-1433).
    if (engGain) { engGain.gain.cancelScheduledValues(t0); engGain.gain.setTargetAtTime(0, t0, 0.06); }
    if (whineGain) whineGain.gain.setTargetAtTime(0, t0, 0.06);
    if (harvGain) harvGain.gain.setTargetAtTime(0, t0, 0.06);
    if (ersGain) ersGain.gain.setTargetAtTime(0, t0, 0.04);
    ers.silence(t0);
    if (rivalPassBy) rivalPassBy.silence(t0);   // pass-by whoosh (#2187)
    if (windGain) windGain.gain.setTargetAtTime(0, t0, 0.06);
    if (skidGain) skidGain.gain.setTargetAtTime(0, t0, 0.04);
    if (scrubGain) scrubGain.gain.setTargetAtTime(0, t0, 0.04);
    if (lockGain) lockGain.gain.setTargetAtTime(0, t0, 0.04);
    if (surfGain) surfGain.gain.setTargetAtTime(0, t0, 0.06);
    if (kerbGain) kerbGain.gain.setTargetAtTime(0, t0, 0.06);
    if (sprayGain) sprayGain.gain.setTargetAtTime(0, t0, 0.06);
    if (brakeGain) brakeGain.gain.setTargetAtTime(0, t0, 0.06);
    kerbLive = false;
    sprayAhead = 0;
    const stopAt = (n: AudioScheduledSourceNode | null, t: number): void => { try { if (n) n.stop(t); } catch { /* already stopped */ } };
    if (usingSamples) {
      if (engGainIdle) engGainIdle.gain.setTargetAtTime(0, t0, 0.06);

      stopAt(engSrcIdle, t0 + 0.35);

    } else {
      stopAt(engA, t0 + 0.35); stopAt(engB, t0 + 0.35); stopAt(engC, t0 + 0.35);
    }
    const deadIdleGain = engGainIdle;
    engSrcIdle = engGainIdle = null;
    if (limGain) limGain.gain.setTargetAtTime(0, t0, 0.02);
    const deadLimGain = limGain;
    if (limPitch) limPitch.gain.setTargetAtTime(0, t0, 0.02);
    const deadLimPitch = limPitch;
    if (limOsc) { stopAt(limOsc, t0 + 0.35); limOsc = null; limGain = null; limPitch = null; }
    // gravGain feeds an AudioParam: invisible to a graph walk, buried by name.
    if (gravGain) gravGain.gain.setTargetAtTime(0, t0, 0.02);
    const deadGravGain = gravGain;
    if (gravOsc) { stopAt(gravOsc, t0 + 0.35); gravOsc = null; gravGain = null; }
    if (pitLimGain) pitLimGain.gain.setTargetAtTime(0, t0, 0.02);
    const deadPitLim = pitLimGain;
    if (pitLimOsc) { stopAt(pitLimOsc, t0 + 0.35); pitLimOsc = null; pitLimGain = null; }
    if (cylCutGain) cylCutGain.gain.setTargetAtTime(0, t0, 0.02);
    const deadCylCut = cylCutGain;
    if (cylCutOsc) { stopAt(cylCutOsc, t0 + 0.35); cylCutOsc = null; cylCutGain = null; }
    stopAt(scrubSrc, t0 + 0.35);
    stopAt(surfSrc, t0 + 0.35);
    stopAt(kerbSrc, t0 + 0.35);
    stopAt(spraySrc, t0 + 0.35);
    scrubSrc = surfSrc = kerbSrc = spraySrc = null;
    stopAt(brakeSrc, t0 + 0.35);
    stopAt(whineOsc, t0 + 0.35);
    stopAt(subOctOsc, t0 + 0.35);
    for (const v of rivalVoices) { try { v.gain.gain.setTargetAtTime(0, t0, 0.06); v.stop(t0 + 0.35); } catch { /* already stopped */ } }
    for (const v of contactVoices) {
      try { v.gain.gain.setTargetAtTime(0, t0, 0.04); stopAt(v.osc, t0 + 0.35); } catch { /* already stopped */ }
    }
    stopAt(harvSrc, t0 + 0.35);
    stopAt(ersOsc, t0 + 0.35);
    stopAt(windSrc, t0 + 0.35);
    stopAt(lfo, t0 + 0.35);
    stopAt(skidSrc, t0 + 0.35);
    // A started, never-stopped oscillator stays in the active-source set (engine.js:1494-1496).
    stopAt(skidLfo, t0 + 0.35);
    const deadSub = (engC && tag(engC)._apexSubGain) || null;   // synth sub-osc gain
    engA = engB = engC = null;
    whineOsc = null;
    harvSrc = null;
    ersOsc = null;
    windSrc = null;
    brakeSrc = null;
    lfo = null;
    skidSrc = null;
    if (dbgAnalyser) { try { dbgAnalyser.disconnect(); } catch { /* torn down already */ } dbgAnalyser = null; }
    // Tear the faded chain out once the 0.35 s stops complete (engine.js:1509-1528).
    const dead: (AudioNode | null)[] = [engFilter, engGain, tiltEq, whineGain, harvFilter, harvGain, skidFilter, skidGain, skidLfo, skidLfoGain, lfoG,
                  voiceFormant, ersHp, ersGain, windFilter, windGain, deadSub, subOctGain,
                  deadIdleGain, deadLimGain, deadLimPitch, deadGravGain, brakeFilter, brakeGain,
                  revSend, convolver, revReturn, deadPitLim, deadCylCut, scrubFilter, scrubGain, lockFilter, lockGain,
                  surfFilter, surfGain, kerbFilter, kerbGain, sprayFilter, sprayGain];
    for (const v of rivalVoices) { dead.push(v.filt, v.gain, v.pan); }
    for (const v of contactVoices) { dead.push(v.filt, v.gain, v.pan); }
    queueDying(dead);
    engFilter = engGain = whineGain = harvFilter = harvGain = skidFilter = skidGain = skidLfoGain = lfoG = null;
    skidLfo = null;
    voiceFormant = ersHp = ersGain = windFilter = windGain = tiltEq = null;
    brakeFilter = brakeGain = null;
    scrubFilter = scrubGain = lockFilter = lockGain = surfFilter = surfGain = null;
    kerbFilter = kerbGain = sprayFilter = sprayGain = null;
    revFlare = 0; pitLimLvl = 0;
    subOctOsc = subOctGain = null;
    convolver = revSend = revReturn = null;
    rivalVoices = [];
    contactVoices = [];
    fieldArmed = false;
    _contactCdN = 0;
    idleGainRamped = false;
    rateFresh = false;
    lastGearSeen = NaN;
    engineOn = false;
  }

  function setEngine(rev01: number, boost01: number | boolean, offroad: boolean | undefined, speed01: number | undefined, gear: number | undefined, physics?: EnginePhysics | null): void {
    if (!engineOn || !sfxOk()) {
      // SFX off: continuous kerb must not keep rumble() muted after the bus is silent.
      if (!sfxOk()) kerbLive = false;
      return;
    }
    // UPGRADE TO THE SAMPLES WHEN THEY LAND: one crossfade, never a per-frame flip (engine.js:1553-1564).
    if (samplesReady && engBuf && !usingSamples) {
      stopEngineGraph();
      keepFade = true;
      try { startEngineGraph(); } finally { keepFade = false; }
    }
    const c = ctx as AudioContext;
    const eFilter = engFilter as BiquadFilterNode, eGain = engGain as GainNode;
    const rev = clamp01(rev01 || 0);
    const s = clamp01(typeof speed01 === "number" ? speed01 : (rev01 || 0));
    const b = clamp01(typeof boost01 === "number" ? boost01 : (boost01 ? 1 : 0));
    const t = c.currentTime;

    // Physics extras; neutral when absent (engine.js:1570-1590).
    const ph: EnginePhysics = physics || {};
    const slip01 = clamp01(1 - (ph.slip != null ? ph.slip : 1)); // 0=grip 1=full slide
    // BRAKING against the model's own full pedal, PhysicsConsts.BRAKE (absolute; does not ride PACE).
    const brakeFull = PHYS.BRAKE || 22;
    const onBrakes = ph.brake != null ? ph.brake > 0.08 : -(ph.ax || 0) > brakeFull * 0.5;
    const brakeFrac = onBrakes ? clamp01(-(ph.ax || 0) / brakeFull) : 0;
    // PULLING on the STANDARD scale (aStd(ax)).
    const pull = Math.max(0, ph.axStd != null ? ph.axStd : (ph.ax || 0));
    const onKerb = !!ph.onKerb;
    const wet = !!ph.wet;
    const thr = clamp01(ph.throttle != null ? ph.throttle : 1);

    let g01 = 0.3, gIdle = 95, gSpan = 700;
    if (typeof gear === "number" && isFinite(gear)) {
      const gi = Math.max(1, Math.min(8, Math.round(gear)));
      g01 = (gi - 1) / 7;
      gIdle = 130 - g01 * 70;             // 130 Hz (1st) -> 60 Hz (8th)
      gSpan = 900 - g01 * 460;            // span 900 (1st) -> 440 (8th)
    }

    // transient gain dip from a recent gear shift (rev-cut), decays ~120 ms
    if (shiftDuck > 0.0001) {
      const sd = shiftDuckT ? Math.max(0, t - shiftDuckT) : 0;
      shiftDuck = shiftDuck * Math.exp(-sd / 0.12);
      shiftDuckT = t;
      if (shiftDuck < 0.0001) shiftDuck = 0;
    }
    // Downshift throttle blip: an overshoot that dies over ~90 ms.
    if (revFlare > 0.0001) {
      const fd = revFlareT ? Math.max(0, t - revFlareT) : 0;
      revFlare = revFlare * Math.exp(-fd / 0.09);
      revFlareT = t;
      if (revFlare < 0.0001) revFlare = 0;
    }

    // The pitch curve's rev term, bent by CURVE.
    const revC = Math.pow(rev, tune.curve);
    let f0 = 0;   // the core's live fundamental, Hz
    {
      const g = (typeof gear === "number" && isFinite(gear)) ? Math.max(1, Math.min(8, Math.round(gear))) : 8;
      const rate = baseRate(revC) * (1 + 0.04 * b * tune.boostPitch) * voice.rateTrim * tune.pitch * (1 + 0.05 * revFlare);   // idle ~0.14x .. limiter ~0.71x
      const gearChanged = typeof gear === "number" && isFinite(gear) && isFinite(lastGearSeen) && g !== lastGearSeen;
      if (usingSamples && engSrcIdle) {
        lastRate = rate;
        const cur = engSrcIdle.playbackRate.value;
        // Snap across discontinuities; steady climbs use aimParam (engine.js:1635-1643).
        if (rateFresh || gearChanged || Math.abs(rate - cur) >= RATE_SNAP_JUMP) {
          snapParam(engSrcIdle.playbackRate, rate, t);
        } else {
          aimParam(engSrcIdle.playbackRate, rate, t, 0.035, 1e-4);
        }
        rateFresh = false;
        f0 = enginePeriod > 1 ? (c.sampleRate * rate) / enginePeriod : 0;
        // The voice's one-time fade-in (engine.js:1652-1655).
        if (!idleGainRamped && engGainIdle) { engGainIdle.gain.setTargetAtTime(0.9, t, 0.05); idleGainRamped = true; }
      } else if (engA && engB && engC) {
        // synth fallback: detuned saws + sub follow the per-gear frequency.
        lastRate = rate;
        const base = (gIdle * tune.idle + revC * gSpan * tune.revRange) * (1 + 0.12 * b * tune.boostPitch) * voice.rateTrim * tune.pitch;
        if (gearChanged) {
          snapParam(engA.frequency, base * 0.994, t);
          snapParam(engB.frequency, base * (1 + (voice.synthSpread - 1) * tune.detune), t);
          snapParam(engC.frequency, base * 0.5, t);
        } else {
          aimParam(engA.frequency, base * 0.994, t, 0.025, 1e-4);
          aimParam(engB.frequency, base * (1 + (voice.synthSpread - 1) * tune.detune), t, 0.025, 1e-4);
          aimParam(engC.frequency, base * 0.5, t, 0.025, 1e-4);
        }
        f0 = base;
      }
      if (typeof gear === "number" && isFinite(gear)) lastGearSeen = g;
    }

    // Engine load from traction loss, braking and kerbs (engine.js:1676-1688).
    const slipLoad  = slip01 * 0.12;          // up to +12% filter open under slide
    const brakeLoad = brakeFrac * 0.08;        // up to +8% under hard braking
    const kerbLoad  = onKerb ? 0.04 : 0;      // small gain bump over a kerb
    const loadLift  = clamp01(pull / (PHYS.ACCEL || 7));
    // OVERRUN TIMBRE (continuous): a lift at speed closes the lowpass (engine.js:1689-1698).
    const lifting = rev > 0.35 && s > 0.12 && (ph.ax || 0) < -0.5 && !onBrakes;
    const overrunAmt = (lifting && layers.overrun)
      ? clamp01(-(ph.ax || 0) / 10) * Math.min(1, tune.overrun)
      : 0;
    // Explicit throttle only: absent thr must not brighten every legacy feed.
    const thrOpen = (ph.throttle != null && !lifting && thr > 0.12)
      ? clamp01((thr - 0.12) / 0.88) : 0;

    // The FINAL cutoff stays just under Nyquist (engine.js:1705-1715).
    const ceil = c.sampleRate * 0.45;
    const cut = Math.min(ceil, (usingSamples
      ? Math.min(11000, 2600 + s * 5800 + rev * 2400 + b * 1500 + slipLoad * 2000 + brakeLoad * 1200)
      : Math.min(7200,  600  + s * 4200 + rev * 700  + b * 1400 + slipLoad * 1000 + brakeLoad * 600))
      * voice.cutTrim * tune.brightness * (1 + 0.22 * loadLift) * (1 + 0.10 * thrOpen) * (1 - 0.22 * overrunAmt));
    aimParam(eFilter.frequency, cut * camMix.cut, t, 0.05, 1e-4);
    // Compensate the tape-speed tilt (engine.js:1717-1728).
    if (tiltEq && lastRate > 0.02) {
      const want = Math.min(12, Math.max(0, -12 * Math.log10(lastRate)) * 0.75 * tune.brightness);
      const tg = tag(tiltEq.gain);
      if (Math.abs((tg._apexTilt ?? -99) - want) > 0.05) {
        tiltEq.gain.setTargetAtTime(want, t, 0.08);
        tg._apexTilt = want;
      }
    }
    const lvl = (usingSamples
      ? (0.3 + s * 0.3 + rev * 0.08 + b * 0.08 + (offroad ? 0.03 : 0) + slipLoad * 0.8 + kerbLoad)
      : (0.05 + s * 0.05 + rev * 0.02 + b * 0.025 + (offroad ? 0.012 : 0) + slipLoad * 0.2 + kerbLoad * 0.3))
      * (1 + 0.08 * loadLift) * (1 - 0.08 * overrunAmt);
    // REV LIMITER above 98.5%: the "shift now" chop (engine.js:1733-1741).
    const limOn = layers.limiter && rev > 0.985 && s > 0.05;
    const topGear = typeof gear === "number" && gear >= (PHYS.GEARS || 8);
    if (limOn && topGear) { if (limSince == null) limSince = t; } else limSince = null;
    const limFade = limSince == null ? 1 : clamp01(1 - (t - limSince - LIM_HOLD) / LIM_FADE);
    // CAPPED AT HALF THE LEVEL: past it the chop inverts phase (engine.js:1742-1748).
    const limDepth = limOn ? Math.min(lvl * 0.5, lvl * 0.45 * tune.limiter) * limFade : 0;
    const mult = (1 - 0.55 * shiftDuck) * camMix.engine;
    const limSwing = Math.floor(limDepth * mult * 1e4) / 1e4;   // floor: rounding up would dip the trough below 0
    if (limGain && tag(limGain)._apexLimTgt !== limSwing) {
      limGain.gain.setTargetAtTime(limSwing, t, 0.02);
      tag(limGain)._apexLimTgt = limSwing;
    }
    // The sag: ±limCents around the note, in step with the cut.
    const limCents = limOn ? 30 * tune.limPitch * limFade : 0;
    if (limPitch && tag(limPitch)._apexCents !== limCents) {
      limPitch.gain.setTargetAtTime(limCents, t, 0.02);
      tag(limPitch)._apexCents = limCents;
    }
    // PIT LIMITER: the base comes DOWN by the depth (engine.js:1774-1780).
    const pitDepth = Math.round(pitLimLvl * Math.max(0, Math.min(lvl * 0.22, lvl * 0.5 - limDepth)) * mult * 1000) / 1000;
    if (pitLimGain && tag(pitLimGain)._apexTgt !== pitDepth) { pitLimGain.gain.setTargetAtTime(pitDepth, t, 0.03); tag(pitLimGain)._apexTgt = pitDepth; }
    const engBase = (lvl - limDepth) * mult - pitDepth;
    aimGain(eGain, engBase, t, 0.03);

    // GRAVEL at the crank rate, depth dying as rev² (engine.js:1784-1802).
    if (gravOsc && gravGain) {
      const gravF = Math.max(18, Math.min(140, f0 / 3));
      const tg = tag(gravOsc.frequency);
      if (Math.abs((tg._apexHz ?? -1) - gravF) > 0.5) {
        gravOsc.frequency.setTargetAtTime(gravF, t, 0.05);
        tg._apexHz = gravF;
      }
      const lump = (1 - rev) * (1 - rev);
      const want = layers.gravel ? engBase * 0.55 * lump * tune.gravel : 0;
      aimGain(gravGain, Math.min(want, Math.max(0, engBase - limSwing - pitDepth)), t, 0.05);
    }

    // Turbo / MGU-K whine (engine.js:1804-1811).
    const deploy01 = clamp01(ph.deploy != null ? ph.deploy : b);
    const lowGearFactor = g01 < 0.35 ? 0.85 + g01 * 0.43 : 1;   // compressed range in low gears
    if (whineOsc) aimParam(whineOsc.frequency, (voice.whineHz + rev * 2000 + deploy01 * 700 + s * deploy01 * 900) * lowGearFactor, t, 0.05, 1e-4);
    aimGain(whineGain,
      layers.whine ? (0.004 + rev * 0.013 + deploy01 * 0.011 + b * 0.008) * (s > 0.04 ? 1 : 0) * (usingSamples ? 0.50 : 1)
        * voice.whineLvl * tune.whine * (1 + 0.55 * deploy01 * (0.3 + 0.7 * s)) : 0, t, 0.08);

    // SUB-OCTAVE an octave under the engine's own fundamental (engine.js:1813-1829).
    if (subOctGain && subOctOsc) {
      const f0s = enginePeriod > 1 ? (c.sampleRate * lastRate) / enginePeriod : 0;
      const subF = Math.max(25, Math.min(240, f0s * 0.5));
      if (tag(subOctOsc)._apexSubF !== subF) { subOctOsc.frequency.setTargetAtTime(subF, t, 0.05); tag(subOctOsc)._apexSubF = subF; }
      aimGain(subOctGain, layers.sub
        ? (0.012 + rev * 0.016 + b * 0.006) * (s > 0.04 ? 1 : 0) * voice.subLvl * tune.sub
        : 0, t, 0.08);
    }

    // OVERRUN CRACKLES, irregular on purpose (engine.js:1831-1850).
    if (lifting && layers.overrun) {
      if (t >= overrunT) {
        const rate = 0.055 + 0.10 * (1 - clamp01(-(ph.ax || 0) / 12)) * (1.3 - rev);
        overrunT = t + rate * (0.55 + rand() * 0.9);
        const k = (0.35 + 0.65 * rev) * tune.overrun;
        overrunFired++;
        noise(0.055 * k, 0.045, 2600 + rand() * 2200);
        if (rand() < 0.28) blip(90 + rand() * 50, "square", 0.05 * k, 0.002, 0.05, 55);
      }
    } else if (t > overrunT) {
      overrunT = t;   // do not bank a backlog while on the throttle
    }

    const dt = lastEngT ? Math.max(0.001, t - lastEngT) : 0;
    const brkDem = clamp01(ph.brake != null ? ph.brake : 0);
    const deploy = deploy01;
    const energy = ph.energy != null ? clamp01(ph.energy) : 1;
    let decelTarget = 0;
    if (dt > 0) {
      const decel = (lastSpeed - s) / dt;   // speed01 units shed per second
      decelTarget = clamp01(decel * 5) * Math.min(1, s * 3);
    }
    if (brkDem > 0.08 && s > 0.06) {
      decelTarget = Math.max(decelTarget, clamp01(brkDem * 0.9) * Math.min(1, s * 2.6));
    }
    const coastActive = thr < 0.06 && brkDem < 0.06 && deploy < 0.05 && s > 0.16;
    const regenK = clamp01(ph.regen != null ? ph.regen : 0.55);
    const packFull = energy > 0.97;
    let coastTarget = 0;
    if (coastActive) {
      coastTarget = clamp01((s - 0.14) / 0.86) * regenK;
      if (packFull) coastTarget *= 0.22;
    }
    lastEngT = t;
    lastSpeed = s;
    const harvTau = 0.12;
    harvBrakeLevel += (decelTarget - harvBrakeLevel) * Math.min(1, (dt || 0.016) / harvTau);
    const coastSmooth = coastActive ? harvTau * 1.35 : harvTau * 0.45;
    harvCoastLevel += (coastTarget - harvCoastLevel) * Math.min(1, (dt || 0.016) / coastSmooth);
    const coastW = 0.52;
    harvLevel = harvBrakeLevel + harvCoastLevel * coastW;
    const harvGainScale = usingSamples ? 0.035 : 0.06;
    const coastMix = harvLevel > 1e-6 ? (harvCoastLevel * coastW) / harvLevel : 0;
    // MGU-K harvest: braking decel stays loud; lift-and-coast is softer and brighter.
    aimGain(harvGain, layers.harvest ? harvLevel * harvGainScale * tune.harvest : 0, t, 0.06);
    if (harvFilter) {
      aimParam(harvFilter.frequency, 680 + s * 1500 + coastMix * 420, t, 0.08, 1e-4);
      const htg = tag(harvFilter);
      if (htg._apexQ == null) htg._apexQ = harvFilter.Q.value;
      const harvQ = 6 - coastMix * 2.4;
      if (Math.abs((htg._apexHarvQ ?? -1) - harvQ) > 0.08) {
        aimParam(harvFilter.Q, harvQ, t, 0.12, 0.05);
        htg._apexHarvQ = harvQ;
      }
    }

    // Music sits under the ENGINE: a gentle rev-keyed duck (engine.js:1897-1904).
    soundtrack.duckForEngine(rev, t);
    const partBias = ph.ersDeploy != null ? 0.8 + 0.4 * clamp01(ph.ersDeploy) : 1;
    // Electric MGU-K + boost cue live in the ErsLayer; the legacy ersOsc is muted (engine.js:1907-1931).
    ers.update({
      t, deploy, energy, brake: brkDem, ax: ph.ax || 0, speed: s,
      layerOn: layers.ers, ersOn: ph.ersOn !== false,
      boost: deploy > 0 || !!ph.boostOn || !!ph.otOn, otOn: !!ph.otOn,
      boostTune: tune.boost, partBias,
    });
    // f1-game kept a legacy ersOsc path for when ErsLayer was not loaded
    // (engine.js:1920-1931); here the layer always is, so ersOsc only fades out.
    if (ersGain && tag(ersGain)._apexErsTgt !== 0) {
      ersGain.gain.setTargetAtTime(0, t, 0.10);
      tag(ersGain)._apexErsTgt = 0;
    }

    // Part-throttle ICE harvest and full-pack regen clip: a shallow ignition cut.
    const partThr = thr > 0.1 && thr < 0.72 && deploy < 0.05 && s > 0.08;
    const packClip = packFull && deploy < 0.05 && (coastTarget > 0.04 || decelTarget > 0.08 || brkDem > 0.12);
    const cylOn = layers.ers && (partThr || packClip);
    const cylDepth = cylOn ? Math.min(engBase * 0.07, 0.011) * mult : 0;
    if (cylCutGain && tag(cylCutGain)._apexCylTgt !== cylDepth) {
      cylCutGain.gain.setTargetAtTime(cylDepth, t, 0.04);
      tag(cylCutGain)._apexCylTgt = cylDepth;
    }

    // AIRFLOW, quadratic in opened speed (engine.js:1943-1956).
    const wf = windFromSpeed(s);
    const windOpen = s > WIND_GATE ? 1 : 0;
    const gust = harvLevel;
    const rough = (offroad ? 0.5 : 0) + (onKerb ? 0.35 : 0);
    const tow = clamp01(ph.tow || 0);
    aimGain(windGain,
      layers.wind ? wf.gain * (1 + 0.45 * rough + 0.30 * gust) * (wet ? 1.25 : 1) * (1 - 0.35 * tow) * windOpen * tune.wind * camMix.wind : 0,
      t, 0.10);
    if (windFilter) aimParam(windFilter.frequency, wf.hz + rough * 260, t, 0.12, 1e-4);

    // BRAKES: level follows deceleration and speed (engine.js:1958-1977).
    if (brakeGain && brakeFilter) {
      // `> 0`, not a bare product: clamp01(-(0)/brakeFull) is -0.
      const brk = brakeFrac > 0 ? brakeFrac * Math.min(1, 0.25 + s) : 0;
      aimGain(brakeGain, (layers.brakes && brk > 0) ? brk * (0.020 + 0.050 * s) * (wet ? 0.8 : 1) * tune.brakes : 0, t, 0.06);
      if (brk > 0) {
        const bf = (600 + s * 900 + brakeFrac * 500) * (wet ? 0.85 : 1);
        const tg = tag(brakeFilter.frequency);
        if (Math.abs((tg._apexHz ?? -1) - bf) > 20) {
          brakeFilter.frequency.setTargetAtTime(bf, t, 0.08);
          tg._apexHz = bf;
        }
      }
    }

    // KERB RUMBLE, continuous; mutes the legacy one-shot (engine.js:1979-1995).
    kerbLive = onKerb;
    if (kerbGain) {
      const kerbLvl = onKerb ? (0.010 + 0.070 * s) : 0;
      aimGain(kerbGain, kerbLvl, t, 0.05);
      if (onKerb && kerbSrc && kerbFilter) {
        aimParam(kerbSrc.playbackRate, 0.80 + 1.10 * s, t, 0.06, 1e-4);
        const khz = 260 + 640 * s;
        const tg = tag(kerbFilter.frequency);
        if (Math.abs((tg._apexHz ?? -1) - khz) > 8) {
          kerbFilter.frequency.setTargetAtTime(khz, t, 0.08);
          tg._apexHz = khz;
        }
      }
    }

    // WET TYRE SPRAY, never a pitch trim (engine.js:1997-2011).
    if (sprayGain) {
      const own = wet ? Math.min(0.045, 0.055 * s * s) : 0;
      const wake = wet && layers.rivals ? sprayAhead * 0.018 * Math.min(1, 0.35 + s) * tune.rivals : 0;
      aimGain(sprayGain, own + wake, t, 0.08);
      if ((own + wake) > 0 && sprayFilter) {
        const shz = 1600 + 1400 * s;
        const tg = tag(sprayFilter.frequency);
        if (Math.abs((tg._apexHz ?? -1) - shz) > 20) {
          sprayFilter.frequency.setTargetAtTime(shz, t, 0.12);
          tg._apexHz = shz;
        }
      }
    }

    // WASTEGATE: armed by time under load, fires once per lift (engine.js:2013-2029).
    if (pull > 5 && rev > 0.45) pullT += dt;
    else if (pull < 0.5) {
      if (pullT > 0.5 && layers.whine && s > 0.1) {
        wasteFired++;
        const k = (0.4 + 0.6 * rev) * voice.whineLvl * tune.whine;
        hiss(0.055 * k, 0.16, 3800, 1300);
      }
      pullT = 0;
    }

    // offroad: ~8 Hz pitch wobble via the LFO, guarded on the target (engine.js:2031-2048).
    const lfoTgt = offroad ? 45 : 0;
    if (lfoG && tag(lfoG)._apexLfoTgt !== lfoTgt) {
      lfoG.gain.setTargetAtTime(lfoTgt, t, 0.05);
      tag(lfoG)._apexLfoTgt = lfoTgt;
    }
  }

  // THE GRID IDLES through the lamps (engine.js:2051-2067).
  function setGridIdle(player: EngineCar | null | undefined, gridOpts?: { soundOn?: boolean; step?: boolean; wet?: boolean } | null): void {
    fieldArmed = false;   // countdown: field contact SFX stay silent (intentional)
    const o = gridOpts || {};
    if (!player || o.soundOn === false || o.step === false) return;
    const idle = PHYS.IDLE_RPM || 5000;
    const max = PHYS.MAX_RPM || 15000;
    const rev = clamp01(((player.rpm || idle) - idle) / Math.max(1, max - idle));
    setEngine(rev, 0, false, 0, player.gear, {
      slip: 1, ax: 0, onKerb: false, wet: !!o.wet, tow: 0,
      deploy: 0, energy: player.energy ?? 1, ersDeploy: player.ersDeploy ?? 0.5,
    });
  }

  // INSTANT REPLAY scrub (engine.js:2069-2112).
  let _scrubWas = false;
  let _scrubGear: ((v: number) => number) | null = null, _scrubRpm: ((gear: number, v: number) => number) | null = null;
  const _scrubArg: EnginePhysics = { slip: 1, ax: 0, onKerb: false, wet: false, tow: 0, deploy: 0, energy: 1, ersDeploy: 0, throttle: 0, brake: 0, regen: 0.5 };
  function syncReplayRpms(cars: readonly EngineCar[] | null | undefined): void {
    if (!_scrubGear || !_scrubRpm || !cars) return;
    for (const car of cars) {
      const v = Math.max(0, car.speed || 0);
      car.rpm = _scrubRpm(_scrubGear(v), v);
    }
  }
  function resetReplayScrub(): void { _scrubWas = false; }
  function feedReplayScrub(player: EngineCar | null | false | undefined, scrubbing: boolean, cars: readonly EngineCar[] | null | undefined,
    gearOf: ((v: number) => number) | null | undefined, rpmFor: ((gear: number, v: number) => number) | null | undefined,
    rivalAudio: { collect(p: EngineCar): readonly AudioRivalRow[] } | null | undefined,
    isWet: (() => boolean) | boolean, vTop: (() => number) | number): void {
    if (!player) return;   // SOUND off or no car: leave everything as it is
    if (!scrubbing) {
      if (_scrubWas) {
        stopEngine(); setRivals([]); _scrubWas = false;
        // stopEngine skips an engine already off; the scrub's whoosh must still close (#2187).
        if (rivalPassBy) rivalPassBy.silence();
      }
      return;
    }
    _scrubWas = true;
    if (typeof gearOf === "function" && typeof rpmFor === "function") { _scrubGear = gearOf; _scrubRpm = rpmFor; }
    syncReplayRpms(cars);
    if (!engineOn) startEngine();
    const idle = PHYS.IDLE_RPM || 5000;
    const max = PHYS.MAX_RPM || 15000;
    const revFrac = clamp01(((player.rpm ?? 0) - idle) / Math.max(1, max - idle));
    const gear = _scrubGear ? _scrubGear(Math.max(0, player.speed || 0)) : (player.gear || 1);
    _scrubArg.wet = typeof isWet === "function" ? !!isWet() : !!isWet;
    _scrubArg.energy = player.energy ?? 1; _scrubArg.regen = player.ersRegen ?? 0.5;
    const top = typeof vTop === "function" ? vTop() : vTop;
    setEngine(revFrac, 0, player.offroad, clamp01((player.speed ?? 0) / Math.max(1e-6, top || 0)), gear, _scrubArg);
    if (rivalAudio && rivalAudio.collect) setRivals(rivalAudio.collect(player));
  }

  let rainSrc: AudioBufferSourceNode | null = null, rainGain: GainNode | null = null;
  let rainHp: BiquadFilterNode | null = null, rainLp: BiquadFilterNode | null = null, rainStopping = false;
  let rainPending: number | null = null;
  let rainWanted = false;
  let rainLastGain = 0.065;

  function startRain(gain?: number | null): void {
    // Remember the last requested level for the no-arg restore paths (engine.js:2120-2122).
    const g = gain == null ? rainLastGain : (rainLastGain = gain);
    rainWanted = true;
    if (rainSrc) { if (rainGain) rainGain.gain.setTargetAtTime(g, now(), 0.8); return; }
    if (!sfxOk()) return;
    // A start inside stopRain's teardown is queued, not dropped (engine.js:2127-2132).
    if (rainStopping) { rainPending = g; return; }
    const c = ctx as AudioContext;
    const dur = 4;
    const buf = noiseBuf(dur);
    const src = rainSrc = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const hp = rainHp = c.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2200;
    hp.Q.value = 0.4;
    const lp = rainLp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 8000;
    const rg = rainGain = c.createGain();
    rg.gain.value = 0;
    src.connect(hp).connect(lp).connect(rg).connect(sfxBus as GainNode);
    src.start();
    rg.gain.setTargetAtTime(g, now(), 1.2);
  }

  function stopRain(keepWant?: boolean): void {
    if (!keepWant) rainWanted = false;
    if (!rainSrc) { if (!keepWant) rainPending = null; return; }
    rainPending = null;   // a newer stop cancels a queued restart, wet or dry
    rainStopping = true;
    const s = rainSrc, g = rainGain as GainNode, h = rainHp as BiquadFilterNode, l = rainLp as BiquadFilterNode;
    rainSrc = null; rainGain = null; rainHp = null; rainLp = null;
    try {
      g.gain.setTargetAtTime(0, now(), 0.4);
      setTimeout(() => {
        try { s.stop(); } catch { /* already stopped */ }
        try { s.disconnect(); g.disconnect(); h.disconnect(); l.disconnect(); } catch { /* already disconnected */ }
        rainStopping = false;
        if (rainPending != null) { const pg = rainPending; rainPending = null; startRain(pg); }
      }, 1200);
    } catch { rainStopping = false; rainPending = null; }
  }

  // Tyre squeal from lateral and longitudinal slip (engine.js:2174-2208).
  function setSkid(x: number | SkidExtra, wet?: boolean, extra?: SkidExtra | null): void {
    if (!engineOn || !skidGain || !skidFilter) return;
    let lat: number, long: number;
    if (x && typeof x === "object") {
      wet = x.wet; extra = x;
      lat = x.lat != null ? x.lat : (x.slip || 0);
      long = x.long || 0;
    } else {
      lat = extra && extra.lat != null ? extra.lat : (x || 0);
      long = extra && extra.long != null ? extra.long : 0;
    }
    const q = squealFromSlip(lat, long, wet);
    const sv = layers.screech ? q.gain * tune.screech : 0;
    const stg = tag(skidGain);
    const sp = stg._apexSkidV;
    if (sp !== sv && (sv === 0 || sp === undefined || Math.abs(sp - sv) >= 1e-4)) { glideLevel(skidGain.gain, sv); stg._apexSkidV = sv; }
    const ftg = tag(skidFilter.frequency);
    if (q.lfo > 0) {
      if (Math.abs((ftg._apexSkidBase ?? -1) - q.hz) >= 1) {
        skidFilter.frequency.setTargetAtTime(q.hz, now(), LEVEL_TAU);
        ftg._apexSkidBase = q.hz;
      }
      if (skidLfoGain && (tag(skidLfoGain)._apexDepth ?? 0) !== q.lfo) {
        skidLfoGain.gain.setTargetAtTime(q.lfo, now(), LEVEL_TAU);
        tag(skidLfoGain)._apexDepth = q.lfo;
      }
    } else if (skidLfoGain && (tag(skidLfoGain)._apexDepth ?? 0) !== 0) {
      skidLfoGain.gain.setTargetAtTime(0, now(), LEVEL_TAU);
      tag(skidLfoGain)._apexDepth = 0;
    }
  }

  // CAR SFX, fed once a frame (engine.js:2210-2232).
  function setCarSfx(o: CarSfxLevels | null | undefined): void {
    if (!engineOn || !scrubGain || !surfFilter) return;
    const t = now();
    const scrub = clamp01(o && o.scrub), lock = clamp01(o && o.lock);
    const surf = clamp01(o && o.surface), pit = clamp01(o && o.pitLim);
    const wet = !!(o && o.wet);
    const on = layers.screech ? tune.screech : 0;
    aimGain(scrubGain, scrub * (wet ? 0.035 : 0.06) * on, t, 0.06);
    aimGain(lockGain, lock * (wet ? 0.05 : 0.09) * on, t, 0.03);
    aimGain(surfGain, surf * 0.22, t, 0.08);
    const surfHz = 120 + 160 * surf;   // rescheduled only on a real change
    const tg = tag(surfFilter.frequency);
    if (surf > 0 && Math.abs((tg._apexHz ?? -99) - surfHz) > 2) {
      surfFilter.frequency.setTargetAtTime(surfHz, t, 0.1); tg._apexHz = surfHz; surfSched++;
    }
    // The depth is set in setEngine, against the engine's own base.
    pitLimLvl = layers.limiter === false ? 0 : pit;
    carSfxLast.scrub = scrub; carSfxLast.lock = lock; carSfxLast.surface = surf; carSfxLast.pitLim = pit;
  }

  // Wheel guns: four staggered pneumatic rattles (engine.js:2234-2246).
  function pitGun(tighten?: boolean): void {
    pitGunFired++;
    if (!sfxOk()) return;
    const lag = [0, 0.05, 0.11, 0.08];
    for (let i = 0; i < 4; i++) {
      const w = (lag[i] as number) + rand() * 0.03;
      const n = tighten ? 3 : 4;
      for (let k = 0; k < n; k++) noise(0.07, 0.03, (tighten ? 3200 : 2600) + i * 140, w + k * 0.045);
    }
  }

  // Which way the view is looking, from the camera id; unknown ids read as chase.
  function setCameraMix(id: string): "onboard" | "chase" | "tv" {
    camKind = CAM_KIND[id] || "chase";
    camMix = CAM_MIX[camKind];
    applyVenue();
    return camKind;
  }

  // Gear-shift cue: a quick rev-cut / blip over the running engine (engine.js:2257-2302).
  function shift(up?: boolean): void {
    if (!sfxOk()) return;
    const c = ctx as AudioContext;
    const isUp = up !== false;
    const t0 = now();

    if (engineOn) {
      shiftDuck = isUp ? 1 : 0.7;     // downshift dips a little less (blip)
      shiftDuckT = t0;
      if (!isUp) { revFlare = 1; revFlareT = t0; }   // heel-and-toe: the note flares, then settles
    }

    const osc = c.createOscillator();
    const f = c.createBiquadFilter();
    const g = c.createGain();
    osc.type = "sawtooth";
    f.type = "bandpass";
    f.Q.value = 1.2;
    const dur = isUp ? 0.085 : 0.11;
    // The crack carries the manufacturer's voice: pitch rides rateTrim, brightness cutTrim.
    const f0 = (isUp ? 520 : 300) * voice.rateTrim;
    const f1 = (isUp ? 300 : 360) * voice.rateTrim;     // up: cut down; down: small blip up
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    f.frequency.setValueAtTime((isUp ? 1400 : 900) * voice.cutTrim, t0);
    f.frequency.exponentialRampToValueAtTime((isUp ? 600 : 700) * voice.cutTrim, t0 + dur);
    shiftPeak = (isUp ? 0.12 : 0.1) * tune.shift;
    shiftFired++;
    env(g, t0, Math.max(0.0001, shiftPeak), 0.004, dur);
    osc.connect(f).connect(g).connect(sfxBus as GainNode);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    osc.onended = () => { osc.disconnect(); f.disconnect(); g.disconnect(); };

    // a touch of mechanical click via short filtered noise
    if (tune.shift > 0) noise((isUp ? 0.05 : 0.045) * tune.shift, 0.05, (isUp ? 2600 : 1800) * voice.cutTrim);
  }

  // i 0..4 — each start light a touch higher than the last
  function lightOn(i: number): void {
    const n = Math.max(0, Math.min(4, i | 0));
    blip(440 + n * 80, "square", 0.2, 0.01, 0.14);
  }

  function lightsOut(): void {
    blip(1245, "square", 0.26, 0.01, 0.12);
    blip(1245, "square", 0.24, 0.01, 0.22, null, 0.13);
  }

  function overtakeReady(): void {
    blip(880, "square", 0.16, 0.008, 0.08);
    blip(1109, "square", 0.16, 0.008, 0.14, null, 0.09);
  }

  // Active-aero X-mode latch: a mechanical latch, not an alert (engine.js:2320-2331).
  function xMode(on: boolean): void {
    if (on) {
      blip(740, "triangle", 0.10, 0.006, 0.06);
      blip(988, "triangle", 0.10, 0.006, 0.10, null, 0.07);
    } else {
      blip(988, "triangle", 0.08, 0.006, 0.06);
      blip(740, "triangle", 0.08, 0.006, 0.10, null, 0.07);
    }
  }

  // The circuit's acoustics from its track def (engine.js:2337-2352).
  function setVenue(def: AudioVenue | null | undefined): keyof typeof VENUES {
    const theme = def && typeof def.theme === "string" ? def.theme : "";
    const key: keyof typeof VENUES = (def && def.street) ? "street"
      : theme.indexOf("green") === 0 ? "green"
      : theme.indexOf("desert") === 0 ? "desert"
      : theme.indexOf("street") === 0 ? "street"
      : "modern";
    venueName = key;
    venue = VENUES[key] || VENUES.modern;
    applyVenue();
    return key;
  }

  // An exponentially decaying stereo noise burst, damped by a one-pole lowpass (engine.js:2354-2376).
  function buildIR(v: Venue): AudioBuffer {
    const cached = _irCache.get(venueName);
    if (cached) return cached;
    const c = ctx as AudioContext;
    const sr = c.sampleRate, len = Math.max(1, Math.floor(sr * v.decay));
    const buf = c.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const a = Math.exp((-2 * Math.PI * v.damp) / sr);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        lp = (1 - a) * (rand() * 2 - 1) + a * lp;
        d[i] = lp * Math.pow(1 - i / len, 2.5);
      }
    }
    _irCache.set(venueName, buf);
    return buf;
  }

  function applyVenue(): void {
    if (!ctx || !convolver || !revReturn) return;
    // ASSIGN ONLY ON A REAL CHANGE: a buffer write re-prepares the IR (engine.js:2380-2384).
    const ir = buildIR(venue);
    if (convolver.buffer !== ir) convolver.buffer = ir;
    const wet = layers.reverb ? venue.level * tune.reverb * camMix.reverb : 0;
    revReturn.gain.setTargetAtTime(wet, now(), 0.2);
    // Mute the send when SPACE is off — returning at 0 still fed the convolver.
    if (revSend) revSend.gain.setTargetAtTime(wet > 0 ? 1 : 0, now(), 0.05);
  }

  function setVoice(engineName: string | null | undefined): void {
    const v = engineName != null ? ENGINE_VOICES[engineName] : undefined;
    voice = v || DEFAULT_VOICE;
    voiceName = v && engineName != null ? engineName : "default";
    applyTuneNodes();
  }

  // DETUNE on the sample core, in cents: [0,1] is no offset (engine.js:2399-2409).
  function sampleDetuneCents(): number {
    return voice.detune + Math.max(0, tune.detune - 1) * 30;
  }

  // The tune fields that are NOT per-frame expressions (engine.js:2411-2432).
  function applyTuneNodes(): void {
    if (!ctx) return;
    const t = now();
    if (engSrcIdle && engSrcIdle.detune) engSrcIdle.detune.setTargetAtTime(sampleDetuneCents(), t, 0.05);

    const subGain = engC && tag(engC)._apexSubGain;
    if (subGain) subGain.gain.setTargetAtTime(voice.subLvl * tune.sub, t, 0.05);

    // CHOP RATE, set once per tune change.
    if (limOsc) limOsc.frequency.setTargetAtTime(13 * tune.limRate, t, 0.05);
    applyRivalMix();
    applyVenue();   // the REVERB trim and its layer switch both land here
  }

  // Clamp into TUNE_RANGE and drop anything not in the table (engine.js:2434-2447).
  function setTune(patch: Readonly<Record<string, unknown>> | null | undefined): Tune {
    patchTune(tune, patch);
    profileName = nameForTune(tune, profileName);
    applyTuneNodes();
    return Object.assign({}, tune);
  }

  // A profile REPLACES the trims; "team" restores identity (engine.js:2449-2458).
  function setProfile(name: unknown): SoundProfile {
    const key: SoundProfile = isProfile(name) ? name : "team";
    profileName = key;
    tune = Object.assign({}, TUNE_DEF, SOUND_PROFILES[key] || {});
    applyTuneNodes();
    return key;
  }

  // setRivals(list): the field around you (engine.js:2460-2611).
  const _rivalRow: number[] = [];
  const RIVAL_REV_NET_TAU = 0.048;
  const _rivalRevSm: ({ key: unknown; a: number; b: number } | undefined)[] = [];
  let _rivalRevSmT = 0;
  let _rivalPanExternal: boolean | null = null;
  function rivalPanPlayerFrame(lat: number, arc: number): number {
    return 0.85 * Math.max(-1, Math.min(1, lat / Math.max(3, Math.abs(arc) + 3)));
  }
  function rivalPanFromCamera(basis: AudioListenerBasis, wx: number, wz: number): number {
    const dx = wx - basis.x, dz = wz - basis.z;
    const lat = dx * basis.rightX + dz * basis.rightZ;
    const arc = dx * basis.fwdX + dz * basis.fwdZ;
    return rivalPanPlayerFrame(lat, arc);
  }
  function rivalSmoothedRev(vi: number, raw: number, net: boolean, key: unknown, dt: number): number {
    let s = _rivalRevSm[vi];
    if (!s) s = _rivalRevSm[vi] = { key: null, a: raw, b: raw };
    const k = key != null ? key : vi;
    if (k !== s.key) { s.key = k; s.a = raw; s.b = raw; return raw; }
    if (!net) return raw;
    const alpha = 1 - Math.exp(-dt / RIVAL_REV_NET_TAU);
    s.a += alpha * (raw - s.a);
    s.b += alpha * (s.a - s.b);
    return s.b;
  }
  function setRivals(list: readonly AudioRivalRow[] | null | undefined): void {
    // Spray wake: rival-audio owns the geometry; engine stores the scalar.
    sprayAhead = rivalPassBy ? rivalPassBy.sprayAhead(list) : 0;
    if (!engineOn || !rivalVoices.length) return;
    fieldArmed = true;
    const t = now();
    const dt = _rivalRevSmT > 0 ? Math.min(0.05, t - _rivalRevSmT) : 1 / 60;
    _rivalRevSmT = t;
    const basis = opts.listener ? opts.listener() ?? null : null;
    const panExternal = !!(basis && basis.external);
    if (_rivalPanExternal !== null && panExternal !== _rivalPanExternal) {
      for (let i = 0; i < rivalVoices.length; i++) {
        const rv = rivalVoices[i];
        if (rv && rv.pan && rv.pan.pan) tag(rv.pan.pan)._apexPanTgt = undefined;
      }
    }
    _rivalPanExternal = panExternal;
    const n = layers.rivals && list ? Math.min(list.length, rivalVoices.length) : 0;
    for (let i = 0; i < rivalVoices.length; i++) _rivalRow[i] = -1;
    let unvoiced = 0;
    const rows = list as readonly AudioRivalRow[];
    for (let k = 0; k < n; k++) {
      const sl = (rows[k] as AudioRivalRow).slot;
      const vi = typeof sl === "number" && Number.isInteger(sl) && sl >= 0 && sl < rivalVoices.length && (_rivalRow[sl] as number) < 0 ? sl : k;
      if ((_rivalRow[vi] as number) < 0) _rivalRow[vi] = k; else unvoiced |= 1 << k;
    }
    for (let k = 0, free = 0; unvoiced && k < n; k++) {
      if (!(unvoiced & (1 << k))) continue;
      while ((_rivalRow[free] as number) >= 0) free++;   // n <= voices, so one is free
      _rivalRow[free] = k;
    }
    for (let i = 0; i < rivalVoices.length; i++) {
      const v = rivalVoices[i] as RivalVoice;
      const row = _rivalRow[i] as number;
      if (row < 0) { aimGain(v.gain, 0, t, 0.12); continue; }
      const r = rows[row] as AudioRivalRow;
      const lat = Number(r.lat) || 0, arc = Number(r.arc) || 0;
      const dist = Math.hypot(lat, arc);
      if (!(dist < RIVAL_RANGE)) { aimGain(v.gain, 0, t, 0.12); continue; }

      // PAN by the angle, never fully hard (engine.js:2550-2561).
      let pan: number;
      if (panExternal && basis && r.wx != null && r.wz != null) pan = rivalPanFromCamera(basis, r.wx, r.wz);
      else pan = rivalPanPlayerFrame(lat, arc);
      const ptg = tag(v.pan.pan);
      const _pp = ptg._apexPanTgt;
      if (_pp === undefined || Math.abs(_pp - pan) >= 0.004) {
        v.pan.pan.setTargetAtTime(pan, t, 0.06); ptg._apexPanTgt = pan;
      }

      // LEVEL: inverse-distance (engine.js:2570-2583).
      const near = RIVAL_REF / (RIVAL_REF + 1.15 * Math.max(0, dist - RIVAL_REF));
      const behind = arc < 0 ? 0.78 : 1;   // your own engine is between you and it
      const rv = (r.voice && ENGINE_VOICES[r.voice]) || DEFAULT_VOICE;
      aimGain(v.gain, PAN_MAKEUP * rivalPeak * tune.rivals * camMix.rivals * near * behind * (0.55 + 0.45 * clamp01(r.rev)), t, 0.10);

      // Air absorbs the top end with distance: a power law (engine.js:2585-2596).
      const cut = Math.max(700, Math.min(12000,
        12000 * Math.pow(RIVAL_REF / Math.max(dist, RIVAL_REF), 0.35) * rv.cutTrim));
      const ftg = tag(v.filt.frequency);
      if (Math.abs((ftg._apexCut ?? -1) - cut) > 60) {
        v.filt.frequency.setTargetAtTime(cut, t, 0.12);
        ftg._apexCut = cut;
      }

      // DOPPLER, the stationary-observer form, ratio-clamped (engine.js:2598-2609).
      const closing = Math.max(-90, Math.min(90, Number(r.approach) || 0));
      const dop = Math.max(0.80, Math.min(1.25, 343 / (343 - closing)));
      const rawRev = clamp01(r.rev);
      const rev01 = rivalSmoothedRev(i, rawRev, !!r.net, r.key, dt);
      v.setPitch(t, rev01, dop * v.detune * rv.rateTrim);   // their manufacturer's note, not yours
    }
  }

  function applyRivalMix(): void {
    const mix = layers.rivals ? tune.rivals : 0;
    if (rivalPassBy) rivalPassBy.setMix(mix);
    if (mix > 0 || !ctx) return;
    const t = now();
    for (const v of rivalVoices) aimGain(v.gain, 0, t, 0.04);
    for (const v of contactVoices) {
      if (v.player) continue;
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setTargetAtTime(0, t, 0.04);
    }
  }

  function setLayer(name: string, on: boolean): Layers {
    if (Object.prototype.hasOwnProperty.call(LAYER_DEF, name)) layers[name as keyof Layers] = !!on;
    // The reverb return and the rival mix are not gated per frame (engine.js:2631-2634).
    if (name === "reverb") applyVenue();
    if (name === "rivals") applyRivalMix();
    return Object.assign({}, layers);
  }

  // Short, low-register deploy whoosh (engine.js:2640-2661).
  function deployBoost(): void {
    boostPeak = layers.ers ? 0.14 * tune.boost : 0;
    boostFired++;
    if (!sfxOk() || !(boostPeak > 0)) return;   // BOOST at 0 is a silent deploy
    const c = ctx as AudioContext;
    const t0 = now();
    ers.cueBoost(t0, tune.boost);
    const src = c.createBufferSource();
    const off = bindNoise(src, 0.7);        // start(t0, off) -> stop(t0 + 0.6)
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 0.5;
    f.frequency.setValueAtTime(240, t0);
    f.frequency.exponentialRampToValueAtTime(1400, t0 + 0.30);
    const g = c.createGain();
    env(g, t0, boostPeak, 0.04, 0.28);
    src.connect(f).connect(g).connect(sfxBus as GainNode);
    src.start(t0, off);
    src.stop(t0 + 0.6);
    src.onended = () => { try { src.disconnect(); f.disconnect(); g.disconnect(); } catch { /* already disconnected */ } };
    blip(180, "sine", 0.035 * tune.boost, 0.025, 0.18, 360);
  }

  // Contact: impact 0..1, scrape = wall-follow grind, side pans through the pool (engine.js:2663-2679).
  function collision(impact?: number | null, scrape?: boolean, side?: number | null): void {
    const k = clamp01(impact != null ? impact : 0.6);
    const panSide = side == null || side === 0 ? 0 : Math.max(-1, Math.min(1, +side));
    if (panSide !== 0 && scheduleContactVoice(scrape ? "scrape" : "bump", k, panSide, 1, true)) {
      _lastPlayerContactPan = panSide;
      return;
    }
    if (scrape) { scrapeNoise(0.12 + 0.22 * k, 0.22 + 0.18 * k); return; }
    blip(150, "sine", 0.34 * (0.4 + 0.6 * k), 0.005, 0.25, 45);
    noise(0.26 * (0.4 + 0.6 * k), 0.18, 900);
    if (k > 0.6) blip(70, "sine", 0.3 * (k - 0.6) / 0.4, 0.004, 0.3, 40);   // the bang under a real hit
  }

  // FIELD CONTACT: positional one-shots, pooled at startEngine (engine.js:2681-2772).
  function contactCdHit(key: number, t: number): boolean {
    if (key == null || key < 0) return false;
    for (let i = 0; i < _contactCdN; i++) {
      if (_contactCdKeys[i] === key) return (_contactCdUntil[i] as number) > t;
    }
    return false;
  }
  function contactCdMark(key: number, t: number): void {
    if (key == null || key < 0) return;
    const until = t + CONTACT_COOLDOWN;
    for (let i = 0; i < _contactCdN; i++) {
      if (_contactCdKeys[i] === key) { _contactCdUntil[i] = until; return; }
    }
    if (_contactCdN < _contactCdKeys.length) {
      _contactCdKeys[_contactCdN] = key; _contactCdUntil[_contactCdN] = until; _contactCdN++;
      return;
    }
    let oldest = 0;
    for (let i = 1; i < _contactCdN; i++) if ((_contactCdUntil[i] as number) < (_contactCdUntil[oldest] as number)) oldest = i;
    _contactCdKeys[oldest] = key; _contactCdUntil[oldest] = until;
  }
  /** Shared pool schedule. `near` is 0..1 distance gain; `player` skips fieldArmed/range. */
  function scheduleContactVoice(kind: string, impact: number | null | undefined, pan: number, near: number | null | undefined, player: boolean): boolean {
    if (!sfxOk() || !engineOn || !contactVoices.length) {
      if (!player) contactDeniedGate++;
      return false;
    }
    if (!player && (!fieldArmed || !layers.rivals || !(tune.rivals > 0))) { contactDeniedGate++; return false; }
    const t = now();
    let v: ContactVoice | null = null;
    for (let i = 0; i < contactVoices.length; i++) {
      const cv = contactVoices[i] as ContactVoice;
      if (cv.freeAt <= t) { v = cv; break; }
    }
    if (!v) { contactDeniedCap++; return false; }
    const k = clamp01(impact != null ? impact : 0.5);
    const kd = kind || "bump";
    let peak: number, attack: number, decay: number, freq: number, q: number, fType: BiquadFilterType;
    if (kd === "scrape") {
      peak = 0.10 + 0.16 * k; attack = 0.02; decay = 0.18 + 0.12 * k;
      freq = 2400; q = 1.2; fType = "bandpass";
    } else if (kd === "squeal") {
      peak = 0.08 + 0.14 * k; attack = 0.01; decay = 0.12 + 0.10 * k;
      freq = 1800 + 600 * k; q = 6; fType = "bandpass";
    } else {
      peak = 0.16 + 0.22 * k; attack = 0.005; decay = 0.14 + 0.12 * k;
      freq = 420 + 180 * k; q = 0.9; fType = "lowpass";
    }
    peak *= clamp01(near != null ? near : 1) * 0.9 * (player ? 1 : tune.rivals);
    v.player = !!player;
    if (!(peak > 0.001)) return false;
    v.filt.type = fType;
    v.filt.Q.value = q;
    v.filt.frequency.cancelScheduledValues(t);
    v.filt.frequency.setValueAtTime(freq, t);
    v.osc.type = kd === "squeal" ? "triangle" : kd === "scrape" ? "sawtooth" : "sine";
    v.osc.frequency.cancelScheduledValues(t);
    v.osc.frequency.setValueAtTime(kd === "bump" ? Math.max(55, freq * 0.35) : freq * 0.55, t);
    const panClamped = Math.max(-1, Math.min(1, pan));
    v.pan.pan.cancelScheduledValues(t);
    v.pan.pan.setValueAtTime(panClamped, t);
    env(v.gain, t, peak, attack, decay);
    v.freeAt = t + attack + decay + 0.05;
    contactFired++;
    return true;
  }
  /** kind: "bump" | "scrape" | "squeal". impact 0..1. wx/wz world metres. carKey for cooldown. */
  function fieldContact(kind: string, impact: number, wx: number | null | undefined, wz: number | null | undefined, carKey: number): boolean {
    if (!sfxOk() || !engineOn || !fieldArmed || !contactVoices.length) {
      contactDeniedGate++; return false;
    }
    const t = now();
    const key = carKey | 0;
    if (contactCdHit(key, t)) { contactDeniedCd++; return false; }
    let pan = 0, dist = CONTACT_REF;
    const basis = opts.listener ? opts.listener() ?? null : null;
    if (basis && wx != null && wz != null && isFinite(+wx) && isFinite(+wz)) {
      const dx = +wx - basis.x, dz = +wz - basis.z;
      dist = Math.hypot(dx, dz);
      const lat = dx * basis.rightX + dz * basis.rightZ;
      const arc = dx * basis.fwdX + dz * basis.fwdZ;
      pan = rivalPanPlayerFrame(lat, arc);
    }
    if (!(dist < CONTACT_RANGE)) { contactDeniedGate++; return false; }
    const near = CONTACT_REF / (CONTACT_REF + 1.15 * Math.max(0, dist - CONTACT_REF));
    if (!scheduleContactVoice(kind, impact, pan, near, false)) return false;
    contactCdMark(key, t);
    return true;
  }
  function fieldContactState() {
    return {
      armed: fieldArmed,
      voices: contactVoices.length,
      live: contactVoices.filter((v) => v.freeAt > now()).length,
      fired: contactFired,
      deniedCd: contactDeniedCd,
      deniedCap: contactDeniedCap,
      deniedGate: contactDeniedGate,
      cooldown: CONTACT_COOLDOWN,
    };
  }
  function offtrack(): void {
    noise(0.14, 0.14, 480);
    blip(95, "square", 0.14, 0.01, 0.1, 60);
  }

  // Legacy kerb one-shot; a no-op while the continuous kerb layer is live.
  function rumble(): void {
    if (kerbLive) return;
    noise(0.09, 0.05, 320);
  }

  function thunder(near?: number | null): void {
    const n = Math.max(0, Math.min(1, near == null ? 0.6 : near));
    noise(0.10 + n * 0.22, 0.9 + n * 0.7, 170 + n * 150);      // rolling body
    noise(0.04 + n * 0.12, 0.25, 650 + n * 700, 0.05);          // closer crack
    noise(0.03 + n * 0.06, 1.7, 85);                            // long low tail
  }

  function lap(): void {
    blip(988, "square", 0.2, 0.01, 0.1);
    blip(1319, "square", 0.2, 0.01, 0.2, null, 0.1);
  }

  function finish(): void {
    [523, 659, 784, 1047, 784, 1047].forEach((f, i) => {
      blip(f, "square", 0.2, 0.01, 0.2, null, i * 0.11);
    });
  }

  // MENU SOUNDS: own switch, one click one sound (engine.js:2815-2836).
  let uiEnabled = true, uiLast = -1e9;
  const UI_GAP_MS = 60;
  function uiOk(): boolean {
    if (!uiEnabled || !sfxOk()) return false;
    const t = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (t - uiLast < UI_GAP_MS) return false;
    uiLast = t;
    return true;
  }
  function setUiEnabled(b: boolean): void { uiEnabled = !!b; }

  function uiTick(): void {
    if (!uiOk()) return;
    blip(660, "square", 0.08, 0.004, 0.05);
  }

  // BRAKE CUE: the signal is the pulse RATE, not pitch (engine.js:2838-2869).
  function assistPlaybackQuiet(): boolean {
    return !!(opts.assistQuiet && opts.assistQuiet());
  }
  function brakeCue(urgency: number): void {
    cueU = urgency > 0 ? Math.min(urgency, 1) : 0;
    if (!cueU || !sfxOk() || assistPlaybackQuiet()) { cueT = now(); return; }
    const t = now();
    if (t < cueT) return;
    blip(520, "square", 0.07, 0.003, 0.045);
    cueFired++;
    cueT = t + (0.4 + (0.07 - 0.4) * cueU);
  }

  // Assist-gated driving cues: a softer triangle with its own clock (engine.js:2871-2890).
  let driveCueT = 0, driveCueFired = 0, cornerCallFired = 0;
  function driveBrakeTone(urgency: number): void {
    const u = urgency > 0 ? Math.min(urgency, 1) : 0;
    if (!u || !sfxOk() || assistPlaybackQuiet()) { driveCueT = now(); return; }
    const t = now();
    if (t < driveCueT) return;
    blip(380, "triangle", 0.09, 0.004, 0.06);
    driveCueFired++;
    driveCueT = t + (0.45 + (0.09 - 0.45) * u);
  }
  // +k = LEFT turn (AGENTS.md). Two pitches, never speech.
  function cornerCall(side: "L" | "R" | "left" | "right" | 1 | -1 | string | number): void {
    if (!sfxOk() || assistPlaybackQuiet()) return;
    const left = side === "L" || side === 1 || side === "left";
    blip(left ? 620 : 480, "sine", 0.11, 0.005, 0.10);
    cornerCallFired++;
  }

  function uiSelect(): void {
    if (!uiOk()) return;
    blip(880, "square", 0.13, 0.005, 0.09);
  }

  // "No": a low sawtooth, unmistakably not a confirmation.
  function uiReject(): void {
    if (!uiOk()) return;
    blip(220, "sawtooth", 0.12, 0.006, 0.14);
  }

  function penalty(): void {
    blip(330, "sawtooth", 0.22, 0.01, 0.45, 116);
    blip(165, "square", 0.14, 0.01, 0.45, 58);
  }

  // Mixer: SFX bus level and switch under the master mute (engine.js:2916-2940).
  function setSfxVolume(v: unknown): number {
    sfxVol = clamp01(typeof v === "number" ? v : 1);
    writeSfx(LEVEL_TAU); refreshFocus(LEVEL_TAU);
    return sfxVol;
  }
  function setSfxEnabled(b: boolean): boolean {
    sfxEnabled = !!b;
    writeSfx(LEVEL_TAU); refreshFocus(LEVEL_TAU);
    // A race that started with SFX off wanted rain but built no nodes.
    if (sfxEnabled && rainWanted && !rainSrc) startRain();
    // Release the rev-keyed music duck the way stopEngine() does (engine.js:2931-2937).
    if (!sfxEnabled) soundtrack.releaseEngineDuck(now(), true);
    return sfxEnabled;
  }
  function volumes(): { sfx: number; music: number } { return { sfx: sfxVol, music: soundtrack.volume() }; }

  let _onInterrupted: (() => void) | null = null;
  /** fn() when the platform interrupts the audio session (an iOS call, Siri). */
  function onInterrupted(fn: unknown): void { _onInterrupted = typeof fn === "function" ? fn as () => void : null; }

  return {
    onInterrupted,
    init,
    setRadioDuck, setSpotterDuck, setRadioFocusDb, getRadioFocusDb: () => radioFocusDb, setVoiceFocusHold, setVoiceFocusSpan,
    now,
    ctxGen: () => ctxGen,
    /** The live context and SFX bus, for leaf modules that schedule their own nodes. */
    context: () => ctx,
    sfxBus: () => sfxBus,
    focusBus: () => focusBus,
    master: () => master,
    signal,
    music: soundtrack,
    radio,
    setEnabled,
    enabled,
    sfxOk,
    startEngine,
    stopEngine,
    engineRunning: () => engineOn,
    enginePlaybackGeneration: () => engineActionGeneration,
    stopEngineIfGeneration(generation: number): boolean { if (generation !== engineActionGeneration) return false; setSkid(0); stopEngine(); return true; },
    setEngine,
    setGridIdle,
    feedReplayScrub,
    syncReplayRpms,
    resetReplayScrub,
    setSkid,
    squealFromSlip,
    windFromSpeed,
    skidPitch(): number { return skidFilter ? Number(tag(skidFilter.frequency)._apexSkidBase ?? skidFilter.frequency.value) : 0; },
    windCutoff(): number { return windFilter ? Number(tag(windFilter.frequency)._apexAimTgt ?? windFilter.frequency.value) : 0; },
    setCarSfx,
    pitGun,
    setCameraMix,
    cameraMix: () => ({ kind: camKind, ...camMix }),
    carSfx: () => ({ ...carSfxLast, pitGuns: pitGunFired, revFlare: +revFlare.toFixed(4), pitDepth: pitLimGain ? tag(pitLimGain)._apexTgt || 0 : 0 }),
    kerbSpray() {
      return {
        kerb: kerbGain ? +(tag(kerbGain)._apexAimTgt ?? kerbGain.gain.value).toFixed(5) : 0,
        kerbRate: kerbSrc ? +(tag(kerbSrc.playbackRate)._apexAimTgt ?? kerbSrc.playbackRate.value).toFixed(4) : 0,
        kerbHz: kerbFilter ? Math.round(tag(kerbFilter.frequency)._apexHz ?? kerbFilter.frequency.value) : 0,
        spray: sprayGain ? +(tag(sprayGain)._apexAimTgt ?? sprayGain.gain.value).toFixed(5) : 0,
        sprayAhead: +sprayAhead.toFixed(4),
        kerbLive: !!kerbLive,
      };
    },
    shift,
    lightOn,
    lightsOut,
    overtakeReady,
    deployBoost,
    xMode,
    setVoice,
    setTune,
    setProfile,
    setLayer,
    setRivals,
    fieldContact,
    fieldContactState,
    lastPlayerContactPan(): number { return +_lastPlayerContactPan.toFixed(4); },
    setVenue,
    venue() { return { name: venueName, level: revReturn ? +revReturn.gain.value.toFixed(4) : 0, decay: venue.decay }; },
    rivalState() {
      return rivalVoices.map((v) => ({
        gain: +v.gain.gain.value.toFixed(5),
        pan: +v.pan.pan.value.toFixed(4),
        rate: v.src ? +v.src.playbackRate.value.toFixed(4) : 0,
        hz: v.oscs && v.oscs[0] ? +v.oscs[0].frequency.value.toFixed(2) : 0,
        cut: Math.round(v.filt.frequency.value),
      }));
    },
    tune(): Tune { return Object.assign({}, tune); },
    tuneRange(): Record<string, [number, number]> { return JSON.parse(JSON.stringify(TUNE_RANGE)) as Record<string, [number, number]>; },
    tuneDefaults(): Tune { return Object.assign({}, TUNE_DEF); },
    layers(): Layers { return Object.assign({}, layers); },
    layerDefaults(): Layers { return Object.assign({}, LAYER_DEF); },
    profile(): SoundProfile | "custom" { return profileName; },
    profiles(): string[] { return Object.keys(SOUND_PROFILES); },
    voiceName(): string { return voiceName; },
    voices(): string[] { return Object.keys(ENGINE_VOICES); },
    collision,
    offtrack,
    rumble,
    thunder,
    lap,
    finish,
    uiTick,
    brakeCue,
    driveBrakeTone,
    cornerCall,
    uiSelect,
    uiReject,
    setUiEnabled,
    uiEnabled(): boolean { return uiEnabled; },
    penalty,
    startRain,
    stopRain,
    setSessionType,
    sessionType(): "playback" | "ambient" { return sessionType; },
    setSfxVolume,
    setSfxEnabled,
    mixDuck() {
      return {
        on: mixDuckOn,
        focusDb: radioFocusDb, focusHolds: focusVoices.size,
        focusValue: ctx ? curveValue(focusCurve, ctx.currentTime) : 1,
        focusEvents: focusCurve.events.map((e) => ({ ...e })),
        holds: radioDuckHolds.size + (spotterDuckHold ? 1 : 0),
        lin: MIX_DUCK_LIN,
        attackTau: MIX_DUCK_ATTACK_TAU,
        releaseTau: MIX_DUCK_RELEASE_TAU,
        sfx: sfxBus ? Number(sfxBus.gain.value) : 0,
      };
    },
    volumes,
    windLevel(): number { return windGain ? Number(windGain.gain.value) : 0; },
    limiterDepth(): number { return limGain ? Number(limGain.gain.value) : 0; },
    limiterHeld(): number | null { return limSince == null || !ctx ? null : +(ctx.currentTime - limSince).toFixed(3); },
    limiterHz(): number { return limOsc ? +limOsc.frequency.value.toFixed(2) : 0; },
    limiterCents(): number { return limPitch ? +limPitch.gain.value.toFixed(3) : 0; },
    ersLevel(): number {
      if (ers.attached()) return ers.deployLevel();
      return ersGain ? Number(ersGain.gain.value) : 0;
    },
    ersAudio(): ErsInspect { return ers.inspect(); },
    harvestLevel(): number { return harvGain ? Number(harvGain.gain.value) : 0; },
    harvestCoastLevel(): number { return +harvCoastLevel.toFixed(5); },
    harvestBrakeLevel(): number { return +harvBrakeLevel.toFixed(5); },
    cylCutDepth(): number { return cylCutGain ? Number(cylCutGain.gain.value) : 0; },
    skidLevel(): number { return skidGain ? Number(skidGain.gain.value) : 0; },
    boostState() { return { fired: boostFired, peak: +boostPeak.toFixed(4) }; },
    engineCut(): number { return engFilter ? Math.round(engFilter.frequency.value) : 0; },
    engineLevel(): number { return engGain ? Number(engGain.gain.value) : 0; },
    subLevel(): number { return subOctGain ? Number(subOctGain.gain.value) : 0; },
    overrunState() { return { fired: overrunFired, nextAt: +overrunT.toFixed(3), now: +now().toFixed(3) }; },
    brakeCueState() { return { fired: cueFired, urgency: +cueU.toFixed(3), nextAt: +cueT.toFixed(3), now: +now().toFixed(3) }; },
    driveCueState() {
      return {
        brakeFired: driveCueFired, callFired: cornerCallFired,
        nextAt: +driveCueT.toFixed(3), now: +now().toFixed(3),
      };
    },
    wastegateState() { return { fired: wasteFired, pullT: +pullT.toFixed(3) }; },
    shiftState() { return { fired: shiftFired, peak: +shiftPeak.toFixed(4) }; },
    gravelDepth(): number { return gravGain ? Number(gravGain.gain.value) : 0; },
    gravelHz(): number { return gravOsc ? +gravOsc.frequency.value.toFixed(2) : 0; },
    brakeLevel(): number { return brakeGain ? Number(brakeGain.gain.value) : 0; },
    subHz(): number { return subOctOsc ? Number(subOctOsc.frequency.value) : 0; },
    detuneCents(): number { return engSrcIdle && engSrcIdle.detune ? +engSrcIdle.detune.value.toFixed(4) : 0; },
    tiltDb(): number { return tiltEq ? +tiltEq.gain.value.toFixed(2) : 0; },
    rate(): number { return (engSrcIdle && engSrcIdle.playbackRate) ? Number(engSrcIdle.playbackRate.value) : 0; },
    centroidHz(): number {
      if (!ctx || !engineOn || !engGain) return 0;
      if (!dbgAnalyser) {
        // Lazy debug tap (test-only caller), torn down with the engine.
        dbgAnalyser = ctx.createAnalyser();
        dbgAnalyser.fftSize = 16384;
        dbgAnalyser.smoothingTimeConstant = 0;
        engGain.connect(dbgAnalyser);
      }
      const n = dbgAnalyser.frequencyBinCount, arr = new Float32Array(n);
      dbgAnalyser.getFloatFrequencyData(arr);
      let num = 0, den = 0;
      for (let i = 1; i < n; i++) { const m = Math.pow(10, (arr[i] as number) / 20); num += (i * ctx.sampleRate / dbgAnalyser.fftSize) * m; den += m; }
      return den > 0 ? Math.round(num / den) : 0;
    },
    debug() {
      return { contextState: ctx ? ctx.state : "uninitialised", samplesReady, usingSamples, engineOn, voice: voiceName,
        limSwing: limGain ? tag(limGain)._apexLimTgt ?? 0 : null, surfSched,
        loop: engSrcIdle ? { s: +engSrcIdle.loopStart.toFixed(2), e: +engSrcIdle.loopEnd.toFixed(2), win: engWin && [+engWin.start.toFixed(2), +engWin.end.toFixed(2)] } : null };
    },
  };
}
