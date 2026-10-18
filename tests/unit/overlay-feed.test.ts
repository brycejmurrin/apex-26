/* overlay-feed.test.ts — the stream overlay frame schema, diff contract and
 * painter. Port of f1-game tests/unit/overlay-feed.test.mjs:1-182.
 * Skipped: the two TvGraphics tests (:144-170; js/race/tv-graphics.js is the
 * race lane's) and the hud.js / stage-files.mjs source checks (:38-40,
 * :178-181; those files are other lanes'). The painter runs on a minimal fake
 * DOM (f1-game used tests/helpers/mini-dom.mjs). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { accept, battle, createDiffer, frame, sector, type FeedCar } from "../../src/overlay/feed";
import { create, options } from "../../src/overlay/render";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (p: string): string => fs.readFileSync(path.join(ROOT, p), "utf8");
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

afterEach(() => {
  vi.unstubAllGlobals();
});

function cars(gapS: number): FeedCar[] {
  return [
    { code: "LEC", prog: 1000, speed: 50, pos: 1, team: "#e8002d" },
    { code: "NOR", prog: 1000 - gapS * 50, speed: 50, pos: 2, team: "#ff8700", you: true },
  ];
}

test("battle uses Broadcast's strict one-second gate", () => {
  expect(plain(battle(cars(0.99)))).toStrictEqual({ ahead: "LEC", behind: "NOR", gapS: 0.99 });
  expect(battle(cars(1.01))).toBe(null);
});

test("sector colours and glyphs match the HUD predicate", () => {
  expect(plain(sector(20, 20, 20))).toStrictEqual({ value: 20, tone: "purple", glyph: "★" });
  expect(plain(sector(20, 20, 19))).toStrictEqual({ value: 20, tone: "green", glyph: "▼" });
  expect(plain(sector(21, 20, 19))).toStrictEqual({ value: 21, tone: "yellow", glyph: "▲" });
  expect(plain(sector(null, 20, 19))).toStrictEqual({ value: null, tone: "", glyph: "" });
});

test("frame schema maps ranked cars without writing them", () => {
  const ranked: FeedCar[] = cars(0.4);
  ranked[0] = { ...ranked[0], tyre: { code: "M" } };
  ranked[1] = { ...ranked[1], pit: true };
  const before = JSON.stringify(ranked);
  const f = frame({
    seq: 7,
    t: 12.5,
    state: "race",
    track: "monza",
    lap: 4,
    laps: 12,
    flag: "green",
    ranked,
    sectorLast: [20, 21, null],
    sectorBests: [20, 20, 20],
    fieldSectorBests: [20, 19, 19],
  });
  expect(f.v).toBe(1);
  expect(plain(f.rows)).toStrictEqual([
    { pos: 1, code: "LEC", team: "#e8002d", interval: null, gap: null, tyre: "M", pit: false, you: false },
    { pos: 2, code: "NOR", team: "#ff8700", interval: 0.4, gap: 0.4, tyre: null, pit: true, you: true },
  ]);
  expect(plain(f.battle)).toStrictEqual({ ahead: "LEC", behind: "NOR", gapS: 0.4 });
  expect(JSON.stringify(ranked), "read-only mapping").toBe(before);
});

test("diff omits unchanged parts and sends a full frame every two seconds", () => {
  const diff = createDiffer(2000);
  const first = frame({ seq: 1, t: 0, state: "race", ranked: cars(0.4) });
  expect(diff.next(first, 0)?.full).toBe(true);

  const same = frame({ seq: 2, t: 0.25, state: "race", ranked: cars(0.4) });
  const patch = diff.next(same, 250);
  expect(patch?.full).toBe(undefined);
  expect(patch?.rows).toBe(undefined);
  expect(patch?.battle).toBe(undefined);
  expect(patch?.seq).toBe(2);

  const changed = frame({ seq: 3, t: 0.5, state: "race", ranked: cars(0.2) });
  expect(plain(diff.next(changed, 500)?.battle)).toStrictEqual({ ahead: "LEC", behind: "NOR", gapS: 0.2 });

  const full = diff.next(frame({ seq: 4, t: 2, state: "race", ranked: cars(0.2) }), 2000);
  expect(full?.full).toBe(true);
  expect(full?.rows).toBeTruthy();
});

test("caption ids dedupe and unsupported schema versions are rejected", () => {
  const diff = createDiffer();
  diff.next(frame({ seq: 1, t: 0, ranked: [], caption: { id: "radio-1", text: "Box" } }), 0);
  const again = frame({ seq: 2, t: 0.25, ranked: [], caption: { id: "radio-1", text: "Box" } });
  expect(diff.next(again, 250)?.caption).toBe(undefined);
  expect(accept({ v: 2 })).toBe(null);
  expect(accept({ v: 1, seq: 4 })?.seq).toBe(4);
});

test("overlay source is display-only", () => {
  for (const rel of ["src/overlay/feed.ts", "src/overlay/render.ts"]) {
    expect(source(rel), `${rel} must not reach track geometry or write car physics`).not.toMatch(/\bTracks\b|\bcurvature\s*\(|\.\s*(?:speed|prog|px|pz|lap)\s*=/);
  }
});

test("query options clamp scale/rows and select chroma + side", () => {
  expect(plain(options("?demo=1&scale=9&rows=3&side=right&chroma=green"))).toStrictEqual({ scale: 2, rows: 3, side: "right", chroma: "green", demo: true, only: "" });
});

// ─── a minimal fake DOM for the painter ─────────────────────────────────────

class FakeEl {
  readonly children: FakeEl[] = [];
  readonly style: Record<string, string> & { setProperty(k: string, v: string): void } = Object.assign(Object.create(null) as Record<string, string>, {
    setProperty(this: Record<string, string>, k: string, v: string) {
      this[k] = v;
    },
  });
  readonly dataset: Record<string, string> = {};
  hidden = false;
  textContent = "";
  className = "";
  constructor(readonly tagName: string) {}
  append(...kids: FakeEl[]): void {
    this.children.push(...kids);
  }
  appendChild(kid: FakeEl): FakeEl {
    this.children.push(kid);
    return kid;
  }
  private all(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  private matches(sel: string): boolean {
    return sel.startsWith(".") ? this.className.split(/\s+/).includes(sel.slice(1)) : this.tagName === sel.toUpperCase();
  }
  querySelector(sel: string): FakeEl | null {
    return this.all().find((e) => e.matches(sel)) ?? null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    return this.all().filter((e) => e.matches(sel));
  }
}

function el(tag: string, cls = "", ...kids: FakeEl[]): FakeEl {
  const e = new FakeEl(tag.toUpperCase());
  e.className = cls;
  e.append(...kids);
  return e;
}

test("painter builds fixed rows once, moves by transform and skips unchanged text", () => {
  vi.stubGlobal("document", { createElement: (tag: string) => el(tag) });
  const tower = el("div", "ov-tower");
  const root = el(
    "section",
    "",
    tower,
    el("div", "ov-battle", el("strong"), el("span")),
    el("div", "ov-sectors", el("span"), el("span"), el("span")),
    el("div", "ov-caption", el("strong"), el("span")),
  );
  const painter = create(root as unknown as ParentNode, { rows: 4 });
  expect(tower.children.length, "rows are built once").toBe(20);
  const f = frame({ seq: 1, ranked: cars(0.4) });
  painter.paint(f);
  const row1 = painter.rows[1];
  if (!row1) throw new Error("row 1");
  expect(row1.el.style.transform).toBe("translate3d(0,34px,0)");
  const original = row1.code.textContent;
  row1.code.textContent = "sentinel";
  painter.paint(f);
  expect(row1.code.textContent, "unchanged row text is not rewritten").toBe("sentinel");
  const moved = { ...f, rows: f.rows.map((r, i) => (i === 1 ? { ...r, pos: 1 } : r)) };
  painter.paint(moved);
  expect(row1.el.style.transform).toBe("translate3d(0,0px,0)");
  expect(original).toBe("NOR");
});

test("overlay page explicitly owns transparent and chroma backgrounds and is a Vite entry", () => {
  const html = source("overlay.html");
  expect(html).toMatch(/html,\s*body\s*\{[^}]*background:\s*transparent/s);
  expect(html).toMatch(/data-chroma="green"[\s\S]*background:\s*#00b140/);
  expect(html).toMatch(/<script type="module" src="\/src\/overlay\/overlay-page\.ts">/);
  expect(source("vite.config.ts")).toMatch(/overlay: "overlay\.html"/);
});
