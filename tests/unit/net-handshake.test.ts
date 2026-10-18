/* net-handshake.test.ts — invite codes, build identity and the offer/answer
 * exchange (src/net/handshake.ts), against fakes: no wire, no browser.
 *
 * Ported from f1-game tests/unit/net-transport.test.mjs (the NetHandshake tests):
 *   :563-574    an invite code round-trips through compression
 *   :576-582    the code is markedly smaller than the SDP it carries
 *   :584-597    garbage and truncated codes are rejected
 *   :599-620    packed SDP rejects non-object payloads / missing fields
 *   :622-638    oversized encoded and plain payloads
 *   :640-645    whitespace from a sloppy copy/paste
 *   :647-685    build mismatch; unknown build is refused
 *   :687-712    SDP verbatim, CRLF-terminated
 *   :714-731    the invite link keeps the code in the fragment
 *   :960-978    localBuild() reads the build meta before it fetches
 *   :980-992    peekCode agrees with decodeCode
 *   :1023-1051  waitForIce re-check after listen, null icecandidate end
 *   :1089-1136  acceptAnswer refuses an answer for an older offer (wrong_offer)
 * and from f1-game tests/unit/desktop-native.test.mjs:225-243, the web case of
 * inviteUrl()/inviteFromUrl() (the native cases need f1-game's Native.shareBase;
 * here that is inviteUrl's optional `base`).
 *
 * Adapted to deliberate apex-26 differences:
 *   - the shell's build meta is <meta name="a26-build"> (f1-game: apex-build);
 *     the localBuild test also pins that apex-build is NOT read;
 *   - a "fresh module" (f1-game re-evals handshake.js) is setLocalBuild(null),
 *     which clears the memoised build;
 *   - NetSdp.unpack is replaced through vi.mock instead of globalThis.NetSdp;
 *   - Hash32.fnv1a is the local fnv1a export.
 * Not ported: the index.html textarea maxlength half of the oversized-payload
 * test (:633-637) — apex-26 has no lobby UI yet; the fuzz test over
 * LobbyCodes.codeFrom + peek/decode (fuzz-untrusted-inputs.test.mjs:119-194)
 * needs LobbyCodes and the seeded-fuzz helper, neither ported. The lobby-*
 * tests only stub NetHandshake, so none of them exercise handshake.ts.
 */
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { bytesToB64url } from "../../src/net/bytes";
import {
  MAGIC,
  acceptAnswer,
  acceptInvite,
  checkBuild,
  decodeCode,
  encodeCode,
  fnv1a,
  inviteFromUrl,
  inviteUrl,
  localBuild,
  metaBuild,
  normaliseSdp,
  offerId,
  peekCode,
  setLocalBuild,
  waitForIce,
  withoutInviteUrl,
  type BuildId,
  type CodePayload,
  type HasPc,
  type IceGatherTarget,
} from "../../src/net/handshake";

// f1-game swaps globalThis.NetSdp for a stub; here unpack is routed through an
// override the packed-SDP test sets, and is the real one otherwise.
const sdpOverride = vi.hoisted(() => ({
  unpack: null as null | ((bytes: Uint8Array | null | undefined) => string | null),
}));
vi.mock("../../src/net/sdp", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/net/sdp")>();
  return {
    ...real,
    unpack: (bytes: Uint8Array | null | undefined): string | null => (sdpOverride.unpack ?? real.unpack)(bytes),
  };
});

beforeEach(() => {
  setLocalBuild(null);
  sdpOverride.unpack = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLocalBuild(null);
  sdpOverride.unpack = null;
});

/** A `document` whose only element is <meta name="a26-build" content=…>. */
const metaDocument = (content: string): { querySelector: (sel: string) => unknown } => ({
  querySelector: (sel: string) => (sel === 'meta[name="a26-build"]' ? { content } : null),
});

// ---------------------------------------------------------------------------
// Handshake codec
// ---------------------------------------------------------------------------

test("an invite code round-trips through compression", async () => {
  const payload = {
    v: MAGIC,
    b: 817,
    k: "offer",
    p: { team: "ferrari", driver: 0 },
    s: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=ice-ufrag:abcd\r\n".repeat(20),
  };
  const code = await encodeCode(payload);
  const back = await decodeCode(code);
  expect(back.ok).toBe(true);
  if (!back.ok) return;
  expect(back.payload).toStrictEqual(payload);
});

