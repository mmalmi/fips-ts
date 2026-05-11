import { test, expect } from "@playwright/test";

test("Three-node FIPS routing A -> B -> C over MemoryTransport (in-page)", async ({ page }) => {
  await page.goto("/");
  const reply = await page.evaluate(async () => {
    const h = window.__fipsHarness;
    const three = await h.memoryThreeNodes();
    return h.echoOverChain(three, "browser-routed");
  });
  expect(reply).toBe("browser-routed");
});
