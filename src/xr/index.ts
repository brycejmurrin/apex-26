// The XR entry the shell lazy-loads (`if (await wantXrBundle()) await import("./xr")`):
// wires XrOpts, ApexXr, XrSession, XrBoot and XrUi the way f1-game's script order did
// (js/xr/xr-plan.js, xr-opts.js, apex-xr.js, xr-input.js, xr-rig.js, xr-session.js,
// xr-boot.js, xr-ui.js, each a global there; explicit instances here).
import { ApexXr, type ApexXrDeps } from "./apex-xr";
import { XrBoot, type XrBootDeps } from "./boot";
import type { XrRemoteInput } from "./input";
import { XrOpts } from "./opts";
import { XrSession, type XrLog } from "./session";
import type { StorageSource } from "./store";
import { createThreeXrGfx, type ThreeXrGfx, type XrRenderHost } from "./three-binding";
import { XrUi } from "./ui";

export * from "./apex-xr";
export * from "./boot";
export * from "./input";
export * from "./opts";
export * from "./plan";
export * from "./rig";
export * from "./session";
export * from "./three-binding";
export * from "./types";
export * from "./ui";
export { KEY_XR_CAPS, KEY_XR_PENDING, KEY_XR_PREV_PIN, SS_XR_FALLBACK, type StorageLike, type StorageSource } from "./store";

export interface XrStackDeps {
  storage?: StorageSource;
  session?: StorageSource;
  /** The game's remote input lane. TODO(lane-shell): src/input. */
  input?: () => XrRemoteInput | null | undefined;
  /** A navigable menu is open. TODO(lane-shell). */
  menuOpen?: () => boolean;
  log?: XrLog;
  doc?: Document;
  nav?: XrBootDeps["nav"];
  /** Extra ApexXr deps (probes; the bound backend). */
  apex?: Omit<ApexXrDeps, "opts" | "storage" | "session" | "xrSession" | "canAttach" | "log">;
}

export interface XrStack {
  opts: XrOpts;
  apex: ApexXr;
  session: XrSession;
  boot: XrBoot;
  ui: XrUi;
  /** The three gfx for boot.bind({ gfx }) on a renderer host (TrackRenderer). */
  threeGfx(host: XrRenderHost): ThreeXrGfx;
}

/** One XR stack for the page. */
export function createXrStack(deps: XrStackDeps = {}): XrStack {
  let apexRef: ApexXr | null = null;
  const storage = deps.storage;
  const opts = new XrOpts({
    ...(storage ? { storage } : {}),
    onChange: () => apexRef?.invalidate(),
    releaseXrInput: () => session.releaseInput(),
    capsVr: () => !!apexRef?.caps().vr,
  });
  const session: XrSession = new XrSession({
    backendPref: () => opts.xrBackend(),
    inputMode: () => opts.xrInput(),
    ...(deps.input ? { input: deps.input } : {}),
    ...(deps.menuOpen ? { menuOpen: deps.menuOpen } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
  const boot = new XrBoot({ session, ...(storage ? { storage } : {}), ...(deps.nav ? { nav: deps.nav } : {}) });
  const apex = new ApexXr({
    ...deps.apex,
    opts,
    xrSession: session,
    canAttach: () => boot.canAttach(),
    ...(storage ? { storage } : {}),
    ...(deps.session ? { session: deps.session } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
  apexRef = apex;
  const ui = new XrUi({ session, boot, ...(deps.doc ? { doc: deps.doc } : {}) });
  return {
    opts,
    apex,
    session,
    boot,
    ui,
    threeGfx: (host) =>
      createThreeXrGfx(host, session, {
        preferWebgpu: () => opts.xrBackend() === "webgpu",
        onFallback: (from, to, reason) => apex.noteFallback(from, to, reason),
      }),
  };
}
