import { VitePWA } from "vite-plugin-pwa";
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
  // PWA (src/pwa/): offline precache of the shell and hashed assets, lazy
  // audio, never voice packs; updates wait for the player (src/pwa/update.ts).
  plugins: [
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src/pwa",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: "script-defer",
      scope: "/apex-26/",
      // Port of f1-game manifest.json; icons copied from f1-game icons/. The
      // ?go= shortcuts and screenshots wait for the shell's deep links.
      manifest: {
        id: "/apex-26/",
        lang: "en",
        name: "Apex 26",
        short_name: "Apex 26",
        description: "Unofficial F1 fan game & data hub — the 2026 grid and classic circuits in 3D, tilt to steer, plus live championship data.",
        start_url: ".",
        scope: "/apex-26/",
        display: "standalone",
        display_override: ["fullscreen", "standalone"],
        orientation: "any",
        background_color: "#0c0c14",
        theme_color: "#0c0c14",
        icons: [
          { src: "icons/icon-180.png", sizes: "180x180", type: "image/png" },
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        categories: ["games", "entertainment"],
        shortcuts: [
          {
            name: "Phone controller",
            short_name: "Controller",
            description: "Steer a game on another screen with this phone",
            url: "controller.html",
            icons: [{ src: "icons/shortcut-96.png", sizes: "96x96", type: "image/png" }],
          },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,png,svg,webp,wasm,woff2}"],
        globIgnores: ["**/voice/**", "**/pack/**", "audio/**", "**/*.map"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
