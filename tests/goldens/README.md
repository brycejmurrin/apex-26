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
