// TrackMaps (src/track/maps/track-maps.ts). Ported from f1-game:
// - tests/unit/track-maps-corners.test.mjs (all ten tests): turn classes from radius +
//   heading sweep with relative spread, fitCanvas, activation zones across the line,
//   and the custom-revision outline cache.
// - tests/unit/track-preview-plan.test.mjs (all eleven tests): planPreview.
// - tests/unit/hud-feel.test.mjs "minimap sector arcs are the podium metals from tokens":
//   the TrackMaps half (SECTOR_TOKENS / sectorColors / SECTOR_COLORS against the sheet's
//   tokens, not a timing colour, separated by lightness).
//
// Differences from f1-game:
// - f1-game booted the IIFE in a fresh Node VM per test; here the module is imported
//   once, so beforeEach clears the outline cache (invalidate()) and afterEach clears
//   the injected AeroZones and stubbed globals.
// - AeroZones.zonesFor (js/physics/aero-zones.js) is not ported, so the two zone tests
//   inject a stand-in zonesFor (setAeroZones) that returns a zone across the line plus
//   one inside the lap. They check what TrackMaps does with the zones it is handed
//   (fractions, b > 1, full-length strokes wrapping % m), not where zonesFor puts them.
//   The suzuka / silverstone / monza loop stays.
// - SKIPPED from the hud-feel test: booting js/ui/hud.js's minimap (not ported) and the
//   regexes over hud.js / track-maps.js source text.
// - Canvas stand-ins are cast to the DOM-typed parameters (Node has no canvas).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import * as TrackMaps from "../../src/track/maps/track-maps";
import type { BuiltDef } from "../../src/track/core/def";
import * as Tracks from "../../src/track/core/tracks";
import type { Track } from "../../src/track/core/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const byId = (id: string): BuiltDef => Tracks.LIST.find((t) => t.id === id)!;
type Fake = { width: number; height: number; style: TrackMaps.FitTarget["style"] };
const fakeCanvas = (): Fake => ({ width: 0, height: 0, style: {} as TrackMaps.FitTarget["style"] });

beforeEach(() => { TrackMaps.invalidate(); });
afterEach(() => { TrackMaps.setAeroZones(null); TrackMaps.invalidate(); vi.unstubAllGlobals(); });

