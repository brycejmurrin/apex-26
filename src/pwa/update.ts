/**
 * "A newer build is live": the in-session update check and its UPDATE READY chip.
 * Port of f1-game js/ui/update-check.js:1-276 and the SHELL VERSION GUARD in
 * f1-game index.html:150-215, onto the service worker update flow.
 *
 * f1-game compared the shell's `<meta name="apex-build">` with a network-truth
 * version.json and reloaded past the HTTP cache with `?b=`. With precached,
 * content-hashed assets the shell and its scripts always come from ONE worker
 * generation, so the question becomes "is a newer worker WAITING?" — the
 * browser's byte-diff of sw.js answers it. Kept from f1-game:
 * - checks are THROTTLED (10 min) and repeated when the tab becomes visible,
 *   with a short backoff after a failed check (offline, deploy window);
 * - the chip is hidden during a race, and APPLYING an update is refused there:
 *   a reload must never end somebody's race;
 * - persistence gets a bounded flush (1.5 s) before the reload;
 * - one reload per update (a sessionStorage guard, `a26.` prefixed).
 */
import { netLog as log } from "../net/log";

export const THROTTLE_MS = 10 * 60 * 1000;
export const FAIL_BACKOFF_MS = 30 * 1000;
export const PERSIST_WAIT_MS = 1500;
export const FOLLOW_MS = 2000;
export const RELOAD_KEY = "a26.shellReloadedTo";
export const READY_CHIP = "UPDATE READY · TAP TO RELOAD";

/** The slice of ServiceWorkerContainer this module uses (a fake in tests). */
export interface SwContainer {
  readonly controller: Pick<ServiceWorker, "scriptURL"> | null;
  getRegistration(): Promise<SwRegistration | undefined>;
  addEventListener(type: "controllerchange", fn: () => void): void;
}

export interface SwWorker {
  readonly state: ServiceWorkerState;
  readonly scriptURL: string;
  postMessage(msg: unknown): void;
  addEventListener(type: "statechange", fn: () => void): void;
}

export interface SwRegistration {
  readonly waiting: SwWorker | null;
  readonly installing: SwWorker | null;
  update(): Promise<unknown>;
  addEventListener(type: "updatefound", fn: () => void): void;
}

