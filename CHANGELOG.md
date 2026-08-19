# Changelog

## Runtime packages 0.0.35 - 2026-08-19

- Emit a disconnected peer lifecycle event when an authenticated identity is
  displaced at a mutable transport address, before emitting the replacement
  identity's connected event. Alias paths are coalesced so consumers remove
  the stale identity exactly once.
- Release `@fips/core` 0.0.35. Other runtime packages remain unchanged from
  runtime bundle 0.0.34.

## Runtime packages 0.0.34 - 2026-08-19

- Retain a small bounded set of authenticated FSP records that arrive before
  the routed final handshake message, then deliver them in order once the
  responder completes the session. This handles legitimate carrier reordering
  between routed Msg3 and negotiated direct transport without losing the first
  application record.
- Release `@fips/core` 0.0.34. Other runtime packages remain unchanged from
  runtime bundle 0.0.33.

## Runtime packages 0.0.33 - 2026-08-19

- Re-resolve a transit destination when an established FSP session loses its
  learned next hop, allowing browser routers to move live traffic onto another
  authenticated mesh path without requiring the endpoint session to restart.
- Exclude the packet's previous hop from recovery lookups and keep the
  end-to-end FSP session responsible for payload authentication while the
  transit router relearns coordinates and a next hop.
- Release `@fips/core` 0.0.33. Other runtime packages remain unchanged from
  runtime bundle 0.0.32.

## Runtime packages 0.0.32 - 2026-08-19

- Exchange Rust-compatible `FilterAnnounce` reachability summaries across
  browser transit nodes, including poisoned-reverse aggregation over current
  tree peers and inbound false-positive-rate validation.
- Advertise Ethernet leaf nodes through browser WSS adjacencies so an upstream
  FIPS seed can route first-contact control sessions back into a WebVM guest.
- Allow only transports that explicitly opt in to authenticate a replacement
  identity at an address, and enable that behavior for virtual Ethernet where
  a restarted VM guest legitimately retains its MAC address.
- Release `@fips/core` 0.0.32 and `@fips/transport-ethernet` 0.0.31. Other
  runtime packages remain unchanged from runtime bundle 0.0.31.

## Runtime packages 0.0.31 - 2026-08-18

- Partition signed Nostr WebRTC adverts by x-only public-key order before
  auto-connect capacity policy. When both peers accept connections, only the
  lower identity initiates automatically, preventing simultaneous FSP session
  glare while both sides retain the advert for explicit resolution.
- Preserve outbound-only auto-connect behavior and ordinary inbound admission.
- Release `@fips/core` 0.0.31, `@fips/transport-webrtc` 0.0.47,
  `@fips/transport-websocket` 0.0.5, `@fips/browser` 0.0.13,
  `@fips/transport-ethernet` 0.0.30, and `@fips/transport-memory` 0.0.11 as one
  immutable runtime bundle. FIPS wire formats are unchanged.

## Runtime packages 0.0.30 - 2026-07-20

- Add a versioned, identity- and scope-bound recent-peer model to
  `@fips/core`. It remembers authenticated identities and optional UDP restart
  hints without granting admission or persisting sessions and signaling data.
- Add a separate `IndexedDbRecentPeersStore` to `@fips/browser`, isolated from
  the identity database and keyed by local identity plus application scope.
- Release `@fips/core` 0.0.30, `@fips/transport-webrtc` 0.0.46,
  `@fips/transport-websocket` 0.0.4, `@fips/browser` 0.0.12,
  `@fips/transport-ethernet` 0.0.29, and `@fips/transport-memory` 0.0.10 as one
  immutable runtime bundle. FIPS wire formats are unchanged.

## Runtime packages 0.0.29 - 2026-07-20

- Negotiate direct-on-transport FSP with the session flag introduced by Rust
  FIPS 0.4.19, while keeping established FSP inside FMP for upstream 0.4.1 and
  other peers that do not advertise the extension.
