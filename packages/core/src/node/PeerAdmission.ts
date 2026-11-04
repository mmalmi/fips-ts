import { fromHex, toHex } from "../codec/hex.js";
import { deriveNodeAddr, type NodeAddr } from "../nodeaddr/index.js";

/** Identity policy is independent of an unauthenticated carrier address or hint. */
export class PeerAdmission {
  private readonly keys = new Set<string>();
  private readonly addresses = new Set<string>();

  constructor(keys: readonly string[] = []) {
    for (const key of keys) {
      if (!/^(?:02|03)?[0-9a-f]{64}$/i.test(key)) {
        throw new Error("blocked peer must be x-only or compressed public key hex");
      }
      const normalized = key.slice(-64).toLowerCase();
      this.keys.add(normalized);
      this.addresses.add(toHex(deriveNodeAddr(fromHex(normalized))));
    }
  }

  equals(other: PeerAdmission): boolean {
    return this.keys.size === other.keys.size && [...this.keys].every(key => other.keys.has(key));
  }

  get hasBlockedPeers(): boolean { return this.keys.size > 0; }

  allows(pubkey: Uint8Array): boolean {
    return !this.keys.size || !this.keys.has(toHex(pubkey).slice(-64));
  }

  assertPeer(pubkey: Uint8Array): void {
    if (!this.allows(pubkey)) throw new Error("FIPS peer is blocked");
  }

  assertNode(nodeAddr: NodeAddr): void {
    if (this.addresses.size && this.addresses.has(toHex(nodeAddr))) throw new Error("FIPS endpoint is blocked");
  }
}
