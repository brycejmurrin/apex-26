# Goldens

Reference output produced by f1-game's real code, used to prove the TypeScript port
behaves identically. Regenerate only from the coordinator session (lane sessions may not
execute f1-game code); never hand-edit.

| file | producer | contents |
|---|---|---|
| `track-<id>.json.gz` | `node tools/oracle/track-dump.cjs --f1 ../f1-game <ids…>` | built track typed arrays (`arrays`, `pit`, `bankP`), scalars, and `queries`: `Tracks.sample` / `banking` / `onKerb` / `inPitLane` at 2,000 evenly spaced `s` × lateral `x ∈ {-1,-.5,0,.5,1}·hw`, plus `wallAt(s, ±1)`, and `meshes`: every `gfx.createMesh` call of the build in order (`verts`, `idx` count, sha256 of `pos`/`nrm`/`col` as Float64 LE and `idx`/`mat` as Uint32). The build is f1-game's full one (scenery loaded), so props it bakes into those buffers are included. Monza, spa, monaco, madrid, zandvoort use 2,000 samples; the other 47 circuits 200 (`--all --samples 200`). |

Load with `JSON.parse(zlib.gunzipSync(fs.readFileSync(path)))`. Values are raw doubles
(Float32Array entries widened exactly), so compare with `Object.is`. `header.sha` is the
f1-game commit they came from.
| `physics-<field\|solo>-<scenario>.json.gz` | `node tools/oracle/physics-dump.cjs --f1 ../f1-game` | the 4 f1-game physics-characterization recipes on Monza (dry, 1/60 s): per step the applied `input`, `__apex.physState()` (`phys`) and every numeric/boolean `G.player` field as raw doubles (`car`, ordered by `carKeys`; `init` = state after reset). `field` runs with the AI grid (asserted equal to f1-game's committed browser baseline at 1e-4); `solo` retires every AI car first. For these 4 recipes the two are identical (no car interaction). |
| `physics-tape-<scenario>.json.gz` | `node tools/oracle/physics.mjs` (lane physics; f1-game's `tools/lib/game-vm.cjs`, pinned world as f1-game `tools/check/physics-oracle.mjs`) | the same 4 recipes, solo, **600 steps** (last stage's input held). `initial.car`: every primitive player field after reset (`{"$undef":true}` = present but undefined); `initial.world`: the scalars the step reads. Per step: `input`, `state` (raw doubles of the plan's list plus drivetrain/surface fields), `raceT`, and `tape`: every top-level track query the step made, in call order, with args and exact result (`sample`, `banking`, `onKerb`, `inPitLane`, `wallAt`, `postLimits`, `wallLimits` as one query, and the arc reads `curvature`/`bankAngle` so the replay can prove the player path skips them). Identical to `physics-solo-*` on every overlapping step. Numbers JSON cannot hold travel as `{"$n":"-0"}` etc. (`tests/goldens/decode.ts`). |
| `physics-modules.json` | `node tools/oracle/modules.mjs` (lane physics) | f1-game's physics modules run in a bare VM on ~5k seeded random inputs (inputs + exact outputs) for `tests/unit/physics-modules.test.ts`. |
