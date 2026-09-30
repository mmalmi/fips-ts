import { describe, expect, it } from "vitest";

import { toHex } from "../src/codec/hex.js";
import { CipherState } from "../src/noise/cipherState.js";

describe("Noise CipherState", () => {
  it("uses the reserved u64 nonce for ChaChaPoly rekey without resetting the message nonce", () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);
    const tx = CipherState.withKey(key);
    tx.encryptWithAd(new Uint8Array(), new Uint8Array([1]));
    tx.rekey();
    // Noise sections 4.2/12.3; independently generated with Python cryptography
    // ChaCha20Poly1305: nonce 00000000ffffffffffffffff, 32 zero bytes, empty AAD.
    expect(toHex(tx.getKey())).toBe("50835543a205b22c9323f2022bc4f67d838f90e61d5ccf33c4513e01f85b5042");
    expect(tx.nonce).toBe(1n);
  });

  it("stops at nonce exhaustion before the reserved nonce or any wraparound", () => {
    const key = new Uint8Array(32).fill(3);
    const tx = CipherState.withKey(key);
    const rx = CipherState.withKey(key);
    Reflect.set(tx, "n", 0xffff_ffff_ffff_fffen);
    Reflect.set(rx, "n", 0xffff_ffff_ffff_fffen);
    const payload = new Uint8Array([1, 2, 3]);
    const frame = tx.encryptWithAd(new Uint8Array(), payload);
    expect(rx.decryptWithAd(new Uint8Array(), frame)).toEqual(payload);
    expect(() => tx.encryptWithAd(new Uint8Array(), payload)).toThrow(/nonce exhausted/);
    expect(() => rx.decryptWithAd(new Uint8Array(), frame)).toThrow(/nonce exhausted/);
    expect(tx.nonce).toBe(0xffff_ffff_ffff_ffffn);
    expect(rx.nonce).toBe(0xffff_ffff_ffff_ffffn);
  });
});
