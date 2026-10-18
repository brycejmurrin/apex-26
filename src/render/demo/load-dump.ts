// Load a track mesh dump written by tools/render/dump-track-mesh.cjs (f1-game's
// TRACK_VM build) from `artifacts/track-mesh/<id>/`. Dev only: the dump is not
// committed, so a build without it falls back to ./fallback.ts.
import type { MeshData, TrackMeshKey } from "../../contracts/render";
import type { Vec3 } from "../../contracts/track";

interface Manifest {
  id: string;
  meshes: Partial<Record<TrackMeshKey, { verts: number; channels: Record<string, number> }>>;
  centre?: { n: number; total: number };
}

export interface TrackDump {
  id: string;
  meshes: Map<TrackMeshKey, MeshData>;
  /** Centreline nodes (tracks.js px/py/pz) and tangents (tx/ty/tz). */
  centre: { p: Float32Array[]; t: Float32Array[] } | null;
}

async function bin(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}

export async function loadDump(baseUrl: string, id: string): Promise<TrackDump | null> {
  const dir = `${baseUrl}artifacts/track-mesh/${id}/`;
  let manifest: Manifest;
  try {
    const r = await fetch(`${dir}manifest.json`);
    if (!r.ok) return null;
    manifest = (await r.json()) as Manifest;
  } catch {
    return null;
  }
  const meshes = new Map<TrackMeshKey, MeshData>();
  for (const [key, entry] of Object.entries(manifest.meshes) as [TrackMeshKey, NonNullable<Manifest["meshes"][TrackMeshKey]>][]) {
    const ch = entry.channels;
    const f = async (name: string) => (ch[name] ? new Float32Array(await bin(`${dir}${key}.${name}.bin`)) : undefined);
    const [pos, nrm, col, mat, trk, idx] = await Promise.all([
      f("pos"),
      f("nrm"),
      f("col"),
      f("mat"),
      f("trk"),
      bin(`${dir}${key}.idx.bin`).then((b) => new Uint32Array(b)),
    ]);
    if (!pos || !nrm || !col) continue;
    meshes.set(key, { pos, nrm, col, idx, ...(mat ? { mat } : {}), ...(trk ? { trk } : {}) });
  }
  let centre: TrackDump["centre"] = null;
  if (manifest.centre) {
    const ax = await Promise.all(["px", "py", "pz", "tx", "ty", "tz"].map((c) => bin(`${dir}centre.${c}.bin`)));
    const a = ax.map((b) => new Float32Array(b));
    centre = { p: a.slice(0, 3), t: a.slice(3, 6) };
  }
  return { id: manifest.id, meshes, centre };
}

/** A fixed chase-height camera at centreline node `i`: 15 m back, 6 m up, looking 40 m ahead. */
export function nodeCamera(centre: NonNullable<TrackDump["centre"]>, i: number): { eye: Vec3; target: Vec3 } {
  const [px, py, pz] = centre.p as [Float32Array, Float32Array, Float32Array];
  const [tx, ty, tz] = centre.t as [Float32Array, Float32Array, Float32Array];
  const n = px.length;
  const k = ((i % n) + n) % n;
  const p: Vec3 = [px[k]!, py[k]!, pz[k]!];
  const t: Vec3 = [tx[k]!, ty[k]!, tz[k]!];
  return {
    eye: [p[0] - t[0] * 15, p[1] + 6, p[2] - t[2] * 15],
    target: [p[0] + t[0] * 40, p[1] + t[1] * 40, p[2] + t[2] * 40],
  };
}
