// @vitest-environment happy-dom
/**
 * src/xr/boot.ts (XrBoot, wantXrBundle) and src/xr/ui.ts (XrUi). Ported from f1-game
 * tests/unit/xr-phase0.test.mjs (XrBoot facade, B3 ensureXrBackend, B4 afterTick
 * dedupe, B5 cockpit override, XrUi.mount, the four mountUi bundle-probe tests),
 * tests/unit/xr-backend-pin.test.mjs and tests/unit/xr-visibility-pause.test.mjs.
 *
 * Adapted, not verbatim: f1-game's ENTER VR switch pinned localStorage
 * apex26.gfxBackend=three + tlxForceGL=1; apex-26's renderer pin is the `?gl=1` query
 * (src/render/policy.ts), so the backend-pin tests assert the URL and a26.xrPrevPin.
 * The bundle-probe tests call wantXrBundle() (the shell dynamic-imports src/xr)
 * instead of counting ScriptLoader fetches.
 */
import { describe, expect, it } from "vitest";
import { probeVr, wantXrBundle, XrBoot, type XrBootApi, type XrPageNav } from "../../src/xr/boot";
import { XrSession } from "../../src/xr/session";
import type { XrSystemLike } from "../../src/xr/types";
import { XrUi } from "../../src/xr/ui";
import { createFakeSession, MemStorage, rigidTransform, type FakeSession } from "./xr-harness";

class FakeNav implements XrPageNav {
  loads: string[] = [];
  replaces: string[] = [];
  constructor(public current = "") {}
  search(): string { return this.current; }
  load(search: string): void { this.loads.push(search); this.current = search; }
  replace(search: string): void { this.replaces.push(search); this.current = search; }
}

function api(over: Partial<XrBootApi> = {}): XrBootApi {
  return {
    gfx: { xrCapable: () => true, attachXrSession: async () => ({}) },
    tickBody: () => {},
    windowTick: () => {},
    getCamMode: () => 0,
    setCamMode: () => {},
    ...over,
  };
}

function makeBoot(opts: { store?: MemStorage; nav?: FakeNav; raf?: (cb: (t: number) => void) => number } = {}) {
  const session = new XrSession({ xr: () => null });
  const boot = new XrBoot({
    session,
    storage: () => opts.store ?? new MemStorage(),
    nav: opts.nav ?? new FakeNav(),
    raf: opts.raf ?? (() => 1),
    cancelRaf: () => {},
  });
  return { session, boot };
}

describe("XrBoot facade (xr-phase0.test.mjs)", () => {
  it("comfort off until presenting; applyEyes null outside XR", () => {
    const { boot } = makeBoot();
    expect(boot.comfort()).toBe(false);
    expect(boot.loopByXr()).toBe(false);
    expect(boot.camComfort(false)).toBe(false);
    expect(boot.camComfort(true)).toBe(true);
    expect(boot.applyEyes({}, [0, 1, 0], [0, 1, 1], [0, 1, 0])).toBeNull();
    expect(boot.canAttach()).toBe(false);
    expect(boot.isBound()).toBe(false);
  });

  it("B4: afterTick dedupes window rAF so EXIT VR cannot double-loop", () => {
    const rafCalls: Array<(t: number) => void> = [];
    const { boot } = makeBoot({ raf: (fn) => { rafCalls.push(fn); return rafCalls.length; } });
    let ticks = 0;
    const tick = (): void => { ticks++; };
    boot.bind(api({ windowTick: tick }));
    expect(boot.isBound()).toBe(true);
    expect(boot.afterTick(tick)).toBe(true);
    expect(boot.afterTick(tick)).toBe(false);
    expect(rafCalls.length).toBe(1);
    (rafCalls[0] as (t: number) => void)(0);
    expect(ticks).toBe(1);
    expect(boot.chainWindowRaf(tick)).toBe(true);
    expect(boot.chainWindowRaf(tick)).toBe(false);
    expect(rafCalls.length).toBe(2);
  });

  it("B5: the VR cockpit camera override does not persist; restore returns to the saved mode", () => {
    const { boot } = makeBoot();
    let cam = 1;
    const store: number[] = [];
    boot.bind(api({
      camModes: [{ id: "chase" }, { id: "far" }, { id: "drift" }, { id: "cockpit" }],
      getCamMode: () => cam,
      setCamMode: (i, o) => { cam = i; if (!(o && o.persist === false)) store.push(i); },
    }));
    boot.saveAndForceCockpit();
    expect(cam).toBe(3);
    expect(store.length).toBe(0);
    expect(boot.diag().savedCam).toBe(1);
    boot.restoreSavedCam();
    expect(cam).toBe(1);
    expect(store.length).toBe(0);
    expect(boot.diag().savedCam).toBe(-1);
  });

  it("a second bind is ignored (f1-game bindInner runs once)", () => {
    const { boot } = makeBoot();
    boot.bind(api({ gfx: { xrCapable: () => false, attachXrSession: async () => ({}) } }));
    boot.bind(api());
    expect(boot.canAttach()).toBe(false);
  });
});

