import { test, expect } from "@playwright/test";

test("FipsHashtreeStore: C fetches a blob from A by hash over FIPS", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const h = window.__fipsHarness;
    const { cFetched, aTeardown } = await h.memoryHashtreePair();
    try {
      return cFetched;
    } finally {
      await aTeardown();
    }
  });
  expect(result).toBe("hashtree-over-fips-smoke");
});
