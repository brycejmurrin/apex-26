import { describe, expect, it } from "vitest";
import {
  b64url, decode, decodeBytes, encode, encodeBytes, FILE_FORMAT, fileEnvelope, fromFile, fromHash,
  inflate, MAX_CODE, shareUrl, unb64url, withoutTrack,
} from "../../src/editor/codec";
import { createCustomTracks, customDef, idOf, KEY, LIMITS, sanitize } from "../../src/editor/custom-tracks";
import type { BuiltDef } from "../../src/track/core/def";
import { memoryStore } from "../../src/editor/store";
import { buildTrack, validateGeometry } from "../../src/track/core/tracks";

/** A 24-point oval (~1.9 km control polygon) with every optional field set. */
function oval(n = 24) {
  const pts: [number, number][] = [];
  const heights: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([Math.cos(a) * 380 + 0.13, Math.sin(a) * 240 - 0.07]);
    heights.push(i < n / 2 ? Math.sin(a) * 6 : 0);
  }
  return {
    name: "Test Ring", seed: 1234, theme: "parkland", baseHW: 6.5, pts, heights,
    hwZones: [{ s0: 0.1, s1: 0.2, hw: 5.5, ease: 0.03 }],
    bankZones: [{ frac: 0.25, angleDeg: 12, widthM: 120 }],
    elevations: [{ s: 0.6, halfM: 200, rise: 4 }],
    bridges: [] as { s: number; halfM: number; rise: number }[],
  };
}

/** 200 points round a 600 x 400 m rectangle: long runs of zero second-order deltas. */
function rectangle() {
  const pts: [number, number][] = [];
  for (let i = 0; i < 60; i++) pts.push([i * 10, 0]);
  for (let i = 0; i < 40; i++) pts.push([600, i * 10]);
  for (let i = 0; i < 60; i++) pts.push([600 - i * 10, 400]);
  for (let i = 0; i < 40; i++) pts.push([0, 400 - i * 10]);
  return { name: "BOX", seed: 7, theme: "parkland", baseHW: 7, pts };
}

/** The storage lattice for a lap fraction (custom-tracks.ts frac). */
const lat = (v: number) => (Math.round((v - Math.floor(v)) * 65535) % 65535) / 65535;

const stable = (d: object) => {
  const o = { ...(d as Record<string, unknown>) };
  delete o.created; delete o.updated;
  return o;
};

