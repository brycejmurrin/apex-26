/**
 * The VS FRIEND room without its DOM: connections, the roster and the start.
 * Port of the connection half of f1-game js/net/lobby.js (NetLobby):
 * newTransport :207-313, waitForOpen :412-497, onConnected :535-786 (HELLO,
 * READY, SETTINGS, GO, LEFT), host/inviteAnother/join/makeAnswer/acceptAnswer
 * :1474-1672, codeHost/codeJoin :1714-2017, removeGuest :1303-1326 and
 * beginRace :1358-1394. src/net/lobby.ts paints it.
 *
 * Kept from f1-game, on purpose:
 * - INVITES ARE SEQUENTIAL: one negotiation in flight, INVITE ANOTHER once a
 *   guest lands, MAX_GUESTS = 3 (2–4 players).
 * - A guest's profile is filed under the CONNECTION it arrived on, never a
 *   `from` in the payload; a guest trusts a `from` only on a relay from the host.
 * - HELLO and READY are rate-limited per connection (five a second each).
 * - The 4-letter VERIFICATION CODE per connection (rendezvous.verifyFor).
 * - The relay must arrive before a connection is built, but never at the cost
 *   of the screen opening (readyIce: a 2.5 s race).
 *
 * Left to the caller (`RoomDeps`): what a profile is (garage, teams), the race
 * settings, and what happens on GO (the shell builds the race, then hands
 * `RoomHandoff.sessions` to NetPlay.start). Friend qualifying and seat-clash
 * resolution (lobby.js :1038-1212) are TODO(lane-net): they need the race and
 * garage lanes.
 */
import * as Handshake from "./handshake";
import { netLog } from "./log";
import * as Rendezvous from "./rendezvous";
import type { HostedRoom } from "./nostr";
import { EV } from "./netplay";
import { createSession, type NetSession } from "./session";
import { prefetchIce, rtc, supported, STORE_RELAY_ONLY, type NetEndpoint, type RtcEndpoint, type RtcOptions, type RtcStats } from "./transport";

export const MAX_GUESTS = 3;
const CONNECT_TIMEOUT_MS = 60000;
const ICE_WAIT_MS = 2500;
const HELLO_RATE = 5;
const EVENT_WINDOW_MS = 1000;
const PEER_ONE = "peer";
const PUMP_MS = 25;
/** The room-code guest gathers briefly, like f1-game's lobby (2.5 s). */
const CODE_GATHER_MS = 2500;

export type RoomRole = "host" | "guest";
export type RoomStep = "pick" | "hosting" | "joining" | "code" | "room" | "racing";

/** What a transport factory returns: an endpoint with its RTCPeerConnection. */
export type RoomTransport = NetEndpoint & { readonly pc?: RTCPeerConnection | null; stats(): object };

export interface RoomDeps {
  /** This player's profile (part IDS, never resolved multipliers). Sent as HELLO. */
  profile(): Record<string, unknown>;
  /** Refuse a malformed peer profile (unknown team or seat). Default: any object. */
  validProfile?(p: Record<string, unknown>): boolean;
  /** Host: the race settings guests must accept before READY. */
  settings?(): unknown;
  /** Guest: apply the host's settings; return false to refuse them. */
  applySettings?(d: unknown): boolean;
  /** Both: the race is starting. The caller now owns the sessions. */
  onGo(handoff: RoomHandoff): void;
  /** Re-render: the room state changed. */
  onChange?(state: RoomState): void;
  /** Status line. */
  say?(msg: string, isError: boolean): void;
  /** Injectable for tests (loopback pairs). Default: rtc(). */
  makeTransport?(opts: RtcOptions): RoomTransport | null;
  /** Handshake options (gather timeout, PC for packed-SDP checks). */
  readonly handshake?: Handshake.HandshakeOptions;
}

export interface RoomPeer {
  readonly id: string;
  readonly profile: Record<string, unknown> | null;
  readonly ready: boolean;
  readonly verify: string | null;
}

export interface RoomState {
  readonly role: RoomRole | null;
  readonly step: RoomStep;
  readonly status: string;
  readonly error: boolean;
  readonly selfReady: boolean;
  readonly peers: readonly RoomPeer[];
  readonly canStart: boolean;
  readonly full: boolean;
  /** Host: the invite on show (code, link) or the room code advertised. */
  readonly invite: { readonly code: string; readonly url: string | null } | null;
  readonly roomCode: string | null;
  /** Guest: the answer code to send back (manual path). */
  readonly answer: string | null;
  readonly settings: unknown;
}

