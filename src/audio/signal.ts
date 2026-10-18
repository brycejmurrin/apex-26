/**
 * Sample analysis and SFX primitives: blip voice pool, noise buffers and
 * filtered-noise one-shots.
 *
 * Ported from f1-game js/audio/signal.js:4-241 (GameAudioSignal). create()
 * takes live service functions so a context rebuild never leaves this module
 * holding the old context; resetContext() discards only the context-bound
 * caches.
 */

/** The live services a signal host provides. signal.js:79 `create(host)`. */
export interface SignalHost {
  context(): BaseAudioContext | null;
  bus(): AudioNode | null;
  sfxOk(): boolean;
  now(): number;
}

/** A uniform [0,1) source; Math.random in the game, seeded in tests. */
export type Rand = () => number;

/** Dominant period of the loop region, by normalised autocorrelation. signal.js:14-43. */
export function detectPeriod(buf: AudioBuffer): number {
  const d = buf.getChannelData(0), sr = buf.sampleRate;
  const from = Math.floor(d.length * 0.3);
  const n = Math.min(8192, d.length - from);
  if (n < 2048) return 0;
  const x = d.subarray(from, from + n);
  const loLag = Math.max(2, Math.floor(sr / 800)), hiLag = Math.min(n >> 1, Math.ceil(sr / 50));
  // NORMALISED, then the SHORTEST lag nearly as good as the best: raw
  // autocorrelation octave-errors onto 2P and 4P (signal.js:21-28).
  const score = new Float32Array(hiLag);
  let best = 0;
  for (let lag = loLag; lag < hiLag; lag++) {
    let acc = 0, e1 = 0, e2 = 0;
    for (let i = 0; i + lag < n; i++) { const a1 = x[i] as number, b1 = x[i + lag] as number; acc += a1 * b1; e1 += a1 * a1; e2 += b1 * b1; }
    const dd = Math.sqrt(e1 * e2);
    const v = dd > 0 ? acc / dd : 0;
    score[lag] = v;
    if (v > best) best = v;
  }
  if (!(best > 0)) return 0;
  const floor = best * 0.9;
  for (let lag = loLag; lag < hiLag; lag++) if ((score[lag] as number) >= floor) return lag;
  return 0;
}

export interface LoopSpan { start: number; end: number }

const _loopMemo = new WeakMap<AudioBuffer, LoopSpan>();
/** The steadiest ~2 s window by zero-crossing coefficient of variation. signal.js:44-75. */
export function findStableLoop(buf: AudioBuffer): LoopSpan {
  const memo = _loopMemo.get(buf);
  if (memo) return memo;
  const r = findStableLoopUncached(buf);
  _loopMemo.set(buf, r);
  return r;
}
function findStableLoopUncached(buf: AudioBuffer): LoopSpan {
  const d = buf.getChannelData(0), sr = buf.sampleRate, N = d.length;
  const hopN = Math.max(1, Math.floor(sr * 0.1));
  const zc: number[] = [];
  for (let a = 0; a + hopN < N; a += hopN) {
    let c = 0, prev = d[a] as number;
    for (let j = a + 1; j < a + hopN; j++) { const v = d[j] as number; if ((v >= 0) !== (prev >= 0)) c++; prev = v; }
    zc.push(c);
  }
  const w = Math.round(2.0 / 0.1);                 // ~2s window
  if (zc.length < w + 2) return { start: buf.duration * 0.1, end: buf.duration * 0.9 };
  let bestCV = Infinity, bi = 0;
  for (let i = 0; i + w < zc.length; i++) {
    let m = 0; for (let k = i; k < i + w; k++) m += zc[k] as number; m /= w;
    if (m <= 0) continue;
    let v = 0; for (let k = i; k < i + w; k++) { const dv = (zc[k] as number) - m; v += dv * dv; } v /= w;
    const cv = Math.sqrt(v) / m;
    if (cv < bestCV) { bestCV = cv; bi = i; }
  }
  return { start: bi * 0.1, end: (bi + w) * 0.1 };
}

let blipFireTotal = 0;
/** Session-wide blip fire count across hosts (signal.js:8). */
export function blipFires(): number { return blipFireTotal; }

export interface Signal {
  env(gainNode: GainNode, t0: number, peak: number, attack: number, decay: number): void;
  blip(freq: number, type: OscillatorType, peak: number, attack: number, decay: number, slideTo?: number | null, when?: number): void;
  blipStats(): { fired: number; pool: number; poolCap: number };
  noiseBuf(seconds: number): AudioBuffer;
  loopNoise(name: string, seconds: number): AudioBuffer;
  noisePool(): AudioBuffer;
  bindNoise(src: AudioBufferSourceNode, needS: number): number;
  noise(peak: number, decay: number, filterFreq: number, when?: number): void;
  hiss(peak: number, decay: number, f0: number, f1: number): void;
  scrapeNoise(peak: number, decay: number): void;
  readonly noisePoolSeconds: number;
  resetContext(): void;
}

interface BurstFilter {
  type: BiquadFilterType;
  frequency: number;
  attack: number;
  when?: number | undefined;
  slideTo?: number;
  q?: number;
}

