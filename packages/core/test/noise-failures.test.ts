/**
 * Defensive tests ported from Rust ~/src/fips/crates/fips-core/src/noise/tests.rs.
 *
 *   test_decryption_failure_wrong_key
 *   test_session_remote_static
 *   test_cipher_state_nonce_sequence
 */

import { describe, expect, it } from "vitest";

import {
  bytesEqual,
  identityFromSecretKey,
  NoiseHandshake,
} from "../src/index.js";

const A_SK = new Uint8Array(32).fill(0x11);
const B_SK = new Uint8Array(32).fill(0x22);
const C_SK = new Uint8Array(32).fill(0x33);
const E_OVR = new Uint8Array(32).fill(0xab);

describe("Noise defensive coverage", () => {
  it("test_decryption_failure_wrong_key: handshake fails when initiator targets wrong responder", async () => {
    // Initiator A intends to talk to B but uses C's pubkey as `rs`.
    // Responder B receives msg1; the AEAD won't open because the chaining
    // keys diverge.
    const a = await identityFromSecretKey(A_SK);
    const b = await identityFromSecretKey(B_SK);
    const c = await identityFromSecretKey(C_SK);
    const hsI = new NoiseHandshake({
      pattern: "IK",
      role: "initiator",
      identity: a,
      remoteStatic: c.publicKey, // wrong target
      ephemeralOverride: E_OVR,
    });
    const hsR = new NoiseHandshake({
      pattern: "IK",
      role: "responder",
      identity: b, // expects to be addressed
    });
    const msg1 = hsI.writeMessage(new Uint8Array(8));
    expect(() => hsR.readMessage(msg1)).toThrow();
  });

  it("test_session_remote_static: responder learns initiator's static after IK msg1", async () => {
    const a = await identityFromSecretKey(A_SK);
    const b = await identityFromSecretKey(B_SK);
    const hsI = new NoiseHandshake({
      pattern: "IK",
      role: "initiator",
      identity: a,
      remoteStatic: b.publicKey,
      ephemeralOverride: E_OVR,
    });
    const hsR = new NoiseHandshake({
      pattern: "IK",
      role: "responder",
      identity: b,
    });
    expect(hsR.getRemoteStatic()).toBeUndefined();
    hsR.readMessage(hsI.writeMessage(new Uint8Array(8)));
    const learned = hsR.getRemoteStatic();
    expect(learned).toBeDefined();
    expect(bytesEqual(learned!, a.publicKey)).toBe(true);
  });

  it("test_cipher_state_nonce_sequence: TX/RX counters advance independently and in order", async () => {
    const a = await identityFromSecretKey(A_SK);
    const b = await identityFromSecretKey(B_SK);
    const hsI = new NoiseHandshake({
      pattern: "IK",
      role: "initiator",
      identity: a,
      remoteStatic: b.publicKey,
      ephemeralOverride: E_OVR,
    });
    const hsR = new NoiseHandshake({
      pattern: "IK",
      role: "responder",
      identity: b,
    });
    hsR.readMessage(hsI.writeMessage(new Uint8Array(8)));
    hsI.readMessage(hsR.writeMessage(new Uint8Array(8)));
    const { tx: aTx, rx: aRx } = hsI.splitTxRx();
    const { tx: bTx, rx: bRx } = hsR.splitTxRx();

    // 100 messages each direction; both sides must agree at every counter.
    for (let i = 0; i < 100; i++) {
      const ct = aTx.encryptWithAd(new Uint8Array(0), new TextEncoder().encode(`a${i}`));
      expect(new TextDecoder().decode(bRx.decryptWithAd(new Uint8Array(0), ct))).toBe(`a${i}`);
      const ct2 = bTx.encryptWithAd(new Uint8Array(0), new TextEncoder().encode(`b${i}`));
      expect(new TextDecoder().decode(aRx.decryptWithAd(new Uint8Array(0), ct2))).toBe(`b${i}`);
    }
    expect(aTx.nonce).toBe(100n);
    expect(bRx.nonce).toBe(100n);
  });
});