// ── track-maps-corners.test.mjs ───────────────────────────────────────────
// Regressions this guards:
//   1. curated apexes stamped v:0 → every turn read FAST
//   2. |k| thresholds alone → every chicane read HAIRPIN
//   3. absolute R<50 alone → Indy/Jacarepagua (and other short-radius packs)
//      painted every chip SLOW — assignCornerClasses tertile-spreads when one
//      class dominates.
describe("track-maps-corners (f1-game)", () => {
  test("classifyCorner: hairpin needs angle; chicanes stay SLOW; sweeps FAST", () => {
    const C = TrackMaps.classifyCorner;
    assert.equal(C(12, 122), "HAIRPIN"); // La Source-like
    assert.equal(C(10, 194), "HAIRPIN"); // Loews-like
    assert.equal(C(33, 168), "SLOW");    // Pouhon-like — large angle, not a hairpin
    assert.equal(C(15, 100), "SLOW");    // Rettifilo-like chicane
    assert.equal(C(16, 86), "SLOW");     // Bus Stop-like
    assert.equal(C(174, 20), "FAST");    // Curva Grande-like
    assert.equal(C(109, 45), "FAST");    // Eau Rouge-like
    assert.equal(C(58, 95), "MEDIUM");   // Lesmo-like
  });

  test("Monza curated turns include Curva Grande and varied classes", () => {
    const monza = byId("monza");
    assert.equal(monza.turns!.length, 11);
    assert.ok(monza.turns!.some((f) => Math.abs(f - 0.1288) < 1e-4),
      "Curva Grande apex (~0.1288) missing from src/circuits/defs/monza.ts turns");
    const crns = TrackMaps.corners(monza);
    assert.equal(crns.length, 11);
    assert.ok(crns.every((c) => c.cls && c.r > 0 && Number.isFinite(c.v)));
    const labels = crns.map((c) => c.cls);
    assert.equal(crns[0]!.cls, "SLOW", "T1 Rettifilo must be SLOW, not HAIRPIN");
    assert.equal(crns[1]!.cls, "SLOW", "T2 Rettifilo must be SLOW, not HAIRPIN");
    assert.equal(crns[2]!.cls, "FAST", "T3 Curva Grande must be FAST");
    assert.equal(crns[5]!.cls, "MEDIUM", "T6 Lesmo should be MEDIUM");
    assert.ok(new Set(labels).size >= 3, "Monza must show ≥3 classes, got " + labels.join(","));
  });

  test("Spa La Source is HAIRPIN; Eau Rouge complex includes FAST", () => {
    const spa = byId("spa");
    const crns = TrackMaps.corners(spa);
    assert.equal(crns[0]!.cls, "HAIRPIN", "T1 La Source");
    assert.ok(crns.slice(1, 4).some((c) => c.cls === "FAST"),
      "Eau Rouge / Raidillon should include a FAST class: " +
      crns.slice(0, 4).map((c) => "T" + c.n + "=" + c.cls).join(" "));
  });

  test("no circuit with ≥6 curated turns collapses to a single class", () => {
    const collapsed: string[] = [];
    for (const t of Tracks.LIST) {
      if (!t.turns || t.turns.length < 6) continue;
      const crns = TrackMaps.corners(t);
      const kinds = new Set(crns.map((c) => c.cls));
      if (kinds.size < 2) collapsed.push(t.id + ":" + [...kinds].join(","));
    }
    assert.deepEqual(collapsed, [],
      "single-class circuits (need assignCornerClasses spread):\n  " + collapsed.join("\n  "));
  });

  test("Indianapolis and Jacarepagua are no longer all-SLOW", () => {
    for (const id of ["indianapolis", "jacarepagua"]) {
      const t = byId(id);
      const crns = TrackMaps.corners(t);
      const kinds = new Set(crns.map((c) => c.cls));
      assert.ok(kinds.size >= 2, id + " classes=" + [...kinds].join(","));
      assert.ok(!kinds.has("SLOW") || kinds.size >= 2);
    }
  });

  test("fitCanvas preserves circuit aspect inside a box (no stretch)", () => {
    const monza = byId("monza");
    const a = TrackMaps.aspect(monza);
    assert.ok(a >= 0.5 && a <= 2.5, "aspect clamped, got " + a);

    // Minimal canvas stand-in (node has no HTMLCanvasElement).
    const fake = fakeCanvas();
    const wide = TrackMaps.fitCanvas(fake, 400, 100, monza, true);
    assert.equal(wide.w, fake.width);
    assert.equal(wide.h, fake.height);
    assert.ok(Math.abs(wide.w / wide.h - a) < 0.05,
      "wide-box fit drifted: " + wide.w + "x" + wide.h + " aspect=" + (wide.w / wide.h));
    assert.ok(wide.h <= 100 && wide.w <= 400);
    assert.equal(fake.style.width, wide.w + "px");
    assert.equal(fake.style.height, wide.h + "px");
    // max-* stays UNPINNED: an inline max would replace the stylesheet caps
    // (#sel-preview-map's 50%, #track-detail-canvas's 100%) that are the
    // layout's defence when a plan is floored or stale — see fitCanvas.
    assert.equal(fake.style.maxWidth, "");
    assert.equal(fake.style.maxHeight, "");
    assert.equal(fake.style.aspectRatio, String(a));

    const tall = TrackMaps.fitCanvas(fake, 100, 400, monza, true);
    assert.ok(Math.abs(tall.w / tall.h - a) < 0.05,
      "tall-box fit drifted: " + tall.w + "x" + tall.h);
    assert.ok(tall.w <= 100 && tall.h <= 400);

    // A square box must still honour the circuit ratio (letterbox in one axis).
    const sq = TrackMaps.fitCanvas(fake, 300, 300, monza);
    assert.ok(Math.abs(sq.w / sq.h - a) < 0.05);
    assert.ok(sq.w === 300 || sq.h === 300, "should bind one edge of the box");
  });

  test("fitCanvas never commits a 1px transient during layout convergence", () => {
    const bahrain = byId("bahrain");
    const fake = fakeCanvas();
    const fit = TrackMaps.fitCanvas(fake, 0, 0, bahrain, true);
    assert.ok(fit.w > 8 && fit.h > 8, `${fit.w}x${fit.h} is not a useful preview`);
    assert.ok(Math.abs(fit.w / fit.h - TrackMaps.aspect(bahrain)) < 0.05);
  });

  // THE ACTIVATION ZONE ACROSS THE LINE. AeroZones.zonesFor starts its straight
  // scan at a corner, so the main-straight zone ends past the lap (end > total).
  // drsZones clamped `b` to 1 and every drawer clamped its last index to n-1, so
  // the minimap, the picker map and the HUD strip cut that zone off at the line.
  // AeroZones is not ported: this stand-in hands over the same shape of answer
  // (a main-straight zone across the line, end > total, and one inside the lap).
  type Zone = { start: number; end: number; len: number };
  function withAeroZones(): { zonesFor(tr: Track): Zone[] } {
    const Z = {
      zonesFor(tr: Track): Zone[] {
        const L = tr.total;
        return [[0.30 * L, 0.38 * L], [0.93 * L, 1.04 * L]].map(([start, end]) => ({ start: start!, end: end!, len: end! - start! }));
      },
    };
    TrackMaps.setAeroZones(Z);
    return Z;
  }

  test("a zone across the start/finish line keeps its full length (b > 1)", () => {
    const AeroZones = withAeroZones();
    for (const id of ["suzuka", "silverstone", "monza"]) {
      const def = byId(id);
      const tr = Tracks.buildCenterline(def, { line: false });
      const want = AeroZones.zonesFor(tr), got = TrackMaps.drsZones(def);
      assert.equal(got.length, want.length, `${id}: one map zone per race zone`);
      assert.ok(got.some((z) => z.b > 1), `${id}: the main-straight zone crosses the line`);
      got.forEach((z, i) => {
        const lenM = (z.b - z.a) * tr.total;
        assert.ok(Math.abs(lenM - want[i]!.len) < 1e-6, `${id} zone ${i + 1}: map ${lenM.toFixed(1)} m vs race ${want[i]!.len.toFixed(1)} m`);
      });
    }
  });

  test("TrackMaps.draw strokes a crossing zone past the line, wrapping to pts[0]", () => {
    withAeroZones();
    const def = byId("suzuka");
    const strokes: { style: unknown; n: number }[] = [];
    let cur: { style: unknown; n: number } | null = null;
    const g: Record<string, unknown> = {
      clearRect() {}, beginPath() { cur = { style: g.strokeStyle, n: 0 }; }, closePath() {},
      moveTo() { cur!.n++; }, lineTo() { cur!.n++; }, stroke() { strokes.push(cur!); },
      arc() {}, fill() {}, fillText() {}, measureText: () => ({ width: 10 }), save() {}, restore() {}, setLineDash() {},
    };
    TrackMaps.draw({ width: 400, height: 300, getContext: () => g as unknown as CanvasRenderingContext2D }, def, { drs: true, start: false });
    const m = TrackMaps.outline(def)!.length;
    const zones = TrackMaps.drsZones(def);
    const drawn = strokes.filter((s) => s.style === "rgba(0,220,180,0.85)").map((s) => s.n);
    const want = Array.from(zones, (z) => Math.floor(z.b * m) - Math.floor(z.a * m) + 1);
    assert.deepEqual(drawn, want, "every zone is stroked over its whole index span, wrapping % m");
  });

  // A custom circuit's id is its content hash, so every saved revision the picker
  // drew stayed in the outline cache for the page: it keeps only what Tracks.LIST
  // still lists (CustomTracks.sync replaces the custom rows) plus the one drawn.
  test("the outline cache drops custom revisions Tracks.LIST no longer lists", () => {
    const LIST = Tracks.LIST as BuiltDef[];
    const n0 = LIST.length;
    try {
      const monza = byId("monza");
      assert.ok(TrackMaps.outline(monza), "a shipped circuit is cached");
      for (let rev = 0; rev < 20; rev++) {
        for (let i = LIST.length - 1; i >= 0; i--) if (LIST[i]!.custom) LIST.splice(i, 1);   // CustomTracks.sync
        const def = Object.assign({}, monza, { id: "custom-rev" + rev, custom: true });
        LIST.push(def);
        assert.ok(TrackMaps.outline(def), "revision " + rev + " draws");
      }
      assert.deepEqual([...TrackMaps.cachedIds()].sort(), ["custom-rev19", "monza"], "only the listed revision and the shipped circuit");
    } finally {
      LIST.splice(n0, LIST.length - n0);
    }
  });

  test("detectCorners numbers curvature peaks in driving order over a built centreline", () => {
    // New: the uncurated path (compute's fallback when a def has no turns), called directly.
    for (const id of ["monza", "spa", "suzuka"]) {
      const tr = Tracks.buildCenterline(byId(id), { line: false });
      const crns = TrackMaps.detectCorners(tr);
      assert.ok(crns.length >= 3, `${id}: ${crns.length} corners`);
      crns.forEach((c, i) => {
        assert.equal(c.n, i + 1, `${id}: numbered in order`);
        assert.ok(c.f >= 0 && c.f < 1 && c.r > 0 && Number.isFinite(c.v), `${id} T${c.n}`);
        assert.equal(c.cls, TrackMaps.classifyCorner(c.r, c.ang), `${id} T${c.n}: measureApex's class before any spread`);
      });
      // Deterministic: a second pass over a fresh build gives the same corners.
      assert.deepEqual(TrackMaps.detectCorners(Tracks.buildCenterline(byId(id), { line: false })), crns);
    }
  });

  test("with AeroZones absent (the port's default) the map draws no activation zones", () => {
    // New: f1-game's "AeroZones unavailable" branch (track-maps.js:378), which is
    // the port's default until zonesFor lands.
    assert.deepEqual(TrackMaps.drsZones(byId("suzuka")), []);
  });
});

