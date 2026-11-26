import {afterEach, describe, expect, it, vi} from 'vitest';
import {BloomFilter, buildFilterAnnounce, encodeFilterAnnounce, identityFromSecretKey, noopLogger, toHex} from '../src/index.js';
import {decodeFilterAnnouncePayload} from '../src/protocol/filter.js';
import {BloomRouting} from '../src/node/BloomRouting.js';
import type {AdjacentPeer} from '../src/node/PeerState.js';

afterEach(() => vi.useRealTimers());

async function fixture() {
  const identity = await identityFromSecretKey(new Uint8Array(32).fill(0x61));
  const peer = {pubkey: identity.publicKey, pubkeyHex: toHex(identity.publicKey)} as AdjacentPeer;
  const routing = new BloomRouting({identity, forwarding: true, logger: noopLogger, getPeers: () => [peer], isTreePeer: () => false, sendLinkMessage: async () => {}, emitError: () => {}});
  const receive = (filledBytes: number, sequence: bigint) => {
    const bytes = new Uint8Array(1024); bytes.fill(255, 0, filledBytes);
    const filter = BloomFilter.fromBytes(bytes, 5);
    return routing.handle(peer, encodeFilterAnnounce(buildFilterAnnounce(filter, sequence)).subarray(1));
  };
  return {peer, receive};
}

describe('native-compatible routing-filter admission', () => {
  it('accepts legitimate aggregates seen on native seeds above the old 5% cap', async () => {
    const {peer, receive} = await fixture();
    await receive(624, 1n); // About 8.4% false positives, as on the public seed network.
    expect(peer.inboundFilter?.countOnes()).toBe(624 * 8);
    expect(peer.inboundFilterSequence).toBe(1n);
  });

  it('retains the 20% antipoison boundary and the last accepted filter', async () => {
    const {peer, receive} = await fixture();
    await receive(741, 1n); // Below the native 20% cap.
    const accepted = peer.inboundFilter;
    expect(accepted?.countOnes()).toBe(741 * 8);
    await receive(743, 2n); // Just above the native cap.
    expect(peer.inboundFilter).toBe(accepted);
    expect(peer.inboundFilterSequence).toBe(1n);
    await receive(1024, 3n);
    expect(peer.inboundFilter).toBe(accepted);
    await receive(10, 1n); // Stale announcements cannot overwrite newer state.
    expect(peer.inboundFilter).toBe(accepted);
  });
});

describe('BloomRouting debounce and tree-peer scoping', () => {
  it('coalesces rapid updates after the initial two-update burst and skips confirmed non-tree routers', async () => {
    vi.useFakeTimers();
    const [local, treeId, sourceId, shortcutId] = await Promise.all(
      [0x71, 0x72, 0x73, 0x74].map(b => identityFromSecretKey(new Uint8Array(32).fill(b))),
    );
    const makePeer = (id: typeof local, seq?: bigint) => ({
      pubkey: id.publicKey, pubkeyHex: toHex(id.publicKey),
      link: {state: 'established'}, routingRoleSequence: seq,
    }) as AdjacentPeer;
    const treePeer = makePeer(treeId, 1n);
    const sourcePeer = makePeer(sourceId, 1n);
    const shortcutPeer = makePeer(shortcutId, 1n);
    const sent: Array<{peer: AdjacentPeer; payload: Uint8Array}> = [];
    const routing = new BloomRouting({
      identity: local, forwarding: true, logger: noopLogger,
      getPeers: () => [treePeer, sourcePeer, shortcutPeer],
      isTreePeer: addr => addr === treeId.nodeAddr || addr === sourceId.nodeAddr
        || toHex(addr) === toHex(treeId.nodeAddr) || toHex(addr) === toHex(sourceId.nodeAddr),
      sendLinkMessage: async (peer, _type, payload) => { sent.push({peer, payload: payload.slice()}); },
      emitError: () => {},
    });
    try {
      const pushSource = async (seq: bigint, tag: number) => {
        const f = BloomFilter.empty();
        f.insertBytes(sourceId.nodeAddr);
        const target = new Uint8Array(16).fill(tag);
        f.insertBytes(target);
        await routing.handle(sourcePeer, encodeFilterAnnounce(buildFilterAnnounce(f, seq)).subarray(1));
        return target;
      };
      // First two distinct updates propagate immediately to treePeer (0ms burst), never to shortcutPeer.
      await pushSource(1n, 1);
      await pushSource(2n, 2);
      expect(sent.filter(s => s.peer === treePeer)).toHaveLength(2);
      expect(sent.filter(s => s.peer === shortcutPeer)).toHaveLength(0);

      // Rapid updates 3..5 within 50ms coalesce into a single trailing flush.
      await pushSource(3n, 3);
      await pushSource(4n, 4);
      const lastTarget = await pushSource(5n, 5);
      expect(sent.filter(s => s.peer === treePeer)).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(50);
      const toTree = sent.filter(s => s.peer === treePeer);
      expect(toTree).toHaveLength(3);
      expect(decodeFilterAnnouncePayload(toTree[2]!.payload).filter.containsBytes(lastTarget)).toBe(true);
      expect(sent.filter(s => s.peer === shortcutPeer)).toHaveLength(0);
    } finally {
      routing.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
