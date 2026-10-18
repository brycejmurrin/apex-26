export type BackendName = "WebGPU" | "WebGL2";

/** Which backend a WebGPURenderer actually bound after init(); three falls back to WebGL2 silently. */
export function backendName(renderer: { backend: unknown }): BackendName {
  const b = renderer.backend as { isWebGPUBackend?: boolean } | null;
  return b?.isWebGPUBackend ? "WebGPU" : "WebGL2";
}
