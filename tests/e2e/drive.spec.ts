import { expect, test } from "@playwright/test";

test("keyboard drives the car (T1.9)", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(page.locator("#backend")).toHaveAttribute("data-backend", /^(WebGPU|WebGL2)$/);
  await page.locator("#mb-tt").click();
  await page.waitForFunction(() => !!window.__apex);
  const prog0 = await page.evaluate(() => window.__apex!.physState().prog);
  await page.keyboard.down("ArrowUp");
  // Real time under software GL is slow (a few fps, at most 5 substeps a frame; CI moved ~4.5 m in
  // 30 s), so assert forward progress, not a distance.
  await expect.poll(() => page.evaluate(() => window.__apex!.physState().prog), { timeout: 60_000 }).toBeGreaterThan(prog0 + 0.5);
  await page.keyboard.up("ArrowUp");
  expect(errors).toEqual([]);
});
