/**
 * Reverse-role live interop matching WebVM's direct service path:
 * Rust initiates FSP/Noise XK, while TypeScript responds and carries direct
 * transport service datagrams in both directions.
 */

import { describe, expect, it } from "vitest";

import {
  decodeFspEstablished,
  FSP_FLAG_DIRECT_TRANSPORT,
  FSP_MSG_DATA,
  FspSession,
  identityFromSecretKey,
  isDirectFspTransportFragment,
  segmentDirectFspTransportRecord,
  toHex,
} from "../../src/index.js";
import { bridgeAvailable, spawnBridge } from "./bridge.js";

const itIfBridge = bridgeAvailable() ? it : it.skip;

const RUST_INITIATOR_SK_HEX =
  "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const TS_RESPONDER_SK = new Uint8Array(32).fill(0xd4);
const RUST_SERVICE_BODY_LEN = 16 * 1024;
const MAX_FSP_SERVICE_BODY_LEN = 0xffff - 6 - 4;
const DIRECT_PATH_MTU = 1_200;

function serviceBody(length: number, salt: number): Uint8Array {
  return Uint8Array.from(
    { length },
    (_, index) => (salt + index * 31 + (index >>> 8)) & 0xff,
  );
}

describe("FSP interop: Rust initiator -> TS responder", () => {
  itIfBridge("exchanges direct service records and returns a DFP1-segmented maximum record", async () => {
    const identity = await identityFromSecretKey(TS_RESPONDER_SK);
    const session = new FspSession({ identity, role: "responder" });
    const bridge = spawnBridge("fsp-initiator", RUST_INITIATOR_SK_HEX);

    try {
      const initiatorStatic = await bridge.readFrame();
      expect(initiatorStatic).toHaveLength(33);
      await bridge.writeFrame(identity.publicKey);

      const msg1 = await bridge.readFrame();
      const msg2 = session.handleMsg1(msg1, () => new Uint8Array(0));
      await bridge.writeFrame(msg2);

      const msg3 = await bridge.readFrame();
      session.handleMsg3(msg3);
      expect(session.state).toBe("established");
      expect(toHex(session.remotePubkey!)).toBe(toHex(initiatorStatic));

      const rustRecord = await bridge.readFrame();
      const rustEstablished = decodeFspEstablished(rustRecord);
      expect(rustEstablished.flags).toBe(FSP_FLAG_DIRECT_TRANSPORT);
      const incoming = session.decryptIncoming(rustRecord);
      expect(incoming.msgType).toBe(FSP_MSG_DATA);
      expect(incoming.data).toEqual({
        srcPort: 0x1010,
        dstPort: 0x2020,
        payload: serviceBody(RUST_SERVICE_BODY_LEN, 0x31),
      });

      const replyBody = serviceBody(MAX_FSP_SERVICE_BODY_LEN, 0x72);
      const replyRecord = session.encryptDatagram(
        { srcPort: 0x3030, dstPort: 0x4040, payload: replyBody },
        FSP_FLAG_DIRECT_TRANSPORT,
      );
      const fragments = segmentDirectFspTransportRecord(replyRecord, DIRECT_PATH_MTU);
      expect(replyRecord).toHaveLength(65_563);
      expect(fragments).toHaveLength(56);
      expect(fragments.every((fragment) => fragment.length <= DIRECT_PATH_MTU)).toBe(true);
      expect(fragments.every(isDirectFspTransportFragment)).toBe(true);

      for (const fragment of fragments.reverse()) {
        await bridge.writeFrame(fragment);
      }

      const rustDecryptedReply = await bridge.readFrame();
      expect(rustDecryptedReply).toEqual(replyBody);
      expect(await bridge.close()).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  if (!bridgeAvailable()) {
    it.skip("(skipped - fips-rust-bridge binary not built)", () => {});
  }
});
