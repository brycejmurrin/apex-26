import { expect, test } from "@playwright/test";

// PWA (src/pwa/sw.ts): the service worker registers, precaches the shell and
// its hashed assets, and the game boots from cache with the network gone.
test.use({ serviceWorkers: "allow" });

test("the service worker installs and the shell reloads offline", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(page.locator("#backend")).toHaveAttribute("data-backend", /^(WebGPU|WebGL2)$/);

  // registerSW.js registers on load; clientsClaim() makes the first install
  // control this page, so wait until it does.
  const scope = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    }
    return reg.scope;
  });
  expect(scope).toMatch(/\/apex-26\/$/);
  const cached = await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("a26-precache")).length);
  expect(cached).toBeGreaterThan(0);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#backend")).toHaveAttribute("data-backend", /^(WebGPU|WebGL2)$/);
  // Another root page is served as itself, never as the game shell.
  await page.goto("controller.html?demo");
  await expect(page).toHaveTitle(/phone controller/i);
  await context.setOffline(false);
  expect(errors).toEqual([]);
});
