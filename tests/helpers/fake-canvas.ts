// A recording fake of the Canvas 2D API (src/car/livery-canvas.ts's subset), so the
// livery atlas painters can run in Node and be compared call for call against
// f1-game's originals in a VM. Every method call is logged as [name, ...args],
// every property write as ["=prop", value]; gradients and canvases are logged by
// id. Readable state (globalAlpha, strokeStyle, ...) follows save()/restore() the
// way a real context does, because f1-game reads some of it back. measureText is
// a deterministic function of the font's px size and the text, identical on both
// sides, so the fit walks in drawWordmark / drawNumber take the same steps.
import type { LiveryCanvas, LiveryCtx2D, LiveryGradient } from "../../src/car/livery-canvas";

export type LogEntry = (string | number | boolean | null | undefined)[];

const STATE_KEYS = [
  "fillStyle", "strokeStyle", "lineWidth", "lineCap", "lineJoin", "miterLimit", "font", "textAlign", "textBaseline",
  "textRendering", "globalAlpha", "globalCompositeOperation", "shadowColor", "shadowBlur", "imageSmoothingEnabled",
  "imageSmoothingQuality",
] as const;
type StateKey = (typeof STATE_KEYS)[number];

const DEFAULTS: Record<StateKey, unknown> = {
  fillStyle: "#000000", strokeStyle: "#000000", lineWidth: 1, lineCap: "butt", lineJoin: "miter", miterLimit: 10,
  font: "10px sans-serif", textAlign: "start", textBaseline: "alphabetic", textRendering: "auto", globalAlpha: 1,
  globalCompositeOperation: "source-over", shadowColor: "rgba(0, 0, 0, 0)", shadowBlur: 0, imageSmoothingEnabled: true,
  imageSmoothingQuality: "low",
};

/** Deterministic advance: px * (0.48 + (code % 9) * 0.035) per character. */
export function fakeAdvance(font: string, text: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  const px = m ? Number(m[1]) : 10;
  let w = 0;
  for (let i = 0; i < text.length; i++) w += px * (0.48 + (text.charCodeAt(i) % 9) * 0.035);
  return w;
}

export interface Recorder {
  log: LogEntry[];
  /** The factory to inject (configureLiveryTex createCanvas / the VM's document.createElement). */
  createCanvas(): LiveryCanvas;
  canvases: LiveryCanvas[];
}

function tag(v: unknown): string | number | boolean | null | undefined {
  if (v === null || v === undefined || typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  const id = (v as { __fakeId?: string }).__fakeId;
  if (id) return "<" + id + ">";
  return "<" + typeof v + ">";
}

export function createRecorder(): Recorder {
  const log: LogEntry[] = [];
  let canvasN = 0, gradN = 0;
  const canvases: LiveryCanvas[] = [];

  function makeGradient(kind: string, args: number[]): LiveryGradient {
    const id = "grad" + gradN++;
    log.push([kind, ...args, "->" + id]);
    return Object.assign(Object.create(null) as object, {
      __fakeId: id,
      addColorStop(offset: number, color: string) { log.push([id + ".addColorStop", offset, color]); },
    }) as LiveryGradient;
  }

  function makeCtx(canvasId: string): LiveryCtx2D {
    let state: Record<string, unknown> = { ...DEFAULTS };
    const stack: Record<string, unknown>[] = [];
    const rec = (name: string) => (...args: unknown[]) => { log.push([name, ...args.map(tag)]); };
    const ctx: Record<string, unknown> = {
      __fakeId: canvasId + ".ctx",
      save() { log.push(["save"]); stack.push({ ...state }); },
      restore() { log.push(["restore"]); const s = stack.pop(); if (s) state = s; },
      beginPath: rec("beginPath"), closePath: rec("closePath"), moveTo: rec("moveTo"), lineTo: rec("lineTo"),
      arc: rec("arc"), arcTo: rec("arcTo"), ellipse: rec("ellipse"), quadraticCurveTo: rec("quadraticCurveTo"),
      rect: rec("rect"), fillRect: rec("fillRect"), strokeRect: rec("strokeRect"), fill: rec("fill"), stroke: rec("stroke"),
      clip: rec("clip"), translate: rec("translate"), rotate: rec("rotate"), scale: rec("scale"),
      transform: rec("transform"), setTransform: rec("setTransform"),
      fillText: rec("fillText"), strokeText: rec("strokeText"), drawImage: rec("drawImage"),
      measureText(text: string) {
        const width = fakeAdvance(String(state["font"]), String(text));
        log.push(["measureText", text, width]);
        return { width };
      },
      createLinearGradient: (...a: number[]) => makeGradient("createLinearGradient", a),
      createRadialGradient: (...a: number[]) => makeGradient("createRadialGradient", a),
      getImageData(sx: number, sy: number, sw: number, sh: number) {
        log.push(["getImageData", sx, sy, sw, sh]);
        return { data: new Uint8ClampedArray(sw * sh * 4) };
      },
    };
    for (const k of STATE_KEYS) {
      Object.defineProperty(ctx, k, {
        get: () => state[k],
        set: (v: unknown) => { log.push(["=" + k, tag(v)]); state[k] = v; },
        enumerable: true,
      });
    }
    return ctx as unknown as LiveryCtx2D;
  }

  function createCanvas(): LiveryCanvas {
    const id = "canvas" + canvasN++;
    log.push(["createCanvas", id]);
    let w = 300, h = 150, ctx: LiveryCtx2D | null = null;
    const c = {
      __fakeId: id,
      get width() { return w; },
      set width(v: number) { log.push([id + ".width", v]); w = v; },
      get height() { return h; },
      set height(v: number) { log.push([id + ".height", v]); h = v; },
      getContext(kind: string, opts?: unknown) {
        log.push([id + ".getContext", kind, opts === undefined ? undefined : JSON.stringify(opts)]);
        if (!ctx) ctx = makeCtx(id);
        return ctx;
      },
    };
    canvases.push(c as LiveryCanvas);
    return c as LiveryCanvas;
  }

  return { log, createCanvas, canvases };
}

/** FNV-1a over a draw log: numbers by their Float64 bits, strings by UTF-16 units, with type tags. */
export function hashLog(log: readonly LogEntry[]): string {
  const dv = new DataView(new ArrayBuffer(8));
  let h = 0x811c9dc5;
  const byte = (b: number) => { h = Math.imul(h ^ (b & 0xff), 0x01000193); };
  for (const e of log) {
    byte(0xfe);
    for (const v of e) {
      if (typeof v === "number") { byte(1); dv.setFloat64(0, v); for (let i = 0; i < 8; i++) byte(dv.getUint8(i)); }
      else if (typeof v === "string") { byte(2); for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); byte(c); byte(c >> 8); } byte(0); }
      else if (typeof v === "boolean") byte(v ? 3 : 4);
      else if (v === null) byte(5);
      else byte(6);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The first entry where two logs differ (numbers by Object.is), or null when identical. */
export function firstDiff(a: readonly LogEntry[], b: readonly LogEntry[]): { at: number; mine: LogEntry | undefined; ref: LogEntry | undefined } | null {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (!x || !y || x.length !== y.length || x.some((v, k) => !Object.is(v, y[k]))) return { at: i, mine: x, ref: y };
  }
  return null;
}
