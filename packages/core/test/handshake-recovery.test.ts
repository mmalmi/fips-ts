import { describe, expect, it } from "vitest";

import { FmpLink } from "../src/fmp/link.js";
import { FspSession } from "../src/fsp/session.js";
import { identityFromSecretKey } from "../src/identity/index.js";

const random = (length: number) => new Uint8Array(length);

function corruptTag(packet: Uint8Array): Uint8Array {
  const corrupted = new Uint8Array(packet);
  corrupted[corrupted.length - 1] ^= 1;
  return corrupted;
}

describe("handshake authentication recovery", () => {
  it.each(["SessionAck", "SessionMsg3"] as const)(
    "completes FSP after rejecting an unauthenticated %s",
    async (phase) => {
      const a = await identityFromSecretKey(new Uint8Array(32).fill(0x31));
      const b = await identityFromSecretKey(new Uint8Array(32).fill(0x72));
      const initiator = new FspSession({ identity: a, role: "initiator", remotePubkey: b.publicKey });
      const responder = new FspSession({ identity: b, role: "responder" });
      const setup = initiator.buildSessionSetup(random, a.nodeAddr, b.nodeAddr);
      const ack = responder.handleSessionSetup(setup, random, b.nodeAddr);
      if (phase === "SessionAck") {
        expect(() => initiator.handleSessionAck(corruptTag(ack), random)).toThrow();
        expect(initiator.state).toBe("handshaking");
      }
      const msg3 = initiator.handleSessionAck(ack, random);
      if (phase === "SessionMsg3") {
        expect(() => responder.handleSessionMsg3(corruptTag(msg3))).toThrow();
        expect(responder.state).toBe("handshaking");
      }
      responder.handleSessionMsg3(msg3);
      const payload = new TextEncoder().encode("recovered end-to-end session");
      expect(responder.decryptIncoming(initiator.encryptEndpointData(payload)).endpointData)
        .toEqual(payload);
      expect(initiator.decryptIncoming(responder.encryptEndpointData(payload)).endpointData)
        .toEqual(payload);
    },
  );

  it.each(["Msg1", "Msg2"] as const)(
    "completes FMP after rejecting an unauthenticated %s",
    async (phase) => {
      const a = await identityFromSecretKey(new Uint8Array(32).fill(0x32));
      const b = await identityFromSecretKey(new Uint8Array(32).fill(0x73));
      const initiator = new FmpLink({ identity: a, role: "initiator", remotePubkey: b.publicKey,
        sessionIdx: 1, localEpoch: new Uint8Array(8) });
      const responder = new FmpLink({ identity: b, role: "responder", sessionIdx: 2,
        localEpoch: new Uint8Array(8) });
      const msg1 = initiator.buildMsg1(random).packet;
      if (phase === "Msg1") expect(() => responder.handleMsg1(corruptTag(msg1), random)).toThrow();
      const msg2 = responder.handleMsg1(msg1, random).reply!;
      if (phase === "Msg2") expect(() => initiator.handleMsg2(corruptTag(msg2))).toThrow();
      initiator.handleMsg2(msg2);
      const payload = new TextEncoder().encode("recovered adjacent link");
      expect(responder.decryptIncoming(initiator.encryptOutgoing(payload)).payload).toEqual(payload);
      expect(initiator.decryptIncoming(responder.encryptOutgoing(payload)).payload).toEqual(payload);
    },
  );
});
