/**
 * The enumerated-preference row (LABEL  ‹ VALUE ›) the camera settings folds
 * build at runtime: the subset of f1-game js/ui/setting-row.js:33-263
 * (SettingRow) that js/camera/cockpit-opts.js:242-251 and feel.js:401-407 call
 * (`build`, `wire`, `paint`, `labels`), ported verbatim with the `_srKey` /
 * `_srLive` expandos kept in WeakMaps instead of on the element.
 *
 * TODO(lane-shell): when the shell ports SettingRow app-wide, the camera folds
 * should take it from there; the DOM contract (ids `X`, `X-label`, `X-sel`,
 * `X-prev`, `X-next`, class `set-row`) is f1-game's, so the swap is drop-in.
 */

/** [value, label, disabled?] */
export type RowOption = readonly [value: string, label: string, disabled?: boolean];

export interface RowParts { el: HTMLElement; sel: HTMLSelectElement | null; prev: HTMLButtonElement | null; next: HTMLButtonElement | null }

interface Live { read: () => string; write: (v: string) => void; wrap: boolean }
const srKey = new WeakMap<HTMLSelectElement, string>();
const srLive = new WeakMap<HTMLSelectElement, Live>();
const S = (v: unknown): string => String(v);

function parts(el: HTMLElement): RowParts {
  const p: RowParts = { el, sel: null, prev: null, next: null };
  const walk = (n: Element): void => {
    for (const c of Array.from(n.children)) {
      if (c.tagName === "SELECT") p.sel = c as HTMLSelectElement;
      else if (c.tagName === "BUTTON") {
        const step = c.getAttribute("data-step");
        if (step === "-1") p.prev = c as HTMLButtonElement;
        else if (step === "1") p.next = c as HTMLButtonElement;
      }
      if (c.tagName !== "SELECT" && c.children.length) walk(c);
    }
  };
  walk(el);
  return p;
}

/* Rebuild the options only when the list actually changed (labels included —
   GRAPHICS appends "— RELOADING…" to one). */
function fill(sel: HTMLSelectElement, values: readonly RowOption[]): void {
  const key = values.map((p) => `${S(p[0])}=${S(p[1])}${p[2] ? "!" : ""}`).join("|");
  if (srKey.get(sel) === key) return;
  srKey.set(sel, key);
  sel.replaceChildren();
  for (const [v, label, disabled] of values) {
    const o = sel.ownerDocument.createElement("option");
    o.value = S(v);
    o.textContent = S(label);
    if (disabled) o.disabled = true;
    sel.appendChild(o);
  }
}

function options(sel: HTMLSelectElement | null): HTMLOptionElement[] {
  const out: HTMLOptionElement[] = [];
  for (const o of Array.from(sel ? sel.children : [])) if (o.tagName === "OPTION") out.push(o as HTMLOptionElement);
  return out;
}

function wraps(p: RowParts): boolean {
  const live = p.sel ? srLive.get(p.sel) : undefined;
  return !(live && live.wrap === false);
}

/* LAPS (and any wrap:false row): dim the chevron that would leave the list
   instead of jumping 3 → FULL. paint() and disable() both land here so a
   later option-list rebuild keeps the ends honest. */
function paintEnds(p: RowParts): void {
  if (wraps(p) || !p.sel || p.sel.disabled) return;
  const live = options(p.sel).filter((o) => !o.disabled).map((o) => o.value);
  const i = live.indexOf(S(p.sel.value));
  if (p.prev) p.prev.disabled = i <= 0;
  if (p.next) p.next.disabled = i < 0 || i >= live.length - 1;
}

/* Show `value`. `values` (optional) refreshes the option list first. */
export function paintSettingRow(el: HTMLElement, value: unknown, values?: readonly RowOption[]): void {
  const p = parts(el);
  if (!p.sel) return;
  if (values) fill(p.sel, values);
  p.sel.value = S(value);
  paintEnds(p);
}

/* Walk the FULL list from the current option, skipping disabled ones.
   wrap:false (LAPS) stops at the ends instead of 3 ↔ FULL. */