describe("ENTER VR backend switch (B3, xr-backend-pin.test.mjs)", () => {
  it("B3: unbound -> pin ?gl=1 + pending enter + one reload; attachable -> no-op", () => {
    const store = new MemStorage();
    const nav = new FakeNav("?track=monza");
    const { boot } = makeBoot({ store, nav });
    const r = boot.ensureXrBackend();
    expect(r).toEqual({ ok: false, reloading: true });
    expect(nav.loads).toEqual(["?track=monza&gl=1"]);
    expect(store.getItem("a26.xrEnterPending")).toBe("1");
    expect(JSON.parse(store.getItem("a26.xrPrevPin") as string)).toEqual({ gl: null });
    boot.bind(api());
    expect(boot.canAttach()).toBe(true);
    expect(boot.ensureXrBackend().ok).toBe(true);
    expect(nav.loads.length).toBe(1);
  });

  it("refuses with a message only when storage is blocked", () => {
    const blocked = { getItem: (): string | null => null, setItem: (): void => { throw new Error("QuotaExceeded"); } };
    const nav = new FakeNav();
    const boot = new XrBoot({ session: new XrSession({ xr: () => null }), storage: () => blocked, nav });
    expect(boot.ensureXrBackend()).toEqual({ ok: false, message: "VR needs WebGL2 (allow site storage)" });
    expect(nav.loads).toEqual([]);
  });

  for (const [label, before] of [
    ["a WebGL2-pinned player", "?gl=1"],
    ["a WebGPU-pinned player", "?gl=0&x=2"],
    ["a player on auto (no pin)", ""],
  ] as const) {
    it(`ENTER VR on ${label}: the pinned boot runs WebGL2, the next boot is the player's own pick`, () => {
      const store = new MemStorage();
      const nav = new FakeNav(before);
      const flat = makeBoot({ store, nav }).boot;
      expect(flat.ensureXrBackend()).toEqual({ ok: false, reloading: true });
      expect(new URLSearchParams(nav.current).get("gl")).toBe("1");
      flat.ensureXrBackend(); // a second click before the reload lands
      // The reloaded page: the renderer booted on ?gl=1; then the shell mounts XR.
      const vr = makeBoot({ store, nav }).boot;
      expect(vr.restorePinnedBackend()).toBe(true);
      expect(new URLSearchParams(nav.current).get("gl")).toBe(new URLSearchParams(before).get("gl"));
      expect(new URLSearchParams(nav.current).get("x")).toBe(new URLSearchParams(before).get("x"));
      expect(store.getItem("a26.xrPrevPin")).toBeNull();
      expect(store.getItem("a26.xrEnterPending")).toBe("1");
    });
  }

  it("no stash, nothing restored; a corrupt stash is dropped without touching the URL", () => {
    const store = new MemStorage();
    const nav = new FakeNav("?gl=0");
    expect(makeBoot({ store, nav }).boot.restorePinnedBackend()).toBe(false);
    store.setItem("a26.xrPrevPin", "{not json");
    expect(makeBoot({ store, nav }).boot.restorePinnedBackend()).toBe(true);
    expect(nav.current).toBe("?gl=0");
    expect(nav.replaces).toEqual([]);
    expect(store.getItem("a26.xrPrevPin")).toBeNull();
  });

  it("armed ENTER on a renderer that cannot attach uses the reversible pin instead of a dead end", async () => {
    const store = new MemStorage({ "a26.xr": "1", "a26.xrCaps": "1" });
    const nav = new FakeNav();
    const { boot, session } = makeBoot({ store, nav });
    let starts = 0;
    session.start = async () => { starts++; return null; };
    boot.bind(api({ gfx: { xrCapable: () => false, attachXrSession: async () => ({}) } }));
    const ui = new XrUi({ session, boot, setTimeout: () => 1, clearTimeout: () => {} });
    await ui.onClick();
    expect(nav.loads).toEqual(["?gl=1"]);
    expect(starts).toBe(0);
    expect(ui.ensureButton().textContent).toBe("SWITCHING…");
    boot.restorePinnedBackend();
    expect(nav.current).toBe("");
    expect(store.getItem("a26.xr")).toBe("1");
  });

  it("mountUi restores the pin, mounts, and auto-enters once after a switch reload", async () => {
    const store = new MemStorage({ "a26.xrEnterPending": "1", "a26.xrPrevPin": JSON.stringify({ gl: null }) });
    const nav = new FakeNav("?gl=1");
    const session = new XrSession({
      xr: () => ({ isSessionSupported: async () => true, requestSession: async () => createFakeSession() }),
      rigidTransform: () => rigidTransform,
    });
    const boot = new XrBoot({ session, storage: () => store, nav, raf: () => 1, cancelRaf: () => {} });
    boot.bind(api());
    let mounted = 0;
    expect(await boot.mountUi(() => mounted++)).toBe(true);
    expect(mounted).toBe(1);
    expect(nav.current).toBe("");
    expect(store.getItem("a26.xrEnterPending")).toBeNull();
    expect(session.isPresenting()).toBe(true);
    expect(boot.loopByXr()).toBe(true);
    expect(await boot.mountUi()).toBe(false); // consumed
    await session.end();
    expect(boot.loopByXr()).toBe(false);
  });
});

