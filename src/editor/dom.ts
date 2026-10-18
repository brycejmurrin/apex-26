/**
 * The one DOM helper the editor uses: f1-game js/ui/dom.js:11 `Dom.el`.
 * TODO(lane-shell): move to src/app/ if the shell ports Dom.
 */

/** Create an element with an optional class name and text. dom.js:11 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: unknown): HTMLElementTagNameMap[K];
export function el(tag: string, cls?: string | null, text?: unknown): HTMLElement;
export function el(tag: string, cls?: string | null, text?: unknown): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}
