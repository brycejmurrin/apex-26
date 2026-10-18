import { defineConfig } from "vitest/config";

// Project site: https://brycejmurrin.github.io/apex-26/
export default defineConfig({
  base: "/apex-26/",
  build: {
    target: "es2022",
    sourcemap: true,
    // three/webgpu alone is ~780 kB min / ~215 kB gz; budgets are tracked in docs/PLAN.md T1.13.
    chunkSizeWarningLimit: 1000,
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
