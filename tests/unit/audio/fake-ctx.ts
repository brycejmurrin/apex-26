/**
 * A recording AudioContext for the audio parity tests. Every node creation,
 * connection, property write and AudioParam call lands in `trace` as a small
 * JSON-safe tuple, so two implementations driven by the same script can be
 * compared call for call.
 *
 * This file has no imports and only erasable TypeScript, so the fixture
 * generator (tools/audio/gen-engine-trace.ts) can load it under
 * `node --experimental-strip-types` next to f1-game's own engine.js.
 */

export type TraceVal = string | number | boolean | null;
export type TraceEntry = TraceVal[];

/** Numbers that JSON cannot carry (-0, NaN, ±Infinity) become strings. */
export function enc(v: unknown): TraceVal {
  if (typeof v === "number") {
    if (Object.is(v, -0)) return "-0";
    return Number.isFinite(v) ? v : String(v);
  }
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  const id = (v as { __id?: string }).__id;
  return id ? id : "?";
}

/** mulberry32: a deterministic Math.random stand-in. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A setTimeout queue fired by hand, in due-time then insertion order. */
export function createTimers(clock: () => number) {
  let seq = 0;
  const q: { id: number; due: number; fn: () => void }[] = [];
  return {
    setTimeout(fn: () => void, ms?: number): number {
      const id = ++seq;
      q.push({ id, due: clock() + (ms || 0), fn });
      return id;
    },
    clearTimeout(id: number): void {
      const i = q.findIndex((e) => e.id === id);
      if (i >= 0) q.splice(i, 1);
    },
    flush(): void {
      while (q.length) {
        q.sort((a, b) => a.due - b.due || a.id - b.id);
        const e = q.shift();
        if (e) e.fn();
      }
    },
  };
}

export interface FakeAudioOpts {
  /** "synth" resolves decodeAudioData with a generated drone; "reject" fails it. */
  decode: "synth" | "reject";
  sampleRate?: number;
}

