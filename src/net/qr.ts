/**
 * An invite you point a camera at: a byte-mode, error-correction-level-L QR
 * encoder with no dependency, versions 1..20.
 * Port of f1-game js/net/qr.js:1-337 (NetQr).
 *
 * Two friends racing in the same room should not have to copy a ~240-char code
 * between phones, so the lobby draws it as a QR. An encoder like this is either
 * exactly right or silently useless (a wrong mask or format field still looks
 * like a QR), which is why tests/unit/net-qr.test.ts checks it with jsQR, an
 * independent decoder. The algorithm (Reed-Solomon over GF(256)/0x11D, block
 * interleave, the eight masks with the spec penalty, BCH format and version
 * bits) is kept verbatim.
 */

// Primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D), as the QR spec says.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
}
const gfMul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : (EXP[(LOG[a] as number) + (LOG[b] as number)] as number);

function rsGenerator(n: number): number[] {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      const p = poly[j] as number;
      next[j] = (next[j] as number) ^ p;
      next[j + 1] = (next[j + 1] as number) ^ gfMul(p, EXP[i] as number);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGenerator(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = (data[i] as number) ^ (rem[0] as number);
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) rem[j] = (rem[j] as number) ^ gfMul(gen[j + 1] as number, factor);
    }
  }
  return rem;
}

/** [ecLen per block, group-1 blocks, group-1 data codewords, group-2 blocks, group-2 data codewords]. */
type BlockSpec = readonly [number, number, number, number, number];

// Level L only, versions 1..20; index 0 is unused so the index is the version.
const L_BLOCKS: readonly (BlockSpec | null)[] = [
  null,
  [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
  [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
  [30, 2, 116, 0, 0], [18, 2, 68, 2, 69], [20, 4, 81, 0, 0], [24, 2, 92, 2, 93],
  [26, 4, 107, 0, 0], [30, 3, 115, 1, 116], [22, 5, 87, 1, 88], [24, 5, 98, 1, 99],
  [28, 1, 107, 5, 108], [30, 5, 120, 1, 121], [28, 3, 113, 4, 114], [28, 3, 107, 5, 108],
];
/** The largest version this encoder emits. */
export const MAX_VERSION = L_BLOCKS.length - 1;

// Alignment-pattern row/column centres per version (version 1 has none).
const ALIGN: readonly (readonly number[] | null)[] = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58],
  [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
  [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];

const blocksOf = (v: number): BlockSpec => {
  const spec = L_BLOCKS[v];
  if (!spec) throw new RangeError(`QR version ${v} is outside 1..${MAX_VERSION}`);
  return spec;
};

const dataCodewords = (v: number): number => {
  const [, b1, d1, b2, d2] = blocksOf(v);
  return b1 * d1 + b2 * d2;
};
// 4 mode bits + the character-count field, which widens at version 10.
const countBits = (v: number): number => (v < 10 ? 8 : 16);

/** How many bytes version `v` holds in byte mode at level L. */
export const byteCapacity = (v: number): number => Math.floor((dataCodewords(v) * 8 - 4 - countBits(v)) / 8);

/** The largest payload, in UTF-8 bytes, that encode() accepts. */
export const capacity = (): number => byteCapacity(MAX_VERSION);

function pickVersion(len: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) if (byteCapacity(v) >= len) return v;
  return 0;
}

function buildData(bytes: Uint8Array, version: number): Uint8Array {
  const bits: number[] = [];
  const push = (value: number, n: number): void => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);

  const total = dataCodewords(version) * 8;
  // Terminator: up to four zero bits, but never past the end.
  push(0, Math.min(4, total - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = new Uint8Array(dataCodewords(version));
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] as number);
    out[i / 8] = byte;
  }
  for (let i = bits.length / 8, alt = 0; i < out.length; i++, alt ^= 1) {
    out[i] = alt ? 0x11 : 0xec;
  }
  return out;
}

