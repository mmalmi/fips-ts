# Link negotiation over FIPS

## Public peer advert (Nostr kind 37195)

```json
{
  "identifier": "fips-overlay-v1",
  "version": 1,
  "endpoints": [
    { "transport": "webrtc", "addr": "<compressed-pubkey-hex>" }
  ],
  "stunServers": ["stun:stun.l.google.com:19302"]
}
```

The parameterized-replaceable event has `d=<app discovery scope>`,
`protocol=<same scope>`, `version=1`, and an `expiration` tag. It is the only
public peerfinding message. Relay selection stays in local configuration; the
configured Nostr peerfinding relays carry signed peer adverts only.

## WebSocket first adjacency

Browsers dial one or more explicit `wss://` seed URLs with
`WebSocketTransport`. Plain `ws://` is accepted only for loopback development.
The seed is configured locally and is not discovered through Nostr.

Immediately after WebSocket open, the client sends a 9-byte key-hint request:
version byte `1` followed by an unsigned 64-bit big-endian nonce. The seed
replies with 41 bytes: version `1`, the same nonce, and its 32-byte x-only
public key. The hint selects the FMP destination identity; the subsequent FMP
Noise handshake performs the authentication.

After the key hint, every binary WebSocket message contains exactly one bounded
FIPS physical record or one bounded `DFP1` direct-FSP fragment. There is no
JSON, Nostr event, or application envelope. Oversized and malformed records
are rejected. Connection attempts, buffered bytes, outbound queues, frame
sizes, and reconnect backoff are bounded.

## Generic link-negotiation service

After FMP and FSP establish over any transport, link offers and answers travel
as the existing FSP DataPacket message (`0x10`) with source and destination
service port 257. No FSP message type, flag, or handshake field is added.

The service payload is UTF-8 JSON:

```ts
interface LinkNegotiationMessage {
  version: 1;
  negotiationId: string;
  linkType: "webrtc" | string;
  kind: "offer" | "answer" | "candidate" | "reject";
  createdAtMs: number;
  expiresAtMs: number;
  payload: unknown; // owned and validated by the selected adapter
}
```

FSP supplies the peer identity, encryption, routing, and replay protection, so
the envelope carries no redundant sender or recipient. Core drops malformed,
expired, future-dated, unsupported, and disabled-adapter negotiations. WebRTC's
payload contains its SDP or ICE candidates; non-trickle ICE is used initially.

Responses are accepted only for known negotiation IDs. An unsolicited offer
requires the adapter and inbound acceptance to be enabled. Inbound WebRTC
acceptance defaults to public WebRTC advertisement, but can be explicitly
enabled for a private deployment or disabled despite advertising. Capacity,
one pending inbound negotiation per peer, expiry, and deterministic
simultaneous-dial resolution are checked before retaining a connection. An
application can additionally supply `allowIncomingPeer` for allowlist, Web of
Trust, or other local authorization policy.

The successful RTCDataChannel then establishes an ordinary FMP link. FIPS path
selection can use the direct path while keeping or retiring the WSS adjacency
according to normal transport policy.
