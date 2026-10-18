import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, CACHE_PREFIX, createTransport, type FetchFn, type FetchResponse } from "../../../src/data/transport";
import { setDataLog } from "../../../src/data/log";
import { jsonResponse, MemoryStorage } from "./fixtures";

const OF1 = "https://api.openf1.org/v1";
const WEEK = 7 * 24 * 3600 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  setDataLog({ info: () => {}, warn: () => {} });
});
afterEach(() => { vi.useRealTimers(); });

function scripted(responses: (FetchResponse | Error | (() => Promise<FetchResponse>))[]): FetchFn & { calls: string[]; at: number[] } {
  const calls: string[] = [], at: number[] = [];
  const fn = ((url: string) => {
    calls.push(url); at.push(Date.now());
    const r = responses.shift();
    if (!r) return Promise.reject(new Error("no more responses"));
    if (r instanceof Error) return Promise.reject(r);
    if (typeof r === "function") return r();
    return Promise.resolve(r);
  }) as FetchFn & { calls: string[]; at: number[] };
  fn.calls = calls; fn.at = at;
  return fn;
}

async function settle<T>(p: Promise<T>): Promise<{ ok: T } | { err: unknown }> {
  const out = p.then((ok) => ({ ok }), (err: unknown) => ({ err }));
  await vi.runAllTimersAsync();
  return out;
}

describe("transport cache", () => {
  it("serves a fresh cache hit without the network and refetches past the TTL", async () => {
    const storage = new MemoryStorage();
    const fetch = scripted([jsonResponse([1]), jsonResponse([2])]);
    const t = createTransport(OF1, WEEK, { fetch, storage });
    const url = OF1 + "/sessions?x=1";
    expect(await settle(t.request(url, 60000))).toEqual({ ok: [1] });
    expect(await settle(t.request(url, 60000))).toEqual({ ok: [1] });
    expect(fetch.calls.length).toBe(1);
    expect(storage.getItem(CACHE_PREFIX + url)).toMatch(/^\{"t":\d+,"data":\[1\]\}$/);
    vi.advanceTimersByTime(60001);
    expect(await settle(t.request(url, 60000))).toEqual({ ok: [2] });
  });

  it("falls back to a stale copy offline and reports its age", async () => {
    const storage = new MemoryStorage();
    const url = OF1 + "/laps?x";
    const t0 = Date.now() - 3600_000;
    storage.setItem(CACHE_PREFIX + url, JSON.stringify({ t: t0, data: ["old"] }));
    const t = createTransport(OF1, WEEK, { fetch: scripted([new TypeError("Failed to fetch")]), storage });
    const mark = t.staleMark();
    expect(await settle(t.request(url, 1000))).toEqual({ ok: ["old"] });
    expect(t.staleSince(mark)).toBe(t0);
    expect(t.staleSince(t.staleMark())).toBe(null);
  });

  it("never serves stale over a 401/403", async () => {
    const storage = new MemoryStorage();
    const url = OF1 + "/position?live";
    storage.setItem(CACHE_PREFIX + url, JSON.stringify({ t: Date.now() - 3600_000, data: ["old"] }));
    const t = createTransport(OF1, WEEK, { fetch: scripted([jsonResponse({ detail: "Live F1 session in progress" }, 401)]), storage });
    const r = await settle(t.request(url, 1000));
    expect("err" in r && r.err instanceof ApiError && r.err.status === 401 && r.err.message).toBe("Live F1 session in progress");
  });

  it("keeps oversize bodies in memory only", async () => {
    const storage = new MemoryStorage();
    const big = "x".repeat(300 * 1024);
    const fetch = scripted([jsonResponse([big])]);
    const t = createTransport(OF1, WEEK, { fetch, storage });
    const url = OF1 + "/position?big";
    await settle(t.request(url, 60000));
    expect(storage.length).toBe(0);
    expect(await settle(t.request(url, 60000))).toEqual({ ok: [big] });
    expect(fetch.calls.length).toBe(1);
    t.forget(url);
    expect("err" in (await settle(t.request(url, 60000)))).toBe(true);
  });

  it("evicts telemetry first when the quota is full", async () => {
    const storage = new MemoryStorage();
    storage.quota = 2000;
    storage.setItem(CACHE_PREFIX + OF1 + "/car_data?a", JSON.stringify({ t: Date.now(), data: "c".repeat(1500) }));
    storage.setItem(CACHE_PREFIX + "https://api.jolpi.ca/ergast/f1/2026.json", JSON.stringify({ t: Date.now() - 1000, data: "s" }));
    const t = createTransport(OF1, WEEK, { fetch: scripted([jsonResponse(["n".repeat(600)])]), storage });
    await settle(t.request(OF1 + "/laps?new", 60000));
    expect(storage.getItem(CACHE_PREFIX + OF1 + "/car_data?a")).toBe(null);
    expect(storage.getItem(CACHE_PREFIX + OF1 + "/laps?new")).not.toBe(null);
  });

  it("reads the cache timestamp by prefix and falls back to a parse", () => {
    const t = createTransport(OF1, WEEK, { fetch: scripted([]), storage: null });
    expect(t.cacheEntryT('{"t":123,"data":1}')).toBe(123);
    expect(t.cacheEntryT('{"data":1,"t":5}')).toBe(5);
    expect(t.cacheEntryT("nope")).toBe(null);
  });
});