// ── track-preview-plan.test.mjs ───────────────────────────────────────────
// Regressions this guards, each measured before it was fixed:
//   1. a TALL circuit fitted into a full-width slot — Jeddah (aspect 0.50) came
//      out 128x255 in a 406x416 card, a sliver with ~190px of dead card beside it
//   2. the caption's height subtracted from the budget even when the caption is
//      NOT stacked under the map (it sits beside it in the `beside` shape)
//   3. `beside` chosen for a WIDE circuit that was merely starved of height —
//      Singapore went 181x117 beside where stacking gives 315x204
//   4. the budget going negative at UI SIZE 175% and collapsing the map onto
//      its floor (36x72), because visual px were subtracted from local px
//   5. a phone-width card being torn into two columns it cannot seat
describe("track-preview-plan (f1-game)", () => {
  const planPreview = TrackMaps.planPreview;

  // MEASURED, not invented — Chromium at 1280x720 with the 50/50 column split:
  // a 487px card less its 22px of padding, in a 563px scrolling section. The 175%
  // row is the same card at UI SIZE 175%.
  const DESKTOP = { cardInnerW: 465, sectionH: 563, labelH: 21, infoH: 94, padY: 22, gap: 14 };
  const DESKTOP_175 = { cardInnerW: 266, sectionH: 322, labelH: 21, infoH: 150, padY: 22, gap: 14 };
  // A phone card: too narrow to seat a map and a caption side by side.
  const PHONE = { cardInnerW: 306, sectionH: 700, labelH: 20, infoH: 120, padY: 20, gap: 12 };

  // Real circuit aspects, spanning the range the picker actually shows.
  const JEDDAH = 0.50, MONZA = 0.58, BAHRAIN = 0.67, BAKU = 1.37, SINGAPORE = 1.55;

  test("a tall circuit puts the caption beside the map rather than strand the card", () => {
    const p = planPreview({ ...DESKTOP, aspect: JEDDAH });
    assert.equal(p.shape, "beside");
    // The whole point: it must be bigger than the 128x255 sliver that shipped.
    assert.ok(p.slotW >= 200, `expected a usable width, got ${p.slotW}`);
    assert.ok(p.slotH >= 400, `expected the column's height to be spent, got ${p.slotH}`);
  });

  test("a wide circuit stacks and uses the card's full width", () => {
    for (const [name, a] of [["baku", BAKU], ["singapore", SINGAPORE]] as const) {
      const p = planPreview({ ...DESKTOP, aspect: a });
      assert.equal(p.shape, "stacked", `${name} should stack`);
      assert.equal(p.slotW, Math.floor(DESKTOP.cardInnerW), `${name} should fill the width`);
    }
  });

  test("the caption's height is only charged to the budget when it is stacked", () => {
    const tall = planPreview({ ...DESKTOP, aspect: JEDDAH });
    const wide = planPreview({ ...DESKTOP, aspect: BAKU });
    assert.equal(tall.shape, "beside");
    assert.equal(wide.shape, "stacked");
    assert.ok(tall.slotH > wide.slotH,
      `beside should get the taller budget (${tall.slotH} vs ${wide.slotH})`);
  });

  test("a wide circuit starved of height stacks anyway — sideways makes it worse", () => {
    // Regression 3. At 175% the dead-space test alone would flip Singapore to
    // `beside`, where it measured 181x117 against 315x204 stacked.
    const p = planPreview({ ...DESKTOP_175, aspect: SINGAPORE });
    assert.equal(p.shape, "stacked");
    assert.ok(p.slotW > p.slotH, "a wide circuit's slot should stay wider than it is tall");
  });

  test("no UI SIZE collapses the map to a thumbnail", () => {
    // Regression 4. Every circuit, at the most cramped card the sliders can make.
    for (const [name, a] of [["jeddah", JEDDAH], ["monza", MONZA], ["bahrain", BAHRAIN],
      ["baku", BAKU], ["singapore", SINGAPORE]] as const) {
      const p = planPreview({ ...DESKTOP_175, aspect: a });
      assert.ok(p.slotW >= 120, `${name}: width collapsed to ${p.slotW}`);
      assert.ok(p.slotH >= 130, `${name}: height collapsed to ${p.slotH}`);
    }
  });

  test("a phone-width card is never torn into two columns", () => {
    for (const a of [JEDDAH, MONZA, BAHRAIN, BAKU, SINGAPORE]) {
      assert.equal(planPreview({ ...PHONE, aspect: a }).shape, "stacked");
    }
  });

  test("a 340px card seats a tall circuit beside its caption", () => {
    // iPad landscape at 150%: stacking used 240px of map plus a 175px caption
    // in a 378px card, clipping the last fact chip. Side-by-side fits both.
    const p = planPreview({ cardInnerW: 347, sectionH: 412, labelH: 21,
      infoH: 175, padY: 20, gap: 10, aspect: BAHRAIN });
    assert.equal(p.shape, "beside");
    assert.ok(p.slotW >= 120 && p.slotH >= 170);
  });

  test("the slot always honours the circuit's aspect and its own caps", () => {
    for (const card of [DESKTOP, DESKTOP_175, PHONE]) {
      for (const a of [JEDDAH, MONZA, BAHRAIN, 1.0, BAKU, SINGAPORE, 2.5]) {
        const p = planPreview({ ...card, aspect: a });
        assert.ok(p.slotW > 0 && p.slotH > 0, "a slot must have positive extent");
        assert.ok(p.slotW <= card.cardInnerW,
          `slot ${p.slotW} must fit the card's ${card.cardInnerW}`);
        // slotW is the width the height implies, clamped by the card — so it can
        // be narrower than slotH*a, never wider.
        assert.ok(p.slotW <= Math.round(p.slotH * a) + 1,
          `slot ${p.slotW}x${p.slotH} is wider than aspect ${a} allows`);
      }
    }
  });

  test("noScroll caps the slot at the measured ceiling — the floor cannot win", () => {
    // The pair-on select section clips (overflow: hidden), so the 240px
    // scroll-column floor cannot be spent there.
    const band = { aspect: BAHRAIN, cardInnerW: 162, sectionH: 96, labelH: 18,
      infoH: 0, padY: 10, gap: 6, noScroll: true };
    const p = planPreview(band);
    const scrolly = planPreview({ ...band, noScroll: false });
    assert.ok(p.slotH <= band.sectionH, `noScroll slot ${p.slotH} must fit the ${band.sectionH}px section`);
    assert.ok(scrolly.slotH > band.sectionH, "without noScroll the floor exceeds the section (the old behaviour)");
    assert.ok(p.slotH >= 40, "the 40px transient floor still guards degenerate frames");
  });

  test("a card measured before layout still gets a usable slot", () => {
    // First paint: no section height yet.
    const p = planPreview({ aspect: JEDDAH, cardInnerW: 385 });
    assert.ok(Number.isFinite(p.slotW) && Number.isFinite(p.slotH));
    assert.ok(p.slotW >= 120 && p.slotH >= 72);
  });

  test("garbage in does not produce NaN out", () => {
    for (const bad of [{}, { aspect: 0 }, { aspect: -3, cardInnerW: -100 },
      { aspect: NaN, sectionH: NaN }, { aspect: "x", cardInnerW: null }]) {
      const p = planPreview(bad);
      assert.ok(Number.isFinite(p.slotW) && Number.isFinite(p.slotH),
        `non-finite slot from ${JSON.stringify(bad)}`);
      assert.ok(p.slotW > 0 && p.slotH > 0);
    }
    const none = planPreview();
    assert.ok(Number.isFinite(none.slotW) && Number.isFinite(none.slotH));
  });
});