function interleave(data: Uint8Array, version: number): Uint8Array {
  const [ecLen, b1, d1, b2, d2] = blocksOf(version);
  const blocks: Uint8Array[] = [];
  let at = 0;
  for (let i = 0; i < b1; i++) { blocks.push(data.slice(at, at + d1)); at += d1; }
  for (let i = 0; i < b2; i++) { blocks.push(data.slice(at, at + d2)); at += d2; }
  const ec = blocks.map((b) => rsEncode(b, ecLen));

  const out: number[] = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i] as number);
  }
  for (let i = 0; i < ecLen; i++) for (const e of ec) out.push(e[i] as number);
  return Uint8Array.from(out);
}

interface Matrix {
  size: number;
  m: Uint8Array;
  reserved: Uint8Array;
}

function makeMatrix(version: number): Matrix {
  const size = version * 4 + 17;
  const m = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);
  const set = (x: number, y: number, v: number): void => { m[y * size + x] = v; reserved[y * size + x] = 1; };

  function finder(ox: number, oy: number): void {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = ox + dx, y = oy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        set(x, y, ring === 2 || ring > 3 ? 0 : 1); // the white separator is ring>3
      }
    }
  }
  finder(0, 0); finder(size - 7, 0); finder(0, size - 7);

  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    set(i, 6, v); set(6, i, v); // timing patterns
  }

  const align = ALIGN[version] ?? [];
  for (const cy of align) {
    for (const cx of align) {
      // Skipped where a finder already sits.
      if ((cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1 ? 1 : 0);
        }
      }
    }
  }

  set(8, size - 8, 1); // the always-dark module
  for (let i = 0; i < 9; i++) { if (i !== 6) set(i, 8, 0); if (i !== 6) set(8, i, 0); }
  for (let i = 0; i < 8; i++) { set(size - 1 - i, 8, 0); set(8, size - 1 - i, 0); }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      set(Math.floor(i / 3), size - 11 + (i % 3), 0);
      set(size - 11 + (i % 3), Math.floor(i / 3), 0);
    }
  }
  return { size, m, reserved };
}

function placeData(mat: Matrix, codewords: Uint8Array): void {
  const { size, m, reserved } = mat;
  let bit = 0;
  const nextBit = (): number => {
    const i = bit >> 3;
    const b = i < codewords.length ? ((codewords[i] as number) >> (7 - (bit & 7))) & 1 : 0;
    bit++;
    return b;
  };
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--; // the timing column is not data
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (let c = 0; c < 2; c++) {
        const x = right - c;
        if (reserved[y * size + x]) continue;
        m[y * size + x] = nextBit();
      }
    }
    upward = !upward;
  }
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x, _y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function penalty(m: Uint8Array, size: number): number {
  const at = (x: number, y: number): number => m[y * size + x] as number;
  let score = 0;

  for (let i = 0; i < size; i++) {
    let runRow = 1, runCol = 1;
    for (let j = 1; j < size; j++) {
      runRow = at(j, i) === at(j - 1, i) ? runRow + 1 : 1;
      if (runRow === 5) score += 3; else if (runRow > 5) score += 1;
      runCol = at(i, j) === at(i, j - 1) ? runCol + 1 : 1;
      if (runCol === 5) score += 3; else if (runCol > 5) score += 1;
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = at(x, y);
      if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
    }
  }
  // 1:1:3:1:1 with four light modules either side — the finder signature.
  const PAT = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const RPAT = PAT.slice().reverse();
  const runs = (get: (i: number) => number): void => {
    for (let i = 0; i + 11 <= size; i++) {
      let fwd = true, rev = true;
      for (let k = 0; k < 11; k++) {
        if (get(i + k) !== PAT[k]) fwd = false;
        if (get(i + k) !== RPAT[k]) rev = false;
      }
      if (fwd) score += 40;
      if (rev) score += 40;
    }
  };
  for (let i = 0; i < size; i++) {
    runs((j) => at(j, i));
    runs((j) => at(i, j));
  }
  let dark = 0;
  for (let i = 0; i < m.length; i++) dark += m[i] as number;
  score += Math.floor(Math.abs((dark * 100) / m.length - 50) / 5) * 10;
  return score;
}

