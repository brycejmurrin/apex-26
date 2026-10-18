/**
 * The DOM and format helpers the Data Hub tabs use. Ported from f1-game
 * js/ui/dom.js:11-16 (el), :32-38 (fmtLap), :45-52 (fmtRaceClock). The shell
 * lane owns src/app/ UI helpers; these stay local so src/data/ has no
 * dependency on another lane's directory.
 */

/** The one createElement helper: tag, class, text (dom.js:11). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: unknown): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// A lap time in seconds as 1:21.163 (58.402 under the minute). Anything that
// is not a positive finite number returns `empty`, which the caller chooses.
export function fmtLap<E = null>(t: unknown, empty: E = null as E): string | E {
  if (typeof t !== "number" || !isFinite(t) || t <= 0) return empty;
  const ms = Math.round(t * 1000), m = Math.floor(ms / 60000);   // round first: never "1:60.000"
  const r = (ms - m * 60000) / 1000;
  const secs = `${r < 10 ? "0" : ""}${r.toFixed(3)}`;
  return m ? `${m}:${secs}` : r.toFixed(3);
}

// A RACE-LENGTH clock: 1:32:14.530 past the hour, 59:59.999 under it, 0:59.999
// under the minute. ROUND FIRST, then split. Not a finite number >= 0 → null.
export function fmtRaceClock(t: unknown, digits = 3): string | null {
  if (typeof t !== "number" || !isFinite(t) || t < 0) return null;
  const k = Math.pow(10, digits);
  const u = digits ? Math.round(t * k) : Math.floor(t);
  const h = Math.floor(u / (3600 * k)), m = Math.floor((u - h * 3600 * k) / (60 * k));
  const r = (u - h * 3600 * k - m * 60 * k) / k;
  return (h ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (r < 10 ? "0" : "") + r.toFixed(digits);
}

/** Tyre compound letter for COLOURBLIND CUES (f1-game js/ui/a11y-opts.js:90-98). */
export function compoundLetter(name: unknown): string {
  const n = String(name || "").toUpperCase();
  if (n.indexOf("SOFT") === 0 || n === "S") return "S";
  if (n.indexOf("MED") === 0 || n === "M") return "M";
  if (n.indexOf("HARD") === 0 || n === "H") return "H";
  if (n.indexOf("INTER") === 0 || n === "I" || n === "INT") return "I";
  if (n.indexOf("WET") === 0 || n === "W") return "W";
  return n ? n.charAt(0) : "";
}
