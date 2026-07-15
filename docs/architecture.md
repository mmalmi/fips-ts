# Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Application (hashtree, etc.)                                    │
├─────────────────────────────────────────────────────────────────┤
│ FIPS endpoint bytes / optional service-port datagrams           │
├─────────────────────────────────────────────────────────────────┤
│ FSP — end-to-end encrypted session (Noise XK over secp256k1)    │
├─────────────────────────────────────────────────────────────────┤
│ FMP — mesh/link layer (Noise IK over secp256k1, forwarding)     │
├─────────────────────────────────────────────────────────────────┤
│ Transport  ── adjacent only ──                                  │
│   • NostrRelayTransport (kind 21060, MTU 1280, low priority)     │
│   • WebRtcTransport (RTCDataChannel, MTU 1200, unordered)       │
│   • MemoryTransport (tests/demo)                                │
├─────────────────────────────────────────────────────────────────┤
│ Discovery / Negotiation                                         │
│   • Public Nostr peer advert kind 37195                         │
│   • Link negotiation via FSP DataPacket service port 257        │
└─────────────────────────────────────────────────────────────────┘
```

## Layering rules

- **Transport** moves opaque bytes between adjacent peers (for example `nostr_relay:<remote-pubkey>`, `webrtc:<remote-pubkey>`, or `memory:<pubkey>`; never a session id).
- **FMP** is responsible for link encryption (IK), framing, replay protection, link-state, mesh forwarding.
- **FSP** is end-to-end encrypted (XK), independent of the path the FMP frames take.
- **EndpointData** carries app-owned opaque bytes without service ports.
- **Service ports** are u16 LE when an app wants local port dispatch; ports 1024–65535 are application. Port 256 is the IPv6 shim and port 257 is generic link negotiation.
- **Link negotiation** is a service above unchanged FSP framing. Core dispatches an authenticated envelope only to an enabled adapter whose `linkType` matches.
- Application protocols stay above FIPS. Hashtree integration lives in Hashtree as `@hashtree/fips-transport`, which sends `@hashtree/mesh` frames as EndpointData bytes.

## Forwarding

Browser default: `forwarding: false`. Tabs are not reliable transit. Enable for test topologies (A — B — C routing test).

## What the browser cannot do

UDP, TCP listening sockets, Tor sockets, BLE L2CAP, TUN, raw packet capture.
Browsers can still carry FIPS over configured Nostr WebSocket relays and
promote the path to WebRTC when available. There is no browser IPv6 shim.
