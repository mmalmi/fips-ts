# Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│ Application protocol                                            │
│   Hashtree: hash-verified blob GET / response                   │
├─────────────────────────────────────────────────────────────────┤
│ Reliable application stream                                     │
│   TCP/FIPS on service port 39018                                │
├─────────────────────────────────────────────────────────────────┤
│ FSP — end-to-end encrypted session (Noise XK over secp256k1)    │
│   authenticated service datagrams and capability exchange       │
├─────────────────────────────────────────────────────────────────┤
│ FMP — mesh/link layer (Noise IK over secp256k1, forwarding)     │
├─────────────────────────────────────────────────────────────────┤
│ Transport — adjacent peers only                                 │
│   Nostr relay, WebRTC, memory, or virtual Ethernet              │
├─────────────────────────────────────────────────────────────────┤
│ Discovery / negotiation                                         │
│   public Nostr peer adverts; link negotiation on FSP port 257   │
└─────────────────────────────────────────────────────────────────┘
```

## Layering rules

- A **transport** moves opaque bytes between adjacent peers. Its address names
  the remote transport endpoint, never an application session.
- **FMP** owns link encryption, framing, replay protection, link state, mesh
  forwarding, and Noise IK proof of the adjacent peer's identity.
- **FSP** is an end-to-end Noise XK session independent of the path its FMP
  frames take. Service and capability traffic is accepted only in this
  authenticated context.
- **Service datagrams** use little-endian `u16` ports. Ports `1024`–`65535` are
  available to applications; port `256` is the IPv6 shim and port `257` is
  generic link negotiation.
- **TCP/FIPS** adds ordered delivery, flow control, and segment retransmission
  without teaching FIPS about application payloads.
- **Capabilities** describe active authenticated services. A listener-backed
  capability is advertised only while the listener owns its port and is
  withdrawn with that listener.
- `EndpointData` remains a generic portless application primitive, but the
  canonical Hashtree transport does not use it.

## Hashtree example

The canonical Hashtree adapter binds TCP/FIPS service port `39018` and
advertises `hashtree.blob/1`. Clients select an authenticated provider, open a
TCP/FIPS stream, and verify returned bytes against the requested hash. FIPS
does not carry Hashtree's former raw mesh framing and does not decide content
availability, provider ranking, retries, or caching.

## Forwarding

Browser forwarding defaults to disabled because tabs are not reliable transit
nodes. Enable it deliberately for routed test topologies such as A—B—C.

## Browser boundary

Browsers cannot open UDP, native TCP-listening, Tor, BLE L2CAP, TUN, or raw
packet-capture sockets. They can carry FIPS over configured Nostr WebSocket
relays, promote paths to WebRTC, and run TCP/FIPS as a protocol above FIPS
service datagrams. Native fixed-loopback discovery belongs to the native FIPS
runtime; browser applications do not emulate it with a second registry.
