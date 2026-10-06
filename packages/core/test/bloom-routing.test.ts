import {describe, expect, it} from 'vitest';
import {BloomFilter, buildFilterAnnounce, encodeFilterAnnounce, identityFromSecretKey, noopLogger, toHex} from '../src/index.js';
import {BloomRouting} from '../src/node/BloomRouting.js';
import type {AdjacentPeer} from '../src/node/PeerState.js';

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
