/**
 * The invite code's payload as BYTES instead of prose.
 * Port of f1-game js/net/sdp.js:1-341 (NetSdp).
 *
 * A gathered data-channel SDP is ~700 B of text and almost none of it is
 * information: we only ever negotiate one m-line, so every line is either a
 * template constant or one of five facts (fingerprint, ufrag, pwd, setup role,
 * candidates). Packing those is ~90 B, which is what makes the invite code
 * SCANNABLE. It never EDITS an SDP — it extracts and rebuilds — and
 * `packChecked()` hands the rebuild to a throwaway RTCPeerConnection before a
 * human sees it. TCP candidates are dropped on purpose. Candidates are capped
 * at MAX_CANDS and selected ROUND-ROBIN BY KIND, relay first.
 */
import { ascii, bytesToHex, hexToBytes } from "./bytes";
import { netLog } from "./log";
import type { PeerConnectionCtor } from "./transport";

export const VERSION = 1;

const C_MDNS = 0;
const C_HOST4 = 1;
const C_SRFLX4 = 2;
const C_RELAY4 = 3;
const C_HOST6 = 4;
const C_SRFLX6 = 5;
const C_RELAY6 = 6;
type Kind = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type CandType = "host" | "srflx" | "relay";

const ADDR_LEN: Readonly<Record<number, number>> = { 0: 16, 1: 4, 2: 4, 3: 4, 4: 16, 5: 16, 6: 16 };
const TYPE_OF: Readonly<Record<Kind, CandType>> = { 0: "host", 1: "host", 2: "srflx", 3: "relay", 4: "host", 5: "srflx", 6: "relay" };
const isV6 = (k: Kind): boolean => k === C_HOST6 || k === C_SRFLX6 || k === C_RELAY6;
const isKind = (k: number): k is Kind => Number.isInteger(k) && k >= 0 && k <= 6;

const SETUPS = ["actpass", "active", "passive", "holdconn"] as const;
const MAX_CANDS = 8; // more than this is stragglers, not reach
const RETAIN: readonly Kind[] = [C_RELAY4, C_RELAY6, C_SRFLX4, C_SRFLX6, C_MDNS, C_HOST4, C_HOST6];

const PRIORITY: Readonly<Record<CandType, number>> = { host: 2113937151, srflx: 1677729535, relay: 16777215 };

const line = (sdp: string, re: RegExp): string | null => {
  const m = sdp.match(re);
  return m ? (m[1] ?? null) : null;
};

interface Cand {
  readonly kind: Kind;
  readonly addr: Uint8Array;
  readonly port: number;
}

function v4ToBytes(addr: string | null | undefined): Uint8Array | null {
  const p = String(addr || "").split(".");
  if (p.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const tok = p[i] as string;
    // Only a strict 0..255 decimal token is an IPv4 byte (sdp.js:23-29).
    if (!/^\d{1,3}$/.test(tok)) return null;
    const n = Number(tok);
    if (!(n >= 0 && n <= 255) || String(n) !== tok) return null;
    out[i] = n;
  }
  return out;
}
const bytesToV4 = (b: Uint8Array): string => Array.from(b).join(".");

