/**
 * CssZoom — one place for zoom ↔ viewport ↔ local conversions. Ported from
 * f1-game js/ui/css-zoom.js:1-64.
 *
 * Four subtrees carry `zoom: var(--ui-scale)` (every `.sheet`, `#overlay > *`,
 * `.dh-card`). Inside a zoomed subtree CSS lengths are LOCAL;
 * getBoundingClientRect on Chromium / modern Safari returns VISUAL (zoomed)
 * pixels; pre-26.4 WebKit returned LOCAL. Mixing a visual rect with
 * `clientWidth` or `scrollTop` is a bug class of its own.
 *
 * Prefer `clientWidth` / `clientHeight` for the element's own box in local
 * units — they never need a probe. `viewportRect` mixes with `clientX`/`clientY`
 * or an unzoomed canvas; `toLocalDelta` turns wheel deltas into `scrollTop`.
 */

let visualCached: boolean | null = null;

// Probe once: does gBCR already include zoom? A 100×50 box at zoom 2 paints
// 200×100 visual on engines that scale the rect; old WebKit reports 100×50.
export function rectsAreVisual(): boolean {
  if (visualCached != null) return visualCached;
  try {
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;left:0;top:0;width:100px;height:50px;zoom:2;visibility:hidden;pointer-events:none";
    document.documentElement.appendChild(el);
    const r = el.getBoundingClientRect();
    document.documentElement.removeChild(el);
    visualCached = Math.abs(r.width - 200) < 2;
  } catch {
    visualCached = true; // Chromium-default assumption
  }
  return visualCached;
}

/** The effective CSS zoom of `el` (1 when the engine has no `currentCSSZoom`). */
export function of(el: Element | null | undefined): number {
  if (!el) return 1;
  const z = (el as Element & { currentCSSZoom?: unknown }).currentCSSZoom;
  return (typeof z === "number" && z > 0) ? z : 1;
}

export function viewportRect(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  const z = of(el);
  if (rectsAreVisual() || z === 1) return r;
  return new DOMRect(r.x * z, r.y * z, r.width * z, r.height * z);
}

export function localRect(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  const z = of(el);
  if (!rectsAreVisual() || z === 1) return r;
  return new DOMRect(r.x / z, r.y / z, r.width / z, r.height / z);
}

// Always local — preferred for thresholds compared against CSS lengths.
export function localBox(el: Element): { w: number; h: number } {
  return { w: el.clientWidth, h: el.clientHeight };
}

export function toLocalDelta(el: Element, viewportPx: number): number {
  return viewportPx / of(el);
}

/** Test hook: forget the probe result. */
export function _resetProbe(): void { visualCached = null; }
