import { afterEach, expect, it, vi } from "vitest";

import { toHex } from "../src/codec/hex.js";
import { peekFspPhase } from "../src/fsp/wire.js";
import { identityFromSecretKey } from "../src/identity/index.js";
import { FspSessionManager } from "../src/node/FspSessionManager.js";
import type { FipsRouting } from "../src/node/FipsRouting.js";
import type { AdjacentPeer } from "../src/node/PeerState.js";

afterEach(() => vi.useRealTimers());

async function pair(drop: (from: number, phase: number, count: number) => boolean) {
  const identities = await Promise.all([0x23, 0x67].map(value => (
    identityFromSecretKey(new Uint8Array(32).fill(value))
  )));
  identities.sort((a, b) => toHex(a.nodeAddr).localeCompare(toHex(b.nodeAddr)));
  const peers = identities.map(identity => ({
    pubkey: identity.publicKey, pubkeyHex: toHex(identity.publicKey),
    remoteAddr: { transport: "memory", addr: toHex(identity.publicKey) },
  } as AdjacentPeer));
  const frames: { from: number; phase: number; frame: Uint8Array }[] = [];
  const delivered: number[][][] = [[], []];
  const managers: FspSessionManager[] = [];
  for (const [from, identity] of identities.entries()) {
    const to = 1 - from;
    const send: FipsRouting["sendFspToward"] = async (_destination, payload) => {
      const packets = typeof payload === "function" ? payload(peers[to]!) : [payload];
      for (const frame of packets) {
        const phase = peekFspPhase(frame);
        frames.push({ from, phase, frame: new Uint8Array(frame) });
        if (drop(from, phase, frames.filter(f => f.from === from && f.phase === phase).length)) continue;
        await managers[to]!.handleFromPeer(peers[from]!, identity.nodeAddr, frame);
      }
    };
    const manager = new FspSessionManager({
      identity, random: { bytes: length => new Uint8Array(length).fill(0x42 + from) },
      localEpoch: new Uint8Array(8).fill(0x52 + from),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      routing: {
        coords: [identity.nodeAddr], hasUsableRoute: () => true, coordinatesFor: () => [identities[to]!.nodeAddr],
        learnReverseRoute: () => {}, sendFspToward: send, sendFspReplyToward: send,
      } as unknown as FipsRouting,
      getPeerByNodeAddr: () => undefined,
      emitDatagram: () => {}, emitEndpointData: () => {},
      handleLinkNegotiation: async () => {}, emitSession: () => {},
    });
    manager.registerService(4_242, ({ payload }) => { delivered[from]!.push([...payload]); });
    managers.push(manager);
  }
  return {
    frames, delivered, managers,
    send: (from: number) => managers[from]!.sendDatagram({
      dst: toHex(identities[1 - from]!.publicKey), dstPort: 4_242,
      payload: new Uint8Array([from + 1]),
    }),
  };
}

it("recovers a lost first Setup when the simultaneous initiator tie chooses its sender", async () => {
  vi.useFakeTimers();
  const network = await pair((from, phase, count) => from === 0 && phase === 1 && count === 1);
  const outcomes: Promise<unknown>[] = [];
  try {
    outcomes.push(network.send(0).catch(error => error));
    await vi.advanceTimersByTimeAsync(0);
    outcomes.push(network.send(1).catch(error => error));
    await vi.advanceTimersByTimeAsync(0);
    expect(network.frames.map(({ from, phase }) => [from, phase])).toEqual([[0, 1], [1, 1]]);
    expect(network.delivered).toEqual([[], []]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(network.delivered).toEqual([[[2]], [[1]]]);
    expect(await Promise.all(outcomes)).toEqual([undefined, undefined]);
    const setups = network.frames.filter(frame => frame.from === 0 && frame.phase === 1);
    expect(setups).toHaveLength(2);
    expect(setups[1]!.frame).toEqual(setups[0]!.frame);
    const sent = network.frames.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(network.frames).toHaveLength(sent);
  } finally {
    network.managers.forEach(manager => manager.stop());
    await Promise.all(outcomes);
  }
});

it("replays the same Setup to recover a lost Ack without replacing authenticated session state", async () => {
  vi.useFakeTimers();
  const network = await pair((from, phase, count) => from === 1 && phase === 2 && count === 1);
  const outcome = network.send(0).catch(error => error);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(network.delivered).toEqual([[], []]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(network.delivered[1]).toEqual([[1]]);
    expect(await outcome).toBeUndefined();
    const acks = network.frames.filter(frame => frame.phase === 2);
    expect(acks).toHaveLength(2);
    expect(acks[1]!.frame).toEqual(acks[0]!.frame);
    await network.send(1);
    expect(network.delivered[0]).toEqual([[2]]);
  } finally {
    network.managers.forEach(manager => manager.stop());
    await outcome;
  }
});
