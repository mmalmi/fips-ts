# fips-ts

Browser TypeScript implementation of [FIPS](https://github.com/jmcorgan/fips) — node identity, FMP / FSP, WebRTC and virtual-Ethernet transports, Nostr signaling (NIP-44 v2 + NIP-59 gift wrap), endpoint bytes, service-port datagrams, and browser endpoint helpers.

The Rust reference lives at **[jmcorgan/fips](https://github.com/jmcorgan/fips)** (canonical) with a mirror at **[mmalmi/fips](https://github.com/mmalmi/fips)**. This package targets byte-for-byte wire compatibility with that codebase and ships a live interop test that drives the Rust Noise responder over stdio from TS — see [`interop/`](interop/) and [`docs/rust-compat.md`](docs/rust-compat.md).

## Layout

```
packages/core              FipsNode, identity, NIP-19 npub, FMP / FSP codecs,
                           Noise IK + XK over secp256k1, routing, services
packages/transport-memory  In-process transport for tests and same-page peers
packages/transport-ethernet  Full-frame virtual Ethernet transport for browser
                           VMs and virtual NICs (EtherType 0x2121)
packages/transport-webrtc  RTCDataChannel transport with Nostr signaling
                           (kind 37195 adverts, kind 21059 NIP-59 wraps over
                           NIP-44 v2 content)
packages/browser           IndexedDB identity store + createBrowserFipsNode
apps/demo                  Vanilla-TS Vite demo
tests/e2e                  Playwright acceptance tests
interop/rust-bridge        Cargo binary depending on ~/src/fips for live
                           Rust ↔ TS handshake interop
fixtures/rust-vectors      Deterministic codec vectors
docs/                      Architecture, rust-compat, signal protocol
```

## Quickstart

```sh
pnpm install
pnpm dev               # open http://127.0.0.1:5173
pnpm test:unit         # vitest unit/interop tests
pnpm test:e2e          # 7 playwright tests (chromium)

# Optional: live Rust ↔ TS Noise interop (needs ~/src/fips checked out)
cargo build --release --manifest-path interop/rust-bridge/Cargo.toml
pnpm --filter '@fips/core' test:unit  # the interop tests now run
```

## Architecture

```
application endpoint bytes or service-port datagrams
  → FSP end-to-end session (Noise XK over secp256k1)
  → FMP mesh / link layer (Noise IK over secp256k1)
  → WebRTC datachannel, virtual Ethernet, or MemoryTransport in tests
  → Nostr signaling (NIP-59 gift wrap, NIP-44 v2 content)
```

The invariant: **WebRTC connects adjacent peers. FIPS routes opaque bytes to node identities. Applications route their own content.** Don't push content hashes into FIPS.

`VirtualEthernetTransport` takes a generic port with `onFrame(listener)` and
`sendFrame(frame)`. Both callbacks carry complete Ethernet frames without an
FCS, making the package independent of any particular browser VM. Discovery
beacons are consumed by `FipsNode` and establish a real FMP link automatically.
Non-direct traffic requires an explicit `FipsNodeConfig.defaultRoute` next hop.

See [`docs/architecture.md`](docs/architecture.md), [`docs/rust-compat.md`](docs/rust-compat.md), [`docs/signal-protocol.md`](docs/signal-protocol.md), [`docs/hashtree-integration.md`](docs/hashtree-integration.md).

## License

MIT.
