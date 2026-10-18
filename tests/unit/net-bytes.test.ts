/* net-bytes.test.ts — the byte<->text codecs every net module shares.
 *
 * f1-game has no dedicated bytes suite; its only direct NetBytes assertions
 * live in tests/unit/net-sdp.test.mjs:27-42 ("NetBytes round-trips base64,
 * base64url, hex and ascii"), ported verbatim as the first test below. The
 * rest is a short apex-26 suite over src/net/bytes.ts (port of
 * f1-game js/net/bytes.js:1-58).
 */
import { expect, test } from "vitest";
import {
  ascii,
  b64ToBytes,
  b64urlToBytes,
  bytesToB64,
  bytesToB64url,
  bytesToHex,
  hexToBytes,
} from "../../src/net/bytes";

const ALL = Uint8Array.from({ length: 256 }, (_, i) => i);

// f1-game tests/unit/net-sdp.test.mjs:27-42.
test("NetBytes round-trips base64, base64url, hex and ascii", () => {
  const bytes = new Uint8Array(70000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff; // past the apply() chunk size
  expect([...b64ToBytes(bytesToB64(bytes))]).toStrictEqual([...bytes]);
  const url = bytesToB64url(bytes);
  expect(url, "url-safe and unpadded").not.toMatch(/[+/=]/);
  expect([...b64urlToBytes(url)]).toStrictEqual([...bytes]);
  expect(bytesToB64(new Uint8Array([0xfb, 0xff]))).toBe("+/8=");
  expect(bytesToB64url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  expect(bytesToHex(new Uint8Array([0xab, 1]), ":")).toBe("AB:01");
  expect([...(hexToBytes("ab:01") ?? [])]).toStrictEqual([0xab, 1]);
  expect(hexToBytes("abc"), "an odd digit count is refused, not truncated").toBe(null);
  expect(ascii(new Uint8Array([65, 66, 67, 68]), 1, 2)).toBe("BC");
  expect(ascii(new Uint8Array([65, 66]))).toBe("AB");
  expect([...b64urlToBytes("")], "empty in, empty out").toStrictEqual([]);
});

test("b64 round-trips every byte value", () => {
  expect(b64ToBytes(bytesToB64(ALL))).toStrictEqual(ALL);
});

test("b64url round-trips every byte value, with no + / or = in the text", () => {
  const url = bytesToB64url(ALL);
  expect(url).not.toMatch(/[+/=]/);
  expect(b64urlToBytes(url)).toStrictEqual(ALL);
  // Every padding length (0, 1, 2 bytes past a multiple of 3).
  for (let n = 0; n < 6; n++) {
    const slice = ALL.slice(250 - n);
    const u = bytesToB64url(slice);
    expect(u).not.toMatch(/[+/=]/);
    expect(b64urlToBytes(u)).toStrictEqual(slice);
  }
});

test("a 100 KB buffer round-trips through both alphabets", () => {
  const big = new Uint8Array(100 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 131 + (i >> 8)) & 0xff;
  expect(b64ToBytes(bytesToB64(big))).toStrictEqual(big);
  const url = bytesToB64url(big);
  expect(url).not.toMatch(/[+/=]/);
  expect(b64urlToBytes(url)).toStrictEqual(big);
});

test("an ArrayBuffer and a plain array encode like the Uint8Array they hold", () => {
  const u8 = new Uint8Array([1, 2, 250, 251, 255]);
  expect(bytesToB64(u8.buffer)).toBe(bytesToB64(u8));
  expect(bytesToHex([1, 2, 250])).toBe("0102FA");
});

test("hexToBytes strips separators and refuses an odd digit count", () => {
  expect(hexToBytes("AB:cd:01")).toStrictEqual(new Uint8Array([0xab, 0xcd, 0x01]));
  expect(hexToBytes("ab cd-01")).toStrictEqual(new Uint8Array([0xab, 0xcd, 0x01]));
  // Every non-hex character is stripped, letters included: "sha-256 ab" -> "a256ab".
  expect(hexToBytes("sha-256 ab")).toStrictEqual(new Uint8Array([0xa2, 0x56, 0xab]));
  expect(hexToBytes("a:bc")).toBe(null);
  expect(hexToBytes("")).toStrictEqual(new Uint8Array(0));
  expect(hexToBytes(null)).toStrictEqual(new Uint8Array(0));
  expect(hexToBytes(bytesToHex(ALL, ":"))).toStrictEqual(ALL);
});

test("bytesToHex is upper-case, zero-padded, with an optional separator", () => {
  expect(bytesToHex(new Uint8Array([0, 0x0f, 0xa0, 0xff]))).toBe("000FA0FF");
  expect(bytesToHex(new Uint8Array([0, 0x0f, 0xa0, 0xff]), ":")).toBe("00:0F:A0:FF");
  expect(bytesToHex(new Uint8Array(0), ":")).toBe("");
});

test("ascii slices by offset and length, defaulting to the rest", () => {
  const b = new Uint8Array([0x61, 0x62, 0x63, 0x64, 0x65]); // "abcde"
  expect(ascii(b)).toBe("abcde");
  expect(ascii(b, 2)).toBe("cde");
  expect(ascii(b, 1, 3)).toBe("bcd");
  expect(ascii(b, 0, 0)).toBe("");
});
