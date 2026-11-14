# Runtime package releases

Release the six runtime packages from one fixed commit, with their generated
`dist` files included in that commit. Keep package versions and each dependent
package's core archive URL in the same release cohort. The workspace overrides
resolve core locally during qualification; the published packages retain their
versioned public core URL.

## Runtime 62 qualification

The runtime-v0.0.62 cohort contains core 0.0.57, browser 0.0.22,
Ethernet 0.0.39, Memory 0.0.17, WebRTC 0.0.61 and WebSocket 0.0.15.
It bounds discovery traffic toward offline peers and lets applications update
preferred WebRTC peers at run time.

Core ports native FIPS's discovery limits. After a first-contact or transit
lookup times out, fresh lookups for that target are suppressed for 30 s,
doubling to 300 s. A successful lookup or session clears that target, and a new
authenticated peer or changed tree coordinates clear all of them. A lookup that
had no peer to ask may retry once a peer exists. Transit nodes forward lookups
for one target at most every 2 s, with a 256-request, 32-per-second budget per
ingress peer. They hold one limited request per target for its next slot.
`TransportContext.isLinked` reports whether any authenticated link is up.

WebRTC auto-connect keeps its 30 s failure cooldown, but five consecutive
failures toward one peer extend it to 30 minutes. A newer advert from that
peer, a connected carrier, or recovered session signaling resets the streak.
Failures while the node has no working link do not count. Preferred peers keep
their prompt retry. Adverts older than half their lifetime plus five minutes have
missed a refresh, so they are dialed after fresh ones. Wire formats are
unchanged.

Preferred peers, such as an application's own devices, can be replaced at run
time with `WebRtcTransport.setPreferredAutoConnectPeers`. They match by x-only
identity, so either key parity works, and a newly preferred peer is dialed at
once even during an earlier cooldown. They are dialed first, may exceed the
speculative dial bound, and never get the 30 minute wait; like native
auto-reconnect peers they back off, here from 1 s doubling to 30 s.

In a 16-node, degree-8 in-memory mesh, one unanswered lookup for an offline
target fell from 791 to 357 forwarded requests. Dialing one dead advert for an
hour fell from 81,473 requests (10.6 MB) to 1,722 (0.22 MB); the mesh's
heartbeats were about 3.4 MB per hour.

Qualify on macOS ARM64 with the runtime 60 toolchain: Node.js 22.23.4 (the same
executable SHA-256), the authenticated pnpm 9.15.4 distribution, TypeScript
5.9.3, Vitest 3.2.7 and the unchanged lockfile. Run the core suite without
interop, the core typecheck, and the WebRTC, WebSocket, Memory and Ethernet
suites with one worker and no file parallelism. Compile core with `--force` and
the other five packages with `tsc -b`; the committed `dist` files must be
reproduced unchanged. Pack and inspect all six archives as described below.

The opt-in Rust bridge interop suite, built from `interop/rust-bridge` against
the local native checkout, accepts Rust-signed lookup replies at the TypeScript
origin. Its Rust-initiated routed-session case fails identically on runtime 61
source: the bridge still expects direct FSP transport in SessionAck flags,
which runtime 61 moved to capability negotiation. The traversal and
native-router fixtures were not supplied and are recorded as skipped. Browser,
device, public-network and live idle-traffic acceptance remain with consumers.

## Runtime 61 qualification

The runtime-v0.0.61 cohort contains core 0.0.56, browser 0.0.21,
Ethernet 0.0.38, Memory 0.0.16, WebRTC 0.0.60 and WebSocket 0.0.14.
It moves private capabilities out of reserved session flags and colliding link
message types. SessionSetup and SessionAck body flags are zero. Authenticated
legacy direct-transport advertisements remain supported.

Session capabilities use established encrypted DataPacket messages with both
ports set to 257. Their exact 12-byte payload is `FIPS-EXT`, version 1,
kind 1 (request) or 2 (response), and a little-endian 16-bit capability mask.
Bit 0 advertises direct FSP transport. The first request follows successful
Msg3 transmission; the first response uses the standard wrapper before direct
transport is enabled. Existing JSON WebRTC signaling on port 257 remains
separate. No phase-4 confirmation is introduced.
Recognized capability controls do not reinforce learned routes or consume
coordinate-warmup state. Authentication, replay checks, key-epoch proof and
receiver-byte accounting still apply.

Link capabilities use message type `0xe0` and the same envelope, with bit 1
advertising client-role support. Kind 3 carries an eight-byte little-endian
sequence after the envelope header and requires prior capability negotiation.
JS ignores listener advertisements. A strict client starts with the namespace
and may send at most three legacy empty `0x53` probes at the existing heartbeat
cadence when unanswered. Legacy role messages require positive legacy support;
namespaced peers never fall back to legacy hints. Capabilities and role sequence
watermarks survive same-process rekey and reset after authenticated restart.

Use the pinned macOS ARM64 tools listed for runtime 60. Run the changed core
suite with one worker, explicitly separating opt-in native interoperability:

```sh
node node_modules/vitest/vitest.mjs run --root packages/core --exclude '**/interop/**' --maxWorkers=1 --minWorkers=1 --no-file-parallelism --pool=threads
node node_modules/typescript/bin/tsc --noEmit -p packages/core/tsconfig.json
node node_modules/typescript/bin/tsc -b packages/core --force
```

