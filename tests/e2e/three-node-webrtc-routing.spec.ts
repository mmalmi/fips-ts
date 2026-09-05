import { test, expect } from "@playwright/test";

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

test("Three-node FIPS routing A -> B -> C upgrades from WSS to real WebRTC", async ({ page }) => {
  await page.addInitScript((url) => {
    window.__fipsTestRelayUrl = url;
  }, relay.url);
  await page.addInitScript((url) => {
    window.__fipsTestWebSocketSeedUrl = url;
  }, seed.url);
  page.on("pageerror", (err) => console.log("pageerror:", err.message));
  await page.exposeFunction("__closeFipsTestWebSocketSeed", () => seed.close());

  await page.goto("/");
  await page.waitForFunction(() => !!window.__fipsHarness);

  const result = await page.evaluate(async () => {
    const h = window.__fipsHarness;
    const three = await h.makeWebRtcChain(window.__fipsTestRelayUrl!);
    try {
      const reply = await h.echoOverChain(three, "webrtc-routed");
      return { reply, forwardedDatagrams: three.forwardedDatagrams() };
    } finally {
      await Promise.all([three.a.stop(), three.b.stop(), three.c.stop()]);
    }
  });

  expect(result.reply).toBe("webrtc-routed");
  expect(result.forwardedDatagrams).toBeGreaterThan(0);
});
