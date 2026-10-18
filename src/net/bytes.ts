/**
 * Byte <-> text codecs every net module needs, in one place.
 * Port of f1-game js/net/bytes.js:1-58 (NetBytes).
 */

// Chunked so a large buffer never hits the argument-count ceiling of
// Function.prototype.apply (bytes.js:5-14).
function binary(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x4000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x4000)));
  }
  return s;
}

function fromBinary(bin: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type ByteSource = Uint8Array | ArrayBuffer | ArrayLike<number>;

const view = (bytes: ByteSource): Uint8Array =>
  bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : Uint8Array.from(bytes);

/** Standard alphabet, padded: a Nostr `content` and a TURN credential (bytes.js:23-26). */
export const bytesToB64 = (bytes: ByteSource): string => btoa(binary(view(bytes)));
export const b64ToBytes = (text: string | null | undefined): Uint8Array<ArrayBuffer> => fromBinary(atob(String(text || "")));

/** URL-safe, unpadded: an invite code and a worker envelope (bytes.js:28-34). */
export const bytesToB64url = (bytes: ByteSource): string =>
  bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function b64urlToBytes(text: string | null | undefined): Uint8Array<ArrayBuffer> {
  const s = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  return fromBinary(atob(s + "=".repeat((4 - (s.length % 4)) % 4)));
}

/** Hex with any separator stripped; null on an odd digit count (bytes.js:36-44). */
export function hexToBytes(hex: string | null | undefined): Uint8Array<ArrayBuffer> | null {
  const clean = String(hex || "").replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export const bytesToHex = (bytes: ByteSource, sep?: string): string =>
  Array.from(view(bytes), (v) => v.toString(16).toUpperCase().padStart(2, "0")).join(sep || "");

/** ASCII slice: ufrag/pwd are ice-char by spec, so charCode IS the byte (bytes.js:48-54). */
export function ascii(bytes: ArrayLike<number>, off?: number, len?: number): string {
  let s = "";
  const o = off || 0;
  const n = len != null ? len : bytes.length - o;
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[o + i] ?? 0);
  return s;
}
