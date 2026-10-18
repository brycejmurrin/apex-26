/**
 * The track-build Worker protocol: what crosses the thread boundary and how a
 * built track is packed for it. Ported from f1-game js/track/build-worker.js
 * (:41-95, `transferables`, `typedRibbon`, the strip before postMessage) and the
 * page half js/track/build-client.js.
 *
 * Differences from f1-game: there is no gfx recorder (the port's buildTrack does
 * not upload; the CPU buffers ARE the result), and the worker builds by circuit
 * id from the same bundled src/circuits data, so no def crosses the boundary.
 * Every buffer is posted as a typed array and transferred, never copied:
 * positions/normals/colours/materials as Float64Array (exact doubles, as
 * f1-game's typedRibbon), indices as Uint32Array.
 */
import { profile as surfaceProfile } from "../core/surface";
import type { BuiltDef } from "../core/def";
import type { GeomOut, SealedGeom, Track, TrackGeometry } from "../core/types";

export interface BuildRequest {
  type: "build";
  seq: number;
  id: string;
  opts?: { night?: boolean; gridSlots?: number };
}

/** One geometry buffer as posted: exact doubles, u32 indices. */
export interface PackedGeom {
  pos: Float64Array;
  nrm: Float64Array;
  col: Float64Array;
  idx: Uint32Array;
  mat: Float64Array | null;
  trk: Float64Array | null;
}
export type PackedGeometry = Record<keyof TrackGeometry, PackedGeom>;

/** The track minus what cannot or need not cross: def, surface sampler, geometry (sent packed), caches. */
export type PostedTrack = Omit<Track, "def" | "surface" | "geo" | "roadGeo" | "terrainGeo" | "propsGeo" | "glassGeo" | "waterGeo" | "_terrGrid" | "_nodeGrid">;

export interface BuiltMessage {
  type: "built";
  seq: number;
  id: string;
  ms: number;
  track: PostedTrack;
  geo: PackedGeometry;
  /** Def fields the build stamps (tracks.js:71, def.js:258), replayed onto the page's def. */
  sceneryShift: number | undefined;
  startFrac: number | undefined;
}

export interface ErrorMessage {
  type: "error";
  seq: number;
  id: string;
  message: string;
}

export type WorkerReply = BuiltMessage | ErrorMessage;

export function packGeom(g: SealedGeom): PackedGeom {
  return {
    pos: Float64Array.from(g.pos), nrm: Float64Array.from(g.nrm), col: Float64Array.from(g.col),
    idx: Uint32Array.from(g.idx), mat: g.mat ? Float64Array.from(g.mat) : null,
    trk: g.trk ? Float64Array.from(g.trk) : null,
  };
}

export function unpackGeom(p: PackedGeom): GeomOut {
  const g: GeomOut = { pos: Array.from(p.pos), nrm: Array.from(p.nrm), col: Array.from(p.col), idx: Array.from(p.idx) };
  if (p.mat) g.mat = Array.from(p.mat);
  if (p.trk) g.trk = Array.from(p.trk);
  return g;
}

/** Every ArrayBuffer reachable from `root` (f1-game build-worker.js:41 transferables). */
export function transferables(root: unknown): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>(), seen = new Set<object>(), stack: unknown[] = [root];
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== "object" || seen.has(o)) continue;
    seen.add(o);
    if (ArrayBuffer.isView(o)) { if (o.buffer instanceof ArrayBuffer) out.add(o.buffer); continue; }
    if (o instanceof ArrayBuffer) { out.add(o); continue; }
    for (const v of Object.values(o)) stack.push(v);
  }
  return [...out];
}

/** Pack a finished build into a reply. */
export function packBuilt(track: Track, seq: number, ms: number): BuiltMessage {
  const geo = track.geo!;
  const packed = {} as PackedGeometry;
  for (const k of Object.keys(geo) as (keyof TrackGeometry)[]) packed[k] = packGeom(geo[k]);
  const { def, surface: _s, geo: _g, roadGeo: _r, terrainGeo: _t, propsGeo: _p, glassGeo: _gl, waterGeo: _w,
          _terrGrid: _tg, _nodeGrid: _ng, ...rest } = track;
  return { type: "built", seq, id: def.id, ms, track: rest, geo: packed, sceneryShift: def._sceneryShift, startFrac: def._startFrac };
}

/**
 * Rebuild a usable Track from a reply on the page: reattach the page's def
 * (after replaying what the build stamped on it), rebuild the surface sampler
 * from the def as f1-game's client does, and restore the geometry.
 */
export function unpackBuilt(msg: BuiltMessage, def: BuiltDef): Track {
  if (msg.sceneryShift !== undefined) def._sceneryShift = msg.sceneryShift;
  if (msg.startFrac !== undefined) def._startFrac = msg.startFrac;
  const geo = {} as TrackGeometry;
  for (const k of Object.keys(msg.geo) as (keyof TrackGeometry)[]) geo[k] = unpackGeom(msg.geo[k]);
  const track: Track = { ...msg.track, def, geo, roadGeo: geo.road, terrainGeo: geo.terrain, propsGeo: geo.props, glassGeo: geo.glass, waterGeo: geo.water };
  track.surface = surfaceProfile(def, track);
  return track;
}
