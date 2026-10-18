/**
 * RACE A FRIEND: the VS FRIEND screen as a plain-DOM module.
 * Port of the screen half of f1-game js/net/lobby.js (NetLobby: show :100-105,
 * renderRoom :1214-1272, verifyRow/hostRemoveRow :1274-1301, wire :2152-2265,
 * openFromUrl :2267-2341), js/net/lobby-codes.js (codeFrom :36-96, paste/copy/
 * share/QR helpers) and js/net/lobby-roster.js (the seat row). The connection
 * logic is src/net/room.ts; this file only paints it and forwards clicks.
 *
 * What a player sees: HOST A RACE makes an invite (QR, SHARE LINK, COPY CODE);
 * JOIN A FRIEND takes it (paste, or SCAN the answer QR). Room codes skip the
 * paste: NEW CODE shows a short code; a friend types it under ENTER CODE. The
 * host invites guests one at a time with INVITE ANOTHER, up to ROOM FULL
 * (4 PLAYERS). Each connected row shows its 4-letter verification code.
 *
 * The shell lane adds the menu entry and calls `mount(el, deps)`; nothing here
 * touches src/main.ts.
 */
import { inviteFromUrl, consumeInviteUrl, MAGIC } from "./handshake";
import { draw as drawQr } from "./qr";
import { create as createScanner, supported as scanSupported, type Scanner } from "./scan";
import { createRoom, MAX_GUESTS, type Room, type RoomDeps, type RoomPeer, type RoomState } from "./room";

export interface LobbyDeps extends Omit<RoomDeps, "onChange" | "say"> {
  /** A one-line label for a peer profile (team + driver). Default: "Player". */
  describe?(profile: Record<string, unknown> | null): string;
  /** The page's URL, for a boot-time `#vs=` invite. Default: location.href. */
  readonly href?: string;
}

export interface MountedLobby {
  readonly room: Room;
  /** Remove the DOM, stop the camera and close every pending connection. */
  unmount(): void;
}

// ─── pasted-code recovery (lobby-codes.js:9-96, verbatim) ─────────────────────────────

const CODE_CHARS = /^[A-Za-z0-9_-]+$/;
const FRAGMENT_MIN = 20;
const LEAD_JUNK = /^[^A-Za-z0-9_.-]+/;
const TAIL_JUNK = /[^A-Za-z0-9_-]+$/;
const INVISIBLE = /[​-‍⁠﻿­]/g;

/** MAGIC.mode with no body: a wrap broke after the separator; put it back. */
function restoreModeSep(c: string): string {
  const p = String(c || "").split(".");
  if (p.length === 2 && p[0] === MAGIC && /^[szp]$/.test(p[1] as string)) return c + ".";
  return c;
}

/**
 * THE CODE OUT OF WHATEVER WAS PASTED: a link gives up its fragment, and a
 * code wrapped in the sender's words or a hard mail wrap is re-joined from
 * the token that starts with the magic plus following code-charset fragments.
 */
export function codeFrom(text: string, keepShortTail = false): string {
  const raw = String(text || "").replace(INVISIBLE, "").trim();
  if (!raw) return "";
  const tokens = raw.split(/\s+/);
  const magic = MAGIC + ".";
  let at = -1;
  let code = "";
  let opened = false;
  let ended = false;
  for (let i = 0; i < tokens.length && at < 0; i++) {
    const tok = tokens[i] as string;
    const lifted = inviteFromUrl(tok);
    if (lifted) {
      at = i;
      code = restoreModeSep(lifted);
      continue;
    }
    // A BARE code gets the link's punctuation rule too.
    const lead = tok.replace(LEAD_JUNK, "");
    if (!lead.startsWith(magic)) continue;
    at = i;
    opened = lead !== tok;
    const stripped = lead.replace(TAIL_JUNK, "");
    ended = stripped !== lead;
    if (ended && restoreModeSep(stripped) !== stripped) {
      code = restoreModeSep(stripped);
      ended = false; // separator, not a sentence end
    } else code = stripped;
  }
  if (at < 0) return raw; // peekCode says "not an invite code"
  let long = false;
  for (let i = at + 1; i < tokens.length && !ended; i++) {
    // Punctuation after a fragment ends the code there.
    const t = (tokens[i] as string).replace(TAIL_JUNK, "");
    ended = t !== tokens[i];
    if (!t || !CODE_CHARS.test(t)) break;
    if (t.length >= FRAGMENT_MIN) {
      code += t;
      long = true;
      continue;
    }
    // A short crumb is usually English; keep it when a later long fragment follows.
    let more = false;
    if (!ended) {
      for (let j = i + 1; j < tokens.length; j++) {
        const n = (tokens[j] as string).replace(TAIL_JUNK, "");
        if (!n || !CODE_CHARS.test(n)) break;
        if (n.length >= FRAGMENT_MIN) {
          more = true;
          break;
        }
      }
    }
    if (more) {
      code += t;
      continue;
    }
    // Final short tail after a long fragment: base64url-ish crumbs and bracketed closers only.
    if (keepShortTail || (long && i === tokens.length - 1 && (!ended || opened) && (opened || /[0-9_-]/.test(t) || t.length >= 10))) {
      code += t;
    }
    break;
  }
  // Nothing joined after a restored separator: hand MAGIC.mode back without the dot.
  if (/^[A-Za-z0-9]+\.[szp]\.$/.test(code)) code = code.slice(0, -1);
  return code;
}

