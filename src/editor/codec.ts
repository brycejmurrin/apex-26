/**
 * TrackCodec: the share code for a custom circuit. Ported verbatim from f1-game
 * js/editor/codec.js (TrackCodec, :1-368); every member of the IIFE's return
 * object (codec.js:366) is a named export here.
 *
 * `APXT1.p.<base64url>` is a compact binary record (theme, width, seed, the
 * control loop as second-order deltas on the 0.25 m lattice, the zone lists and
 * the name, with a 16-bit FNV check) and `APXT1.z.…` the same bytes through
 * deflate-raw (CompressionStream) when that is shorter. `APXT2.…` is the same
 * layout plus an authored props trailer (TrackDesignerProps) when the design
 * places any. The code rides a URL fragment (`#track=`) and the JSON file
 * envelope. Decoding is DEFENSIVE: every field is bounded, nothing public
 * throws (a refusal is { ok: false, reason } or null), and the design that
 * comes out is re-sanitised by CustomTracks. Byte-identical with f1-game.
 *
 * Differences from f1-game, none of which change a byte:
 * - `Log.warn` (codec.js:307) is dropped.
 * - The `typeof TrackDesignerProps` guards (codec.js:135, :235) are gone: ./props
 *   is a static import, so the module is always present.
 * - `Native.isNative()` (codec.js:338) is dropped: apex-26 has no native shell
 *   yet; a native build passes `base`. TODO(lane-shell).
 */
import type { CustomDesign } from "./custom-tracks";
import { sanitize } from "./custom-tracks";
import * as TrackDesignerProps from "./props";
import * as TrackThemes from "./track-themes";

/** codec.js:17 */
export const MAGIC = "APXT1", VERSION = 1, VERSION_PROPS = 2;
/** codec.js:18 */
export const MAX_CODE = 4096, MAX_BYTES = 16384;
const MAX_N = 200, MIN_N = 8, UNIT = 4 /* per metre */, COORD_MAX = 10000 * UNIT;
// look (32), country (64), heights (128): written only when set / off default,
// so every older code keeps its bytes. Props ride VERSION_PROPS (FLAG is full).
// Surface (kerb style + berms) is a trailing u8 written only when off default.
/** codec.js:31 */
export const FLAG = { hwZones: 1, bankZones: 2, elevations: 4, bridges: 8, name: 16, look: 32, country: 64, heights: 128 } as const;
const FLAG_ALL = 0xff;
/** codec.js:33 */
export const KERB_STYLES = ["flat", "sausage", "rumble"] as const;

/** The design fields the codec reads (a sanitised CustomTracks record satisfies it). */
export type CodecDesign = Pick<CustomDesign, "theme" | "baseHW" | "seed" | "pts" | "hwZones" | "bankZones" | "elevations" | "bridges">
  & Partial<Pick<CustomDesign, "name" | "country" | "look" | "heights" | "props" | "kerbStyle">>
  & { berms?: boolean };

/** Pack kerbStyle + berms into one byte; 0 = defaults (flat, berms on). codec.js:35 */
export function surfaceByte(it: { kerbStyle?: string; berms?: boolean } | null | undefined): number {
  let k = (KERB_STYLES as readonly (string | null | undefined)[]).indexOf(it && it.kerbStyle);
  if (k < 0) k = 0;
  const noBerm = it && it.berms === false ? 4 : 0;
  return (k & 3) | noBerm;
}
function applySurfaceByte(design: DecodedDesign, b: number): boolean {
  if (!Number.isFinite(b) || (b & ~7) || (b & 3) > 2) return false;
  const k = b & 3;
  if (k) design.kerbStyle = KERB_STYLES[k]!;
  if (b & 4) design.berms = false;
  return true;
}
// = CustomTracks.LIMITS.zones for every list: a lower cap here silently dropped
// what storage keeps. 24 of each is ~600 bytes, well inside MAX_CODE.
/** codec.js:51 */
export const ZONE_CAPS = { hwZones: 24, bankZones: 24, elevations: 24, bridges: 24 } as const;
type ZoneKey = keyof typeof ZONE_CAPS;
// A hwZone with no `ease` (older stores) rides as this byte, so the receiver
// rebuilds the SAME record (and id). Stored ease tops out at 0.2 → 200.
const NO_EASE = 255;

