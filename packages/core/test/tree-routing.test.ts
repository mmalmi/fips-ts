import { describe, expect, it } from "vitest";

import {
  decodeTreeAnnounce,
  encodeTreeAnnounce,
  identityFromSecretKey,
  nodeAddrToHex,
  verifyTreeAnnounce,
} from "../src/index.js";
import { TreeState } from "../src/node/TreeState.js";

describe("Rust-compatible spanning-tree routing", () => {
  it("encodes, verifies, and decodes a signed TreeAnnounce", async () => {
    const identity = await identityFromSecretKey(new Uint8Array(32).fill(0x51));
    const state = new TreeState(identity);
    const encoded = encodeTreeAnnounce(state.announce());
    const decoded = decodeTreeAnnounce(encoded);

    expect(decoded.ancestry.map((entry) => nodeAddrToHex(entry.nodeAddr)))
      .toEqual([nodeAddrToHex(identity.nodeAddr)]);
    expect(verifyTreeAnnounce(decoded, identity.publicKey)).toBe(true);
  });

  it("elects the smallest visible root and greedily routes toward cached coordinates", async () => {
    const rootIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x52));
    const leafIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x53));
    const root = new TreeState(rootIdentity);
    const leaf = new TreeState(leafIdentity);
    const rootAddr = nodeAddrToHex(rootIdentity.nodeAddr);
    const leafAddr = nodeAddrToHex(leafIdentity.nodeAddr);
    const smaller = rootAddr < leafAddr ? root : leaf;
    const larger = smaller === root ? leaf : root;
    const smallerIdentity = smaller === root ? rootIdentity : leafIdentity;

    expect(larger.updatePeer(smallerIdentity.nodeAddr, smaller.announce())).toBe(true);
    expect(nodeAddrToHex(larger.root)).toBe(nodeAddrToHex(smallerIdentity.nodeAddr));
    expect(larger.nextHop(smaller.coords, () => true))
      .toBe(nodeAddrToHex(smallerIdentity.nodeAddr));
  });
});