// ─── DOM helpers (lobby-roster.js) ──────────────────────────────────────────

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, string>> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "text") el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids) el.append(kid);
  return el;
}

const canShare = (): boolean => typeof navigator !== "undefined" && typeof navigator.share === "function";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function mount(el: HTMLElement, deps: LobbyDeps): MountedLobby {
  const root = h("section", { class: "a26-vs", id: "vsfriend", "aria-label": "Race a friend" });
  const status = h("p", { class: "a26-vs-status", id: "vs-status", role: "status", "aria-live": "polite" });

  // Steps (lobby.js:100-105): exactly one is visible.
  const pick = h("div", { class: "a26-vs-step", id: "vs-pick" });
  const hosting = h("div", { class: "a26-vs-step", id: "vs-hosting" });
  const joining = h("div", { class: "a26-vs-step", id: "vs-joining" });
  const code = h("div", { class: "a26-vs-step", id: "vs-code" });
  const roomEl = h("div", { class: "a26-vs-step", id: "vs-room" });
  const steps = { pick, hosting, joining, code, room: roomEl } as const;

  let scanner: Scanner | null = null;
  const stopScan = (): void => {
    if (scanner) scanner.stop();
    scanner = null;
    scanVideo.hidden = true;
  };

  const room = createRoom({
    ...deps,
    onChange: (st) => render(st),
    say: (msg, isError) => {
      if (status.textContent !== msg) status.textContent = msg;
      status.classList.toggle("a26-vs-error", isError);
    },
    onGo: (handoff) => {
      stopScan();
      deps.onGo(handoff);
    },
  });

  // ── pick ──
  const btnHost = h("button", { type: "button", id: "vs-host", text: "HOST A RACE" });
  const btnJoin = h("button", { type: "button", id: "vs-join", text: "JOIN A FRIEND" });
  const btnCodeHost = h("button", { type: "button", id: "vs-code-host", text: "NEW CODE" });
  const btnCodeJoin = h("button", { type: "button", id: "vs-code-join", text: "ENTER CODE" });
  pick.append(h("h2", { text: "RACE A FRIEND" }), btnHost, btnJoin, h("p", { class: "a26-vs-hint", text: "Or use a short room code:" }), btnCodeHost, btnCodeJoin);

  // ── hosting: invite out, answer in ──
  const qr = h("canvas", { id: "vs-qr", class: "a26-vs-qr", "aria-label": "Invite QR code" });
  const btnShare = h("button", { type: "button", id: "vs-share", text: "SHARE LINK" });
  const btnCopy = h("button", { type: "button", id: "vs-copy", text: "COPY CODE" });
  const inviteOut = h("textarea", { id: "vs-invite", readonly: "", rows: "3", "aria-label": "Your invite code" });
  const answerIn = h("textarea", { id: "vs-answer-in", rows: "3", placeholder: "Paste your friend's answer", "aria-label": "Friend's answer" });
  const btnAnswer = h("button", { type: "button", id: "vs-answer-go", text: "CONNECT" });
  const btnScan = h("button", { type: "button", id: "vs-scan", text: "SCAN ANSWER" });
  const scanVideo = h("video", { id: "vs-scan-video", playsinline: "", muted: "" });
  scanVideo.hidden = true;
  hosting.append(h("h2", { text: "HOST A RACE" }), qr, btnShare, btnCopy, inviteOut, answerIn, btnAnswer, btnScan, scanVideo);

  // ── joining: invite in, answer out ──
  const inviteIn = h("textarea", { id: "vs-invite-in", rows: "3", placeholder: "Paste the invite", "aria-label": "Invite code" });
  const btnJoinGo = h("button", { type: "button", id: "vs-join-go", text: "JOIN" });
  const answerQr = h("canvas", { id: "vs-answer-qr", class: "a26-vs-qr", "aria-label": "Answer QR code" });
  const answerOut = h("textarea", { id: "vs-answer", readonly: "", rows: "3", "aria-label": "Your answer code" });
  const btnCopyAnswer = h("button", { type: "button", id: "vs-copy-answer", text: "COPY ANSWER" });
  joining.append(h("h2", { text: "JOIN A FRIEND" }), inviteIn, btnJoinGo, answerQr, answerOut, btnCopyAnswer);

  // ── room code ──
  const codeValue = h("output", { id: "vs-code-value", class: "a26-vs-code" });
  const btnCodeShare = h("button", { type: "button", id: "vs-code-share", text: "SHARE" });
  const btnCodeCopy = h("button", { type: "button", id: "vs-code-copy", text: "COPY" });
  const codeIn = h("input", { id: "vs-code-in", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", "aria-label": "Room code" });
  const btnCodeGo = h("button", { type: "button", id: "vs-code-go", text: "JOIN" });
  const codeShow = h("div", { id: "vs-code-show" }, codeValue, btnCodeShare, btnCodeCopy);
  const codeInput = h("div", { id: "vs-code-input" }, codeIn, btnCodeGo);
  code.append(h("h2", { text: "ROOM CODE" }), codeShow, codeInput);

  // ── room ──
  const roster = h("ul", { id: "vs-roster", class: "a26-vs-roster" });
  const playerCount = h("p", { id: "vs-player-count" });
  const btnReady = h("button", { type: "button", id: "vs-ready", "aria-pressed": "false", text: "READY" });
  const btnStart = h("button", { type: "button", id: "vs-start", text: "START" });
  const btnInviteMore = h("button", { type: "button", id: "vs-invite-more", text: "INVITE ANOTHER" });
  roomEl.append(h("h2", { text: "WAITING ROOM" }), playerCount, roster, btnReady, btnStart, btnInviteMore);

  const btnBack = h("button", { type: "button", id: "vs-back", text: "BACK" });
  root.append(pick, hosting, joining, code, roomEl, status, btnBack);
  el.append(root);

  // One codeShow/codeInput split per mode.
  let codeMode: "host" | "join" = "host";
  let lastInviteQr: string | null = null;
  let lastAnswerQr: string | null = null;

  function rosterRow(p: RoomPeer, isHost: boolean): HTMLLIElement {
    const li = h("li", { class: "a26-vs-seat", "data-peer": p.id });
    const dot = h("span", { class: "a26-vs-dot" + (p.ready ? " on" : ""), role: "img", "aria-label": p.ready ? "Ready" : "Not ready" });
    const who = h("span", { class: "a26-vs-who", text: deps.describe ? deps.describe(p.profile) : p.profile ? "Player" : "Choosing…" });
    li.append(dot, who);
    // The verification code: both screens must show the same four letters.
    if (p.verify) li.append(h("span", { class: "a26-vs-verify", title: "Both screens should show this code", text: p.verify }));
    if (isHost) {
      const rm = h("button", { type: "button", class: "a26-vs-remove", "aria-label": "Remove this player", text: "REMOVE" });
      rm.addEventListener("click", () => room.removeGuest(p.id));
      li.append(rm);
    }
    return li;
  }

  function render(st: RoomState): void {
    const visible = st.step === "racing" ? null : st.step;
    for (const [k, node] of Object.entries(steps)) node.hidden = k !== visible;
    root.hidden = st.step === "racing";

    if (st.invite && st.invite.url !== lastInviteQr) {
      lastInviteQr = st.invite.url;
      // The QR holds the LINK, so a phone camera app opens the lobby with the code filled in.
      drawQr(qr, st.invite.url || st.invite.code);
    }
    qr.hidden = !st.invite;
    inviteOut.value = st.invite ? st.invite.code : "";
    btnShare.hidden = !st.invite || !canShare();
    btnScan.hidden = !scanSupported();

    if (st.answer && st.answer !== lastAnswerQr) {
      lastAnswerQr = st.answer;
      drawQr(answerQr, st.answer);
    }
    answerQr.hidden = !st.answer;
    answerOut.hidden = btnCopyAnswer.hidden = !st.answer;
    answerOut.value = st.answer || "";

    codeShow.hidden = codeMode !== "host" || !st.roomCode;
    codeInput.hidden = codeMode !== "join";
    codeValue.textContent = st.roomCode || "";
    btnCodeShare.hidden = !canShare();

    roster.replaceChildren(h("li", { class: "a26-vs-seat a26-vs-you" }, h("span", { class: "a26-vs-dot" + (st.selfReady ? " on" : "") }), h("span", { class: "a26-vs-who", text: "You" })));
    for (const p of st.peers) roster.append(rosterRow(p, st.role === "host"));
    const n = st.peers.length + 1;
    playerCount.textContent = n + (n === 1 ? " player" : " players");
    btnReady.textContent = st.selfReady ? "NOT READY" : "READY";
    btnReady.setAttribute("aria-pressed", String(st.selfReady));
    btnStart.hidden = st.role !== "host";
    btnStart.toggleAttribute("disabled", !st.canStart);
    btnInviteMore.hidden = st.role !== "host";
    btnInviteMore.toggleAttribute("disabled", st.full);
    btnInviteMore.textContent = st.full ? "ROOM FULL (" + (MAX_GUESTS + 1) + " PLAYERS)" : "INVITE ANOTHER";
  }

  const on = (b: HTMLElement, fn: () => unknown): void => b.addEventListener("click", () => void fn());
  on(btnHost, () => room.host());
  on(btnJoin, () => {
    room.cancel();
    for (const [k, node] of Object.entries(steps)) node.hidden = k !== "joining";
    inviteIn.focus();
  });
  on(btnJoinGo, () => room.join(codeFrom(inviteIn.value)));
  on(btnAnswer, () => room.acceptAnswer(codeFrom(answerIn.value)));
  on(btnShare, async () => {
    const st = room.state();
    if (st.invite && st.invite.url) {
      try {
        await navigator.share({ title: "Race me in Apex 26", url: st.invite.url });
      } catch {
        /* the player closed the sheet */
      }
    }
  });
  on(btnCopy, async () => {
    const st = room.state();
    if (st.invite) status.textContent = (await copyText(st.invite.url || st.invite.code)) ? "Copied." : "Copy failed — select the code and copy it.";
  });
  on(btnCopyAnswer, async () => {
    const st = room.state();
    if (st.answer) status.textContent = (await copyText(st.answer)) ? "Copied." : "Copy failed — select the answer and copy it.";
  });
  on(btnScan, async () => {
    stopScan();
    scanner = createScanner();
    scanVideo.hidden = false;
    const res = await scanner.start(scanVideo, (text) => {
      stopScan();
      answerIn.value = text;
      void room.acceptAnswer(codeFrom(text));
    });
    if (!res.ok) {
      stopScan();
      if (res.error !== "cancelled") status.textContent = res.message;
    }
  });
  on(btnCodeHost, () => {
    codeMode = "host";
    return room.codeHost();
  });
  on(btnCodeJoin, () => {
    room.cancel();
    codeMode = "join";
    for (const [k, node] of Object.entries(steps)) node.hidden = k !== "code";
    render(room.state());
    for (const [k, node] of Object.entries(steps)) node.hidden = k !== "code";
    codeIn.focus();
  });
  on(btnCodeGo, () => room.codeJoin(codeIn.value));
  codeIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void room.codeJoin(codeIn.value);
  });
  on(btnCodeShare, async () => {
    const c = room.state().roomCode;
    if (c) {
      try {
        await navigator.share({ title: "Race me in Apex 26", text: "Room code: " + c });
      } catch {
        /* closed */
      }
    }
  });
  on(btnCodeCopy, async () => {
    const c = room.state().roomCode;
    if (c) status.textContent = (await copyText(c)) ? "Copied." : "Copy failed.";
  });
  on(btnReady, () => room.setReady(!room.state().selfReady));
  on(btnStart, () => room.start());
  on(btnInviteMore, () => (room.state().roomCode ? room.codeHost() : room.inviteAnother()));
  on(btnBack, () => {
    stopScan();
    room.cancel();
  });
  // A camera outliving its screen is a privacy bug nothing on screen reveals.
  const onHide = (): void => {
    if (document.hidden) stopScan();
  };
  document.addEventListener("visibilitychange", onHide);

  render(room.state());

  // A boot-time invite link (#vs=CODE) opens the join step with it filled in.
  const fromUrl = inviteFromUrl(deps.href ?? null);
  if (fromUrl) {
    inviteIn.value = fromUrl;
    consumeInviteUrl();
    void room.join(fromUrl);
  }

  return {
    room,
    unmount() {
      stopScan();
      document.removeEventListener("visibilitychange", onHide);
      if (room.state().step !== "racing") room.cancel();
      root.remove();
    },
  };
}
