/* pwa-update.test.ts — src/pwa/update.ts over a fake ServiceWorkerContainer.
 * The behaviours are f1-game js/ui/update-check.js's (throttle, failure
 * backoff, never mid-race, bounded persist flush, one reload per update),
 * restated for a waiting service worker instead of a version.json number. */
import { afterEach, expect, test, vi } from "vitest";
import { createUpdateCheck, FAIL_BACKOFF_MS, PERSIST_WAIT_MS, RELOAD_KEY, THROTTLE_MS, type SwContainer, type SwRegistration, type SwWorker } from "../../src/pwa/update";

afterEach(() => {
  vi.useRealTimers();
});

class FakeWorker implements SwWorker {
  state: ServiceWorkerState = "installing";
  readonly posted: unknown[] = [];
  private readonly fns: Array<() => void> = [];
  constructor(readonly scriptURL: string) {}
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  addEventListener(_t: "statechange", fn: () => void): void {
    this.fns.push(fn);
  }
  to(s: ServiceWorkerState): void {
    this.state = s;
    for (const f of this.fns) f();
  }
}

class FakeReg implements SwRegistration {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  updates = 0;
  failNext = false;
  private readonly found: Array<() => void> = [];
  update(): Promise<unknown> {
    this.updates++;
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("offline"));
    }
    return Promise.resolve();
  }
  addEventListener(_t: "updatefound", fn: () => void): void {
    this.found.push(fn);
  }
  /** A new worker is found, installs and waits. */
  ship(url: string): FakeWorker {
    const w = new FakeWorker(url);
    this.installing = w;
    for (const f of this.found) f();
    w.to("installed");
    this.installing = null;
    this.waiting = w;
    return w;
  }
}

class FakeSw implements SwContainer {
  controller: { scriptURL: string } | null = { scriptURL: "sw.js" };
  private readonly changes: Array<() => void> = [];
  constructor(readonly reg: FakeReg) {}
  getRegistration(): Promise<SwRegistration | undefined> {
    return Promise.resolve(this.reg);
  }
  addEventListener(_t: "controllerchange", fn: () => void): void {
    this.changes.push(fn);
  }
  change(): void {
    for (const f of this.changes) f();
  }
}

function memStorage(): Pick<Storage, "getItem" | "setItem"> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function chipEl(): { hidden: boolean; textContent: string; setAttribute(n: string, v: string): void } {
  return { hidden: true, textContent: "", setAttribute() {} };
}

test("the first install is not an update: nothing to replace, no chip", async () => {
  const reg = new FakeReg();
  const sw = new FakeSw(reg);
  sw.controller = null;
  const chip = chipEl();
  const u = createUpdateCheck({ sw, chip: () => chip as unknown as HTMLElement, storage: memStorage() });
  await tick();
  reg.ship("sw.js?1");
  expect(u.blocked()).toBe(false);
  expect(chip.hidden).toBe(true);
});

test("a worker waiting at boot is an update, shown on the chip", async () => {
  const reg = new FakeReg();
  reg.waiting = new FakeWorker("sw.js?2");
  reg.waiting.state = "installed";
  const chip = chipEl();
  let ready = 0;
  const u = createUpdateCheck({ sw: new FakeSw(reg), chip: () => chip as unknown as HTMLElement, onReady: () => ready++, storage: memStorage() });
  await tick();
  expect(u.blocked()).toBe(true);
  expect(chip.hidden).toBe(false);
  expect(chip.textContent).toMatch(/UPDATE READY/);
  expect(ready).toBe(1);
  u.stop();
});

test("an update found mid-session becomes ready once it is installed", async () => {
  const reg = new FakeReg();
  const u = createUpdateCheck({ sw: new FakeSw(reg), storage: memStorage() });
  await tick();
  expect(u.blocked()).toBe(false);
  reg.ship("sw.js?3");
  expect(u.blocked()).toBe(true);
  u.stop();
});

test("the chip hides during a race and apply() refuses: a reload must never end a race", async () => {
  const reg = new FakeReg();
  const w = new FakeWorker("sw.js?4");
  w.state = "installed";
  reg.waiting = w;
  let racing = true;
  const chip = chipEl();
  const u = createUpdateCheck({ sw: new FakeSw(reg), inRace: () => racing, chip: () => chip as unknown as HTMLElement, storage: memStorage() });
  await tick();
  expect(chip.hidden).toBe(true);
  expect(await u.apply()).toBe(false);
  expect(w.posted).toEqual([]);
  racing = false;
  u.render();
  expect(chip.hidden).toBe(false);
  expect(await u.apply()).toBe(true);
  expect(w.posted).toEqual([{ type: "SKIP_WAITING" }]);
  u.stop();
});

test("the new worker taking control reloads the page exactly once", async () => {
  const reg = new FakeReg();
  const sw = new FakeSw(reg);
  let reloads = 0;
  const storage = memStorage();
  const u = createUpdateCheck({ sw, reload: () => reloads++, storage });
  await tick();
  reg.ship("sw.js?5");
  expect(await u.apply()).toBe(true);
  sw.change();
  sw.change();
  expect(reloads).toBe(1);
  expect(storage.map.get(RELOAD_KEY)).toBe("sw.js?5");
  // The same update cannot be applied again from a reloaded tab still on it.
  const again = createUpdateCheck({ sw, reload: () => reloads++, storage });
  await tick();
  expect(await again.apply()).toBe(false);
  u.stop();
  again.stop();
});

test("a race that starts while saves flush cancels the reload; the flush is bounded", async () => {
  vi.useFakeTimers();
  const reg = new FakeReg();
  const w = new FakeWorker("sw.js?6");
  w.state = "installed";
  reg.waiting = w;
  let racing = false;
  const u = createUpdateCheck({ sw: new FakeSw(reg), inRace: () => racing, persist: () => new Promise(() => undefined), storage: memStorage() });
  await vi.advanceTimersByTimeAsync(0);
  const p = u.apply();
  racing = true;
  await vi.advanceTimersByTimeAsync(PERSIST_WAIT_MS);
  expect(await p).toBe(false);
  expect(w.posted).toEqual([]);
  u.stop();
});

test("checks are throttled, and a failed one is retried after a short backoff", async () => {
  let t = 1_000_000;
  const reg = new FakeReg();
  const u = createUpdateCheck({ sw: new FakeSw(reg), now: () => t, storage: memStorage() });
  await tick();
  await u.check();
  expect(reg.updates).toBe(0); // inside the throttle window since creation
  t += THROTTLE_MS;
  await u.check();
  expect(reg.updates).toBe(1);
  t += 1000;
  await u.check();
  expect(reg.updates).toBe(1);
  // Forced, and failing (offline): asked again after FAIL_BACKOFF_MS, not THROTTLE_MS.
  reg.failNext = true;
  expect(await u.check(true)).toBe(false);
  expect(reg.updates).toBe(2);
  t += FAIL_BACKOFF_MS;
  await u.check();
  expect(reg.updates).toBe(3);
});

test("no service worker support is a quiet no-op", async () => {
  const u = createUpdateCheck({ sw: null, storage: null });
  expect(await u.check(true)).toBe(false);
  expect(await u.apply()).toBe(false);
  expect(u.blocked()).toBe(false);
});
