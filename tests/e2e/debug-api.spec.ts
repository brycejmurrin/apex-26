import { expect, test } from "@playwright/test";

// PLAN T1.11 accept: boot, drive 10 s with scripted input, assert progress and the backend label.
test("window.__apex drives 10 s of scripted input", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(page.locator("#backend")).toHaveAttribute("data-backend", /^(WebGPU|WebGL2)$/);
  await page.waitForFunction(() => !!window.__apex);
  const r = await page.evaluate(() => {
    const api = window.__apex!;
    const start = api.physState();
    // Full throttle, wheel straight: Monza's grid slot sits on the start/finish straight.
    api.setInput({ throttle: true, steer: 0 });
    api.step(600);
    api.setInput(null);
    return { start: start.prog, end: api.physState(), info: api.info() };
  });
  expect(r.end.prog - r.start).toBeGreaterThan(150);   // f1-game pulls ~218 m in 10 s from a standing start
  expect(r.end.lap).toBe(1);   // crossed the line from the grid
  expect(r.info.track).toBe("monza");
  expect(r.end.speed).toBeGreaterThan(20);
  expect(r.info.steps).toBeGreaterThanOrEqual(600);
  expect(r.info.backend).toMatch(/^(WebGPU|WebGL2)$/);
  expect(r.info.overridden).toBe(false);
  expect(errors).toEqual([]);
});
