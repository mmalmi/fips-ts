import { expect, test } from "@playwright/test";

import { startLocalNostrRelay, type LocalNostrRelay } from "./fixtures/localNostrRelay.js";

let relay: LocalNostrRelay;

test.beforeAll(async () => {
  relay = await startLocalNostrRelay();
});

test.afterAll(async () => {
  await relay.close();
});

test("a live inbound peer connects while stale adverts have pending auto-dials", async ({ page }) => {
  await page.addInitScript((url) => {
    window.__fipsTestRelayUrl = url;
  }, relay.url);
  await page.goto("/");
  await page.waitForFunction(() => !!window.__fipsHarness);

  const reply = await page.evaluate(() => window.__fipsHarness
    .connectThroughStaleAdvertBacklog(window.__fipsTestRelayUrl!));

  expect(reply).toEqual({
    first: "live-peer-through-stale-backlog",
    second: "reconnected-peer-through-stale-backlog",
  });
});
