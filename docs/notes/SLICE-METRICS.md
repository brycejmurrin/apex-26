# Slice metrics: Monza time trial (PLAN T1.13)

How to reproduce:

```sh
npm run build
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium node tools/metrics/slice.mjs --seconds 10
# writes artifacts/slice-metrics.json
```

The script serves `dist/` with `vite preview`, loads the app in Chromium at 1280x720,
waits for the first rendered frame (`__apex.info().firstFrameMs`), then drives full
throttle down Monza's main straight for 10 s while counting rAF frames. "Initial
download" is every `dist/` file the page requested up to the first frame, each
gzipped at level 9 (GitHub Pages serves gzip).

## Run 1: cloud container, headless Chromium, SwiftShader (no GPU)

2026-10-18, `main` at fbdec7a plus the metrics hooks (`lane-shell/t1.13-slice-metrics`).

| metric | value | gate (PLAN Checkpoint 1) |
|---|---|---|
| initial download, gzip | **353 KB** (1.20 MB raw): renderer chunk 245 KB, main 108 KB | ≤ 3 MB gz before audio: **pass** |
| time to first frame | 1.73 s from navigation start (DOMContentLoaded 1.15 s) | (no gate) |
| fps, driving | 1.2 fps; frame time p50 750 ms, p95 2.2 s | ≥ 60 desktop, ≥ 30 iPhone: **not measurable here** |
| draw calls per frame | 23, every pass (shadow, scene, bloom, composite) | (no gate; f1-game's WebGL2 bottleneck is per-object cost) |
| triangles per frame | 194k | |
| JS heap | 29 MB | |
| backend | WebGL2 (no WebGPU adapter in the container) | |

**This run has no GPU.** SwiftShader renders on the CPU, so the fps and frame
times are a software floor, not evidence about the gate. Download size, draw calls,
triangle count and heap do not depend on the GPU and stand as measured.

The time to first frame includes building Monza on the main thread (about 0.8 s in
Node). The track lane's worker build (`src/track/build/client.ts buildInWorker`)
would take that off the main thread; whether it is worth wiring depends on the
hardware numbers below.

## Not yet measured (needs real devices)

| target | how | status |
|---|---|---|
| desktop Chrome (WebGPU) | `node tools/metrics/slice.mjs` on a machine with a GPU, or the deployed site with the Performance panel | not run |
| desktop Safari (WebGL2, boot policy) | deployed site, Web Inspector timelines | not run |
| iPhone (WebGL2) | deployed site, Safari remote inspector | not run |

The ≥ 60 / ≥ 30 fps gate and "feels the same as f1-game" are Bryce's calls on
hardware (PLAN Checkpoint 1).
