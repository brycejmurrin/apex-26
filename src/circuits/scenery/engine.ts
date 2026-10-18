/**
 * What a circuit scenery closure receives. f1-game: `window.TrackScenery[id] =
 * function (api) {...}` (js/circuits/scenery/*.js), which also reads three
 * engine globals directly: `TrackGeom` (unguarded emitters on model stages:
 * shanghai.js:625, silverstone.js:320), `TrackSpace` (monaco.js:22-73) and
 * `TrackPit`. Here those arrive as a second argument, a slice of SceneryCore.
 */
import type { SceneryApi } from "../../contracts/scenery";
import type { SceneryCore } from "../../track/scenery/core";

export type SceneryEngine = Pick<SceneryCore, "geom" | "space" | "pit">;

export type SceneryClosure = (api: SceneryApi, engine: SceneryEngine) => void;
