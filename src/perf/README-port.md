# src/perf/ — port notes

Ported from f1-game `js/perf/` (data lane). Each `.ts` file cites its source in
its header; logic, float operation order and the WHY comments are verbatim, the
IIFE singletons became `create*()` factories, and every former global arrives as
an injected dependency. Storage keys are `a26.*` (f1-game owns `apex26.*`).

| f1-game | apex-26 | notes |
|---|---|---|
| `governor.js` | `governor.ts` | `PerfGov` decision logic in full; bit-exact against the original (tests/unit/perf/governor.test.ts). Renderer = injected `PerfGfx`; `createScaleGfx()` implements TLX's `setRenderScale` / `capDpr` contract over a pixel ratio. `renderScaleReport()` is f1-game `__apex.perf()` (js/agent/apex.js:1623). |
| `thermal-drift.js` | `thermal-drift.ts` | verbatim, bit-exact. |
| `render-rate.js` | `render-rate.ts` | verbatim, bit-exact. Key `a26.renderRate`. |
| `loop-health.js` | `loop-health.ts` | verbatim, bit-exact. |
| `spans.js` | `spans.ts` | verbatim, bit-exact. |
| `race-entry-profile.js` | `race-entry-profile.ts` | verbatim; `softwareRaster` and the clock injected; loading screen / session entry typed as seams. |
| `quality-preset.js` | `quality-preset.ts` | the GRAPHICS presets; button → `mount(el, deps)`. |
| `metrics-overlay.js` | `metrics-overlay.ts` + `perf.css` | `mount(host, deps)` builds the METRICS fold into `host`; painted text matches f1-game line for line (tests/unit/perf/dom.test.ts). |
| `gfx-debug-overlay.js` | `gfx-debug-overlay.ts` | backend-neutral parts only (below). |
| `three-inspector.js` | `three-inspector.ts` | dynamic `import("three/addons/inspector/Inspector.js")`, its own chunk. |
| `phone-recorder.js` | `phone-recorder.ts` + `perf.css` | recorder state machine verbatim; live readers read injected sources. |
| `soak-run.js` | `soak-run.ts` | control law bit-exact; curvature is a separate soak-only `SoakHost.curvature` (arc rule, see the file header). |
| `renderer-picker.js` | — | **not ported**, see below. |

## What the shell frame loop and the render lane call

- **Shell (`src/sim/loop.ts`, `src/app/`)**, per rAF: `renderRate.observe(ms)`;
  fixed physics steps; `perfGov.recordSimulation(steps, dropped)`; while racing
  and not paused `perfGov.tick(dtMs)`; `if (renderRate.gate(dt, ms, xrPresenting, racing))`
  render + HUD with `renderRate.dt()`; wrap the frame body in try/catch with
  `loopHealth.clean()` / `if (!loopHealth.fault(e)) throw e`; bracket phases with
  `perfSpans.begin/end(name)`. Race lifecycle: `perfGov.sentinelArm(true)` at
  race start, `cleanRace()` at a finished race, `sentinelArm(false)` on quit,
  `sentinelResume()` on a tab return. Race entry: `raceEntryProfile.beginUi()` /
  `runSession()` / `lap()` / `afterPresent()`. Settings: `mountGfxQuality(btn, …)`,
  `mountMetrics(displayPanel, …)`, `mountPhoneRecorder(metricsFoldBody, …)`,
  `mountGfxDebug(…)`, `createThreeInspector().boot(host)`.
- **Render lane**: `perfGov.init(gfx)` once the renderer is up, with a `PerfGfx`
  (`createScaleGfx({ isMobile, apply: (pr) => trackRenderer.resize(w, h, pr) })`);
  gate features on `perfGov.tier()` (cost ladder: 1 env probe, 2 lamp shadow +
  dry SSR, 3 car sun shadow + wet SSR, 4 SSAO / god rays / bloom) and look-defining
  post on `autoTier()` / `autoShed()`; read `a26.gfxHigh` at renderer init for the
  mobile boot tier.

## Injected seams (TODO owners)

| seam | where | owner |
|---|---|---|
| `PerfGfx` (render scale, DPR cap, software-raster flags) | governor.ts | TODO(lane-render): TrackRenderer should own the scale |
| `backend()` = `{ name, reason }` from `BootResult` | metrics, gfx-debug, phone-recorder | TODO(lane-render) |
| `gpuErrors()`, `rendererMemory()` / `rendererInfo()` (three `renderer.info`), `extraLines()` | gfx-debug, metrics, phone-recorder | TODO(lane-render) |
| `InspectorHost` (renderer + GPU-timer hold) | three-inspector.ts | TODO(lane-render) |
| `EntryGfx` (warm / warming / ctxLost), `HandoffScreen`, `SessionEntry` | race-entry-profile.ts | TODO(lane-render) / TODO(lane-shell) |
| `MetricsSources` (info, timing, probe, physState, camera, caution, dashKph) | metrics-overlay.ts | TODO(lane-shell): the debug API (`src/debug/api.ts`) |
| `MetricsLog` (levels + record ring), `setPerfLog` sink | metrics-overlay.ts, env.ts | TODO(lane-shell): the shared logger |
| `SettingRowApi` | setting-row.ts | TODO(lane-shell); until then the one-button cycle fallback |
| `SoakHost` (app state, input override, pause, startRace, camera) | soak-run.ts | TODO(lane-shell) |
| `SoakHost.curvature` | soak-run.ts | TODO(lane-track): a soak-only channel, never on `TrackQuery` |
| `reapplyLighting`, `uiSelect` | quality-preset.ts, metrics-overlay.ts | TODO(lane-render), TODO(lane-audio) |

