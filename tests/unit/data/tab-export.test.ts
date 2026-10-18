// @vitest-environment happy-dom
/**
 * The Data Hub EXPORT tab (src/data/tabs/export.ts). Ports the assertions of
 * f1-game tests/unit/data-export.test.mjs: the hand-rolled ZIP read back by
 * walking its headers, CRC-32 in both headers, the startlines JSON shape, an
 * empty or failed feed, timestamp-partial traces, the next-driver fallback,
 * and the native-save outcomes. Recorded fixtures only; fake timers drive the
 * gather's multi-minute pacing.
 */
import { crc32 as zlibCrc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createF1Api } from "../../../src/data/api";
import { clear, el } from "../../../src/data/dom";
import { setDataLog } from "../../../src/data/log";
import { crc32, create, makeZip, mount, safeName, type StartLines } from "../../../src/data/tabs/export";
import { fixture, jsonResponse, MemoryStorage } from "./fixtures";
import { stubDeps } from "./hub-stub";
import type { FetchFn, FetchResponse } from "../../../src/data/transport";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const EPOCH = Date.parse("2026-10-14T22:00:00.000Z");

type Row = Record<string, unknown>;
type Decide = (url: string) => { body?: unknown; status?: number } | undefined;

// The Baku weekend: meetings is cut to that one meeting (the only one with
// recorded sessions); its Qualifying (11373) is served the 11377 race fixtures
// for any driver, since only the lap-28 location of car 1 is recorded.
const BAKU = (fixture("openf1-2026-meetings.json") as Row[]).filter((m) => m.meeting_key === 1295);
const LOCATION = fixture("openf1-11377-location-1-lap28.json") as Row[];
function openF1Body(url: string): unknown {
  if (url.includes("/meetings?")) return BAKU;
  if (url.includes("/sessions?meeting_key=1295")) return fixture("openf1-1295-sessions.json");
  if (url.includes("/drivers?")) return fixture("openf1-11377-drivers.json");
  if (url.includes("/laps?")) return fixture("openf1-11377-laps-1.json");
  if (url.includes("/location?")) return LOCATION;
  return undefined;
}
function openF1Fetch(decide?: Decide): FetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((url: string): Promise<FetchResponse> => {
    calls.push(url);
    const custom = decide ? decide(url) : undefined;
    if (custom && custom.status && custom.status !== 200) return Promise.resolve(jsonResponse(custom.body ?? { detail: "failed" }, custom.status));
    const body = custom && "body" in custom ? custom.body : openF1Body(url);
    if (body === undefined) return Promise.resolve(jsonResponse({ detail: "No results found." }, 404));
    return Promise.resolve(jsonResponse(body));
  }) as FetchFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

