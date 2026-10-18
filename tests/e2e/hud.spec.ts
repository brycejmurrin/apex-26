import { expect, test } from "@playwright/test";

test("HUD shows speed and gear while driving (T1.10)", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#backend")).toHaveAttribute("data-backend", /^(WebGPU|WebGL2)$/);
  const speed = page.locator('#hud [data-k="speed"]');
  await expect(speed).toHaveText("0");
  await expect(page.locator('#hud [data-k="lap"]')).toHaveText("OUT");
  await page.keyboard.down("ArrowUp");
  await expect.poll(async () => Number(await speed.textContent()), { timeout: 20_000 }).toBeGreaterThan(10);
  await page.keyboard.up("ArrowUp");
  await expect(page.locator('#hud [data-k="gear"]')).not.toHaveText("N");
});