describe("TrackCodec", () => {
  it("round-trips a sanitised design byte-for-byte", async () => {
    const it0 = sanitize(oval())!;
    expect(it0).not.toBeNull();
    const code = (await encode(it0))!;
    expect(code).toMatch(/^APXT1\.[pz]\.[A-Za-z0-9_-]+$/);
    const r = await decode(code);
    if (!r.ok) throw new Error(r.reason);
    expect(r.id).toBe(it0.id);
    expect(stable(r.design)).toEqual(stable(it0));
    expect(r.design.name).toBe("TEST RING");
    expect(r.design.heights.some((h) => h !== 0)).toBe(true);
    // The bytes are a fixed point of encode ∘ decode.
    expect(Array.from(encodeBytes(r.design))).toEqual(Array.from(encodeBytes(it0)));
    // The p-path bytes are the base64url of encodeBytes.
    const p = "APXT1.p." + b64url(encodeBytes(it0));
    const rp = await decode(p);
    expect(rp.ok && rp.id).toBe(it0.id);
    expect(Array.from(unb64url(p.slice(8))!)).toEqual(Array.from(encodeBytes(it0)));
  });

  it("takes the deflate-raw path when it is shorter, and inflates it back", async () => {
    const it0 = sanitize(rectangle())!;
    expect(it0).not.toBeNull();
    const code = (await encode(it0))!;
    expect(code.startsWith("APXT1.z.")).toBe(true);
    expect(code.length).toBeLessThan(("APXT1.p." + b64url(encodeBytes(it0))).length);
    const z = await inflate(unb64url(code.slice(8))!);
    expect(z.ok && Array.from(z.bytes)).toEqual(Array.from(encodeBytes(it0)));
    const r = await decode(code);
    expect(r.ok && r.id).toBe(it0.id);
  });

  it("refuses malformed codes with { ok: false, reason } and never throws", async () => {
    const good = (await encode(sanitize(oval())!))!;
    const bytes = encodeBytes(sanitize(oval())!);
    const flipped = Uint8Array.from(bytes); flipped[5] = flipped[5]! ^ 0xff;
    const cases: unknown[] = [
      undefined, null, 42, {}, "", "garbage", "APXT9.p.AAAA", "APXT1.q.AAAA", "APXT1.p.!!!!",
      "APXT1.p.AAAA", "APXT1.z.AAAAAAAA", "APXT2.p." + b64url(bytes), "APXT1.p." + b64url(flipped),
      good.slice(0, good.length - 6), "APXT1.p." + "A".repeat(MAX_CODE),
    ];
    for (const c of cases) {
      const r = await decode(c);
      expect(r.ok, String(c).slice(0, 40)).toBe(false);
      if (!r.ok) expect(typeof r.reason).toBe("string");
    }
    expect((await decode("APXT1.p." + "A".repeat(MAX_CODE))).ok === false && "bounds").toBe("bounds");
    expect(decodeBytes(new Uint8Array(4))).toEqual({ ok: false, reason: "bounds" });
    expect(decodeBytes(flipped)).toEqual({ ok: false, reason: "check" });
    expect(decodeBytes(null)).toEqual({ ok: false, reason: "bounds" });
    // A list over ZONE_CAPS is refused, not truncated.
    const many = sanitize(oval())!;
    many.elevations = Array.from({ length: 25 }, (_, i) => ({ s: i / 25, halfM: 30, rise: 1 }));
    expect(() => encodeBytes(many)).toThrow(RangeError);
  });

  it("reads #track= fragments, builds share URLs and file envelopes", async () => {
    const code = (await encode(sanitize(oval())!))!;
    const url = shareUrl(code, "https://example.test/apex/");
    expect(url).toBe("https://example.test/apex/#track=" + code);
    expect(fromHash(new URL(url).hash)).toBe(code);
    expect(fromHash("#ghost=1&track=" + encodeURIComponent(code))).toBe(code);
    expect(fromHash("#ghost=1")).toBeNull();
    expect(fromHash("#track=%E0%A4%A")).toBeNull();
    expect(fromHash(undefined)).toBeNull();
    expect(withoutTrack("#ghost=1&track=" + code)).toBe("#ghost=1");
    expect(withoutTrack("#track=" + code)).toBe("");
    const design = sanitize(oval())!;
    const env = JSON.parse(JSON.stringify(fileEnvelope(design, code)));
    expect(env.format).toBe(FILE_FORMAT);
    expect(env.v).toBe(1);
    expect(fromFile(env)).toEqual({ code });
    expect(fromFile({ format: FILE_FORMAT, design: { pts: [] } })).toEqual({ design: { pts: [] } });
    expect(fromFile({ format: "nope", code })).toBeNull();
    expect(fromFile(null)).toBeNull();
  });
});

