# Changelog

## Runtime packages 0.0.26 - 2026-07-16

- Allocate FMP receiver indices inside each node's fresh startup epoch instead
  of a module-global counter that reset when a browser JS realm reloaded.
- Remember a bounded history of authenticated remote startup epochs so replayed
  relay handshakes cannot roll a live same-identity peer back to a retired link.
- Drain an authenticated link displaced by a same-address replacement long
  enough for its in-flight FSP establishment and application data to finish.
- Treat configured Nostr relays as subscription alternatives so one unavailable
  relay cannot cancel healthy relay and ordinary transport startup, while still
  failing clearly when no configured relay accepts the subscription.
- Release `@fips/core` 0.0.26, `@fips/transport-webrtc` 0.0.42,
  `@fips/browser` 0.0.8, `@fips/transport-ethernet` 0.0.25, and
  `@fips/transport-memory` 0.0.6 as one immutable runtime bundle.
- Keep the FMP/FSP/link-negotiation wire and public API unchanged; verify the
  real two-page persisted-identity reload, native FIPS 0.4.4 process matrix,
  and consumer restart paths.

## Runtime packages 0.0.25 - 2026-07-16

- Match FMP Msg2 and Established packets by their authenticated receiver index
  across Nostr x-only and compressed transport-address aliases, while dropping
  stale relay packets that no longer belong to a pending handshake.
- Detect same-identity process restarts from the authenticated startup epoch,
  reset displaced FSP sessions, and keep the fresh carrier alive while retiring
  stale WebRTC paths and pending dials.
- Release `@fips/core` 0.0.25, `@fips/transport-webrtc` 0.0.41,
  `@fips/browser` 0.0.7, `@fips/transport-ethernet` 0.0.24, and
  `@fips/transport-memory` 0.0.5 as one immutable runtime bundle.
- Verify all 15 browser process gates against native FIPS 0.4.1, five repeated
  replacement-page gates, and five repeated Iris Drive identity-switch/block
  exchange gates.

## Runtime packages - 2026-07-16

- Carry generic link negotiation through the existing FSP DataPacket service
  on port 257. Remove the accidental WebRTC-specific FSP message type `0x18`.
- Dispatch negotiations only to enabled matching adapters. WebRTC rejects
  unsolicited offers unless inbound acceptance is enabled, which defaults to
  public WebRTC advertisement; correlated simultaneous dials remain eligible.
- Release `@fips/core` 0.0.24 and `@fips/transport-webrtc` 0.0.40. Release
  `@fips/browser` 0.0.6, `@fips/transport-ethernet` 0.0.23, and
  `@fips/transport-memory` 0.0.4 against that core tuple.
- Verify the unchanged browser process suite against native FIPS 0.4.1,
  including disconnect, replacement-page, and WebRTC reconnect coverage.
- Pin cross-package runtime dependencies to this immutable release bundle while
  retaining local workspace overrides for development.

## @fips/transport-webrtc 0.0.39 - 2026-07-14

- Replace a stale same-identity WebRTC connection when a restarted peer sends
  a fresh offer, using the deterministic public-key ordering to converge on
  one initiator.
- Route replacement redials back through `FipsNode` so the new data channel
  also establishes an authenticated FMP link and immediately carries traffic.

## @fips/transport-webrtc 0.0.38 - 2026-07-14

- Resolve simultaneous browser/native offers deterministically so the lower
  public key remains initiator and the losing dial is rejected immediately.
- Reject replacement offers while an existing peer connection is still live.

## @fips/core 0.0.23 - 2026-07-14

- Remove a disconnected adjacent peer from the browser's spanning-tree state,
  so a reconnect accepts the peer's initial TreeAnnounce immediately instead
  of waiting for its periodic 60-second sequence refresh.

## Runtime packages - 2026-07-14

- `@fips/transport-webrtc` 0.0.37 and `@fips/transport-ethernet` 0.0.22
  pin `@fips/core` 0.0.23 in packed manifests.

## @fips/core 0.0.22 - 2026-07-13

- Promote an authenticated responder rekey as soon as its final XK message
  arrives, so browser-to-peer traffic uses the new K-bit epoch immediately.
- Keep the previous receive epoch draining for delayed packets after cutover.
- Detect a same-identity peer restart from its Noise epoch and reset the session
  K bit to zero instead of treating the fresh process as an ordinary rekey.

## Runtime packages - 2026-07-13

- `@fips/transport-webrtc` 0.0.32, `@fips/transport-ethernet` 0.0.21,
  `@fips/transport-memory` 0.0.3, and `@fips/browser` 0.0.5 pin
  `@fips/core` 0.0.22 in packed manifests.

## @fips/transport-webrtc 0.0.30 - 2026-07-12

- Preserve speculative auto-connect reservations when concurrent route
  resolution consumes the same retained Nostr adverts before dialing begins.
- Cover repeated advert replay and resolution so a four-dial speculative cap
  cannot expand back to the full connection limit.

## @fips/transport-webrtc 0.0.29 - 2026-07-12

- Keep inbound and explicit connection capacity available while retained Nostr
  adverts trigger speculative WebRTC auto-dials.
- Verify a live peer can connect and reconnect while eight stale adverts remain
  in the relay backlog.

## @fips/core 0.0.21 - 2026-07-12

- Resolve simultaneous FSP session initiation deterministically by NodeAddr so
  both peers converge on one authenticated session without dropping the first
  endpoint messages.
- Complete the losing initiator's pending send only after the replacement
  responder session authenticates.

## Runtime packages - 2026-07-12

- `@fips/transport-webrtc` 0.0.28, `@fips/transport-ethernet` 0.0.20, and
  `@fips/browser` 0.0.3 pin `@fips/core` 0.0.21 in packed manifests.
