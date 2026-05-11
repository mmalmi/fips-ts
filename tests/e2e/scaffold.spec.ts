import { test, expect } from "@playwright/test";

test("demo app loads and exposes status pill", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("stopped");
});

test("starting node yields an identity and connects local peer", async ({ page }) => {
  await page.goto("/");
  await page.click("#start");
  await expect(page.locator("#status")).toHaveText("started", { timeout: 10_000 });
  const pub = await page.locator("#pubkey").textContent();
  expect(pub).toMatch(/^[0-9a-f]{66}$/);
  const addr = await page.locator("#nodeaddr").textContent();
  expect(addr).toMatch(/^[0-9a-f]{32}$/);
});
