# Rust FIPS test vectors

This directory is the destination for hex-encoded test vectors that pin
TypeScript codecs against Rust FIPS byte-for-byte output.

Vectors to produce (planned):

- `nodeaddr.json` — secret-key → 16-byte NodeAddr
- `fmp-codec.json` — FMP Msg1/Msg2/Established frames at known field values
- `fsp-codec.json` — FSP Msg1/Msg2/Msg3/Established
- `session-datagram.json` — DataPacket (src_port/dst_port/payload) bytes

The Rust repo does not ship a vector exporter yet. When it does (or when we
add one), wire it as:

```sh
FIPS_RUST_REPO=../fips pnpm generate:rust-vectors
```

For now, the TypeScript implementation enforces the documented byte layouts
through unit tests in `packages/core/test/`. Once Rust vectors are available
we compare hex strings directly here.
