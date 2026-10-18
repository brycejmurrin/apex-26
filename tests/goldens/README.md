# Goldens

Reference output produced by f1-game's real code, used to prove the TypeScript port
behaves identically. Regenerate only from the coordinator session (lane sessions may not
execute f1-game code); never hand-edit.

| file | producer | contents |
|---|---|---|
| `track-<id>.json.gz` | `node tools/oracle/track-dump.cjs --f1 ../f1-game <ids…>` | built track typed arrays (`arrays`, `pit`, `bankP`), scalars, and `queries`: `Tracks.sample` / `banking` / `onKerb` / `inPitLane` at 2,000 evenly spaced `s` × lateral `x ∈ {-1,-.5,0,.5,1}·hw`, plus `wallAt(s, ±1)` |

Load with `JSON.parse(zlib.gunzipSync(fs.readFileSync(path)))`. Values are raw doubles
(Float32Array entries widened exactly), so compare with `Object.is`. `header.sha` is the
f1-game commit they came from.
| `physics-<field\|solo>-<scenario>.json.gz` | `node tools/oracle/physics-dump.cjs --f1 ../f1-game` | the 4 f1-game physics-characterization recipes on Monza (dry, 1/60 s): per step the applied `input`, `__apex.physState()` (`phys`) and every numeric/boolean `G.player` field as raw doubles (`car`, ordered by `carKeys`; `init` = state after reset). `field` runs with the AI grid (asserted equal to f1-game's committed browser baseline at 1e-4); `solo` retires every AI car first. For these 4 recipes the two are identical (no car interaction). |
