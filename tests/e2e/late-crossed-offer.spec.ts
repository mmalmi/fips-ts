import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startLocalFipsWebSocketSeed, type LocalFipsWebSocketSeed } from "./fixtures/localFipsWebSocketSeed.js";
import { startLocalNostrRelay, type LocalNostrRelay } from "./fixtures/localNostrRelay.js";
import type { LateCrossedOfferPeer } from "./fixtures/lateCrossedOfferPeer.js";

declare global {
  interface Window { __lateCrossedRtc?: LateCrossedOfferPeer }
}

test("a late canceled crossed offer preserves the real RTC carrier and FSP session", async ({ page, context }, testInfo) => {
  let relay: LocalNostrRelay | undefined;
  let seed: LocalFipsWebSocketSeed | undefined;
  let other: Page | undefined;
  let failed = false;
  const pages = [page];
  const modulePath = fileURLToPath(new URL("./fixtures/lateCrossedOfferPeer.ts", import.meta.url)).replaceAll("\\", "/");
  const moduleUrl = `/@fs/${modulePath}`;
  try {
    relay = await startLocalNostrRelay();
    seed = await startLocalFipsWebSocketSeed();
    other = await context.newPage();
    pages.push(other);
    const seedUrl = seed.url;
    const relayUrl = relay.url;
    const keys = await Promise.all(pages.map(async (peer, index) => {
      await peer.goto("/");
      return await peer.evaluate(async ({ url, seedUrl, relayUrl, scalar }) => {
        const fixture = await import(/* @vite-ignore */ url);
        window.__lateCrossedRtc = await fixture.startLateCrossedOfferPeer(seedUrl, relayUrl, scalar);
        return window.__lateCrossedRtc!.publicKey;
      }, { url: moduleUrl, seedUrl, relayUrl, scalar: index + 1 });
    }));
    expect(keys[0]!.slice(2) < keys[1]!.slice(2)).toBe(true);
    await Promise.all(pages.map((peer) => peer.evaluate(() => window.__lateCrossedRtc!.waitForSeed())));
    // Prove routed discovery and authenticated FSP before either RTC offer.
    for (const [index, peer] of pages.entries()) {
      expect(await peer.evaluate(({ remote, text }) => window.__lateCrossedRtc!.echo(remote, text), {
        remote: keys[1 - index]!, text: `routed-bootstrap-${index}`,
      })).toBe(`routed-bootstrap-${index}`);
    }
    await page.evaluate(() => window.__lateCrossedRtc!.holdNextOffer());
    await other.evaluate((key) => window.__lateCrossedRtc!.beginLosingDial(key), keys[0]!);
    const held = await page.evaluate(() => window.__lateCrossedRtc!.waitForHeldOffer());
    expect(held).toMatchObject({ key: keys[1], kind: "offer" });
    await page.evaluate((key) => window.__lateCrossedRtc!.connect(key), keys[1]!);
    expect(await other.evaluate(() => window.__lateCrossedRtc!.losingDialOutcome())).toEqual({
      result: "incoming WebRTC offer won simultaneous dial", firstPcState: "closed",
    });

    await seed.close();
    await Promise.all(pages.map((peer) => peer.evaluate(() => window.__lateCrossedRtc!.waitForSeedDisconnect())));
    for (const [index, peer] of pages.entries()) {
      const remote = keys[1 - index]!;
      expect(await peer.evaluate(({ remote, text }) => window.__lateCrossedRtc!.echo(remote, text), {
        remote, text: `before-late-offer-${index}`,
      })).toBe(`before-late-offer-${index}`);
      expect(await peer.evaluate((key) => window.__lateCrossedRtc!.capture(key), remote))
        .toEqual([["webrtc", "established"]]);
    }

    expect(await page.evaluate(() => window.__lateCrossedRtc!.releaseHeldOffer())).toBe(held.negotiationId);
    for (const [index, peer] of pages.entries()) {
      const remote = keys[1 - index]!;
      // Check ownership before sending: the old runtime fails here, without a
      // replacement handshake or echo timeout concealing the original loss.
      expect(await peer.evaluate((key) => window.__lateCrossedRtc!.status(key), remote)).toMatchObject({
        sameSession: true, established: true, sameKBit: true, sameCarrier: true,
        originalPcState: "connected", peers: [["webrtc", "established"]],
        errors: [], closedSessions: 0,
      });
      expect(await peer.evaluate(({ remote, text }) => window.__lateCrossedRtc!.echo(remote, text), {
        remote, text: `after-late-offer-${index}`,
      })).toBe(`after-late-offer-${index}`);
      expect(await peer.evaluate((key) => window.__lateCrossedRtc!.status(key), remote))
        .toMatchObject({ counterAdvanced: true, sameSession: true, errors: [], closedSessions: 0 });
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const stopped = await Promise.allSettled(pages.map((peer) => peer.evaluate(async () => {
      const fixture = window.__lateCrossedRtc;
      delete window.__lateCrossedRtc;
      return fixture ? await fixture.stop() : true;
    })));
    const servers = await Promise.allSettled([relay?.close(), seed?.close(), other?.close()]);
    const closure = {
      peers: stopped.map((result) => result.status === "fulfilled" && result.value),
      servers: servers.map((result) => result.status),
    };
    await testInfo.attach("late-crossed-offer-cleanup", {
      body: JSON.stringify(closure), contentType: "application/json",
    });
    if (!failed) {
      expect(closure.peers).toEqual([true, true]);
      expect(closure.servers).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    }
  }
});
