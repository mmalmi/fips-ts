/**
 * Ported from Rust ~/src/fips/crates/fips-core/src/noise/tests.rs
 * test_handshake_with_odd_parity_responder.
 *
 * When the responder's secret key produces an odd-parity public key (0x03
 * prefix), and the initiator only knows the x-only pubkey (e.g. from an
 * npub) — so it assumes even parity (0x02) — the pre-message MixHash must
 * normalize parity so both sides produce matching hash chains.
 *
 * This is the test that catches a missing or buggy
 * `normalize_for_premessage`. Our `NoiseHandshake` ctor sets the parity
 * byte to 0x02 before mixing.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { describe, expect, it } from "vitest";

import {
  fromHex,
  identityFromSecretKey,
  NoiseHandshake,
  toHex,
} from "../src/index.js";

const ODD_PARITY_SK = fromHex(
  "b102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fb0",
);
const EVEN_PARITY_SK = fromHex(
  "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
);

describe("Noise IK with odd-parity responder + x-only-known initiator", () => {
  it("handshake completes when initiator assumes even parity for the responder", async () => {
    const responder = await identityFromSecretKey(ODD_PARITY_SK);
    const initiator = await identityFromSecretKey(EVEN_PARITY_SK);

    // Sanity: responder's actual compressed key starts with 0x03 (odd).
    expect(responder.publicKey[0]).toBe(0x03);

    // Initiator only has the x-only pubkey (npub form) and constructs the
    // assumed-even variant.
    const xOnly = responder.xOnlyPubkey;
    const assumedEven = new Uint8Array(33);
    assumedEven[0] = 0x02;
    assumedEven.set(xOnly, 1);
    // The assumed-even key must be a valid curve point but DIFFERENT from
    // the real (odd-parity) compressed key.
    expect(toHex(assumedEven)).not.toBe(toHex(responder.publicKey));
    // And it must round-trip through the secp256k1 library.
    expect(() => secp256k1.ProjectivePoint.fromHex(toHex(assumedEven))).not.toThrow();

    // Run the handshake using the assumed-even key (initiator side).
    const hsI = new NoiseHandshake({
      pattern: "IK",
      role: "initiator",
      identity: initiator,
      remoteStatic: assumedEven,
    });
    const hsR = new NoiseHandshake({
      pattern: "IK",
      role: "responder",
      identity: responder,
    });

    const epoch = new Uint8Array(8);
    const msg1 = hsI.writeMessage(epoch);
    expect(msg1.length).toBe(106);
    expect(hsR.readMessage(msg1).length).toBe(8);

    const msg2 = hsR.writeMessage(epoch);
    expect(msg2.length).toBe(57);
    expect(hsI.readMessage(msg2).length).toBe(8);

    // Sessions agree: encrypt with initiator's TX cipher, decrypt with
    // responder's RX cipher.
    const { tx: itx } = hsI.splitTxRx();
    const { rx: rrx } = hsR.splitTxRx();
    const ct = itx.encryptWithAd(new Uint8Array(0), new TextEncoder().encode("parity test"));
    const pt = rrx.decryptWithAd(new Uint8Array(0), ct);
    expect(new TextDecoder().decode(pt)).toBe("parity test");
  });
});
