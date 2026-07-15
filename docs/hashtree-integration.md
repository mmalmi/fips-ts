# Hashtree integration

Hashtree owns content addressing, storage, provider selection, retries, hash
verification, and caching. FIPS supplies authenticated identities, discovery,
routing, and service datagrams; TCP/FIPS supplies a reliable byte stream over
those datagrams.

The canonical adapters live in the Hashtree repository as
`hashtree-fips-transport` for Rust and `@hashtree/fips-transport` for
TypeScript. Both use the TCP/FIPS blob protocol on service port `39018`. They
do not send the former `@hashtree/mesh` request/response frames through raw
FIPS `EndpointData`.

## Provider discovery

A provider advertises the authenticated FSP capability:

```text
hashtree.blob/1
```

The capability is service state, not plaintext transport discovery metadata.
It appears only after the provider owns its TCP/FIPS listener and is withdrawn
when that listener closes. A client selects providers from the authenticated
capability roster, opens an ordinary TCP/FIPS connection to port `39018`, and
still verifies every returned blob against the requested SHA-256 hash.

Public browser providers use the shared FIPS discovery scope:

```text
fips-overlay-v1
```

Private deployments may select another scope. Discovery only establishes a
route to a FIPS identity; it does not prove that the peer offers Hashtree. The
authenticated capability does that. Same-host native processes use FIPS's
ordinary fixed-loopback discovery and authenticated link establishment, not a
Hashtree-specific registry or wire protocol.

## Blob service

Each request uses one reliable TCP/FIPS stream. The client sends the protocol
version, GET operation, and 32-byte hash. The provider returns an explicit
found-or-missing header followed by the blob when found. Implementations bound
blob size, retry only a wholly reset session, and verify the hash before
returning or caching bytes.

An explicit missing response means absence at that provider. Timeouts, resets,
malformed responses, mixed missing/error results, and hash mismatches are
availability or integrity errors, not proof that content does not exist.

## Layering boundary

FIPS does not:

- choose content providers or retry/hedge policy;
- track which peer stores which hash;
- chunk or Merkle-encode blobs;
- implement Hashtree's `Store` interface; or
- turn transport silence into a content miss.

Hashtree does not copy FIPS discovery, capability exchange, routing,
retransmission, or underlay-specific logic.
