// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as CssZoom from "../../src/styles/css-zoom";

const css = (f: string) => readFileSync(resolve(process.cwd(), "src/styles", f), "utf8");

describe("src/styles", () => {
  it("declares the cascade layers before any rule, in f1-game's order", () => {
    const t = css("tokens.css");
    const decl = t.indexOf("@layer reset, base, components, hud, overlays;");
    expect(decl).toBeGreaterThan(-1);
    expect(t.slice(0, decl)).not.toMatch(/\{/);   // only comments before it
  });

  it("points every @font-face at a bundled font file", () => {
    for (const f of ["tokens.css", "fonts-hud.css"]) {
      for (const m of css(f).matchAll(/url\("(\.\/fonts\/[^"]+)"\)/g)) {
        expect(() => readFileSync(resolve(process.cwd(), "src/styles", m[1]!))).not.toThrow();
      }
      expect(css(f)).not.toMatch(/\.\.\/assets\//);
    }
  });

  it("keeps each sheet inside its layer", () => {
    expect(css("components.css")).toMatch(/^\/\*[^]*?\*\/\n@layer components \{/);
    expect(css("responsive.css")).toMatch(/^\/\*[^]*?\*\/\n@layer overlays \{/);
    expect(css("fonts-hud.css")).toMatch(/^\/\*[^]*?\*\/\n@layer hud \{/);
  });
});

describe("CssZoom", () => {
  afterEach(() => CssZoom._resetProbe());
  const box = (x: number, y: number, w: number, h: number, zoom?: number) => {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => new DOMRect(x, y, w, h);
    if (zoom !== undefined) Object.defineProperty(el, "currentCSSZoom", { value: zoom });
    return el;
  };

  it("reads currentCSSZoom, defaulting to 1", () => {
    expect(CssZoom.of(null)).toBe(1);
    expect(CssZoom.of(box(0, 0, 1, 1))).toBe(1);
    expect(CssZoom.of(box(0, 0, 1, 1, 1.5))).toBe(1.5);
    expect(CssZoom.of(box(0, 0, 1, 1, 0))).toBe(1);
  });

  it("converts between local and viewport rects when the engine reports local boxes", () => {
    // happy-dom does no layout: the probe reads 0 wide, i.e. "rects are local" (old WebKit).
    expect(CssZoom.rectsAreVisual()).toBe(false);
    const el = box(10, 20, 100, 50, 2);
    expect(CssZoom.viewportRect(el)).toMatchObject({ x: 20, y: 40, width: 200, height: 100 });
    expect(CssZoom.localRect(el)).toMatchObject({ x: 10, y: 20, width: 100, height: 50 });
    expect(CssZoom.toLocalDelta(el, 30)).toBe(15);
  });
});
