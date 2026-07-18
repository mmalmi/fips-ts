import { test, expect } from "@playwright/test";

import {
  startLocalFipsWebSocketSeed,
  type LocalFipsWebSocketSeed,
} from "./fixtures/localFipsWebSocketSeed.js";
import { startLocalNostrRelay, type LocalNostrRelay } from "./fixtures/localNostrRelay.js";

let relay: LocalNostrRelay;
let replacementRelay: LocalNostrRelay;
let seed: LocalFipsWebSocketSeed;

test.beforeAll(async () => {
  [relay, replacementRelay, seed] = await Promise.all([
    startLocalNostrRelay(),
    startLocalNostrRelay(),
    startLocalFipsWebSocketSeed(),
  ]);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((url) => {
    window.__fipsTestWebSocketSeedUrl = url;
  }, seed.url);
});

test.afterAll(async () => {
  await Promise.all([relay.close(), replacementRelay.close(), seed.close()]);
});

test("Two-node FIPS upgrades from WSS to WebRTC using signed Nostr peer announcements", async ({ page }) => {
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

test("Nostr advert auto-connect replaces a disconnected WebRTC peer", async ({ page }) => {
  await page.addInitScript((url) => {
    window.__fipsTestRelayUrl = url;
  }, relay.url);

  await page.goto("/");
  await page.waitForFunction(() => !!window.__fipsHarness);

  const result = await page.evaluate(async () => {
    return window.__fipsHarness.autoConnectWebRtcReconnect(window.__fipsTestRelayUrl!);
  });

  expect(result).toEqual({
    first: "before-auto-reconnect",
    second: "after-auto-reconnect",
  });
});

test("a restarted peer with the same identity replaces its stale WebRTC session", async ({ page }) => {
  await page.addInitScript((url) => {
    window.__fipsTestRelayUrl = url;
  }, relay.url);

  await page.goto("/");
  await page.waitForFunction(() => !!window.__fipsHarness);

  const result = await page.evaluate(async (replacementRelayUrl) => {
    const incomingAccepted = await window.__fipsHarness.autoConnectWebRtcPeerRestart(
      window.__fipsTestRelayUrl!,
      replacementRelayUrl,
      true,
    );
    const redialConverged = await window.__fipsHarness.autoConnectWebRtcPeerRestart(
      window.__fipsTestRelayUrl!,
      replacementRelayUrl,
      false,
    );
    return { incomingAccepted, redialConverged };
  }, replacementRelay.url);

  expect(result).toEqual({
    incomingAccepted: {
      first: "before-peer-restart",
      second: "after-peer-restart",
    },
    redialConverged: {
      first: "before-peer-restart",
      second: "after-peer-restart",
    },
  });
});

test("a replacement page ignores replayed Msg1 state and completes its fresh dial", async ({ page }) => {
  await page.addInitScript((url) => {
    window.__fipsTestRelayUrl = url;
  }, relay.url);

  await page.goto("/");
  await page.waitForFunction(() => !!window.__fipsHarness);

  const result = await page.evaluate(async () => {
    return window.__fipsHarness.autoConnectWebRtcPeerRestartWithRelayReplay(
      window.__fipsTestRelayUrl!,
    );
  });

  expect(result).toEqual({
    first: "before-peer-restart",
    second: "after-peer-restart",
  });
});
