import type { FipsIdentity } from "../identity/index.js";
import { type NodeAddr } from "../nodeaddr/index.js";
import { type TreeAnnounce } from "../protocol/tree.js";
export declare class TreeState {
    private readonly identity;
    private sequence;
    private timestamp;
    private parent;
    private ancestry;
    private cachedCoords;
    private cachedAnnounce?;
    private readonly peers;
    constructor(identity: FipsIdentity);
    get coords(): NodeAddr[];
    get root(): NodeAddr;
    get parentNodeAddr(): NodeAddr;
    announce(): TreeAnnounce;
    updatePeer(peerNodeAddr: NodeAddr, announce: TreeAnnounce, peerNodeHex?: string): boolean;
    removePeer(peerNodeAddr: NodeAddr, peerNodeHex?: string): boolean;
    reset(): void;
    isTreePeer(peerNodeAddr: NodeAddr, peerNodeHex?: string): boolean;
    nextHop(destCoords: NodeAddr[], eligible: (nodeHex: string) => boolean): string | undefined;
    private evaluateParent;
    private selfEntry;
}
export declare function treeDistance(a: NodeAddr[], b: NodeAddr[]): number;
//# sourceMappingURL=TreeState.d.ts.map