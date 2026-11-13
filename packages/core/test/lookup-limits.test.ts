import {afterEach, describe, expect, it, vi} from 'vitest';
import {decodeLookupRequest, encodeLookupRequestPayload, identityFromSecretKey, LinkMessageType, nodeAddrToHex, noopLogger, toHex} from '../src/index.js';
import {FipsRouting} from '../src/node/FipsRouting.js';
import type {AdjacentPeer} from '../src/node/PeerState.js';

type Identity = Awaited<ReturnType<typeof identityFromSecretKey>>;
const peerFor = (identity: Identity) => ({pubkey: identity.publicKey, pubkeyHex: toHex(identity.publicKey), transport: {mtu: 1200}, link: {state: 'established'}} as AdjacentPeer);

async function fixture(options: {peers?: number} = {}) {
  const ids = await Promise.all([0x41, 0x42, 0x43, 0x44].map(value => identityFromSecretKey(new Uint8Array(32).fill(value))));
  const [local, target, first, second] = ids as [Identity, Identity, Identity, Identity];
  const peers = [peerFor(first), peerFor(second)].slice(0, options.peers ?? 2);
  let randomSequence = 0;
  const sent: Array<{peer: AdjacentPeer; type: number; payload: Uint8Array}> = [];
  const sendLinkMessage = vi.fn(async (peer: AdjacentPeer, type: number, payload: Uint8Array) => { sent.push({peer, type, payload}); });
  const routing = new FipsRouting({identity: local, forwarding: true, routingMode: 'reply_learned', transports: [], logger: noopLogger,
    randomBytes: length => { const bytes = new Uint8Array(length); bytes[0] = ++randomSequence; bytes[1] = randomSequence >> 8; return bytes; },
    getPeers: () => peers, getPeerByPubkey: () => undefined, getPeerByNodeAddr: () => undefined, sendLinkMessage,
    connectKnownPeer: async () => {}, handleLocalSession: async () => {}, emitError: () => {}, isStarted: () => true});
  vi.useFakeTimers();
  const targetHex = nodeAddrToHex(target.nodeAddr);
  const lookup = () => routing.ensureFirstContactRoute(target.nodeAddr, targetHex, target.publicKey)
    .then(() => 'success', (error: Error) => error.message);
  const lookups = () => sent.filter(entry => entry.type === LinkMessageType.LookupRequest);
  return {routing, peers, sent, lookups, lookup, target, targetHex, first, second, local, ids};
}

afterEach(() => vi.useRealTimers());

describe('origin lookup backoff for unreachable targets', () => {
  it('suppresses fresh lookups for 30 s after a timeout, then doubles the wait', async () => {
    const {routing, lookups, lookup} = await fixture();
    try {
      const firstResult = lookup();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await firstResult).toMatch(/no route/);
      const afterFirst = lookups().length;
      expect(afterFirst).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(await lookup()).toMatch(/no route/);
      expect(lookups()).toHaveLength(afterFirst);

      await vi.advanceTimersByTimeAsync(20_000); // 30 s after the first timeout
      const secondResult = lookup();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await secondResult).toMatch(/no route/);
      const afterSecond = lookups().length;
      expect(afterSecond).toBeGreaterThan(afterFirst);

      await vi.advanceTimersByTimeAsync(31_000); // within the doubled 60 s window
      expect(await lookup()).toMatch(/no route/);
      expect(lookups()).toHaveLength(afterSecond);
      await vi.advanceTimersByTimeAsync(29_000);
      void lookup();
      await vi.advanceTimersByTimeAsync(0);
      expect(lookups().length).toBeGreaterThan(afterSecond);
    } finally { routing.stop(); }
  });

  it('retries immediately after a new authenticated peer or session proves reachability', async () => {
    const {routing, lookups, lookup, targetHex} = await fixture();
    try {
      const failed = lookup();
      await vi.advanceTimersByTimeAsync(5_000);
      await failed;
      const afterFailure = lookups().length;

      routing.resetLookupBackoff();
      void lookup();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(lookups().length).toBeGreaterThan(afterFailure);
      const afterReset = lookups().length;

      routing.noteSessionEstablished(targetHex);
      void lookup();
      await vi.advanceTimersByTimeAsync(0);
      expect(lookups().length).toBeGreaterThan(afterReset);
    } finally { routing.stop(); }
  });

  it('gives a lookup that had no peer to ask one retry once a peer exists', async () => {
    const {routing, peers, lookups, lookup, first} = await fixture({peers: 0});
    try {
      const unsent = lookup();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await unsent).toMatch(/no route/);
      expect(lookups()).toHaveLength(0);

      peers.push(peerFor(first));
      void lookup();
      await vi.advanceTimersByTimeAsync(0);
      expect(lookups()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await lookup()).toMatch(/no route/);
      await vi.advanceTimersByTimeAsync(0);
      expect(lookups().length).toBeLessThanOrEqual(7);
    } finally { routing.stop(); }
  });
});

describe('transit lookup forwarding limit', () => {
  async function transit() {
    const f = await fixture();
    const origin = await identityFromSecretKey(new Uint8Array(32).fill(0x45));
    let requestId = 1000n;
    const receive = (target = f.target) => f.routing.handleLinkMessage(f.peers[0]!, LinkMessageType.LookupRequest,
      encodeLookupRequestPayload({requestId: ++requestId, target: target.nodeAddr, origin: origin.nodeAddr, ttl: 8, minMtu: 0, originCoords: [origin.nodeAddr]}));
    const forwarded = () => f.lookups().filter(entry => entry.peer === f.peers[1]);
    return {...f, receive, forwarded};
  }

  it('forwards an offline target at most once per 2 s, holding one waiter for the next slot', async () => {
    const {routing, receive, forwarded} = await transit();
    try {
      // The origin's fresh-ID attempt schedule: 0, 0.25, 0.75, 1.75, 2.75, 3.75, 4.75 s.
      for (const delay of [0, 250, 500, 1_000, 1_000, 1_000, 1_000]) {
        await vi.advanceTimersByTimeAsync(delay);
        await receive();
      }
      await vi.advanceTimersByTimeAsync(2_000);
      expect(forwarded().length).toBeGreaterThanOrEqual(3);
      expect(forwarded().length).toBeLessThanOrEqual(4);
    } finally { routing.stop(); }
  });

  it('forwards the held waiter when the target slot opens', async () => {
    const {routing, receive, forwarded} = await transit();
    try {
      await receive();
      await vi.advanceTimersByTimeAsync(100);
      await receive();
      expect(forwarded()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_899);
      expect(forwarded()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(forwarded()).toHaveLength(2);
      expect(decodeLookupRequest(forwarded()[1]!.payload).requestId).toBe(1002n);
    } finally { routing.stop(); }
  });

  it('does not limit lookups for different targets', async () => {
    const {routing, receive, forwarded, ids} = await transit();
    try {
      for (const target of ids) await receive(target);
      // Lookups for this node itself are answered, not forwarded.
      expect(forwarded()).toHaveLength(ids.length - 1);
    } finally { routing.stop(); }
  });
});
