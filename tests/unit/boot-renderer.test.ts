import { describe, expect, it } from "vitest";
import { createRenderer, type RendererParams } from "../../src/render/boot";

const UA = {
  iosSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  chrome:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

class FakeRenderer {
  disposed = false;
  backend: { isWebGPUBackend?: boolean } | null = null;
  constructor(
    readonly params: RendererParams,
    private readonly behaviour: { throwOnWebGPU?: boolean; silentFallback?: boolean },
  ) {}
  async init(): Promise<this> {
    if (!this.params.forceWebGL && this.behaviour.throwOnWebGPU) throw new Error("webgpu init failed");
    this.backend = { isWebGPUBackend: !this.params.forceWebGL && !this.behaviour.silentFallback };
    return this;
  }
  dispose(): void {
    this.disposed = true;
  }
}

function harness(opts: { search?: string; ua?: string; adapter?: unknown; noGpu?: boolean; throwOnWebGPU?: boolean; silentFallback?: boolean }) {
  const made: FakeRenderer[] = [];
  let adapterCalls = 0;
  const canvas = {} as HTMLCanvasElement;
  const run = () =>
    createRenderer(canvas, {
      env: {
        search: opts.search ?? "",
        userAgent: opts.ua ?? UA.chrome,
        requestAdapter: opts.noGpu
          ? undefined
          : async () => {
              adapterCalls++;
              if (opts.adapter instanceof Error) throw opts.adapter;
              return opts.adapter === undefined ? {} : opts.adapter;
            },
      },
      factory: (p) => {
        const r = new FakeRenderer(p, opts);
        made.push(r);
        return r;
      },
    });
  return { run, made, adapterCalls: () => adapterCalls };
}

describe("createRenderer", () => {
  it("auto with an adapter binds WebGPU", async () => {
    const h = harness({});
    const r = await h.run();
    expect(r).toMatchObject({ backend: "WebGPU", reason: "auto" });
    expect(h.made.map((m) => m.params.forceWebGL)).toEqual([false]);
    expect(h.made[0]?.params.antialias).toBe(true);
  });

  it("no navigator.gpu, a null adapter, or a throwing requestAdapter all force WebGL2", async () => {
    for (const o of [{ noGpu: true }, { adapter: null }, { adapter: new Error("nope") }]) {
      const r = await harness(o).run();
      expect(r).toMatchObject({ backend: "WebGL2", reason: "no-adapter" });
    }
  });

  it("WebKit forces WebGL2", async () => {
    const r = await harness({ ua: UA.iosSafari }).run();
    expect(r).toMatchObject({ backend: "WebGL2", reason: "webkit" });
  });

  it("a pin skips the adapter request", async () => {
    const h = harness({ search: "?gl=1" });
    expect(await h.run()).toMatchObject({ backend: "WebGL2", reason: "pin-webgl" });
    expect(h.adapterCalls()).toBe(0);
    expect(await harness({ search: "?gl=0", ua: UA.iosSafari }).run()).toMatchObject({ backend: "WebGPU", reason: "pin-webgpu" });
  });

  it("WebGPU init throwing on auto disposes and retries once on WebGL2", async () => {
    const h = harness({ throwOnWebGPU: true });
    const r = await h.run();
    expect(r).toMatchObject({ backend: "WebGL2", reason: "init-retry" });
    expect(h.made.map((m) => [m.params.forceWebGL, m.disposed])).toEqual([
      [false, true],
      [true, false],
    ]);
    expect(r.renderer).toBe(h.made[1]);
  });

  it("a ?gl=0 pin surfaces the init failure instead of retrying", async () => {
    const h = harness({ search: "?gl=0", throwOnWebGPU: true });
    await expect(h.run()).rejects.toThrow("webgpu init failed");
    expect(h.made).toHaveLength(1);
  });

  it("names three's silent WebGL2 fallback", async () => {
    expect(await harness({ silentFallback: true }).run()).toMatchObject({ backend: "WebGL2", reason: "silent-fallback" });
  });
});
