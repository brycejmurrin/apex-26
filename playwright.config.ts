import { defineConfig } from "@playwright/test";

// CI installs Playwright's own Chromium; cloud containers ship one at /opt/pw-browsers.
const executablePath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  // CI also writes an HTML report, uploaded as an artifact when the job fails.
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:4173/apex-26/",
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173/apex-26/",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
