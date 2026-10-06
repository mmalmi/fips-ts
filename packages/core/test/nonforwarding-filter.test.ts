import {describe, expect, it} from 'vitest';
import {
  BloomFilter, buildFilterAnnounce, buildTreeAnnounce, encodeFilterAnnounce,
  encodeLookupRequestPayload, encodeTreeAnnounce, identityFromSecretKey,
  LinkMessageType, nodeAddrToHex, noopLogger, toHex,
} from '../src/index.js';
import {FipsRouting} from '../src/node/FipsRouting.js';
import type {AdjacentPeer} from '../src/node/PeerState.js';

async function fixture(forwarding: boolean) {
  const identities = await Promise.all([0x31, 0x32, 0x33, 0x34].map(byte =>
    identityFromSecretKey(new Uint8Array(32).fill(byte))));
  identities.sort((a, b) => nodeAddrToHex(a.nodeAddr).localeCompare(nodeAddrToHex(b.nodeAddr)));
  const [root, local, child, destination] = identities;
  const peers = [root, child].map(identity => ({
    pubkey: identity.publicKey, pubkeyHex: toHex(identity.publicKey),
    link: {state: 'established'}, transport: {mtu: 1500},
  }) as AdjacentPeer);
  const sent: {peer: AdjacentPeer; type: number; payload: Uint8Array}[] = [];
  const routing = new FipsRouting({
    identity: local, forwarding, routingMode: 'reply_learned', transports: [],
    logger: noopLogger, randomBytes: length => new Uint8Array(length),
    getPeers: () => peers,
    getPeerByPubkey: key => peers.find(peer => peer.pubkeyHex === key),
    getPeerByNodeAddr: key => peers.find(peer => nodeAddrToHex(
      identities.find(identity => toHex(identity.publicKey) === peer.pubkeyHex)!.nodeAddr) === key),
    sendLinkMessage: async (peer, type, payload) => {sent.push({peer, type, payload});},
    connectKnownPeer: async () => {}, handleLocalSession: async () => {},
    emitError: error => {throw error;}, isStarted: () => true,
  });
  const entry = (identity: typeof local) => ({nodeAddr: identity.nodeAddr, sequence: 1n, timestamp: 1n});
  await routing.handleLinkMessage(peers[0], LinkMessageType.TreeAnnounce,
    encodeTreeAnnounce(buildTreeAnnounce(root, root.nodeAddr, 1n, 1n, [entry(root)])).subarray(1));
  await routing.handleLinkMessage(peers[1], LinkMessageType.TreeAnnounce,
    encodeTreeAnnounce(buildTreeAnnounce(child, local.nodeAddr, 1n, 1n,
      [entry(child), entry(local), entry(root)])).subarray(1));
  const filter = BloomFilter.empty();
  filter.insertBytes(root.nodeAddr);
  filter.insertBytes(destination.nodeAddr);
  await routing.handleLinkMessage(peers[0], LinkMessageType.FilterAnnounce,
    encodeFilterAnnounce(buildFilterAnnounce(filter, 1n)).subarray(1));
  return {routing, peers, local, destination, sent};
}

describe('nonforwarding browser reachability', () => {
  it('advertises only itself while still answering its own authenticated lookups', async () => {
    const {routing, peers, local, destination, sent} = await fixture(false);
    const own = BloomFilter.empty();
    own.insertBytes(local.nodeAddr);
    expect(peers[1].outboundFilter?.asBytes()).toEqual(own.asBytes());
    expect(peers[1].outboundFilter?.containsBytes(destination.nodeAddr)).toBe(false);

    sent.length = 0;
    const request = {requestId: 1n, origin: destination.nodeAddr, originCoords: [destination.nodeAddr], ttl: 5, minMtu: 1200};
    await routing.handleLinkMessage(peers[0], LinkMessageType.LookupRequest,
      encodeLookupRequestPayload({...request, target: destination.nodeAddr}));
    expect(sent).toHaveLength(0);
    await routing.handleLinkMessage(peers[0], LinkMessageType.LookupRequest,
      encodeLookupRequestPayload({...request, requestId: 2n, target: local.nodeAddr}));
    expect(sent.map(message => message.type)).toEqual([LinkMessageType.LookupResponse]);
    routing.stop();
  });

  it('retains aggregated reachability when forwarding is explicitly enabled', async () => {
    const {routing, peers, local, destination} = await fixture(true);
    expect(peers[1].outboundFilter?.containsBytes(local.nodeAddr)).toBe(true);
    expect(peers[1].outboundFilter?.containsBytes(destination.nodeAddr)).toBe(true);
    routing.stop();
  });
});
