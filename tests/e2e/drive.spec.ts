import { expect, test } from "@playwright/test";

test("keyboard drives the placeholder car (T1.9)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(page.locator("#backend")).toHaveAttribute("data-backend", /^(WebGPU|WebGL2)$/);
  await page.locator("#game").click();
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(3000);
  await page.keyboard.up("ArrowUp");
  await page.screenshot({ path: "scratch/e2e-drive.png" });
  expect(errors).toEqual([]);
});
