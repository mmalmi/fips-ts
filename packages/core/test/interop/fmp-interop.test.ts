/**
 * Live interop test: TypeScript FMP link frames with a Rust responder.
 *
 * This covers the layer above raw WebRTC: the browser transports opaque
 * packets, but a useful FIPS peer also has to complete the FMP link handshake
 * and decrypt established link frames byte-for-byte with Rust.
 */

import { describe, expect, it } from "vitest";

import {
  FMP_INNER_DATA,
  FmpLink,
  identityFromSecretKey,
  toHex,
} from "../../src/index.js";
import { bridgeAvailable, spawnBridge } from "./bridge.js";

const itIfBridge = bridgeAvailable() ? it : it.skip;

const RUST_RESPONDER_SK_HEX =
  "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const TS_INITIATOR_SK = new Uint8Array(32).fill(0xb2);

describe("FMP interop: TS initiator ↔ Rust responder", () => {
  itIfBridge("handshakes and exchanges established link frames", async () => {
    const identity = await identityFromSecretKey(TS_INITIATOR_SK);
    const bridge = spawnBridge("fmp", RUST_RESPONDER_SK_HEX);
    try {
      const responderStatic = await bridge.readFrame();
      expect(responderStatic.length).toBe(33);

      const link = new FmpLink({
        identity,
        remotePubkey: responderStatic,
        role: "initiator",
        sessionIdx: 0x01020304,
        localEpoch: new Uint8Array(8).fill(0x44),
      });

      const msg1 = link.buildMsg1(() => new Uint8Array(0)).packet;
      expect(msg1.length).toBe(114);
      await bridge.writeFrame(msg1);

      const msg2 = await bridge.readFrame();
      const handshake = link.handleMsg2(msg2);
      expect(handshake.established).toBe(true);
      expect(toHex(handshake.remotePubkey)).toBe(toHex(responderStatic));
      expect(link.remoteEpoch).toEqual(new Uint8Array(8));

      const payload = new TextEncoder().encode("hello-rust-fmp");
      await bridge.writeFrame(link.encryptOutgoing(payload, FMP_INNER_DATA));

      const rustPlaintext = await bridge.readFrame();
      expect(rustPlaintext[4]).toBe(FMP_INNER_DATA);
      expect(new TextDecoder().decode(rustPlaintext.slice(5))).toBe("hello-rust-fmp");

      const rustEncrypted = await bridge.readFrame();
      const decoded = link.decryptIncoming(rustEncrypted);
      expect(decoded.msgType).toBe(FMP_INNER_DATA);
      expect(new TextDecoder().decode(decoded.payload)).toBe("pong-from-rust-fmp");
    } finally {
      await bridge.close();
    }
  });

  if (!bridgeAvailable()) {
    it.skip("(skipped — fips-rust-bridge binary not built)", () => {});
    console.warn(
      "[fmp-interop] skipping; build with: cargo build --release --manifest-path interop/rust-bridge/Cargo.toml",
    );
  }
});