function v6ToBytes(addr: string): Uint8Array | null {
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  // Trailing dotted IPv4 (NAT64 64:ff9b::a.b.c.d, ::a.b.c.d) (sdp.js:39-48).
  if (addr.indexOf(".") >= 0) {
    const lastColon = addr.lastIndexOf(":");
    if (lastColon < 0) return null;
    const v4 = v4ToBytes(addr.slice(lastColon + 1));
    if (!v4) return null;
    const hi = (((v4[0] as number) << 8) | (v4[1] as number)).toString(16);
    const lo = (((v4[2] as number) << 8) | (v4[3] as number)).toString(16);
    addr = addr.slice(0, lastColon + 1) + hi + ":" + lo;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const grp = (s: string | undefined): string[] => (s ? s.split(":").filter((x) => x.length) : []);
  const head = grp(halves[0]);
  const tail = halves.length === 2 ? grp(halves[1]) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const words = head.concat(new Array<string>(fill).fill("0"), tail);
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const w = words[i] ?? "";
    // parseInt("cafeg", 16) is 0xcafe — refuse non-hex so garbage never packs.
    if (!/^[0-9a-fA-F]{1,4}$/.test(w)) return null;
    const n = parseInt(w, 16);
    if (!(n >= 0 && n <= 0xffff)) return null;
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

function bytesToV6(b: Uint8Array): string {
  const words: string[] = [];
  for (let i = 0; i < 8; i++) words.push((((b[i * 2] as number) << 8) | (b[i * 2 + 1] as number)).toString(16));
  // Collapse the longest run of zero words, as every implementation prints it.
  let bestAt = -1;
  let bestLen = 0;
  let at = -1;
  let len = 0;
  for (let i = 0; i < 9; i++) {
    if (i < 8 && words[i] === "0") {
      if (at < 0) at = i;
      len++;
    } else {
      if (len > bestLen) {
        bestLen = len;
        bestAt = at;
      }
      at = -1;
      len = 0;
    }
  }
  if (bestLen < 2) return words.join(":");
  return words.slice(0, bestAt).join(":") + "::" + words.slice(bestAt + bestLen).join(":");
}

/** fe80::/10 link-local and ::1: no OTHER device can reach them (sdp.js:85-93). */
function unreachableV6(b: Uint8Array): boolean {
  if (b[0] === 0xfe && ((b[1] as number) & 0xc0) === 0x80) return true;
  for (let i = 0; i < 15; i++) if (b[i]) return false;
  return b[15] === 1;
}

function parseCandidate(text: string): Cand | null {
  const t = text.trim().split(/\s+/);
  if (t.length < 8 || t[6] !== "typ") return null;
  const transport = (t[2] as string).toLowerCase();
  if (transport !== "udp") return null; // TCP is dropped
  if (t[1] !== "1") return null; // component 2 is RTCP; not for data
  let addr = t[4] as string;
  const port = Number(t[5]);
  const type = t[7];
  // An IPv4-mapped IPv6 address is an IPv4 candidate in v6 clothing.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) addr = mapped[1] as string;

  if (/\.local$/i.test(addr)) {
    const uuid = hexToBytes(addr.replace(/\.local$/i, "").replace(/-/g, ""));
    if (!uuid || uuid.length !== 16) return null;
    return { kind: C_MDNS, addr: uuid, port };
  }
  if (addr.indexOf(":") >= 0) {
    const b = v6ToBytes(addr);
    if (!b) return null;
    if (unreachableV6(b)) return null;
    if (type === "host") return { kind: C_HOST6, addr: b, port };
    if (type === "srflx") return { kind: C_SRFLX6, addr: b, port };
    if (type === "relay") return { kind: C_RELAY6, addr: b, port };
    return null;
  }
  const b = v4ToBytes(addr);
  if (!b) return null;
  if (b[0] === 127) return null; // loopback: this machine only
  if (type === "host") return { kind: C_HOST4, addr: b, port };
  if (type === "srflx") return { kind: C_SRFLX4, addr: b, port };
  if (type === "relay") return { kind: C_RELAY4, addr: b, port };
  return null;
}

function mdnsName(b: Uint8Array): string {
  const h = bytesToHex(b, "").toLowerCase();
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20) + ".local";
}

function candidateLine(c: Cand, i: number): string {
  const type = TYPE_OF[c.kind];
  const addr = c.kind === C_MDNS ? mdnsName(c.addr) : isV6(c.kind) ? bytesToV6(c.addr) : bytesToV4(c.addr);
  // rel-addr is masked rather than carried: diagnostic only (sdp.js:126-129).
  const rel = type === "srflx" || type === "relay" ? (isV6(c.kind) ? " raddr :: rport 0" : " raddr 0.0.0.0 rport 0") : "";
  return "a=candidate:" + (i + 1) + " 1 udp " + PRIORITY[type] + " " + addr + " " + c.port + " typ " + type + rel + " generation 0";
}

/** ufrag/pwd are ASCII by spec (ice-char); refuse anything else (sdp.js:213-224). */
function strBytes(s: string): Uint8Array | null {
  const out = new Uint8Array(s.length);
  if (s.length > 255) return null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return null;
    out[i] = c;
  }
  return out;
}

export function pack(sdp: string | null | undefined): Uint8Array<ArrayBuffer> | null {
  const text = String(sdp || "");
  const fpHex = line(text, /^a=fingerprint:sha-256 (\S+)/im);
  const ufrag = line(text, /^a=ice-ufrag:(\S+)/im);
  const pwd = line(text, /^a=ice-pwd:(\S+)/im);
  const setup = line(text, /^a=setup:(\S+)/im) || "actpass";
  if (!fpHex || !ufrag || !pwd) return null;
  const fp = hexToBytes(fpHex);
  if (!fp || fp.length !== 32) return null; // only sha-256 is packed
  const setupIdx = (SETUPS as readonly string[]).indexOf(setup);
  if (setupIdx < 0) return null;
  const uf = strBytes(ufrag);
  const pw = strBytes(pwd);
  if (!uf || !pw) return null;

  // TAKE THE FIRST EIGHT OF EACH KIND, NOT THE FIRST EIGHT: SDP lists
  // candidates in gathering order and relay is always last (sdp.js:174-193).
  const byKind = new Map<Kind, Cand[]>();
  const re = /^a=candidate:(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const c = parseCandidate(m[1] as string);
    // A port is an integer 1..65535 or the candidate is noise.
    if (!c || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535) continue;
    const list = byKind.get(c.kind);
    if (list) list.push(c);
    else byKind.set(c.kind, [c]);
  }
  const order = [...byKind.keys()].sort((a, b) => RETAIN.indexOf(a) - RETAIN.indexOf(b));
  const cands: Cand[] = [];
  for (let round = 0; cands.length < MAX_CANDS; round++) {
    let added = 0;
    for (const k of order) {
      const list = byKind.get(k) as Cand[];
      const c = list[round];
      if (c && cands.length < MAX_CANDS) {
        cands.push(c);
        added++;
      }
    }
    if (!added) break;
  }
  if (!cands.length) return null; // nothing to connect to

  let n = 3 + 32 + 1 + uf.length + 1 + pw.length;
  for (const c of cands) n += 1 + (ADDR_LEN[c.kind] as number) + 2;
  const out = new Uint8Array(n);
  let o = 0;
  out[o++] = VERSION;
  out[o++] = setupIdx & 0x03;
  out[o++] = cands.length;
  out.set(fp, o);
  o += 32;
  out[o++] = uf.length;
  out.set(uf, o);
  o += uf.length;
  out[o++] = pw.length;
  out.set(pw, o);
  o += pw.length;
  for (const c of cands) {
    out[o++] = c.kind;
    out.set(c.addr, o);
    o += c.addr.length;
    out[o++] = c.port >> 8;
    out[o++] = c.port & 0xff;
  }
  return out;
}