- Apply the negotiated result to datagrams, endpoint data, replies, and rekeyed
  sessions so peers never send the direct-record flag unilaterally.
- Release `@fips/core` 0.0.29, `@fips/transport-webrtc` 0.0.45,
  `@fips/transport-websocket` 0.0.3, `@fips/browser` 0.0.11,
  `@fips/transport-ethernet` 0.0.28, and `@fips/transport-memory` 0.0.9 as one
  immutable runtime bundle.
- Verify the browser process matrix against released Rust FIPS 0.4.19,
  including WSS bootstrap, FSP-carried WebRTC promotion, direct FSP, browser
  replacement, and legacy routed-FSP fallback.

## Runtime packages 0.0.28 - 2026-07-19

- Replay a retained lookup to an authenticated target that becomes adjacent
  after the lookup first arrived, preserving its signed reverse path.
- Forward transit lookup traffic across established authenticated peers before
  attempting speculative direct WebRTC resolution, preventing stale advert
  dials from delaying ordinary routed traffic.
- Release `@fips/core` 0.0.28, `@fips/transport-webrtc` 0.0.44,
  `@fips/transport-websocket` 0.0.2, `@fips/browser` 0.0.10,
  `@fips/transport-ethernet` 0.0.27, and `@fips/transport-memory` 0.0.8 as one
  immutable runtime bundle. The FMP/FSP wire format is unchanged.

## Runtime packages 0.0.27 - 2026-07-18

- Add `@fips/transport-websocket` 0.0.1 for explicit `wss://` first
  adjacencies. Each bounded binary WebSocket message carries one FIPS physical
  record or bounded direct-FSP fragment; the ordinary FMP Noise handshake
  authenticates the remote identity.
- Remove the kind-21060 Nostr relay packet transport. Nostr relays remain an
  optional carrier for low-rate signed peer adverts; they never carry FIPS
  physical packets or WebRTC offers and answers.
- Carry WebRTC negotiation only through the authenticated in-FIPS service on
  port 257, and preserve an FSP session while its WSS path is being replaced
  by an in-progress authenticated WebRTC path.
- Release `@fips/core` 0.0.27, `@fips/transport-webrtc` 0.0.43,
  `@fips/transport-websocket` 0.0.1, `@fips/browser` 0.0.9,
  `@fips/transport-ethernet` 0.0.26, and `@fips/transport-memory` 0.0.7 as one
  immutable runtime bundle.
- Verify bounded queue/backpressure and reconnect behavior, all browser unit
  and Playwright gates, and real Rust FIPS 0.4.11 WSS-to-WebRTC interop.

## Runtime packages 0.0.26 - 2026-07-16

- Allocate FMP receiver indices inside each node's fresh startup epoch instead
  of a module-global counter that reset when a browser JS realm reloaded.
- Remember a bounded history of authenticated remote startup epochs so replayed
  relay handshakes cannot roll a live same-identity peer back in either handshake
  role, while restoring the surviving authenticated link as the canonical peer.
- Drain an authenticated link displaced by a same-address replacement long
  enough for its in-flight FSP establishment and application data to finish.
- Treat configured Nostr relays as subscription alternatives so one unavailable
  relay cannot cancel healthy relay and ordinary transport startup, while still
  failing clearly when no configured relay accepts the subscription.
- Refresh the test and build toolchain and remove all known OSV findings from
  the frozen dependency lock without changing shipped runtime behavior.
- Release `@fips/core` 0.0.26, `@fips/transport-webrtc` 0.0.42,
  `@fips/browser` 0.0.8, `@fips/transport-ethernet` 0.0.25, and
  `@fips/transport-memory` 0.0.6 as one immutable runtime bundle.
- Keep the FMP/FSP/link-negotiation wire and public API unchanged; verify the
  real two-page persisted-identity reload, native FIPS 0.4.5 process matrix,
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