/** What decodeBytes hands CustomTracks.sanitize: a plain, unsanitised design. */
export interface DecodedDesign {
  theme: string; baseHW: number; seed: number; pts: [number, number][];
  hwZones?: { s0: number; s1: number; hw: number; ease?: number }[];
  bankZones?: { frac: number; angleDeg: number; widthM: number }[];
  elevations?: { s: number; halfM: number; rise: number }[];
  bridges?: { s: number; halfM: number; rise: number }[];
  name?: string;
  look?: { time: string; trees: string; crowd: string };
  country?: string;
  heights?: number[];
  props?: { kind: string; s: number; side: number; gap: number }[];
  kerbStyle?: (typeof KERB_STYLES)[number];
  berms?: false;
}

export type Refusal = { ok: false; reason: string };

// ── byte writer / reader ────────────────────────────────────────────────
interface Writer {
  u8(v: number): Writer; u16(v: number): Writer; varint(v: number): Writer; zz(v: number): Writer;
  bytes(arr: Iterable<number>): Writer; out(): Uint8Array;
}
function writer(): Writer {
  const buf: number[] = [];
  const w: Writer = {
    u8: (v) => { buf.push(v & 0xff); return w; },
    u16: (v) => { buf.push(v & 0xff, (v >>> 8) & 0xff); return w; },
    varint: (v) => { v = Math.max(0, Math.floor(v)); do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; buf.push(b); } while (v); return w; },
    zz: (v) => w.varint(v >= 0 ? v * 2 : -v * 2 - 1),
    bytes: (arr) => { for (const b of arr) buf.push(b & 0xff); return w; },
    out: () => Uint8Array.from(buf),
  };
  return w;
}
interface Reader {
  readonly pos: number; readonly left: number;
  u8(): number; u16(): number; varint(): number; zz(): number; bytes(n: number): Uint8Array;
}
function reader(bytes: Uint8Array): Reader {
  let i = 0;
  const fail = (): never => { throw new RangeError("corrupt"); };
  const r: Reader = {
    get pos() { return i; }, get left() { return bytes.length - i; },
    u8: () => (i < bytes.length ? bytes[i++]! : fail()),
    u16: () => { const a = r.u8(), b = r.u8(); return a | (b << 8); },
    varint: () => { let v = 0, m = 1, k = 0; for (;;) { const b = r.u8(); v += (b & 0x7f) * m; if (!(b & 0x80)) return v; m *= 128; if (++k > 7) fail(); } },
    zz: () => { const u = r.varint(); return u % 2 ? -(u + 1) / 2 : u / 2; },
    bytes: (n) => { if (i + n > bytes.length) fail(); const s = bytes.subarray(i, i + n); i += n; return s; },
  };
  return r;
}
/** codec.js:83 */
export function fnv16(bytes: ArrayLike<number>, end: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < end; i++) { h ^= bytes[i]!; h = Math.imul(h, 0x01000193); }
  return (h >>> 0) & 0xffff;
}
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** codec.js:89 */
export function b64url(bytes: ArrayLike<number>): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = i + 1 < bytes.length ? bytes[i + 1]! : 0, c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    s += B64[a >> 2]! + B64[((a & 3) << 4) | (b >> 4)]!;
    if (i + 1 < bytes.length) s += B64[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) s += B64[c & 63];
  }
  return s;
}
/** codec.js:99 */
export function unb64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const out: number[] = [];
  let bits = 0, acc = 0;
  for (const ch of s) { acc = (acc << 6) | B64.indexOf(ch); bits += 6; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } }
  return Uint8Array.from(out);
}
// Lap fractions on the storage lattice (k / 65535). 1.0 rides as 65535 (not
// wrapped to 0) and 65535 decodes a quarter-step below 1, which the sanitiser
// rounds back to the sender's value: the round trip is exact either way.
const u16frac = (f: number): number => { if (!Number.isFinite(f)) return 0; if (f < 0 || f > 1) f = ((f % 1) + 1) % 1; return Math.min(65535, Math.round(f * 65535)); };
const fracU16 = (v: number): number => (v === 65535 ? (65535 - 0.25) / 65535 : v / 65535);

