import { expect, test } from "@playwright/test";

test("concurrent IndexedDB stores create one persistent FIPS identity", async ({ page }) => {
  await page.goto("/");
  const identities = await page.evaluate(async (dbName) => {
    return window.__fipsHarness.concurrentIdentityStoreCreate(dbName);
  }, `fips-identity-race-${crypto.randomUUID()}`);

  expect(identities.first).toBe(identities.second);
  expect(identities.persisted).toBe(identities.first);
});
