/**
 * ErsLayer — player-car MGU-K electric layer and overtake/boost cue.
 *
 * Ported from f1-game js/audio/ers-layer.js:7-236. f1-game's module is a
 * singleton IIFE; here createErsLayer() returns one instance, owned by the
 * engine. A fixed node set is built once in attach(); update() only aims
 * existing params via setTargetAtTime. Zero nodes per frame. Never writes
 * car state.
 */
import { tag } from "./tags";

const DEPLOY_HZ0 = 720, DEPLOY_HZ_SPAN = 600;
const HARVEST_HZ0 = 380, HARVEST_HZ_SPAN = 340;
const SUSTAIN_HZ = 440, CUE_HZ = 660, CUE_PEAK = 0.018;
const EMPTY = 1e-4, DEPLOY_GATE = 0.12, HARVEST_GATE = 0.04, CUE_REARM = 0.12;

function clamp01(x: unknown): number {
  const v = Number(x);
  if (!(v > 0)) return 0;
  if (v > 1) return 1;
  return v;
}

function socK(energy: number): number { return 0.22 + 0.78 * clamp01(energy); }

export interface ErsGainOpts {
  layerOn?: boolean | undefined;
  ersOn?: boolean | undefined;
  partBias?: number | null | undefined;
  boostTune?: number | null | undefined;
  speed?: number | null | undefined;
}

export function isLive(energy: number, layerOn?: boolean, ersOn?: boolean): boolean {
  return layerOn !== false && ersOn !== false && clamp01(energy) > EMPTY;
}

/** Deploy whine Hz: rises with deploy power; sagging pack drops ~12%. ers-layer.js:29-34. */
export function deployHz(deploy: number, energy: number): number {
  const d = clamp01(deploy);
  const e = clamp01(energy);
  const low = e < 0.2 ? 0.88 + 0.12 * (e / 0.2) : 1;
  return (DEPLOY_HZ0 + DEPLOY_HZ_SPAN * d) * low;
}

/** Harvest/regen Hz: lower register, braking-linked. ers-layer.js:37. */
export function harvestHz(brake: number): number { return HARVEST_HZ0 + HARVEST_HZ_SPAN * clamp01(brake); }

export function deployGain(deploy: number, energy: number, opts?: ErsGainOpts | null): number {
  const o = opts || {};
  if (!isLive(energy, o.layerOn, o.ersOn)) return 0;
  const d = clamp01(deploy);
  if (!(d > 0)) return 0;
  const e = clamp01(energy);
  const low = e < 0.2 ? e / 0.2 : 1;
  const part = o.partBias != null ? o.partBias : 1;
  const tune = o.boostTune != null ? o.boostTune : 1;
  const s = o.speed != null ? clamp01(o.speed) : 0.75;
  return (0.005 + 0.010 * d * (0.35 + 0.65 * e)) * (0.4 + 0.6 * low)
    * part * tune * (0.42 + 0.58 * Math.max(s, 0.04));
}

export function harvestGain(brake: number, energy: number, deploy: number, opts?: ErsGainOpts | null): number {
  const o = opts || {};
  if (!isLive(energy, o.layerOn, o.ersOn)) return 0;
  if (clamp01(deploy) >= 0.05) return 0;
  const b = clamp01(brake);
  if (!(b > HARVEST_GATE)) return 0;
  return (0.008 + 0.022 * b) * socK(energy);
}

export function sustainGain(on: boolean, energy: number, opts?: ErsGainOpts | null): number {
  const o = opts || {};
  if (!on || !isLive(energy, o.layerOn, o.ersOn)) return 0;
  const tune = o.boostTune != null ? o.boostTune : 1;
  return 0.003 * socK(energy) * tune;
}

function aim(param: AudioParam | null | undefined, target: number, t: number, tau: number, rel?: number): void {
  if (!param || typeof param.setTargetAtTime !== "function") return;
  const tg = tag(param);
  const prev = tg._ersAim;
  const close = rel
    ? prev !== undefined && Math.abs(prev - target) <= Math.abs(target) * rel
    : prev !== undefined && Math.abs(prev - target) < 1e-4;
  if (prev === target || close) return;
  param.setTargetAtTime(target, t, tau);
  tg._ersAim = target;
}

