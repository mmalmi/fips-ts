import { test, expect } from "@playwright/test";

import { startLocalNostrRelay, type LocalNostrRelay } from "./fixtures/localNostrRelay.js";

let relay: LocalNostrRelay;

test.beforeAll(async () => {
  relay = await startLocalNostrRelay();
});

test.afterAll(async () => {
  await relay.close();
});

test("Two-node FIPS over WebRTC + local Nostr relay (in-page, native browser RTCPeerConnection)", async ({ page }) => {
  await page.addInitScript((url) => {
    window.__fipsTestRelayUrl = url;
  }, relay.url);

  page.on("console", (msg) => {
    if (msg.type() === "log" || msg.type() === "warning" || msg.type() === "error") {
      console.log(`browser ${msg.type()}: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => console.log("pageerror:", err.message));

  await page.goto("/");
  // Wait for the relay URL to be present and the harness ready.
  await page.waitForFunction(() => !!window.__fipsHarness);

  const reply = await page.evaluate(async () => {
    const h = window.__fipsHarness;
    const pair = await h.makeWebRtcPair(window.__fipsTestRelayUrl!);
    try {
      return await h.echoOverPair(pair, "hello-via-webrtc");
    } finally {
      await pair.a.stop();
      await pair.b.stop();
    }
  });

  expect(reply).toBe("hello-via-webrtc");
});

test("duplicate WebRTC dials wait for the same open datachannel", async ({ page }) => {
  await page.addInitScript((url) => {
    window.__fipsTestRelayUrl = url;
  }, relay.url);

  page.on("console", (msg) => {
    if (msg.type() === "log" || msg.type() === "warning" || msg.type() === "error") {
      console.log(`browser ${msg.type()}: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => console.log("pageerror:", err.message));

  await page.goto("/");
  await page.waitForFunction(() => !!window.__fipsHarness);

  const reply = await page.evaluate(async () => {
    return window.__fipsHarness.duplicateWebRtcConnect(window.__fipsTestRelayUrl!);
  });

  expect(reply).toBe("duplicate-connect");
});

test("Nostr advert auto-connect establishes FMP, not only a data channel", async ({ page }) => {
  await page.addInitScript((url) => {
    window.__fipsTestRelayUrl = url;
  }, relay.url);

  await page.goto("/");
  await page.waitForFunction(() => !!window.__fipsHarness);

  const reply = await page.evaluate(async () => {
    const h = window.__fipsHarness;
    const pair = await h.autoConnectWebRtcPair(window.__fipsTestRelayUrl!);
    try {
      return await h.echoOverPair(pair, "advert-fmp-connect");
    } finally {
      await pair.a.stop();
      await pair.b.stop();
    }
  });

  expect(reply).toBe("advert-fmp-connect");
});