function step(p: RowParts, dir: number, read: () => string, write: (v: string) => void): void {
  const all = options(p.sel);
  const n = all.length;
  if (!all.some((o) => !o.disabled)) return;
  const cur = S(read());
  let i = all.findIndex((o) => o.value === cur);
  if (i < 0) i = dir > 0 ? -1 : 0;   // an unlisted value: › the first, ‹ the last
  const wrap = wraps(p);
  for (let k = 1; k <= n; k++) {
    const j = i + dir * k;
    if (!wrap && (j < 0 || j >= n)) break;
    const o = all[wrap ? ((j % n) + n) % n : j];
    if (!o || o.disabled) continue;
    if (o.value !== cur) write(o.value);
    break;
  }
  paintSettingRow(p.el, read());
}

/* The chevrons are pointer affordances for the native <select>, not a second
   pair of controls. */
function pointerOnly(p: RowParts): void {
  for (const x of [p.prev, p.next]) {
    if (!x) continue;
    x.tabIndex = -1;
    x.setAttribute("aria-hidden", "true");
  }
}

/* opts: { values: [[v, label, disabled?], …], read(): v, write(v) } */
export function wireSettingRow(el: HTMLElement, opts: { values?: readonly RowOption[]; read: () => string; write: (v: string) => void; wrap?: boolean }): HTMLElement | null {
  const p = parts(el);
  const sel = p.sel;
  if (!sel) return null;
  if (opts.values) fill(sel, opts.values);
  /* Re-wiring must not stack listeners: one "change" listener per select,
     which reads the LATEST read/write so a later wire with new callbacks still wins. */
  const read = opts.read;
  const write = opts.write;
  const fresh = !srLive.has(sel);
  srLive.set(sel, { read, write, wrap: opts.wrap !== false });
  if (fresh) sel.addEventListener("change", (e) => {
    e.stopPropagation();
    const cur = srLive.get(sel);
    if (!cur) return;
    const v = sel.value;
    if (v !== S(cur.read())) cur.write(v);
    paintSettingRow(p.el, cur.read());
  });
  if (p.prev) p.prev.onclick = (e) => { e.stopPropagation(); step(p, -1, read, write); };
  if (p.next) p.next.onclick = (e) => { e.stopPropagation(); step(p, 1, read, write); };
  pointerOnly(p);
  paintSettingRow(p.el, read());
  return p.el;
}

/* Build the same row for a setting the JS creates at runtime. Returns
   { row, label, sel, prev, next }; the caller places `row` and wires it. */
export function buildSettingRow(d: Document, id: string, labelText: string, values?: readonly RowOption[]) {
  const row = d.createElement("div");
  row.id = id;
  row.className = "set-row";
  row.setAttribute("role", "group");
  const labelId = `${id}-label`;
  row.setAttribute("aria-labelledby", labelId);
  const label = d.createElement("span");
  label.className = "tune-label";
  label.id = labelId;
  label.textContent = labelText;
  const ctl = d.createElement("div");
  const prev = d.createElement("button");
  prev.id = `${id}-prev`;
  prev.type = "button";
  prev.setAttribute("data-step", "-1");
  prev.setAttribute("aria-label", `Previous ${labelText.toLowerCase()}`);
  prev.textContent = "‹";
  const sel = d.createElement("select");
  sel.id = `${id}-sel`;
  sel.setAttribute("aria-labelledby", labelId);
  const next = d.createElement("button");
  next.id = `${id}-next`;
  next.type = "button";
  next.setAttribute("data-step", "1");
  next.setAttribute("aria-label", `Next ${labelText.toLowerCase()}`);
  next.textContent = "›";
  ctl.appendChild(prev);
  ctl.appendChild(sel);
  ctl.appendChild(next);
  row.appendChild(label);
  row.appendChild(ctl);
  if (values) fill(sel, values);
  return { row, label, sel, prev, next };
}

/* [["auto", "AUTO"], …] from a plain value list. */
export const labels = (list: readonly string[]): RowOption[] => list.map((v) => [v, S(v).toUpperCase()] as const);