## Dropped as GLX / WGX-specific

- **governor.js**: nothing in the decision logic. Only the facade changed (see above).
- **metrics-overlay.js**: the GOV page's `tlx` line (TLX blit / readback /
  pack / heal / draw-call / ARRAYNEAREST / matMode counters),
  `RendererPicker.liveBackend()` and the `apex26.gfxBackend` pick. The `gfx`
  row shows the bound backend and its boot reason instead.
- **gfx-debug-overlay.js**: `picks()` (gfxBackend / tlxForceGL / gfxBound /
  gfxTlxFail / gfxWgxFail), the `data-engine` canvas stamp, `pushThreeState`
  (TLX backendState / envState / skyState / chunkState / postState) and
  `pushFrameState` (the GLX/WGX soft-blit `#game-soft` readback and
  softPresentState). `DevFlags` is not ported; `?gfxdebug=1` / `a26.gfxDebug`
  arm it directly.
- **phone-recorder.js**: `backendPick` (TLX api / path / pin / softBlit /
  packLive) and the three-path A/B how-to; samples record `backend` + boot
  `reason`, and the A/B is the `?gl=1` pin.
- **three-inspector.js**: the "TLX only, a software-GL boot may pick GLX"
  refusal — apex-26 always boots three.js.

## renderer-picker.js: not ported

f1-game's RENDERER control chose between three backends (GLX = raw WebGL2,
WGX = raw WebGPU, three.js = TLX) and the THREE PATH inside three.js. apex-26
has one renderer, three.js `WebGPURenderer` with its WebGL2 fallback, and the
render lane's `src/render/policy.ts` + `boot.ts` choose the path at boot.

Covered by policy.ts / boot.ts:
- THREE PATH AUTO / WEBGL2 / WEBGPU (`apex26.tlxForceGL`) → the `?gl=1|0` pin
  (`parsePin`) and auto (`chooseBackend`).
- WEBGPU "UNAVAILABLE" when `navigator.gpu` is missing → `no-adapter` reason,
  WebGL2 bound without asking.
- WebKit forced onto WebGL2 on auto (tlx.js `isWebKit`) → `webkit` reason.
- `liveBackend()` (what is drawing, not what was picked) → `backendName(renderer)`
  and the `silent-fallback` / `init-retry` reasons.
- A WebGPU init throw retried once on WebGL2 → `init-retry`.

Dropped (no equivalent needed, or someone else's when it is):
- the three-way GLX / THREE.JS / WEBGPU picker, its `<select>` + ‹ › control,
  the `ApexRoster.DEFERRED` availability check and the UNAVAILABLE dialog;
- persisted backend prefs and RESET RENDERER (`clearRendererStorage` over the
  `apex26.gfx*` / `wgx*` / `tlx*` keys): apex-26 persists no backend choice; the
  pin is URL-only (a persisted pin would be the shell's settings, if wanted);
- the in-race two-tap reload confirm (`raceGuard` / ARM_MS) shared by reloading
  controls: GRAPHICS (quality-preset.ts) keeps its own rule — in a race the boot
  tier waits for the next natural reload;
- CAR REFLECTIONS (`apex26.tlxEnvProbe`), SCREENSHOTS / SAVE SCREENSHOT
  (`wgxCapture` readback), `#pm-gfx-status` post health: render-lane features if
  they come back;
- COPY DIAG (`playerDiag`): the gfx-debug COPY button and the phone recorder's
  facts carry the same report.

## Deviations

- Factories instead of singletons; `perfGov`, `perfSpans`, `loopHealth`,
  `renderRate`, `raceEntryProfile` are the shared instances (./index.ts).
- governor: an un-init'ed governor evaluates against a no-op gfx (f1-game would
  throw at its first evaluation); the build id defaults to
  `src/net/handshake.ts` `metaBuild()` (f1-game `window.__APEX_BUILD`).
- three-inspector: teardown restores the renderer's original `InspectorBase`
  instead of assigning `null` (three's setter would throw).
- metrics-overlay: the summary is built with DOM nodes, not `innerHTML`;
  `mount()` builds the fold in one call where f1-game polled for it on timers;
  `unmount()` removes listeners.
- soak-run: `startRace({ track, laps, weather })` replaces writing `G.trackIdx`,
  `G.raceWeather`, … directly; the PAUSE is `host.pause()`, not a click on
  `#pausebtn`.
- quality-preset: `a26.gfxPreset` is a raw key (f1-game kept it on GameStore's
  typed lane).
