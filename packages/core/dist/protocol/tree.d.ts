import { type FipsIdentity } from "../identity/index.js";
import { type NodeAddr } from "../nodeaddr/index.js";
export declare const TREE_ANNOUNCE_VERSION = 1;
export declare const TREE_COORD_ENTRY_SIZE = 32;
export declare const TREE_ANNOUNCE_MIN_PAYLOAD_SIZE = 99;
export interface TreeCoordEntry {
    nodeAddr: NodeAddr;
    sequence: bigint;
    timestamp: bigint;
}
export interface TreeAnnounce {
    sequence: bigint;
    timestamp: bigint;
    parent: NodeAddr;
    ancestry: TreeCoordEntry[];
    signature: Uint8Array;
}
export declare function treeDeclarationBytes(nodeAddr: NodeAddr, parent: NodeAddr, sequence: bigint, timestamp: bigint): Uint8Array;
export declare function buildTreeAnnounce(identity: FipsIdentity, parent: NodeAddr, sequence: bigint, timestamp: bigint, ancestry: TreeCoordEntry[]): TreeAnnounce;
export declare function encodeTreeAnnounce(announce: TreeAnnounce): Uint8Array;
export declare function decodeTreeAnnounce(buf: Uint8Array): TreeAnnounce;
export declare function decodeTreeAnnouncePayload(payload: Uint8Array): TreeAnnounce;
export declare function verifyTreeAnnounce(announce: TreeAnnounce, peerPubkey: Uint8Array): boolean;
export declare function validateTreeAnnounceSemantics(announce: TreeAnnounce): void;
//# sourceMappingURL=tree.d.ts.map