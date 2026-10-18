// TrackFixes, TrackStamps, ElevPresets and DesignerSceneryPreview (src/editor/fixes.ts,
// stamps.ts, elev-presets.ts, scenery-preview.ts) over the real engine. Ported from
// f1-game's own unit tests:
//   tests/unit/track-fixes.test.mjs           (every test)
//   tests/unit/elev-presets.test.mjs          (every test)
//   tests/unit/track-editor-geometry.test.mjs (the stamp / splice / SPIRAL / seedFromSegments tests)
//   tests/unit/designer-canvas.test.mjs       (the two DesignerSceneryPreview tests)
//   tests/unit/designer-props.test.mjs        (the preview half of "landscapes reach the real engine")
// plus property tests over the designs in tests/goldens/editor-codec.json.gz. TrackMaps is
// absent (validate.ts default), where f1-game's editor-vm loads it. revive is copied from
// tests/unit/editor-goldens.test.ts; f1-game's test-side plain() is a JSON round trip.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import * as CustomTracks from "../../src/editor/custom-tracks";
import * as ElevPresets from "../../src/editor/elev-presets";
import * as TrackFixes from "../../src/editor/fixes";
import type { FixDesign, FixResult } from "../../src/editor/fixes";
import * as TrackDesignerProps from "../../src/editor/props";
import * as TrackRandom from "../../src/editor/randomise";
import * as DesignerSceneryPreview from "../../src/editor/scenery-preview";
import * as S from "../../src/editor/shape";
import type { Pose, Pt } from "../../src/editor/shape";
import * as TrackStamps from "../../src/editor/stamps";
import type { StampKindName, StampSample } from "../../src/editor/stamps";
import * as TrackThemes from "../../src/editor/track-themes";
import * as TrackValidate from "../../src/editor/validate";
import type { Issue, Verdict } from "../../src/editor/validate";
import { fromRaw, type RawDef } from "../../src/track/core/def";
import * as Tracks from "../../src/track/core/tracks";
import type { Track } from "../../src/track/core/types";

const V = TrackValidate, F = TrackFixes, ST = TrackStamps, TR = TrackRandom, C = CustomTracks, E = ElevPresets, P = DesignerSceneryPreview;
const SLOW = 300_000;

// ── f1-game tests/helpers/editor-vm.mjs ─────────────────────────────────────
const plain = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;
/** An a×b ellipse of n control points on the 0.25 m lattice (≈ 4.1 km at 800×500). */
function ellipse(n = 36, a = 800, b = 500): Pt[] {
  const pts: Pt[] = [], q = (v: number) => Math.round(v * 4) / 4;
  for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2; pts.push([q(a * Math.cos(t)), q(b * Math.sin(t))]); }
  return pts;
}
type Design = FixDesign & { pts: Pt[] };
const design = (extra?: object): Design => Object.assign({ name: "Test Loop", seed: 7, theme: "parkland", baseHW: 7, pts: ellipse() }, extra);

const ok = (cond: unknown, msg?: string) => expect(Boolean(cond), msg).toBe(true);
type Zone = { s: number; s0: number; s1: number; frac: number; halfM: number; rise: number; kind: string; side: number; gap: number };
const zl = (d: FixDesign, key: string) => d[key] as Zone[];

