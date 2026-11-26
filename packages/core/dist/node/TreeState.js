import { bytesEqual } from "../codec/hex.js";
import { compareNodeAddr, nodeAddrToHex } from "../nodeaddr/index.js";
import { buildTreeAnnounce, } from "../protocol/tree.js";
export class TreeState {
    identity;
    sequence = 1n;
    timestamp = nowSeconds();
    parent;
    ancestry;
    cachedCoords;
    cachedAnnounce;
    peers = new Map();
    constructor(identity) {
        this.identity = identity;
        this.parent = identity.nodeAddr;
        this.ancestry = [this.selfEntry()];
        this.cachedCoords = [identity.nodeAddr];
    }
    get coords() {
        return this.cachedCoords;
    }
    get root() {
        return this.ancestry.at(-1).nodeAddr;
    }
    get parentNodeAddr() {
        return this.parent;
    }
    announce() {
        return (this.cachedAnnounce ??= buildTreeAnnounce(this.identity, this.parent, this.sequence, this.timestamp, this.ancestry));
    }
    updatePeer(peerNodeAddr, announce, peerNodeHex = nodeAddrToHex(peerNodeAddr)) {
        const existing = this.peers.get(peerNodeHex);
        if (existing && announce.sequence <= existing.sequence)
            return false;
        this.peers.set(peerNodeHex, {
            sequence: announce.sequence,
            parent: announce.parent,
            ancestry: announce.ancestry,
            coords: announce.ancestry.map((entry) => entry.nodeAddr),
        });
        return this.evaluateParent();
    }
    removePeer(peerNodeAddr, peerNodeHex = nodeAddrToHex(peerNodeAddr)) {
        const removed = this.peers.delete(peerNodeHex);
        return removed ? this.evaluateParent() : false;
    }
    reset() {
        this.peers.clear();
        this.evaluateParent();
    }
    isTreePeer(peerNodeAddr, peerNodeHex = nodeAddrToHex(peerNodeAddr)) {
        if (!bytesEqual(this.parent, this.identity.nodeAddr) && bytesEqual(this.parent, peerNodeAddr)) {
            return true;
        }
        const peerParent = this.peers.get(peerNodeHex)?.parent;
        return peerParent ? bytesEqual(peerParent, this.identity.nodeAddr) : false;
    }
    nextHop(destCoords, eligible) {
        if (destCoords.length === 0 || !bytesEqual(this.root, destCoords.at(-1)))
            return undefined;
        const myDistance = treeDistance(this.cachedCoords, destCoords);
        let bestHex;
        let bestDistance = myDistance;
        for (const [nodeHex, peer] of this.peers) {
            const distance = treeDistance(peer.coords, destCoords);
            if (distance > bestDistance || (distance === bestDistance && (bestHex === undefined || nodeHex >= bestHex))) {
                continue;
            }
            if (!eligible(nodeHex))
                continue;
            bestHex = nodeHex;
            bestDistance = distance;
        }
        return bestHex;
    }
    evaluateParent() {
        let bestHex;
        let bestPeer;
        for (const [hex, peer] of this.peers) {
            if (peer.coords.some((addr) => bytesEqual(addr, this.identity.nodeAddr)))
                continue;
            if (bestPeer) {
                const rootOrder = compareNodeAddr(peer.coords.at(-1), bestPeer.coords.at(-1));
                if (rootOrder > 0)
                    continue;
                if (rootOrder === 0) {
                    const depthOrder = peer.ancestry.length - bestPeer.ancestry.length;
                    if (depthOrder > 0 || (depthOrder === 0 && hex >= bestHex))
                        continue;
                }
            }
            bestHex = hex;
            bestPeer = peer;
        }
        const shouldRoot = !bestPeer || compareNodeAddr(this.identity.nodeAddr, bestPeer.coords.at(-1)) <= 0;
        const nextParent = shouldRoot ? this.identity.nodeAddr : bestPeer.coords[0];
        const nextAncestry = shouldRoot
            ? [this.selfEntry()]
            : [this.selfEntry(), ...bestPeer.ancestry];
        if (bytesEqual(this.parent, nextParent) && sameCoords(this.ancestry, nextAncestry))
            return false;
        this.sequence += 1n;
        this.timestamp = nowSeconds();
        this.parent = nextParent;
        this.ancestry = nextAncestry;
        this.ancestry[0] = this.selfEntry();
        this.cachedCoords = this.ancestry.map((entry) => entry.nodeAddr);
        this.cachedAnnounce = undefined;
        return true;
    }
    selfEntry() {
        return { nodeAddr: this.identity.nodeAddr, sequence: this.sequence, timestamp: this.timestamp };
    }
}
export function treeDistance(a, b) {
    if (a.length === 0 || b.length === 0 || !bytesEqual(a.at(-1), b.at(-1)))
        return Infinity;
    let common = 0;
    while (common < a.length && common < b.length) {
        if (!bytesEqual(a[a.length - 1 - common], b[b.length - 1 - common]))
            break;
        common += 1;
    }
    return a.length + b.length - 2 * common;
}
function sameCoords(a, b) {
    return a.length === b.length && a.every((entry, index) => bytesEqual(entry.nodeAddr, b[index].nodeAddr));
}
function nowSeconds() {
    return BigInt(Math.floor(Date.now() / 1000));
}
//# sourceMappingURL=TreeState.js.map