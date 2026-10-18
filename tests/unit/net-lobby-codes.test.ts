/**
 * net-lobby-codes.test.ts — pasted-code recovery (`codeFrom`).
 * Port of the codeFrom tests in f1-game tests/unit/lobby-codes.test.mjs
 * (:44-75 the codeFrom half of "delivering a real invite…", :101-133,
 * :160-221).
 *
 * f1-game ran lobby-codes.js in a VM with a stub inviteFromUrl that copied the
 * real one (:20-23); here codeFrom uses the real handshake.ts inviteFromUrl.
 *
 * Not ported (apex-26 has no counterpart yet): resolveCode and deliver (the
 * decode-validated short-tail choice, :44-99 apart from the codeFrom checks),
 * paintQr (:135-146), canShare (:148-151), the manifest load order (:153-158)
 * and the share/copy hand-off (:223-245).
 */
import { expect, test } from "vitest";
import { encodeCode, type CodePayload } from "../../src/net/handshake";
import { codeFrom } from "../../src/net/lobby";

test("a real invite wrapped before a short final fragment re-joins with keepShortTail", async () => {
  // lobby-codes.test.mjs:44-75: deliver() and resolveCode() call codeFrom(text, true)
  // for the tail candidate and codeFrom(text) for the conservative one.
  const payload: CodePayload = { k: "offer", b: 1, s: "v=0\r\na=ice-ufrag:abcd\r\n", p: null };
  const code = await encodeCode(payload);
  expect(code.startsWith("APEX1.")).toBe(true);
  for (const tail of [1, 2, 9, 19]) {
    const wrapped = code.slice(0, -tail) + "\n" + code.slice(-tail);
    expect(code.slice(-tail).length).toBe(tail);
    expect(codeFrom(wrapped, true), `${tail}-character tail`).toBe(code);
  }
  const [, mode, body] = code.split(".");
  for (const text of [code + " thanks", code + "\nthanks", "APEX1." + mode + ".\n" + body + " now", code + "\nSent from my phone"]) {
    expect(codeFrom(text), "valid complete codes keep prose outside").toBe(code);
  }
  const tail = code.slice(0, -2) + "\r\n" + code.slice(-2);
  for (const text of [tail, "https://x.test/#vs=" + tail, "(" + tail + ").", tail + " thanks"]) {
    expect(codeFrom(text, true), "short tails survive links, punctuation and prose").toBe(code);
  }
});

test("codeFrom trims and unwraps invite URLs", () => {
  expect(codeFrom("")).toBe("");
  expect(codeFrom("  APEX1.z.abc  ")).toBe("APEX1.z.abc");
  expect(codeFrom("https://x.test/play#vs=INVITE")).toBe("INVITE");
});

test("codeFrom lifts a code out of a message and re-joins one a mail client hard-wrapped", () => {
  const body = "Q".repeat(100) + "_-" + "z".repeat(42) + "xy_7";
  const code = "APEX1.s." + body;
  expect(codeFrom("here you go: " + code + " thanks!"), "prose on both sides").toBe(code);
  expect(codeFrom(code + "\nSent from my iPhone"), "a signature after the code").toBe(code);
  expect(codeFrom(code + " thanks"), "one short word after an unwrapped code is not a fragment").toBe(code);
  // A 76-column hard wrap: long fragments, then a short tail as the LAST token.
  const wrapped = code.slice(0, 76) + "\n" + code.slice(76, 152) + "\n" + code.slice(152);
  expect(code.slice(152).length).toBeLessThan(20);
  expect(code.slice(152).length).toBeGreaterThan(0);
  expect(codeFrom(wrapped), "re-joined").toBe(code);
  expect(codeFrom("code:\n" + wrapped), "wrapped, with a word before it").toBe(code);
  // Text with no code at all is handed on as-is for peekCode's verdict.
  expect(codeFrom("not a code at all")).toBe("not a code at all");
  expect(codeFrom("nocode")).toBe("nocode");
  // A link inside a message still wins as a link.
  expect(codeFrom("join me https://x.test/play#vs=" + code + " now")).toBe(code);
});

test("codeFrom lifts a code out of a LINK inside a sentence, wrapped or followed by punctuation", () => {
  const code = "APEX1.s." + "Q".repeat(60);
  expect(codeFrom("Race me: https://x.test/#vs=" + code + ".")).toBe(code);
  expect(codeFrom("(https://x.test/#vs=" + code + ")")).toBe(code);
  // A folded link re-joins like a bare code.
  const head = code.slice(0, 40);
  const tail = code.slice(40);
  expect(codeFrom("https://x.test/#vs=" + head + "\n" + tail + "\nSent from my phone")).toBe(code);
  // Zero-width characters are not whitespace to \s.
  expect(codeFrom(code.slice(0, 20) + "​" + code.slice(20) + "­")).toBe(code);
  expect(codeFrom("https://x.test/#vs=" + code.slice(0, 20) + "⁠" + code.slice(20))).toBe(code);
});

test("codeFrom lifts a BARE code out of brackets, quotes and a sentence's end", () => {
  const code = "APEX1.s." + "Q".repeat(100) + "_-" + "z".repeat(42) + "xy_7";
  expect(codeFrom("(" + code + ").")).toBe(code);
  expect(codeFrom('Here: "' + code + '", thanks')).toBe(code);
  expect(codeFrom("[" + code + "]")).toBe(code);
  expect(codeFrom(code + ".")).toBe(code);
  // Punctuation ends the code: a long word after it is not a fragment.
  expect(codeFrom(code + ". " + "w".repeat(30))).toBe(code);
  // A bracketed, hard-wrapped code keeps its short tail without the bracket.
  const wrapped = code.slice(0, 76) + "\n" + code.slice(76, 152) + "\n" + code.slice(152);
  expect(codeFrom("(" + wrapped + ").")).toBe(code);
  // …an unbracketed one does not glue on a punctuated last word.
  expect(codeFrom(code.slice(0, 76) + "\n" + code.slice(76, 152) + "\nok!")).toBe(code.slice(0, 152));
});

test("codeFrom re-joins a fold after the mode separator and a short mid soft-wrap", () => {
  const body = "Q".repeat(60) + "_-" + "z".repeat(58);
  const code = "APEX1.s." + body;
  expect(codeFrom("APEX1.s.\n" + body)).toBe(code);
  expect(codeFrom("here: APEX1.s.\n" + body + "\nthanks")).toBe(code);
  expect(codeFrom("https://x.test/#vs=APEX1.s.\n" + body)).toBe(code);
  expect(codeFrom("Race me https://brycejmurrin.github.io/f1-game/#vs=APEX1.s.\n" + body + " now")).toBe(code);
  const folded = code.slice(0, 76) + "\n" + code.slice(76, 88) + "\n" + code.slice(88);
  expect(code.slice(76, 88).length).toBeLessThan(20);
  expect(codeFrom(folded)).toBe(code);
  const urlFold = "https://x.test/#vs=" + code.slice(0, 12) + "\n" + code.slice(12, 27) + "\n" + code.slice(27);
  expect(codeFrom(urlFold)).toBe(code);
  // Still refuse to glue English after a complete code.
  expect(codeFrom(code + " thanks")).toBe(code);
  expect(codeFrom(code + "\nSent from my iPhone")).toBe(code);
});

test("a MAGIC.mode with nothing after it is handed back without the restored dot", () => {
  // lobby-codes.js:93-95: so peekCode says bad_code, not an empty-body corrupt.
  expect(codeFrom("APEX1.s.")).toBe("APEX1.s");
  expect(codeFrom("APEX1.s.\nthanks!")).toBe("APEX1.s");
});