const THEME_ORDER = (): readonly string[] => TrackThemes.ORDER as readonly string[];
const LOOK = (): { time: readonly string[]; trees: readonly string[]; crowd: readonly string[] } => TrackThemes.LOOK;
const KINDS = (): readonly string[] => TrackDesignerProps.KINDS as readonly string[];

// ── encode ──────────────────────────────────────────────────────────────
/**
 * The raw bytes for a (sanitised) design; name omitted when withName is false
 * (the content id's canon). Throws RangeError("zones") for a list over
 * ZONE_CAPS: encode() turns that into a refusal. codec.js:118
 */
export function encodeBytes(it: CodecDesign, withName = true): Uint8Array {
  for (const k of Object.keys(ZONE_CAPS) as ZoneKey[]) if (Array.isArray(it[k]) && it[k].length > ZONE_CAPS[k]) throw new RangeError("zones");
  const w = writer();
  const themeIdx = Math.max(0, THEME_ORDER().indexOf(it.theme));
  const zones = { hwZones: it.hwZones || [], bankZones: it.bankZones || [], elevations: it.elevations || [], bridges: it.bridges || [] };
  let flags = 0;
  for (const k of Object.keys(ZONE_CAPS) as ZoneKey[]) if (zones[k].length) flags |= FLAG[k];
  const name = withName && it.name ? new TextEncoder().encode(String(it.name).slice(0, 48)) : null;
  if (name && name.length) flags |= FLAG.name;
  const country = withName && it.country ? new TextEncoder().encode(String(it.country).slice(0, 32)) : null;
  if (country && country.length) flags |= FLAG.country;
  const look = TrackThemes.sanitizeLook(it.look);
  if (look) flags |= FLAG.look;
  const hs = Array.isArray(it.heights) ? it.heights : null;
  let hasH = false;
  if (hs && hs.length === it.pts.length) for (let i = 0; i < hs.length; i++) if (hs[i]) { hasH = true; break; }
  if (hasH) flags |= FLAG.heights;
  const props = TrackDesignerProps.sanitize(it.props);
  const ver = props && props.length ? VERSION_PROPS : VERSION;
  w.u8(ver).u8(flags).u8(themeIdx).u8(Math.round(it.baseHW * 10)).varint(it.seed >>> 0).varint(it.pts.length);
  const q = (v: number) => Math.round(v * UNIT);
  let px = q(it.pts[0]![0]), pz = q(it.pts[0]![1]);
  w.zz(px).zz(pz);
  let dx = 0, dz = 0;
  for (let i = 1; i < it.pts.length; i++) {
    const x = q(it.pts[i]![0]), z = q(it.pts[i]![1]);
    const ndx = x - px, ndz = z - pz;
    if (i === 1) w.zz(ndx).zz(ndz); else w.zz(ndx - dx).zz(ndz - dz);
    dx = ndx; dz = ndz; px = x; pz = z;
  }
  if (flags & FLAG.hwZones) { w.varint(zones.hwZones.length); for (const z of zones.hwZones) w.u16(u16frac(z.s0)).u16(u16frac(z.s1)).u8(Math.round(z.hw * 10)).u8(Number.isFinite(z.ease) ? Math.min(200, Math.max(0, Math.round(z.ease * 1000))) : NO_EASE); }
  if (flags & FLAG.bankZones) { w.varint(zones.bankZones.length); for (const z of zones.bankZones) w.u16(u16frac(z.frac)).zz(Math.round(z.angleDeg * 4)).u16(Math.round(z.widthM)); }
  for (const k of ["elevations", "bridges"] as const) if (flags & FLAG[k]) { w.varint(zones[k].length); for (const z of zones[k]) w.u16(u16frac(z.s)).u16(Math.round(z.halfM)).zz(Math.round(z.rise * 4)); }
  if (flags & FLAG.name) { w.u8(name!.length).bytes(name!); }
  if (flags & FLAG.look) { const L = LOOK(); w.u8(L.time.indexOf(look!.time) | (L.trees.indexOf(look!.trees) << 2) | (L.crowd.indexOf(look!.crowd) << 4)); }
  if (flags & FLAG.country) { w.u8(country!.length).bytes(country!); }
  // Heights after the label fields: a heights bit forces refusal on builds that lack it.
  if (flags & FLAG.heights) {
    let py = q(hs![0] || 0), dy = 0;
    w.zz(py);
    for (let i = 1; i < hs!.length; i++) {
      const y = q(hs![i] || 0), ndy = y - py;
      if (i === 1) w.zz(ndy); else w.zz(ndy - dy);
      dy = ndy; py = y;
    }
  }
  // APXT2 trailer: authored props (FLAG is full — no spare bit on v1).
  if (ver === VERSION_PROPS) {
    const kinds = KINDS();
    w.varint(props!.length);
    for (const p of props!) {
      w.u8(kinds.indexOf(p.kind));
      w.u16(u16frac(p.s));
      w.u8(p.side < 0 ? 0 : 1);
      w.u8(Math.min(255, Math.max(0, p.gap | 0)));
    }
  }
  // Ultimate trailing surface byte (kerb / berms), only when off default.
  const surf = surfaceByte(it);
  if (surf) w.u8(surf);
  const body = w.out();
  const all = new Uint8Array(body.length + 2);
  all.set(body); const c = fnv16(body, body.length); all[body.length] = c & 0xff; all[body.length + 1] = c >> 8;
  return all;
}

