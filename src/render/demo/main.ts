// Render demo (PLAN T1.7 acceptance): Monza from a fixed camera, draw calls logged.
// `render-demo.html?track=monza&node=0&gl=1`. Loads the f1-game mesh dump from
// artifacts/ (tools/render/dump-track-mesh.cjs) or a procedural ring without one.
import { createTrackRenderer } from "../renderer";
import { fallbackTrack, RING_R } from "./fallback";
import { loadDump, nodeCamera } from "./load-dump";

export interface RenderDemoState {
  ready: boolean;
  backend: string | null;
  source: string;
  frames: number;
  drawCalls: number;
  triangles: number;
  objects: number;
  error: string | null;
}

declare global {
  interface Window {
    __renderDemo?: RenderDemoState;
  }
}

const state: RenderDemoState = {
  ready: false,
  backend: null,
  source: "",
  frames: 0,
  drawCalls: 0,
  triangles: 0,
  objects: 0,
  error: null,
};
window.__renderDemo = state;

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const label = document.querySelector<HTMLElement>("#info")!;
const q = new URLSearchParams(location.search);
const trackId = q.get("track") ?? "monza";
const node = Number(q.get("node") ?? "0") | 0;
const software = /SwiftShader|llvmpipe/i.test(q.get("sw") ?? "") || q.get("sw") === "1";

async function main(): Promise<void> {
  const r = await createTrackRenderer(canvas, { softwareGL: software });
  r.resize(window.innerWidth, window.innerHeight, Math.min(window.devicePixelRatio, 2));
  window.addEventListener("resize", () => r.resize(window.innerWidth, window.innerHeight, Math.min(window.devicePixelRatio, 2)));
  state.backend = r.backend;

  const dump = await loadDump(import.meta.env.BASE_URL, trackId);
  const meshes = dump ? dump.meshes : fallbackTrack();
  state.source = dump ? `dump:${dump.id}` : "fallback";
  for (const [key, data] of meshes) r.uploadTrackMesh(key, data);

  const cam = dump?.centre ? nodeCamera(dump.centre, node) : { eye: [RING_R - 15, 6, -30] as [number, number, number], target: [RING_R, 0, 20] as [number, number, number] };
  r.setCamera({ eye: cam.eye, target: cam.target, fovY: (55 * Math.PI) / 180, near: 0.5, far: 6000 });
  r.setLighting({
    sunDir: [0.45, 0.7, 0.35],
    sunColor: [1.25, 1.2, 1.1],
    fogColor: [0.62, 0.74, 0.88],
    fogDensity: 0.0006,
    ambientSky: [0.3, 0.32, 0.36],
    ambientGround: [0.2, 0.19, 0.18],
  });

  let lastLog = -Infinity;
  const tick = (t: number) => {
    r.renderFrame();
    state.frames++;
    state.drawCalls = r.stats.drawCalls;
    state.triangles = r.stats.triangles;
    state.objects = r.stats.objects;
    if (t - lastLog > 2000) {
      lastLog = t;
      console.log(`[render] ${state.source} ${r.backend} drawCalls=${state.drawCalls} tris=${state.triangles} objects=${state.objects}`);
      label.textContent = `${r.backend} · ${state.source} · ${state.drawCalls} draws · ${(state.triangles / 1e3).toFixed(0)}k tris`;
      label.dataset.backend = r.backend ?? "";
    }
    if (state.frames >= 2) state.ready = true;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

main().catch((e: unknown) => {
  state.error = e instanceof Error ? e.message : String(e);
  label.textContent = `render demo failed: ${state.error}`;
  console.error(e);
});
