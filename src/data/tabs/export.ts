/**
 * Apex 26 — the data hub's EXPORT tab (dev tool): gathers one fast-lap GPS
 * trace per circuit from OpenF1 and downloads a ZIP (traces JSON + labelled
 * map PNG per circuit).
 *
 * Ported verbatim from f1-game js/data/export.js:1-331:
 *   create(ctx)          export.js:5-326
 *   gatherStartLines     export.js:17-130
 *   CRC_TABLE / crc32    export.js:132-145
 *   makeZip              export.js:146-172
 *   safeName             export.js:174
 *   traceToPng           export.js:176-207
 *   canvasPng            export.js:208-218
 *   loadExport           export.js:220-321
 *
 * Changes from f1-game: the global F1API is `ctx.api`; the global
 * NativeDownload is the optional `ctx.saveBlob`; `Log` is ./log; crc32,
 * makeZip and safeName are module-level exports (same code) so tests reach
 * them; `mount(host, deps)` is new.
 */
import type { F1Api, Key, Meeting } from "../api";
import type { HubDeps, MountedTab } from "../hub-deps";
import { log as Log } from "../log";

/** One captured circuit in the startlines JSON (export.js:75-78). */
export interface StartLineCircuit {
  circuit: string | null;
  country: string | null;
  driver: string | null;
  lapDur: number | null;
  sf: [number, number] | undefined;
  nLoc: number;
  trace: [number, number][];
}

/** The gathered result the ZIP's startlines-<year>.json holds (export.js:18). */
export interface StartLines {
  year: number;
  generatedAt: string;
  circuits: Record<string, StartLineCircuit>;
}

export interface ZipFile { name: string; data: Uint8Array }

export interface ExportCtx {
  api: F1Api;
  el: HubDeps["el"];
  clear: HubDeps["clear"];
  isOpen?: () => boolean;
  /**
   * Native save (f1-game's global NativeDownload.saveBlob, used when
   * NativeDownload.viable()). Absent → the anchor-download path.
   * TODO(lane-shell): wire the shell lane's native save here.
   */
  saveBlob?: (blob: Blob, name: string) => Promise<void>;
}

export interface DataExport {
  loadExport(): Promise<HTMLDivElement>;
  gatherStartLines(year: number, log: (m: string) => void): Promise<StartLines>;
}

/** The error-shape checks f1-game does on a rejection (cancelled flag, HTTP status). */
interface ErrLike { cancelled?: unknown; status?: unknown; message?: unknown }
function errLike(e: unknown): ErrLike | null {
  return (e && typeof e === "object") ? e as ErrLike : null;
}

const CRC_TABLE = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]!) & 0xff]!;
  return (crc ^ -1) >>> 0;
}
export function makeZip(files: readonly ZipFile[]): Blob {  // files: [{name, data: Uint8Array}]
  const enc = new TextEncoder();
  const u16 = function (n: number): number[] { return [n & 255, (n >>> 8) & 255]; };
  const u32 = function (n: number): number[] { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; };
  const parts: Uint8Array[] = [], central: { nameB: Uint8Array; crc: number; sz: number; offset: number }[] = [];
  let offset = 0;
  files.forEach(function (f) {
    const nameB = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const local = ([] as number[]).concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(sz), u32(sz), u16(nameB.length), u16(0));
    parts.push(new Uint8Array(local), nameB, f.data);
    central.push({ nameB: nameB, crc: crc, sz: sz, offset: offset });
    offset += local.length + nameB.length + sz;
  });
  const cdStart = offset;
  const cd: Uint8Array[] = [];
  central.forEach(function (c) {
    const hdr = ([] as number[]).concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(c.crc), u32(c.sz), u32(c.sz), u16(c.nameB.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(c.offset));
    cd.push(new Uint8Array(hdr), c.nameB);
    offset += hdr.length + c.nameB.length;
  });
  const end = new Uint8Array(([] as number[]).concat(u32(0x06054b50), u16(0), u16(0),
    u16(central.length), u16(central.length), u32(offset - cdStart), u32(cdStart), u16(0)));
  // TS 5.7+ types Uint8Array<ArrayBufferLike>, which BlobPart rejects; the bytes are plain ArrayBuffer-backed.
  return new Blob(parts.concat(cd, [end]) as BlobPart[], { type: "application/zip" });
}