/** What GameAudio.setEngine hands the layer each frame. engine.js:1910-1915. */
export interface ErsUpdate extends ErsGainOpts {
  t?: number;
  energy?: number;
  deploy?: number;
  brake?: number;
  ax?: number;
  boost?: boolean;
  otOn?: boolean;
}

export interface ErsInspect {
  attached: boolean; deploy: number; harvest: number; sustain: number;
  deployHz: number; harvestHz: number; cueFired: number; builds: number;
}

export interface ErsLayer {
  attach(ac: BaseAudioContext, bus: AudioNode): void;
  detach(): void;
  silence(t?: number | null): void;
  update(st: ErsUpdate): void;
  cueBoost(t?: number | null, tune?: number | null): void;
  inspect(): ErsInspect;
  attached(): boolean;
  deployLevel(): number;
  harvestLevel(): number;
  sustainLevel(): number;
  cueCount(): number;
  builds(): number;
}

export function createErsLayer(): ErsLayer {
  let ctx: BaseAudioContext | null = null, dest: AudioNode | null = null;
  let deployOsc: OscillatorNode | null = null, deployHp: BiquadFilterNode | null = null, deployG: GainNode | null = null;
  let harvestOsc: OscillatorNode | null = null, harvestBp: BiquadFilterNode | null = null, harvestG: GainNode | null = null;
  let sustainOsc: OscillatorNode | null = null, sustainG: GainNode | null = null;
  let cueOsc: OscillatorNode | null = null, cueG: GainNode | null = null;
  let wasBoost = false, cueFired = 0, lastCueT = -1e9, built = 0;

  function stopNode(n: AudioNode | null): void {
    try { if (n && "stop" in n) (n as AudioScheduledSourceNode).stop(); } catch { /* already stopped */ }
    try { if (n) n.disconnect(); } catch { /* torn down */ }
  }

  function detach(): void {
    stopNode(deployOsc); stopNode(deployHp); stopNode(deployG);
    stopNode(harvestOsc); stopNode(harvestBp); stopNode(harvestG);
    stopNode(sustainOsc); stopNode(sustainG);
    stopNode(cueOsc); stopNode(cueG);
    deployOsc = deployHp = deployG = null;
    harvestOsc = harvestBp = harvestG = null;
    sustainOsc = sustainG = cueOsc = cueG = null;
    ctx = dest = null;
    wasBoost = false;
    lastCueT = -1e9;
  }

  function attach(ac: BaseAudioContext, bus: AudioNode): void {
    if (!ac || !bus) return;
    if (ctx === ac && dest === bus && deployOsc) return;
    detach();
    ctx = ac;
    dest = bus;
    deployOsc = ctx.createOscillator();
    deployOsc.type = "sine";
    deployOsc.frequency.value = DEPLOY_HZ0;
    deployHp = ctx.createBiquadFilter();
    deployHp.type = "lowpass";
    deployHp.frequency.value = 1800;
    deployHp.Q.value = 0.5;
    deployG = ctx.createGain();
    deployG.gain.value = 0;
    deployOsc.connect(deployHp).connect(deployG).connect(dest);

    harvestOsc = ctx.createOscillator();
    harvestOsc.type = "sine";
    harvestOsc.frequency.value = HARVEST_HZ0;
    harvestBp = ctx.createBiquadFilter();
    harvestBp.type = "bandpass";
    harvestBp.frequency.value = HARVEST_HZ0;
    harvestBp.Q.value = 5;
    harvestG = ctx.createGain();
    harvestG.gain.value = 0;
    harvestOsc.connect(harvestBp).connect(harvestG).connect(dest);

    sustainOsc = ctx.createOscillator();
    sustainOsc.type = "sine";
    sustainOsc.frequency.value = SUSTAIN_HZ;
    sustainG = ctx.createGain();
    sustainG.gain.value = 0;
    sustainOsc.connect(sustainG).connect(dest);

    cueOsc = ctx.createOscillator();
    cueOsc.type = "sine";
    cueOsc.frequency.value = CUE_HZ;
    cueG = ctx.createGain();
    cueG.gain.value = 0;
    cueOsc.connect(cueG).connect(dest);

    try { deployOsc.start(); } catch { /* started */ }
    try { harvestOsc.start(); } catch { /* started */ }
    try { sustainOsc.start(); } catch { /* started */ }
    try { cueOsc.start(); } catch { /* started */ }
    built++;
  }

  function silence(t?: number | null): void {
    if (!ctx) return;
    const at = t != null ? t : ctx.currentTime;
    aim(deployG && deployG.gain, 0, at, 0.06);
    aim(harvestG && harvestG.gain, 0, at, 0.06);
    aim(sustainG && sustainG.gain, 0, at, 0.06);
    if (cueG) {
      cueG.gain.cancelScheduledValues(at);
      cueG.gain.setTargetAtTime(0, at, 0.04);
      tag(cueG.gain)._ersAim = 0;
    }
    wasBoost = false;
  }

  function fireCue(t: number | null | undefined, tune: number | null | undefined): void {
    const peak = CUE_PEAK * (tune != null ? tune : 1);
    if (!cueG || !ctx || !(peak > 0)) return;
    const at = t != null ? t : ctx.currentTime;
    if (at - lastCueT < CUE_REARM) return;
    lastCueT = at;
    cueFired++;
    const g = cueG.gain;
    if (g.cancelScheduledValues) g.cancelScheduledValues(at);
    g.setTargetAtTime(peak, at, 0.015);
    g.setTargetAtTime(0, at + 0.04, 0.05);
    tag(g)._ersAim = 0;
  }

  function cueBoost(t?: number | null, tune?: number | null): void { fireCue(t, tune); }

  function update(st: ErsUpdate): void {
    if (!ctx || !deployG || !harvestG || !sustainG) return;
    const s = st || {};
    const t = s.t != null ? s.t : ctx.currentTime;
    const energy = clamp01(s.energy != null ? s.energy : 1);
    const deploy = clamp01(s.deploy != null ? s.deploy : 0);
    const brakeIn = clamp01(s.brake != null ? s.brake : 0);
    const ax = Number(s.ax) || 0;
    const brake = Math.max(brakeIn, ax < 0 ? clamp01(-ax / 22) : 0);
    const on = isLive(energy, s.layerOn, s.ersOn);
    const dGain = on ? deployGain(deploy, energy, s) : 0;
    const hGain = on ? harvestGain(brake, energy, deploy, s) : 0;
    const boostActive = on && s.boostTune !== 0 && !!(s.boost || s.otOn || deploy > DEPLOY_GATE);
    if (boostActive && !wasBoost) fireCue(t, s.boostTune);
    if ((!on || s.boostTune === 0) && wasBoost) silence(t);
    wasBoost = boostActive;
    const sGain = sustainGain(boostActive, energy, s);
    aim(deployG.gain, dGain, t, deploy > 0 ? 0.05 : 0.10);
    aim(harvestG.gain, hGain, t, 0.08);
    aim(sustainG.gain, sGain, t, 0.07);
    if (deployOsc) aim(deployOsc.frequency, deployHz(deploy, energy), t, 0.06, 1e-4);
    if (harvestOsc) aim(harvestOsc.frequency, harvestHz(brake), t, 0.08, 1e-4);
    if (harvestBp) aim(harvestBp.frequency, harvestHz(brake), t, 0.08, 1e-4);
    if (sustainOsc) aim(sustainOsc.frequency, SUSTAIN_HZ, t, 0.10, 1e-4);
  }

  function attached(): boolean { return !!(ctx && deployOsc); }
  function deployLevel(): number { return deployG ? Number(deployG.gain.value) : 0; }
  function harvestLevel(): number { return harvestG ? Number(harvestG.gain.value) : 0; }
  function sustainLevel(): number { return sustainG ? Number(sustainG.gain.value) : 0; }
  function cueCount(): number { return cueFired | 0; }
  function builds(): number { return built | 0; }

  function inspect(): ErsInspect {
    return {
      attached: attached(),
      deploy: deployLevel(),
      harvest: harvestLevel(),
      sustain: sustainLevel(),
      deployHz: deployOsc ? Number(deployOsc.frequency.value) : 0,
      harvestHz: harvestOsc ? Number(harvestOsc.frequency.value) : 0,
      cueFired: cueFired | 0,
      builds: built | 0,
    };
  }

  return {
    attach, detach, silence, update, cueBoost, inspect, attached,
    deployLevel, harvestLevel, sustainLevel, cueCount, builds,
  };
}
