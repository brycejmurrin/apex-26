/** Recorded-fixture fetch for the data lane: no live network in tests. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CacheStorage, FetchFn, FetchResponse } from "../../../src/data/transport";

// cwd, not import.meta.url: under happy-dom the module URL is not a file: URL.
const DIR = resolve(process.cwd(), "tests/fixtures/data") + "/";

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(DIR + name, "utf8"));
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): FetchResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
    json: () => Promise.resolve(JSON.parse(text)),
    text: () => Promise.resolve(text),
  };
}

/** A fetch that serves fixtures by URL substring; records every URL asked for. */
export function fixtureFetch(routes: [match: string, file: string][]): FetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((url: string) => {
    calls.push(url);
    const hit = routes.find(([m]) => url.includes(m));
    if (!hit) return Promise.resolve(jsonResponse({ detail: "No results found." }, 404));
    return Promise.resolve(jsonResponse(fixture(hit[1])));
  }) as FetchFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export class MemoryStorage implements CacheStorage {
  readonly map = new Map<string, string>();
  quota = Infinity;
  get length(): number { return this.map.size; }
  key(i: number): string | null { return [...this.map.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void {
    let used = v.length;
    for (const [key, val] of this.map) if (key !== k) used += val.length;
    if (used > this.quota) throw new Error("QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k: string): void { this.map.delete(k); }
}
