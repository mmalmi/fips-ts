import { test, expect } from "@playwright/test";

import { startLocalNostrRelay, type LocalNostrRelay } from "./fixtures/localNostrRelay.js";

let relay: LocalNostrRelay;

test.beforeAll(async () => {
  relay = await startLocalNostrRelay();
});

test.afterAll(async () => {
  await relay.close();
});

test("Browser C fetches a hashtree blob from Browser A over REAL WebRTC + Nostr", async ({ page }) => {
  await page.addInitScript((url) => {
    window.__fipsTestRelayUrl = url;
  }, relay.url);
  page.on("pageerror", (err) => console.log("pageerror:", err.message));

  await page.goto("/");
  await page.waitForFunction(() => !!window.__fipsHarness);

  const result = await page.evaluate(async () => {
    const h = window.__fipsHarness;
    const { cFetched, teardown } = await h.webRtcHashtreePair(window.__fipsTestRelayUrl!);
    try {
      return cFetched;
    } finally {
      await teardown();
    }
  });

  expect(result).toBe("hashtree-over-webrtc-smoke");
});
