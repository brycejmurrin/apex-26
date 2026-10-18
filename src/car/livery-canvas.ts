// The slice of the Canvas 2D API the livery atlas painters use (f1-game
// js/car/liverytex.js, crest-draw.js, livery-graphics.js, livery-design.js). The
// painters never touch a DOM global: the canvas comes from an injected factory, so
// they run in the browser on an HTMLCanvasElement / OffscreenCanvas and in Node
// tests on a recording fake. Both DOM contexts satisfy these interfaces
// (tests/unit/car-liverytex.test.ts asserts it at compile time).

/** CanvasGradient's one method. */
export interface LiveryGradient {
  addColorStop(offset: number, color: string): void;
}

/** A fill / stroke style: a CSS colour string or a gradient (or a pattern the
 *  painters never create, but may read back from `strokeStyle`). */
export type LiveryPaintStyle = string | object;

/** Anything drawImage takes: an uploaded emblem image or a scratch canvas. */
export type LiveryDrawable = object;

/** The CanvasRenderingContext2D members the livery painters use, and no more. */
export interface LiveryCtx2D {
  fillStyle: LiveryPaintStyle;
  strokeStyle: LiveryPaintStyle;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  miterLimit: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  /** Absent on older canvases (f1-game wraps the write in try). */
  textRendering?: string;
  globalAlpha: number;
  globalCompositeOperation: string;
  shadowColor: string;
  shadowBlur: number;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw?: boolean): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fill(rule?: "nonzero" | "evenodd"): void;
  stroke(): void;
  clip(rule?: "nonzero" | "evenodd"): void;
  translate(x: number, y: number): void;
  rotate(a: number): void;
  scale(x: number, y: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  measureText(text: string): { readonly width: number };
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): LiveryGradient;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): LiveryGradient;
  drawImage(image: LiveryDrawable, dx: number, dy: number, dw: number, dh: number): void;
  getImageData?(sx: number, sy: number, sw: number, sh: number): { readonly data: ArrayLike<number> };
}

/** A canvas: HTMLCanvasElement, OffscreenCanvas, or a test fake. */
export interface LiveryCanvas {
  width: number;
  height: number;
  getContext(id: "2d", opts?: { willReadFrequently?: boolean }): LiveryCtx2D | null;
}

/** Makes a fresh canvas; f1-game's `document.createElement("canvas")`. The caller
 *  sets width / height afterwards, in that order, then asks for the context. */
export type LiveryCanvasFactory = () => LiveryCanvas;

/** An atlas region / box in canvas pixels (liverytex.js REGIONS). */
export interface LiveryRect { x: number; y: number; w: number; h: number }

/** fit()'s unit-box mapping (liverytex.js:392-402). */
export interface LiveryFit { X(u: number): number; Y(v: number): number; S(d: number): number }

/** A linear RGB colour as the atlas handles it: f1-game's [r, g, b] arrays, read
 *  only. Inputs (Vec3 / Rgb tuples) are assignable; `.slice()` copies come back as
 *  number[]. */
export type LiveryColour = readonly number[];
