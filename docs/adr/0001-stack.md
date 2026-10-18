# ADR-0001: Rebuild Apex 26 on TypeScript + Vite + three.js WebGPURenderer

**Status:** Proposed
**Date:** 2026-10-18
**Deciders:** Bryce Murrin

## Context

[f1-game](https://github.com/brycejmurrin/f1-game) is a ~269k-line vanilla-JS
browser F1 game: 519 IIFE files loaded by 283 `<script>` tags, no build step,
hosted on GitHub Pages. About 65% of the repo's hand-written text is
infrastructure (≈388k lines of tests/tools, ≈107k lines of docs, 16 CI
workflows), much of which exists to compensate for having no compiler:
hand-maintained load order (`tools/manifest.cjs`, 202 `HARD_EDGES`), a
hand-checked 258-member `G` façade (`types/game-ctx.d.ts`), generated shell
blocks, cache-busting rewrites, and three hand-maintained renderers (raw
WebGL2 "GLX", three.js "TLX", raw WebGPU "WGX", ≈36k lines) whose shaders
are kept in parity by hand.

f1-game's own August 2026 redesign panel
(`docs/research/ARCHITECTURE-REDESIGN-2026-08.md`) rejected an in-place
TypeScript conversion chiefly because of migration risk inside a live,
multi-agent codebase. A separate repo (`apex-26`) removes that risk: f1-game
keeps shipping while apex-26 is built beside it.

Forces:

- **Hosting is GitHub Pages**: static files, no custom headers (so no
  COOP/COEP → no `SharedArrayBuffer` → no WASM threads), fixed
  `cache-control: max-age=600`, gzip only (no Brotli), 1 GB site cap,
  100 GB/month soft bandwidth, Actions-based deploys (10-min timeout).
- **Browsers**: WebGPU is on by default in Chrome/Edge, Safari 26
  (macOS/iOS) and Firefox (Windows, macOS); still missing on Firefox
  Linux/Android and some Android/Linux GPUs → WebGL2 fallback is mandatory.
  f1-game measured that three's WebGPU backend misdraws silently on iOS
  WebKit, so iOS runs three's WebGL2 backend today.
- **Maintainers are mostly AI agents** working in parallel. Compiler-checked
  contracts beat prose rules and bespoke guard scripts.
- **The physics feel is the product**: the port must drive identically, and
  the "arc must not reach the driver" invariant must survive.

## Decision

Build apex-26 as a **TypeScript 7 + Vite 8 single-page app**, rendering with
**three.js `three/webgpu` (WebGPURenderer + TSL, built-in WebGL2 fallback)**
as the only renderer, deployed to GitHub Pages by Actions. Port f1-game code
mechanically where it is pure (track engine, circuit data, physics, car
geometry, TLX renderer), rewrite where it is coupled to `G` or the DOM, and
gate the physics port against bit-exact golden traces produced by f1-game's
existing headless Node VM.

## Options considered

### A. TypeScript + Vite + three.js WebGPURenderer (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium — same language family; most pure code ports by codemod |
| Cost | Months, incremental, playable from the first slice |
| Performance | Same JIT as today; WebGL2 per-object CPU cost is the known bottleneck (f1-game PERF-HUNT-4 G1) → design for instancing |
| Team/agent familiarity | Highest — TS/three.js are the best-covered stack in model training data |

**Pros:** reuse of TLX (already r186 WebGPURenderer/TSL), physics, track
engine and 52 circuit defs; DOM/WebRTC/WebAudio/WebXR/gamepad with zero
interop cost; content-hashed builds and dynamic imports replace the manifest
and cache-busting machinery; `tsc` replaces façade/contract guard scripts;
one renderer instead of three.
**Cons:** three.js needs f1-game's 10 live patches (patch-package) until
upstreamed (r187 retires 4); TypeScript 7 has no programmatic API until 7.1,
so typescript-eslint runs on the TS 6 compat package meanwhile.

### B. Rust (wgpu + winit, Rapier) compiled to WASM

| Dimension | Assessment |
|---|---|
| Complexity | High — full rewrite, nothing reused |
| Cost | Year+ before parity |
| Performance | Single-threaded on Pages; JS↔WASM boundary costs often exceed gains for chatty code |
| Familiarity | Medium; Bevy alternative churns its API every 3–6 months |

**Pros:** one language for engine and logic; strong typing; WebGPU + WebGL2
via wgpu.
**Cons:** every browser API (DOM HUD/menus, WebRTC, WebAudio, WebXR, fetch,
gamepad) crosses wasm-bindgen; no hot reload on wasm; weaker in-browser
debugging; zero code reuse.

### C. Engine (Unity 6.6 Web / Godot 4.7)

**Rejected.** Unity: ≥10 MB Brotli builds (Pages can't serve Brotli),
slow builds, binary editor agents can't drive. Godot: C# cannot export to
web; GDScript web export is WebGL2-only.

### D. Keep f1-game, harden in place ("Bedrock", the August verdict)

Still valid for f1-game itself. Not chosen for apex-26 because the goal is a
clean codebase without the compensating infrastructure.

## Trade-off analysis

Option A keeps everything that makes f1-game work (the TLX renderer, the
physics, the data) and deletes what only exists because there is no
compiler. Option B buys a language change at the cost of all reuse and of
free browser-API access — the parts of this game that are *not* rendering
(menus, multiplayer, audio, data hub) are a majority of the code. A compiled
core can still be added later for a measured bulk hotspot (e.g. AI rollouts)
without changing this decision.

## Consequences

- **Easier:** adding a file (write the import), refactoring across modules
  (the compiler finds callers), cache busting (hashed filenames), shipping
  per-feature chunks (dynamic `import()`), keeping renderer behaviour
  consistent (one backend).
- **Harder:** a build is now required to run the game; vendored-three patches
  must be re-applied on each three upgrade; the f1-game test harness does
  not carry over and must be rebuilt (smaller, typed).
- **Revisit:** WebGPU on iOS once three's WebGPU backend renders correctly on
  WebKit; WASM threads if hosting moves off Pages (Cloudflare/Netlify allow
  COOP/COEP); TypeScript 7.1 programmatic API for linting.

## Action items

See [`docs/PLAN.md`](../PLAN.md).

## Sources

- GitHub Pages limits — https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- Vite static deploy — https://vite.dev/guide/static-deploy ; Vite 8 — https://vite.dev/blog/announcing-vite8
- three.js WebGPURenderer (WebGL2 fallback, `forceWebGL`, `init()`) — https://threejs.org/docs/pages/WebGPURenderer.html
- vite-plugin-pwa injectManifest — https://vite-pwa-org.netlify.app/guide/inject-manifest
- WebGPU implementation status — https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
- coi-serviceworker (COOP/COEP workaround) — https://github.com/gzuidhof/coi-serviceworker
- TypeScript 7 — https://devblogs.microsoft.com/typescript/
- Rapier determinism — https://rapier.rs/docs/user_guides/javascript/determinism
- Godot C# web export status — https://docs.godotengine.org/en/4.7/tutorials/scripting/c_sharp/index.html
- Rust/WASM boundary cost — https://urandom.io/blog/2026-03-21-rust-wasm-slower-than-typescript
- Strangler fig — https://martinfowler.com/bliki/OriginalStranglerFigApplication.html
- f1-game evidence: `docs/research/ARCHITECTURE-REDESIGN-2026-08.md`,
  `docs/ARCHITECTURE.md` (iOS WebGPU misdraw), `vendor/three-0.186.1/PATCHES.md`,
  `docs/notes/PERF-HUNT-4-2026-10-14.md`, `tools/lib/game-vm.cjs`
