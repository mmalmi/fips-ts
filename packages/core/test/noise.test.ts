import { describe, expect, it } from "vitest";

import {
  identityFromSecretKey,
  NoiseHandshake,
  bytesEqual,
  toHex,
} from "../src/index.js";

const initiatorSk = new Uint8Array(32);
initiatorSk.fill(0x11);
const responderSk = new Uint8Array(32);
responderSk.fill(0x22);
const initiatorEphemeral = new Uint8Array(32).fill(0x33);
const responderEphemeral = new Uint8Array(32).fill(0x44);

describe("Noise_IK_secp256k1_ChaChaPoly_SHA256", () => {
  it("produces the FIPS-spec frame sizes for an 8-byte epoch payload", async () => {
    const initiator = await identityFromSecretKey(initiatorSk);
    const responder = await identityFromSecretKey(responderSk);
    const hsI = new NoiseHandshake({
      pattern: "IK",
      role: "initiator",
      identity: initiator,
      remoteStatic: responder.publicKey,
      ephemeralOverride: initiatorEphemeral,
    });
    const hsR = new NoiseHandshake({
      pattern: "IK",
      role: "responder",
      identity: responder,
      ephemeralOverride: responderEphemeral,
    });

    const payload8 = new Uint8Array(8);

    const msg1 = hsI.writeMessage(payload8);
    // 33 (e) + 49 (enc_s) + 24 (enc_payload+tag) = 106
    expect(msg1.length).toBe(106);
    const decoded1 = hsR.readMessage(msg1);
    expect(bytesEqual(decoded1, payload8)).toBe(true);

    const msg2 = hsR.writeMessage(payload8);
    // 33 (e) + 24 (enc_payload+tag) = 57
    expect(msg2.length).toBe(57);
    const decoded2 = hsI.readMessage(msg2);
    expect(bytesEqual(decoded2, payload8)).toBe(true);

    const { tx: itx, rx: irx } = hsI.splitTxRx();
    const { tx: rtx, rx: rrx } = hsR.splitTxRx();

    // Initiator's TX must equal responder's RX (and vice versa) — verify by
    // sealing on one side and opening on the other.
    const aad = new Uint8Array([1, 2, 3, 4]);
    const ct = itx.encryptWithAd(aad, new TextEncoder().encode("hi"));
    const pt = rrx.decryptWithAd(aad, ct);
    expect(new TextDecoder().decode(pt)).toBe("hi");

    const ct2 = rtx.encryptWithAd(aad, new TextEncoder().encode("yo"));
    const pt2 = irx.decryptWithAd(aad, ct2);
    expect(new TextDecoder().decode(pt2)).toBe("yo");

    // Handshake hash equals on both sides — gives us a transcript binding.
    expect(toHex(hsI.getHandshakeHash())).toBe(toHex(hsR.getHandshakeHash()));
  });
});

describe("Noise_XK_secp256k1_ChaChaPoly_SHA256", () => {
  it("produces the FIPS-spec frame sizes for 0/8/8 byte payloads", async () => {
    const initiator = await identityFromSecretKey(initiatorSk);
    const responder = await identityFromSecretKey(responderSk);
    const hsI = new NoiseHandshake({
      pattern: "XK",
      role: "initiator",
      identity: initiator,
      remoteStatic: responder.publicKey,
      ephemeralOverride: initiatorEphemeral,
    });
    const hsR = new NoiseHandshake({
      pattern: "XK",
      role: "responder",
      identity: responder,
      ephemeralOverride: responderEphemeral,
    });

    // XK msg1: 33 bytes (just `e`) with empty (no-key) payload appended unchanged.
    const msg1 = hsI.writeMessage(new Uint8Array(0));
    expect(msg1.length).toBe(33);
    expect(hsR.readMessage(msg1).length).toBe(0);

    const payload8 = new Uint8Array(8);

    const msg2 = hsR.writeMessage(payload8);
    // 33 (e) + 8 + 16 = 57
    expect(msg2.length).toBe(57);
    expect(hsI.readMessage(msg2).length).toBe(8);

    const msg3 = hsI.writeMessage(payload8);
    // 49 (enc_s) + 8 + 16 = 73
    expect(msg3.length).toBe(73);
    expect(hsR.readMessage(msg3).length).toBe(8);

    const { tx: itx } = hsI.splitTxRx();
    const { rx: rrx } = hsR.splitTxRx();
    const ct = itx.encryptWithAd(new Uint8Array(), new TextEncoder().encode("xk"));
    expect(new TextDecoder().decode(rrx.decryptWithAd(new Uint8Array(), ct))).toBe("xk");

    expect(toHex(hsI.getHandshakeHash())).toBe(toHex(hsR.getHandshakeHash()));
  });
});