export interface RoomHandoff {
  readonly role: RoomRole;
  readonly sessions: ReadonlyArray<{ readonly id: string; readonly session: NetSession }>;
  readonly peers: ReadonlyArray<{ readonly id: string; readonly profile: Record<string, unknown> | null }>;
  readonly settings: unknown;
  /** The race's transports stay up; close them when the race ends. */
  readonly transports: ReadonlyMap<string, RoomTransport>;
}

export type RoomResult = { readonly ok: true } | { readonly ok: false; readonly error: string; readonly message: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface Room {
  host(): Promise<RoomResult & { code?: string; url?: string | null }>;
  inviteAnother(): Promise<RoomResult & { code?: string; url?: string | null }>;
  acceptAnswer(code: string): Promise<RoomResult>;
  join(code: string): Promise<RoomResult & { answer?: string }>;
  codeHost(code?: string): Promise<RoomResult & { code?: string }>;
  codeJoin(code: string): Promise<RoomResult>;
  setReady(ready: boolean): void;
  /** Host: re-publish settings after a change; guests must READY again. */
  publishSettings(): void;
  removeGuest(id: string): void;
  start(): RoomResult;
  cancel(): void;
  state(): RoomState;
}

export function createRoom(deps: RoomDeps): Room {
  const makeTransport = deps.makeTransport ?? ((o: RtcOptions): RtcEndpoint | null => rtc(o));
  const transports = new Map<string, RoomTransport>();
  const sessions = new Map<string, NetSession>();
  const peers = new Map<string, Record<string, unknown>>();
  const ready = new Map<string, boolean>();
  const verify = new Map<string, string>();
  /** Host: guests REMOVE was pressed for; their close is ours, not a departure (lobby.js hostEvictingIds). */
  const evicting = new Set<string>();
  let pending: RoomTransport | null = null;
  let pendingId: string | null = null;
  let nextGuestId = 0;
  let role: RoomRole | null = null;
  let step: RoomStep = "pick";
  let status = "";
  let error = false;
  let selfReady = false;
  let invite: { code: string; url: string | null } | null = null;
  let answer: string | null = null;
  let roomCode: string | null = null;
  let codeRoom: HostedRoom | null = null;
  let pumpTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let settingsRevision = 0;
  let settings: unknown = null;
  let settingsAccepted = true;
  // Every user-started async flow owns one generation: a late continuation
  // must not repaint a screen the player has left (lobby.js:37-46).
  let generation = 0;
  const begin = (): number => ++generation;
  const current = (g: number): boolean => g === generation;
  const cancelled = (): RoomResult => ({ ok: false, error: "cancelled", message: "" });

  const mintGuestId = (): string => "g" + ++nextGuestId;
  const changed = (): void => {
    if (deps.onChange) deps.onChange(state());
  };
  function say(msg: string, isError = false): void {
    status = msg;
    error = isError;
    if (deps.say) deps.say(msg, isError);
    changed();
  }
  const fail = (err: string, message: string): RoomResult => {
    say(message, true);
    return { ok: false, error: err, message };
  };
  const validProfile = (p: unknown): p is Record<string, unknown> => isObj(p) && (deps.validProfile ? deps.validProfile(p) : true);

  /** THE RELAY HAS TO ARRIVE BEFORE THE CONNECTION IS BUILT — but as a race (lobby.js:146-188). */
  function readyIce(): Promise<unknown> {
    let p: Promise<unknown> | null = null;
    try {
      p = prefetchIce();
    } catch {
      p = null;
    }
    if (!p) return Promise.resolve();
    return Promise.race([p.catch(() => null), new Promise((r) => setTimeout(r, ICE_WAIT_MS))]);
  }

  function stopPoll(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function dropPending(): void {
    if (pending) stopPoll();
    if (pending && !(pendingId && transports.has(pendingId))) {
      try {
        pending.close();
      } catch {
        /* already gone */
      }
    }
    pending = null;
    pendingId = null;
  }

  function newTransport(asRole: RoomRole): RoomTransport | null {
    dropPending();
    role = asRole;
    pendingId = asRole === "host" ? mintGuestId() : PEER_ONE;
    const t = makeTransport({ role: asRole, name: asRole });
    if (!t) {
      say("This browser cannot do WebRTC, so it cannot race a friend.", true);
      return null;
    }
    pending = t;
    const id = pendingId;
    t.onClose(() => {
      const wasIn = transports.has(id) || sessions.has(id);
      transports.delete(id);
      const s = sessions.get(id);
      if (s) {
        try {
          s.close();
        } catch {
          /* already gone */
        }
      }
      sessions.delete(id);
      peers.delete(id);
      ready.delete(id);
      verify.delete(id);
      const evicted = evicting.delete(id);
      if (!wasIn) return; // never connected: waitForOpen already said why
      netLog.info("peer leave " + id);
      if (step === "racing") return; // NetPlay owns race-phase drops
      if (!transports.size) {
        stopPump();
        peers.clear();
        ready.clear();
        selfReady = false;
        // Removing the last guest keeps the host in the waiting room; removeGuest
        // already rotated the room code (lobby.js wasHostEvict).
        if (evicted && role === "host") {
          say("You removed that player. Invite someone else when you are ready.");
          return;
        }
        sealRoom();
        step = "pick";
        say(role === "guest" ? "The host left the room." : "Your friend left the room.", true);
        return;
      }
      // Guests learned of each other only through the host's relay: tell them.
      if (role === "host") {
        for (const sess of sessions.values()) {
          try {
            sess.sendEvent(EV.LEFT, { from: id });
          } catch {
            /* a dead session is its own close */
          }
        }
        if (!evicted && transports.size < MAX_GUESTS && roomCode && !codeRoom) void codeHost(roomCode, true);
      }
      say(evicted ? "You removed that player. The rest of you are still in." : "A player left. The rest of you are still in.");
    });
    return t;
  }

  /** Two failures that need OPPOSITE responses, told apart by whether we learnt our public address (lobby.js:379-410). */
  function failureMsg(st: Partial<RtcStats> | null, secs: number): string {
    const c = (st && st.candidates) || { host: 0, srflx: 0, relay: 0, mdns: 0 };
    const last = st ? " (" + st.ice + "/" + st.connection + ")" : "";
    if (!c.srflx && !c.relay) {
      return (
        "Could not connect after " + secs + "s" + last + ". This network never revealed a public address, so the other side had nothing to reach." +
        " Try again on a different network — mobile data often works where guest or office Wi-Fi does not."
      );
    }
    if (secs > 45) {
      return (
        "Could not connect after " + secs + "s" + last + ". The invite probably went stale — the addresses in a code stop working after a minute or so." +
        " Start a new invite and paste the answer back more quickly."
      );
    }
    return (
      "Could not connect after " + secs + "s" + last + ". Both sides found an address but the direct link was blocked, which means one of these networks needs a relay to get through." +
      (st && st.turn
        ? " A relay was offered and did not carry it. Racing over the same Wi-Fi works meanwhile."
        : " No relay is configured at all. Race over the same Wi-Fi, or set a26.turnApi to a credentials URL.")
    );
  }

  function waitForOpen(): void {
    stopPoll();
    const started = Date.now();
    // A TEST FLAG MUST ANNOUNCE ITSELF (lobby.js:415-427).
    let relayNote = "";
    try {
      if (typeof localStorage !== "undefined" && localStorage.getItem(STORE_RELAY_ONLY) === "true") {
        relayNote = " [RELAY-ONLY TEST MODE is on — remove localStorage " + STORE_RELAY_ONLY + " unless you are testing TURN]";
      }
    } catch {
      /* storage blocked */
    }
    say("Connecting…" + relayNote);
    const watched = pending;
    const watchedId = pendingId;
    if (!watched || !watchedId) return;
    const check = (): void => {
      if (pending !== watched && !transports.has(watchedId)) {
        stopPoll();
        return;
      }
      if (watched.status === "open") {
        stopPoll();
        onConnected(watchedId, watched);
        return;
      }
      const st = watched.stats() as Partial<RtcStats>;
      const secs = Math.round((Date.now() - started) / 1000);
      const dead = watched.status === "closed" || st.ice === "failed" || st.connection === "failed";
      if (dead || Date.now() - started > CONNECT_TIMEOUT_MS) {
        stopPoll();
        netLog.warn("connect fail " + secs + "s");
        say(failureMsg(st.candidates ? st : null, secs), true);
        // Only this attempt: a host whose SECOND invite fails keeps its first guest.
        dropPending();
        // The room code advertised the dead offer: mint a fresh one.
        if (codeRoom && transports.size < MAX_GUESTS) void codeRoom.rotate(null);
        if (sessions.size) step = "room";
        else {
          teardown();
          step = "pick";
        }
        changed();
      }
    };
    pollTimer = setInterval(check, 250);
    check();
  }

  function startPump(): void {
    if (pumpTimer) return;
    pumpTimer = setInterval(() => {
      const now = performance.now();
      for (const s of [...sessions.values()]) s.pump(now);
    }, PUMP_MS);
  }
  function stopPump(): void {
    if (pumpTimer) clearInterval(pumpTimer);
    pumpTimer = null;
  }

  const rateGate = (): (() => boolean) => {
    const times: number[] = [];
    return () => {
      const now = performance.now();
      while (times.length && now - (times[0] as number) > EVENT_WINDOW_MS) times.shift();
      if (times.length >= HELLO_RATE) return false;
      times.push(now);
      return true;
    };
  };

  function catchUpReady(sess: NetSession, exceptId: string): void {
    try {
      if (selfReady) sess.sendEvent(EV.READY, { ready: true, revision: settingsRevision });
    } catch {
      /* dead session */
    }
    for (const [k, r] of ready) {
      if (!r || k === exceptId) continue;
      try {
        sess.sendEvent(EV.READY, { ready: true, from: k, revision: settingsRevision });
      } catch {
        /* dead session */
      }
    }
  }

  function onConnected(id: string, t: RoomTransport): void {
    netLog.info("peer join " + id);
    transports.set(id, t);
    if (pending === t) {
      pending = null;
      pendingId = null;
    }
    invite = null;
    answer = null;
    const made = createSession({ transport: t });
    sessions.set(id, made);
    if (t.pc) {
      void Rendezvous.verifyFor(t.pc).then((v) => {
        if (v && transports.get(id) === t) {
          verify.set(id, v);
          say("Connected. Check both screens show code " + v + ".");
        }
      });
    }
    startPump();
    const helloGate = rateGate();
    const readyGate = rateGate();

    // The LATEST hello wins; filed under the CONNECTION (lobby.js:599-626).
    made.onEvent(EV.HELLO, (p) => {
      if (!helloGate() || !validProfile(p)) return;
      const from = p["from"];
      const who = role === "host" ? id : typeof from === "string" ? from : id;
      const { from: _f, rank: _r, ...profile } = p;
      peers.set(who, profile);
      // THE ROSTER IS RELAYED: guests have no connection to each other.
      if (role === "host") {
        const tagged = { ...profile, from: id };
        for (const [k, sess] of sessions) {
          if (k === id) continue;
          try {
            sess.sendEvent(EV.HELLO, tagged);
          } catch {
            /* a dead session must not stop the relay */
          }
        }
        // …and the new arrival needs everyone who was already here.
        for (const [k, prof] of peers) {
          if (k === id) continue;
          try {
            made.sendEvent(EV.HELLO, { ...prof, from: k });
          } catch {
            /* as above */
          }
        }
        catchUpReady(made, id);
      }
      changed();
    });
    made.onEvent(EV.SETTINGS, (d) => {
      if (role !== "guest" || !isObj(d)) return;
      const rev = Number(d["revision"]);
      const ok = deps.applySettings ? deps.applySettings(d["settings"]) : true;
      settings = d["settings"] ?? null;
      settingsRevision = Number.isInteger(rev) ? rev : 0;
      settingsAccepted = ok;
      // New rules: confirm them again.
      if (selfReady) setReady(false);
      say(ok ? "The host changed the race. Press READY when you are happy." : "These race settings are not available here.", !ok);
    });
    made.onEvent(EV.READY, (d) => {
      if (!readyGate() || !isObj(d) || typeof d["ready"] !== "boolean") return;
      const from = d["from"];
      const who = role === "host" ? id : typeof from === "string" ? from : id;
      const rev = d["revision"];
      ready.set(who, d["ready"] && (rev === settingsRevision || (settingsRevision === 0 && rev == null)));
      if (role === "host") {
        const tagged = { ready: !!ready.get(who), from: id, revision: settingsRevision };
        for (const [k, sess] of sessions) {
          if (k === id) continue;
          try {
            sess.sendEvent(EV.READY, tagged);
          } catch {
            /* dead session */
          }
        }
      }
      changed();
    });
    made.onEvent(EV.GO, (d) => {
      if (role !== "guest") return;
      const rev = isObj(d) ? d["revision"] : undefined;
      if (!settingsAccepted || (rev != null && (rev !== settingsRevision || !selfReady))) {
        say("Review the host’s race settings and press READY before starting.", true);
        return;
      }
      handOff();
    });
    // Lobby-phase LEFT: the host saying another guest's connection closed, or
    // that it removed us.
    made.onEvent(EV.LEFT, (d) => {
      if (role !== "guest" || !isObj(d)) return;
      if (d["evicted"]) {
        try {
          t.close();
        } catch {
          /* already closing */
        }
        step = "pick";
        say("The host removed you from the room.", true);
        return;
      }
      const from = d["from"];
      if (typeof from !== "string" || from === id) return;
      peers.delete(from);
      ready.delete(from);
      changed();
    });

    made.sendEvent(EV.HELLO, deps.profile());
    if (role === "host") {
      // A FRESH room publishes; a late joiner only gets the current rules, so
      // the READY of everyone already here survives (lobby.js openRoom resets
      // READY only for a fresh room).
      if (sessions.size <= 1) publishSettings();
      else made.sendEvent(EV.SETTINGS, { revision: settingsRevision, settings });
      catchUpReady(made, id);
      // The room code stays open for the next guest (one negotiation at a time).
      if (codeRoom) {
        if (transports.size < MAX_GUESTS) void codeRoom.rotate(null);
        else sealRoom();
      }
    }
    if (sessions.size <= 1) {
      selfReady = false;
      ready.clear();
    }
    step = "room";
    say(role === "host" ? "Pick the race, then start when you are all ready." : "The host is picking the race. Choose your car.");
  }

  function publishSettings(): void {
    if (role !== "host") return;
    settings = deps.settings ? deps.settings() : null;
    settingsRevision++;
    // Everyone confirms the new rules again, the host included.
    for (const k of ready.keys()) ready.set(k, false);
    selfReady = false;
    for (const s of sessions.values()) {
      try {
        s.sendEvent(EV.SETTINGS, { revision: settingsRevision, settings });
      } catch {
        /* dead session */
      }
    }
    changed();
  }

  function setReady(v: boolean): void {
    selfReady = v;
    for (const s of sessions.values()) {
      try {
        s.sendEvent(EV.READY, { ready: v, revision: settingsRevision });
      } catch {
        /* dead session */
      }
    }
    changed();
  }

  // Everyone has to be ready, and there has to BE somebody (lobby.js:240-245).
  const peersReady = (): boolean => {
    const ids = [...new Set([...peers.keys(), ...ready.keys()])];
    return ids.length > 0 && ids.every((k) => ready.get(k));
  };

  function sealRoom(): void {
    if (codeRoom) {
      try {
        codeRoom.stop();
      } catch {
        /* already stopped */
      }
    }
    codeRoom = null;
  }

  function teardown(): void {
    stopPoll();
    stopPump();
    sealRoom();
    for (const s of sessions.values()) {
      try {
        s.close();
      } catch {
        /* already gone */
      }
    }
    sessions.clear();
    for (const t of transports.values()) {
      try {
        t.close();
      } catch {
        /* already gone */
      }
    }
    transports.clear();
    if (pending) {
      try {
        pending.close();
      } catch {
        /* already gone */
      }
    }
    pending = null;
    pendingId = null;
    peers.clear();
    ready.clear();
    verify.clear();
    evicting.clear();
    nextGuestId = 0;
    selfReady = false;
    invite = null;
    answer = null;
    roomCode = null;
    settingsRevision = 0;
    settingsAccepted = true;
  }

  function handOff(): void {
    stopPump();
    stopPoll();
    sealRoom();
    dropPending();
    const handoff: RoomHandoff = {
      role: role as RoomRole,
      sessions: [...sessions.entries()].map(([id, session]) => ({ id, session })),
      peers: [...peers.entries()].map(([id, profile]) => ({ id, profile })),
      settings,
      transports: new Map(transports),
    };
    // NetPlay owns them now; the lobby keeps nothing alive behind the race.
    sessions.clear();
    step = "racing";
    changed();
    deps.onGo(handoff);
  }

  async function host(): Promise<RoomResult & { code?: string; url?: string | null }> {
    const g = begin();
    if (transports.size >= MAX_GUESTS) return fail("full", "The room is full (4 players).");
    await readyIce();
    if (!current(g)) return cancelled();
    const t = newTransport("host");
    if (!t) return { ok: false, error: "no_transport", message: status };
    step = transports.size ? "room" : "hosting";
    say("Making an invite…");
    let res: Handshake.InviteResult;
    try {
      res = await Handshake.createInvite(t, deps.profile(), deps.handshake);
    } catch {
      res = { ok: false, error: "invite_failed", message: "Could not make an invite. Try again." };
    }
    if (!current(g)) return cancelled();
    if (!res.ok) return fail(res.error, res.message);
    invite = { code: res.code, url: res.url };
    say("Send this invite to your friend, then paste their answer.");
    return { ok: true, code: res.code, url: res.url };
  }

  const inviteAnother = (): Promise<RoomResult & { code?: string; url?: string | null }> => host();

  async function acceptAnswer(code: string): Promise<RoomResult> {
    const g = begin();
    if (!pending || role !== "host") return fail("no_invite", noConnectionMsg());
    const res = await Handshake.acceptAnswer(pending, code);
    if (!current(g)) return cancelled();
    if (!res.ok) return fail(res.error, res.message);
    waitForOpen();
    return { ok: true };
  }

  function noConnectionMsg(): string {
    return supported() || deps.makeTransport ? "That attempt has ended. Tap HOST A RACE or JOIN A FRIEND to start over." : "This browser cannot do WebRTC, so it cannot race a friend.";
  }

  async function makeAnswer(code: string, gatherTimeoutMs?: number): Promise<Handshake.AcceptInviteResult> {
    const t = newTransport("guest");
    if (!t) return { ok: false, error: "no_transport", message: status };
    const opts: Handshake.HandshakeOptions = gatherTimeoutMs != null ? { ...deps.handshake, gatherTimeoutMs } : { ...deps.handshake };
    return Handshake.acceptInvite(t, code, deps.profile(), opts);
  }

  async function join(code: string): Promise<RoomResult & { answer?: string }> {
    const g = begin();
    // FORMAT FIRST, before any transport (handshake.js peekCode).
    const peek = Handshake.peekCode(code);
    if (!peek.ok) return fail(peek.error, peek.message);
    await readyIce();
    if (!current(g)) return cancelled();
    step = "joining";
    say("Reading the invite…");
    const res = await makeAnswer(code);
    if (!current(g)) return cancelled();
    if (!res.ok) {
      dropPending();
      return fail(res.error, res.message);
    }
    answer = res.code;
    if (validProfile(res.peer)) peers.set(PEER_ONE, res.peer);
    waitForOpen();
    say("Send this answer back to the host.");
    return { ok: true, answer: res.code };
  }

  /**
   * Host a room code. ONE negotiation in flight: each answer is matched to the
   * transport that minted the offer it answers (lobby.js:1714-1917).
   */
  async function codeHost(code?: string, quiet = false): Promise<RoomResult & { code?: string }> {
    const g = begin();
    if (transports.size >= MAX_GUESTS) return fail("full", "The room is full (4 players).");
    const theCode = code || Rendezvous.makeCode();
    if (!theCode) return fail("crypto", "This browser could not make a room code. Use the invite link instead.");
    await readyIce();
    if (!current(g)) return cancelled();
    role = "host";
    roomCode = theCode;
    if (!quiet) step = transports.size ? "room" : "code";
    const seen = new Set<string>();
    let minting = false;
    const mintOffer = async (): Promise<string | null> => {
      if (minting) return null;
      minting = true;
      try {
        const t = newTransport("host");
        if (!t) return null;
        const res = await Handshake.createInvite(t, deps.profile(), deps.handshake);
        return res.ok ? res.code : null;
      } catch {
        return null;
      } finally {
        minting = false;
      }
    };
    const res = await Rendezvous.hostRoom({
      code: theCode,
      mintOffer,
      onJoiner: async (_from, ans) => {
        if (seen.has(ans) || !pending) return; // a repost of an answer already taken
        seen.add(ans);
        const took = await Handshake.acceptAnswer(pending, ans);
        if (!took.ok) {
          // An answer to an older offer stays seen and silent (wrong_offer).
          if (took.error !== "wrong_offer") say(took.message, true);
          return;
        }
        waitForOpen();
      },
      onFail: (r) => {
        if (r.advisory) say(r.message, true);
        else if (r.error !== "stopped" && !transports.size) say(r.message, true);
      },
    });
    if (!current(g)) {
      if ("subscribed" in res) res.stop();
      return cancelled();
    }
    if (!res.ok) return fail(res.error, res.message);
    if ("subscribed" in res) codeRoom = res;
    if (!quiet) say("Room open. Your friend types this code under ENTER CODE.");
    else changed();
    return { ok: true, code: theCode };
  }

  async function codeJoin(code: string): Promise<RoomResult> {
    const g = begin();
    if (!Rendezvous.valid(code)) return fail("bad_code", "That code should be " + (Rendezvous.usingPrivateRelay() ? Rendezvous.PRIVATE_CODE_LEN : Rendezvous.CODE_LEN) + " characters.");
    await readyIce();
    if (!current(g)) return cancelled();
    step = "code";
    say("Looking for that room…");
    const norm = Rendezvous.normalise(code);
    const res = await Rendezvous.swap({
      code: norm,
      slot: "answer",
      want: "offer",
      reply: async (offer) => {
        if (!current(g)) return null;
        const made = await makeAnswer(offer, CODE_GATHER_MS);
        if (!made.ok) {
          say(made.message, true);
          return null;
        }
        if (validProfile(made.peer)) peers.set(PEER_ONE, made.peer);
        return made.code;
      },
      onTick: () => {
        if (current(g) && !pending) say("Looking for that room…");
      },
    });
    if (!current(g)) return cancelled();
    if (!res.ok) {
      dropPending();
      return fail(res.error, res.message);
    }
    waitForOpen();
    return { ok: true };
  }

  /** Host: REMOVE a guest whose verification code disagrees (lobby.js:1303-1326). */
  function removeGuest(id: string): void {
    if (role !== "host") return;
    const s = sessions.get(id);
    const t = transports.get(id);
    if (!t || evicting.has(id)) return; // unknown, or a second tap while LEFT is in flight
    evicting.add(id);
    try {
      if (s) s.sendEvent(EV.LEFT, { evicted: true });
    } catch {
      /* already gone */
    }
    // Give the guest a moment to read LEFT, then close our side regardless.
    setTimeout(() => {
      try {
        t.close();
      } catch {
        /* already gone */
      }
    }, 1500);
    // Never reuse the code the removed player still has.
    if (roomCode) {
      sealRoom();
      const fresh = Rendezvous.makeCode();
      if (fresh) void codeHost(fresh, true);
    }
  }

  function start(): RoomResult {
    if (role !== "host" || step !== "room") return { ok: false, error: "not_host", message: "Only the host can start the race." };
    if (!sessions.size) return fail("empty", "Nobody has joined yet.");
    if (!selfReady || !peersReady()) return fail("not_ready", "Everyone has to be READY first.");
    for (const s of sessions.values()) {
      try {
        s.sendEvent(EV.GO, { revision: settingsRevision });
      } catch {
        /* dead session */
      }
    }
    handOff();
    return { ok: true };
  }

  function cancel(): void {
    begin();
    teardown();
    role = null;
    step = "pick";
    status = "";
    error = false;
    changed();
  }

  function state(): RoomState {
    const list: RoomPeer[] = [...new Set([...peers.keys(), ...transports.keys()])].map((id) => ({
      id,
      profile: peers.get(id) ?? null,
      ready: !!ready.get(id),
      verify: verify.get(id) ?? null,
    }));
    return {
      role,
      step,
      status,
      error,
      selfReady,
      peers: list,
      canStart: role === "host" && step === "room" && sessions.size > 0 && selfReady && peersReady(),
      full: transports.size >= MAX_GUESTS,
      invite,
      roomCode,
      answer,
      settings,
    };
  }

  return {
    host,
    inviteAnother,
    acceptAnswer,
    join,
    codeHost: (code?: string) => codeHost(code),
    codeJoin,
    setReady,
    publishSettings,
    removeGuest,
    start,
    cancel,
    state,
  };
}

export { PEER_ONE };
