import { test, expect } from "@playwright/test";

test("Reconnect: tear down and re-establish FIPS state; service datagram works again", async ({ page }) => {
  await page.goto("/");
  const { first, second } = await page.evaluate(async () => {
    return window.__fipsHarness.reconnectMemoryPair();
  });
  expect(first).toBe("before");
  expect(second).toBe("after");
});
