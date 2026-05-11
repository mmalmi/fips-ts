/**
 * Live interop test: TS Noise initiator ↔ Rust FIPS Noise responder.
 *
 * Spawns the `fips-rust-bridge` Cargo binary (built from
 * interop/rust-bridge/), which runs the Rust FIPS HandshakeState as a
 * responder. We drive the initiator side from TS through both IK and XK
 * patterns and exchange a transport-message round-trip after each
 * handshake.
 *
 * Skipped if the bridge binary isn't built (so CI without a Rust toolchain
 * still passes the rest of the suite). Build it with:
 *
 *   cargo build --release --manifest-path interop/rust-bridge/Cargo.toml
 */

import { describe, expect, it } from "vitest";

import {
  identityFromSecretKey,
  NoiseHandshake,
  toHex,
} from "../../src/index.js";
import { bridgeAvailable, spawnBridge } from "./bridge.js";

const itIfBridge = bridgeAvailable() ? it : it.skip;

// Fixed responder secret so the Rust side is deterministic. Use plain values
// so both sides agree on the conversation regardless of host-side entropy.
const RUST_RESPONDER_SK_HEX =
  "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const TS_INITIATOR_SK = new Uint8Array(32).fill(0xb2);
const EPOCH_PAYLOAD = new Uint8Array(8);

describe("Noise interop: TS initiator ↔ Rust responder (live handshake)", () => {
  itIfBridge("IK pattern + transport message round-trip", async () => {
    const initiator = await identityFromSecretKey(TS_INITIATOR_SK);
    const bridge = spawnBridge("ik", RUST_RESPONDER_SK_HEX);
    try {
      // 1. Bridge announces its 33-byte compressed static pubkey.
      const responderStatic = await bridge.readFrame();
      expect(responderStatic.length).toBe(33);

      // 2. TS does IK initiator with responder's static.
      const hs = new NoiseHandshake({
        pattern: "IK",
        role: "initiator",
        identity: initiator,
        remoteStatic: responderStatic,
      });
      const msg1 = hs.writeMessage(EPOCH_PAYLOAD);
      expect(msg1.length).toBe(106);
      await bridge.writeFrame(msg1);

      // 3. Receive IK msg2 from Rust.
      const msg2 = await bridge.readFrame();
      expect(msg2.length).toBe(57);
      const inboundPayload = hs.readMessage(msg2);
      expect(inboundPayload.length).toBe(8);

      // 4. Transport: encrypt ping with our tx cipher (empty AAD, counter 0).
      const { tx, rx } = hs.splitTxRx();
      const ping = new TextEncoder().encode("ping-from-ts");
      const pingCt = tx.encryptWithAd(new Uint8Array(0), ping);
      await bridge.writeFrame(pingCt);

      // 5. Read Rust's encrypted pong and decrypt with rx cipher.
      const pongCt = await bridge.readFrame();
      const pong = rx.decryptWithAd(new Uint8Array(0), pongCt);
      expect(new TextDecoder().decode(pong)).toBe("pong-from-rust");
    } finally {
      await bridge.close();
    }
  });

  itIfBridge("XK pattern + transport message round-trip", async () => {
    const initiator = await identityFromSecretKey(TS_INITIATOR_SK);
    const bridge = spawnBridge("xk", RUST_RESPONDER_SK_HEX);
    try {
      const responderStatic = await bridge.readFrame();
      expect(responderStatic.length).toBe(33);

      const hs = new NoiseHandshake({
        pattern: "XK",
        role: "initiator",
        identity: initiator,
        remoteStatic: responderStatic,
      });
      if (process.env.INTEROP_DEBUG) {
        console.log("[ts] responder_static =", toHex(responderStatic));
        console.log("[ts] h_after_init =", toHex(hs.getHandshakeHash()));
      }

      // XK msg1: just `e`, no payload (no key yet).
      const msg1 = hs.writeMessage(new Uint8Array(0));
      expect(msg1.length).toBe(33);
      if (process.env.INTEROP_DEBUG) {
        console.log("[ts] msg1 =", toHex(msg1));
        console.log("[ts] h_after_msg1 =", toHex(hs.getHandshakeHash()));
      }
      await bridge.writeFrame(msg1);

      // XK msg2: 57 bytes; we expect an 8-byte epoch payload (Rust default).
      const msg2 = await bridge.readFrame();
      expect(msg2.length).toBe(57);
      const m2Payload = hs.readMessage(msg2);
      expect(m2Payload.length).toBe(8);

      // XK msg3: encrypted static + epoch.
      const msg3 = hs.writeMessage(EPOCH_PAYLOAD);
      expect(msg3.length).toBe(73);
      await bridge.writeFrame(msg3);

      // Transport round-trip.
      const { tx, rx } = hs.splitTxRx();
      const ping = new TextEncoder().encode("ping-from-ts");
      await bridge.writeFrame(tx.encryptWithAd(new Uint8Array(0), ping));
      const pongCt = await bridge.readFrame();
      const pong = rx.decryptWithAd(new Uint8Array(0), pongCt);
      expect(new TextDecoder().decode(pong)).toBe("pong-from-rust");
    } finally {
      await bridge.close();
    }
  });

  if (!bridgeAvailable()) {
    it.skip("(skipped — fips-rust-bridge binary not built)", () => {});
    // eslint-disable-next-line no-console
    console.warn(
      "[noise-interop] skipping; build with: cargo build --release --manifest-path interop/rust-bridge/Cargo.toml",
    );
  }

  // Help TS compiler — keep toHex imported for callers using the same module.
  void toHex;
});