/** Bytes → design (plain object for CustomTracks.sanitize) or { ok: false, reason }. Never throws. codec.js:187 */
export function decodeBytes(bytes: Uint8Array | null | undefined): { ok: true; design: DecodedDesign } | Refusal {
  try {
    if (!bytes || bytes.length < 12 || bytes.length > MAX_BYTES) return { ok: false, reason: "bounds" };
    const bodyLen = bytes.length - 2;
    if (fnv16(bytes, bodyLen) !== (bytes[bodyLen]! | (bytes[bodyLen + 1]! << 8))) return { ok: false, reason: "check" };
    const r = reader(bytes.subarray(0, bodyLen));
    const ver = r.u8(); if (ver !== VERSION && ver !== VERSION_PROPS) return { ok: false, reason: "version" };
    const flags = r.u8(); if (flags & ~FLAG_ALL) return { ok: false, reason: "corrupt" };
    const themeIdx = r.u8(); if (themeIdx >= THEME_ORDER().length) return { ok: false, reason: "theme" };
    const baseHW = r.u8() / 10; if (baseHW < 5 || baseHW > 8) return { ok: false, reason: "bounds" };
    const seed = r.varint(); if (seed > 0xffffffff) return { ok: false, reason: "bounds" };
    const N = r.varint(); if (N < MIN_N || N > MAX_N) return { ok: false, reason: "bounds" };
    const pts: [number, number][] = [];
    let x = r.zz(), z = r.zz(), dx = 0, dz = 0;
    const push = () => { if (Math.abs(x) > COORD_MAX || Math.abs(z) > COORD_MAX) throw new RangeError("bounds"); pts.push([x / UNIT, z / UNIT]); };
    push();
    for (let i = 1; i < N; i++) {
      if (i === 1) { dx = r.zz(); dz = r.zz(); } else { dx += r.zz(); dz += r.zz(); }
      x += dx; z += dz; push();
    }
    const design: DecodedDesign = { theme: THEME_ORDER()[themeIdx]!, baseHW, seed, pts };
    if (flags & FLAG.hwZones) {
      const n = r.varint(); if (n > ZONE_CAPS.hwZones) return { ok: false, reason: "bounds" };
      design.hwZones = [];
      for (let i = 0; i < n; i++) { const z: { s0: number; s1: number; hw: number; ease?: number } = { s0: fracU16(r.u16()), s1: fracU16(r.u16()), hw: r.u8() / 10 }, e = r.u8(); if (e !== NO_EASE) z.ease = e / 1000; design.hwZones.push(z); }
    }
    if (flags & FLAG.bankZones) { const n = r.varint(); if (n > ZONE_CAPS.bankZones) return { ok: false, reason: "bounds" }; design.bankZones = []; for (let i = 0; i < n; i++) design.bankZones.push({ frac: fracU16(r.u16()), angleDeg: r.zz() / 4, widthM: r.u16() }); }
    for (const k of ["elevations", "bridges"] as const) if (flags & FLAG[k]) { const n = r.varint(); if (n > ZONE_CAPS[k]) return { ok: false, reason: "bounds" }; const list: { s: number; halfM: number; rise: number }[] = design[k] = []; for (let i = 0; i < n; i++) list.push({ s: fracU16(r.u16()), halfM: r.u16(), rise: r.zz() / 4 }); }
    if (flags & FLAG.name) { const n = r.u8(); if (n > 48) return { ok: false, reason: "bounds" }; design.name = new TextDecoder().decode(r.bytes(n)); }
    if (flags & FLAG.look) {
      const b = r.u8(), L = LOOK(), t = b & 3, tr = (b >> 2) & 3, c = (b >> 4) & 3;
      if (b >> 6 || t >= L.time.length || tr >= L.trees.length || c >= L.crowd.length) return { ok: false, reason: "bounds" };
      design.look = { time: L.time[t]!, trees: L.trees[tr]!, crowd: L.crowd[c]! };
    }
    // 32 UTF-16 units can occupy up to 96 UTF-8 bytes.
    if (flags & FLAG.country) { const n = r.u8(); if (n > 96) return { ok: false, reason: "bounds" }; design.country = new TextDecoder().decode(r.bytes(n)); }
    if (flags & FLAG.heights) {
      const heights: number[] = [];
      let y = r.zz(), dy = 0;
      const pushH = () => { if (Math.abs(y) > COORD_MAX) throw new RangeError("bounds"); heights.push(y / UNIT); };
      pushH();
      for (let i = 1; i < N; i++) {
        if (i === 1) dy = r.zz(); else dy += r.zz();
        y += dy; pushH();
      }
      design.heights = heights;
    }
    if (ver === VERSION_PROPS) {
      const n = r.varint(), kinds = KINDS(), max = TrackDesignerProps.TOTAL || 16;
      if (n > max) return { ok: false, reason: "bounds" };
      const props: { kind: string; s: number; side: number; gap: number }[] = [];
      for (let i = 0; i < n; i++) {
        const ki = r.u8(); if (ki >= kinds.length) return { ok: false, reason: "bounds" };
        const s = fracU16(r.u16()), side = r.u8() ? 1 : -1, gap = r.u8();
        props.push({ kind: kinds[ki]!, s, side, gap });
      }
      design.props = props;
    }
    // Optional trailing surface byte (see surfaceByte). Zero leftovers = legacy.
    if (r.left === 1) {
      if (!applySurfaceByte(design, r.u8())) return { ok: false, reason: "bounds" };
    } else if (r.left !== 0) {
      return { ok: false, reason: "corrupt" };
    }
    return { ok: true, design };
  } catch (e) {
    return { ok: false, reason: e instanceof RangeError && e.message === "bounds" ? "bounds" : "corrupt" };
  }
}

