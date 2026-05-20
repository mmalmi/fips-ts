/**
 * Full-stack session/transport tests ported from Rust
 * ~/src/fips/crates/fips-core/src/noise/tests.rs.
 *
 *   test_multiple_messages
 *   test_session_replay_protection
 */

import { describe, expect, it } from "vitest";

import {
  bytesEqual,
  identityFromSecretKey,
  NoiseHandshake,
} from "../src/index.js";

async function ikSessions(): Promise<{
  itx: ReturnType<NoiseHandshake["splitTxRx"]>["tx"];
  irx: ReturnType<NoiseHandshake["splitTxRx"]>["rx"];
  rtx: ReturnType<NoiseHandshake["splitTxRx"]>["tx"];
  rrx: ReturnType<NoiseHandshake["splitTxRx"]>["rx"];
}> {
  const a = await identityFromSecretKey(new Uint8Array(32).fill(0xaa));
  const b = await identityFromSecretKey(new Uint8Array(32).fill(0xbb));
  const hsI = new NoiseHandshake({
    pattern: "IK",
    role: "initiator",
    identity: a,
    remoteStatic: b.publicKey,
  });
  const hsR = new NoiseHandshake({
    pattern: "IK",
    role: "responder",
    identity: b,
  });
  hsR.readMessage(hsI.writeMessage(new Uint8Array(8)));
  hsI.readMessage(hsR.writeMessage(new Uint8Array(8)));
  const { tx: itx, rx: irx } = hsI.splitTxRx();
  const { tx: rtx, rx: rrx } = hsR.splitTxRx();
  return { itx, irx, rtx, rrx };
}

describe("Session transport (Rust noise/tests.rs integration)", () => {
  it("test_multiple_messages: 100 ciphertexts each way decrypt correctly, counters end at 100", async () => {
    const { itx, irx, rtx, rrx } = await ikSessions();
    const aad = new Uint8Array(0);
    for (let i = 0; i < 100; i++) {
      const fromA = new TextEncoder().encode(`Message ${i} from A`);
      const fromB = new TextEncoder().encode(`Message ${i} from B`);
      expect(
        new TextDecoder().decode(
          rrx.decryptWithAd(aad, itx.encryptWithAd(aad, fromA)),
        ),
      ).toBe(`Message ${i} from A`);
      expect(
        new TextDecoder().decode(
          irx.decryptWithAd(aad, rtx.encryptWithAd(aad, fromB)),
        ),
      ).toBe(`Message ${i} from B`);
    }
    expect(itx.nonce).toBe(100n);
    expect(rrx.nonce).toBe(100n);
    expect(rtx.nonce).toBe(100n);
    expect(irx.nonce).toBe(100n);
  });

  it("test_session_replay_protection: identical ciphertext can't be decrypted twice (CipherState level)", async () => {
    const { itx, rrx } = await ikSessions();
    const aad = new Uint8Array(0);
    const message = new TextEncoder().encode("test message");
    const ct = itx.encryptWithAd(aad, message);

    // First decryption succeeds.
    const pt = rrx.decryptWithAd(aad, ct);
    expect(bytesEqual(pt, message)).toBe(true);

    // Replay: CipherState's nonce has advanced past 0, so re-applying the
    // same ciphertext with nonce=0 (implicitly handled by AEAD nonce mismatch
    // after the counter moved) must fail.
    expect(() => rrx.decryptWithAd(aad, ct)).toThrow();
  });

  it("FspSession explicit-counter replay protection: replayed frame is rejected by ReplayWindow", async () => {
    const { FspSession } = await import("../src/fsp/session.js");
    const a = await identityFromSecretKey(new Uint8Array(32).fill(0x55));
    const b = await identityFromSecretKey(new Uint8Array(32).fill(0x77));

    const init = new FspSession({
      identity: a,
      role: "initiator",
      remotePubkey: b.publicKey,
    });
    const resp = new FspSession({ identity: b, role: "responder" });

    const m1 = init.buildMsg1(() => new Uint8Array(0));
    const m2 = resp.handleMsg1(m1, () => new Uint8Array(0));
    const m3 = init.handleMsg2(m2, () => new Uint8Array(0));
    resp.handleMsg3(m3);

    const frame = init.encryptDatagram({
      srcPort: 9000,
      dstPort: 9000,
      payload: new TextEncoder().encode("once"),
    });
    const { data } = resp.decryptIncoming(frame);
    expect(new TextDecoder().decode(data!.payload)).toBe("once");

    // Replay: same encrypted FSP frame must be rejected by the ReplayWindow.
    expect(() => resp.decryptIncoming(frame)).toThrow(/replay|duplicate/i);
  });

  it("FspSession endpoint data carries opaque payloads without service ports", async () => {
    const { FspSession, FSP_MSG_ENDPOINT_DATA } = await import("../src/index.js");
    const a = await identityFromSecretKey(new Uint8Array(32).fill(0x35));
    const b = await identityFromSecretKey(new Uint8Array(32).fill(0x53));

    const init = new FspSession({
      identity: a,
      role: "initiator",
      remotePubkey: b.publicKey,
    });
    const resp = new FspSession({ identity: b, role: "responder" });

    const m1 = init.buildMsg1(() => new Uint8Array(0));
    const m2 = resp.handleMsg1(m1, () => new Uint8Array(0));
    const m3 = init.handleMsg2(m2, () => new Uint8Array(0));
    resp.handleMsg3(m3);

    const payload = new TextEncoder().encode("opaque hashtree frame");
    const frame = init.encryptEndpointData(payload);
    const result = resp.decryptIncoming(frame);

    expect(result.msgType).toBe(FSP_MSG_ENDPOINT_DATA);
    expect(result.endpointData).toEqual(payload);
    expect(result.data).toBeUndefined();
  });
});
