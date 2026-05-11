# Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Application (hashtree, etc.)                                    │
├─────────────────────────────────────────────────────────────────┤
│ FIPS Service Port datagrams       (port 7001 = hashtree)        │
├─────────────────────────────────────────────────────────────────┤
│ FSP — end-to-end encrypted session (Noise XK over secp256k1)    │
├─────────────────────────────────────────────────────────────────┤
│ FMP — mesh/link layer (Noise IK over secp256k1, forwarding)     │
├─────────────────────────────────────────────────────────────────┤
│ Transport  ── adjacent only ──                                  │
│   • WebRtcTransport (RTCDataChannel, MTU 1200, unordered)       │
│   • MemoryTransport (tests/demo)                                │
├─────────────────────────────────────────────────────────────────┤
│ Discovery / Signaling                                           │
│   • Nostr advert kind 37195                                     │
│   • Nostr signaling kind 21059 (NIP-44 gift-wrap)               │
└─────────────────────────────────────────────────────────────────┘
```

## Layering rules

- **Transport** moves opaque bytes between adjacent peers (a transport address is `webrtc:<remote-pubkey>` or `memory:<pubkey>`, NOT a session id).
- **FMP** is responsible for link encryption (IK), framing, replay protection, link-state, mesh forwarding.
- **FSP** is end-to-end encrypted (XK), independent of the path the FMP frames take.
- **Service ports** are u16 LE; ports 1024–65535 are application; port 256 is reserved (IPv6 shim, not implemented in browser).
- **Hashtree** uses an application service port (default 7001) and reuses the existing `@hashtree/mesh` MessagePack DataRequest/DataResponse encoding.

## Forwarding

Browser default: `forwarding: false`. Tabs are not reliable transit. Enable for test topologies (A — B — C routing test).

## What the browser cannot do

UDP, TCP listening sockets, Tor sockets, BLE L2CAP, TUN, raw packet capture. Therefore FIPS-in-browser is WebRTC-only at the transport layer. There is no browser IPv6 shim.
