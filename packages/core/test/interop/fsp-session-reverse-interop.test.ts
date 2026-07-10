import { describe, expect, it } from "vitest";

import {
  FSP_FLAG_DIRECT_TRANSPORT,
  FSP_MSG_DATA,
  DirectFspTransportReassembler,
  FspSession,
  identityFromSecretKey,
  segmentDirectFspTransportRecord,
} from "../../src/index.js";
import { bridgeAvailable, spawnBridge } from "./bridge.js";

const itIfBridge = bridgeAvailable() ? it : it.skip;
const RUST_INITIATOR_SK_HEX = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";

describe("FSP routed-session interop: Rust initiator -> TS responder", () => {
  itIfBridge("exchanges SessionSetup/Ack/Msg3 and direct service data", async () => {
    const identity = await identityFromSecretKey(new Uint8Array(32).fill(0xd4));
    const bridge = spawnBridge("fsp-session-initiator", RUST_INITIATOR_SK_HEX);
    try {
      await bridge.readFrame();
      await bridge.writeFrame(identity.publicKey);
      const session = new FspSession({ identity, role: "responder" });

      const setup = await bridge.readFrame();
      await bridge.writeFrame(
        session.handleSessionSetup(setup, () => new Uint8Array(0), identity.nodeAddr),
      );
      session.handleSessionMsg3(await bridge.readFrame());
      expect(session.state).toBe("established");

      const incoming = session.decryptIncoming(await bridge.readFrame());
      expect(incoming.msgType).toBe(FSP_MSG_DATA);
      const reply = new Uint8Array(65_525).map((_, index) => (0x72 + index * 31 + (index >> 8)) & 0xff);
      const record = session.encryptDatagram({
        srcPort: 0x3030,
        dstPort: 0x4040,
        payload: reply,
      }, FSP_FLAG_DIRECT_TRANSPORT);
      const fragments = segmentDirectFspTransportRecord(record, 1_200).reverse();
      const reassembler = new DirectFspTransportReassembler();
      for (const fragment of fragments) {
        expect(reassembler.ingest("rust", fragment, Date.now()) === undefined).toBe(
          fragment !== fragments.at(-1),
        );
        await bridge.writeFrame(fragment);
      }

      expect(await bridge.readFrame()).toEqual(reply);
      expect(await bridge.close()).toBe(0);
    } finally {
      await bridge.close();
    }
  });
});