export function createFakeAudio(trace: TraceEntry[], opts: FakeAudioOpts) {
  const sampleRate = opts.sampleRate || 44100;
  let nodeSeq = 0, bufSeq = 0;
  const clock = { t: 0 };
  const contexts: unknown[] = [];

  function param(owner: string, name: string, init: number) {
    let value = init;
    const pid = owner + "." + name;
    const rec = (m: string, args: unknown[]): void => { trace.push(["p", pid, m, ...args.map(enc)]); };
    const p = {
      __pid: pid,
      get value() { return value; },
      set value(v: number) { value = v; trace.push(["v", pid, enc(v)]); },
      setValueAtTime(v: number, t: number) { value = v; rec("set", [v, t]); return p; },
      setTargetAtTime(v: number, t: number, tau: number) { value = v; rec("tgt", [v, t, tau]); return p; },
      linearRampToValueAtTime(v: number, t: number) { value = v; rec("lin", [v, t]); return p; },
      exponentialRampToValueAtTime(v: number, t: number) { value = v; rec("exp", [v, t]); return p; },
      cancelScheduledValues(t: number) { rec("cancel", [t]); return p; },
      cancelAndHoldAtTime(t: number) { rec("hold", [t]); return p; },
    };
    return p;
  }

  function buffer(ch: number, len: number, sr: number) {
    const id = "b" + (++bufSeq);
    trace.push(["buf", id, ch, len, sr]);
    const data: Float32Array[] = [];
    for (let i = 0; i < ch; i++) data.push(new Float32Array(len));
    return {
      __id: id, sampleRate: sr, length: len, duration: len / sr, numberOfChannels: ch,
      getChannelData: (c: number) => data[c] as Float32Array,
      copyToChannel: (src: Float32Array, c: number) => { (data[c] as Float32Array).set(src); },
    };
  }

  function node(kind: string) {
    const id = kind + (++nodeSeq);
    trace.push(["new", id]);
    const props: Record<string, unknown> = { type: "", loop: false, loopStart: 0, loopEnd: 0, buffer: null };
    const self: Record<string, unknown> = {
      __id: id,
      connect(target: { __id?: string; __pid?: string }) {
        trace.push(["c", id, target.__pid || target.__id || "?"]);
        return target.__pid ? undefined : target;
      },
      disconnect() { trace.push(["d", id]); },
      start(...a: unknown[]) { trace.push(["start", id, ...a.map(enc)]); },
      stop(...a: unknown[]) { trace.push(["stop", id, ...a.map(enc)]); },
      onended: null,
      fftSize: 0,
      frequencyBinCount: 0,
      smoothingTimeConstant: 0,
      getFloatFrequencyData() {},
      gain: param(id, "gain", 1), frequency: param(id, "frequency", 440), detune: param(id, "detune", 0),
      Q: param(id, "Q", 1), playbackRate: param(id, "playbackRate", 1), pan: param(id, "pan", 0),
      threshold: param(id, "threshold", -24), knee: param(id, "knee", 30), ratio: param(id, "ratio", 12),
      attack: param(id, "attack", 0.003), release: param(id, "release", 0.25),
    };
    for (const k of Object.keys(props)) {
      Object.defineProperty(self, k, {
        get: () => props[k],
        set: (v: unknown) => { props[k] = v; trace.push(["set", id, k, enc(v)]); },
        enumerable: true,
      });
    }
    return self;
  }

  // A deterministic engine-like drone, long enough for findStableLoop's 2 s window.
  function synthDrone() {
    const len = Math.floor(sampleRate * 3);
    const b = buffer(1, len, sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      d[i] = 0.6 * Math.sin(2 * Math.PI * 180 * t) + 0.3 * Math.sin(2 * Math.PI * 360 * t + 0.3) * (1 + 0.4 * Math.sin(2 * Math.PI * 0.7 * t));
    }
    return b;
  }

  function AudioContext(this: unknown) {
    const ctx = {
      __id: "ctx" + (contexts.length + 1),
      get currentTime() { return clock.t; },
      state: "running",
      sampleRate,
      onstatechange: null,
      destination: node("dest"),
      createGain: () => node("gain"),
      createBiquadFilter: () => node("biquad"),
      createOscillator: () => node("osc"),
      createBufferSource: () => node("src"),
      createAnalyser: () => node("analyser"),
      createConvolver: () => node("conv"),
      createStereoPanner: () => node("pan"),
      createDynamicsCompressor: () => node("comp"),
      createBuffer: (ch: number, len: number, sr: number) => buffer(ch, len, sr),
      decodeAudioData(_ab: unknown, res: (b: unknown) => void, rej: (e: unknown) => void) {
        trace.push(["decode", opts.decode]);
        if (opts.decode === "synth") res(synthDrone());
        else rej(new Error("fake: no decode"));
      },
      resume: () => Promise.resolve(),
      suspend: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    contexts.push(ctx);
    trace.push(["ctx", ctx.__id]);
    return ctx;
  }

  const fetchStub = (url: string) => {
    trace.push(["fetch", url.replace(/^.*\//, "")]);
    return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
  };

  return { AudioContext, fetch: fetchStub, clock, contexts };
}

/**
 * The soundtrack surface engine.js calls, recorded. f1-game destructures
 * every playlist member off it, so the no-op ones are here too.
 */
export function createMusicRecorder(trace: TraceEntry[]) {
  const rec = (name: string, args: unknown[]): void => { trace.push(["music", name, ...args.map(enc)]); };
  const noop = () => undefined;
  return {
    duckForEngine(rev: number, t: number) { rec("duckForEngine", [rev, t]); },
    releaseEngineDuck(t: number, useRadio: boolean) { rec("releaseEngineDuck", [t, useRadio]); },
    setRadioDuck(on: boolean) { rec("setRadioDuck", [on]); return on ? 0.35 : 1; },
    isPlaying: () => false, lastTrack: () => -1, suspendMusic: noop, resumeMusic: noop, resetContext: noop,
    musicPlaybackGeneration: () => 0, volume: () => 0.5, startMusic: noop, stopMusic: noop,
    setMusicEnabled: noop, skipTrack: noop, prevTrack: noop, trackName: () => "", tracks: () => [],
    addTracks: noop, removeTrack: noop, playTrackId: () => false, currentTrackId: () => null,
    setMusicBackend: noop, musicBackend: noop, setMusicSource: noop, musicSource: noop,
    sourceCounts: () => ({}), setMusicVolume: () => 0.5, stopMusicIfGeneration: () => false,
  };
}