// ═══════════════════════════════ TrackFixes ═══════════════════════════════
// track-fixes.test.mjs
describe("TrackFixes (f1-game tests/unit/track-fixes.test.mjs)", () => {
  const q = (v: number) => Math.round(v * 4) / 4;
  const apply = (...a: Parameters<typeof F.apply>) => { const r = F.apply(...a); return r && plain(r); };
  const reds = (v: Verdict, code: string) => v.issues.filter((i) => i.code === code && i.level === "red");
  const codes = (v: Verdict) => v.issues.map((i) => i.code + ":" + i.level).join(" ");
  /** The world point at arc fraction f of the closed control polygon. */
  function at(pts: readonly Pt[], f: number): Pt {
    const N = pts.length, c = [0];
    for (let i = 0; i < N; i++) { const a = pts[i]!, b = pts[(i + 1) % N]!; c.push(c[i]! + Math.hypot(b[0] - a[0], b[1] - a[1])); }
    const x = (((f % 1) + 1) % 1) * c[N]!;
    let i = 0;
    while (i < N - 1 && c[i + 1]! < x) i++;
    const a = pts[i]!, b = pts[(i + 1) % N]!, t = (x - c[i]!) / ((c[i + 1]! - c[i]!) || 1);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
  const onLattice = (pts: readonly Pt[]) => pts.every((p) => Number.isInteger(p[0] * 4) && Number.isInteger(p[1] * 4));
  /** One remedy, with the invariants every result keeps. */
  function fix(d: Design, code: string, opts: { movesStart?: boolean } = {}): { v: Verdict; r: FixResult; after: Verdict } {
    const v = V.check(d);
    const issue = reds(v, code)[0];
    ok(issue, `the design is RED for ${code}: ${codes(v)}`);
    ok(issue!.fix && F.canFix(issue), `${code} carries a fix tag`);
    const before = JSON.stringify(d);
    const r = apply(d, issue, v);
    ok(r && r.design && typeof r.msg === "string" && r.msg.length > 0, `${code}: a remedy`);
    expect(JSON.stringify(d), `${code}: the input design is not mutated`).toBe(before);
    expect(r!.design).not.toBe(d);
    ok(onLattice(r!.design.pts), `${code}: the result is on the 0.25 m lattice`);
    if (!opts.movesStart) expect(r!.design.pts[0], `${code}: point 0 stays the start`).toEqual(plain(d.pts[0]));
    const after = V.check(r!.design);
    expect(reds(after, code).length, `${code} is gone or amber after the fix: ${codes(after)}`).toBe(0);
    return { v, r: r!, after };
  }

  // ── crafted designs ─────────────────────────────────────────────────────
  // A stadium (1.3 km straights, 200 m ends) whose index 0 sits mid-corner.
  function stadium(): Pt[] {
    const pts: Pt[] = [], h = 650, R = 200;
    for (let x = -h; x < h; x += 40) pts.push([x, -R]);
    for (let a = 0; a < Math.PI; a += Math.PI / 16) pts.push([h + R * Math.sin(a), -R * Math.cos(a)]);
    for (let x = h; x > -h; x -= 40) pts.push([x, R]);
    for (let a = 0; a < Math.PI; a += Math.PI / 16) pts.push([-h - R * Math.sin(a), R * Math.cos(a)]);
    return S.rotate(pts.map((p): Pt => [q(p[0]), q(p[1])]), 41);
  }
  // A zig-zag of 8 m-spaced points spliced into the ellipse a quarter-lap in.
  function zig(amp: number, sp: number, n: number): Pt[] {
    const base = ellipse(36, 800, 500), k = 9, p = base[k]!, z: Pt[] = [];
    for (let m = -n; m <= n; m++) z.push([q(p[0] - m * sp), q(p[1] + (m % 2 ? amp : -amp))]);
    return base.slice(0, k).concat(z, base.slice(k + 1));
  }
  // A narrow spike out of the ellipse's top (a hairpin narrower than the road).
  function spike(depth: number, w: number): Pt[] {
    const base = ellipse(36, 800, 500), k = 9, p = base[k]!;
    return base.slice(0, k).concat([[q(p[0] + w), q(p[1])], [q(p[0]), q(p[1] + depth)], [q(p[0] - w), q(p[1])]], base.slice(k + 1));
  }
  // A 2 km × 600 m ellipse pinched at its waist until the two sides run 16 m apart.
  function pinch(gap: number): Pt[] {
    return ellipse(100, 1000, 300).map(([x, z]): Pt => { const w = Math.exp(-(x * x) / (2 * 260 * 260)); return [q(x), q(Math.sign(z) * (Math.abs(z) - (300 - gap / 2) * w * Math.abs(z) / 300))]; });
  }
  function eight(): Pt[] {
    const e: Pt[] = [];
    for (let i = 0; i < 48; i++) { const t = (i / 48) * Math.PI * 2; e.push([q(900 * Math.sin(t)), q(450 * Math.sin(2 * t))]); }
    return e;
  }
  const zones = (extra: object) => Object.assign({ elevations: [{ s: 0.62, halfM: 200, rise: 4 }], hwZones: [{ s0: 0.55, s1: 0.6, hw: 6, ease: 0.025 }], bankZones: [{ frac: 0.66, angleDeg: 8, widthM: 120 }] }, extra);
  /** Zones away from the edit keep their place on the road (within `tol` m). */
  function zonesStay(d0: Design, d1: Design, tol: number, label: string) {
    ok(dist(at(d0.pts, zl(d0, "elevations")[0]!.s), at(d1.pts, zl(d1, "elevations")[0]!.s)) <= tol, `${label}: the elevation stays put`);
    ok(dist(at(d0.pts, zl(d0, "hwZones")[0]!.s0), at(d1.pts, zl(d1, "hwZones")[0]!.s0)) <= tol, `${label}: the width zone's start stays put`);
    ok(dist(at(d0.pts, zl(d0, "hwZones")[0]!.s1), at(d1.pts, zl(d1, "hwZones")[0]!.s1)) <= tol, `${label}: the width zone's end stays put`);
    ok(dist(at(d0.pts, zl(d0, "bankZones")[0]!.frac), at(d1.pts, zl(d1, "bankZones")[0]!.frac)) <= tol, `${label}: the banking stays put`);
  }

  it("canFix: every remedied code the validator raises carries a fix tag; nothing else does", () => {
    for (const c of F.ORDER) expect(F.canFix({ code: c, level: "red", fix: c }), c).toBe(true);
    for (const bad of [null, undefined, 0, "start", {}, { code: "start" }, { code: "grade", fix: "grade" }, { code: "width", fix: true }, { code: "toString", fix: 1 }]) expect(F.canFix(bad), JSON.stringify(bad)).toBe(false);
    const seen = new Set<string>();
    for (const d of [design({ pts: ellipse(24, 150, 90) }), design({ pts: eight() }), design({ pts: zig(60, 8, 2) }), design({ pts: spike(200, 4) }), design({ pts: pinch(16) }), design({ pts: ellipse(240, 800, 500) }), design({ pts: stadium() })]) {
      for (const it of V.check(d).issues) {
        if ((F.ORDER as readonly string[]).includes(it.code) && !(it.code === "points" && /at least/.test(it.msg))) { ok(it.fix, `${it.code}:${it.level} is tagged`); seen.add(it.code); }
        if (it.code === "clearance") ok(Number.isFinite(it.s2), "clearance carries s2");
      }
    }
    for (const c of ["start", "length", "points", "kink", "radius", "fold", "crossing", "clearance"]) ok(seen.has(c), `the fixtures raise ${c}`);
  }, SLOW);

  it("start: moves the line to the longest straight; the zones stay on the same road", () => {
    const d = design(zones({ pts: stadium() }));
    const { r } = fix(d, "start", { movesStart: true });
    expect(r.msg).toMatch(/start/i);
    // A rotation of the same loop: every point survives, index 0 moved.
    expect(r.design.pts.length).toBe(d.pts.length);
    const j = r.design.pts.length - d.pts.findIndex((p) => p[0] === r.design.pts[0]![0] && p[1] === r.design.pts[0]![1]);
    expect(plain(S.rotate(r.design.pts, j)), "the same points, rotated").toEqual(plain(d.pts));
    zonesStay(d, r.design, 1e-6, "start");
    // Already on the longest straight: nothing to do.
    const again = V.check(r.design);
    expect(apply(r.design, { code: "start", level: "amber", fix: "start", s: 0 }, again), "a second START is a no-op").toBe(null);
  }, SLOW);

  it("length: a short lap scales to 4 km and a long one to 6.5 km on the BUILT road; zones keep fractions", () => {
    for (const [pts, want] of [[ellipse(24, 150, 90), 4000], [ellipse(36, 1600, 1000), 6500]] as const) {
      const d = design(zones({ pts }));
      const { r, after } = fix(d, "length", { movesStart: true });
      ok(Math.abs(after.stats.lengthM - want) <= want * 0.01, `built ${after.stats.lengthM} m ≈ ${want} m`);
      expect(r.design.pts.length).toBe(d.pts.length);
      // Point 0 is the same control point, scaled about the centroid.
      const c0 = S.centroid(d.pts), c1 = S.centroid(r.design.pts);
      const h0 = Math.atan2(d.pts[0]![1] - c0[1], d.pts[0]![0] - c0[0]), h1 = Math.atan2(r.design.pts[0]![1] - c1[1], r.design.pts[0]![0] - c1[0]);
      ok(Math.abs(h0 - h1) < 1e-3, "point 0 is the old start, scaled");
      expect(r.design.elevations, "zone fractions stand under a uniform scale").toEqual(d.elevations);
      expect(r.design.hwZones).toEqual(d.hwZones);
    }
    // A lap already in range: no remedy.
    expect(apply(design(), { code: "length", level: "red", fix: "length" }, V.check(design()))).toBe(null);
  }, SLOW);

  it("bounds: a loop off the map is centred (and scaled to fit) with its start kept", () => {
    const d = design(zones({ pts: ellipse(36, 800, 500).map((p): Pt => [p[0] + 9600, p[1]]) }));
    const v = V.check(d);
    ok(reds(v, "bounds").length, codes(v));
    const r = apply(d, reds(v, "bounds")[0], v);
    ok(r, "a remedy");
    ok(r!.design.pts.every((p) => Math.abs(p[0]) <= 9500 && Math.abs(p[1]) <= 9500));
    expect(r!.design.pts[0], "the same start, translated").toEqual([d.pts[0]![0] - 9600, d.pts[0]![1]]);
    expect(V.check(r!.design).red, codes(V.check(r!.design))).toBe(0);
    // A loop wider than the map is also scaled into ±9.5 km.
    const huge = design({ pts: ellipse(36, 12000, 3000) });
    const rh = apply(huge, { code: "bounds", level: "red", fix: "bounds" }, null);
    ok(rh && rh.design.pts.every((p) => Math.abs(p[0]) <= 9500 && Math.abs(p[1]) <= 9500) && /scaled/.test(rh.msg));
  }, SLOW);

  it("spacing / points: merges points under 8 m, thins to ≤ 180 with RDP, never drops point 0", () => {
    const base = ellipse(36, 800, 500);
    const crowded = design(zones({ pts: base.slice(0, 11).concat([[base[10]![0] + 3, base[10]![1] + 3]], base.slice(11)) }));
    const s = fix(crowded, "spacing");
    expect(s.r.design.pts.length).toBe(36);
    zonesStay(crowded, s.r.design, 0.5, "spacing");
    const dense = design(zones({ pts: ellipse(240, 800, 500) }));
    const v = V.check(dense);
    const it0 = reds(v, "points")[0];
    ok(it0 && F.canFix(it0), codes(v));
    const r = apply(dense, it0, v);
    ok(r && r.design.pts.length <= 180 && r.design.pts.length >= 8, `thinned to ${r && r.design.pts.length}`);
    expect(r!.design.pts[0]).toEqual(dense.pts[0]);
    ok(!V.check(r!.design).issues.some((i) => i.code === "points" || i.code === "spacing"));
    zonesStay(dense, r!.design, 2, "points");
    // Too FEW points: nothing to thin.
    expect(apply(design({ pts: ellipse(6) }), { code: "points", level: "red", fix: "points" }, null)).toBe(null);
  }, SLOW);

  it("kink / radius / fold: relaxes the points under the issue; point 0 and far zones stay put", () => {
    for (const [code, pts] of [["radius", zig(60, 8, 2)], ["kink", spike(200, 4)], ["fold", zig(12, 9, 3)]] as const) {
      const d = design(zones({ pts }));
      const { r } = fix(d, code);
      expect(r.msg).toMatch(/Smoothed/);
      zonesStay(d, r.design, 0.5, code);
    }
  }, SLOW);

  it("crossing: a bridge in sanitize's shape over the far road; refused when the span would lift both", () => {
    const d = design(zones({ pts: eight() }));
    const { v, r, after } = fix(d, "crossing");
    const bridges = zl(r.design, "bridges"), b = bridges[bridges.length - 1]!;
    expect(Object.keys(b).sort()).toEqual(["halfM", "rise", "s"]);
    expect(b.halfM).toBe(160); expect(b.rise).toBe(8);
    ok(b.s > 0 && b.s < 1);
    expect(r.design.pts, "the loop itself is untouched").toEqual(plain(d.pts));
    ok(after.issues.some((i) => i.code === "bridge" && i.level === "info"), codes(after));
    ok(!after.issues.some((i) => i.code === "bridge" && i.level === "red"));
    const sane = C.sanitize(r.design)!;
    expect(sane.bridges![sane.bridges!.length - 1]!.halfM, "sanitize keeps the bridge").toEqual(160);
    const x = reds(v, "crossing")[0]!;
    // The other road inside the span: no bridge can lift only one of them.
    expect(apply(d, Object.assign({}, x, { s2: x.s! + 100 }), v)).toBe(null);
    // An existing deck already there: not a second one.
    expect(apply(r.design, x, V.check(r.design))).toBe(null);
    // The bridges cap.
    const full = Object.assign({}, d, { bridges: Array.from({ length: 24 }, (_, i) => ({ s: 0.2 + i * 0.001, halfM: 20, rise: 1 })) });
    expect(apply(full, x, v)).toBe(null);
    // No s2 on the issue: the crossing scan finds the other road.
    const r2 = apply(d, { code: "crossing", level: "red", fix: "bridge", s: x.s }, v);
    ok(r2 && zl(r2.design, "bridges").length === 1);
  }, SLOW);

  it("clearance: pushes the two close sections apart; point 0 and far zones stay put", () => {
    const d = design({ pts: pinch(16), elevations: [{ s: 0.5, halfM: 200, rise: 4 }], hwZones: [{ s0: 0.45, s1: 0.55, hw: 6, ease: 0.025 }], bankZones: [{ frac: 0.05, angleDeg: 8, widthM: 120 }] });
    const { r } = fix(d, "clearance");
    expect(r.msg).toMatch(/apart/);
    zonesStay(d, r.design, 0.5, "clearance");
  }, SLOW);

  it("apply never throws: null, garbage designs, unknown codes, missing fields", () => {
    const good = design();
    const designs: unknown[] = [null, undefined, 0, "x", [], {}, { pts: "x" }, { pts: [1, 2, 3] }, { pts: [[0, 0], [NaN, 1], [2, 2]] }, { pts: [[0, 0]] }, good];
    const issues: unknown[] = [null, undefined, 1, "start", {}, { code: "nope" }, { code: "__proto__" }, { code: "constructor" }];
    for (const c of F.ORDER) issues.push({ code: c }, { code: c, s: NaN, s2: "a" }, { code: c, level: "red", fix: c, s: 1e9, s2: -1e9 });
    for (const d of designs) for (const it of issues) for (const built of [undefined, null, {}, { tr: {} }, { total: -1 }]) {
      let r: FixResult | null = null;
      expect(() => { r = apply(d, it, built); }, `${JSON.stringify(d)} / ${JSON.stringify(it)}`).not.toThrow();
      const rr = r as FixResult | null;
      ok(rr === null || (rr.design && Array.isArray(rr.design.pts) && typeof rr.msg === "string"));
    }
    expect(() => F.fixAll(null, V.check)).not.toThrow();
    expect(() => F.fixAll({ pts: "x" })).not.toThrow();
  }, SLOW);

  it("fixAll: the tiny loop and the figure-8 end with no RED within three rounds", () => {
    for (const [label, d] of [["tiny", design({ pts: ellipse(24, 150, 90) })], ["eight", design({ pts: eight() })]] as const) {
      ok(V.check(d).red > 0);
      const before = JSON.stringify(d);
      const r = F.fixAll(d, V.check);
      expect(JSON.stringify(d), `${label}: input untouched`).toBe(before);
      const v = V.check(r.design);
      expect(v.red, `${label}: ${codes(v)} after ${r.applied.join(", ")}`).toBe(0);
      ok(r.applied.length > 0 && r.applied.every((c) => (F.ORDER as readonly string[]).includes(c)));
      ok(onLattice((r.design as Design).pts));
    }
  }, SLOW);

  it("fixAll: a green RANDOMISE loop is a no-op", () => {
    const g = TR.generate(1), d = design({ pts: g.pts, seed: 1 });
    expect(V.check(d).red).toBe(0);
    const r = F.fixAll(d, V.check);
    expect(r.design, "the same design").toBe(d);
    expect(plain(r.applied)).toEqual([]);
  }, SLOW);

  // Heights are parallel to pts by index and props are arc-fraction keyed: a remedy
  // that drops or rotates points must carry both, or every later height slides one
  // point down the road (~80 m measured) and a stand strands on the wrong straight.
  const triples = (d: Design) => d.pts.map((p, i) => p[0] + "," + p[1] + "," + ((d.heights as number[])[i] || 0)).filter((t) => !t.endsWith(",0")).sort();
  it("heights and props ride through a remedy: SPACING and START keep every (x, z, height) triple and each prop's place on the road", () => {
    // SPACING: a point 4 m past point 20 is merged away; the 36 original points keep their own heights.
    const base = ellipse(36, 800, 500), p20 = base[20]!;
    const crowded = base.slice(0, 21).concat([[q(p20[0] + 4), q(p20[1])]], base.slice(21));
    const heights = crowded.map((_, i) => (i === 21 ? 0 : 1 + (i % 9)));
    const props = [{ kind: "stand", s: 0.8, side: 1, gap: 18 }, { kind: "billboard", s: 0.3, side: -1, gap: 12 }];
    const d = design({ pts: crowded, heights, props });
    const { r } = fix(d, "spacing");
    expect(r.design.pts.length).toBe(crowded.length - 1);
    expect((r.design.heights as number[]).length, "heights stay parallel to pts").toBe(r.design.pts.length);
    expect(triples(r.design), "spacing: the heights stay on their points").toEqual(triples(d));
    props.forEach((p, i) => ok(dist(at(d.pts, p.s), at(r.design.pts, zl(r.design, "props")[i]!.s)) <= 0.5, `spacing: prop ${i} stays put`));
    expect(plain(zl(r.design, "props").map((p) => [p.kind, p.side, p.gap])), "…and keeps its kind, side and gap").toEqual(props.map((p) => [p.kind, p.side, p.gap]));
    // START: the line moves to the longest straight, heights rotate with their points, props stay on their road.
    const st = stadium(), ds = design({ pts: st, heights: st.map((_, i) => 1 + (i % 7)), props: [{ kind: "stand", s: 0.1, side: 1, gap: 18 }, { kind: "trees", s: 0.55, side: -1, gap: 24 }] });
    const { r: rs } = fix(ds, "start", { movesStart: true });
    expect((rs.design.heights as number[]).slice().sort((a, b) => a - b), "start: the same heights").toEqual((ds.heights as number[]).slice().sort((a, b) => a - b));
    expect(triples(rs.design), "start: each height still sits on its own point").toEqual(triples(ds));
    zl(ds, "props").forEach((p, i) => ok(dist(at(ds.pts, p.s), at(rs.design.pts, zl(rs.design, "props")[i]!.s)) <= 0.5, `start: prop ${i} stays put`));
  }, SLOW);
});

// ═══════════════════════════════ TrackStamps ═══════════════════════════════
// track-editor-geometry.test.mjs (stamp tests)
function rawBuild(pts: readonly Pt[]): Track {
  const raw = C.toRaw(C.sanitize(design({ pts }))!);
  raw.id = "__stamp-test"; raw.path.pts = pts.map((p): Pt => [p[0], p[1]]);
  return Tracks.buildCenterline(fromRaw(raw as unknown as RawDef));
}
/** Built radius under a stamp: 1 / peak |curv| over the middle 60 % of the arc a → b. */
function midArcRadius(tr: Track, a: Pt, b: Pt): number {
  const near = (p: Pt) => { let best = Infinity, k0 = 0; for (let k = 0; k < tr.n; k++) { const d = Math.hypot(tr.px[k]! - p[0], tr.pz[k]! - p[1]); if (d < best) { best = d; k0 = k; } } return k0; };
  const k0 = near(a), span = ((near(b) - k0) % tr.n + tr.n) % tr.n;
  let peak = 0;
  for (let s = Math.round(span * 0.2); s <= Math.round(span * 0.8); s++) peak = Math.max(peak, Math.abs(tr.curv![(k0 + s) % tr.n]!));
  return 1 / peak;
}
const okSplice = (r: TrackStamps.SpliceResult) => { if (!r.ok) throw new Error(r.reason); return r; };

describe("TrackStamps (f1-game tests/unit/track-editor-geometry.test.mjs)", () => {
  it("stamps: a +90° CORNER builds as a LEFT turn of (about) the requested radius; −90° turns right", () => {
    for (const dir of [1, -1]) {
      const r0 = ST.splice(ellipse(), 5, 8, "corner", { R: 40, deg: 90, dir });
      expect(r0.ok, r0.ok ? "" : r0.reason).toBe(true);
      const r = okSplice(r0);
      expect(r.pts[0], "index 0 (the start line) is kept").toEqual(ellipse()[0]);
      for (let i = 0; i < r.pts.length; i++) { const p = r.pts[i]!, q = r.pts[(i + 1) % r.pts.length]!; ok(Math.hypot(q[0] - p[0], q[1] - p[1]) >= ST.SPACING - 1e-9, "≥ 8 m spacing"); }
      const v = V.check(design({ pts: r.pts }));
      ok(v.tr, "the engine builds it");
      const tr = v.tr!;
      // Read the BUILT curvature under the stamp's own middle control point (the
      // Dubins rejoin behind it may be tighter; that is not what is under test).
      const mid = r.pts[Math.round((r.sel[0] + r.sel[1]) / 2)]!;
      let kNode = 0, best = Infinity;
      for (let k = 0; k < tr.n; k++) { const d = Math.hypot(tr.px[k]! - mid[0], tr.pz[k]! - mid[1]); if (d < best) { best = d; kNode = k; } }
      const kHere = tr.curv![kNode]!;
      ok(dir > 0 ? kHere > 0 : kHere < 0, `+k is LEFT: dir ${dir} gave curvature ${kHere} under the stamp`);
      const builtR = 1 / Math.abs(kHere);
      ok(Math.abs(builtR - 40) / 40 < 0.15, `built radius ${builtR.toFixed(1)} within 15 % of 40 (Laplacian pre-compensation)`);
    }
  }, SLOW);

  it("stamps: insert, wrap past the start line, every kind, and a refusal that names its reason", () => {
    const base = ellipse();
    const ins = okSplice(ST.splice(base, 10, 10, "straight", { L: 300 }));
    ok(ins.pts.length > base.length, "an insert adds road");
    const wrap = ST.splice(base, 34, 2, "hairpin", { R: 18, dir: -1 });
    expect(wrap.ok, wrap.ok ? "" : wrap.reason).toBe(true);
    for (const kind of Object.keys(ST.KINDS)) {
      const s = ST.sample(kind, {}, { x: 0, z: 0, th: 0 });
      ok(s && s.pts.length >= 1, kind);
      ok(Number.isFinite(s!.end.th));
    }
    expect(ST.clampParams("corner", { R: 1, deg: 999, dir: -3 })!.R, "R clamps to the hairpin floor").toBe(ST.R_MIN);
    expect(ST.clampParams("corner", { R: 1, deg: 999, dir: -3 })!.deg).toBe(270);
    expect(ST.clampParams("nope", {})).toBe(null);
    ok(ST.compensate(40, 6.8) > 40 && ST.compensate(40, 6.8) < 41, "pre-compensation grows the sampled radius slightly");
    // A span that would leave fewer than four points of loop is refused, with the reason.
    const tiny = ellipse(8, 60, 40);
    const no = ST.splice(tiny, 1, 6, "corner", {});
    expect(no.ok).toBe(false); expect(no.ok ? "" : no.reason).toMatch(/no room/);
  });

  it("seedFromSegments: a straights-and-turns list becomes a closed ~25 m-spaced loop", () => {
    const segs = [{ t: 0, l: 900 }, { t: 90, l: 120 }, { t: 0, l: 500 }, { t: 90, l: 120 }, { t: 0, l: 900 }, { t: 90, l: 120 }, { t: 0, l: 500 }, { t: 90, l: 120 }];
    const pts = ST.seedFromSegments(segs, 7);
    ok(pts && pts.length > 60, "a loop of controls");
    const L = S.polyLen(pts, true);
    ok(L > 2800 && L < 3600, `about the authored 3.28 km (${L.toFixed(0)}; the integrator's scale is undone)`);
    for (let i = 0; i < pts.length; i++) { const p = pts[i]!, q = pts[(i + 1) % pts.length]!; ok(Math.abs(Math.hypot(q[0] - p[0], q[1] - p[1]) - 25) < 3); }
  });

  it("stamps: arcs are sampled exactly — 8-25 m chords, compensated at their own step, landing on the end pose", () => {
    for (const R of [15, 18, 30, 45, 100, 300, 600]) for (const deg of [10, 35, 90, 180, 270]) {
      const A = deg * Math.PI / 180, { Rc, n } = ST.arcFor(R, A), phi = A / n, chord = 2 * Rc * Math.sin(phi / 2);
      ok(chord >= ST.SPACING - 1e-9 || n === 1, `R ${R} ${deg}°: chord ${chord.toFixed(2)} ≥ 8 m`);
      ok(chord <= 25 + 1e-9 || 2 * Rc * Math.sin(A / (2 * (n + 1))) < ST.SPACING, `R ${R} ${deg}°: chord ${chord.toFixed(2)} ≤ 25 m unless one step more breaks the 8 m rule`);
      const f = 1 - 0.25 * (1 - Math.cos(phi));
      ok(Math.abs(Rc * f * f - R) < 1e-6 * R, `R ${R} ${deg}°: two Laplacian passes at φ ${(phi * 180 / Math.PI).toFixed(1)}° land on R`);
      const pose = { x: 10, z: -20, th: 0.7 }, arc = S.arcPts(pose, Rc, A, 0, n), e = arc.pts[n - 1]!;
      // +sweep is a LEFT turn: heading (sin θ, cos θ) rotates toward +x, centre at pose + Rc (cos θ, −sin θ)
      const cx = pose.x + Rc * Math.cos(pose.th), cz = pose.z - Rc * Math.sin(pose.th);
      for (const p of arc.pts) ok(Math.abs(Math.hypot(p[0] - cx, p[1] - cz) - Rc) < 1e-9 * Rc, "every point on the circle");
      const th1 = pose.th + A;
      ok(Math.hypot(e[0] - (cx - Rc * Math.cos(th1)), e[1] - (cz + Rc * Math.sin(th1))) < 1e-9 * Rc, "the last point is the analytic end");
      ok(Math.abs(arc.end.th - th1) < 1e-12 && arc.end.x === e[0] && arc.end.z === e[1], "end pose = last point, heading + sweep");
    }
  });

  it("stamps: arc chords survive the 0.25 m save lattice — every chord of a snapped arc stays >= 8 m (bug-hunt H7)", () => {
    const q = (v: number) => Math.round(v * 4) / 4;
    let worst = Infinity, cases = 0;
    for (const R of [15, 16, 18, 20, 22, 25, 30, 45, 60, 100, 300]) for (let deg = 10; deg <= 270; deg += 10) for (const th of [0, 0.7, 2.1]) {
      const A = deg * Math.PI / 180, { Rc, n } = ST.arcFor(R, A);
      if (n < 2) continue;   // a one-step arc is one chord: nothing to keep apart (the validator sees it against its neighbours)
      const pose = { x: q(10.13), z: q(-20.37), th }, pts = S.arcPts(pose, Rc, A, 0, n).pts.map((p): Pt => [q(p[0]), q(p[1])]);
      const all: Pt[] = [[pose.x, pose.z] as Pt].concat(pts);
      for (let i = 1; i < all.length; i++) worst = Math.min(worst, Math.hypot(all[i]![0] - all[i - 1]![0], all[i]![1] - all[i - 1]![1]));
      cases++;
    }
    ok(cases > 300, "the sweep ran");
    ok(worst >= ST.SPACING, `shortest snapped chord ${worst.toFixed(3)} m < 8 m: validate reds "Two points closer than 8 m" right after a legal stamp`);
  });

  it("stamps: a CORNER spliced into a 25 m loop BUILDS at the requested radius (±3 %, R 30-300)", () => {
    const base = S.resample(ellipse(36, 900, 500), 25);
    for (const R of [30, 45, 100, 300]) for (const dir of [1, -1]) {
      const r = okSplice(ST.splice(base, 40, 46, "corner", { R, deg: 90, dir }));
      const tr = rawBuild(r.pts);
      const built = midArcRadius(tr, r.pts[r.sel[0] - 1]!, r.pts[r.sel[1]]!);
      ok(Math.abs(built / R - 1) < 0.03, `R ${R} dir ${dir}: built ${built.toFixed(1)} m`);
    }
  }, SLOW);

  it("splice: ≥ 8 m spacing, ≤ 200 points, index 0 stays the start; a 400-stamp fuzz rarely runs out of points", () => {
    const rnd = S.rng(11), kinds = Object.keys(ST.KINDS);
    let many = 0;
    for (let t = 0; t < 400; t++) {
      const base = t % 2 ? ellipse(36 + (t % 40), 700, 450) : TR.generate(t).pts;
      const N = base.length, i0 = Math.floor(rnd() * N), ins = rnd() < 0.5, i1 = ins ? i0 : (i0 + 1 + Math.floor(rnd() * 6)) % N;
      const kind = kinds[Math.floor(rnd() * kinds.length)]!;
      const p = { L: 30 + rnd() * 1400, R: 15 + rnd() * 200, deg: 10 + rnd() * 200, dir: rnd() < 0.5 ? 1 : -1 };
      const r = ST.splice(base, i0, i1, kind, p);
      if (!r.ok) { if (/too many/.test(r.reason)) many++; continue; }
      ok(r.pts.length <= 200, `t ${t}: ${r.pts.length} points`);
      for (let i = 0; i < r.pts.length; i++) {
        const a = r.pts[i]!, b = r.pts[(i + 1) % r.pts.length]!;
        ok(Number.isFinite(a[0]) && Number.isFinite(a[1]), `t ${t}: finite`);
        ok(Math.hypot(b[0] - a[0], b[1] - a[1]) >= ST.SPACING - 1e-9, `t ${t} ${kind}: spacing ${Math.hypot(b[0] - a[0], b[1] - a[1]).toFixed(2)} at ${i}`);
      }
      // Index 0 (the start line) moves only when the replaced span wraps past it.
      if (!(i1 < i0)) expect(r.pts[0], `t ${t}: index 0 is still the start`).toBe(base[0]);
      ok(r.sel[0] > 0 && r.sel[0] <= r.sel[1] && r.sel[1] < r.pts.length, `t ${t}: the selection names the stamp`);
    }
    ok(many <= 8, `${many}/400 stamps ran out of points (≤ 2 %)`);
  }, SLOW);

  // ── SPIRAL: clothoid entry / exit on the curved stamps (TrackStamps.spiralSweep) ──
  const CURVED: { [K in Exclude<StampKindName, "straight">]: { R: number; deg?: number } } = { corner: { R: 60, deg: 90 }, hairpin: { R: 18 }, chicane: { R: 40, deg: 35 }, sbend: { R: 60, deg: 45 } };
  /** The pieces each kind turns, in order (degrees, signed for dir +1). */
  const PIECES: { [kind: string]: (p: { deg?: number }) => number[] } = { corner: (p) => [p.deg!], hairpin: () => [180], chicane: (p) => [p.deg!, -2 * p.deg!, p.deg!], sbend: (p) => [p.deg!, -p.deg!] };
  /** A spiral of length Ls into radius Rc, integrated by Simpson: the classic shift p and tangent offset k. */
  function shiftOf(Rc: number, Ls: number) {
    const N = 2000, f = (s: number) => s * s / (2 * Rc * Ls);
    let x = 0, y = 0;
    for (let i = 0; i <= N; i++) { const s = Ls * i / N, w = i === 0 || i === N ? 1 : i % 2 ? 4 : 2; x += w * Math.cos(f(s)); y += w * Math.sin(f(s)); }
    x *= Ls / N / 3; y *= Ls / N / 3;
    const th = Ls / (2 * Rc);
    return { p: y - Rc * (1 - Math.cos(th)), k: x - Rc * Math.sin(th) };
  }

  it("SPIRAL: every curved stamp turns exactly its angle for Ls 0–80; its exit line moves by the Euler spiral's own shift (a chicane's not at all)", () => {
    const DEG = Math.PI / 180, pose: Pose = { x: 12.5, z: -40.25, th: 0.7 };
    for (const [kind, base] of Object.entries(CURVED)) for (const R of kind === "hairpin" ? [15, 18, 25] : [base.R, 30, 120, 300].filter((r) => r <= ST.KINDS[kind as StampKindName].max.R!)) for (const Ls of [0, 20, 40, 80]) for (const dir of [1, -1]) {
      const Pp = Object.assign({}, base, { R, dir, Ls }), what = `${kind} R ${R} Ls ${Ls} dir ${dir}`;
      const st = ST.sample(kind, Pp, pose)!, flat = ST.sample(kind, Object.assign({}, Pp, { Ls: 0 }), pose)!;
      const pieces = PIECES[kind]!(Pp).map((d) => d * DEG);
      const net = pieces.reduce((a, b) => a + b, 0) * dir;
      ok(Math.abs(st.end.th - pose.th - net) < 1e-9, `${what}: heading change ${(st.end.th - pose.th) / DEG}° = ${net / DEG}°`);
      let shift = 0;
      for (const A of pieces) {
        const sp = ST.spiralSweep(R, Ls, Math.abs(A));
        ok(Math.abs(2 * sp.sweep + sp.arc - Math.abs(A)) < 1e-12, `${what}: two spirals + the arc turn the piece's ${Math.abs(A) / DEG}°`);
        ok(sp.Ls === 0 || (sp.Ls >= 17 && sp.Ls <= 2 * ST.LS_MAX), `${what}: Ls' ${sp.Ls}`);
        if (sp.Ls > 0) { const { p, k } = shiftOf(sp.Rc, sp.Ls), a = Math.abs(A); shift += p * (1 - Math.cos(a)) + k * Math.sin(a); }
      }
      // A chicane's pieces cancel (+A, −2A, +A); a hairpin's 180° is 2p; a corner's p(1 − cos A) + k sin A; an S-bend twice that.
      if (kind === "chicane") shift = 0;
      const off = (st.end.x - flat.end.x) * Math.cos(flat.end.th) - (st.end.z - flat.end.z) * Math.sin(flat.end.th);
      ok(Math.abs(Math.abs(off) - shift) < 0.5, `${what}: the end sits ${off.toFixed(3)} m off the Ls = 0 stamp's exit line, the spiral shift is ${shift.toFixed(3)} m`);
      if (Ls === 0) expect(st.pts).toEqual(flat.pts);
    }
  });

  it("SPIRAL: Ls 0 (or omitted) is the pre-spiral stamp byte for byte; a spiralled stamp keeps 8 m spacing and splices", () => {
    // fnv1a over every pre-spiral sample, pinned in f1-game ("8d93271b").
    const digest = (extra: object) => {
      let h = 0x811c9dc5;
      const feed = (s: string) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } };
      for (const kind of ["corner", "hairpin", "chicane", "sbend"]) for (const R of [15, 18, 25, 30, 45, 60, 100, 300, 600]) for (const deg of [10, 35, 60, 90, 120, 180, 270]) for (const dir of [1, -1]) {
        const st = ST.sample(kind, Object.assign({ R, deg, dir }, extra), { x: 12.5, z: -40.25, th: 0.7 })!;
        feed(JSON.stringify([st.pts, st.end]));
      }
      return (h >>> 0).toString(16);
    };
    expect(digest({}), "Ls omitted: the pre-spiral output").toBe("8d93271b");
    expect(digest({ Ls: 0 }), "Ls 0: the same").toBe("8d93271b");
    expect(digest({ Ls: 40 })).not.toBe("8d93271b");
    expect(ST.clampParams("corner", { Ls: 999 })!.Ls).toBe(80); expect(ST.clampParams("hairpin", { Ls: -5 })!.Ls).toBe(0);
    expect("Ls" in ST.clampParams("straight", {})!, "a straight has no spiral").toBe(false);
    const minChord = (st: StampSample) => { let prev: Pt = [0, 0], m = Infinity; for (const p of st.pts) { m = Math.min(m, Math.hypot(p[0] - prev[0], p[1] - prev[1])); prev = p; } return m; };
    for (const kind of Object.keys(CURVED)) for (let R = 15; R <= 300; R += 7) for (const deg of [10, 45, 90, 180, 270]) for (const Ls of [5, 10, 25, 50, 80]) {
      // Where the plain stamp already clears the spacing rule (a 10° arc at R 15 is 2.6 m long: it does not).
      if (minChord(ST.sample(kind, { R, deg, dir: 1 }, { x: 0, z: 0, th: 0 })!) < ST.SPACING) continue;
      ok(minChord(ST.sample(kind, { R, deg, Ls, dir: 1 }, { x: 0, z: 0, th: 0 })!) >= ST.SPACING, `${kind} R ${R} ${deg}° Ls ${Ls}: spacing`);
    }
    const rnd = S.rng(5), kinds = Object.keys(CURVED);
    let n = 0;
    for (let t = 0; t < 120; t++) {
      const base = TR.generate(t).pts, N = base.length, i0 = Math.floor(rnd() * N), i1 = (i0 + Math.floor(rnd() * 5)) % N;
      const r = ST.splice(base, i0, i1, kinds[t % 4]!, { R: 15 + rnd() * 200, deg: 10 + rnd() * 200, dir: rnd() < 0.5 ? 1 : -1, Ls: 20 + rnd() * 60 });
      if (!r.ok) continue;
      n++;
      ok(r.pts.length <= 200);
      for (let i = 0; i < r.pts.length; i++) { const a = r.pts[i]!, b = r.pts[(i + 1) % r.pts.length]!; ok(Math.hypot(b[0] - a[0], b[1] - a[1]) >= ST.SPACING - 1e-9, `t ${t}: spacing at ${i}`); }
    }
    ok(n >= 100, n + "/120 spiralled splices");
  }, SLOW);

  it("SPIRAL: a spiralled CORNER builds at its radius (±5 %, R 30–300) and the curvature steps at its ends drop ≥ 30 %", () => {
    // Three identical 120° corners and three straights: a loop that closes by
    // symmetry, so no Dubins rejoin sits beside the corner under test.
    const loop = (R: number, Ls: number) => {
      let cur: Pose = { x: 0, z: 0, th: 0 };
      const pts: Pt[] = [[0, 0]], marks: [number, number][] = [];
      for (let k = 0; k < 3; k++) {
        const st = ST.sample("straight", { L: R > 200 ? 500 : 700 }, cur)!; pts.push(...st.pts); cur = st.end;
        const c = ST.sample("corner", { R, deg: 120, dir: -1, Ls }, cur)!; marks.push([pts.length - 1, pts.length - 1 + c.pts.length]); pts.push(...c.pts); cur = c.end;
      }
      pts.pop();                                            // the last corner ends on point 0
      return { pts, marks };
    };
    const measure = (R: number, Ls: number) => {
      const { pts, marks } = loop(R, Ls), tr = rawBuild(pts), curv = tr.curv!;
      const near = (p: Pt) => { let best = Infinity, k0 = 0; for (let k = 0; k < tr.n; k++) { const d = Math.hypot(tr.px[k]! - p[0], tr.pz[k]! - p[1]); if (d < best) { best = d; k0 = k; } } return k0; };
      let err = 0, dk = 0;
      for (const [i0, i1] of marks) {
        const a = near(pts[i0]!), span = ((near(pts[i1 % pts.length]!) - a) % tr.n + tr.n) % tr.n;
        let peak = 0;
        for (let s = 0; s <= span; s++) peak = Math.max(peak, Math.abs(curv[(a + s) % tr.n]!));
        err = Math.max(err, Math.abs(1 / peak / R - 1));
        // node-to-node curvature steps over the corner and 60 m either side of it
        for (let s = -15; s <= span + 15; s++) { const k = (a + s + tr.n) % tr.n; dk = Math.max(dk, Math.abs(curv[(k + 1) % tr.n]! - curv[k]!)); }
      }
      return { err, dk };
    };
    for (const R of [30, 60, 120, 300]) {
      const flat = measure(R, 0), sp = measure(R, 80), cut = 1 - sp.dk / flat.dk;
      const row = `R ${R}: apex ${(sp.err * 100).toFixed(1)} % off (Ls 0: ${(flat.err * 100).toFixed(1)} %), max |Δk| ${flat.dk.toExponential(2)} → ${sp.dk.toExponential(2)} (−${(cut * 100).toFixed(0)} %)`;
      ok(sp.err < 0.05, row);
      ok(cut >= 0.3, row);
    }
  }, SLOW);
});

