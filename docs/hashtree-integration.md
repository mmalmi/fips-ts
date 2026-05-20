# Hashtree integration

Hashtree content routing **stays in hashtree**. FIPS only carries opaque bytes between identities.

The Hashtree-side integration now lives in the Hashtree repository as `@hashtree/fips-transport`. It sends existing `@hashtree/mesh` MessagePack-tagged `DataRequest` / `DataResponse` frames over FIPS EndpointData, exposed through a generic FIPS endpoint interface:

```ts
send(peerId, bytes)
onMessage(({ peerId, data }) => ...)
```

For public Hashtree swarms, use the FIPS Nostr discovery app scope:

```text
hashtree-v1
```

Private or narrower swarms can use app scopes such as `hashtree-v1:<topic>`.
The advert content still uses the FIPS advert identifier `fips-overlay-v1`; the
Hashtree scope lives in the FIPS `d` and `protocol` tags. A generic FIPS daemon
advert and a Hashtree endpoint advert are separate replaceable events.

Those may be different identities. A host daemon can advertise generic FIPS
reachability while a Hashtree endpoint identity behind that daemon advertises
`hashtree-v1`; FIPS routing/gateway state is responsible for reaching the
endpoint identity.

## What FIPS does NOT do

- decrement HTL or choose retry/hedge policy (that's hashtree's concern)
- track which peers have which blob (no content routing)
- chunk or merkleize data
- run the @hashtree/core Store interface

## Silence

Hashtree's blob protocol does not require explicit misses. If a peer has no matching blob it can remain silent. The Hashtree transport treats silence as unknown/no response, not as proof of absence and not as a reason to retry the same peer forever.