export function createSignal(host: SignalHost, rand: Rand = Math.random): Signal {
  const ac = (): BaseAudioContext => host.context() as BaseAudioContext;
  const bus = (): AudioNode => host.bus() as AudioNode;

  function env(gainNode: GainNode, t0: number, peak: number, attack: number, decay: number): void {
    const g = gainNode.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.linearRampToValueAtTime(peak, t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  // Fixed-size blip voice pool: start once, envelope the gain, reuse (signal.js:96-123).
  const BLIP_POOL = 8;
  const blipVoices: { osc: OscillatorNode; g: GainNode; freeAt: number }[] = [];
  let blipFired = 0;

  function acquireBlipVoice(t0: number): { osc: OscillatorNode; g: GainNode; freeAt: number } {
    let v: { osc: OscillatorNode; g: GainNode; freeAt: number } | null = null;
    for (let i = 0; i < blipVoices.length; i++) {
      const bv = blipVoices[i];
      if (bv && bv.freeAt <= t0) { v = bv; break; }
    }
    if (!v && blipVoices.length < BLIP_POOL) {
      const osc = ac().createOscillator();
      const g = ac().createGain();
      g.gain.value = 0.0001;
      osc.connect(g).connect(bus());
      osc.start(0);
      v = { osc, g, freeAt: 0 };
      blipVoices.push(v);
    }
    if (!v) {
      let o = blipVoices[0] as { osc: OscillatorNode; g: GainNode; freeAt: number };
      for (let i = 1; i < blipVoices.length; i++) {
        const bv = blipVoices[i];
        if (bv && bv.freeAt < o.freeAt) o = bv;
      }
      v = o;
    }
    return v;
  }

  function blip(freq: number, type: OscillatorType, peak: number, attack: number, decay: number, slideTo?: number | null, when?: number): void {
    if (!host.sfxOk()) return;
    const t0 = host.now() + (when || 0);
    const dur = attack + decay;
    const v = acquireBlipVoice(t0);
    blipFired++;
    blipFireTotal++;
    v.freeAt = t0 + dur + 0.05;
    const osc = v.osc, g = v.g;
    osc.type = type;
    osc.frequency.cancelScheduledValues(t0);
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    env(g, t0, peak, attack, decay);
  }

  function blipStats(): { fired: number; pool: number; poolCap: number } {
    return { fired: blipFired, pool: blipVoices.length, poolCap: BLIP_POOL };
  }

  function noiseBuf(seconds: number): AudioBuffer {
    const len = Math.ceil(ac().sampleRate * seconds);
    const buf = ac().createBuffer(1, len, ac().sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = rand() * 2 - 1;
    return buf;
  }

  // ONE shared white-noise buffer for the one-shots, played from a random
  // offset (signal.js:162-185). Context-bound: resetContext() clears it.
  const NOISE_POOL_S = 3;
  let noisePoolBuf: AudioBuffer | null = null;
  const _loopNoise = new Map<string, AudioBuffer>();
  function loopNoise(name: string, seconds: number): AudioBuffer {
    let buf = _loopNoise.get(name);
    if (!buf) { buf = noiseBuf(seconds); _loopNoise.set(name, buf); }
    return buf;
  }
  function noisePool(): AudioBuffer {
    if (!noisePoolBuf) noisePoolBuf = noiseBuf(NOISE_POOL_S);
    return noisePoolBuf;
  }
  function bindNoise(src: AudioBufferSourceNode, needS: number): number {
    if (needS >= NOISE_POOL_S) { src.buffer = noiseBuf(needS); return 0; }
    src.buffer = noisePool();
    return rand() * (NOISE_POOL_S - needS);
  }

  function noiseBurst(peak: number, decay: number, filter: BurstFilter): void {
    const t0 = host.now() + (filter.when || 0);
    const src = ac().createBufferSource();
    const off = bindNoise(src, decay + 0.15);
    const f = ac().createBiquadFilter();
    f.type = filter.type;
    if (filter.q != null) f.Q.value = filter.q;
    if (filter.slideTo != null) {
      f.frequency.setValueAtTime(filter.frequency, t0);
      f.frequency.exponentialRampToValueAtTime(filter.slideTo, t0 + decay);
    } else f.frequency.value = filter.frequency;
    const g = ac().createGain();
    env(g, t0, peak, filter.attack, decay);
    src.connect(f).connect(g).connect(bus());
    src.start(t0, off);
    src.stop(t0 + decay + 0.1);
    src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); };
  }
  function noise(peak: number, decay: number, filterFreq: number, when?: number): void {
    if (!host.sfxOk()) return;
    noiseBurst(peak, decay, { type: "lowpass", frequency: filterFreq, attack: 0.005, when });
  }
  // A falling band-passed hiss: a wastegate rounds off as its pressure goes.
  function hiss(peak: number, decay: number, f0: number, f1: number): void {
    if (!host.sfxOk() || !(peak > 0)) return;
    noiseBurst(peak, decay, { type: "bandpass", frequency: f0, slideTo: f1, q: 1.4, attack: 0.008 });
  }
  function scrapeNoise(peak: number, decay: number): void {
    if (!host.sfxOk()) return;
    noiseBurst(peak, decay, { type: "bandpass", frequency: 2600, q: 1.2, attack: 0.02 });
  }

  return {
    env, blip, blipStats, noiseBuf, loopNoise, noisePool, bindNoise, noise, hiss, scrapeNoise,
    noisePoolSeconds: NOISE_POOL_S,
    resetContext() {
      noisePoolBuf = null;
      _loopNoise.clear();
      for (let i = 0; i < blipVoices.length; i++) {
        const v = blipVoices[i];
        if (!v) continue;
        try { v.osc.disconnect(); } catch { /* closed ctx */ }
        try { v.g.disconnect(); } catch { /* closed ctx */ }
      }
      blipVoices.length = 0;
    },
  };
}
