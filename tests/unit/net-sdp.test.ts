/* net-sdp.test.ts — the compact invite codec (src/net/sdp.ts).
 *
 * This is the module that makes an invite scannable instead of merely
 * pasteable, and it works by NOT sending the SDP: it extracts five facts and
 * rebuilds a complete description from a template. That is exactly the shape
 * of change that broke every real connection last time (a rejoin that dropped
 * the trailing CRLF), so the round trip is pinned line by line here, against
 * SDP captured from a real gathered RTCPeerConnection rather than invented.
 *
 * Ported from f1-game tests/unit/net-sdp.test.mjs:
 *   :44-66    REAL (captured Chromium offer) and field()
 *   :68-319   every NetSdp test: five facts, CRLF, required lines, size, exact
 *             allocation, srflx, IPv6 / NAT64 / dirty addresses, TCP and RTCP
 *             drop, setup role, null-not-partial, truncated struct, relay
 *             budget, IPv6 relay, IPv4-mapped, identity(), unreachable
 *             candidates and bad ports.
 * Not ported here: "NetBytes round-trips base64, base64url, hex and ascii"
 * (:27-42), which lives in tests/unit/net-bytes.test.ts.
 */
import { expect, test } from "vitest";
import { fingerprint, identity, pack, unpack } from "../../src/net/sdp";

// Captured verbatim from Chromium after ICE gathering completed, with the two
// data channels this game actually opens. The mDNS `.local` host candidate is
// Chrome's LAN-address privacy form and is the common case, so it is the one
// that must survive.
const REAL =
  [
    "v=0",
    "o=- 3676103885910906122 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=extmap-allow-mixed",
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=candidate:669599788 1 udp 2113937151 50a48b8e-b13b-42b4-b448-0ae6d08aaaf0.local 48941 typ host generation 0 network-cost 999",
    "a=ice-ufrag:0BnP",
    "a=ice-pwd:cYngfNsQbABEXhLKe2Bg/q3E",
    "a=ice-options:trickle",
    "a=fingerprint:sha-256 85:93:AA:4F:69:8F:E1:43:B7:87:D4:D5:6D:24:BD:FB:4D:F5:AA:1E:CC:1A:F6:17:61:6F:41:81:38:77:97:4B",
    "a=setup:actpass",
    "a=mid:0",
    "a=sctp-port:5000",
    "a=max-message-size:262144",
  ].join("\r\n") + "\r\n";

const field = (sdp: string, re: RegExp): string | null => {
  const m = sdp.match(re);
  return m ? (m[1] ?? null) : null;
};

/** pack → unpack, asserting both halves succeeded. */
function roundTrip(sdp: string): string {
  const out = unpack(pack(sdp));
  expect(out, "should have packed and unpacked").not.toBeNull();
  return out as string;
}

test("the five facts survive a real gathered offer", () => {
  const out = roundTrip(REAL);
  expect(field(out, /^a=ice-ufrag:(\S+)/m)).toBe("0BnP");
  expect(field(out, /^a=ice-pwd:(\S+)/m)).toBe("cYngfNsQbABEXhLKe2Bg/q3E");
  expect(field(out, /^a=fingerprint:sha-256 (\S+)/m)).toBe(field(REAL, /^a=fingerprint:sha-256 (\S+)/m));
  expect(field(out, /^a=setup:(\S+)/m)).toBe("actpass");
  expect(out).toMatch(/50a48b8e-b13b-42b4-b448-0ae6d08aaaf0\.local 48941 typ host/);
});

test("every line is CRLF-terminated, including the last", () => {
  // THE regression. An SDP whose final line has no terminator is refused
  // outright by Chrome with "Invalid SDP line", and it is invisible until two
  // real browsers try to connect.
  const out = roundTrip(REAL);
  expect(out.endsWith("\r\n"), "the final line MUST be terminated").toBe(true);
  expect(out.includes("\n\n"), "no blank lines").toBe(false);
  expect(/[^\r]\n/.test(out), "every LF must be preceded by CR").toBe(false);
});

test("the rebuild keeps the lines a data channel cannot connect without", () => {
  const out = roundTrip(REAL);
  for (const required of [
    "v=0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=group:BUNDLE 0",
    "a=mid:0",
    "a=sctp-port:5000",
    "a=max-message-size:262144",
  ]) {
    expect(out.includes(required), `missing: ${required}`).toBe(true);
  }
});

test("it is dramatically smaller than the text it replaces", () => {
  // The whole reason the module exists: a QR of ~650 characters needs a
  // density phone cameras struggle with, and ~130 does not.
  const packed = pack(REAL);
  expect(packed).not.toBeNull();
  const len = (packed as Uint8Array).length;
  expect(len, `expected under 100 bytes, got ${len}`).toBeLessThan(100);
  const b64 = Math.ceil(len / 3) * 4;
  expect(b64, `expected 4x smaller than the raw SDP, got ${b64} vs ${REAL.length}`).toBeLessThan(REAL.length / 4);
});

