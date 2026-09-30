import {sha256} from '@noble/hashes/sha256';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {decodeLookupRequest, encodeLookupResponsePayload, identityFromSecretKey, LinkMessageType, lookupResponseProofBytes, nodeAddrToHex, noopLogger, signSchnorr, toHex} from '../src/index.js';
import {FipsRouting} from '../src/node/FipsRouting.js';
import type {AdjacentPeer} from '../src/node/PeerState.js';

async function fixture(answerOnAttempt?: number) {
  const [local, target, seed] = await Promise.all([0x71,0x72,0x73].map(value => identityFromSecretKey(new Uint8Array(32).fill(value))));
  const peer = {pubkey: seed.publicKey, pubkeyHex: toHex(seed.publicKey), transport: {mtu: 1200}, link: {state: 'established'}} as AdjacentPeer;
  let attempts = 0;
  const sendLinkMessage = vi.fn(async (_peer: AdjacentPeer, type: number, payload: Uint8Array) => {
    if (type !== LinkMessageType.LookupRequest || ++attempts !== answerOnAttempt) return;
    const request = decodeLookupRequest(payload);
    const coords = [target.nodeAddr];
    await routing.handleLinkMessage(peer, LinkMessageType.LookupResponse, encodeLookupResponsePayload({requestId: request.requestId, target: target.nodeAddr, targetCoords: coords, pathMtu: 1200, proof: signSchnorr(target, sha256(lookupResponseProofBytes(request.requestId, target.nodeAddr, coords)))}));
  });
  const routing = new FipsRouting({identity: local, forwarding: true, routingMode: 'reply_learned', transports: [], logger: noopLogger, randomBytes: length => new Uint8Array(length), getPeers: () => [peer], getPeerByPubkey: () => peer, getPeerByNodeAddr: () => undefined, sendLinkMessage, connectKnownPeer: async () => {}, handleLocalSession: async () => {}, emitError: () => {}, isStarted: () => true});
  vi.useFakeTimers();
  const lookup = () => routing.ensureFirstContactRoute(target.nodeAddr, nodeAddrToHex(target.nodeAddr), target.publicKey);
  return {routing, sendLinkMessage, lookup};
}

afterEach(() => vi.useRealTimers());

describe('bounded origin-lookup retries', () => {
  it('backs off an unreachable destination without extending its five-second deadline', async () => {
    const {routing, sendLinkMessage, lookup} = await fixture();
    const result = lookup().then(() => 'success', error => error.message);
    try {
      await vi.advanceTimersByTimeAsync(4999);
      expect(sendLinkMessage.mock.calls.length).toBeLessThanOrEqual(7);
      expect(sendLinkMessage.mock.calls.length).toBeGreaterThan(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatch(/no route/);
      const attempts = sendLinkMessage.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(sendLinkMessage).toHaveBeenCalledTimes(attempts);
    } finally {routing.stop();}
  });

  it('recovers a lost initial lookup after 250 ms and stops on the authenticated reply', async () => {
    const {routing, sendLinkMessage, lookup} = await fixture(2);
    const result = lookup();
    try {
      await vi.advanceTimersByTimeAsync(249);
      expect(sendLinkMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await result;
      await vi.advanceTimersByTimeAsync(5000);
      expect(sendLinkMessage).toHaveBeenCalledTimes(2);
    } finally {routing.stop();}
  });
});
