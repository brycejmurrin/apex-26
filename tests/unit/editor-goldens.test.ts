// The editor core against f1-game's own code (tests/goldens/editor-codec.json.gz, produced by
// tools/oracle/editor-dump.cjs in the coordinator session): sanitize, canonical, the APXT share
// codes byte for byte, decode, the file envelope, toRaw, defFields, customDef and the built track,
// plus the malformed-code and bad-sanitize refusals. Date.now is pinned to the dump's clock, and
// every value goes through the dump's own plain() (functions and undefined dropped).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Codec from "../../src/editor/codec";
import * as CustomTracks from "../../src/editor/custom-tracks";
import * as Themes from "../../src/editor/track-themes";
import { buildTrack } from "../../src/track/core/tracks";
import type { SealedGeom, TrackGeometry } from "../../src/track/core/types";

type Json = unknown;
interface DesignRow {
  label: string; input: Json; sanitized: Json; canonical?: string; code?: Json; codeFromInput?: Json;
  encodeBytes?: Json; encodeBytesNoName?: Json; decoded?: Json; shareUrl?: string | null; fromHash?: string | null;
  fileEnvelope?: Json; fromFile?: Json; fromFileDesignOnly?: Json; raw?: Json; defFields?: Record<string, Json>; def?: Json;
  track?: { scalars: Record<string, Json>; arrays: Record<string, number[]>; pit: { scalars: Record<string, Json>; arrays: Record<string, number[]> } | null;
            bankP: Record<string, number[]> | null; meshes: MeshRow[] };
}
interface MeshRow { verts: number; idx: number; pos: string; nrm: string; col: string; idxHash: string; mat: string | null }
interface Golden {
  header: { clock: number };
  themes: { ORDER: string[]; LOOK: Json }; codec: Record<string, Json>; limits: Record<string, Json>;
  designs: DesignRow[];
  badCodes: { label: string; code?: Json; result: Json }[];
  badSanitize: { label: string; input: Json; opts: { loose?: boolean } | null; result: Json }[];
}

