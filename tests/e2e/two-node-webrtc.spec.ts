import { test, expect } from "@playwright/test";

import { startLocalNostrRelay, type LocalNostrRelay } from "./fixtures/localNostrRelay.js";

let relay: LocalNostrRelay;
let replacementRelay: LocalNostrRelay;

test.beforeAll(async () => {
  [relay, replacementRelay] = await Promise.all([
    startLocalNostrRelay(),
    startLocalNostrRelay(),
  ]);
});

test.afterAll(async () => {
  await Promise.all([relay.close(), replacementRelay.close()]);
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

test("a reloaded page rejects replayed packets from its previous FMP epoch", async ({ page, context }) => {
  const listenerPage = await context.newPage();
  const discoveryApp = `fips-page-reload-${crypto.randomUUID()}`;
  const initiatorStore = `fips-page-reload-initiator-${crypto.randomUUID()}`;
  const listenerStore = `fips-page-reload-listener-${crypto.randomUUID()}`;
  for (const candidate of [page, listenerPage]) {
    await candidate.addInitScript((url) => {
      window.__fipsTestRelayUrl = url;
    }, relay.url);
    await candidate.goto("/");
    await candidate.waitForFunction(() => !!window.__fipsHarness);
  }

  const listenerPubkey = await listenerPage.evaluate(
    ([storeName, app]) => window.__fipsHarness.startPersistentWebRtcPeer(
      window.__fipsTestRelayUrl!, storeName, app,
    ),
    [listenerStore, discoveryApp] as const,
  );
  const initiatorPubkey = await page.evaluate(
    ([storeName, app]) => window.__fipsHarness.startPersistentWebRtcPeer(
      window.__fipsTestRelayUrl!, storeName, app,
    ),
    [initiatorStore, discoveryApp] as const,
  );

  await page.evaluate(
    (remotePubkey) => window.__fipsHarness.connectPersistentWebRtcPeer(remotePubkey),
    listenerPubkey,
  );
  await listenerPage.evaluate(
    (remotePubkey) => window.__fipsHarness.waitForPersistentWebRtcPeer(remotePubkey),
    initiatorPubkey,
  );
  await expect(page.evaluate(
    (remotePubkey) => window.__fipsHarness.echoPersistentWebRtcPeer(remotePubkey, "before-reload"),
    listenerPubkey,
  )).resolves.toBe("before-reload");
  const oldEventCount = relay.eventCount();

  await page.reload();
  await page.waitForFunction(() => !!window.__fipsHarness);
  const reloadedPubkey = await page.evaluate(
    ([storeName, app]) => window.__fipsHarness.startPersistentWebRtcPeer(
      window.__fipsTestRelayUrl!, storeName, app,
    ),
    [initiatorStore, discoveryApp] as const,
  );
  expect(reloadedPubkey).toBe(initiatorPubkey);
  relay.pauseBroadcasts();
  const reconnect = page.evaluate(
    (remotePubkey) => window.__fipsHarness.connectPersistentWebRtcPeer(remotePubkey),
    listenerPubkey,
  );
  await expect.poll(() => relay.eventCount()).toBeGreaterThan(oldEventCount);
  // A fresh JS realm used to restart the module-global receiver index at one.
  // Deliver the old 69-byte FMP Msg2 while the replacement Msg1 is pending so
  // that collision is deterministic rather than dependent on relay timing.
  relay.replayPrefix(oldEventCount, 69);
  relay.resumeBroadcasts();
  await reconnect;
  await expect(page.evaluate(
    (remotePubkey) => window.__fipsHarness.echoPersistentWebRtcPeer(remotePubkey, "after-reload"),
    listenerPubkey,
  )).resolves.toBe("after-reload");

  relay.replayPrefix(oldEventCount);
  await page.waitForTimeout(250);
  const errors = {
    initiator: await page.evaluate(() => window.__fipsHarness.persistentWebRtcPeerErrors()),
    listener: await listenerPage.evaluate(
      () => window.__fipsHarness.persistentWebRtcPeerErrors(),
    ),
  };
  expect([...errors.initiator, ...errors.listener]).not.toContainEqual(
    expect.stringContaining("invalid tag"),
  );
  await expect(page.evaluate(
    (remotePubkey) => window.__fipsHarness.echoPersistentWebRtcPeer(remotePubkey, "after-replay"),
    listenerPubkey,
  )).resolves.toBe("after-replay");

  await Promise.all([
    page.evaluate(() => window.__fipsHarness.stopPersistentWebRtcPeer()),
    listenerPage.evaluate(() => window.__fipsHarness.stopPersistentWebRtcPeer()),
  ]);
  await listenerPage.close();
});