describe("transport network policy", () => {
  it("shares one in-flight request between callers", async () => {
    const fetch = scripted([jsonResponse([1])]);
    const t = createTransport(OF1, WEEK, { fetch, storage: null });
    const a = t.request(OF1 + "/a", 1000), b = t.request(OF1 + "/a", 1000);
    expect(a).toBe(b);
    await settle(a);
    expect(fetch.calls.length).toBe(1);
  });

  it("paces a lane at 400 ms and keeps lanes independent", async () => {
    const fetch = scripted([jsonResponse(1), jsonResponse(2), jsonResponse(3)]);
    const t = createTransport(OF1, WEEK, { fetch, storage: null });
    const t0 = Date.now();
    const ps = [t.request(OF1 + "/a", 0), t.request(OF1 + "/b", 0), t.request("https://api.jolpi.ca/ergast/f1/x.json", 0)];
    await settle(Promise.all(ps));
    const byUrl = Object.fromEntries(fetch.calls.map((u, i) => [u, fetch.at[i]! - t0]));
    expect(byUrl[OF1 + "/a"]).toBe(0);
    expect(byUrl["https://api.jolpi.ca/ergast/f1/x.json"]).toBe(0);
    expect(byUrl[OF1 + "/b"]).toBe(400);
  });

  it("holds OpenF1 under 28 requests a minute", async () => {
    const fetch = scripted(Array.from({ length: 30 }, (_, i) => jsonResponse(i)));
    const t = createTransport(OF1, WEEK, { fetch, storage: null });
    const t0 = Date.now();
    await settle(Promise.all(Array.from({ length: 30 }, (_, i) => t.request(OF1 + "/r" + i, 0))));
    expect(fetch.at[27]! - t0).toBeLessThan(60000);
    expect(fetch.at[28]! - t0).toBeGreaterThanOrEqual(60000);
  });

  it("retries 429 / 5xx with backoff, honouring Retry-After", async () => {
    const fetch = scripted([jsonResponse({}, 503), jsonResponse({}, 429, { "Retry-After": "30" }), jsonResponse(["ok"])]);
    const t = createTransport(OF1, WEEK, { fetch, storage: null });
    const t0 = Date.now();
    expect(await settle(t.request(OF1 + "/x", 0))).toEqual({ ok: ["ok"] });
    expect(fetch.at.map((x) => x - t0)).toEqual([0, 10000, 40000]);
  });

  it("fails fast when Retry-After exceeds 90 s", async () => {
    const fetch = scripted([jsonResponse({}, 429, { "Retry-After": "120" })]);
    const t = createTransport(OF1, WEEK, { fetch, storage: null });
    const r = await settle(t.request(OF1 + "/x", 0));
    expect("err" in r && (r.err as ApiError).status).toBe(429);
    expect(fetch.calls.length).toBe(1);
  });

  it("times out a stalled body after 15 s", async () => {
    const stalled: FetchResponse = { ok: true, status: 200, json: () => new Promise(() => {}), text: () => new Promise(() => {}) };
    const t = createTransport(OF1, WEEK, { fetch: scripted([stalled]), storage: null });
    const r = await settle(t.request(OF1 + "/x", 0));
    expect("err" in r && (r.err as Error).message).toMatch(/timed out/);
  });

  it("cancelAll drops queued and in-flight work without stale fallback", async () => {
    let release: (r: FetchResponse) => void = () => {};
    const fetch = scripted([() => new Promise<FetchResponse>((res) => { release = res; }), jsonResponse(2)]);
    const t = createTransport(OF1, WEEK, { fetch, storage: null });
    const a = settle(t.request(OF1 + "/a", 0));
    const b = settle(t.request(OF1 + "/b", 0));
    await Promise.resolve(); await Promise.resolve();
    expect(t.cancelAll()).toBe(1);
    release(jsonResponse(1));
    const [ra, rb] = await Promise.all([a, b]);
    expect("err" in ra && (ra.err as ApiError).cancelled).toBe(true);
    expect("err" in rb && (rb.err as ApiError).cancelled).toBe(true);
    expect(fetch.calls).toEqual([OF1 + "/a"]);
  });
});
