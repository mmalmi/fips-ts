import { afterEach, describe, expect, it, vi } from "vitest";

import { toHex } from "../src/codec/hex.js";
import {
  FSP_FLAG_DIRECT_TRANSPORT,
  FSP_PHASE_ESTABLISHED,
  peekFspPhase,
} from "../src/fsp/wire.js";
import { FspSession } from "../src/fsp/session.js";
import { identityFromSecretKey } from "../src/identity/index.js";
import { FspSessionManager } from "../src/node/FspSessionManager.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("FspSessionManager", () => {
  it("delivers a direct record that arrives before the routed final handshake", async () => {
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x31));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x72));
    const sentReplies: Uint8Array[] = [];
    const delivered: Uint8Array[] = [];
    const routing = {
      coords: [responderIdentity.nodeAddr],
      learnReverseRoute: () => {},
      sendFspReplyToward: async (
        _remoteNodeAddr: Uint8Array,
        frame: Uint8Array,
      ) => {
        sentReplies.push(new Uint8Array(frame));
      },
    };
    const manager = new FspSessionManager({
      identity: responderIdentity,
      random: { bytes: (length: number) => new Uint8Array(length).fill(0x44) },
      localEpoch: new Uint8Array(8).fill(0x55),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      routing: routing as never,
      getPeerByNodeAddr: () => undefined,
      emitDatagram: () => {},
      emitEndpointData: () => {},
      handleLinkNegotiation: async () => {},
      emitSession: () => {},
    });
    manager.registerService(4_242, ({ payload }) => {
      delivered.push(new Uint8Array(payload));
    });
    const peer = {
      pubkey: initiatorIdentity.publicKey,
      pubkeyHex: "",
      remoteAddr: { transport: "memory", addr: "initiator" },
    } as never;
    const initiator = new FspSession({
      identity: initiatorIdentity,
      role: "initiator",
      remotePubkey: responderIdentity.publicKey,
      localEpoch: new Uint8Array(8).fill(0x66),
    });

    const setup = initiator.buildSessionSetup(
      (length) => new Uint8Array(length),
      initiatorIdentity.nodeAddr,
      responderIdentity.nodeAddr,
    );
    await manager.handleFromPeer(peer, initiatorIdentity.nodeAddr, setup);
    const msg3 = initiator.handleSessionAck(
      sentReplies[0]!,
      (length) => new Uint8Array(length),
    );
    const payload = new TextEncoder().encode("first pubsub record");
    const earlyRecord = initiator.encryptDatagram({
      srcPort: 5_000,
      dstPort: 4_242,
      payload,
    }, FSP_FLAG_DIRECT_TRANSPORT);

    await expect(
      manager.handleFromPeer(peer, initiatorIdentity.nodeAddr, earlyRecord),
    ).resolves.toBeUndefined();
    expect(delivered).toEqual([]);

    await manager.handleFromPeer(peer, initiatorIdentity.nodeAddr, msg3);
    expect(delivered).toEqual([payload]);
  });

  it("shares a setup timeout and replaces it before the next send attempt", async () => {
    vi.useFakeTimers();
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x23));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x67));
    let completeSetup = false;
    let setupAttempts = 0;
    let responder: FspSession | undefined;
    const peer = {
      pubkey: responderIdentity.publicKey,
      pubkeyHex: "",
      remoteAddr: { transport: "memory", addr: "responder" },
    } as never;
    const routing = {
      coords: [initiatorIdentity.nodeAddr],
      coordinatesFor: () => [responderIdentity.nodeAddr],
      learnReverseRoute: () => {},
      sendFspToward: async (_remoteNodeAddr: Uint8Array, frame: Uint8Array) => {
        const phase = peekFspPhase(frame);
        if (phase === 1) {
          setupAttempts += 1;
          if (!completeSetup) return;
          responder = new FspSession({
            identity: responderIdentity,
            role: "responder",
            localEpoch: new Uint8Array(8).fill(0x77),
          });
          const ack = responder.handleSessionSetup(
            frame,
            (length) => new Uint8Array(length).fill(0x31),
            responderIdentity.nodeAddr,
          );
          await manager.handleFromPeer(peer, responderIdentity.nodeAddr, ack);
          return;
        }
        if (phase === 3) {
          responder?.handleSessionMsg3(frame);
          return;
        }
        expect(phase).toBe(FSP_PHASE_ESTABLISHED);
      },
    };
    const manager = new FspSessionManager({
      identity: initiatorIdentity,
      random: { bytes: (length: number) => new Uint8Array(length).fill(0x42) },
      localEpoch: new Uint8Array(8).fill(0x52),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      routing: routing as never,
      getPeerByNodeAddr: () => undefined,
      emitDatagram: () => {},
      emitEndpointData: () => {},
      handleLinkNegotiation: async () => {},
      emitSession: () => {},
    });
    const datagram = {
      dst: toHex(responderIdentity.publicKey),
      dstPort: 4_242,
      payload: new Uint8Array([1, 2, 3]),
    };

    const firstSend = expect(manager.sendDatagram(datagram))
      .rejects.toThrow("FSP handshake timeout");
    const concurrentSend = expect(manager.sendDatagram(datagram))
      .rejects.toThrow("FSP handshake timeout");
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all([firstSend, concurrentSend]);
    expect(setupAttempts).toBe(1);
    completeSetup = true;

    await expect(manager.sendDatagram(datagram)).resolves.toBeUndefined();
    expect(setupAttempts).toBe(2);
    expect(responder?.state).toBe("established");
  });
});
