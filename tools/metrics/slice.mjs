// T1.13 slice metrics: serve dist/ with `vite preview`, load the Monza time trial
// in Chromium, and report initial download (gzip), time to first frame, fps and
// draw calls. Writes artifacts/slice-metrics.json.
//
//   npm run build && node tools/metrics/slice.mjs [--gl] [--seconds 10]
//
// PW_CHROMIUM_PATH picks the browser binary (cloud containers: /opt/pw-browsers/chromium).
// Without a GPU, Chromium runs SwiftShader: the fps it reports is a software-GL
// floor, not a desktop number.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const seconds = Number(args[args.indexOf("--seconds") + 1]) || 10;
const forceGL = args.includes("--gl");
const PORT = 4174;
const BASE = `http://localhost:${PORT}/apex-26/`;

const log = (m) => process.stderr.write(`[slice] ${m}\n`);
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
for (let i = 0; ; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch { /* not up yet */ }
  if (i > 120) throw new Error("vite preview did not start");
  await new Promise((r) => setTimeout(r, 500));
}
log("server up");

const exe = process.env.PW_CHROMIUM_PATH;
const browser = await chromium.launch({
  ...(exe ? { executablePath: exe } : {}),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const loaded = new Set();
  page.on("request", (r) => { if (r.url().startsWith(BASE)) loaded.add(new URL(r.url()).pathname.replace(/^\/apex-26\//, "")); });
  const t0 = Date.now();
  await page.goto(BASE + (forceGL ? "?gl=1" : ""));
  await page.waitForFunction(() => window.__apex && window.__apex.info().firstFrameMs !== null, null, { timeout: 120_000 });
  const boot = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    return { info: window.__apex.info(), domContentLoaded: nav ? nav.domContentLoadedEventEnd : null };
  });
  log(`first frame at ${boot.info.firstFrameMs} ms`);
  const initialFiles = [...loaded].filter((f) => f && !f.endsWith("/"));

  // Drive: full throttle down the main straight while counting rendered frames.
  const run = await page.evaluate(async (secs) => {
    const api = window.__apex;
    api.setInput({ throttle: true, steer: 0 });
    const f0 = api.info().frames, t0 = performance.now();
    const gaps = [];
    let last = t0;
    await new Promise((res) => {
      const tick = (t) => { gaps.push(t - last); last = t; if (t - t0 < secs * 1000) requestAnimationFrame(tick); else res(); };
      requestAnimationFrame(tick);
    });
    api.setInput(null);
    const i = api.info();
    gaps.sort((a, b) => a - b);
    const heap = performance.memory ? performance.memory.usedJSHeapSize : null;
    return { frames: i.frames - f0, ms: performance.now() - t0, drawCalls: i.drawCalls, triangles: i.triangles,
      p50: gaps[Math.floor(gaps.length * 0.5)], p95: gaps[Math.floor(gaps.length * 0.95)], heap, backend: i.backend };
  }, seconds);

  let gz = 0, raw = 0;
  const files = [];
  for (const f of initialFiles) {
    try {
      const buf = readFileSync(join("dist", f));
      const g = gzipSync(buf, { level: 9 }).length;
      gz += g; raw += buf.length;
      files.push({ file: f, bytes: buf.length, gzip: g });
    } catch { /* not a dist file (a data URL, a 404) */ }
  }
  files.sort((a, b) => b.gzip - a.gzip);
  const out = {
    date: new Date().toISOString(),
    backend: run.backend,
    software: true,
    initialDownload: { gzipBytes: gz, rawBytes: raw, files },
    timeToFirstFrameMs: boot.info.firstFrameMs,
    wallToFirstFrameMs: Date.now() - t0,
    domContentLoadedMs: boot.domContentLoaded,
    fps: (run.frames * 1000) / run.ms,
    frameMs: { p50: run.p50, p95: run.p95 },
    drawCalls: run.drawCalls,
    triangles: run.triangles,
    jsHeapBytes: run.heap,
  };
  mkdirSync("artifacts", { recursive: true });
  writeFileSync("artifacts/slice-metrics.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
  server.kill();
}