// ═══════════════════════════════ ElevPresets ═══════════════════════════════
// elev-presets.test.mjs
describe("ElevPresets (f1-game tests/unit/elev-presets.test.mjs)", () => {
  function oval(n = 16, rx = 700, rz = 450): Pt[] {
    const pts: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push([Math.round(Math.cos(a) * rx * 4) / 4, Math.round(Math.sin(a) * rz * 4) / 4]);
    }
    return pts;
  }

  it("sanitize: missing heights → flat zeros; clamps to ±60 on the 0.25 m lattice", () => {
    const pts = oval(12);
    expect(E.sanitize(pts, null)).toEqual(pts.map(() => 0));
    expect(E.sanitize(pts, [])).toEqual(pts.map(() => 0));
    expect(E.sanitize(pts, [1, 2])).toEqual([1, 2].concat(pts.slice(2).map(() => 0)).map((h, i) => i < 2 ? h : 0));
    const big = E.sanitize(pts, pts.map(() => 999));
    ok(big.every((h) => h === 60));
    const tiny = E.sanitize(pts, [0.12, -0.13].concat(pts.slice(2).map(() => 0)));
    expect(tiny[0]).toBe(0); // Math.round(0.12*4)/4 = Math.round(0.48)/4 = 0
    expect(E.clampH(0.3)).toBe(0.25);
    expect(E.clampH(-0.3)).toBe(-0.25);
  });

  it("Flat / Rolling / Hilly presets write node heights; deterministic; undo-shaped replace", () => {
    const pts = oval(20);
    const flat = E.apply("flat", pts, { seed: 7 });
    expect(flat.style).toBe("flat");
    ok(E.isFlat(flat.heights));
    expect(flat.heights.length).toBe(pts.length);

    const roll = E.apply("rolling", pts, { seed: 7 });
    expect(roll.style).toBe("rolling");
    expect(roll.heights.length).toBe(pts.length);
    expect(E.isFlat(roll.heights), "rolling moves some nodes").toBe(false);
    ok(roll.heights.every((h) => Math.abs(h) <= 60));
    expect(roll.heights[0], "start pinned flat for a closed loop").toBe(0);

    const again = E.apply("rolling", pts, { seed: 7 });
    expect(again.heights, "deterministic per seed").toEqual(roll.heights);

    const hilly = E.apply("hilly", pts, { seed: 7 });
    expect(hilly.style).toBe("hilly");
    const maxR = Math.max(...roll.heights.map(Math.abs));
    const maxH = Math.max(...hilly.heights.map(Math.abs));
    ok(maxH >= maxR, "hilly peaks at least as high as rolling for the same seed");

    // One-shot replace (what commit uses): Flat clears Rolling.
    const cleared = E.apply("flat", pts, { seed: 99 });
    ok(E.isFlat(cleared.heights));
  });

  it("unknown style → flat; short pts → flat", () => {
    expect(E.apply("mystery", oval(10)).style).toBe("flat");
    expect(E.apply("hilly", [[0, 0], [1, 0]]).heights).toEqual([0, 0]);
  });
});

