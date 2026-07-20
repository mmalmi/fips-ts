import { describe, expect, it } from "vitest";

import {
  RECENT_PEERS_MAX_ENDPOINTS,
  RECENT_PEERS_MAX_PEERS,
  createRecentPeers,
  encodeNpub,
  identityFromSecretKey,
  observeAuthenticatedPeer,
  parseRecentPeers,
  pruneRecentPeers,
  type RecentPeers,
} from "../src/index.js";

async function npubFor(seed: number): Promise<string> {
  const secretKey = new Uint8Array(32);
  new DataView(secretKey.buffer).setUint32(28, seed + 1, false);
  const identity = await identityFromSecretKey(secretKey);
  return encodeNpub(identity.xOnlyPubkey);
}

describe("RecentPeers", () => {
  it("creates the version-1 cross-language JSON shape", async () => {
    const localNpub = await npubFor(0);

    expect(createRecentPeers(localNpub, "fips-overlay-v1")).toEqual({
      version: 1,
      local_npub: localNpub,
      scope: "fips-overlay-v1",
      peers: {},
    });
  });

  it("observes authenticated peers without mutating the input", async () => {
    const localNpub = await npubFor(1);
    const remoteNpub = await npubFor(2);
    const empty = createRecentPeers(localNpub, "scope-a");

    const observed = observeAuthenticatedPeer(
      empty,
      remoteNpub,
      1_000,
      "192.0.2.1:32112",
    );
    const refreshed = observeAuthenticatedPeer(
      observed,
      remoteNpub,
      2_000,
      "192.0.2.2:32112",
    );

    expect(empty.peers).toEqual({});
    expect(refreshed.peers[remoteNpub]).toEqual({
      last_authenticated_at_ms: 2_000,
      endpoints: [
        {
          transport: "udp",
          addr: "192.0.2.2:32112",
          last_authenticated_at_ms: 2_000,
        },
        {
          transport: "udp",
          addr: "192.0.2.1:32112",
          last_authenticated_at_ms: 1_000,
        },
      ],
    });
  });

  it("keeps only the newest four UDP endpoints", async () => {
    const localNpub = await npubFor(3);
    const remoteNpub = await npubFor(4);
    let recent = createRecentPeers(localNpub, "scope-a");

    for (let index = 0; index < RECENT_PEERS_MAX_ENDPOINTS + 1; index++) {
      recent = observeAuthenticatedPeer(
        recent,
        remoteNpub,
        1_000 + index,
        `192.0.2.${index + 1}:32112`,
      );
    }

    expect(recent.peers[remoteNpub]!.endpoints).toHaveLength(RECENT_PEERS_MAX_ENDPOINTS);
    expect(recent.peers[remoteNpub]!.endpoints.map(({ addr }) => addr)).toEqual([
      "192.0.2.5:32112",
      "192.0.2.4:32112",
      "192.0.2.3:32112",
      "192.0.2.2:32112",
    ]);
  });

  it("caps peers by most recent authenticated observation", async () => {
    const localNpub = await npubFor(5);
    let recent = createRecentPeers(localNpub, "scope-a");
    const tiedOldestNpubs: string[] = [];
    let newestNpub = "";

    for (let index = 0; index < RECENT_PEERS_MAX_PEERS + 1; index++) {
      const remoteNpub = await npubFor(100 + index);
      if (index < 2) tiedOldestNpubs.push(remoteNpub);
      newestNpub = remoteNpub;
      recent = observeAuthenticatedPeer(
        recent,
        remoteNpub,
        index < 2 ? 1_000 : 1_000 + index,
      );
    }

    const [evictedNpub, retainedNpub] = tiedOldestNpubs.sort();
    expect(Object.keys(recent.peers)).toHaveLength(RECENT_PEERS_MAX_PEERS);
    expect(recent.peers[evictedNpub!]).toBeUndefined();
    expect(recent.peers[retainedNpub!]).toBeDefined();
    expect(recent.peers[newestNpub]).toBeDefined();
  });

  it("accepts only reusable numeric UDP socket addresses", async () => {
    const localNpub = await npubFor(12);
    const remoteNpub = await npubFor(13);
    const empty = createRecentPeers(localNpub, "scope-a");

    for (const invalidAddr of [
      "peer.example:32112",
      "192.168.1.1:0",
      "192.168.001.001:32112",
      "0.0.0.0:32112",
      "224.0.0.1:32112",
      "[::]:32112",
      "[ff02::1]:32112",
    ]) {
      expect(() => observeAuthenticatedPeer(empty, remoteNpub, 1_000, invalidAddr))
        .toThrow(/reusable numeric UDP socket address/);
    }

    const observed = observeAuthenticatedPeer(
      empty,
      remoteNpub,
      1_000,
      "[2001:0db8:0:0:0:0:0:1]:032112",
    );
    expect(observed.peers[remoteNpub]!.endpoints[0]!.addr)
      .toBe("[2001:db8::1]:32112");

    const scoped = observeAuthenticatedPeer(
      observed,
      remoteNpub,
      2_000,
      "[fe80::1%0003]:32112",
    );
    expect(scoped.peers[remoteNpub]!.endpoints[0]!.addr)
      .toBe("[fe80::1%3]:32112");
  });

  it("rejects semantically duplicate UDP socket addresses", async () => {
    const localNpub = await npubFor(14);
    const remoteNpub = await npubFor(15);
    const recent: RecentPeers = {
      version: 1,
      local_npub: localNpub,
      scope: "scope-a",
      peers: {
        [remoteNpub]: {
          last_authenticated_at_ms: 1_000,
          endpoints: [
            {
              transport: "udp",
              addr: "[2001:db8::1]:32112",
              last_authenticated_at_ms: 1_000,
            },
            {
              transport: "udp",
              addr: "[2001:0db8:0:0:0:0:0:1]:32112",
              last_authenticated_at_ms: 1_000,
            },
          ],
        },
      },
    };

    expect(() => parseRecentPeers(recent, localNpub, "scope-a"))
      .toThrow(/unique UDP addresses/);
  });

  it("prunes stale peers and endpoints by authenticated age", async () => {
    const localNpub = await npubFor(6);
    const staleNpub = await npubFor(7);
    const liveNpub = await npubFor(8);
    let recent = createRecentPeers(localNpub, "scope-a");
    recent = observeAuthenticatedPeer(recent, staleNpub, 1_000, "192.0.2.1:32112");
    recent = observeAuthenticatedPeer(recent, liveNpub, 1_000, "192.0.2.2:32112");
    recent = observeAuthenticatedPeer(recent, liveNpub, 4_000);

    const pruned = pruneRecentPeers(recent, 5_000, 1_500);

    expect(pruned.peers[staleNpub]).toBeUndefined();
    expect(pruned.peers[liveNpub]).toEqual({
      last_authenticated_at_ms: 4_000,
      endpoints: [],
    });
  });

  it("strictly parses the expected identity, scope, keys, and limits", async () => {
    const localNpub = await npubFor(9);
    const remoteNpub = await npubFor(10);
    const recent = observeAuthenticatedPeer(
      createRecentPeers(localNpub, "scope-a"),
      remoteNpub,
      1_000,
      "192.0.2.1:32112",
    );
    const jsonValue: unknown = JSON.parse(JSON.stringify(recent));
    const otherLocalNpub = await npubFor(11);

    expect(parseRecentPeers(jsonValue, localNpub, "scope-a")).toEqual(recent);
    expect(() => parseRecentPeers(jsonValue, localNpub, "scope-b")).toThrow(/scope/);
    expect(() => parseRecentPeers(jsonValue, otherLocalNpub, "scope-a")).toThrow(/local_npub/);

    expect(() => parseRecentPeers({ ...recent, extra: true }, localNpub, "scope-a"))
      .toThrow(/keys/);
    expect(() => parseRecentPeers({ ...recent, version: 2 }, localNpub, "scope-a"))
      .toThrow(/version/);

    const wrongTransport = structuredClone(recent) as unknown as {
      peers: Record<string, { endpoints: Array<{ transport: string }> }>;
    };
    wrongTransport.peers[remoteNpub]!.endpoints[0]!.transport = "webrtc";
    expect(() => parseRecentPeers(wrongTransport, localNpub, "scope-a"))
      .toThrow(/transport/);

    const extraEndpointKey = structuredClone(recent) as unknown as {
      peers: Record<string, { endpoints: Array<Record<string, unknown>> }>;
    };
    extraEndpointKey.peers[remoteNpub]!.endpoints[0]!.candidate = "not allowed";
    expect(() => parseRecentPeers(extraEndpointKey, localNpub, "scope-a"))
      .toThrow(/keys/);

    const malformed = structuredClone(recent) as RecentPeers;
    malformed.peers[remoteNpub]!.endpoints.push({
      transport: "udp",
      addr: "192.0.2.2:32112",
      last_authenticated_at_ms: 1_000,
    });
    malformed.peers[remoteNpub]!.endpoints.push({
      transport: "udp",
      addr: "192.0.2.3:32112",
      last_authenticated_at_ms: 1_000,
    });
    malformed.peers[remoteNpub]!.endpoints.push({
      transport: "udp",
      addr: "192.0.2.4:32112",
      last_authenticated_at_ms: 1_000,
    });
    malformed.peers[remoteNpub]!.endpoints.push({
      transport: "udp",
      addr: "192.0.2.5:32112",
      last_authenticated_at_ms: 1_000,
    });
    expect(() => parseRecentPeers(malformed, localNpub, "scope-a")).toThrow(/endpoints/);
  });
});
