/**
 * The title screen and the pause menu: the first slice of f1-game's screen
 * system (index.html:2074 `#overlay` with its `#mb-*` doors, :766
 * `#pausemenu`).
 *
 * Doors wired so far:
 * - TIME TRIAL (`#mb-tt`): the Monza time trial;
 * - RACE A FRIEND (`#mb-vs`): the net lane's lobby (src/net/lobby.ts `mount`),
 *   mounted on open and unmounted on close;
 * - DATA HUB (`#mb-data`): the data lane's hub (src/data `mountDataHub`) in
 *   `<dialog id="datahub">`.
 * The other f1-game doors (race, season, career, garage, settings, …) arrive
 * with their modes.
 *
 * Pause (`#pausemenu`, a modal `<dialog>`): RESUME, RESTART, QUIT TO MENU.
 * Escape and the pad's Start toggle it through `Input` ("pause" edge); the
 * dialog's own `cancel` is suppressed so the two never disagree.
 */
import { mountDataHub, type DataHub } from "../data";
import { mount as mountLobby, type MountedLobby } from "../net/lobby";
import type { RoomHandoff } from "../net/room";

export interface ScreenDeps {
  /** Start (or restart) the time trial. */
  startTimeTrial(): void;
  quitToMenu(): void;
  setPaused(paused: boolean): void;
  /** RACE A FRIEND: this player's lobby profile (team and driver ids). */
  profile(): Record<string, unknown>;
  /** RACE A FRIEND: the lobby handed over the sessions; start the friend race. */
  onFriendGo(handoff: RoomHandoff): void;
}

export interface Screens {
  readonly title: HTMLElement;
  readonly pause: HTMLDialogElement;
  showTitle(on: boolean): void;
  showPause(on: boolean): void;
  readonly hub: DataHub;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, attrs: Record<string, string> = {}, text = ""): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

function door(doc: Document, id: string, label: string, sub: string): HTMLButtonElement {
  const b = el(doc, "button", { id, class: "bigbtn", type: "button", "aria-label": sub ? `${label} — ${sub}` : label });
  const span = el(doc, "span", {}, label + " ");
  if (sub) span.append(el(doc, "span", { class: "mb-sub" }, sub));
  b.append(span);
  return b;
}

export function createScreens(parent: HTMLElement, deps: ScreenDeps): Screens {
  const doc = parent.ownerDocument;

  // ── title (#overlay) ────────────────────────────────────────────────────
  const title = el(doc, "div", { id: "overlay", role: "dialog", "aria-label": "Apex 26" });
  title.append(el(doc, "h1", { class: "a26-title" }, "APEX 26"));
  const doors = el(doc, "nav", { class: "a26-doors" });
  const tt = door(doc, "mb-tt", "TIME TRIAL", "YOU AGAINST THE CLOCK · MONZA");
  const vs = door(doc, "mb-vs", "RACE A FRIEND", "PRIVATE 2–4 PLAYER RACE");
  const data = door(doc, "mb-data", "DATA HUB", "SCHEDULE · STANDINGS · LIVE");
  doors.append(tt, vs, data);
  title.append(doors);
  parent.append(title);

  // ── pause (#pausemenu) ──────────────────────────────────────────────────
  const pause = el(doc, "dialog", { id: "pausemenu", class: "a26-dialog", "aria-labelledby": "dlg-pause" });
  pause.append(el(doc, "h2", { id: "dlg-pause" }, "PAUSED"));
  const resume = el(doc, "button", { id: "pm-resume", class: "bigbtn", type: "button" }, "RESUME");
  const restart = el(doc, "button", { id: "pm-restart", class: "bigbtn", type: "button" }, "RESTART");
  const quit = el(doc, "button", { id: "pm-quit", class: "bigbtn", type: "button" }, "QUIT TO MENU");
  pause.append(resume, restart, quit);
  parent.append(pause);

  // ── RACE A FRIEND (#vsfriend lives inside this dialog while open) ───────
  const friend = el(doc, "dialog", { id: "vsdialog", class: "a26-dialog", "aria-label": "Race a friend" });
  const friendBody = el(doc, "div");
  const friendClose = el(doc, "button", { id: "vs-close", class: "bigbtn alt", type: "button" }, "BACK");
  friend.append(friendBody, friendClose);
  parent.append(friend);
  let lobby: MountedLobby | null = null;
  const closeFriend = (): void => {
    lobby?.unmount();
    lobby = null;
    if (friend.open) friend.close();
  };

  // ── DATA HUB (<dialog id="datahub">) ────────────────────────────────────
  const hubEl = el(doc, "dialog", { id: "datahub" });
  hubEl.hidden = true;
  parent.append(hubEl);
  const hub = mountDataHub(hubEl, {
    blockingLayer: () => (pause.open ? pause : friend.open ? friend : null),
    helpDoorIds: ["mb-help"],
  });

  const showTitle = (on: boolean): void => { title.hidden = !on; };
  const showPause = (on: boolean): void => {
    if (on && !pause.open) pause.showModal();
    else if (!on && pause.open) pause.close();
  };

  tt.addEventListener("click", () => { showTitle(false); deps.startTimeTrial(); });
  vs.addEventListener("click", () => {
    if (!lobby) {
      lobby = mountLobby(friendBody, {
        profile: deps.profile,
        onGo: (handoff) => { closeFriend(); showTitle(false); deps.onFriendGo(handoff); },
      });
    }
    if (!friend.open) friend.showModal();
  });
  friendClose.addEventListener("click", closeFriend);
  friend.addEventListener("cancel", (e) => { e.preventDefault(); closeFriend(); });
  // The hub toggles its root's `hidden`; the shell owns the <dialog>'s modal state
  // (the "showModal seam", f1-game hub.js:153-160): open it modal when the hub opens,
  // close it when the hub hides itself, and route the dialog's Escape to hub.close().
  data.addEventListener("click", () => {
    hub.open("schedule");
    if (hub.isOpen() && !hubEl.open) hubEl.showModal();
  });
  new MutationObserver(() => { if (hubEl.hidden && hubEl.open) hubEl.close(); }).observe(hubEl, { attributes: true, attributeFilter: ["hidden"] });
  hubEl.addEventListener("cancel", (e) => { e.preventDefault(); hub.close(); });

  resume.addEventListener("click", () => deps.setPaused(false));
  restart.addEventListener("click", () => { deps.setPaused(false); deps.startTimeTrial(); });
  quit.addEventListener("click", () => { deps.quitToMenu(); showTitle(true); });
  // Escape is the Input "pause" edge, which already toggles the pause; the dialog's
  // own cancel must not close it a second time behind the app's back.
  pause.addEventListener("cancel", (e) => e.preventDefault());

  return { title, pause, showTitle, showPause, hub };
}
