# Local patches on `node_modules`

Applied by [`patch-package`](https://github.com/ds300/patch-package) 8.0.1 from the
`postinstall` script (`patch-package --error-on-fail --error-on-warn`), so `npm ci` and
`npm install` re-apply them. Both flags make drift loud: a hunk whose context no longer
matches, or a patch written for a different package version, exits non-zero and fails
the install. `tests/unit/boot-three-patches.test.ts` then greps the installed build for
each patch's marker, so an install that skipped the hook (`--ignore-scripts`) turns
`npm test` red.

## `three+0.186.1.patch`

Patches `node_modules/three/build/three.webgpu.js` only: `three/package.json` maps the
`./webgpu` export to that file, and it is what Vite bundles for `import "three/webgpu"`.
`build/three.webgpu.nodes.js` carries the same code but nothing here imports it; patch it
too before anything does.

Both edits are ported from f1-game's `vendor/three-patches/patches.mjs` (ids 1 and 4;
rationale in its `vendor/three-0.186.1/PATCHES.md`), which applies them as exact-count
string edits to the same readable npm r186 build.

### #1 swizzle: Chromium 141 rejects the r185+ texture-view descriptor

`GPUTextureViewDescriptor` sets `this.swizzle = 'rgba'` in its constructor and in
`reset()`, and passes it into every `createView()`. Chromium 141 validates `swizzle` as a
`GPUTextureComponentSwizzle` dictionary, so the string throws on every render pass
(shadow maps, environment probes, then `present()` on the first frame). An identity
swizzle carries no information, so both sites become `undefined`.

Upstream: unfixed in r186 and on `dev` as of f1-game's check (2026-09-22). The right fix
upstream is a feature gate on `device.features.has('texture-component-swizzle')`. No
upstream issue is filed (f1-game's draft: `docs/notes/UPSTREAM-THREE-ISSUES.md` §1).
Marker: `// apex-26 patch #1` (two sites).

### #4 `var<private>`: WebKit's 8 KB private address space

iOS/Safari 26 refuses a WGSL module whose module-scope `var<private>` declarations sum past
8,192 bytes ("The combined byte size of all variables in the private address space
exceeds 8192 bytes"). `WGSLNodeBuilder` emits every node variable as a module-scope
`var<private>`; a lit material easily declares more than that, and on an iPhone the
pipeline fails and only the sky draws. Dawn does not check the sum, so no Chromium run
sees it.

The builder already has the function-scope form (compute uses it when
`allowGlobalVariables` is false). Three edits: `buildCode()` asks `getVars()` for global
vars only for compute, and the vertex and fragment templates move their `// vars` block
from module scope to the top of `main()`. Safe as long as no layouted helper `fn`
(`Fn().setLayout(...)`) reads a node variable; only `main` may. `varyings`, `output` and
`instanceIndex` stay `var<private>`.

Upstream: unfixed on `dev` as of 2026-09-22 (the related TSL perf work, #34386 / PR
#34531, does not touch the scoping). No upstream issue is filed (f1-game's draft:
`docs/notes/UPSTREAM-THREE-ISSUES.md` §2). Marker: `// apex-26 patch #4`.

Both patches are WebGPU-backend-only. Under SwiftShader (no WebGPU adapter) the game
boots on WebGL2, so CI never exercises them; they need a real Chromium 141+ GPU and a real
iPhone.

## Changing a patch

Edit the file under `node_modules/`, then run `npx patch-package three`, which rewrites
`three+<version>.patch`. Update the markers in `tests/unit/boot-three-patches.test.ts`
and this file. On a three upgrade, the patch fails to apply: re-derive each edit against
the new source, or delete it once upstream has fixed it.