// ── hud-feel.test.mjs (the TrackMaps half) ────────────────────────────────
describe("hud-feel (f1-game): sector colours", () => {
  const ALL_TOKENS = (() => {
    const t: Record<string, string> = {};
    const css = fs.readFileSync(path.join(ROOT, "src/styles/tokens.css"), "utf8");
    for (const [, k, v] of css.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) if (!(k! in t)) t[k!] = v!.trim();
    return t;
  })();
  const lin = (u: number) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
  const lum = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
  const hex01 = (h: string) => {
    const d = /^#([0-9a-f]{6})$/i.exec(String(h).trim())![1]!;
    return [0, 2, 4].map((i) => parseInt(d.slice(i, i + 2), 16) / 255);
  };

  test("minimap sector arcs are the podium metals from tokens — no purple, no red/green pair", () => {
    // The REAL TrackMaps.sectorColors against the sheet's own tokens.
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (k: string) => ALL_TOKENS[k] || "" }));
    const TM = TrackMaps;
    assert.deepEqual([...TM.SECTOR_TOKENS], ["--gold", "--silver", "--bronze"]);
    const want = [...TM.SECTOR_TOKENS].map((k) => ALL_TOKENS[k]!);
    assert.deepEqual([...TM.sectorColors()], want, "sectorColors reads the tokens");
    assert.deepEqual([...TM.SECTOR_COLORS], want, "and its fallback literals are those tokens' values");
    // SKIPPED: the js/ui/hud.js minimap boot (not ported).

    // Not a timing colour: purple is session best, green personal best, red slower.
    for (const k of ["--sec-best", "--faster", "--slower", "--you"])
      assert.ok(!want.includes(ALL_TOKENS[k]!), `a sector arc wears ${k}`);
    // Separated by LIGHTNESS: each pair differs by at least 1.25:1 in WCAG luminance ratio.
    const L = want.map((h) => lum(hex01(h)));
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const r = (Math.max(L[i]!, L[j]!) + 0.05) / (Math.min(L[i]!, L[j]!) + 0.05);
      assert.ok(r >= 1.25, `S${i + 1} vs S${j + 1}: ${r.toFixed(2)}:1`);
    }
    // SKIPPED: the regexes over hud.js / track-maps.js source text.
  });

  test("with no computed style, sectorColors falls back to the literals", () => {
    // New: Node has no document, the branch the import-safety rule depends on.
    assert.deepEqual(TrackMaps.sectorColors(), [...TrackMaps.SECTOR_COLORS]);
  });
});
