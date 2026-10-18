import { expect, test } from "@playwright/test";

test("boots and reports a renderer backend", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(page.locator("#backend")).toHaveAttribute("data-backend", /^(WebGPU|WebGL2)$/);
  expect(errors).toEqual([]);
});
