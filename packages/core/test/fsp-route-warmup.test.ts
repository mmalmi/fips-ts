import { expect, it } from "vitest";
import { FspSession } from "../src/fsp/session.js";
import { decodeFspEstablished, FSP_FLAG_CP, FSP_MSG_ENDPOINT_DATA } from "../src/fsp/wire.js";
import { identityFromSecretKey } from "../src/identity/index.js";
import { nodeAddrToHex } from "../src/nodeaddr/index.js";
import { toHex } from "../src/codec/hex.js";
import { FipsNode } from "../src/node/FipsNode.js";
import { decodeSessionDatagramPayload, LinkMessageType } from "../src/protocol/link.js";

// Keep the real session manager, routing, and FSP encryption; only the carrier is a sink.
it("warms a changed transit before its first payload and stops after the bounded burst", async () => {
  const [local, remote, first, second] = await Promise.all([0x31, 0x32, 0x33, 0x34]
    .map((value) => identityFromSecretKey(new Uint8Array(32).fill(value))));
  const initiator = new FspSession({ identity: local, role: "initiator", remotePubkey: remote.publicKey });
  const responder = new FspSession({ identity: remote, role: "responder" });
  responder.handleMsg3(initiator.handleMsg2(
    responder.handleMsg1(initiator.buildMsg1(() => new Uint8Array()), () => new Uint8Array()),
    () => new Uint8Array(),
  ));
  const node = new FipsNode({ identity: local, transports: [], routingMode: "reply_learned" });
  const internal = node as any;
  const destination = nodeAddrToHex(remote.nodeAddr);
  internal.sessionManager.sessions.set(destination, {
    remoteNodeAddr: remote.nodeAddr, remotePubkey: remote.publicKey,
    remotePubkeyHex: toHex(remote.publicKey), fsp: initiator, currentKBit: false,
  });
  internal.routing.coordCache.set(destination, [remote.nodeAddr, first.nodeAddr]);
  const packets: Uint8Array[] = [];
  const makePeer = (identity: typeof first) => ({
    pubkey: identity.publicKey, pubkeyHex: toHex(identity.publicKey),
    remoteAddr: { transport: "sink", addr: toHex(identity.publicKey) },
    link: { state: "established", encryptOutgoing: (payload: Uint8Array) => payload },
    transport: { send: async (_addr: unknown, payload: Uint8Array) => { packets.push(payload); } },
  });
  const peer1 = makePeer(first);
  const peer2 = makePeer(second);
  internal.peersByNodeAddr.set(nodeAddrToHex(first.nodeAddr), peer1);
  internal.peersByNodeAddr.set(nodeAddrToHex(second.nodeAddr), peer2);
  internal.routing.learnReverseRoute(destination, peer1);
  const send = () => node.sendEndpointData({ dst: toHex(remote.publicKey), payload: new Uint8Array([7]) });
  for (const peer of [peer1, peer2]) {
    internal.routing.learnedRoutes.clear();
    internal.routing.learnReverseRoute(destination, peer);
    for (let index = 0; index < 7; index++) {
      packets.length = 0;
      await send();
      expect(packets).toHaveLength(index < 5 ? 2 : 1);
      const frames = packets.map((packet) => decodeSessionDatagramPayload(packet).payload);
      const data = responder.decryptIncoming(frames.at(-1)!);
      expect(data.msgType).toBe(FSP_MSG_ENDPOINT_DATA);
      expect(data.endpointData).toEqual(new Uint8Array([7]));
      expect(decodeFspEstablished(frames.at(-1)!).flags & FSP_FLAG_CP).toBe(0);
      if (index < 5) {
        const warmup = decodeFspEstablished(frames[0]!);
        expect(warmup.flags & FSP_FLAG_CP).toBe(FSP_FLAG_CP);
        expect(warmup.srcCoords).toEqual(internal.routing.coords);
        expect(warmup.destCoords).toEqual([remote.nodeAddr, first.nodeAddr]);
        expect(responder.decryptIncoming(frames[0]!).msgType).toBe(0x14);
        // A cold forwarder learns both sides without seeing the original handshake.
        const transit = new FipsNode({ identity: second, transports: [] });
        await (transit as any).routing.handleLinkMessage(peer1, LinkMessageType.SessionDatagram, packets[0]);
        expect((transit as any).routing.coordinatesFor(destination)).toEqual(warmup.destCoords);
        expect((transit as any).routing.coordinatesFor(nodeAddrToHex(local.nodeAddr))).toEqual(warmup.srcCoords);
      }
    }
  }
});