// ═══════════════════════════ DesignerSceneryPreview ═══════════════════════════
// designer-canvas.test.mjs, designer-props.test.mjs
describe("DesignerSceneryPreview (f1-game tests/unit/designer-canvas.test.mjs, designer-props.test.mjs)", () => {
  it("live scenery supports every theme with finite, bounded, deterministic footprints", () => {
    const d = design(), tr = V.check(d).tr!;
    const before = plain(d);
    for (const theme of TrackThemes.ORDER) {
      const props = TrackDesignerProps.KINDS.map((kind, i) => ({ kind, s: 0.1 + i * 0.06, side: 1, gap: TrackDesignerProps.DEFAULT_GAP[kind] }));
      const scene = P.plan({ ...d, theme, props }, tr)!, objects = [...scene.items, ...scene.ground];
      ok(objects.length > 0 && objects.length <= P.LIMIT, theme);
      for (const item of objects) ok([item.x, item.z, item.w, item.d, item.angle, ...item.col].every(Number.isFinite), theme + ": " + item.kind);
    }
    // f1-game also asserts no Log.warn from swallowed recipe failures; the port drops Log, so that assertion is not portable.
    expect(plain(P.plan(d, tr)), "same design keeps scenery stable").toEqual(plain(P.plan(d, tr)));
    expect(plain(d), "preview does not alter the saved design").toEqual(before);
    const few = P.plan({ ...d, look: { trees: "few", crowd: "few" } }, tr)!;
    const many = P.plan({ ...d, look: { trees: "many", crowd: "packed" } }, tr)!;
    ok(many.items.length > few.items.length, "density settings reach the preview");
    expect(P.plan({ ...d, look: { time: "night" } }, tr)!.night).toBe(true);
    const prop = { kind: "marshal", s: 0.2, side: 1, gap: 25 };
    const withProp = P.plan({ ...d, props: [prop] }, tr)!.items.filter((x) => x.kind === "marshal");
    const moved = P.plan({ ...d, props: [{ ...prop, gap: 50 }] }, tr)!.items.filter((x) => x.kind === "marshal");
    expect(withProp.length).toBe(moved.length);
    ok(withProp.length > 0);
    ok(withProp.some((p, i) => Math.hypot(p.x - moved[i]!.x, p.z - moved[i]!.z) > 20), "roadside gap changes the footprint");
  }, SLOW);

  it("water preview footprints retain native world-axis alignment", () => {
    const d = design(), tr = V.check(d).tr!;
    const scene = P.plan({ ...d, theme: "lakeside" }, tr)!;
    const water = scene.ground.filter((item) => item.kind === "water");
    ok(water.length > 0, "theme emits water for the orientation check");
    ok(water.every((item) => item.angle === 0), "waterSurface renders world-axis boxes, independently of the road normal");
  }, SLOW);

  it("landscapes reach the overhead preview (designer-props: the preview half)", () => {
    // The race-mesh half (Tracks.build with def.scenery) needs the scenery builder,
    // which src/track/core/tracks.ts stubs (TODO(lane-scenery)); not ported.
    for (const kind of TrackDesignerProps.KINDS.slice(15)) {
      const d = C.sanitize(design({ props: [{ kind, s: 0, side: -1, gap: 100 }] }))!;
      const def = fromRaw(C.toRaw(d) as unknown as RawDef);
      const tr = Tracks.buildCenterline(def, { line: false });
      const scene = P.plan(d, tr);
      ok(scene && scene.items.length + scene.ground.length > 0, kind + " preview builds");
    }
  }, SLOW);

  it("plan refuses no design / no track; draw paints both layers onto a 2D context without throwing", () => {
    const d = design(), tr = V.check(d).tr!;
    expect(P.plan(null, tr)).toBe(null);
    expect(P.plan(d, null)).toBe(null);
    const scene = P.plan({ ...d, look: { time: "dusk" } }, tr)!;
    const calls: string[] = [];
    const g = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) => (k in t ? t[k] : (...a: unknown[]) => { calls.push(k); void a; }),
      set: (t, k: string, v) => { t[k] = v; return true; },
    }) as unknown as CanvasRenderingContext2D;
    const view = { scale: 0.1, cx: scene.bounds.cx, cz: scene.bounds.cz, w: 400, h: 300 };
    expect(() => P.draw(g, scene, view, "ground")).not.toThrow();
    ok(calls.includes("fillRect") && calls.includes("ellipse"), "the ground layer paints");
    const n = calls.length;
    expect(() => P.draw(g, scene, view, "items")).not.toThrow();
    ok(calls.length > n && calls.filter((c) => c === "save").length === calls.filter((c) => c === "restore").length, "items paint, save/restore balanced");
    expect(() => P.draw(g, null, view, "items")).not.toThrow();
  }, SLOW);
});

