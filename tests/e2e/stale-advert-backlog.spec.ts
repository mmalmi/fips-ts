import { expect, test } from "@playwright/test";

import {
  startLocalFipsWebSocketSeed,
  type LocalFipsWebSocketSeed,
} from "./fixtures/localFipsWebSocketSeed.js";
import { startLocalNostrRelay, type LocalNostrRelay } from "./fixtures/localNostrRelay.js";

let relay: LocalNostrRelay;
let seed: LocalFipsWebSocketSeed;

test.beforeAll(async () => {
  [relay, seed] = await Promise.all([startLocalNostrRelay(), startLocalFipsWebSocketSeed()]);
});

test.afterAll(async () => {
  await Promise.all([relay.close(), seed.close()]);
});

test("a live inbound peer connects while stale adverts have pending auto-dials", async ({ page }) => {
  await page.addInitScript((url) => {
    window.__fipsTestRelayUrl = url;
  }, relay.url);
  await page.addInitScript((url) => {
    window.__fipsTestWebSocketSeedUrl = url;
  }, seed.url);
  await page.goto("/");
  await page.waitForFunction(() => !!window.__fipsHarness);

  const reply = await page.evaluate(() => window.__fipsHarness
    .connectThroughStaleAdvertBacklog(window.__fipsTestRelayUrl!));

  expect(reply).toEqual({
    first: "live-peer-through-stale-backlog",
    second: "reconnected-peer-through-stale-backlog",
  });
});
