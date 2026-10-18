# Implementation plan: apex-26 (rebuild of f1-game)

**Status:** draft for review · **Date:** 2026-10-18 · **Decision record:** [ADR-0001](adr/0001-stack.md)

## Overview

Rebuild [f1-game](https://github.com/brycejmurrin/f1-game) as a TypeScript 7 +
Vite 8 app rendering with three.js `three/webgpu`, deployed to GitHub Pages.
f1-game keeps shipping until apex-26 reaches parity. The first milestone is a
**playable vertical slice** (Monza time trial: real track, real physics, one
car, chase camera, minimal HUD) that is also the go/no-go gate for the full
port.

Guiding rule: **port what is pure, rewrite what is coupled.** The inventory of
f1-game (2026-10-18) says the pure layers are large and already run headless:

| f1-game layer | lines | coupling | plan |
|---|---|---|---|
| `js/circuits/` defs (52) | ~4k | pure data, one schema, JSON-safe | codemod → typed TS data |
| `js/circuits/scenery/` (52) | ~41k | `scenery(api)` closures | codemod → `export default (api: SceneryApi) => …` |
| `js/track/` engine | 15.5k | pure (gfx injected) | port; already runs in Node VM + Worker |
| `js/physics/` | 7.7k | mostly pure; ≤9 `G` members per file | port behind a typed `SimCtx` |
| `js/game.js` player step (`updateCar*`, ≈4910–6660) | ~1.75k | `G`-coupled | port verbatim into `src/sim/`, gated bit-exact |
| `js/car/` geometry (`car3d` and deps) | ~8k | pure mesh data | port; rewrite `car-draw.js` on three |
| `js/render/three/` (TLX) | 14k | already r186 WebGPURenderer/TSL | re-host as the only renderer |
| `js/render/glx/`, `js/render/webgpu/` | 21.7k | — | **drop** |
| `js/lighting/presets.js` | 7.3k | pure data literal | codemod → JSON |
| `js/ui/`, `js/race/`, `js/net/`, `js/audio/`, … | ~90k | `G` + DOM heavy | rewrite against typed state, wave by wave |
| `js/agent/` (`__apex`) | 6.7k | reads 136 `G` members | replace with a small typed debug API |

## Architecture decisions

1. **Stack:** TypeScript 7 (`strict`, `tsc --noEmit` as the checker), Vite 8
   (Rolldown), three.js 0.186.1 (`three/webgpu`, TSL), Vitest, Playwright,
   vite-plugin-pwa 2 in `injectManifest` mode. Pages deploy via
   `configure-pages@v6` / `upload-pages-artifact@v5` / `deploy-pages@v5`,
   `base: '/apex-26/'`.
2. **One renderer.** WebGPURenderer with its built-in WebGL2 fallback. Keep
   f1-game's measured policy: **force WebGL2 on WebKit** (iOS misdraws
   silently on three's WebGPU backend) and when `requestAdapter()` fails.
3. **three.js patches** from f1-game (`vendor/three-0.186.1/PATCHES.md`, 10
   live) are carried with `patch-package`. #1 (swizzle, Chromium 141) and #4
   (`var<private>`, WebKit 8 KB cap) are correctness blockers and land in
   Phase 0; the perf patches land with the renderer. Upgrade to r187 retires
   #6, #9, #10, #15.
4. **Single-threaded by design.** Pages cannot send COOP/COEP, so no
   `SharedArrayBuffer`. Workers are fine (track build already runs in one);
   shared-memory threads are not.
5. **Fixed step 1/60 s, accumulator with max 5 substeps, render interpolation**
   — the f1-game loop (`game.js` `tickBody`), ported as is.
6. **The arc must not reach the driver — by type.** The player physics input
   type has no curvature or racing-line field; assists are a separate,
   opt-in input. (f1-game `AGENTS.md` §Physics, `docs/PHYSICS.md` table.)
7. **No global façade.** f1-game's 258-member `G` becomes explicit typed
   context objects per subsystem (`SimCtx`, `RenderCtx`, …), each a superset
   added wave by wave — never one god object.
8. **Plain DOM for the HUD**, updated at a throttled rate, never per frame
   through reactive state. Menus: plain DOM in Phase 1; framework choice is an
   open question.
9. **Assets ship as hashed files** with a service-worker precache (Pages'
   `max-age=600` is not configurable). Compression lives in the formats
   (KTX2/Basis textures, meshopt glTF), since Pages serves gzip only.
10. **Storage keys are prefixed `a26.`**, not `apex26.`: both games live on the
    origin `brycejmurrin.github.io`, so they share `localStorage`. Importing
    f1-game saves is a deliberate migration step (Phase 5), never a collision.

## Source layout (target)

```
src/
  main.ts            boot: renderer policy, loop, screens
  contracts/         cross-lane interfaces (track query, sim ctx, renderer seam, scenery api)
  core/              math (mat4), hash, log, store
  track/             ported engine: core/ (spline, mesh, surface, pit, …), scenery/ kits
  circuits/          defs/<id>.ts (data), scenery/<id>.ts (closures), index.ts (curated order)
  physics/           consts, tyre-model, grip-steer, player-forces, wall-clamp, collide
  sim/               player-step (updateCar* port), race state, loop
  render/            three backend (from TLX), materials (TSL), post, car draw
  car/               car geometry (from car3d), liveries
  camera/ input/ hud/ audio/ race/ ui/ net/ …   (later waves)
  debug/             window.__apex (typed, small)
tests/
  unit/              Vitest (track, physics oracle, data schema)
  e2e/               Playwright smoke (boot, drive, backend label)
  goldens/           physics + track traces produced by f1-game
tools/               codemods and oracle import scripts
```

## Task list

Sizes: S = 1–2 files, M = 3–5. Anything larger is split. Every task ends with
`npm run check` (typecheck + lint + unit) and `npm run build` green.

### Phase 0 — Foundation (sequential, one session)

- [ ] **T0.1 Scaffold the app** (M)
  - Vite 8 + TS 7 strict + three 0.186.1 + Vitest + ESLint (typescript-eslint on the TS 6 compat package); scripts `dev`, `build`, `preview`, `check`, `test`, `e2e`.
  - `src/main.ts` boots WebGPURenderer, awaits `init()`, draws a lit cube, and shows the active backend (`WebGPU` / `WebGL2`).
  - **Accept:** `npm run build` emits hashed assets; `npm run preview` shows the cube and backend label.
- [ ] **T0.2 CI and Pages deploy** (S) — depends on T0.1
  - `.github/workflows/ci.yml` (check, build, Playwright smoke on PRs) and `deploy.yml` (build → Pages on `main`); `base: '/apex-26/'`.
  - **Accept:** a push to `main` publishes https://brycejmurrin.github.io/apex-26/ showing the cube; PR CI is a required check.
- [ ] **T0.3 Renderer boot policy and correctness patches** (M) — depends on T0.1
  - `patch-package` with f1-game patches #1 and #4; boot policy: WebKit → `forceWebGL`, no adapter → `forceWebGL`, WebGPU init throw → retry on WebGL2; `?gl=1|0` pin for testing.
  - **Accept:** deployed page renders on desktop Chrome (WebGPU), Firefox, and an iPhone (WebGL2); Playwright pins WebGL2 under SwiftShader.
- [ ] **T0.4 Contracts and repo rules** (M) — depends on T0.1
  - `src/contracts/`: `TrackQuery` (sample, banking, onKerb, inPitLane, wallAt, wrapS), `PlayerInput` (no curvature), `SimCtx` (≈25 members from f1-game's physics `G` reads), `RenderSeam`, `CircuitDef`, `SceneryApi`.
  - `AGENTS.md` (+ `CLAUDE.md` importing it): the loop, branch/PR rules, the arc rule, "contracts change only in their own PR".
  - **Accept:** contracts compile; each has a one-line doc comment citing its f1-game source.

**Checkpoint 0:** deployed site boots on desktop + iPhone; CI green; contracts reviewed by Bryce before lanes start.

### Phase 1 — Vertical slice: Monza time trial (four parallel lanes)

Lanes start once T0.4 merges and touch disjoint directories. Changes to `src/contracts/` go in their own PR, never inside a lane PR.

**Lane A: track** (`src/track/`, `src/circuits/`, `tools/codemod-*`)
- [ ] **T1.1 Circuit defs codemod** (M)
  - Script loads all 52 f1-game defs in a Node VM and writes `src/circuits/defs/<id>.ts` typed as `CircuitDef` (17 required keys, 26 optional), plus `index.ts` in f1-game's curated `CIRCUITS` order.
  - **Accept:** a Vitest round-trip test shows each TS def deep-equals the f1-game def; the codemod is re-runnable.
- [ ] **T1.2 Port the track core** (M)
  - geom, spline, line, mesh, surface, pit, space, def (the `TRACK_VM` core) → `src/track/core/`; `TrackBuildProps` stubbed to empty for now.
  - **Accept:** `buildTrack('monza')` returns mesh buffers in Node.
- [ ] **T1.3 Track parity goldens** (S) — f1-game PR + apex-26 test
  - f1-game script dumps `Tracks.sample/banking/onKerb/wallAt` at 2,000 `s` values × 5 lateral `x` for Monza; apex-26 compares.
  - **Accept:** bit-exact (`Object.is`) for Monza.

**Lane B: physics** (`src/physics/`, `src/sim/`, `tests/goldens/`)
- [ ] **T1.4 Physics oracle in f1-game** (M) — f1-game PR, following its AGENTS.md
  - `tools/check/physics-oracle.mjs` on `tools/lib/game-vm.cjs`: Monza, AI retired, assists off, wear/wind/weather pinned, `TrackScenery` loaded.
  - Replays the 4 physics-characterization recipes plus one recorded InputGhost v3 lap; dumps raw doubles per step (s, x, px, pz, head, speed, vLat, yawRateCur, prog, gear, steerSm, kerbGripSm, slips) and the per-step track-query results, stamped with `REVISION`, seed and sha.
  - **Accept:** goldens are deterministic across two runs; committed to apex-26 `tests/goldens/`.
- [ ] **T1.5 Port physics modules** (M)
  - consts, tyre-model, grip-steer, player-forces, wall-end-face, wall-clamp, collide (player-vs-wall only) → `src/physics/`.
  - Keep operation order verbatim: no re-association, no `**` for `Math.pow`, no `Math.hypot` swaps.
  - **Accept:** each module compiles against `SimCtx`, with unit tests ported from f1-game where they exist.
- [ ] **T1.6 Port the player step** (M) — depends on T1.5, T1.4
  - `updateCar` → `BrakePlan` → `Longitudinal` → `Lateral` → `Bicycle` → `WallClamp` → `Advance` (f1-game `game.js` ≈4910–6660, player path only) → `src/sim/player-step.ts`.
  - Track queries come through `TrackQuery`; the test can feed them from the goldens, isolating physics from Lane A.
  - **Accept:** Vitest replays every golden: bit-exact for 300 steps, ≤1e-4 drift at end of trace, first-divergence step reported.

**Lane C: render** (`src/render/`, `src/car/`)
- [ ] **T1.7 Renderer core from TLX** (M)
  - Track mesh upload, sky, sun + shadow map, tone mapping, bloom-lite; follow TLX's `tlx.js` / `tsl-lit.js` structure and f1-game patch list; instanced scenery path stubbed.
  - **Accept:** Monza track renders from a fixed camera on WebGPU and WebGL2; draw-call count logged.
- [ ] **T1.8 Car geometry and draw** (M)
  - Port `car3d` and deps (car-geometry, car-wheels, car-body-geom, car-materials, car-shade, car-material-shade, parts, helmets) to emit three `BufferGeometry`; one livery; wheels instanced.
  - **Accept:** a car renders on the track with correct scale and orientation, matching an f1-game screenshot side by side.

**Lane D: shell** (`src/sim/loop.ts`, `src/input/`, `src/camera/`, `src/hud/`, `src/debug/`)
- [ ] **T1.9 Loop, input and chase camera** (M)
  - Fixed-step accumulator (from `tickBody`); keyboard + gamepad into `PlayerInput`; chase camera from `drive-chase`/`vantage` (minimal).
  - **Accept:** a placeholder body drives around a flat test loop at 60 Hz sim with interpolated render.
- [ ] **T1.10 Minimal HUD** (S)
  - Speed, gear, lap, lap time, last lap; port `hud-readouts.js` (pure); DOM writes throttled.
  - **Accept:** the HUD updates during driving with no per-frame layout thrash (Performance panel shows no forced reflow).
- [ ] **T1.11 Debug API and e2e smoke** (S)
  - `window.__apex = { physState, setInput, step, info }` (typed); Playwright: boot → drive 10 s with scripted input → assert progress > 0 and backend label set.
  - **Accept:** the smoke test runs green in CI.

**Integration**
- [ ] **T1.12 Assemble the Monza time trial** (M) — depends on all lanes
  - Wire track + physics + render + car + shell; start/finish line and lap timing (`RaceControl.lineTransition`).
  - **Accept:** a full lap of Monza is drivable on the deployed site, and lap time is in the same range as f1-game for the same input trace.
- [ ] **T1.13 Measure the slice** (S)
  - Report: initial download (gz), time to first frame, fps / frame time on desktop Chrome, desktop Safari, iPhone; draw calls; JS heap.
  - **Accept:** numbers recorded in `docs/notes/SLICE-METRICS.md` against the gate below.

**Checkpoint 1 — go / no-go gate (Bryce decides):**
- Physics goldens bit-exact for 300 steps on every trace.
- ≥ 60 fps desktop; ≥ 30 fps on iPhone (WebGL2 backend).
- Initial download ≤ 3 MB gz before audio.
- Feels the same as f1-game to Bryce on a blind back-to-back lap.

If any gate fails, fix it or stop with the slice as evidence; f1-game is unaffected either way.

### Phase 2 — Race (after Checkpoint 1; tasks written when Phase 1 closes)

AI field (`ai-drive`, ai-band/corridor, the AI half of `updateCar`), collisions between cars, grid and start lights, sectors, race control (flags, SC/VSC), results. This is where the typed `GameState` store is designed, since f1-game's `race/` reads 117 `G` members. **Gate:** a 22-car Monza race against AI, deterministic under a fixed seed (golden race hash from f1-game).

### Phase 3 — Content

All 52 circuits plus the 41k-line `scenery(api)` closures via codemod (needs build-props and the scenery kits); lighting presets → JSON plus the profile/frame-light logic; night/floodlights with light budgets; the asset pack (PBR texture array; evaluate KTX2); wet surfaces. **Gate:** every circuit builds and renders; per-circuit track goldens bit-exact.

### Phase 4 — Feel

Audio (engine model, sfx, radio, music), full input (touch, tilt, steering tuning), the camera family (onboard, broadcast, flyby, replay, photo), replays and ghosts (InputGhost format, a new key namespace).

### Phase 5 — Modes

Tyres, pits and weather; qualifying; season; career and My Team; garage, parts and liveries; save import from f1-game's `apex26.*` keys.

### Phase 6 — Platform

Multiplayer (WebRTC, Nostr signalling, invite/QR), track designer, data hub (OpenF1/Jolpica), WebXR, PWA offline, Rapier debris/incidents (deterministic build), phone controller, overlay, desktop/Android wrappers.

### Phase 7 — Cutover

Parity checklist against f1-game's `docs/USAGE-PATHS.md`; Bryce decides whether apex-26 replaces f1-game's URL (a redirect page on f1-game) or both stay live.

## Parallel work: sessions and agents

- **Phase 0 is one session.** It sets the contracts everyone else codes against.
- **Phase 1 runs four sibling sessions, one per lane (A–D),** each on its own branch `lane-<x>/<task>`, one draft PR per task. Each launches with the apex-26 repo, auto mode, and this plan's lane section as its brief.
  - Lane B also opens one f1-game PR (T1.4), following f1-game's AGENTS.md (its branch naming, gates and draft-PR rules).
  - Lane A's T1.3 needs a small f1-game script too; it goes in the same f1-game PR as T1.4 or a sibling one.
- **One coordinator (this session or one Bryce names)** owns `src/contracts/`, reviews lane PRs, and does T1.12 integration. Lanes ask for contract changes; they don't make them.
- **Subagents inside a lane** handle read-only work: locating f1-game sources, diffing behaviour, reviewing a PR. Codemods and ports stay in the lane session, which owns verification.
- **Every task is a GitHub issue** in apex-26, linked from its PR with `Closes #n`.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Physics port drifts (float order, hidden-field init) | High | Bit-exact goldens from f1-game's own VM; port verbatim first, refactor only under green goldens |
| three.js WebGPU misrenders on iOS | High | WebKit forced to WebGL2 (f1-game's measured policy); f1-game patch #4 |
| WebGL2 per-object CPU cost (f1-game's top bottleneck) | Med | Instancing and merged chunks from day one; draw-call budget in T1.13 |
| Scope: f1-game has years of features | High | Gate at Checkpoint 1; phases 2–7 are ordered so each ships something playable |
| Unpatched three regressions on upgrade | Med | patch-package fails loudly on drift; upgrade only with the smoke test and goldens green |
| Parallel lanes collide | Med | Disjoint directories per lane; contracts owned by one coordinator |
| Shared origin with f1-game (`localStorage`, service-worker scope) | Med | `a26.` key prefix; SW scoped to `/apex-26/` (Vite `base`) |
| Tooling churn (TS 7 API, Vite 8 plugins) | Low | Pin exact versions; typescript-eslint on the TS 6 compat package until 7.1 |

## Open questions for Bryce

1. **Scope at parity:** all 52 circuits and every mode (XR, editor, data hub, multiplayer), or a trimmed set?
2. **Menu UI:** plain DOM (like f1-game), or a small framework (Solid/Preact) for menus only?
3. **Final URL:** keep `/apex-26/` alongside f1-game, or eventually replace `/f1-game/`?
4. **Sibling sessions:** OK to launch four lane sessions for Phase 1 once Checkpoint 0 passes?
5. **Test-harness budget:** f1-game's tests and tools outweigh the game. Is a deliberately small suite here (goldens + unit + one smoke per feature) acceptable?
