import { describe, expect, it } from "vitest";
import { backendName } from "../../src/render/backend";

describe("backendName", () => {
  it("reports WebGPU only when the bound backend says so", () => {
    expect(backendName({ backend: { isWebGPUBackend: true } })).toBe("WebGPU");
    expect(backendName({ backend: { isWebGLBackend: true } })).toBe("WebGL2");
    expect(backendName({ backend: null })).toBe("WebGL2");
  });
});