export interface UpdateCheckOptions {
  /** True while a race runs: the chip hides and apply() refuses. */
  inRace?(): boolean;
  /** The chip element; shown while an update is ready and no race runs. */
  chip?(): HTMLElement | null;
  /** Flush saves before the reload (bounded by PERSIST_WAIT_MS). */
  persist?(): unknown;
  /** Called once per newly ready update. */
  onReady?(): void;
  readonly now?: () => number;
  readonly sw?: SwContainer | null;
  readonly reload?: () => void;
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

export interface UpdateCheck {
  /** Ask the browser to re-fetch sw.js (throttled unless forced). Resolves true when an update is ready. */
  check(force?: boolean): Promise<boolean>;
  /** Activate the waiting worker and reload, unless a race is running. */
  apply(): Promise<boolean>;
  /** True when a newer build is ready (a lazy load must not mix generations). */
  blocked(): boolean;
  onVisible(): void;
  render(): void;
  state(): { ready: boolean; lastCheck: number; checking: boolean };
  stop(): void;
}

function defaultSw(): SwContainer | null {
  try {
    return typeof navigator !== "undefined" && "serviceWorker" in navigator ? (navigator.serviceWorker as unknown as SwContainer) : null;
  } catch {
    return null;
  }
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

export function createUpdateCheck(o: UpdateCheckOptions = {}): UpdateCheck {
  const now = o.now ?? ((): number => Date.now());
  const sw = o.sw !== undefined ? o.sw : defaultSw();
  const inRace = o.inRace ?? ((): boolean => false);
  const storage = o.storage !== undefined ? o.storage : defaultStorage();
  const reload = o.reload ?? ((): void => location.reload());
  let waiting: SwWorker | null = null;
  let lastCheck = now();
  let inflight: Promise<boolean> | null = null;
  let follow: ReturnType<typeof setInterval> | null = null;
  let reloading = false;
  let watched = false;

  function render(): void {
    const el = o.chip ? o.chip() : null;
    if (!el) return;
    el.hidden = !(waiting && !inRace());
    if (!el.hidden) {
      if (!el.textContent) el.textContent = READY_CHIP;
      el.setAttribute("aria-label", "Update ready. Reload to update.");
    }
  }

  function markReady(w: SwWorker): void {
    if (waiting === w) return;
    waiting = w;
    // Re-render on a slow timer so the chip follows race start / finish.
    if (!follow && typeof setInterval === "function") follow = setInterval(render, FOLLOW_MS);
    log.info("update ready: " + w.scriptURL);
    render();
    if (o.onReady) {
      try {
        o.onReady();
      } catch {
        /* a listener bug never blocks the chip */
      }
    }
  }

  // An update is ready when a worker reaches "installed" while another one
  // already controls this page (the first install has nothing to replace).
  function watchInstalling(w: SwWorker | null): void {
    if (!w) return;
    const settle = (): void => {
      if (w.state === "installed" && sw && sw.controller) markReady(w);
    };
    w.addEventListener("statechange", settle);
    settle();
  }

  async function registration(): Promise<SwRegistration | undefined> {
    if (!sw) return undefined;
    const reg = await sw.getRegistration();
    if (reg && !watched) {
      watched = true;
      reg.addEventListener("updatefound", () => watchInstalling(reg.installing));
      sw.addEventListener("controllerchange", () => {
        // The waiting worker took over: this page's scripts are the old
        // generation, so reload once onto the new one.
        if (!reloading && waiting) {
          reloading = true;
          reload();
        }
      });
    }
    if (reg && reg.waiting && sw.controller) markReady(reg.waiting);
    if (reg) watchInstalling(reg.installing);
    return reg;
  }

  function check(force = false): Promise<boolean> {
    if (!sw) return Promise.resolve(false);
    const t = now();
    if (inflight) return inflight;
    if (!force && t - lastCheck < THROTTLE_MS) return Promise.resolve(!!waiting);
    lastCheck = t;
    inflight = registration()
      .then(async (reg) => {
        if (!reg) return false;
        await reg.update();
        await registration();
        return !!waiting;
      })
      .catch(() => {
        // Offline or mid-deploy: ask again soon.
        lastCheck = now() - THROTTLE_MS + FAIL_BACKOFF_MS;
        return false;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  async function apply(): Promise<boolean> {
    if (!waiting || inRace()) return false;
    if (o.persist) {
      const flush = o.persist;
      try {
        await Promise.race([Promise.resolve().then(() => flush()), new Promise((r) => setTimeout(r, PERSIST_WAIT_MS))]);
      } catch {
        /* a failed flush is retried by pagehide on the way out */
      }
    }
    if (inRace()) {
      render(); // a race may have started while persistence was pending
      return false;
    }
    // One reload per update: a second controllerchange for the same worker
    // must not loop.
    const key = waiting.scriptURL;
    try {
      if (storage && storage.getItem(RELOAD_KEY) === key) return false;
      if (storage) storage.setItem(RELOAD_KEY, key);
    } catch {
      /* private mode: the guard may reload once more, harmlessly */
    }
    waiting.postMessage({ type: "SKIP_WAITING" });
    return true;
  }

  function onVisible(): void {
    if (typeof document !== "undefined" && document.hidden) return;
    void check(false);
    render();
  }

  void registration().catch(() => undefined);

  return {
    check,
    apply,
    blocked: () => !!waiting,
    onVisible,
    render,
    state: () => ({ ready: !!waiting, lastCheck, checking: !!inflight }),
    stop: () => {
      if (follow) clearInterval(follow);
      follow = null;
    },
  };
}
