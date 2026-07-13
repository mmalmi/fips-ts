# Changelog

## @fips/core 0.0.23 - 2026-07-14

- Remove a disconnected adjacent peer from the browser's spanning-tree state,
  so a reconnect accepts the peer's initial TreeAnnounce immediately instead
  of waiting for its periodic 60-second sequence refresh.

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
