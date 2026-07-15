# Link negotiation over FIPS

## Public peer advert (Nostr kind 37195)

```json
{
  "identifier": "fips-overlay-v1",
  "version": 1,
  "endpoints": [
    { "transport": "webrtc", "addr": "<compressed-pubkey-hex>" },
    { "transport": "nostr_relay", "addr": "<npub>" }
  ],
  "stunServers": ["stun:stun.l.google.com:19302"]
}
```

The parameterized-replaceable event has `d=<app discovery scope>`,
`protocol=<same scope>`, `version=1`, and an `expiration` tag. It is the only
public peerfinding message. Relay selection stays in local configuration; the
configured Nostr peerfinding relays are also available to the relay transport.

## Nostr relay transport (kind 21060)

Kind `21060` is a targeted ephemeral event carrying one ordinary FIPS wire
datagram. Its single `p` tag is the destination x-only key. `content` is the
FIPS datagram encoded as unpadded base64url. FMP and FSP already authenticate
and encrypt the datagram, so this Nostr envelope adds no private-message
protocol.

Implementations reject invalid signatures, multiple recipients, events older
than 60 seconds, events more than 30 seconds in the future, and decoded
datagrams above the transport MTU (1280 bytes by default). A relay that
delivered a peer's advert is preferred for that peer; otherwise all configured
relay connections are eligible.

`WebRtcTransport` enables this low-priority companion transport automatically.
Supplying an explicit transport with type `nostr_relay` overrides the companion.
The relay path remains usable when WebRTC cannot be established.

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

The successful RTCDataChannel then establishes a higher-priority FMP link.
FIPS uses that direct path automatically while retaining the relay transport
as bootstrap and fallback connectivity.