/** The dump encodes -0 / NaN as {$n: "..."}. */
const revive = (_k: string, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && "$n" in v ? Number((v as { $n: string }).$n) : v;
const G = JSON.parse(gunzipSync(readFileSync(new URL("../goldens/editor-codec.json.gz", import.meta.url))).toString(), revive) as Golden;

/** tools/oracle/editor-dump.cjs plain(): functions/undefined dropped, typed arrays as arrays, array holes as null. */
function plain(v: unknown, seen = new Set<object>()): unknown {
  if (v === undefined || typeof v === "function" || typeof v === "symbol") return undefined;
  if (v === null || typeof v !== "object") return v;
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
  if (seen.has(v)) return { $cycle: true };
  seen.add(v);
  let out: unknown;
  if (Array.isArray(v)) out = v.map((e) => { const p = plain(e, seen); return p === undefined ? null : p; });
  else { const o: Record<string, unknown> = {}; for (const k of Object.keys(v)) { const p = plain((v as Record<string, unknown>)[k], seen); if (p !== undefined) o[k] = p; } out = o; }
  seen.delete(v);
  return out;
}
const tryIt = (fn: () => unknown) => { try { return plain(fn()); } catch (e) { return { $error: String((e as Error).message ?? e) }; } };
const tryAsync = async (fn: () => Promise<unknown>) => { try { return plain(await fn()); } catch (e) { return { $error: String((e as Error).message ?? e) }; } };

const sha = (a: ArrayLike<number> | undefined, T: Float64ArrayConstructor | Uint32ArrayConstructor) =>
  a ? createHash("sha256").update(new Uint8Array(T.from(a).buffer)).digest("hex") : null;
const meshRow = (g: SealedGeom): MeshRow => ({ verts: g.pos.length / 3, idx: g.idx.length,
  pos: sha(g.pos, Float64Array)!, nrm: sha(g.nrm, Float64Array)!, col: sha(g.col, Float64Array)!, idxHash: sha(g.idx, Uint32Array)!, mat: sha(g.mat, Uint32Array) });
const MESH_ORDER: (keyof TrackGeometry)[] = ["floor", "road", "terrain", "props", "glass", "water", "gate", "startline"];
const SCENERY_MESHES = new Set<keyof TrackGeometry>(["props", "glass", "water"]);
const same = (a: unknown, b: unknown) => Object.is(a, b) || (b === 0 && a === 0);

beforeAll(() => { vi.spyOn(Date, "now").mockReturnValue(G.header.clock); });
afterAll(() => { vi.restoreAllMocks(); });

describe("editor constants", () => {
  it("theme ORDER / LOOK, codec constants and LIMITS", () => {
    expect(Themes.ORDER).toEqual(G.themes.ORDER);
    expect(plain(Themes.LOOK)).toEqual(G.themes.LOOK);
    for (const [k, v] of Object.entries(G.codec)) expect(plain((Codec as unknown as Record<string, unknown>)[k]), k).toEqual(v);
    expect(plain(CustomTracks.LIMITS)).toEqual(G.limits);
  });
});

describe.each(G.designs.map((d) => [d.label, d] as const))("design %s", (_label, d) => {
  it("sanitize / canonical", () => {
    expect(tryIt(() => CustomTracks.sanitize(d.input))).toEqual(d.sanitized);
    if (d.canonical !== undefined) expect(CustomTracks.canonical(CustomTracks.sanitize(d.input)!)).toBe(d.canonical);
  });
  if (!d.sanitized) return;
  const it0 = () => CustomTracks.sanitize(d.input)!;

  it("share code bytes, encode / decode", async () => {
    expect(tryIt(() => Codec.encodeBytes(it0() as Codec.CodecDesign, true))).toEqual(d.encodeBytes);
    expect(tryIt(() => Codec.encodeBytes(it0() as Codec.CodecDesign, false))).toEqual(d.encodeBytesNoName);
    expect(await tryAsync(() => Codec.encode(it0()))).toEqual(d.code);
    expect(await tryAsync(() => Codec.encode(d.input))).toEqual(d.codeFromInput);
    if (typeof d.code === "string") expect(await tryAsync(() => Codec.decode(d.code))).toEqual(d.decoded);
  });

  it("share URL, hash and file envelope", () => {
    const code = typeof d.code === "string" ? d.code : null;
    if (code) {
      const url = Codec.shareUrl(code, "https://example.test/");
      expect(url).toBe(d.shareUrl);
      expect(Codec.fromHash("#" + url.split("#")[1])).toBe(d.fromHash);
    }
    const env = Codec.fileEnvelope(it0(), code) as unknown as Record<string, unknown>;
    const envPlain = plain(env) as Record<string, unknown>;
    delete envPlain.exportedAt;
    expect(envPlain).toEqual(d.fileEnvelope);
    expect(tryIt(() => Codec.fromFile(JSON.parse(JSON.stringify(env))))).toEqual(d.fromFile);
    expect(tryIt(() => Codec.fromFile({ format: Codec.FILE_FORMAT, v: 1, design: plain(it0()) }))).toEqual(d.fromFileDesignOnly);
  });

  it("toRaw, defFields for every theme, customDef", () => {
    expect(tryIt(() => CustomTracks.toRaw(it0()))).toEqual(d.raw);
    for (const id of Themes.ORDER) expect(tryIt(() => Themes.defFields(id, it0())), id).toEqual(d.defFields![id]);
    const def = CustomTracks.customDef(it0());
    // `points` is the lazy getter f1-game's plain() materialises on read: read it the same way.
    expect(plain(def)).toEqual(d.def);
  });

  if (!d.track || !d.track.arrays) return;
  const tr = d.track;
  it("built track: scalars, arrays, pit, bankP and the non-scenery mesh buffers", () => {
    const track = buildTrack(CustomTracks.customDef(it0()));
    expect(track.n).toBe(tr.scalars.n);
    expect(Object.is(track.total, tr.scalars.total)).toBe(true);
    const arr = track as unknown as Record<string, ArrayLike<number> | undefined>;
    for (const [k, v] of Object.entries(tr.arrays)) {
      if (k === "barL" || k === "barR") continue;   // TODO(lane-scenery): the PropsBuilder sets them
      const a = arr[k];
      expect(a && a.length, k).toBe(v.length);
      for (let i = 0; i < v.length; i++) if (!same(a![i], v[i])) expect.fail(`${k}[${i}] ${a![i]} vs ${v[i]}`);
    }
    if (tr.pit) {
      const pit = track.pit as unknown as Record<string, ArrayLike<number>>;
      for (const [k, v] of Object.entries(tr.pit.arrays)) expect(Array.from(pit[k]!).every((x, i) => same(x, v[i])), `pit.${k}`).toBe(true);
    }
    if (tr.bankP) {
      const bp = track.bankP as unknown as Record<string, ArrayLike<number>>;
      for (const [k, v] of Object.entries(tr.bankP)) expect(Array.from(bp[k]!).every((x, i) => same(x, v[i])), `bankP.${k}`).toBe(true);
    }
    expect(tr.meshes.length).toBe(MESH_ORDER.length);
    for (const k of MESH_ORDER) if (!SCENERY_MESHES.has(k)) expect(meshRow(track.geo![k]), k).toEqual(tr.meshes[MESH_ORDER.indexOf(k)]);
  }, 30_000);
});

describe("refusals", () => {
  it.each(G.badCodes.map((c) => [c.label, c] as const))("bad code %s", async (label, c) => {
    let got: unknown;
    if (label === "fromFile-wrong-format") got = tryIt(() => Codec.fromFile({ format: "nope", code: "x" }));
    else if (label === "fromFile-empty") got = tryIt(() => Codec.fromFile({ format: Codec.FILE_FORMAT }));
    else if (label === "fromFile-null") got = tryIt(() => Codec.fromFile(null));
    else if (label === "fromHash-bad-escape") got = tryIt(() => Codec.fromHash("#track=%E0%A4%A"));
    else if (label === "fromHash-mixed") got = tryIt(() => Codec.fromHash("#a=1&track=APXT1.p.AAAA&b=2"));
    else if (label === "withoutTrack") got = tryIt(() => Codec.withoutTrack("#a=1&track=APXT1.p.AAAA&b=2"));
    else if (label === "decodeBytes-null") got = tryIt(() => Codec.decodeBytes(null));
    else got = await tryAsync(() => Codec.decode(c.code));
    expect(got).toEqual(c.result);
  });

  it.each(G.badSanitize.map((c) => [c.label, c] as const))("bad sanitize %s", (_l, c) => {
    expect(tryIt(() => CustomTracks.sanitize(c.input, c.opts))).toEqual(c.result);
  });
});