test("the code is markedly smaller than the SDP it carries", async () => {
  // The whole point of compressing: a raw gathered SDP is a miserable paste.
  const sdp = "a=candidate:1 1 udp 2113937151 192.168.1.10 54321 typ host generation 0\r\n".repeat(40);
  const code = await encodeCode({ b: 1, k: "offer", p: null, s: sdp });
  expect(code.startsWith(MAGIC + ".z."), "should have taken the compressed path").toBe(true);
  expect(code.length, `expected heavy compression, got ${code.length} vs ${sdp.length}`).toBeLessThan(sdp.length / 4);
});

test("garbage and truncated codes are rejected with a usable message", async () => {
  for (const bad of ["", "hello", "APEX1.z", "NOPE.z.AAAA"]) {
    const r = await decodeCode(bad);
    expect(r.ok, `"${bad}" should be rejected`).toBe(false);
    if (r.ok) continue;
    expect(r.message.length, "should explain itself to a human").toBeGreaterThan(10);
  }
  // Right envelope, ruined body.
  const truncated = await decodeCode("APEX1.z.####");
  expect(truncated.ok).toBe(false);
  expect(!truncated.ok && truncated.error).toBe("corrupt_code");
  expect((await decodeCode("APEX1.x.e30")).ok, "unknown envelopes must not bypass the plain-payload size policy").toBe(false);
});

test("packed SDP rejects non-object payloads and missing handshake fields as corrupt", async () => {
  sdpOverride.unpack = () => "v=0\r\n";
  const packed = (json: unknown): string => {
    const rest = Buffer.from(JSON.stringify(json));
    const joined = Buffer.concat([Buffer.from([0, 1, 7]), rest]);
    return "APEX1.s." + bytesToB64url(new Uint8Array(deflateRawSync(joined)));
  };
  for (const payload of [null, "offer", [], { b: 1 }]) {
    const decoded = await decodeCode(packed(payload));
    expect(decoded.ok, `packed ${JSON.stringify(payload)} must be corrupt`).toBe(false);
    expect(!decoded.ok && decoded.error).toBe("corrupt_code");
  }
  sdpOverride.unpack = () => null;
  const noSdp = await decodeCode(packed({ b: 1, k: "offer" }));
  expect(!noSdp.ok && noSdp.error, "a packed payload without reconstructable SDP must be corrupt").toBe("corrupt_code");
});

test("invite decoding rejects oversized encoded and plain payloads before use", async () => {
  const tooLong = "APEX1.p." + "A".repeat(512 * 1024 + 1);
  expect((await decodeCode(tooLong)).ok, "encoded input must be bounded before atob allocates it").toBe(false);

  // Still below the encoded ceiling, but above the decoded JSON/SDP ceiling.
  const plain = JSON.stringify({ k: "offer", pad: "x".repeat(270 * 1024) });
  const encoded = Buffer.from(plain).toString("base64url");
  expect(encoded.length, "fixture must exercise the decoded cap").toBeLessThan(512 * 1024);
  expect((await decodeCode("APEX1.p." + encoded)).ok).toBe(false);
  // f1-game also pins index.html's textarea maxlength here; apex-26 has no lobby UI yet.
});

test("whitespace from a sloppy copy/paste is tolerated", async () => {
  const code = await encodeCode({ b: 1, k: "offer", p: null, s: "v=0" });
  const mangled = "  " + code.slice(0, 10) + "\n  " + code.slice(10) + "\t\n";
  const back = await decodeCode(mangled);
  expect(back.ok, "a code split across lines by a chat client must still work").toBe(true);
});

test("a build mismatch is refused, and says which side is stale", () => {
  expect(checkBuild(817, 817).ok).toBe(true);

  const older = checkBuild(817, 800);
  expect(older.ok).toBe(false);
  if (older.ok) return;
  expect(older.error).toBe("build_mismatch");
  expect(older.message).toMatch(/ask them to reload/i);

  const newer = checkBuild(800, 817);
  expect(newer.ok).toBe(false);
  if (newer.ok) return;
  expect(newer.message).toMatch(/reload the page to update/i);
});