// BCH(15,5) over the format bits, then XOR 0x5412 so an all-zero format is
// never all-zero on the code.
function formatBits(maskId: number): number {
  const data = (0b01 << 3) | maskId; // 01 = error correction L
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}
function versionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) if ((rem >> i) & 1) rem ^= 0x1f25 << (i - 12);
  return (version << 12) | rem;
}

function writeFormat(m: Uint8Array, size: number, maskId: number): void {
  const bits = formatBits(maskId);
  const b = (i: number): number => (bits >> i) & 1;
  const put = (x: number, y: number, v: number): void => { m[y * size + x] = v; };

  for (let i = 0; i <= 5; i++) put(8, i, b(i));
  put(8, 7, b(6));
  put(8, 8, b(7));
  put(7, 8, b(8));
  for (let i = 9; i <= 14; i++) put(14 - i, 8, b(i));

  for (let i = 0; i <= 7; i++) put(size - 1 - i, 8, b(i));
  for (let i = 8; i <= 14; i++) put(8, size - 15 + i, b(i));
}
function writeVersion(m: Uint8Array, size: number, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const a = Math.floor(i / 3), c = i % 3;
    m[(size - 11 + c) * size + a] = bit;
    m[a * size + size - 11 + c] = bit;
  }
}

/** An encoded symbol: `modules[y * size + x]` is 1 for dark. No quiet zone included. */
export interface QrCode {
  version: number;
  size: number;
  modules: Uint8Array;
  mask: number;
}

/**
 * Encode `text` (as UTF-8 bytes) or return null if it simply will not fit —
 * which the caller must handle by showing the code as text rather than by
 * drawing a wrong QR. null/undefined encode as the empty string.
 */
export function encode(text: string | null | undefined): QrCode | null {
  const bytes = new TextEncoder().encode(String(text == null ? "" : text));
  const version = pickVersion(bytes.length);
  if (!version) return null;

  const codewords = interleave(buildData(bytes, version), version);
  const base = makeMatrix(version);
  placeData(base, codewords);

  let best: { score: number; m: Uint8Array; id: number } | null = null;
  for (let id = 0; id < 8; id++) {
    const mask = MASKS[id] as (x: number, y: number) => boolean;
    const m = base.m.slice();
    for (let y = 0; y < base.size; y++) {
      for (let x = 0; x < base.size; x++) {
        if (base.reserved[y * base.size + x]) continue;
        if (mask(x, y)) m[y * base.size + x] = (m[y * base.size + x] as number) ^ 1;
      }
    }
    writeFormat(m, base.size, id);
    writeVersion(m, base.size, version);
    const score = penalty(m, base.size);
    if (!best || score < best.score) best = { score, m, id };
  }
  if (!best) return null; // unreachable: eight masks always run
  return { version, size: base.size, modules: best.m, mask: best.id };
}

/** Light modules around the symbol; scanners need it (see the quiet-zone test). */
export const QUIET = 4;

/** The slice of CanvasRenderingContext2D draw() paints with. */
export interface QrContext2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/** The slice of HTMLCanvasElement draw() needs; a real canvas satisfies it. */
export interface QrCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): QrContext2D | null;
}

export interface QrDrawOptions {
  /** Target edge in CSS pixels; the module scale is floored to an integer. Default 320. */
  px?: number;
  light?: string;
  dark?: string;
}

/**
 * Encode `text` and paint it, quiet zone included, onto `canvas` (resized to a
 * whole number of pixels per module). Returns the code, or null when the text
 * does not fit, the canvas is missing, or it has no 2D context.
 */
export function draw(canvas: QrCanvas | null | undefined, text: string | null | undefined, opts?: QrDrawOptions): QrCode | null {
  const o = opts || {};
  const qr = encode(text);
  if (!canvas || !qr) return null;
  const total = qr.size + QUIET * 2;
  const scale = Math.max(1, Math.floor((o.px || 320) / total));
  const px = total * scale;
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = o.light || "#ffffff";
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = o.dark || "#000000";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x]) {
        ctx.fillRect((x + QUIET) * scale, (y + QUIET) * scale, scale, scale);
      }
    }
  }
  return qr;
}
