/**
 * The track build in a Worker (f1-game js/track/build-worker.js): builds one
 * circuit by id and posts the result with every buffer transferred.
 * Load with `new Worker(new URL("./build-worker.ts", import.meta.url), { type: "module" })`.
 */
import { buildTrack, defById } from "../core/tracks";
import { packBuilt, transferables, type BuildRequest, type WorkerReply } from "./protocol";

/** The message handler, exported so it can be driven without a Worker (tests). */
export function handleBuild(m: BuildRequest, post: (msg: WorkerReply, transfer: ArrayBuffer[]) => void): void {
  try {
    const def = defById(m.id);
    if (!def) throw new Error("unknown circuit id " + m.id);
    const t0 = performance.now();
    const track = buildTrack(def, m.opts ?? null);
    const msg = packBuilt(track, m.seq, performance.now() - t0);
    post(msg, transferables(msg));
  } catch (e) {
    post({ type: "error", seq: m.seq, id: m.id, message: e instanceof Error ? e.message : String(e) }, []);
  }
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<BuildRequest>) => void) | null;
  postMessage(msg: WorkerReply, transfer: ArrayBuffer[]): void;
}

const scope = globalThis as unknown as Partial<WorkerScope>;
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined" && scope.postMessage) {
  const post = scope.postMessage.bind(scope);
  scope.onmessage = (e) => { if (e.data && e.data.type === "build") handleBuild(e.data, post); };
}
