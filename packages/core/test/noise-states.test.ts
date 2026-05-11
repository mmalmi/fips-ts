/**
 * Noise state-machine tests ported from Rust
 * ~/src/fips/crates/fips-core/src/noise/tests.rs.
 *
 *   test_wrong_role_errors
 *   test_invalid_pubkey_in_msg1
 *   test_xk_identity_timing
 *   test_xk_wrong_state_errors
 *   test_xk_handshake_hash_differs_from_ik
 */

import { describe, expect, it } from "vitest";

import {
  bytesEqual,
  identityFromSecretKey,
  NoiseHandshake,
  toHex,
} from "../src/index.js";

async function pair() {
  return {
    a: await identityFromSecretKey(new Uint8Array(32).fill(0x11)),
    b: await identityFromSecretKey(new Uint8Array(32).fill(0x22)),
  };
}

describe("Noise state-machine errors (Rust noise/tests.rs)", () => {
  it("test_wrong_role_errors (IK): initiator can't read msg1 or write msg2 first", async () => {
    const { a, b } = await pair();
    const init = new NoiseHandshake({
      pattern: "IK",
      role: "initiator",
      identity: a,
      remoteStatic: b.publicKey,
    });
    expect(() => init.readMessage(new Uint8Array(106))).toThrow();
    // Step has not advanced — writing msg2 (responder's job) at step 0 is also wrong.
    expect(() => {
      // Force-write at step 1 as if init had received a msg2 — but init.step is 0
      // and isSenderForStep(0)=true only for initiator. Writing twice from
      // step 0 advances to step 1 which is responder; second call must throw.
      init.writeMessage(new Uint8Array(8));
      init.writeMessage(new Uint8Array(8));
    }).toThrow(/not our turn/);
  });

  it("test_invalid_pubkey_in_msg1: responder rejects all-zero msg1", async () => {
    const { b } = await pair();
    const resp = new NoiseHandshake({
      pattern: "IK",
      role: "responder",
      identity: b,
    });
    expect(() => resp.readMessage(new Uint8Array(106))).toThrow();
  });

  it("test_xk_identity_timing: XK responder learns initiator static only after msg3", async () => {
    const { a, b } = await pair();
    const init = new NoiseHandshake({
      pattern: "XK",
      role: "initiator",
      identity: a,
      remoteStatic: b.publicKey,
    });
    const resp = new NoiseHandshake({
      pattern: "XK",
      role: "responder",
      identity: b,
    });

    expect(resp.getRemoteStatic()).toBeUndefined();

    const m1 = init.writeMessage(new Uint8Array(0));
    resp.readMessage(m1);
    expect(resp.getRemoteStatic()).toBeUndefined();

    const m2 = resp.writeMessage(new Uint8Array(8));
    init.readMessage(m2);
    expect(resp.getRemoteStatic()).toBeUndefined();

    const m3 = init.writeMessage(new Uint8Array(8));
    resp.readMessage(m3);
    const learned = resp.getRemoteStatic();
    expect(learned).toBeDefined();
    expect(bytesEqual(learned!, a.publicKey)).toBe(true);
  });

  it("test_xk_wrong_state_errors: initiator can't read msg1; responder can't write msg1", async () => {
    const { a, b } = await pair();
    const init = new NoiseHandshake({
      pattern: "XK",
      role: "initiator",
      identity: a,
      remoteStatic: b.publicKey,
    });
    expect(() => init.readMessage(new Uint8Array(33))).toThrow();

    const resp = new NoiseHandshake({
      pattern: "XK",
      role: "responder",
      identity: b,
    });
    expect(() => resp.writeMessage(new Uint8Array(0))).toThrow();
  });

  it("test_xk_handshake_hash_differs_from_ik: different protocol names give different handshake hashes", async () => {
    const { a, b } = await pair();
    const ikI = new NoiseHandshake({
      pattern: "IK",
      role: "initiator",
      identity: a,
      remoteStatic: b.publicKey,
    });
    const xkI = new NoiseHandshake({
      pattern: "XK",
      role: "initiator",
      identity: a,
      remoteStatic: b.publicKey,
    });
    // Even before any message is written, the SymmetricState was initialized
    // with different protocol names, so handshake hashes differ.
    expect(toHex(ikI.getHandshakeHash())).not.toBe(toHex(xkI.getHandshakeHash()));
  });
});