export function unpack(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes || bytes.length < 4) return null;
  const at = (i: number): number => bytes[i] as number;
  let o = 0;
  if (at(o++) !== VERSION) return null;
  const setup = SETUPS[at(o++) & 0x03] as string;
  const count = at(o++);
  if (bytes.length < o + 32) return null;
  const fp = bytesToHex(bytes.slice(o, o + 32), ":");
  o += 32;
  if (o >= bytes.length) return null;
  const ufLen = at(o++);
  if (bytes.length < o + ufLen) return null;
  const ufrag = ascii(bytes, o, ufLen);
  o += ufLen;
  if (o >= bytes.length) return null;
  const pwLen = at(o++);
  if (bytes.length < o + pwLen) return null;
  const pwd = ascii(bytes, o, pwLen);
  o += pwLen;

  const cands: Cand[] = [];
  for (let i = 0; i < count; i++) {
    if (o >= bytes.length) return null;
    const kind = at(o++);
    const len = ADDR_LEN[kind];
    if (!isKind(kind) || len == null || bytes.length < o + len + 2) return null;
    const addr = bytes.slice(o, o + len);
    o += len;
    const port = (at(o) << 8) | at(o + 1);
    o += 2;
    cands.push({ kind, addr, port });
  }
  if (!cands.length) return null;

  return [
    "v=0",
    "o=- 1 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=extmap-allow-mixed",
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
  ]
    .concat(cands.map(candidateLine))
    .concat([
      "a=ice-ufrag:" + ufrag,
      "a=ice-pwd:" + pwd,
      "a=fingerprint:sha-256 " + fp,
      "a=setup:" + setup,
      "a=mid:0",
      "a=sctp-port:5000",
      "a=max-message-size:262144",
      "",
    ])
    .join("\r\n");
}

/**
 * Hand our own reconstruction to a throwaway RTCPeerConnection before any human
 * sees it, validated as an OFFER (sdp.js:290-316). `PC` is injectable for tests.
 */
export async function verify(rebuilt: string, PC?: PeerConnectionCtor): Promise<boolean> {
  const Ctor = PC ?? (typeof RTCPeerConnection !== "undefined" ? RTCPeerConnection : null);
  if (!Ctor) return false;
  let probe: RTCPeerConnection | null = null;
  try {
    probe = new Ctor({});
    await probe.setRemoteDescription({ type: "offer", sdp: rebuilt.replace(/^a=setup:.*$/im, "a=setup:actpass") });
    return true;
  } catch (e) {
    // Name only: a parse error's message can quote the SDP line, ice-pwd included.
    netLog.debug("short SDP refused by this browser, using the full form:", e instanceof Error ? e.name : "");
    return false;
  } finally {
    if (probe) {
      try {
        probe.close();
      } catch {
        /* the probe already served its purpose */
      }
    }
  }
}

export async function packChecked(sdp: string, PC?: PeerConnectionCtor): Promise<Uint8Array<ArrayBuffer> | null> {
  const bytes = pack(sdp);
  if (!bytes) {
    netLog.debug("SDP not packable (no sha-256/ufrag/pwd or no UDP candidate), using the full form");
    return null;
  }
  const rebuilt = unpack(bytes);
  if (!rebuilt) {
    netLog.warn("packed SDP failed to unpack, using the full form");
    return null;
  }
  return (await verify(rebuilt, PC)) ? bytes : null;
}

/**
 * WHO MADE THIS DESCRIPTION: its DTLS fingerprint (sha-256 first), lower-case
 * hex without colons, so a verbatim SDP and its rebuild compare equal
 * (sdp.js:325-336).
 */
export function fingerprint(sdp: string | null | undefined): string | null {
  const text = String(sdp || "");
  const fp = line(text, /^a=fingerprint:sha-256 (\S+)/im) || line(text, /^a=fingerprint:\S+ (\S+)/im);
  const hex = fp ? fp.replace(/[^0-9a-f]/gi, "").toLowerCase() : "";
  return hex || null;
}

export interface SdpIdentity {
  readonly fp: string;
  readonly ufrag: string;
}

export function identity(sdp: string | null | undefined): SdpIdentity | null {
  const fp = fingerprint(sdp);
  const ufrag = line(String(sdp || ""), /^a=ice-ufrag:(\S+)/im);
  return fp && ufrag ? { fp, ufrag } : null;
}
