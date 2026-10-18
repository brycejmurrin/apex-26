# Fleet: parallel lanes for the full migration

Bryce asked for the complete migration "using parallel sessions to work as fast as
possible" and said "We can freely merge for a while" (2026-10-18). This file is the
lane map those sessions work from. The coordinator is session
`session_01GiW52Wfj2t9pFRmy26vhby`.

## Rules for every lane

1. **Stay in your directories.** The table below lists what each lane owns. Do not edit
   another lane's directory. If you need something from another lane, message the
   coordinator; meanwhile code against a local interface and leave a `TODO(lane-X)`.
2. **Shared files:**
   - `src/contracts/`: the coordinator's. A lane may *add* a new file for its own seam,
     for example `src/contracts/audio.ts`. Changes to an existing contract go to the
     coordinator.
   - `package.json` and `package-lock.json`: add the deps you need. On conflict, merge
     `origin/main`, re-run `npm install`, and commit the regenerated lockfile. Never
     hand-edit the lock.
   - `src/main.ts`, `index.html` and `src/app/`: the shell lane's. Other lanes export
     functions; the shell wires them in.
3. **Small PRs, merged fast.** Branch `lane-<id>/<topic>` from `origin/main`. Open a draft
   PR with `Closes #n` if there is an issue. Before merging:
   - merge `origin/main` into your branch
   - run `npm ci && npm run check && npm run build` green on that merged tree
   - mark the PR ready and merge it yourself (merge commit, never squash or rebase)
   Aim for a merge every 1–2 hours of work. Do not wait for CI or reviews.
4. **Port, don't reinvent.** f1-game is the reference. Clone it read-only next to the
   repo (`git clone --depth 50 https://github.com/brycejmurrin/f1-game ../f1-game`) and
   cite `file:line` in a header comment on each ported file. Follow AGENTS.md §Porting
   (float operation order, no `any`, no globals).
5. **Running f1-game code:** lane sessions' auto mode refuses to *execute* f1-game code
   (game-vm, TRACK_VM); reading it is fine. For reference output, message the coordinator
   `NEED-DUMP lane-<id> <exact spec>`; it runs the dump and pushes it under
   `tests/goldens/` or `tests/fixtures/` (producers live in `tools/oracle/`).
6. **Tests:** a Vitest unit test for each ported pure module. Wherever f1-game can
   produce reference output (Node VM: `tools/lib/game-vm.cjs`), compare against it.
   Playwright only for boot, render or input changes.
7. **Report:** after each merge, send the coordinator one `send_message` line:
   `MERGED lane-<id> <PR url> <sha> — <what landed>; next: <next task>`.
   When blocked: `BLOCKED lane-<id> <reason>`. Keep going on the next item while you wait.

## Lanes

| id | lane | owns | first tasks (docs/PLAN.md) | then |
|---|---|---|---|---|
| track | track engine | `src/track/core/`, `src/track/build/`, `tests/unit/track-*` | T1.2 track core port; T1.3 track parity goldens | full track build (mesh buffers, pit, surface), build worker, `TrackQuery` impl |
| physics | player physics | `src/physics/`, `src/sim/player-step*`, `tests/goldens/` | T1.5 physics modules; T1.6 player step vs goldens | AI driving (`ai-drive`, ai-band/corridor) in `src/sim/ai/`, car-car collisions |
| render | renderer | `src/render/` (not boot/policy), `src/lighting/`, `src/assets/` | T1.7 renderer core from TLX | lighting presets → JSON, frame lights, floodlights, shadows, post, asset pack, instancing |
| car | car model | `src/car/` | T1.8 car geometry and draw | liveries, parts, helmets, field LOD, livery textures |
| shell | app shell and integration | `src/main.ts`, `index.html`, `src/app/`, `src/sim/loop.ts`, `src/input/`, `src/camera/`, `src/hud/`, `src/debug/`, `tests/e2e/` | T1.9 loop/input/chase cam; T1.10 HUD; T1.11 debug API; T1.12 assemble Monza TT | menus and screens, settings, the camera family, touch/tilt, PWA (`vite-plugin-pwa`) |
| scenery | scenery | `src/track/scenery/`, `src/circuits/scenery/` | port the scenery kits (`js/track/scenery/*`) against `SceneryApi` | codemod all 52 `scenery(api)` closures, build-props, graph batches |
| audio | audio | `src/audio/` | engine sound model (`js/audio/engine.js`, tone-model) on WebAudio | sfx, crowd, radio, announcer, music, voice packs (lazy-loaded assets) |
| race | race and modes | `src/race/`, `src/modes/` | pure race rules: race control, flags/SC/VSC, start lights, sectors, points, results | tyres/pits/weather, quali, season, career and My Team (save import from `apex26.*`) |
| data | data hub | `src/data/` | OpenF1 + Jolpica clients (typed) with caching | Data Hub tabs: schedule, standings, last race, live, telemetry, export |
| net | multiplayer | `src/net/` | WebRTC transport, Nostr signalling, invite/QR (`js/net/`) | lobby, replicated rivals, host-authoritative snapshots (20 Hz) |

Reassigned (2026-10-18): the track lane also owns `editor` (`src/editor/`); the net lane also owns `src/pwa/` (moved from shell), `src/overlay/` and `src/xr/`.

Later lanes, started by the coordinator when their inputs exist: `garage`
(`src/garage/`, needs car + race), and `debris` (Rapier side-worlds, `src/physics/debris/`).

## Live sessions (2026-10-18)

| lane | session id |
|---|---|
| coordinator | session_01GiW52Wfj2t9pFRmy26vhby |
| track | session_011ffxeAVgs8HAP7xPBD4oKx |
| physics | session_01Ni5hh1aPkKXby4JHg1yjXR |
| render | session_01VKfkKzXXB9SdaLr3g6srt3 |
| car | session_01XAuqFENYFAd7A6YXrhpdws |
| shell | session_01VAsB9WeJepigBfQp5KztWD |
| scenery | session_012xrhXFCPErJJLFnqEbJauR |
| audio | session_01WZRSgxCphpfWRxkArKrsL7 |
| race | session_01M95Vf3AMimBx75Ev2vmjm5 |
| data | session_01SHN96cJYkDTP4a5iiedaNq |
| net | session_01LW67cfZkhLCsMu22aq6Zyz |
| f1-game oracle (f1-game repo) | session_01UNGyfauYf4UT9pXzJV4zQz |

Lanes may message each other directly (`send_message`) for interface questions in their
own seams; contract changes still go through the coordinator.