test("pack() allocates exactly the bytes it writes — no stray trailing 0x00", () => {
  // The regression this pins: the allocation arithmetic once carried a spare
  // `+ 1`, so every packed struct ended with one 0x00 the writer never touched.
  // Decode-harmless (unpack walks by count, not to the end) but a wire-format
  // wart, and a byte of QR density paid for nothing. The struct is
  //   ver + setup + count | fp(32) | len+ufrag | len+pwd | (kind+addr+port)*
  // and for REAL that is one mDNS candidate (16-byte uuid + 2-byte port).
  const packed = pack(REAL) as Uint8Array;
  expect(packed).not.toBeNull();
  const ufrag = "0BnP";
  const pwd = "cYngfNsQbABEXhLKe2Bg/q3E";
  const expected = 3 + 32 + (1 + ufrag.length) + (1 + pwd.length) + (1 + 16 + 2);
  expect(packed.length, `packed length must equal the struct size exactly, got ${packed.length} vs ${expected}`).toBe(expected);
  // And the last byte is the port's low byte, not padding (48941 & 0xff).
  expect(packed[packed.length - 1], "struct must END on the port low byte").toBe(48941 & 0xff);
});

test("a server-reflexive IPv4 candidate round-trips with its port", () => {
  // The candidate that actually connects two people on different networks.
  const withSrflx = REAL.replace(
    "a=ice-ufrag:0BnP",
    "a=candidate:842163049 1 udp 1677729535 203.0.113.7 54321 typ srflx raddr 192.168.1.10 rport 54321 generation 0\r\n" + "a=ice-ufrag:0BnP",
  );
  const out = roundTrip(withSrflx);
  expect(out).toMatch(/203\.0\.113\.7 54321 typ srflx/);
  // rel-addr is masked, not carried — diagnostic only, and ICE never connects
  // through it.
  expect(out).toMatch(/typ srflx raddr 0\.0\.0\.0 rport 0/);
});

test("an IPv6 host candidate round-trips, including :: compression", () => {
  const withV6 = REAL.replace(
    "a=ice-ufrag:0BnP",
    "a=candidate:1 1 udp 2113937151 2001:db8::1 9999 typ host generation 0\r\n" + "a=ice-ufrag:0BnP",
  );
  expect(roundTrip(withV6)).toMatch(/2001:db8::1 9999 typ host/);
});

test("NAT64 / embedded-IPv4 v6 candidates keep the full address, not a truncated hextet", () => {
  // parseInt("192.0.2.1", 16) used to stop at the dot and pack as ::192 —
  // the peer then dialled a different address than ICE gathered.
  const nat64 = REAL.replace(
    "a=ice-ufrag:0BnP",
    "a=candidate:1 1 udp 2113937151 64:ff9b::192.0.2.1 54321 typ host generation 0\r\n" + "a=ice-ufrag:0BnP",
  );
  const out = roundTrip(nat64);
  expect(out, "64:ff9b::192.0.2.1 must survive as its two trailing hextets").toMatch(/64:ff9b::c000:201 54321 typ host/);
  expect(out, "must not silently truncate at the first dotted octet").not.toMatch(/64:ff9b::192\b/);

  const bare = REAL.replace(
    "a=ice-ufrag:0BnP",
    "a=candidate:1 1 udp 2113937151 ::192.0.2.1 54321 typ host generation 0\r\n" + "a=ice-ufrag:0BnP",
  );
  expect(roundTrip(bare)).toMatch(/::c000:201 54321 typ host/);
});

test("dirty hextets and trailing-empty IPv4 octets are refused, never rewritten", () => {
  // parseInt("cafeg", 16) === 0xcafe; Number("") === 0. Both used to pack a
  // plausible-looking wrong address into the invite.
  const dirty = REAL.replace(/^a=candidate:.*$/m, "a=candidate:1 1 udp 2113937151 2001:db8::cafeg 9999 typ host generation 0");
  expect(pack(dirty), "non-hex hextet must drop the candidate set").toBeNull();

  const trail = REAL.replace(/^a=candidate:.*$/m, "a=candidate:1 1 udp 2113937151 192.168.1. 54321 typ host generation 0");
  expect(pack(trail), "trailing empty IPv4 octet must not become .0").toBeNull();
});