describe("CustomTracks", () => {
  it("sanitize clamps every field to LIMITS", () => {
    const d = oval();
    const it0 = sanitize({
      ...d, name: "  très  long name that keeps going on and on ", baseHW: 20, seed: -1.5,
      theme: "no-such-theme", country: "Italy<script>",
      heights: d.heights.map(() => 500),
      hwZones: [{ s0: 1.25, s1: -0.5, hw: 2 }],
      bankZones: [{ frac: 0.5, angleDeg: 90, widthM: 5000 }, { frac: 0.5, angleDeg: 0, widthM: 10 }],
      elevations: [{ s: lat(0.5), halfM: 40, rise: 60 }],
      lengthM: 1,
    })!;
    expect(it0.name).toBe("TRS LONG NAME THAT KEEPS");
    expect(it0.name.length).toBeLessThanOrEqual(LIMITS.name);
    expect(it0.baseHW).toBe(LIMITS.hwMax);
    expect(sanitize({ ...d, baseHW: 1 })!.baseHW).toBe(LIMITS.hwMin);
    expect(it0.seed).toBe(Math.floor(-1.5) >>> 0);
    expect(it0.theme).toBe("parkland");
    expect(it0.country).toBe("Italyscript");
    expect(it0.heights.every((h) => h === LIMITS.rise)).toBe(true);
    expect(it0.hwZones).toEqual([{ s0: lat(0.25), s1: lat(0.5), hw: 5, ease: 0.025 }]);
    expect(it0.bankZones).toEqual([{ frac: lat(0.5), angleDeg: 30, widthM: 600 }, { frac: lat(0.5), angleDeg: 1, widthM: 20 }]);
    // Grade cap: |rise| <= halfM / 19.6, on the quarter lattice.
    expect(it0.elevations).toEqual([{ s: lat(0.5), halfM: 40, rise: Math.round((40 / 19.6) * 4) / 4 }]);
    expect(it0.lengthM).toBeGreaterThan(1000);
    expect(it0.pts.every(([x, z]) => x * 4 === Math.round(x * 4) && z * 4 === Math.round(z * 4))).toBe(true);
    // Refusals.
    expect(sanitize(null)).toBeNull();
    expect(sanitize({ pts: d.pts.slice(0, 7) })).toBeNull();
    expect(sanitize({ pts: d.pts.map(([x, z], i) => (i ? [x, z] : [LIMITS.coord + 1, z])) })).toBeNull();
    const tight = d.pts.map(([x, z], i): [number, number] => (i === 1 ? [d.pts[0]![0] + 1, d.pts[0]![1]] : [x, z]));
    expect(sanitize({ pts: tight })).toBeNull();
    expect(sanitize({ pts: tight }, { loose: true })).not.toBeNull();
  });

  it("idOf is stable and keys on shape, not labels", () => {
    const a = sanitize(oval())!;
    expect(a.id).toMatch(/^custom-[0-9a-f]{8}$/);
    expect(sanitize(oval())!.id).toBe(a.id);
    expect(sanitize(a)!.id).toBe(a.id);
    expect(idOf(a)).toBe(a.id);
    expect(sanitize({ ...oval(), name: "Other", country: "Italy" })!.id).toBe(a.id);
    expect(sanitize({ ...oval(), theme: "alpine" })!.id).not.toBe(a.id);
    expect(sanitize({ ...oval(), seed: 99 })!.id).not.toBe(a.id);
    expect(sanitize({ ...oval(), kerbStyle: "sausage" })!.id).not.toBe(a.id);
    expect(sanitize({ ...oval(), heights: [] })!.id).not.toBe(a.id);
  });

  it("customDef(design) builds valid geometry", () => {
    const def: BuiltDef = customDef(oval());
    expect(def.custom).toBe(true);
    expect(def.id).toBe(sanitize(oval())!.id);
    const track = buildTrack(def);
    for (const k of ["floor", "road", "terrain", "gate", "startline"] as const) {
      const g = validateGeometry(track.geo![k]);
      expect(g.ok, k + ": " + g.reason).toBe(true);
      expect(g.vertices!).toBeGreaterThan(0);
    }
    expect(() => customDef({ pts: [] })).toThrow(/geometry/);
  });

  it("the store-backed registry upserts, lists, replaces and removes", () => {
    const store = memoryStore();
    let tail: BuiltDef[] = [];
    const ct = createCustomTracks(store, { setCustomTail: (defs) => { tail = defs; } });
    expect(ct.list()).toEqual([]);
    const r = ct.upsert(oval());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ct.get(r.id)!.name).toBe("TEST RING");
    expect(tail.map((d) => d.id)).toEqual([r.id]);
    expect(JSON.parse(store.data[KEY]!).items).toHaveLength(1);
    const r2 = ct.upsert({ ...oval(), theme: "alpine" }, { replace: r.id });
    expect(r2.ok && r2.replaced).toBe(r.id);
    expect(ct.list().map((x) => x.id)).toEqual([r2.ok ? r2.id : ""]);
    ct.setDraft({ a: 1 });
    expect(ct.draft()).toEqual({ a: 1 });
    ct.setDraft(null);
    expect(ct.draft()).toBeNull();
    const exp = ct.exportCollection();
    expect(ct.remove(r2.ok ? r2.id : "").ok).toBe(true);
    expect(ct.list()).toEqual([]);
    const imp = ct.importCollection(JSON.parse(JSON.stringify(exp)));
    expect(imp).toMatchObject({ ok: true, added: 1, skipped: 0 });
    expect(ct.importCollection({ format: "x" })).toEqual({ ok: false, reason: "format" });
  });
});
