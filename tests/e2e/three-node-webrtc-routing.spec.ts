import { test, expect } from "@playwright/test";

import { startLocalNostrRelay, type LocalNostrRelay } from "./fixtures/localNostrRelay.js";

let relay: LocalNostrRelay;

test.beforeAll(async () => {
  relay = await startLocalNostrRelay();
});

test.afterAll(async () => {
  await relay.close();
});

test("Three-node FIPS routing A -> B -> C over REAL WebRTC + Nostr signaling", async ({ page }) => {
  await page.addInitScript((url) => {
    window.__fipsTestRelayUrl = url;
  }, relay.url);
  page.on("pageerror", (err) => console.log("pageerror:", err.message));

  await page.goto("/");
  await page.waitForFunction(() => !!window.__fipsHarness);

  const reply = await page.evaluate(async () => {
    const h = window.__fipsHarness;
    const three = await h.makeWebRtcChain(window.__fipsTestRelayUrl!);
    return h.echoOverChain(three, "webrtc-routed");
  });

  expect(reply).toBe("webrtc-routed");
});