// ═══════════════════════ properties over the goldens' designs ═══════════════════════
interface DesignRow { label: string; input: unknown; sanitized: unknown; validate?: { red: number } }
const revive = (_k: string, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && "$n" in v ? Number((v as { $n: string }).$n) : v;
const G = JSON.parse(gunzipSync(readFileSync(new URL("../goldens/editor-codec.json.gz", import.meta.url))).toString(), revive) as { designs: DesignRow[] };
const sanitized = G.designs.filter((d) => d.sanitized && typeof d.sanitized === "object").map((d) => [d.label, d.sanitized as Design] as const);
const failing = sanitized.filter(([, d]) => V.check(d).red > 0);
const green = sanitized.filter(([, d]) => V.check(d).red === 0);

describe("properties over tests/goldens/editor-codec.json.gz designs", () => {
  it("the goldens hold failing and green designs", () => { ok(failing.length >= 3); ok(green.length >= 30); });

  it.each(failing)("every fix that applies to %s's REDs is a new lattice design that reduces or resolves that issue", (_label, d) => {
    const before = JSON.stringify(d);
    const v = V.check(d);
    const fixable = v.issues.filter((i: Issue) => i.level === "red" && F.canFix(i));
    ok(fixable.length > 0, "a fixable RED");
    let applied = 0;
    for (const code of new Set(fixable.map((i) => i.code))) {
      const count = (w: Verdict) => w.issues.filter((i) => i.level === "red" && i.code === code).length;
      let r: FixResult | null = null;
      for (const it of fixable.filter((i) => i.code === code)) { r = F.apply(d, it, v); if (r) break; }
      // A remedy may decline (null): START on a loop with no straight to move to (minimal-octagon).
      if (!r) continue;
      applied++;
      ok(r.design !== d && r.design.pts.every((p) => Number.isInteger(p[0] * 4) && Number.isInteger(p[1] * 4)), `${code}: on the lattice`);
      ok(count(V.check(r.design)) < count(v), `${code}: reduced or resolved`);
      ok(C.sanitize(r.design, { loose: true }), `${code}: still a design`);
    }
    ok(applied > 0, "at least one remedy applies");
    expect(JSON.stringify(d), "the input is not mutated").toBe(before);
    const all = F.fixAll(d, V.check);
    ok(all.verdict && all.verdict.red < v.red, `fixAll: ${v.red} → ${all.verdict && all.verdict.red} RED`);
  }, SLOW);

  it.each(green)("fixAll leaves the green %s alone", (_label, d) => {
    const r = F.fixAll(d, V.check);
    expect(r.design).toBe(d);
    expect(r.applied).toEqual([]);
  }, SLOW);

  it.each(green)("every stamp kind spliced into %s gives a sanitizable design", (_label, d) => {
    const N = d.pts.length;
    for (const kind of Object.keys(ST.KINDS)) for (const [i0, i1] of [[3, 3], [Math.floor(N / 2), Math.floor(N / 2) + 3]] as const) {
      const r = ST.splice(d.pts, i0, i1, kind, {});
      if (!r.ok) { expect(r.reason).toMatch(/no room|too many/); continue; }
      const sane = C.sanitize(Object.assign({}, d, { pts: r.pts.map((p): Pt => [Math.round(p[0] * 4) / 4, Math.round(p[1] * 4) / 4]) }));
      ok(sane, `${kind} [${i0}, ${i1}]: sanitizes`);
      expect(sane!.pts.length, `${kind}: every point survives`).toBe(r.pts.length);
    }
  }, SLOW);

  it.each(green)("every elevation preset on %s sanitizes to itself", (_label, d) => {
    for (const style of E.NAMES) {
      const r = E.apply(style, d.pts, { seed: 3 });
      expect(r.heights.length).toBe(d.pts.length);
      expect(C.sanitizeHeights(d.pts, r.heights), style).toEqual(r.heights);
      expect(E.sanitize(d.pts, r.heights), style).toEqual(r.heights);
    }
  });
});
