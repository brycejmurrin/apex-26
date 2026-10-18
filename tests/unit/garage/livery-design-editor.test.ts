// @vitest-environment happy-dom
// The livery design editor (src/garage/livery-design-editor.ts), driven the way
// f1-game tests/unit/livery-design.test.mjs:163-299 drives the original: a
// root with the sheet's own pill rows, f1-game's LiveryDesign
// (js/car/livery-design.js, the car lane's module) injected as the design, and
// the editor's assertions ported one for one. Needs /home/f1-game for the
// design module; skipped without it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createLiveryDesignEditor, type LiveryDesignLike, type LiveryDraft } from "../../../src/garage/livery-design-editor";
import { F1_ROOT, hasF1 } from "../data/f1-vm";

const hasDesign = hasF1 && (() => { try { readFileSync(path.join(F1_ROOT, "js/car/livery-design.js")); return true; } catch { return false; } })();
function loadDesign(): LiveryDesignLike {
  const ctx = createContext({});
  runInContext(readFileSync(path.join(F1_ROOT, "js/car/livery-design.js"), "utf8"), ctx);
  return runInContext("LiveryDesign", ctx) as LiveryDesignLike;
}
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function editorFixture() {
  const D = loadDesign(), E = createLiveryDesignEditor(D), root = document.createElement("div");
  document.body.appendChild(root);
  const draft: LiveryDraft = { name: "Mine", c1: "#000000", c2: "#ffffff", spineLogo: "stripe", patternWidth: "70", patternRepeat: "6", patternOffset: "0", patternTaper: "20", patternOpacity: "100", patternPlacement: "crown", patternSide: "both" };
  const previews: LiveryDraft[] = []; let editor: { changed(drag?: boolean): void } | undefined;
  const changed = (drag?: boolean): void => { editor?.changed(drag); previews.push(plain(draft)); };
  // setup-sheet.ts buildLiveryCreator's pillRow, as the f1-game test lifts it from the sheet.
  const pillRow = (label: string, key: string, values: readonly string[], dflt: string): HTMLElement => {
    const r = document.createElement("div"); r.className = "cs-liv-ed-row";
    const lb = document.createElement("span"); lb.className = "cs-liv-ed-lbl"; lb.textContent = label; r.appendChild(lb);
    const group = document.createElement("span"); group.className = "cs-liv-ed-finish";
    group.setAttribute("role", "group"); group.setAttribute("aria-label", label);
    const btns: HTMLButtonElement[] = [];
    for (const f of values) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cs-liv-ed-none" + ((draft[key] || dflt) === f ? " active" : "");
      if (key === "finish") b.dataset["csFinish"] = f; else b.dataset["csPill"] = key + ":" + f;
      b.textContent = E.label(f).toUpperCase();
      b.setAttribute("aria-pressed", String((draft[key] || dflt) === f));
      b.onclick = () => {
        draft[key] = f;
        for (const other of btns) { const on = other === b; other.classList.toggle("active", on); other.setAttribute("aria-pressed", String(on)); }
        changed();
      };
      btns.push(b); group.appendChild(b);
    }
    r.appendChild(group); root.appendChild(r);
    return r;
  };
  const bodyRow = document.createElement("label"); root.appendChild(bodyRow);
  const spineRow = pillRow("SPINE TOP", "spineLogo", ["stripe", ...D.PATTERNS], "stripe");
  const nextRow = pillRow("COVER BIND", "coverBind", ["independent", "saddleWrap", "spineOnly"], "independent");
  const nameRow = document.createElement("label"); root.appendChild(nameRow);
  editor = E.attach(root, draft, { flush() {}, changed, preview(value) { previews.push(plain(value)); },
    pillRow, spineRow, bodyRow, nameRow });
  const all = <T extends Element>(sel: string): T[] => Array.from(root.querySelectorAll<T>(sel));
  const click = (text: string): void => {
    const b = all<HTMLButtonElement>("button").find((x) => x.textContent === text);
    expect(b, text).toBeTruthy(); expect(b!.disabled, text + " enabled").toBe(false); (b!.onclick as (e: Event) => void)(new Event("click"));
  };
  const input = (key: string): HTMLInputElement => all<HTMLInputElement>("input").find((el) => el.dataset["livField"] === key)!;
  return { root, draft, editor: editor!, previews, click, spineRow, nextRow, bodyRow, nameRow, D, all, input, E };
}
const fire = (el: HTMLInputElement, k: "oninput" | "onchange"): void => { (el[k] as (e: Event) => void)(new Event(k.slice(2))); };

