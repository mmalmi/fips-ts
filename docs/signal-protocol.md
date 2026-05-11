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

`d`-tag = `fips-overlay-v1` to make adverts replaceable per identity.

## Signal (Nostr kind 21059, encrypted)

The event `content` is **NIP-44 v2** ciphertext (base64) from `nostr-tools/nip44`, encrypted with the conversation key `HKDF-SHA256(ECDH(senderSk, recipientPk), salt="nip44-v2")`. The plaintext is a JSON `WebRtcSignal`:

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

## NIP-59 gift wrap (TODO — Rust interop)

Rust FIPS uses kind 21059 as a NIP-59 gift-wrap envelope around the encrypted
signal rather than putting the NIP-44 ciphertext directly into a kind 21059
event's content. This v1 implementation skips that outer wrap. To be
byte-compatible with Rust signaling, add `nostr-tools/nip59` `wrapEvent` /
`unwrapEvent` around `sendSignal` / `handleSignalEvent` in
`NostrWebRtcSignaling.ts`.
