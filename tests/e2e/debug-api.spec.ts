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
    // A driver that reads only its own state: full throttle, steer back to the centreline.
    for (let i = 0; i < 600; i++) {
      const s = api.physState();
      api.setInput({ throttle: true, steer: Math.max(-1, Math.min(1, -s.x * 0.3 + 0.4)) });
      api.step(1);
    }
    api.setInput(null);
    return { start: start.prog, end: api.physState(), info: api.info() };
  });
  expect(r.end.prog - r.start).toBeGreaterThan(200);
  expect(r.end.speed).toBeGreaterThan(20);
  expect(r.info.steps).toBeGreaterThanOrEqual(600);
  expect(r.info.backend).toMatch(/^(WebGPU|WebGL2)$/);
  expect(r.info.overridden).toBe(false);
  expect(errors).toEqual([]);
});
