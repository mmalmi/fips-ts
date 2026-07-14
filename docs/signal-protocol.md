# WebRTC negotiation over FIPS

Protocol id: `fips-webrtc-v1`. Version: 1.

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

## Authenticated WebRTC negotiation (FSP message 0x18)

After FMP and FSP establish over the relay transport, WebRTC offers, answers,
and rejections travel as encrypted FSP message type `0x18`. Its payload is the
UTF-8 JSON form of:

```ts
interface WebRtcSignal {
  protocol: "fips-webrtc-v1";
  version: 1;
  sessionId: string;
  kind: "offer" | "answer" | "candidate" | "reject";
  sender: string;
  recipient: string;
  sdp?: string;
  candidates?: IceCandidateJson[];
  createdAtMs: number;
  expiresAtMs: number;
}
```

The authenticated FSP peer must equal `sender`; `recipient` must equal the
local identity. Expired, future-dated, duplicate, malformed, and unknown-session
messages are rejected. Non-trickle ICE is used in version 1.

The successful RTCDataChannel then establishes a higher-priority FMP link.
FIPS uses that direct path automatically while retaining the relay transport
as bootstrap and fallback connectivity.
