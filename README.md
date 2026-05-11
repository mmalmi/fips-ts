# fips-ts

Browser TypeScript implementation of FIPS — node identity, FMP/FSP, WebRTC datachannel transport, Nostr-based signaling, optional service-port datagrams, and a hashtree adapter.

Compatibility target: Rust FIPS (`mmalmi/fips`) wire format.

## Layout

```
packages/core              FipsNode, identity, FMP/FSP, codecs, routing
packages/transport-memory  In-process transport for tests
packages/transport-webrtc  RTCDataChannel transport with Nostr signaling
packages/browser           Browser-friendly node bootstrap (IndexedDB identity)
packages/hashtree-adapter  FIPS service-port adapter for @hashtree/mesh
apps/demo                  Vanilla-TS Vite demo
tests/e2e                  Playwright acceptance tests
fixtures/rust-vectors      Cross-impl test vectors
docs/                      Architecture and rust-compat notes
```

## Quickstart

```sh
pnpm install
pnpm dev          # open http://127.0.0.1:5173
pnpm test:unit
pnpm test:e2e
```

## Architecture

```
hashtree → FipsHashtreeStore → FIPS service port 7001
              → FSP end-to-end session
              → FMP mesh/link layer
              → WebRTC datachannel transport (or MemoryTransport in tests)
              → Nostr signaling (relays + STUN)
```

The invariant: **WebRTC connects adjacent peers. FIPS routes to node identities. Hashtree routes to content.** Don't push content hashes into FIPS.

See `docs/architecture.md` and `docs/rust-compat.md`.
