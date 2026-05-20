# WebRTC signaling protocol

Protocol id: `fips-webrtc-v1`. Version: 1.

## Advert (Nostr kind 37195, public, parameterized replaceable)

```
{
  "identifier": "fips-overlay-v1",
  "version": 1,
  "endpoints": [{ "transport": "webrtc", "addr": "<local-pubkey-hex>" }],
  "signalRelays": ["wss://relay.example.com"],
  "stunServers": ["stun:stun.l.google.com:19302"]
}
```

`d`-tag = the app discovery scope, for example `hashtree-v1`, to make
adverts replaceable per identity and per app.
Content `identifier` remains `fips-overlay-v1`.
`protocol` tag = the same app discovery scope.
`version` tag = `1`.

## Signal (Nostr kind 21059, NIP-59 gift-wrapped)

Each signal is published as a **kind 21059 NIP-59 gift wrap**. Three layers:

```
gift-wrap (kind 21059)                     ← signed by random ephemeral key
  content: NIP-44 v2 ciphertext of …
    └─ seal (kind 13)                      ← signed by sender's real key
       content: NIP-44 v2 ciphertext of …
          └─ rumor (kind 21059, unsigned)  ← carries the WebRtcSignal as JSON
```

`p` tag = recipient xOnly hex. The outer event's pubkey is a fresh one-time
key, so the sender's real identity is only revealed after the recipient
decrypts the outer layer.

The rumor's content is a JSON `WebRtcSignal`:

```ts
interface WebRtcSignal {
  protocol: "fips-webrtc-v1";
  version: 1;
  sessionId: string;
  kind: "offer" | "answer" | "candidate" | "reject";
  sender: string;      // hex pubkey
  recipient: string;   // hex pubkey
  sdp?: string;
  candidates?: IceCandidateJson[];
  createdAtMs: number;
  expiresAtMs: number;
}
```

## Validation rules (reject the signal if any fail)

- `protocol !== "fips-webrtc-v1"` or `version !== 1`
- `expiresAtMs < now`
- `recipient !== localPubkey`
- `sender` does not match the outer gift-wrap author
- `sessionId` is unknown for `answer`/`candidate`
- `offer`/`answer` missing `sdp`
- `sessionId` already seen within the replay window (dedupe)

## Negotiation (non-trickle ICE for v1)

```
1. initiator: createOffer
2. setLocalDescription
3. wait for iceGatheringState === "complete" (or 10 s timeout)
4. publish offer signal
5. wait for answer signal
6. setRemoteDescription
7. wait for datachannel `open` and connectionState `connected`
```

`candidate` messages are part of the schema for forward compatibility but unused in v1.

## Kind choice (21059 vs 1059)

Standard NIP-59 uses kind **1059** for gift wraps (regular event — relays
store them). FIPS uses kind **21059**, which is in the 20000–29999 ephemeral
range, so relays broadcast and drop them. This matches Rust FIPS and keeps
signaling state out of relay storage.

Inner rumor kind is also 21059 (same number, internal). The seal stays at the
NIP-59 standard kind 13.