// An UNKNOWN build is not a matching build. localBuild() used to answer a failed
// version.json fetch with 0 and memoise it, so two peers who had both failed
// compared 0 === 0 and were waved through the one guard that keeps mismatched
// splines, barriers and tuning constants off the same track.
test("an unknown build is refused, not treated as a match", () => {
  const cases: ReadonlyArray<readonly [BuildId | null | undefined, BuildId | null | undefined]> = [
    [null, null],
    [null, 817],
    [817, null],
    [undefined, 817],
    [817, undefined],
  ];
  for (const [mine, theirs] of cases) {
    const r = checkBuild(mine, theirs);
    expect(r.ok, `checkBuild(${mine}, ${theirs}) must not pass`).toBe(false);
    if (r.ok) continue;
    expect(r.error).toBe("build_unknown");
    // The old failure mode told people to "reload the page to update", which
    // could not work: the reload hit the same dead fetch. Say what is true.
    expect(r.message).toMatch(/could not confirm/i);
  }

  // A real pair of equal builds still matches — the guard above must not have
  // swallowed the ordinary case.
  expect(checkBuild(817, 817).ok).toBe(true);
  // 0 is a LEGITIMATE build number, not the sentinel it used to double as.
  expect(checkBuild(0, 0).ok).toBe(true);
  const zero = checkBuild(0, 817);
  expect(!zero.ok && zero.error).toBe("build_mismatch");
});

test("SDP survives the round trip verbatim, CRLF-terminated", () => {
  // The regression this exists for. An earlier version stripped "regenerable"
  // attributes and rejoined with \n, which dropped the trailing terminator —
  // so the last line arrived unterminated and Chrome refused the whole
  // description with "Invalid SDP line".
  const sdp =
    [
      "v=0",
      "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "a=ice-ufrag:4ZcD",
      "a=ice-pwd:2/1muCWoOi3uLifh0NuRHlZw",
      "a=fingerprint:sha-256 AB:CD",
      "a=candidate:1 1 udp 2113937151 192.168.1.10 54321 typ host",
      "a=sctp-port:5000",
      "a=max-message-size:262144", // the line that was being orphaned
    ].join("\r\n") + "\r\n";

  const out = normaliseSdp(sdp);
  expect(out, "the SDP must survive untouched").toBe(sdp);
  expect(out.endsWith("\r\n"), "the final line MUST be terminated").toBe(true);
  expect(out.includes("a=max-message-size:262144")).toBe(true);
  expect(out.includes("\n\n"), "no blank lines").toBe(false);

  // Bare-LF input (some stacks) is normalised up to CRLF rather than passed on.
  const lf = normaliseSdp("v=0\na=ice-ufrag:x\na=max-message-size:262144");
  expect(lf).toBe("v=0\r\na=ice-ufrag:x\r\na=max-message-size:262144\r\n");
});

test("the invite link keeps the code in the fragment", () => {
  // The fragment never leaves the browser, so the code never reaches a server
  // log — which matters because there is no server in this design at all.
  const code = "APEX1.z.SOMECODE";
  expect(inviteFromUrl("https://x.dev/#vs=" + code)).toBe(code);
  expect(inviteFromUrl("https://x.dev/#a=1&vs=" + code)).toBe(code);
  // A link pasted from a message carries the message's tail: the code ends at whitespace.
  expect(inviteFromUrl("https://x.dev/#vs=" + code + "\nSent from my iPhone")).toBe(code);
  expect(inviteFromUrl("https://x.dev/#vs=" + code + " see you on track")).toBe(code);
  expect(inviteFromUrl("https://x.dev/?vs=nope"), "a query-string code must NOT be honoured — that one does reach the server").toBeNull();
  expect(
    withoutInviteUrl("https://x.dev/play?renderer=glx#keep=1&vs=" + code + "&camera=chase"),
    "consuming an invite preserves unrelated query and fragment state",
  ).toBe("https://x.dev/play?renderer=glx#keep=1&camera=chase");
});

// f1-game desktop-native.test.mjs:225-243, the web kind: the link base is this
// page's origin + pathname. The native kinds pass a public share base, which
// apex-26 takes as inviteUrl's optional `base`.
test("inviteUrl builds the link from this page, and inviteFromUrl reads it back", () => {
  const origin = "https://preview.test";
  vi.stubGlobal("location", { origin, pathname: "/custom/index.html" });
  const base = origin + "/custom/index.html";
  expect(inviteUrl("INVITE")).toBe(base + "#vs=INVITE");
  expect(inviteFromUrl(inviteUrl("INVITE"))).toBe("INVITE");
  const publicBase = "https://brycejmurrin.github.io/f1-game/";
  expect(inviteUrl("INVITE", publicBase)).toBe(publicBase + "#vs=INVITE");
  expect(inviteFromUrl(inviteUrl("INVITE", publicBase))).toBe("INVITE");
});

