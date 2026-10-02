import {afterEach, describe, expect, it, vi} from 'vitest';
import {decodeLookupRequest, decodeLookupResponse, encodeLookupResponsePayload, identityFromSecretKey, LinkMessageType, nodeAddrToHex, noopLogger, toHex} from '../src/index.js';
import {FipsRouting} from '../src/node/FipsRouting.js';
import type {AdjacentPeer} from '../src/node/PeerState.js';
import type {OriginLookupRegistry} from '../src/node/OriginLookupRegistry.js';

async function fixture(dropFirstReply = false, collideIds = false) {
  const [local, target, seed] = await Promise.all([0x71, 0x72, 0x73].map(value => identityFromSecretKey(new Uint8Array(32).fill(value))));
  const peer = {pubkey: seed.publicKey, pubkeyHex: toHex(seed.publicKey), transport: {mtu: 1200}, link: {state: 'established'}} as AdjacentPeer;
  const requests: ReturnType<typeof decodeLookupRequest>[] = [];
  const replies: Uint8Array[] = [];
  const admitted = new Set<bigint>();
  let sequence = 0n;
  const randomBytes = (length: number) => {
    const bytes = new Uint8Array(length);
    new DataView(bytes.buffer).setBigUint64(0, collideIds ? 1n : ++sequence, true);
    return bytes;
  };
  const common = {forwarding: false, routingMode: 'reply_learned' as const, transports: [], logger: noopLogger, randomBytes,
    getPeers: () => [peer], getPeerByPubkey: () => peer, getPeerByNodeAddr: () => undefined,
    connectKnownPeer: async () => {}, handleLocalSession: async () => {}, emitError: () => {}, isStarted: () => true};
  const targetRouting = new FipsRouting({...common, identity: target, sendLinkMessage: async (_peer, type, payload) => {
    if (type !== LinkMessageType.LookupResponse) return;
    replies.push(new Uint8Array(payload));
    if (dropFirstReply && replies.length > 1) await deliver(payload);
  }});
  const routing = new FipsRouting({...common, identity: local, sendLinkMessage: async (_peer, type, payload) => {
    if (type !== LinkMessageType.LookupRequest) return;
    const request = decodeLookupRequest(payload);
    requests.push(request);
    // Native-equivalent admission, not a native runtime: fips-core discovery
    // deduplicates an admitted ID before target reply/forwarding. The actual
    // target routing method generates its real signed response below.
    if (admitted.has(request.requestId)) return;
    admitted.add(request.requestId);
    await targetRouting.handleLinkMessage(peer, type, payload);
  }});
  const registry = (routing as unknown as {originLookups: Pick<OriginLookupRegistry, 'findRequest'> & {
    byTarget: Map<string, unknown>; byRequest: Map<bigint, unknown>;
  }}).originLookups;
  const deliver = (payload: Uint8Array) => routing.handleLinkMessage(peer, LinkMessageType.LookupResponse, payload);
  const lookup = () => routing.ensureFirstContactRoute(target.nodeAddr, nodeAddrToHex(target.nodeAddr), target.publicKey);
  const stop = () => {routing.stop(); targetRouting.stop();};
  vi.useFakeTimers();
  return {routing, target, peer, registry, requests, replies, deliver, lookup, stop};
}

afterEach(() => vi.useRealTimers());