Compile core once for packaging, retain the other five packages' unchanged
generated outputs, and inspect all six archives and packed imports. Qualify
both handshake roles against the pinned unmodified upstream peer, the corrected
native peer, and the retained legacy migration fixture where applicable.
Use source- and executable-bound prebuilt fixtures; do not silently build or
download them from tests. These changed handshake paths require new mixed-peer
evidence; earlier runtime proofs retain only their original scope. Publication
still requires the source, history and public-byte gates below. This correction
does not enable application multipath defaults or establish browser, device,
privacy or idle-traffic acceptance.

## Runtime 60 qualification

The runtime-v0.0.60 cohort contains core 0.0.55, browser 0.0.20,
Ethernet 0.0.37, Memory 0.0.15, WebRTC 0.0.59 and WebSocket 0.0.13.
Its WebRTC change retries an unanswered offer within the existing dial deadline
and handles identical authenticated offers without abandoning a live answer.
The retry and response caches have bounded lifetimes, sizes and replay rates.

Qualify this cohort on macOS ARM64 with Node.js 22.23.4, pnpm 9.15.4,
TypeScript 5.9.3 and Vitest 3.2.7. The Node executable SHA-256 is
`2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0`.
Authenticate the pnpm distribution against the root `packageManager` SHA-512
before extracting or executing it. Reuse the locked dependency tree without
installing dependencies or changing the lockfile.

Run the WebRTC unit suite with one worker and no file parallelism, then build
the changed package with the locked compiler:

```sh
node node_modules/vitest/vitest.mjs run --root packages/transport-webrtc --maxWorkers=1 --minWorkers=1 --no-file-parallelism --pool=threads
node node_modules/typescript/bin/tsc -b packages/transport-webrtc
```

Retain and verify unchanged generated files from the preceding commit for the
other five packages. Pack and inspect all six archives as described below.
This macOS qualification does not establish byte equivalence with the prior
Linux build. Serial commands require fresh capacity admission and bounded
deadlines; recorded resource observations are not universal peak guarantees.

The new reload tests inject a temporary seed-forwarding gap in memory. They
cover both peer roles, a successfully written but dropped offer, and retry
delivery after the gap. These tests do not replace consumer browser acceptance
against the published cohort. Reuse the previously accepted core traversal and
native/JS loopback proofs because their executable inputs are unchanged.

## Runtime 59 qualified environment

The runtime-v0.0.59 package qualification used Linux x86-64, Node.js 22.23.4,
pnpm 9.15.4, TypeScript 5.9.3 and Vitest 3.2.7. The preinstalled Node executable
had SHA-256
`94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90`.
The pnpm distribution's SHA-512 is pinned in the root `packageManager` field.
Use the committed `pnpm-lock.yaml` for dependency integrity. Do not install a
different toolchain or regenerate the lockfile as part of packing a release.

For a newly admitted dependency installation, use:

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

The qualification reused its previously verified dependency tree. Compilation
and packaging ran offline with two CPUs, 1.5 GiB memory, no swap, one workspace
writer, and bounded deadlines. Resource admission must also account for retained
outputs and other writers; these observed limits are not universal build peaks.

## Build and pack

The changed core and the Ethernet and Memory packages were compiled with the
locked TypeScript compiler. Browser, WebRTC and WebSocket generated files were
byte-identical to the preceding qualified cohort and were reused from source.
From the repository root, the equivalent build steps are:

```sh
node node_modules/typescript/bin/tsc -b packages/core
node node_modules/typescript/bin/tsc -b packages/transport-ethernet packages/transport-memory
```

Run `pnpm pack --pack-destination OUTPUT_DIRECTORY` in each of
`packages/core`, `packages/browser`, `packages/transport-ethernet`,
`packages/transport-memory`, `packages/transport-webrtc` and
`packages/transport-websocket`, using an absolute, task-owned output directory.
Do not include build caches, private plans, signing material or local paths in
source or archives.

A successful pack command does not prove the package is usable. Check every
archive's full file set against the release commit, permitting only verified
manifest key ordering and trailing-newline normalization. Require all advertised JavaScript and type
entrypoints, include the source files referenced by maps, and reject unsafe or
unexpected archive entries. Import all six actual packed entrypoints with the
packed core and locked runtime dependencies. Preserve rejected archives and
failure receipts separately from corrected outputs.

## Acceptance and publication

Reuse tests only when their executable source and relevant inputs are unchanged.
The traversal change requires unit coverage and the opt-in native/JS routed,
encrypted session fixture in
`packages/core/test/interop/traversal-unsupported-interop.test.ts`. Supply its
prebuilt native fixture with an independently verified full source commit,
toolchain and executable hash; the test never builds or downloads it. Record
skips explicitly. Loopback interoperability and package imports do not establish
browser, public-network, application idle-traffic or device acceptance.

Before publishing assets, verify this repository's signed public refs through
an open subscription, an ordinary empty cold Git clone, all reachable objects
and `git fsck`. Bind the resulting full source commit, toolchain, lockfile,
recipe, six archive checksums, tests and limitations in public build provenance.
Keep operational details in private receipts. Publish the immutable runtime tag
and six archives to the established release target, then independently verify
the public bytes. Consumer owners accept their own exact dependency cohort and
runtime behavior before the rollout is complete.
