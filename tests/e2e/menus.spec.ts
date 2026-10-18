import { expect, test } from "@playwright/test";

test("title → time trial → pause → quit (menus)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(page.locator("#backend")).toHaveAttribute("data-backend", /^(WebGPU|WebGL2)$/);
  await expect(page.locator("#overlay")).toBeVisible();
  await expect(page.locator("#hud")).toBeHidden();

  await page.locator("#mb-tt").click();
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(page.locator("#hud")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#pausemenu")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__apex!.info().paused)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator("#pausemenu")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__apex!.info().paused)).toBe(false);

  await page.keyboard.press("Escape");
  await page.locator("#pm-quit").click();
  await expect(page.locator("#overlay")).toBeVisible();
  await expect(page.locator("#hud")).toBeHidden();

  await page.locator("#mb-data").click();
  await expect(page.locator("#datahub")).toBeVisible();
  expect(errors).toEqual([]);
});
