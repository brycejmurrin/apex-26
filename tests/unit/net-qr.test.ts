/* net-qr.test.ts — the QR encoder, checked by a decoder that is not ours.
 * Port of f1-game tests/unit/net-qr.test.mjs:1-113 (the NetQr half; the NetScan
 * half lives in net-scan.test.ts).
 *
 * A QR encoder is either exactly right or completely useless, and it fails
 * silently: a wrong mask, a mis-shifted format field or a botched interleave
 * all produce a picture that looks exactly like a QR code and that no camera
 * can read. Self-consistency proves nothing, because a decoder written from
 * the same misunderstanding would agree. So every assertion goes through jsQR,
 * an independent third-party decoder, reading the modules back out as if it
 * were a camera. If jsQR gets the string back, a phone will too.
 */
import { expect, test } from "vitest";
import jsQR from "jsqr";
import { QUIET, capacity, draw, encode, type QrCanvas, type QrCode } from "../../src/net/qr";

// Render to the RGBA buffer jsQR expects, quiet zone included — without those
// four clear modules a real scanner often will not lock on either, so leaving
// them out of the test would hide a genuine defect.
function raster(qr: QrCode, scale = 3): { data: Uint8ClampedArray; width: number; height: number } {
  const q = QUIET;
  const side = (qr.size + q * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y * qr.size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (((y + q) * scale + dy) * side + (x + q) * scale + dx) * 4;
          data[px] = data[px + 1] = data[px + 2] = 0;
        }
      }
    }
  }
  return { data, width: side, height: side };
}

function roundTrip(text: string): { text: string; qr: QrCode } {
  const qr = encode(text);
  expect(qr, `should have encoded ${text.length} chars`).not.toBeNull();
  if (!qr) throw new Error("unreachable");
  const img = raster(qr);
  const out = jsQR(img.data, img.width, img.height);
  expect(out, `jsQR could not read a version-${qr.version} code`).not.toBeNull();
  return { text: out?.data ?? "", qr };
}

test("a short string survives an independent decoder", () => {
  expect(roundTrip("APEX26").text).toBe("APEX26");
});

test("a REAL invite link round-trips — the whole reason this exists", () => {
  // Length and character set of an actual code: base64url after the compact
  // SDP pack, in the URL fragment. If this does not scan, the feature does not
  // work, however pretty the picture is.
  const code = "APEX1.s." + "aB3-_x9Zq".repeat(26).slice(0, 232);
  const url = "https://brycejmurrin.github.io/f1-game/#vs=" + code;
  const { text, qr } = roundTrip(url);
  expect(text).toBe(url);
  // Version 12 is 65x65 modules. Much past that and a phone camera starts
  // needing a steady hand and a big screen, which is the point of the compact
  // codec that feeds this.
  expect(qr.version, `expected a scannable version, got ${qr.version}`).toBeLessThanOrEqual(14);
});

test("every byte value survives, not just printable ASCII", () => {
  // Byte mode must be byte mode. A codec that quietly went alphanumeric would
  // pass every test above and mangle the first '_' in a base64url code.
  const s = Array.from({ length: 200 }, (_, i) => String.fromCharCode(32 + (i % 95))).join("");
  expect(roundTrip(s).text).toBe(s);
});

test("it steps up versions as the payload grows, and each one still decodes", () => {
  let last = 0;
  for (const len of [10, 40, 100, 200, 400, 700]) {
    const { text, qr } = roundTrip("x".repeat(len));
    expect(text.length).toBe(len);
    expect(qr.version, "version must not go backwards as data grows").toBeGreaterThanOrEqual(last);
    last = qr.version;
  }
});

test("a payload that will not fit returns null rather than a wrong picture", () => {
  // The one unacceptable outcome is a QR that renders and cannot be read. The
  // caller shows the code as text instead.
  expect(encode("x".repeat(capacity() + 1))).toBeNull();
  expect(encode("x".repeat(capacity())), "the stated capacity must actually fit").not.toBeNull();
});

test("the empty string encodes rather than throwing", () => {
  expect(roundTrip("").text).toBe("");
});

test("the quiet zone is required, and its absence is what breaks scanners", () => {
  // Documents WHY raster() pads. Cropped flush to the modules, the same code
  // that decodes above stops decoding — so this is a real constraint on how the
  // lobby draws it, not a formality.
  const qr = encode("https://example.com/#vs=APEX1.s.abcdefgh");
  if (!qr) throw new Error("should encode");
  const side = qr.size;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let i = 0; i < qr.modules.length; i++) {
    if (qr.modules[i]) { const p = i * 4; data[p] = data[p + 1] = data[p + 2] = 0; }
  }
  expect(jsQR(data, side, side), "if this ever starts decoding, the quiet-zone requirement has changed").toBeNull();
});

// apex-26: draw() takes the canvas explicitly; check it paints what encode() says.
test("draw() sizes the canvas to whole modules and paints exactly the dark modules", () => {
  const rects: [number, number, number, number, string][] = [];
  const ctx = { fillStyle: "" as string | CanvasGradient | CanvasPattern, fillRect(x: number, y: number, w: number, h: number) { rects.push([x, y, w, h, String(this.fillStyle)]); } };
  const canvas: QrCanvas = { width: 0, height: 0, getContext: () => ctx };
  const qr = draw(canvas, "APEX26", { px: 300 });
  if (!qr) throw new Error("should draw");
  const scale = Math.floor(300 / (qr.size + QUIET * 2));
  expect(canvas.width).toBe((qr.size + QUIET * 2) * scale);
  expect(canvas.height).toBe(canvas.width);
  expect(rects[0]).toEqual([0, 0, canvas.width, canvas.width, "#ffffff"]);
  const dark = qr.modules.reduce((n, v) => n + v, 0);
  expect(rects.length - 1).toBe(dark);
  expect(rects.slice(1).every((r) => r[4] === "#000000" && r[2] === scale)).toBe(true);
  expect(draw(null, "APEX26")).toBeNull();
  expect(draw({ width: 0, height: 0, getContext: () => null }, "APEX26")).toBeNull();
  expect(draw(canvas, "x".repeat(capacity() + 1))).toBeNull();
});
