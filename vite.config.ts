import { defineConfig } from "vitest/config";

// Project site: https://brycejmurrin.github.io/apex-26/
export default defineConfig({
  base: "/apex-26/",
  build: {
    target: "es2022",
    sourcemap: true,
    // three/webgpu alone is ~780 kB min / ~215 kB gz; budgets are tracked in docs/PLAN.md T1.13.
    chunkSizeWarningLimit: 1000,
    // render-demo.html is the renderer lane's demo page (PLAN T1.7); built so the e2e
    // smoke can load it from `vite preview`. controller.html is the PHONE AS
    // CONTROLLER page (src/net/controller-page.ts), a second root page.
    rollupOptions: {
      input: { main: "index.html", "render-demo": "render-demo.html", controller: "controller.html" },
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
