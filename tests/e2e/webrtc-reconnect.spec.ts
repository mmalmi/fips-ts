import { test, expect } from "@playwright/test";

import { startLocalNostrRelay, type LocalNostrRelay } from "./fixtures/localNostrRelay.js";

let relay: LocalNostrRelay;

test.beforeAll(async () => {
  relay = await startLocalNostrRelay();
});

test.afterAll(async () => {
  await relay.close();
});

test("WebRTC reconnect: tear down both nodes, redial, echo works again", async ({ page }) => {
  await page.addInitScript((url) => {
    window.__fipsTestRelayUrl = url;
  }, relay.url);
  page.on("pageerror", (err) => console.log("pageerror:", err.message));

  await page.goto("/");
  await page.waitForFunction(() => !!window.__fipsHarness);

  const { first, second } = await page.evaluate(async () => {
    const h = window.__fipsHarness;
    return h.webRtcReconnect(window.__fipsTestRelayUrl!);
  });

  expect(first).toBe("before-reconnect");
  expect(second).toBe("after-reconnect");
});
