/**
 * AuthChallenge tests ported from Rust
 * ~/src/fips/crates/fips-identity/src/tests.rs.
 */

import { describe, expect, it } from "vitest";

import {
  authChallengeDigest,
  bytesEqual,
  encodeNpub,
  generateAuthChallenge,
  generateIdentity,
  PeerIdentity,
  signChallenge,
  signSchnorr,
  toHex,
  verifyChallenge,
} from "../src/index.js";

import { sha256 } from "@noble/hashes/sha256";

describe("AuthChallenge (Rust auth.rs)", () => {
  it("test_auth_challenge_verify_success: signed response verifies and yields the signer's NodeAddr", async () => {
    const id = await generateIdentity();
    const challenge = generateAuthChallenge();
    const ts = 1234567890n;

    const response = signChallenge(id, challenge, ts);
    const addr = verifyChallenge(challenge, response);
    expect(bytesEqual(addr, id.nodeAddr)).toBe(true);
  });

  it("test_auth_challenge_verify_wrong_challenge: response to challenge1 fails for challenge2", async () => {
    const id = await generateIdentity();
    const c1 = generateAuthChallenge();
    const c2 = generateAuthChallenge();
    const response = signChallenge(id, c1, 1234567890n);
    expect(() => verifyChallenge(c2, response)).toThrow(/verification failed/);
  });

  it("test_auth_challenge_verify_wrong_timestamp: tampering with timestamp invalidates the response", async () => {
    const id = await generateIdentity();
    const challenge = generateAuthChallenge();
    const response = signChallenge(id, challenge, 1234567890n);
    const tampered = { ...response, timestamp: 9999999999n };
    expect(() => verifyChallenge(challenge, tampered)).toThrow(/verification failed/);
  });

  it("digest is deterministic for fixed inputs", () => {
    const challenge = new Uint8Array(32).fill(0xaa);
    const d1 = authChallengeDigest(challenge, 7n);
    const d2 = authChallengeDigest(challenge, 7n);
    expect(toHex(d1)).toBe(toHex(d2));
    expect(d1.length).toBe(32);
  });
});

describe("PeerIdentity (Rust peer.rs)", () => {
  it("test_peer_identity_from_npub: round-trip through npub recovers the same x-only pubkey", async () => {
    const id = await generateIdentity();
    const peer = PeerIdentity.fromNpub(encodeNpub(id.xOnlyPubkey));
    expect(toHex(peer.xOnlyPubkey)).toBe(toHex(id.xOnlyPubkey));
    expect(bytesEqual(peer.nodeAddr, id.nodeAddr)).toBe(true);
  });

  it("test_peer_identity_verify_signature: peer can verify a signature made over SHA256(data)", async () => {
    const id = await generateIdentity();
    const peer = PeerIdentity.fromXOnlyPubkey(id.xOnlyPubkey);
    const data = new TextEncoder().encode("ping over the wire");
    const sig = signSchnorr(id, sha256(data));
    expect(peer.verify(data, sig)).toBe(true);

    // Tampered data fails.
    const tampered = new TextEncoder().encode("ping over the wireX");
    expect(peer.verify(tampered, sig)).toBe(false);
  });

  it("test_peer_identity_from_invalid_npub: throws on garbage input", () => {
    expect(() => PeerIdentity.fromNpub("not an npub")).toThrow();
    expect(() => PeerIdentity.fromNpub("npub1invalidchecksum0000000000000000000000000000000000000000")).toThrow();
  });
});