describe("wantXrBundle (xr-phase0.test.mjs mountUi bundle probe)", () => {
  const immediate = { setTimeout: (fn: () => void) => setImmediate(fn), clearTimeout: () => {} };
  const want = (xr: XrSystemLike | null, ls: Record<string, string> = {}) =>
    wantXrBundle({ storage: () => new MemStorage(ls), xr: () => xr, ...immediate });
  const sys = (isSessionSupported: XrSystemLike["isSessionSupported"]): XrSystemLike => ({
    ...(isSessionSupported ? { isSessionSupported } : {}),
    requestSession: () => Promise.reject(new Error("unused")),
  });

  it("a desktop browser with navigator.xr but no headset never loads the XR bundle", async () => {
    expect(await want(sys(async (m) => { expect(m).toBe("immersive-vr"); return false; }))).toBe(false);
  });

  it("a headset (isSessionSupported true) loads it", async () => {
    expect(await want(sys(async () => true))).toBe(true);
  });

  it("a probe that throws, rejects or hangs keeps the old answer (load)", async () => {
    expect(await want(sys(() => { throw new Error("SecurityError"); }))).toBe(true);
    expect(await want(sys(() => Promise.reject(new Error("x"))))).toBe(true);
    expect(await want(sys(() => new Promise<boolean>(() => {})))).toBe(true);
    expect(await want(sys(undefined))).toBe(true);
  });

  it("no navigator.xr loads nothing; an armed VR mode or a pending enter loads without probing", async () => {
    expect(await want(null)).toBe(false);
    let probed = 0;
    const xr = sys(async () => { probed++; return false; });
    expect(await want(xr, { "a26.xr": "1" })).toBe(true);
    expect(await want(xr, { "a26.xrEnterPending": "1" })).toBe(true);
    expect(await want(xr, { "apex26.xr": "1" })).toBe(false); // f1-game's key is not ours
    expect(probed).toBe(1);
  });

  it("probeVr: false without xr, null past the cap", async () => {
    expect(await probeVr(null)).toBe(false);
    expect(await probeVr(sys(() => new Promise<boolean>(() => {})), immediate)).toBeNull();
  });
});

/** xr-visibility-pause.test.mjs: the real XrSession + XrBoot over a fake XRSession. */
async function pauseHarness({ withPause = true } = {}) {
  const session = createFakeSession();
  const pauses: string[] = [], lost: number[] = [];
  const xrs = new XrSession({
    xr: () => ({ isSessionSupported: async () => true, requestSession: async () => session }),
    input: () => ({ remoteSample() {}, remoteEvent() {}, remoteLost: () => lost.push(1) }),
    rigidTransform: () => rigidTransform,
  });
  const boot = new XrBoot({ session: xrs, storage: () => new MemStorage(), raf: () => 1, cancelRaf: () => {} });
  boot.bind(api({ ...(withPause ? { pause: (why) => pauses.push(why) } : {}) }));
  expect(await xrs.start()).toBeTruthy();
  lost.length = 0;
  return { xrs, session: session as FakeSession, pauses, lost };
}