export function safeName(s: unknown): string { return String(s || "circuit").replace(/[^a-z0-9_-]+/gi, "_"); }

export function create(ctx: ExportCtx): DataExport {
  const { el } = ctx;
  const F1API = ctx.api;
  const hubOpen = ctx.isOpen || function () { return true; };

  /* Runs in the browser (where OpenF1 is reachable) and downloads a JSON file.
     For each circuit of the chosen season it pulls ONE clean fast-lap location
     trace with timestamps covering both lap boundaries. The first fix is within
     two feed intervals of the start/finish crossing, so it estimates S/F — used offline to validate/correct each circuit's start
     line (s=0 / startFrac) against the game's centreline. */

  function sleep(ms: number): Promise<void> { return new Promise(function (r) { setTimeout(r, ms); }); }

  function gatherStartLines(year: number, log: (m: string) => void): Promise<StartLines> {
    const out: StartLines = { year: year, generatedAt: new Date().toISOString(), circuits: {} };
    const GAP = 5000;
    const DRIVERS = 3;

    // Cancel checkpoint: a gather must not keep hammering OpenF1 for ~10 min
    // after the hub is closed. Checked around every pacing sleep; a quick
    // close-and-reopen that spans no checkpoint deliberately survives.
    function ck(): void {
      if (!hubOpen()) { const e = new Error("cancelled") as Error & { cancelled?: boolean }; e.cancelled = true; throw e; }
    }
    function sleepCk(ms: number): Promise<void> { ck(); return sleep(ms).then(ck); }

    function tryMeeting(m: Meeting, retrying: boolean): Promise<boolean> {
      const key = (m.circuit || m.name) as string;
      // api.meetings drops rows without a meeting key; the Key casts below
      // pass f1-game's values through unchanged (a null would reach the URL as "null").
      return F1API.sessionsForMeeting(m.meetingKey as Key).then(function (ss) {
        const s = ss.find(function (x) { return /quali/i.test(x.name || ""); }) ||
                  ss.find(function (x) { return /race/i.test(x.name || ""); }) ||
                  ss[ss.length - 1];
        if (!s) { log("· no session: " + key); return false; }
        const sessionKey = s.sessionKey as Key;
        return sleepCk(2000).then(function () {
          return F1API.sessionDrivers(sessionKey);
        }).then(function (drv) {
          if (!drv || !drv.length) { log("· no drivers: " + key); return false; }
          const cand = drv.slice(0, DRIVERS);
          let dc: Promise<boolean> = Promise.resolve(false);
          cand.forEach(function (d) {
            dc = dc.then(function (done): Promise<boolean> | boolean {
              if (done) return true;
              // 3 s before each laps request to stay within rate limit
              return sleepCk(3000).then(function () {
                return F1API.fastestLap(sessionKey, d.num as Key);
              }).then(function (fl) {
                if (!fl || !fl.dateStart) return false;
                const dateStart = fl.dateStart;
                // null lapDuration coerces to 0 in the arithmetic, as in f1-game.
                const lapDuration = fl.lapDuration as number;
                const endISO = new Date(Date.parse(dateStart) + (lapDuration + 1) * 1000).toISOString();
                // 3 s before location (large response — give the server breathing room)
                return sleepCk(3000).then(function () {
                  return F1API.locationData(sessionKey, d.num as Key, dateStart, endISO);
                }).then(function (loc) {
                  if (!loc || loc.length < 20) return false;
                  const startMs = Date.parse(dateStart), endMs = startMs + lapDuration * 1000;
                  loc = loc.filter(function (p) { return +p.date >= startMs && +p.date <= endMs; });
                  if (loc.length < 20) return false;
                  const cadence: number[] = [];
                  for (let i = 1; i < loc.length; i++) {
                    const dt = +loc[i]!.date - +loc[i - 1]!.date;
                    if (!(dt > 0)) return false;
                    cadence.push(dt);
                  }
                  cadence.sort(function (a, b) { return a - b; });
                  const tick = cadence[Math.floor(cadence.length / 2)]!;
                  // Use feed timestamps, independent of coordinate units or scale.
                  if (+loc[0]!.date - startMs > tick * 2 ||
                      endMs - +loc[loc.length - 1]!.date > tick * 2 ||
                      cadence[cadence.length - 1]! > tick * 8) return false;
                  const step = Math.max(1, Math.floor(loc.length / 240));
                  const trace = loc.filter(function (_, i) { return i % step === 0; })
                                   .map(function (p): [number, number] { return [Math.round(p.x), Math.round(p.y)]; });
                  out.circuits[key] = {
                    circuit: m.circuit, country: m.country, driver: d.code,
                    lapDur: fl.lapDuration, sf: trace[0], nLoc: loc.length, trace: trace
                  };
                  log("✓ " + key + "  pts=" + trace.length + " (" + (d.code || ("#" + d.num)) + ")");
                  return true;
                });
              }).catch(function (e: unknown) {
                const er = errLike(e);
                if (er && er.cancelled) throw e;
                // A 429 here is the rate-limit path the outer catch waits 90 s
                // for — swallowing it as "this driver failed" skipped the wait
                // and only retried after the 2 min missed-circuits pass.
                if (er && (er.status === 429 || /429/.test(String(er.message || "")))) throw e;
                return false;
              });
            });
          });
          return dc.then(function (done) { if (!done) log("· no lap/loc: " + key); return done; });
        });
      }).catch(function (e: unknown) {
        const er = errLike(e);
        if (er && er.cancelled) throw e;
        const msg = (er && er.message as string) || String(e);
        // On 429 wait 90 s then retry once — longer than OpenF1's sliding window
        // (f1-game reads e.status unguarded; a non-object rejection has no status.)
        if (!retrying && ((er && er.status === 429) || /429/.test(msg))) {
          log("· rate limited for " + key + " — waiting 90 s…");
          return sleepCk(90000).then(function () { return tryMeeting(m, true); });
        }
        log("· skip " + key + ": " + msg);
        return false;
      });
    }

    function pass(list: Meeting[]): Promise<Meeting[]> {
      let chain: Promise<unknown> = Promise.resolve();
      const missed: Meeting[] = [];
      list.forEach(function (m, i) {
        chain = chain.then(function () {
          log("Circuit " + (i + 1) + "/" + list.length + " · " + (m.circuit || m.name || "unknown"));
          return tryMeeting(m, false).then(function (ok) { if (!ok) missed.push(m); });
        }).then(function () { return i < list.length - 1 ? sleepCk(GAP) : null; });
      });
      return chain.then(function () { return missed; });
    }

    return F1API.meetings(year).then(function (ms) {
      log("meetings: " + ms.length + " — gathering (~10 min, paced to avoid rate limits)…");
      return pass(ms).then(function (missed): Promise<unknown> | undefined {
        if (!missed.length) return;
        log("retrying " + missed.length + " missed circuit(s) — waiting 2 min for rate limit to clear…");
        return sleepCk(120000).then(function () { return pass(missed); });
      });
    }).then(function () {
      log("done — " + Object.keys(out.circuits).length + " circuits captured");
      return out;
    });
  }

  function traceToPng(circ: StartLineCircuit): Promise<Uint8Array> {
    const t = circ.trace || [];
    const W = 560, H = 560, pad = 48;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    // No 2D context (f1-game assumes one and would throw into "ZIP ERROR"):
    // skip this map, as an empty toBlob does.
    if (!g) return Promise.resolve(new Uint8Array(0));
    g.fillStyle = "#0c0c12"; g.fillRect(0, 0, W, H);
    if (t.length < 2) { return canvasPng(cv); }
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    t.forEach(function (p) {
      if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0];
      if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1];
    });
    const w = (maxx - minx) || 1, h = (maxy - miny) || 1;
    const sc = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
    const X = function (x: number): number { return pad + (x - minx) * sc; };
    const Y = function (y: number): number { return H - (pad + (y - miny) * sc); };  // flip Y → north-up
    g.strokeStyle = "#4da3ff"; g.lineWidth = 3; g.lineJoin = "round"; g.beginPath();
    t.forEach(function (p, i) { const x = X(p[0]), y = Y(p[1]); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
    g.stroke();
    // initial-direction arrow (trace[0] → a few points along)
    const a = t[0]!, b = t[Math.min(10, t.length - 1)]!;
    g.strokeStyle = "#ffd54a"; g.lineWidth = 4; g.beginPath();
    g.moveTo(X(a[0]), Y(a[1])); g.lineTo(X(b[0]), Y(b[1])); g.stroke();
    // S/F marker at trace[0]
    g.fillStyle = "#e10600"; g.beginPath(); g.arc(X(a[0]), Y(a[1]), 8, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#fff"; g.lineWidth = 2; g.stroke();
    g.fillStyle = "#fff"; g.font = "bold 18px sans-serif";
    g.fillText((circ.circuit || "?") + "  [" + (circ.driver || "") + "]", 14, 28);
    g.font = "13px sans-serif"; g.fillStyle = "#e10600"; g.fillText("● start/finish (lap start)", 14, H - 30);
    g.fillStyle = "#ffd54a"; g.fillText("→ initial direction", 14, H - 12);
    return canvasPng(cv);
  }
  function canvasPng(cv: HTMLCanvasElement): Promise<Uint8Array> {
    return new Promise(function (res) {
      cv.toBlob(function (blob) {
        if (!blob) { res(new Uint8Array(0)); return; }
        // A rejection here (detached buffer, OOM) must not hang the ZIP chain —
        // that leaves `running` true and kills Download for the whole session.
        blob.arrayBuffer().then(function (ab) { res(new Uint8Array(ab)); },
                                function () { res(new Uint8Array(0)); });
      }, "image/png");
    });
  }

  function loadExport(): Promise<HTMLDivElement> {
    const wrap = el("div", "dh-export");
    wrap.appendChild(el("div", "dh-export-note",
      "Pulls one fast-lap GPS trace per circuit from OpenF1 (runs in your browser). " +
      "The lap starts at the start/finish line, so it captures where each start/finish really is. " +
      "Pick a season, press Gather (about 10 minutes, paced so the feed is not overloaded), then Download a ZIP " +
      "of the traces and a labelled map per circuit. Keep Data Hub open while it gathers."));

    const yearRow = el("div", "dh-pick-years");
    const OPENF1_FIRST_YEAR = 2023;
    const years: number[] = [];
    for (let y = Math.max(new Date().getFullYear(), OPENF1_FIRST_YEAR); y >= OPENF1_FIRST_YEAR; y--) years.push(y);
    const sel = { year: years[0]! };
    years.forEach(function (y) {
      const b = el("button", "dh-pill" + (y === sel.year ? " active" : ""), String(y));
      b.addEventListener("click", function () {
        sel.year = y;
        for (let i = 0; i < yearRow.children.length; i++)
          yearRow.children[i]!.classList.toggle("active", yearRow.children[i] === b);
      });
      yearRow.appendChild(b);
    });
    wrap.appendChild(yearRow);

    const row = el("div", "dh-export-row");
    const gatherBtn = el("button", "dh-pill active", "Gather");
    const dlBtn = el("button", "dh-pill", "Download");
    gatherBtn.setAttribute("data-aria-action", "");
    dlBtn.setAttribute("data-aria-action", "");
    dlBtn.disabled = true;
    row.appendChild(gatherBtn);
    row.appendChild(dlBtn);
    wrap.appendChild(row);

    const status = el("div", "dh-export-status",
      "Not gathered yet. Choose a season, press Gather, and keep Data Hub open for about 10 minutes. Download unlocks when gathering completes.");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    wrap.appendChild(status);

    let result: StartLines | null = null, running = false;
    const logs: string[] = [];
    const log = function (m: unknown): void { logs.push(String(m)); status.textContent = logs.slice(-200).join("\n"); status.scrollTop = status.scrollHeight; };

    gatherBtn.addEventListener("click", function () {
      if (running) return;
      running = true; result = null; dlBtn.disabled = true; logs.length = 0;
      gatherBtn.textContent = "Gathering…";
      log("Gathering " + sel.year + " — this can take ~10 min…");
      Log.info("export gather " + sel.year);
      gatherStartLines(sel.year, log).then(function (res) {
        result = res; dlBtn.disabled = false;
        log("Ready to download.");
        Log.info("export gather done");
      }).catch(function (e: unknown) {
        const er = errLike(e);
        if (er && er.cancelled) { log("Cancelled — data hub closed."); Log.info("export gather cancelled"); return; }
        log("ERROR: " + ((er && er.message) || e));
        Log.warn("export gather fail");
      }).then(function () { running = false; gatherBtn.textContent = "Gather"; });
    });

    async function triggerDownload(blob: Blob, name: string): Promise<void> {
      if (ctx.saveBlob) {
        await ctx.saveBlob(blob, name);
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }

    dlBtn.addEventListener("click", function () {
      if (!result || running) return;
      const res = result;
      running = true; dlBtn.disabled = true; dlBtn.textContent = "Zipping…";
      const enc = new TextEncoder();
      const json = JSON.stringify(res, null, 1);
      // The GATHERED year: the pill may have moved since.
      const files: ZipFile[] = [{ name: "startlines-" + res.year + ".json", data: enc.encode(json) }];
      const keys = Object.keys(res.circuits);
      log("rendering " + keys.length + " circuit map image(s)…");
      let chain: Promise<void> = Promise.resolve();
      keys.forEach(function (k) {
        chain = chain.then(function () {
          return traceToPng(res.circuits[k]!).then(function (png) {
            if (png && png.length) files.push({ name: "img/" + safeName(k) + ".png", data: png });
          });
        });
      });
      chain.then(async function () {
        const zip = makeZip(files);
        await triggerDownload(zip, "apex-startlines-" + res.year + ".zip");
        log("Downloaded apex-startlines-" + res.year + ".zip — " + files.length +
            " file(s), " + Math.round(zip.size / 1024) + " KB");
      }).catch(function (e: unknown) {
        const er = errLike(e);
        log("ZIP ERROR: " + ((er && er.message) || e));
      }).then(function () { running = false; dlBtn.disabled = false; dlBtn.textContent = "Download"; });
    });

    return Promise.resolve(wrap);
  }

  // gatherStartLines is exposed so unit tests can drive the OpenF1 gather
  // path with a mocked F1API (no real network, no DOM Gather click).
  return { loadExport, gatherStartLines };
}

/**
 * Mount the EXPORT tab into `host` (new in apex-26; f1-game's hub appended
 * loadExport()'s node itself, hub.js). Unmount also cancels a running gather
 * at its next pacing checkpoint, as closing the hub does in f1-game.
 */
export function mount(host: HTMLElement, deps: HubDeps & { saveBlob?: (blob: Blob, name: string) => Promise<void> }): MountedTab {
  let mounted = true;
  const ctx: ExportCtx = {
    api: deps.api, el: deps.el, clear: deps.clear,
    isOpen: () => mounted && deps.isOpen(),
  };
  if (deps.saveBlob) ctx.saveBlob = deps.saveBlob;
  const tab = create(ctx);
  function refresh(): Promise<void> {
    return tab.loadExport().then((wrap) => {
      if (!mounted) return;
      deps.clear(host);
      host.appendChild(wrap);
    });
  }
  void refresh();
  return {
    refresh,
    unmount(): void { mounted = false; deps.clear(host); },
  };
}
