# apex-26 — engineering reference

A rebuild of [f1-game](https://github.com/brycejmurrin/f1-game) as TypeScript 7 (strict,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) + Vite 8 + three.js 0.186.1
(`three/webgpu`, WebGL2 fallback) + Vitest + Playwright, deployed to GitHub Pages.
The plan is `docs/PLAN.md`, the stack decision `docs/adr/0001-stack.md`, and the
parallel lane map `docs/FLEET.md`. This file holds the rules every session needs.

## The loop

```sh
npm ci              # once per checkout; exact versions from package-lock.json
# edit
npm run check       # tsc --noEmit (src + tests) and vitest run
npm run build       # vite build: must stay green
npm run e2e         # Playwright smoke; run it when you touch boot, render or input
```

Every task ends with `npm run check` and `npm run build` green. Report anything you did
not run as not run.

## Branches and PRs

- One task per draft PR. Link its issue with `Closes #<n>` in the body.
- Merge commits only: never squash or rebase-merge, never force-push a shared branch.
- Changes to `src/contracts/` go in their own PR, never inside a lane PR. Lanes ask the
  coordinator for a contract change; they do not make it.
- Phase 1 lanes touch disjoint directories (see `docs/PLAN.md` §Phase 1).

## Contracts (`src/contracts/`)

The seams Phase 1 codes against: `TrackQuery` (track.ts), `PlayerInput`, `AssistInput`,
`SimCtx`, `CarState` (sim.ts), `RenderSeam` (render.ts), `SceneryApi` (scenery.ts).
Each member cites the f1-game file:line it came from; keep that true when you edit one.
`tests/unit/contracts.test.ts` holds compile-time assertions that `tsc` checks.

## The arc rule

The arc must not reach the driver: nothing derived from track curvature or the racing
line may affect the player with assists off (f1-game `AGENTS.md` §Physics and the
`docs/PHYSICS.md` "Curvature channels" table). Here it is enforced by type:
`PlayerInput` has no curvature or racing-line field, `TrackQuery` has no `curvature()`,
and assists arrive only through the separate, opt-in `AssistInput`, each value behind a
gain that defaults to 0. Do not add an `ArcKey` field to the player path.

## Porting from f1-game

- Port verbatim first, refactor only under green goldens (`tests/goldens/`).
- Keep float math in f1-game's operation order: no re-association, no `**` in place of
  `Math.pow` (or the reverse), no `Math.hypot` swaps, no hoisting that changes rounding.
  Physics goldens are bit-exact (`Object.is`).
- Keep f1-game's array types where it uses typed arrays (track nodes are `Float32Array`;
  scenery accumulators `Float64Array`).
- Speeds compare through `vTop()` / `vStd()`; `PACE` is a ground-speed scale, not a cap.
- Coordinates: +Y up, metres, radians, arc `s`, lateral `x` +right; +k = left turn.

## Code rules

- No `any`. Use `unknown` with a `TODO` naming the task that will type it.
- ES modules and `import`; no globals, no IIFEs, no god object (f1-game's `G` becomes
  explicit typed contexts per subsystem).
- localStorage keys are prefixed `a26.` (f1-game owns `apex26.` on the same origin).
- Generated or regenerable output goes in `dist/`, `artifacts/` or `scratch/`, never `/tmp`.

## f1-game is the reference

Read it to port or to answer "how did f1-game do this?", and cite file:line. Never edit,
commit or push to f1-game from an apex-26 session; f1-game changes (for example the
physics oracle, PLAN T1.4) are separate PRs made under f1-game's own AGENTS.md.