test("TCP and non-data components are dropped, not mangled", () => {
  // Dropping them is most of the remaining size, and a TCP candidate is
  // near-useless for a data channel across a NAT.
  const withTcp = REAL.replace(
    "a=ice-ufrag:0BnP",
    "a=candidate:9 1 tcp 1518280447 192.168.1.10 9 typ host tcptype active generation 0\r\n" +
      "a=candidate:8 2 udp 2113937150 192.168.1.10 5001 typ host generation 0\r\n" +
      "a=ice-ufrag:0BnP",
  );
  const out = roundTrip(withTcp);
  expect(out.includes(" tcp "), "TCP candidate should be gone").toBe(false);
  expect(out.includes("5001"), "component 2 is RTCP, not for a data channel").toBe(false);
  expect(out, "the usable candidate must remain").toMatch(/48941 typ host/);
});

test("an answer keeps its setup role, which is what makes it an answer", () => {
  const answer = REAL.replace("a=setup:actpass", "a=setup:active");
  expect(field(roundTrip(answer), /^a=setup:(\S+)/m)).toBe("active");
});

test("anything not fully understood packs to null rather than partially", () => {
  // A partial pack is worse than a long code: it produces an invite that looks
  // perfectly fine and cannot connect.
  expect(pack("")).toBeNull();
  expect(pack(REAL.replace(/^a=fingerprint:.*$/m, "")), "no fingerprint").toBeNull();
  expect(pack(REAL.replace(/^a=ice-pwd:.*$/m, "")), "no ice-pwd").toBeNull();
  expect(pack(REAL.replace(/^a=candidate:.*$/m, "")), "no candidates").toBeNull();
  // sha-1 fingerprints are not packed — refuse rather than silently truncate.
  expect(pack(REAL.replace(/a=fingerprint:sha-256 \S+/, "a=fingerprint:sha-1 AB:CD"))).toBeNull();
});

test("a truncated struct unpacks to null rather than a plausible offer", () => {
  const packed = pack(REAL) as Uint8Array;
  expect(packed).not.toBeNull();
  expect(unpack(packed.slice(0, packed.length - 3))).toBeNull();
  expect(unpack(new Uint8Array([9, 0, 1])), "wrong version").toBeNull();
  expect(unpack(null)).toBeNull();
});

test("the relay candidate survives the budget, because it arrives last", () => {
  // MEASURED, and unguarded until now. SDP lists candidates in GATHERING
  // order — host, then srflx once STUN answers, then relay once TURN
  // allocates — so relay is ALWAYS last. Truncating the raw sequence at
  // MAX_CANDS therefore dropped exactly the candidate that matters most, and
  // dropped it on precisely the machines that need one: a laptop with Wi-Fi,
  // Ethernet, a VPN and IPv6 fills eight slots before a relay line is emitted.
  //
  // The symptom was maddening: the connection gathered relay candidates, and
  // the invite code carried none — so the peer was handed addresses it could
  // not reach. Every wire dump read relay:0 and looked exactly like a dead relay.
  const cands = [
    "a=candidate:1 1 udp 2113937151 192.168.1.10 5001 typ host",
    "a=candidate:2 1 udp 2113937151 192.168.1.11 5002 typ host",
    "a=candidate:3 1 udp 2113937151 10.0.0.5 5003 typ host",
    "a=candidate:4 1 udp 2113937151 10.211.55.2 5004 typ host",
    "a=candidate:5 1 udp 2113937151 172.16.0.3 5005 typ host",
    "a=candidate:6 1 udp 2113937151 192.168.64.1 5006 typ host",
    "a=candidate:7 1 udp 1677729535 203.0.113.9 5007 typ srflx raddr 0.0.0.0 rport 0",
    "a=candidate:8 1 udp 1677729535 203.0.113.10 5008 typ srflx raddr 0.0.0.0 rport 0",
    "a=candidate:9 1 udp 16777215 198.51.100.7 5009 typ relay raddr 0.0.0.0 rport 0",
  ];
  const sdp =
    [
      "v=0",
      "o=- 1 2 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "c=IN IP4 0.0.0.0",
      "a=ice-ufrag:AbCd",
      "a=ice-pwd:0123456789abcdefghijklmn",
      "a=fingerprint:sha-256 " +
        Array.from({ length: 32 }, (_, i) =>
          ((i * 7) % 256).toString(16).toUpperCase().padStart(2, "0"),
        ).join(":"),
      "a=setup:actpass",
      "a=sctp-port:5000",
    ]
      .concat(cands)
      .join("\r\n") + "\r\n";

  expect(cands.length, "the fixture must actually exceed the budget").toBeGreaterThan(8);

  const bytes = pack(sdp);
  expect(bytes, "a crowded SDP must still pack").not.toBeNull();
  const out = unpack(bytes);
  expect(out, "and unpack").not.toBeNull();

  expect(
    out,
    "THE RELAY MUST SURVIVE — it is the one candidate that works when none of " + "the others can, and it is always the last one gathered",
  ).toMatch(/198\.51\.100\.7 5009 typ relay/);
  expect(out, "the public address keeps its place too").toMatch(/typ srflx/);
  expect(
    out,
    "and the LAN keeps one, because two phones on a sofa are the case the " + "mDNS packing exists for",
  ).toMatch(/typ host/);
});

