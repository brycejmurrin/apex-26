/**
 * The page side of the build Worker (f1-game js/track/build-client.js, minus
 * the gfx replay): `buildInWorker(id)` resolves the built Track. Falls back to
 * building on this thread where Workers are unavailable.
 */
import { buildTrack, defById } from "../core/tracks";
import type { Track } from "../core/types";
import { unpackBuilt, type BuildRequest, type WorkerReply } from "./protocol";

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (t: Track) => void; reject: (e: Error) => void; id: string }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./build-worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<WorkerReply>) => {
    const m = e.data, p = pending.get(m.seq);
    if (!p) return;
    pending.delete(m.seq);
    if (m.type === "error") { p.reject(new Error(m.message)); return; }
    const def = defById(p.id);
    if (!def) { p.reject(new Error("unknown circuit id " + p.id)); return; }
    p.resolve(unpackBuilt(m, def));
  };
  w.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || "track build worker failed"));
    pending.clear();
    worker = null;
  };
  return (worker = w);
}

export function buildInWorker(id: string, opts?: BuildRequest["opts"]): Promise<Track> {
  if (typeof Worker === "undefined") {
    const def = defById(id);
    return def ? Promise.resolve(buildTrack(def, opts ?? null)) : Promise.reject(new Error("unknown circuit id " + id));
  }
  const w = ensureWorker();
  const s = ++seq;
  return new Promise<Track>((resolve, reject) => {
    pending.set(s, { resolve, reject, id });
    const req: BuildRequest = opts ? { type: "build", seq: s, id, opts } : { type: "build", seq: s, id };
    w.postMessage(req);
  });
}
