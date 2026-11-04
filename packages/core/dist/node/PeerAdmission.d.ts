import { type NodeAddr } from "../nodeaddr/index.js";
/** Identity policy is independent of an unauthenticated carrier address or hint. */
export declare class PeerAdmission {
    private readonly keys;
    private readonly addresses;
    constructor(keys?: readonly string[]);
    equals(other: PeerAdmission): boolean;
    get hasBlockedPeers(): boolean;
    allows(pubkey: Uint8Array): boolean;
    assertPeer(pubkey: Uint8Array): void;
    assertNode(nodeAddr: NodeAddr): void;
}
//# sourceMappingURL=PeerAdmission.d.ts.map