// ── the code string ─────────────────────────────────────────────────────
async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const cs = new CompressionStream("deflate-raw");
    const wr = cs.writable.getWriter();
    // Settle the writer's own promises too: an unhandled rejection after the
    // caller moved on is a crash report nobody asked for.
    const fed = Promise.all([wr.write(bytes as Uint8Array<ArrayBuffer>), wr.close()]).catch(() => null);
    const out = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    await fed;
    return out;
  } catch (_) { return null; }
}
/**
 * deflate-raw bytes → { ok, bytes } | { ok: false, reason }. Read chunk by chunk
 * under a running MAX_BYTES cap and cancelled past it. codec.js:275
 */
export async function inflate(bytes: Uint8Array): Promise<{ ok: true; bytes: Uint8Array } | Refusal> {
  if (typeof DecompressionStream === "undefined") return { ok: false, reason: "unsupported" };
  let rd: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const ds = new DecompressionStream("deflate-raw");
    const wr = ds.writable.getWriter();
    const fed = Promise.all([wr.write(bytes as Uint8Array<ArrayBuffer>), wr.close()]).catch(() => null);
    rd = ds.readable.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { rd.cancel().catch(() => null); return { ok: false, reason: "bounds" }; }
      parts.push(value);
    }
    await fed;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
    return { ok: true, bytes: out };
  } catch (_) {
    if (rd) rd.cancel().catch(() => null);
    return { ok: false, reason: "corrupt" };
  }
}
/** design → "APXT1.p.…" / "APXT2.p.…" (or ".z.…" when deflate is shorter). codec.js:303 */
export async function encode(design: unknown): Promise<string | null> {
  const it = sanitize(design);
  if (!it) return null;
  let bytes: Uint8Array;
  try { bytes = encodeBytes(it, true); } catch (_) { return null; }
  const magic = "APXT" + bytes[0];
  const plain = magic + ".p." + b64url(bytes);
  const z = await deflate(bytes);
  if (z && z.length < bytes.length - 8) { const zc = magic + ".z." + b64url(z); if (zc.length < plain.length) return zc; }
  return plain;
}
/** "APXT1.…" / "APXT2.…" → { ok, design (sanitised), id } or { ok: false, reason }. Never throws. codec.js:315 */
export async function decode(code: unknown): Promise<{ ok: true; design: CustomDesign; id: string } | Refusal> {
  try {
    const s = String(code || "").trim();
    if (s.length > MAX_CODE) return { ok: false, reason: "bounds" };
    const m = /^APXT(\d+)\.([pz])\.([A-Za-z0-9_-]+)$/.exec(s);
    if (!m) return { ok: false, reason: "magic" };
    const outer = +m[1]!;
    if (outer !== VERSION && outer !== VERSION_PROPS) return { ok: false, reason: "version" };
    let bytes = unb64url(m[3]!);
    if (!bytes) return { ok: false, reason: "corrupt" };
    if (m[2] === "z") { const z = await inflate(bytes); if (!z.ok) return z; bytes = z.bytes; }
    if (bytes[0] !== outer) return { ok: false, reason: "version" };
    const d = decodeBytes(bytes);
    if (!d.ok) return d;
    const it = sanitize(d.design);
    if (!it) return { ok: false, reason: "geometry" };
    return { ok: true, design: it, id: it.id };
  } catch (_) { return { ok: false, reason: "corrupt" }; }
}

