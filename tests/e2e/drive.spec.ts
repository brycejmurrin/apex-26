import { expect, test } from "@playwright/test";

test("keyboard drives the car (T1.9)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(page.locator("#backend")).toHaveAttribute("data-backend", /^(WebGPU|WebGL2)$/);
  await page.waitForFunction(() => !!window.__apex);
  const prog0 = await page.evaluate(() => window.__apex!.physState().prog);
  await page.keyboard.down("ArrowUp");
  // Real time under software GL is slow (a few fps, 5 substeps a frame): wait on the sim, not the clock.
  await expect.poll(() => page.evaluate(() => window.__apex!.physState().prog), { timeout: 30_000 }).toBeGreaterThan(prog0 + 5);
  await page.keyboard.up("ArrowUp");
  expect(errors).toEqual([]);
});
