# Hashtree integration

Hashtree content routing **stays in hashtree**. FIPS only carries opaque bytes between identities. The adapter glues them together.

## Layering

```
HashTree.readFile(cid)
  └─ Store.get(hash)
       └─ FipsHashtreeStore
            ├─ localStore.get(hash)             // fast path
            └─ for each peer ∈ peers:
                  fipsNode.sendDatagram({ dst: peer, dstPort: 7001, payload: encodeRequest({ h: hash, htl }) })
                  await response                 // FSP service datagram from peer
                  verifyHash(hash, data); return data
```

The request/response payloads inside the FIPS service-port datagram are the **existing `@hashtree/mesh` MessagePack-tagged frames**:

```
[type_byte:1][msgpack(DataRequest | DataResponse)]
```

`type_byte = 0x00` (request), `0x01` (response). HTL semantics, hash verification, peer selection — all reused from `@hashtree/mesh`.

## What FIPS does NOT do

- decrement HTL (that's hashtree's concern)
- track which peers have which blob (no content routing)
- chunk or merkleize data
- run the @hashtree/core Store interface

## Multi-hop fetch

When B does not have hash H:

1. A asks B for H with htl=10.
2. B has no local copy; B uses its own `FipsHashtreeStore.peers` to ask C with htl decremented per hashtree policy.
3. C returns data over FIPS to B.
4. B returns data over FIPS to A.

This is *hashtree* multi-hop, not FIPS multi-hop. FIPS just delivers each pair-of-identities datagram. FIPS may itself route through intermediate FIPS forwarders; that is independent of hashtree HTL.
