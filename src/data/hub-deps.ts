/**
 * The seam between the Data Hub shell (./hub.ts) and its tabs (./tabs/*).
 * Mirrors the deps object f1-game's DataHub passes to each tab's create()
 * (js/data/hub.js:526-667). Each tab module exports
 * `mount(el, deps): MountedTab` and its f1-game `create(deps)`.
 */
import type { F1Api, Key, Session } from "./api";
import type { Rgb, Team } from "./teams";

/** The shared session selection RESULTS, LIVE, TELEMETRY and RACE drive (hub.js:419). */
export interface HubSelection {
  year: number | null;
  meetingKey: Key | null;
  sessionKey: Key | null;
  meta: Session | null;
  selAt: number;
  pinned: boolean;
}

/** What a tab load may record on its node for the hub's tab state (hub.js:418, 642-647: `node.tabOutcome`). */
export interface TabOutcome {
  status?: "loading" | "ready" | "empty" | "failed";
  error?: unknown;
  at?: number;
  dataAt?: number | null;
  offlineCopy?: boolean;
  /** false: the node carries no data worth a footnote (hub.js:253-260). */
  hasData?: boolean;
}
export type TabNode = HTMLElement & { tabOutcome?: TabOutcome };

export interface HubDeps {
  api: F1Api;
  el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: unknown): HTMLElementTagNameMap[K];
  clear(node: Node): void;
  emptyMsg(text: string): HTMLElement;
  spinner(): HTMLElement;
  fmtDateTime(iso: string | null | undefined): string;
  sel: HubSelection;
  ensureSession(force?: boolean): Promise<Session | null>;
  /** onPick(session) after an explicit pick; onChange runs first on a year/GP change. */
  buildPicker(onPick: (meta: Session | null) => void, onChange?: () => void): HTMLElement;
  invalidateOther(except: string): void;
  findTeam(apiName: string | null | undefined): Team | null;
  cssColor(c: Rgb | null | undefined): string;
  textColorOn(c: Rgb | null | undefined): string;
  teamChip(code: string | null | undefined, teamName: string | null | undefined): HTMLElement;
  compoundChipLabel(compound: string | null | undefined): string;
  /** Tyre compound colors (hub.js:34-37). */
  COMPOUND: Readonly<Record<string, string>>;
  close(): void;
  isOpen(): boolean;
  /** Is reduced motion asked for (OS flag or html[data-motion=reduce]) (hub.js:12-18). */
  motionReduced(): boolean;
  /** Called by RESULTS when its picker settles a new outcome on `node` (hub.js:642-647). */
  onOutcome?(node: TabNode): void;
  NO_LIVE_MSG: string;
  NO_TELEM_MSG: string;
  NO_RESULT_MSG: string;
}

/** A tab mounted into a host element by `mount(el, deps)`. */
export interface MountedTab {
  /** Re-run the tab's load into the host element. */
  refresh(): Promise<void>;
  /** Stop timers / polls and detach. */
  unmount(): void;
}