test("an IPv6 relay candidate round-trips — it is the whole relay leg on a v6-only path", () => {
  const withV6Relay = REAL.replace(
    "a=ice-ufrag:0BnP",
    "a=candidate:7 1 udp 16777215 2001:db8:5::9 3478 typ relay raddr 2001:db8::1 rport 5000 generation 0\r\n" + "a=ice-ufrag:0BnP",
  );
  expect(roundTrip(withV6Relay), "kind C_RELAY6 exists and masks rel-addr the v6 way").toMatch(
    /2001:db8:5::9 3478 typ relay raddr :: rport 0/,
  );
});

test("an IPv4-mapped IPv6 address is packed as the IPv4 candidate it is", () => {
  // ::ffff:a.b.c.d parsed as hex words was garbage (parseInt("1.2.3.4", 16)).
  const withMapped = REAL.replace(
    "a=ice-ufrag:0BnP",
    "a=candidate:8 1 udp 1677729535 ::ffff:203.0.113.9 40000 typ srflx raddr 0.0.0.0 rport 0 generation 0\r\n" + "a=ice-ufrag:0BnP",
  );
  expect(roundTrip(withMapped)).toMatch(/203\.0\.113\.9 40000 typ srflx/);
});

// ── identity: what binds an answer to its offer (handshake offerId) ─────────
// The host hashes its OWN verbatim SDP; the guest hashes the one it REBUILT
// from the packed bytes. Both must read the same ufrag and fingerprint, or
// every packed answer would be refused as "for an older invite".
test("identity() reads the same ufrag + fingerprint off the verbatim and the rebuilt SDP", () => {
  const verbatim = identity(REAL);
  const rebuilt = identity(unpack(pack(REAL)));
  expect(verbatim && verbatim.ufrag === "0BnP", "ufrag read").toBe(true);
  expect(verbatim?.fp, "lower-case hex, no colons").toMatch(/^[0-9a-f]{64}$/);
  expect(rebuilt, "pack/unpack does not change the identity").toEqual(verbatim);
  expect(fingerprint(REAL)).toBe(verbatim?.fp);
  // sha-256 is preferred even when another algorithm is listed first — pack() carries only sha-256.
  const both = REAL.replace("a=fingerprint:sha-256", "a=fingerprint:sha-384 " + "11:".repeat(47) + "11\r\na=fingerprint:sha-256");
  expect(fingerprint(both)).toBe(verbatim?.fp);
  expect(identity("v=0\r\n"), "no ufrag/fingerprint, no identity").toBeNull();
});

// L8-e: candidates no other device can reach, and ports that are not ports,
// never take one of the MAX_CANDS slots (and a NaN port was packed as 0).
test("link-local IPv6, loopback and non-numeric ports are not packed", () => {
  const withCands = (lines: readonly string[]): string =>
    REAL.replace(/^a=candidate:.*\r\n/m, lines.map((l) => "a=candidate:" + l + "\r\n").join(""));
  const sdp = withCands([
    "1 1 udp 2113937151 fe80::1%eth0 50000 typ host generation 0",
    "2 1 udp 2113937151 ::1 50001 typ host generation 0",
    "3 1 udp 2113937151 127.0.0.1 50002 typ host generation 0",
    "4 1 udp 2113937151 192.168.1.10 abc typ host generation 0",
    "5 1 udp 2113937151 192.168.1.11 0 typ host generation 0",
    "6 1 udp 2113937151 192.168.1.12 54321 typ host generation 0",
    "7 1 udp 2113937151 2001:db8::5 54322 typ host generation 0",
  ]);
  const out = roundTrip(sdp);
  const cands = out.match(/^a=candidate:.*$/gm) ?? [];
  expect(cands.length, "only the two reachable candidates: " + cands.join(" | ")).toBe(2);
  expect(out).toMatch(/192\.168\.1\.12 54321 typ host/);
  expect(out).toMatch(/2001:db8::5 54322 typ host/);
  expect(cands.join("\n")).not.toMatch(/fe80|::1 |127\.0\.0\.1| 0 typ /);
  // Nothing reachable at all: nothing to pack, as before.
  expect(pack(withCands(["1 1 udp 2113937151 fe80::2 5 typ host generation 0"]))).toBeNull();
});