interface Entry { name: string; offset: number; data: Uint8Array; crc: number; size: number }
/** Read a stored ZIP back by walking its local headers, central directory and EOCD (data-export.test.mjs unzip). */
function unzip(buf: ArrayBuffer): Entry[] {
  const z = new Uint8Array(buf);
  const v = new DataView(buf);
  const dec = new TextDecoder();
  const local: Entry[] = [];
  let offset = 0;
  while (offset + 30 <= z.length && v.getUint32(offset, true) === 0x04034b50) {
    const flags = v.getUint16(offset + 6, true);
    const method = v.getUint16(offset + 8, true);
    const crc = v.getUint32(offset + 14, true);
    const compressed = v.getUint32(offset + 18, true);
    const uncompressed = v.getUint32(offset + 22, true);
    const nameLen = v.getUint16(offset + 26, true);
    const extraLen = v.getUint16(offset + 28, true);
    const name = dec.decode(z.subarray(offset + 30, offset + 30 + nameLen));
    const start = offset + 30 + nameLen + extraLen;
    const data = z.subarray(start, start + compressed);
    expect(flags, `${name}: no data descriptor`).toBe(0);
    expect(method, `${name}: stored, not deflated`).toBe(0);
    expect(compressed, `${name}: header compressed size`).toBe(uncompressed);
    expect(uncompressed, `${name}: header size matches payload`).toBe(data.length);
    expect(crc, `${name}: local CRC-32`).toBe(zlibCrc32(data) >>> 0);
    local.push({ name, offset, data, crc, size: uncompressed });
    offset = start + compressed;
  }
  const eocd = z.length - 22;
  expect(eocd >= offset, "EOCD fits after the entries").toBe(true);
  expect(v.getUint32(eocd, true), "end of central directory").toBe(0x06054b50);
  expect(v.getUint16(eocd + 8, true), "disk entry count").toBe(local.length);
  expect(v.getUint16(eocd + 10, true), "total entry count").toBe(local.length);
  const cdSize = v.getUint32(eocd + 12, true);
  let cursor = v.getUint32(eocd + 16, true);
  expect(cursor, "central directory starts where local entries end").toBe(offset);
  expect(cursor + cdSize, "central directory ends at the EOCD").toBe(eocd);
  for (const entry of local) {
    expect(v.getUint32(cursor, true), `${entry.name}: central signature`).toBe(0x02014b50);
    const nameLen = v.getUint16(cursor + 28, true);
    const extraLen = v.getUint16(cursor + 30, true);
    const commentLen = v.getUint16(cursor + 32, true);
    expect(dec.decode(z.subarray(cursor + 46, cursor + 46 + nameLen))).toBe(entry.name);
    expect(v.getUint32(cursor + 16, true), `${entry.name}: central CRC-32`).toBe(entry.crc);
    expect(v.getUint32(cursor + 20, true), `${entry.name}: central compressed size`).toBe(entry.size);
    expect(v.getUint32(cursor + 24, true), `${entry.name}: central uncompressed size`).toBe(entry.size);
    expect(v.getUint32(cursor + 42, true), `${entry.name}: central offset`).toBe(entry.offset);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  expect(cursor, "central directory consumed").toBe(eocd);
  return local;
}

function assertStartlines(parsed: StartLines, { year, keys }: { year: number; keys: string[] }): void {
  expect(Object.keys(parsed).sort()).toEqual(["circuits", "generatedAt", "year"]);
  expect(parsed.year).toBe(year);
  expect(typeof parsed.generatedAt).toBe("string");
  expect(Number.isNaN(Date.parse(parsed.generatedAt))).toBe(false);
  expect(Array.isArray(parsed.circuits)).toBe(false);
  expect(typeof parsed.circuits).toBe("object");
  expect(Object.keys(parsed.circuits)).toEqual(keys);
  for (const [key, circuit] of Object.entries(parsed.circuits)) {
    expect(Object.keys(circuit).sort()).toEqual(["circuit", "country", "driver", "lapDur", "nLoc", "sf", "trace"]);
    expect(circuit.circuit).toBe(key);
    expect(typeof circuit.country).toBe("string");
    expect(circuit.country!.length).toBeGreaterThan(0);
    expect(circuit.driver).toBe("NOR");
    expect(circuit.lapDur).toBeGreaterThan(0);
    expect(circuit.nLoc).toBeGreaterThanOrEqual(20);
    expect(circuit.trace.length).toBeGreaterThanOrEqual(2);
    expect(circuit.trace.every((p) => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && Number.isInteger(p[1]))).toBe(true);
    expect(circuit.sf).toEqual(circuit.trace[0]);
  }
}

function jsonOf(entries: Entry[]): StartLines[] {
  return entries.filter((e) => e.name.endsWith(".json")).map((e) => JSON.parse(new TextDecoder().decode(e.data)) as StartLines);
}

/** Fire timers one at a time until done(), flushing promises between them. */
async function pump(done: () => boolean, limit = 20000): Promise<void> {
  for (let i = 0; i < limit; i++) {
    await vi.advanceTimersByTimeAsync(0);
    if (done()) return;
    if (vi.getTimerCount() === 0) { await Promise.resolve(); if (done()) return; break; }
    await vi.advanceTimersToNextTimerAsync();
  }
  if (!done()) throw new Error("export did not settle");
}

let anchorName: string | null = null;
let anchorBlob: Blob | null = null;

beforeEach(() => {
  vi.useFakeTimers({ now: EPOCH, toFake: ["setTimeout", "clearTimeout", "Date"] });
  setDataLog({ info: () => {}, warn: () => {} });
  anchorName = null; anchorBlob = null;
  // happy-dom has no 2D canvas: hand back a no-op context and a fixed PNG.
  const g = new Proxy({}, { get: () => () => {}, set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(g as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb: BlobCallback) => { cb(new Blob([PNG], { type: "image/png" })); });
  vi.spyOn(URL, "createObjectURL").mockImplementation((b: Blob | MediaSource) => { anchorBlob = b as Blob; return "blob:export"; });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { anchorName = this.download; });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function boot(fetch: FetchFn, saveBlob?: (blob: Blob, name: string) => Promise<void>) {
  const api = createF1Api({ fetch, storage: new MemoryStorage() });
  const tab = create(saveBlob ? { api, el, clear, isOpen: () => true, saveBlob } : { api, el, clear, isOpen: () => true });
  return tab;
}
function parts(wrap: HTMLElement) {
  const [gather, download] = Array.from(wrap.querySelector(".dh-export-row")!.children) as HTMLButtonElement[];
  return { gather: gather!, download: download!, status: wrap.querySelector(".dh-export-status")! };
}

async function runExport(fetch: FetchFn) {
  const wrap = await boot(fetch).loadExport();
  const { gather, download, status } = parts(wrap);
  const year = Number(wrap.querySelector(".dh-pick-years")!.children[0]!.textContent);
  gather.click();
  await pump(() => (gather.textContent === "Gather" && (status.textContent ?? "").includes("ERROR"))
    || (!download.disabled && gather.textContent === "Gather"));
  if (!download.disabled) {
    download.click();
    await pump(() => !!anchorBlob && download.textContent === "Download");
  }
  return { year, status: status.textContent ?? "", download, blob: anchorBlob as Blob | null, downloadName: anchorName };
}

describe("crc32 / makeZip", () => {
  it("CRC-32 of the check string is 0xCBF43926 and matches zlib", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xCBF43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(PNG)).toBe(zlibCrc32(PNG) >>> 0);
  });

  it("writes a stored archive whose entries read back byte-for-byte", async () => {
    const files = [
      { name: "a.json", data: new TextEncoder().encode('{"x":1}') },
      { name: "img/Spa-Francorchamps.png", data: PNG },
      { name: "empty.txt", data: new Uint8Array(0) },
    ];
    const zip = makeZip(files);
    expect(zip.type).toBe("application/zip");
    const entries = unzip(await zip.arrayBuffer());
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    entries.forEach((e, i) => expect(Array.from(e.data)).toEqual(Array.from(files[i]!.data)));
  });

  it("an empty file list is just the end-of-central-directory record", async () => {
    const buf = new Uint8Array(await makeZip([]).arrayBuffer());
    expect(buf.length).toBe(22);
    expect(unzip(buf.buffer)).toEqual([]);
  });

  it("safeName maps circuit names to file-safe stems", () => {
    expect(safeName("Spa-Francorchamps")).toBe("Spa-Francorchamps");
    expect(safeName("Yas Marina Circuit")).toBe("Yas_Marina_Circuit");
    expect(safeName("Monte Carlo")).toBe("Monte_Carlo");
    expect(safeName(null)).toBe("circuit");
  });
});

describe("EXPORT gather + download", () => {
  it("zips every circuit from the OpenF1 fixture, with CRC-32 and JSON shape", async () => {
    const out = await runExport(openF1Fetch());
    expect(out.year).toBe(2026);
    expect(out.status).toMatch(/Ready to download/);
    expect(out.status).not.toMatch(/ERROR/);
    expect(out.downloadName).toBe("apex-startlines-2026.zip");
    expect(out.blob!.type).toBe("application/zip");
    const entries = unzip(await out.blob!.arrayBuffer());
    expect(entries.map((e) => e.name)).toEqual(["startlines-2026.json", "img/Baku.png"]);
    const parsed = jsonOf(entries);
    expect(parsed.length).toBe(1);
    assertStartlines(parsed[0]!, { year: 2026, keys: ["Baku"] });
    const laps = fixture("openf1-11377-laps-1.json") as { lap_duration: number | null; date_start: string | null; is_pit_out_lap: boolean }[];
    const best = laps.filter((l) => l.lap_duration && l.date_start && !l.is_pit_out_lap)
      .reduce((a, b) => (a.lap_duration! < b.lap_duration! ? a : b));
    const startMs = Date.parse(best.date_start!), endMs = startMs + best.lap_duration! * 1000;
    const inLap = LOCATION.filter((p) => { const t = Date.parse(p.date as string); return t >= startMs && t <= endMs; });
    const c = parsed[0]!.circuits.Baku!;
    expect(c.country).toBe(BAKU[0]!.country_name);
    expect(c.lapDur).toBe(best.lap_duration);
    expect(c.nLoc).toBe(inLap.length);
    expect(c.trace.length).toBe(Math.ceil(inLap.length / Math.max(1, Math.floor(inLap.length / 240))));
    expect(c.sf).toEqual([Math.round(inLap[0]!.x as number), Math.round(inLap[0]!.y as number)]);
    expect(Array.from(entries[1]!.data)).toEqual(Array.from(PNG));
  });

  it("an empty meetings body still downloads a valid zip with no circuits", async () => {
    const out = await runExport(openF1Fetch((url) => (url.includes("/meetings") ? { body: [] } : undefined)));
    expect(out.status).toMatch(/meetings: 0/);
    expect(out.status).toMatch(/0 circuits captured/);
    expect(out.status).not.toMatch(/ERROR/);
    expect(out.download.disabled).toBe(false);
    const entries = unzip(await out.blob!.arrayBuffer());
    expect(entries.map((e) => e.name)).toEqual(["startlines-2026.json"]);
    assertStartlines(jsonOf(entries)[0]!, { year: 2026, keys: [] });
  });

  it("an empty location body skips every circuit and still zips", async () => {
    const out = await runExport(openF1Fetch((url) => (url.includes("/location") ? { body: [] } : undefined)));
    expect(out.status).toMatch(/no lap\/loc/);
    expect(out.status).toMatch(/0 circuits captured/);
    expect(out.status).not.toMatch(/ERROR/);
    const entries = unzip(await out.blob!.arrayBuffer());
    expect(entries.map((e) => e.name)).toEqual(["startlines-2026.json"]);
    assertStartlines(jsonOf(entries)[0]!, { year: 2026, keys: [] });
  });

  it("a failed OpenF1 response leaves Download disabled and records the error", async () => {
    const out = await runExport(openF1Fetch(() => ({ status: 404, body: { detail: "not found" } })));
    expect(out.blob).toBe(null);
    expect(out.download.disabled).toBe(true);
    expect(out.download.textContent).toBe("Download");
    expect(out.status).toMatch(/ERROR: not found/);
  });

  for (const defect of ["start", "end", "middle"] as const) {
    it(`rejects a timestamp-${defect} partial trace despite sufficient samples`, async () => {
      const out = await runExport(openF1Fetch((url) => {
        if (!url.includes("/location")) return undefined;
        return { body: LOCATION.filter((_, i) => defect === "start" ? i >= 38 : defect === "end" ? i < 102 : i < 45 || i >= 83) };
      }));
      expect(jsonOf(unzip(await out.blob!.arrayBuffer()))[0]!.circuits).toEqual({});
    });
  }

  it("tries the next driver after a partial trace, independent of coordinate scale", async () => {
    const out = await runExport(openF1Fetch((url) => {
      if (!url.includes("/location")) return undefined;
      return { body: new URL(url).searchParams.get("driver_number") === "1" ? LOCATION.slice(38) :
        LOCATION.map((p) => ({ ...p, x: (p.x as number) * 10, y: (p.y as number) * 10 })) };
    }));
    const parsed = jsonOf(unzip(await out.blob!.arrayBuffer()))[0]!;
    const c = parsed.circuits.Baku!;
    expect(c).toBeDefined();
    expect(c.driver).toBe("VER");
    expect(c.sf).toEqual([(LOCATION[0]!.x as number) * 10, (LOCATION[0]!.y as number) * 10]);
  });

  it("native save waits for sharing and never reports a cancelled or failed share as downloaded", async () => {
    for (const outcome of ["success", "cancel", "failure"] as const) {
      let resolve!: () => void, reject!: (e: Error) => void;
      let saved: { blob: Blob; name: string } | null = null;
      const held = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      const wrap = await boot(openF1Fetch(() => ({ body: [] })), (blob, name) => { saved = { blob, name }; return held; }).loadExport();
      const { gather, download, status } = parts(wrap);
      gather.click();
      await pump(() => !download.disabled && gather.textContent === "Gather");
      download.click();
      await pump(() => !!saved);
      const s = saved as { blob: Blob; name: string } | null;
      expect(s!.name).toBe("apex-startlines-2026.zip");
      expect(s!.blob.type).toBe("application/zip");
      expect(download.disabled).toBe(true);
      expect(status.textContent).not.toMatch(/Downloaded/);
      expect(anchorName, "native ZIP must not fall back to an anchor").toBe(null);
      if (outcome === "success") resolve(); else reject(new Error(outcome === "cancel" ? "Share canceled" : "disk full"));
      await pump(() => !download.disabled);
      expect(status.textContent).toMatch(outcome === "success" ? /Downloaded apex-startlines-2026.zip/ : outcome === "cancel" ? /ZIP ERROR: Share canceled/ : /ZIP ERROR: disk full/);
      if (outcome !== "success") expect(status.textContent).not.toMatch(/Downloaded/);
    }
  });

  it("closing the hub cancels a running gather at its next checkpoint", async () => {
    let open = true;
    const api = createF1Api({ fetch: openF1Fetch(), storage: new MemoryStorage() });
    const wrap = await create({ api, el, clear, isOpen: () => open }).loadExport();
    const { gather, download, status } = parts(wrap);
    gather.click();
    await vi.advanceTimersByTimeAsync(0);
    open = false;
    await pump(() => gather.textContent === "Gather");
    expect(status.textContent).toMatch(/Cancelled — data hub closed\./);
    expect(download.disabled).toBe(true);
  });
});

describe("mount", () => {
  it("mounts the EXPORT tab, lists seasons back to 2023, and unmounts", async () => {
    const host = document.createElement("div");
    const deps = stubDeps([]);
    const tab = mount(host, deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector(".dh-export")).not.toBe(null);
    expect(host.querySelector(".dh-export-note")).not.toBe(null);
    const pills = Array.from(host.querySelectorAll(".dh-pick-years .dh-pill")).map((b) => b.textContent);
    expect(pills).toEqual(["2026", "2025", "2024", "2023"]);
    expect(host.querySelector(".dh-pick-years .active")!.textContent).toBe("2026");
    (host.querySelectorAll(".dh-pick-years .dh-pill")[2] as HTMLButtonElement).click();
    expect(host.querySelector(".dh-pick-years .active")!.textContent).toBe("2024");
    const status = host.querySelector(".dh-export-status")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect((host.querySelector(".dh-export-row")!.children[1] as HTMLButtonElement).disabled).toBe(true);
    await tab.refresh();
    expect(host.querySelectorAll(".dh-export").length).toBe(1);
    tab.unmount();
    expect(host.childNodes.length).toBe(0);
  });
});