describe.skipIf(!hasDesign)("GarageLiveryDesignEditor (livery-design.test.mjs:163-299)", () => {
  it("existing SPINE TOP controls drive undo, palettes and pattern adjustments without duplicate menus", () => {
    const { root, draft, editor, previews, click, spineRow, nextRow, nameRow, D, all, input } = editorFixture();
    expect(all("select, details").length, "no parallel design, surface or preset menus").toBe(0);
    expect(all("[data-liv-design-tools]").length).toBe(0);
    expect(spineRow.querySelectorAll("button").length, "all adjustable patterns share the existing SPINE TOP row").toBe(D.PATTERNS.length + 1);
    const rows = Array.from(root.children), width = input("patternWidth");
    expect(rows.indexOf(width.parentNode as Element)).toBeGreaterThan(rows.indexOf(spineRow));
    expect(rows.indexOf(width.parentNode as Element), "adjustments stay after SPINE TOP and before cover-side controls").toBeLessThan(rows.indexOf(nextRow));
    expect(all<HTMLButtonElement>("button").find((b) => b.textContent === "MIDNIGHT ELECTRIC")!.parentNode!.parentNode as Element)
      .toSatisfy((el: Element) => el.getAttribute("data-liv-section") === "COLOUR PALETTE");
    expect((rows[rows.indexOf(nameRow) - 1] as Element).getAttribute("role")).toBe("status");
    expect(width.disabled, "legacy patterns retain their existing controls").toBe(true);
    click("CONTOUR LINES");
    expect(draft["spineLogo"]).toBe("contours"); expect(width.disabled).toBe(false);
    click("UNDO"); expect(draft["spineLogo"]).toBe("stripe"); expect(width.disabled).toBe(true);
    click("REDO"); expect(draft["spineLogo"]).toBe("contours");
    click("COMPARE ORIGINAL"); expect(previews.at(-1)!["spineLogo"]).toBe("stripe"); expect(draft["spineLogo"]).toBe("contours");
    click("SHOW EDITED"); expect(previews.at(-1)!["spineLogo"]).toBe("contours");
    click("COMPARE ORIGINAL"); draft["name"] = "Renamed"; editor.changed(true);
    expect(previews.at(-1)!["spineLogo"], "metadata edits also leave comparison with the edited preview").toBe("contours");
    click("MIDNIGHT ELECTRIC"); const paletteColor = draft["c1"];
    draft["c1"] = "#010101"; editor.changed(); click("MIDNIGHT ELECTRIC");
    expect(draft["c1"], "same palette reapplies after manual edits").toBe(paletteColor);
    click("CHECKERED FLAG");
    const first = draft["patternTint"], second = draft["patternSecond"];
    click("SWAP COLOURS"); expect(draft["patternTint"]).toBe(second); expect(draft["patternSecond"]).toBe(first);
    click("UNDO"); expect(draft["patternTint"]).toBe(first);
    width.value = "90"; fire(width, "oninput"); fire(width, "onchange"); click("WRAP"); click("LEFT");
    expect(draft["patternSide"]).toBe("left");
    click("RESET SETTINGS"); expect(draft["patternWidth"]).toBe("70"); expect(draft["patternPlacement"]).toBe("crown");
    click("UNDO"); expect(draft["patternWidth"]).toBe("90"); expect(draft["patternPlacement"]).toBe("wrap");
  });

  it("integrated adjustments disable only controls unused by the current spine design", () => {
    const { all, click, input } = editorFixture();
    const repeat = input("patternRepeat");
    const left = all<HTMLButtonElement>("button").find((b) => b.textContent === "LEFT")!;
    click("GRADIENT"); expect(repeat.disabled).toBe(true); expect(left.disabled).toBe(true);
    click("WRAP"); expect(left.disabled).toBe(false);
    click("HONEYCOMB"); expect(repeat.disabled).toBe(false);
    click("STRIPE"); expect(repeat.disabled).toBe(true); expect(left.disabled).toBe(true);
    expect((repeat.parentNode as HTMLElement).title).toContain("SPINE TOP");
  });

  it("surface sections and spine families preserve one button per choice and label their scope", () => {
    const { all, spineRow, D } = editorFixture();
    const headings = all('[role="heading"]').map((el) => el.textContent);
    for (const title of ["BODY PAINT & BASE FINISH", "ENGINE COVER — SHAPE & PAINT", "SPINE TOP — ARTWORK & COLOURS", "WINGS", "TAIL FIN", "TEAM MARKS & NUMBERS", "COCKPIT & CAMERA", "REVIEW & SAVE"])
      expect(headings, title).toContain(title);
    expect(spineRow.getAttribute("data-liv-section")).toBe("SPINE TOP — ARTWORK & COLOURS");
    expect(spineRow.querySelector('[role="group"]')!.getAttribute("aria-label")).toBe("SPINE TOP");
    expect(Array.from(spineRow.querySelectorAll(".cs-liv-ed-sec")).map((el) => el.textContent)).toEqual(["MARKS & IDENTITY", "FIXED GRAPHICS", "ADJUSTABLE PATTERNS"]);
    const ids = Array.from(spineRow.querySelectorAll<HTMLElement>("button")).map((b) => b.dataset["csPill"]);
    expect(ids.length).toBe(D.PATTERNS.length + 1); expect(new Set(ids).size, "grouping moves original buttons without duplication").toBe(ids.length);
    const swatches = all(".cs-liv-swatch");
    expect(swatches.length).toBe(D.PALETTES.length); expect(swatches.every((s) => s.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("new design controls support undo, redo, reset and meaningful line-weight availability", () => {
    const { draft, click, input } = editorFixture();
    click("WAVE BANDS");
    for (const [key, value] of [["patternRotation", "35"], ["patternStretch", "150"], ["patternWeight", "175"]] as const) {
      const el = input(key); expect(el.disabled).toBe(false); el.value = value; fire(el, "oninput"); fire(el, "onchange");
      expect(draft[key]).toBe(value); click("UNDO"); expect(draft[key]).not.toBe(value); click("REDO"); expect(draft[key]).toBe(value);
    }
    click("RESET SETTINGS"); expect(draft["patternRotation"]).toBe("0"); expect(draft["patternStretch"]).toBe("100"); expect(draft["patternWeight"]).toBe("100");
    click("UNDO"); expect(draft["patternRotation"]).toBe("35"); expect(draft["patternWeight"]).toBe("175");
    click("ANGULAR SHARDS"); expect(input("patternWeight").disabled).toBe(true);
    click("CIRCUIT TRACES"); expect(input("patternWeight").disabled).toBe(false);
  });

  it("range readouts carry their unit and the label falls back to LiveryDesign.LABELS, then the id", () => {
    const { input, click, E } = editorFixture();
    click("WAVE BANDS");
    const out = (k: string): string => (input(k).parentNode as HTMLElement).querySelector("b")!.textContent!;
    expect(out("patternRepeat")).toBe("6"); expect(out("patternRotation")).toBe("0°"); expect(out("patternWidth")).toBe("70%");
    expect(E.label("waves")).toBe("Wave bands");
    expect(E.label("keylineSplit")).toBe("Keyline split");
    expect(E.label("logo")).toBe("logo");
    expect(createLiveryDesignEditor(null).label("halftone"), "no design module: the id").toBe("halftone");
  });
});
