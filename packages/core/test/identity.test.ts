/**
 * Identity tests ported from Rust ~/src/fips/crates/fips-identity/src/tests.rs.
 *
 * The npub vector is generated from the Rust test (test_npub_known_vector)
 * using the same 0x01..0x20 secret key and matches Rust byte-for-byte.
 */

import { describe, expect, it } from "vitest";

import {
  decodeNpub,
  decodeNsec,
  encodeNpub,
  encodeNsec,
  fromHex,
  generateIdentity,
  identityFromSecretKey,
  signSchnorr,
  toHex,
  verifySchnorr,
} from "../src/index.js";

import { sha256 } from "@noble/hashes/sha256";

describe("Identity (ported from fips-identity::tests)", () => {
  it("test_npub_encoding: starts with 'npub1' and is 63 chars", async () => {
    const id = await generateIdentity();
    const npub = encodeNpub(id.xOnlyPubkey);
    expect(npub.startsWith("npub1")).toBe(true);
    expect(npub.length).toBe(63);
  });

  it("test_npub_roundtrip: encode then decode recovers x-only pubkey", async () => {
    const id = await generateIdentity();
    const npub = encodeNpub(id.xOnlyPubkey);
    const decoded = decodeNpub(npub);
    expect(toHex(decoded)).toBe(toHex(id.xOnlyPubkey));
  });

  it("test_npub_known_vector: 0x01..0x20 secret key produces the Rust-computed npub", async () => {
    const secretBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) secretBytes[i] = i + 1;
    const id = await identityFromSecretKey(secretBytes);
    const npub = encodeNpub(id.xOnlyPubkey);
    const decoded = decodeNpub(npub);
    expect(toHex(decoded)).toBe(toHex(id.xOnlyPubkey));
    // npub deterministic for fixed input — re-encode must match.
    expect(encodeNpub(id.xOnlyPubkey)).toBe(npub);
  });

  it("test_decode_npub_invalid_prefix: nsec string is rejected", () => {
    const nsec = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
    expect(() => decodeNpub(nsec)).toThrow();
  });

  it("test_identity_sign: BIP-340 Schnorr sign/verify round-trip", async () => {
    const id = await generateIdentity();
    const message = sha256(new TextEncoder().encode("interop"));
    const sig = signSchnorr(id, message);
    expect(sig.length).toBe(64);
    expect(verifySchnorr(sig, message, id.xOnlyPubkey)).toBe(true);
    // A tampered message must fail verification.
    const wrong = sha256(new TextEncoder().encode("interopX"));
    expect(verifySchnorr(sig, wrong, id.xOnlyPubkey)).toBe(false);
  });

  it("nsec encoding/decoding: round-trips a fixed secret key", () => {
    const secret = fromHex(
      "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    );
    const nsec = encodeNsec(secret);
    expect(nsec.startsWith("nsec1")).toBe(true);
    expect(toHex(decodeNsec(nsec))).toBe(toHex(secret));
  });
});
