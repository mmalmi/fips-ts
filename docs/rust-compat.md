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

`SessionSetup` and `SessionAck` body flag `0x04` advertises support for
established FSP records carried directly on an authenticated adjacent
transport. Both endpoints must advertise the bit before TypeScript emits the
established-record direct flag `0x08`; otherwise it retains FSP inside FMP.
This preserves interoperability with original FIPS 0.4.1.

### Service-port DataPacket (FSP msg_type 0x10)
Inside the FSP AEAD body:

```
src_port : u16 LE
dst_port : u16 LE
payload  : bytes
```

Port 256 is the IPv6 shim (not used in browser). Apps should use 1024–65535. Hashtree uses 7001.

### Ethernet transport

The browser virtual-Ethernet boundary carries full frames without an FCS:

```
destination MAC : 6 bytes
source MAC      : 6 bytes
EtherType       : 0x2121 (u16 BE)
payload         : FIPS Ethernet record
```

Data records are `0x00 || fmp_length:u16-LE || FMP`. The explicit length trims
minimum-frame padding before FMP authentication. Discovery records are
`0x01 || 0x01 || x-only-pubkey[32]` with an optional
`scope_length:u8 || scope:utf8` trailer. The FMP MTU is at most the interface
payload MTU minus the three-byte data-record header.

Source: `crates/fips-core/src/transport/ethernet/`. Exact full-frame fixtures
are at `fixtures/rust-vectors/ethernet-frames.json`.

## Crypto

- DH: secp256k1 ECDH followed by `SHA-256(x-coordinate)`. Both sides hash
  only the x-coord so initiator and responder agree even when the initiator
  only knows the x-only pubkey (from an npub). See
  `~/src/fips/crates/fips-core/src/noise/handshake.rs::ecdh`.
- AEAD: ChaCha20-Poly1305 (ring in Rust, `@noble/ciphers` in TS)
- Hash: SHA-256
- Patterns (implemented in `packages/core/src/noise/`):
  - Link layer (FMP): `Noise_IK_secp256k1_ChaChaPoly_SHA256`
  - Session layer (FSP): `Noise_XK_secp256k1_ChaChaPoly_SHA256`
- Noise HKDF: chained HMAC-SHA256 with byte counters 0x01/0x02/0x03
- Nonce: 4 zero bytes ‖ 8-byte LE counter (12 bytes); Established frames
  index AEAD nonces by the explicit u64 counter carried in the frame header
- Replay window: 2048 packets (WireGuard style)

### Deviations from the Noise spec that we match for Rust interop

- **Pre-message MixHash normalizes responder static to 0x02 parity** so
  initiator-with-x-only and responder-with-real-key produce identical hash
  chains.
- **EncryptAndHash uses empty AAD** during the handshake (Noise spec says
  AAD = h; Rust's `cipher.encrypt(plaintext)` uses `&[]`).
- **XK msg1 omits the trailing empty-payload AEAD tag** entirely (33 bytes
  rather than 49). Rust's `write_xk_message_1` does not call
  `encrypt_and_hash` after the `e, es` tokens.
- **IK msg2 `se` actually computes `DH(e_initiator, s_responder)`** (i.e.,
  `es` operands) rather than the spec's `DH(s_initiator, e_responder)`. XK
  msg3 `se` uses the standard semantics.

These behaviors are codified in `packages/core/src/noise/handshake.ts` and
covered by the live interop tests in `packages/core/test/interop/`.

Handshake-payload sizes (must be exactly 8 bytes — currently zeros; Rust
carries a u64 epoch here):

- IK msg1: 106 bytes = 33 (e) + 49 (enc_s) + 24 (enc_payload+tag)
- IK msg2: 57 bytes  = 33 (e) + 24 (enc_payload+tag)
- XK msg1: 33 bytes  = 33 (e), no encrypted payload (no key yet)
- XK msg2: 57 bytes  = 33 (e) + 24 (enc_payload+tag)
- XK msg3: 73 bytes  = 49 (enc_s) + 24 (enc_payload+tag)

Deterministic vectors are at `fixtures/rust-vectors/noise-handshakes.json`
(regenerate with `REGENERATE_VECTORS=1 pnpm -C packages/core test:unit`).
Once Rust ships an equivalent exporter, the two JSON files should match
byte-for-byte modulo the epoch field.

## Nostr

- Advert kind: 37195 (parameterized replaceable)
- Link negotiation: ordinary FSP DataPacket (`0x10`) on service port 257
- Advert tags: `d=<app-scope>`, `protocol=<app-scope>`, `version=1`
- Nostr relays carry signed adverts only, never FIPS physical records

Advert content (JSON):

```json
{
  "identifier": "fips-overlay-v1",
  "version": 1,
  "endpoints": [
    { "transport": "webrtc", "addr": "<pubkey-hex>" }
  ],
  "stunServers": ["stun:..."]
}
```

The Playwright Rust interop test starts a native Rust WebSocket seed and
verifies WSS FMP/FSP bootstrap, FSP-carried WebRTC negotiation, direct-link
promotion, endpoint echo, disconnect, and replacement-browser reconnect.

## Signatures

64-byte secp256k1 Schnorr (BIP-340), used on adverts and proof-of-possession messages.

## Test vectors

The Rust repo has no exported hex test-vector files. To generate vectors locally:

```sh
FIPS_RUST_REPO=../fips pnpm generate:rust-vectors
```

(Script to be added; currently fixtures are produced inside this repo and compared via Vitest.)
