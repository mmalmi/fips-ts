# Rust ↔ TypeScript interop

Two pieces:

- `rust-bridge/` — a tiny Cargo binary whose `fips-core` and `fips-identity`
  dependency aliases point by path to the `nvpn-fips-core` and
  `nvpn-fips-identity` packages in the local
  [Nostr VPN FIPS implementation](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/fips)
  checkout. It runs a Noise IK or XK **responder**, reads 4-byte big-endian
  length-prefixed frames from stdin, and writes responses to stdout.
- The Vitest suite at `packages/core/test/interop/noise-interop.test.ts`
  spawns the bridge and drives the **initiator** side from TypeScript.
  Both IK and XK patterns are exchanged, and a transport-message
  round-trip after each handshake verifies the split CipherStates agree.

## Build the bridge

```sh
cargo build --release --manifest-path interop/rust-bridge/Cargo.toml
```

To reuse a debug build or another checkout's build, set `FIPS_RUST_BRIDGE_BIN`
to the bridge executable path when running the tests. All interop cases share
this setting and also honor `CARGO_TARGET_DIR` for the default release build.

## Run the interop tests

```sh
pnpm --filter '@fips/core' test:unit
```

(They auto-skip if the bridge binary isn't built, so the rest of the suite
stays green in environments without a Rust toolchain.)

For the browser WebRTC interop test, build the native fixture before running
Playwright so compilation does not consume its 90-second startup deadline:

```sh
cargo build --manifest-path ../fips/Cargo.toml --bin fips-webrtc-echo-fixture
FIPS_RS_FIXTURE_BIN=../fips/target/debug/fips-webrtc-echo-fixture pnpm test:e2e
```

Point `FIPS_RS_FIXTURE_BIN` at the resulting executable when using a custom
`CARGO_TARGET_DIR`. Without it, the test retains its `cargo run` convenience path.

## What this proves

A handshake-and-transport round-trip end-to-end through the Rust
implementation verifies that all of the following match byte-for-byte:

- secp256k1 ECDH with `SHA-256(x-coordinate)` post-hashing
- Noise IK + XK state machines (including the FIPS-specific deviations
  documented in `docs/rust-compat.md`)
- ChaCha20-Poly1305 with the `4×0 || u64 LE counter` nonce
- HKDF chain and the symmetric-state split

If you change anything in `packages/core/src/noise/` or `identity/index.ts`,
re-run these tests to catch interop regressions immediately.