// ── the build is the one THIS shell is running ──────────────────────────────
// A tab left open across a deploy fetched the NEW version.json while running
// the OLD scripts. The shell stamps its own generation in a build meta, and
// that is what the handshake reports; the fetch is the fallback for a shell
// with no stamp. apex-26: the meta is name="a26-build" (f1-game "apex-build").
test("localBuild() reads the shell's a26-build meta before it fetches", async () => {
  let fetched = 0;
  vi.stubGlobal("fetch", async () => {
    fetched++;
    return { json: async () => ({ build: 2000 }) };
  });
  vi.stubGlobal("document", metaDocument(" 1234 "));
  expect(metaBuild()).toBe(1234);
  expect(await localBuild(), "the meta wins").toBe(1234);
  expect(fetched, "and version.json is never asked").toBe(0);

  vi.stubGlobal("document", { querySelector: () => null });
  setLocalBuild(null); // f1-game re-evals the module; this clears the memoised build
  expect(metaBuild()).toBeNull();
  expect(await localBuild(), "no stamp: the fetch still answers").toBe(2000);
  expect(fetched).toBe(1);

  // apex-26: f1-game's meta name is not ours (f1-game owns it on the same origin).
  vi.stubGlobal("document", {
    querySelector: (sel: string) => (sel === 'meta[name="apex-build"]' ? { content: "1234" } : null),
  });
  expect(metaBuild(), "an apex-build meta is f1-game's, not this shell's").toBeNull();
});

// ── peekCode: the format half of decodeCode, synchronous and connection-free ──
// The lobby runs it BEFORE it needs a transport, so a typo is refused as a
// typo while join() is still waiting on the ICE prefetch. It must agree with
// decodeCode on every shape decodeCode rejects without decoding.
test("peekCode refuses the shapes decodeCode refuses, synchronously, and accepts a real code", async () => {
  const errorOf = (r: { readonly ok: boolean; readonly error?: string }): string | undefined => r.error;
  expect(errorOf(peekCode("not-a-real-code"))).toBe("bad_code");
  const bad = peekCode("not-a-real-code");
  expect(!bad.ok && bad.message).toMatch(/apex invite code/i);
  expect(errorOf(peekCode(""))).toBe("bad_code");
  expect(errorOf(peekCode("APEX1.x.e30")), "an unknown mode is corrupt, not foreign").toBe("corrupt_code");
  expect(errorOf(peekCode("APEX1.z")), "two parts is not our shape").toBe("bad_code");
  const ok = peekCode("APEX1.p.e30");
  expect(ok.ok).toBe(true);
  if (ok.ok) {
    expect(ok.mode).toBe("p");
    expect(ok.body).toBe("e30");
  }
  for (const code of ["not-a-real-code", "APEX1.x.e30", "APEX1.z"]) {
    expect(errorOf(await decodeCode(code)), `decodeCode and peekCode agree on ${code}`).toBe(errorOf(peekCode(code)));
  }
});

// ── waitForIce: completion between the pre-check and the listener must not hang ──
// Without a re-check after addEventListener, ICE can finish in that gap and the
// waiter sits until gatherTimeoutMs — room-code answers then race a dying courier.
test("waitForIce re-checks after listening and honors a null icecandidate end", async () => {
  class RacePC extends EventTarget {
    iceGatheringState: RTCIceGatheringState = "gathering";
    override addEventListener(
      type: string,
      fn: EventListenerOrEventListenerObject | null,
      opts?: boolean | AddEventListenerOptions,
    ): void {
      super.addEventListener(type, fn, opts);
      // Race: complete AFTER the initial === "complete" check, BEFORE any event.
      if (type === "icegatheringstatechange") this.iceGatheringState = "complete";
    }
  }
  const raced = new RacePC();
  const t0 = Date.now();
  expect(await waitForIce(raced as unknown as IceGatherTarget, 4000), "must resolve from the post-listen re-check, not the 4 s timeout").toBe(
    true,
  );
  expect(Date.now() - t0, "must not wait out the gather timeout").toBeLessThan(500);

  class NullEndPC extends EventTarget {
    iceGatheringState: RTCIceGatheringState = "gathering";
  }
  const nullEnd = new NullEndPC();
  const p = waitForIce(nullEnd as unknown as IceGatherTarget, 4000);
  nullEnd.dispatchEvent(Object.assign(new Event("icecandidate"), { candidate: null }));
  expect(await p, "a null candidate ends gathering even if state lags").toBe(true);
});

