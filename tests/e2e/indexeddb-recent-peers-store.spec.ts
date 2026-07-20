import { expect, test } from "@playwright/test";

test("IndexedDB persists recent peers by local identity and scope", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (dbName) => {
    return window.__fipsHarness.recentPeersStoreRoundTrip(dbName);
  }, `fips-recent-peers-${crypto.randomUUID()}`);

  expect(result.persistedPeerCount).toBe(1);
  expect(result.persistedEndpoint).toBe("192.0.2.1:32112");
  expect(result.otherScopePeerCount).toBe(0);
  expect(result.otherIdentityPeerCount).toBe(0);
  expect(result.clearedPeerCount).toBe(0);
});