// ── URL + file envelopes ────────────────────────────────────────────────
const HASH_KEY = "track";
/** codec.js:337 */
export function shareUrl(code: string, base?: string | null): string {
  const b = base || (typeof location !== "undefined" ? location.origin + location.pathname : "");
  return b + "#" + HASH_KEY + "=" + code;
}
/** The code in a location hash, or null (also for a malformed %-escape). codec.js:344 */
export function fromHash(hash: unknown): string | null {
  const m = /(?:^#|&)track=([^&]+)/.exec(String(hash || ""));
  if (!m) return null;
  try { return decodeURIComponent(m[1]!); } catch (_) { return null; }
}
/** The hash with only #track= removed (other fragments kept). codec.js:350 */
export function withoutTrack(hash: unknown): string {
  const rest = String(hash || "").replace(/^#/, "").split("&").filter((p) => p && !p.startsWith(HASH_KEY + "="));
  return rest.length ? "#" + rest.join("&") : "";
}
/** codec.js:354 */
export const FILE_FORMAT = "apex26.track";
export interface FileEnvelope<D> {
  format: typeof FILE_FORMAT; v: 1; build: unknown; exportedAt: string; code: string | null; design: D;
}
/** codec.js:355 */
export function fileEnvelope<D>(design: D, code?: string | null): FileEnvelope<D> {
  // TODO(lane-shell): the build stamp; f1-game's shell sets window.__APEX_BUILD.
  const w = typeof window !== "undefined" ? (window as unknown as { __APEX_BUILD?: unknown }) : null;
  return { format: FILE_FORMAT, v: 1, build: (w && w.__APEX_BUILD) || null, exportedAt: new Date().toISOString(), code: code || null, design };
}
/** A parsed file → the code or the design it carries ({ code } | { design } | null). codec.js:359 */
export function fromFile(obj: unknown): { code: string } | { design: object } | null {
  if (!obj || typeof obj !== "object" || (obj as { format?: unknown }).format !== FILE_FORMAT) return null;
  const o = obj as { code?: unknown; design?: unknown };
  if (typeof o.code === "string") return { code: o.code };
  if (o.design && typeof o.design === "object") return { design: o.design };
  return null;
}