describe('signed lookup reply recovery across native-equivalent dedup', () => {
  it('recovers a lost admitted reply with a fresh attempt inside the original deadline', async () => {
    const f = await fixture(true);
    const started = Date.now();
    let settledAt: number | undefined;
    const result = f.lookup().then(() => {settledAt = Date.now() - started; return 'success';}, error => error.message);
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(await result).toBe('success');
      expect(settledAt).toBe(250);
      expect(f.requests).toHaveLength(2);
      expect(new Set(f.requests.map(request => request.requestId)).size).toBe(2);
      expect(f.registry.byTarget.size).toBe(0);
      expect(f.registry.byRequest.size).toBe(0);
    } finally {f.stop();}
  });

  it('accepts the earlier signed reply after a subsequent attempt was issued', async () => {
    const f = await fixture();
    const result = f.lookup();
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(f.requests).toHaveLength(2);
      expect(f.requests.every(request => f.registry.findRequest(request.requestId)?.targetHex === nodeAddrToHex(f.target.nodeAddr))).toBe(true);
      await f.deliver(f.replies[0]!);
      await result;
      expect(f.routing.coordinatesFor(nodeAddrToHex(f.target.nodeAddr))).toEqual([f.target.nodeAddr]);
      expect(f.registry.byRequest.size).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.requests).toHaveLength(2);
    } finally {f.stop();}
  });

  for (const mismatch of ['target', 'request', 'proof'] as const) {
    it(`rejects a ${mismatch} mismatch without admitting a route`, async () => {
      const f = await fixture();
      const result = f.lookup();
      try {
        await vi.advanceTimersByTimeAsync(0);
        const response = decodeLookupResponse(f.replies[0]!);
        if (mismatch === 'target') response.target = new Uint8Array(16);
        if (mismatch === 'request') response.requestId += 1000n;
        if (mismatch === 'proof') response.proof = new Uint8Array(64);
        await f.deliver(encodeLookupResponsePayload(response));
        expect(f.routing.coordinatesFor(nodeAddrToHex(f.target.nodeAddr))).toBeUndefined();
        expect(f.registry.byTarget.size).toBe(1);
        await f.deliver(f.replies[0]!);
        await result;
        expect(f.registry.byRequest.size).toBe(0);
      } finally {f.stop();}
    });
  }

  it('bounds aliases to seven attempts and clears every alias at five seconds', async () => {
    const f = await fixture();
    const result = f.lookup().catch(error => error.message);
    try {
      await vi.advanceTimersByTimeAsync(4999);
      expect(f.requests).toHaveLength(7);
      expect(f.registry.byTarget.size).toBe(1);
      expect(f.registry.byRequest.size).toBe(7);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatch(/no route/);
      expect(f.registry.byTarget.size).toBe(0);
      expect(f.registry.byRequest.size).toBe(0);
      await f.deliver(f.replies[0]!);
      expect(f.routing.coordinatesFor(nodeAddrToHex(f.target.nodeAddr))).toBeUndefined();
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.requests).toHaveLength(7);
    } finally {f.stop();}
  });

  it('keeps the 64 logical lookup capacity with bounded aliases and closes all correlations', async () => {
    const f = await fixture();
    const targets = Array.from({length: 65}, (_, n) => new Uint8Array(16).fill(n + 1));
    const start = (target: Uint8Array) => f.routing.ensureFirstContactRoute(target, nodeAddrToHex(target), f.target.publicKey);
    const results = targets.slice(0, 64).map(target => start(target).catch(error => error.message));
    try {
      await expect(start(targets[64]!)).rejects.toThrow('lookup capacity exceeded');
      await vi.advanceTimersByTimeAsync(4999);
      expect(f.registry.byTarget.size).toBe(64);
      expect(f.registry.byRequest.size).toBe(64 * 7);
      expect(f.requests).toHaveLength(64 * 7);
      const ids = f.requests.map(request => request.requestId);
      f.stop();
      expect((await Promise.all(results)).every(message => message === 'FIPS node stopped')).toBe(true);
      expect(f.registry.byTarget.size).toBe(0);
      expect(f.registry.byRequest.size).toBe(0);
      expect(ids.every(id => f.registry.findRequest(id) === undefined)).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.requests).toHaveLength(64 * 7);
    } finally {f.stop();}
  });

  it('does not admit a delayed signed reply after close', async () => {
    const f = await fixture();
    const result = f.lookup().catch(error => error.message);
    try {
      await vi.advanceTimersByTimeAsync(750);
      f.stop();
      expect(await result).toBe('FIPS node stopped');
      for (const reply of f.replies) await f.deliver(reply);
      expect(f.registry.byRequest.size).toBe(0);
      expect(f.registry.byTarget.size).toBe(0);
      expect(f.routing.coordinatesFor(nodeAddrToHex(f.target.nodeAddr))).toBeUndefined();
    } finally {f.stop();}
  });

  it('propagates exhausted ID allocation and clears previously issued correlations', async () => {
    const f = await fixture(false, true);
    const result = f.lookup().catch(error => error.message);
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(await result).toBe('failed to allocate unique lookup request id');
      expect(f.requests).toHaveLength(1);
      expect(f.registry.byRequest.size).toBe(0);
      expect(f.registry.byTarget.size).toBe(0);
      await f.deliver(f.replies[0]!);
      expect(f.routing.coordinatesFor(nodeAddrToHex(f.target.nodeAddr))).toBeUndefined();
    } finally {f.stop();}
  });
});