describe("headset menu pause (xr-visibility-pause.test.mjs)", () => {
  it("visible-blurred and hidden pause the race and drop the injected input; back to visible does not resume", async () => {
    const h = await pauseHarness();
    h.session.visibilityState = "visible-blurred";
    h.session.fire("visibilitychange");
    expect(h.pauses).toEqual(["xr-hidden"]);
    expect(h.lost.length).toBe(1);
    h.session.visibilityState = "hidden";
    h.session.fire("visibilitychange");
    expect(h.pauses).toEqual(["xr-hidden", "xr-hidden"]);
    h.session.visibilityState = "visible";
    h.session.fire("visibilitychange");
    expect(h.pauses.length).toBe(2);
  });

  it("the headset session ending (taken off / exit) pauses too", async () => {
    const h = await pauseHarness();
    h.session.fire("end");
    expect(h.pauses).toEqual(["xr-end"]);
    expect(h.xrs.isPresenting()).toBe(false);
  });

  it("a game that binds no pause path still drops the input and does not throw", async () => {
    const h = await pauseHarness({ withPause: false });
    h.session.visibilityState = "hidden";
    h.session.fire("visibilitychange");
    expect(h.lost.length).toBe(1);
  });

  it("reference origin reset pauses and releases input once, with listener cleanup", async () => {
    const h = await pauseHarness();
    const base = h.session.base;
    base.fireReset(null);
    expect(h.pauses).toEqual(["xr-reset"]);
    expect(h.lost.length).toBe(1);
    h.session.fire("end");
    expect(base.events.has("reset")).toBe(false);
  });
});

describe("XrUi (xr-phase0.test.mjs XrUi.mount)", () => {
  it("mount creates a hidden #xr-enter until the capability probe says yes", async () => {
    const session = new XrSession({ xr: () => ({ isSessionSupported: async () => false, requestSession: () => Promise.reject(new Error("x")) }) });
    const ui = new XrUi({ session, doc: document });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const btn = ui.mount(host);
    expect(btn.id).toBe("xr-enter");
    expect(host.children.length).toBe(1);
    expect(btn.hidden).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.hidden).toBe(true);
    ui.show(true);
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toMatch(/ENTER VR/i);
    ui.unmount();
    expect(host.children.length).toBe(0);
    host.remove();
  });

  it("a supported headset shows the button; click starts, the label flips, click again exits", async () => {
    const session = new XrSession({
      xr: () => ({ isSessionSupported: async () => true, requestSession: async () => createFakeSession() }),
      rigidTransform: () => rigidTransform,
    });
    const boot = new XrBoot({ session, storage: () => new MemStorage(), raf: () => 1, cancelRaf: () => {} });
    boot.bind(api());
    const ui = new XrUi({ session, boot, doc: document });
    const btn = ui.mount();
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.hidden).toBe(false);
    await ui.onClick();
    expect(session.isPresenting()).toBe(true);
    expect(btn.textContent).toBe("EXIT VR");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    await ui.onClick();
    expect(session.isPresenting()).toBe(false);
    expect(btn.textContent).toBe("ENTER VR");
    ui.unmount();
  });

  it("a failed start flashes the error and re-enables after the flash", async () => {
    const timers: Array<() => void> = [];
    const session = new XrSession({ xr: () => ({ isSessionSupported: async () => true, requestSession: () => Promise.reject(new Error("NotAllowedError")) }) });
    const boot = new XrBoot({ session, storage: () => new MemStorage(), raf: () => 1, cancelRaf: () => {} });
    boot.bind(api());
    const ui = new XrUi({ session, boot, doc: document, setTimeout: (fn) => timers.push(fn), clearTimeout: () => {} });
    const btn = ui.ensureButton();
    await ui.onClick();
    expect(btn.textContent).toBe("NotAllowedError");
    expect(btn.disabled).toBe(true);
    await ui.onClick(); // disabled: ignored
    timers[0]?.();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("ENTER VR");
  });
});
