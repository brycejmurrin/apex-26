import { expect, test } from "@playwright/test";

// PLAN T1.7: the renderer core draws a track (the procedural fallback when no f1-game
// mesh dump is present, as in CI) and reports its draw calls.
test("render demo draws a track and logs draw calls", async ({ page }) => {
  const errors: string[] = [];
  const logs: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => logs.push(m.text()));
  await page.goto("./render-demo.html?sw=1");
  await page.waitForFunction(() => window.__renderDemo?.ready || window.__renderDemo?.error, null, { timeout: 45_000 });
  const s = await page.evaluate(() => window.__renderDemo!);
  expect(s.error).toBeNull();
  expect(s.backend).toMatch(/^(WebGPU|WebGL2)$/);
  expect(s.objects).toBeGreaterThanOrEqual(3);
  expect(s.drawCalls).toBeGreaterThan(0);
  expect(logs.some((l) => /^\[render\] .* drawCalls=\d+/.test(l))).toBe(true);
  expect(errors).toEqual([]);
});
