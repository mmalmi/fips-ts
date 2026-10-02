import {afterEach, describe, expect, it, vi} from 'vitest';
import {decodeLookupRequest, deriveNodeAddr, identityFromSecretKey, LinkMessageType, nodeAddrToHex, noopLogger, toHex} from '../../src/index.js';
import {FipsRouting} from '../../src/node/FipsRouting.js';
import type {AdjacentPeer} from '../../src/node/PeerState.js';
import {bridgeAvailable, spawnBridge} from './bridge.js';

const itIfBridge = bridgeAvailable() ? it : it.skip;
afterEach(() => vi.useRealTimers());

describe('TypeScript lookup origin accepts real Rust-signed retry replies', () => {
  for (const reply of ['second attempt after dropped first reply', 'delayed first attempt'] as const) {
    itIfBridge(reply, async () => {
      const [local, seed] = await Promise.all([0x41, 0x42].map(value => identityFromSecretKey(new Uint8Array(32).fill(value))));
      const bridge = spawnBridge('lookup-target', '72'.repeat(32));
      let routing: FipsRouting | undefined;
      try {
        const targetPublicKey = await bridge.readFrame();
        const target = deriveNodeAddr(targetPublicKey);
        const peer = {pubkey: seed.publicKey, pubkeyHex: toHex(seed.publicKey), transport: {mtu: 1200}, link: {state: 'established'}} as AdjacentPeer;
        const replies: Uint8Array[] = [];
        const requestIds: bigint[] = [];
        let firstReceived!: () => void;
        let secondReceived!: () => void;
        const first = new Promise<void>(resolve => {firstReceived = resolve;});
        const second = new Promise<void>(resolve => {secondReceived = resolve;});
        let sequence = 0;
        routing = new FipsRouting({identity: local, forwarding: false, routingMode: 'reply_learned', transports: [], logger: noopLogger,
          randomBytes: length => new Uint8Array(length).fill(++sequence),
          getPeers: () => [peer], getPeerByPubkey: () => peer, getPeerByNodeAddr: () => undefined,
          connectKnownPeer: async () => {}, handleLocalSession: async () => {}, emitError: () => {}, isStarted: () => true,
          sendLinkMessage: async (_peer, type, payload) => {
            expect(type).toBe(LinkMessageType.LookupRequest);
            requestIds.push(decodeLookupRequest(payload).requestId);
            await bridge.writeFrame(payload);
            replies.push(await bridge.readFrame());
            if (replies.length === 1) firstReceived();
            if (replies.length === 2) secondReceived();
          },
        });
        vi.useFakeTimers();
        const result = routing.ensureFirstContactRoute(target, nodeAddrToHex(target), targetPublicKey);
        await first;
        await vi.advanceTimersByTimeAsync(250);
        await second;
        expect(new Set(requestIds).size).toBe(2);
        // Real Rust codec/signature output enters the ordinary TS verification
        // path. No native dedup or live relay recovery claim is made here.
        await routing.handleLinkMessage(peer, LinkMessageType.LookupResponse, replies[reply === 'delayed first attempt' ? 0 : 1]!);
        await result;
        expect(routing.coordinatesFor(nodeAddrToHex(target))).toEqual([target]);
        await vi.advanceTimersByTimeAsync(5000);
        expect(requestIds).toHaveLength(2);
      } finally {
        routing?.stop();
        vi.useRealTimers();
        expect(await bridge.close()).toBe(0);
      }
    });
  }
});
