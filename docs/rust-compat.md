# Rust FIPS compatibility

Reference: `mmalmi/fips` (Rust), `~/src/fips`.

## Wire format

### NodeAddr
- 16 bytes = first 16 bytes of SHA-256 of the **32-byte x-only** secp256k1 public key.
- Source: `crates/fips-identity/src/node_addr.rs`.

### FMP (mesh/link layer)
4-byte common prefix:

```
byte 0 : (ver << 4) | phase     // ver=1, phase ∈ {0,1,2}
byte 1 : flags                  // 0 during handshake
byte 2-3 : payload_len (u16 LE)
```

- Phase 0x1 (Msg1, handshake initiation): total **114 bytes** = 4 prefix + 4 sender_idx (u32 LE) + 106 Noise_IK msg1.
- Phase 0x2 (Msg2, handshake response):  total **69 bytes**  = 4 prefix + 4 sender_idx + 4 receiver_idx + 57 Noise_IK msg2.
- Phase 0x0 (Established, encrypted):
  - Header (AAD): 4 prefix + 4 receiver_idx (u32 LE) + 8 counter (u64 LE) = 16 bytes
  - Body: AEAD ciphertext + 16-byte ChaCha20-Poly1305 tag
  - Inner plaintext: 4-byte timestamp (u32 LE) + 1-byte msg_type + payload

Source: `crates/fips-core/src/node/wire.rs`.

### FSP (end-to-end session)
Same 4-byte common prefix. Phases 0x1/0x2/0x3 are Noise_XK msg1/2/3. Phase 0x0 (Established) header is 4 prefix + 8 counter (u64 LE) = **12 bytes** (no receiver_idx — dispatched by FMP src_addr).

Inner plaintext: 4-byte timestamp + 1-byte msg_type + 1-byte inner_flags + payload.

Source: `crates/fips-core/src/node/session_wire.rs`.

### Service-port DataPacket (FSP msg_type 0x10)
Inside the FSP AEAD body:

```
src_port : u16 LE
dst_port : u16 LE
payload  : bytes
```

Port 256 is the IPv6 shim (not used in browser). Apps should use 1024–65535. Hashtree uses 7001.

## Crypto

- DH: secp256k1 ECDH
- AEAD: ChaCha20-Poly1305 (ring in Rust, `@noble/ciphers` in TS)
- Hash: SHA-256
- Patterns:
  - Link layer (FMP): `Noise_IK_secp256k1_ChaChaPoly_SHA256`
  - Session layer (FSP): `Noise_XK_secp256k1_ChaChaPoly_SHA256`
- Nonce: 4 zero bytes ‖ 8-byte LE counter (12 bytes)
- Replay window: 2048 packets (WireGuard style)

Sizes:
- IK msg1: 106 bytes
- IK msg2: 57 bytes
- XK msg1: 33 bytes, msg2: 57 bytes, msg3: 73 bytes

## Nostr

- Advert kind: 37195 (parameterized replaceable)
- Signaling kind: 21059 (NIP-59 gift-wrap, NIP-44 encrypted)

Advert content (JSON):

```json
{
  "identifier": "fips-overlay-v1",
  "version": 1,
  "endpoints": [{ "transport": "webrtc", "addr": "<pubkey-hex>" }],
  "signalRelays": ["wss://..."],
  "stunServers": ["stun:..."]
}
```

## Signatures

64-byte secp256k1 Schnorr (BIP-340), used on adverts and proof-of-possession messages.

## Test vectors

The Rust repo has no exported hex test-vector files. To generate vectors locally:

```sh
FIPS_RUST_REPO=../fips pnpm generate:rust-vectors
```

(Script to be added; currently fixtures are produced inside this repo and compared via Vitest.)