// ── an answer names the offer it answers (L8-a) ─────────────────────────────
// An SDP answer carries only the answerer's credentials, so an answer to invite
// A used to be accepted onto a newer pending invite B and spin "Connecting…"
// for 60 s. The answer now carries `o` = hash of the offer's ufrag +
// fingerprint, and acceptAnswer refuses a mismatch as wrong_offer.
test("acceptAnswer refuses an answer built for an older offer, and still takes an id-less one", async () => {
  const fp = (n: number): string =>
    Array.from({ length: 32 }, (_, i) =>
      ((i * n + 1) & 255).toString(16).padStart(2, "0").toUpperCase(),
    ).join(":");
  const sdp = (ufrag: string, f: string, setup: string): string =>
    [
      "v=0",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "a=candidate:1 1 udp 2113937151 192.168.1.10 54321 typ host",
      "a=ice-ufrag:" + ufrag,
      "a=ice-pwd:abcdefghijklmnopqrstuvwx",
      "a=fingerprint:sha-256 " + f,
      "a=setup:" + setup,
    ].join("\r\n") + "\r\n";
  const offerA = sdp("aaaa", fp(3), "actpass");
  const offerB = sdp("bbbb", fp(5), "actpass");

  interface HostPc {
    signalingState: RTCSignalingState;
    iceGatheringState: RTCIceGatheringState;
    localDescription: RTCSessionDescriptionInit;
    took: RTCSessionDescriptionInit | null;
    setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void>;
  }
  const hostPc = (offer: string): HostPc => ({
    signalingState: "have-local-offer",
    iceGatheringState: "complete",
    localDescription: { type: "offer", sdp: offer },
    took: null,
    async setRemoteDescription(d) {
      this.took = d;
      this.signalingState = "stable";
    },
  });
  interface GuestPc {
    iceGatheringState: RTCIceGatheringState;
    localDescription: RTCSessionDescriptionInit | null;
    remote: RTCSessionDescriptionInit | null;
    setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void>;
    createAnswer(): Promise<RTCSessionDescriptionInit>;
    setLocalDescription(d: RTCSessionDescriptionInit): Promise<void>;
  }
  const guestPc = (): GuestPc => ({
    iceGatheringState: "complete",
    localDescription: null,
    remote: null,
    async setRemoteDescription(d) {
      this.remote = d;
    },
    async createAnswer() {
      return { type: "answer", sdp: sdp("gggg", fp(7), "active") };
    },
    async setLocalDescription(d) {
      this.localDescription = d;
    },
  });
  const asTransport = (pc: object): HasPc => ({ pc: pc as RTCPeerConnection });
  vi.stubGlobal("document", metaDocument("817"));

  expect(offerId(offerA)).toMatch(/^[0-9a-f]{8}$/);
  expect(offerId(offerA), "fresh ufrag+fingerprint, fresh id").not.toBe(offerId(offerB));
  const inviteA = await encodeCode({ b: 817, k: "offer", p: null, s: offerA });
  const answer = await acceptInvite(asTransport(guestPc()), inviteA, { team: 1 });
  expect(answer.ok).toBe(true);
  if (!answer.ok) return;
  const decoded = await decodeCode(answer.code);
  expect(decoded.ok && decoded.payload.o, "the answer names offer A").toBe(offerId(offerA));

  const stale = await acceptAnswer(asTransport(hostPc(offerB)), answer.code);
  expect(stale.ok).toBe(false);
  if (stale.ok) return;
  expect(stale.error).toBe("wrong_offer");
  expect(stale.message).toMatch(/older invite/i);

  const pcA = hostPc(offerA);
  expect((await acceptAnswer(asTransport(pcA), answer.code)).ok, "the right offer takes it").toBe(true);
  expect(pcA.took?.type).toBe("answer");
  // A repost of the same answer against the same, now-answered offer is "already used", not "older invite".
  const again = await acceptAnswer(asTransport(pcA), answer.code);
  expect(!again.ok && again.error).toBe("already_answered");

  // The OLD format (no `o`) still decodes and is judged as before.
  const legacy: CodePayload = { b: 817, k: "answer", p: null, s: sdp("gggg", fp(7), "active") };
  const legacyCode = await encodeCode(legacy);
  expect((await acceptAnswer(asTransport(hostPc(offerB)), legacyCode)).ok, "an id-less answer is accepted").toBe(true);
});

// f1-game js/core/hash32.js:5-13 is FNV-1a 32; offerId depends on it hashing
// exactly as f1-game does, so pin the published test vectors.
test("fnv1a is 32-bit FNV-1a, as f1-game's Hash32.fnv1a", () => {
  expect(fnv1a("")).toBe(0x811c9dc5);
  expect(fnv1a("a")).toBe(0xe40c292c);
  expect(fnv1a("foobar")).toBe(0xbf9cf968);
});
