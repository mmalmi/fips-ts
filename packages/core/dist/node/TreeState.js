import { bytesEqual } from "../codec/hex.js";
import { compareNodeAddr, nodeAddrToHex } from "../nodeaddr/index.js";
import { buildTreeAnnounce, } from "../protocol/tree.js";
export class TreeState {
    identity;
    sequence = 1n;
    timestamp = nowSeconds();
    parent;
    ancestry;
    peers = new Map();
    constructor(identity) {
        this.identity = identity;
        this.parent = identity.nodeAddr;
        this.ancestry = [this.selfEntry()];
    }
    get coords() {
        return this.ancestry.map((entry) => entry.nodeAddr);
    }
    get root() {
        return this.ancestry.at(-1).nodeAddr;
    }
    get parentNodeAddr() {
        return this.parent;
    }
    announce() {
        return buildTreeAnnounce(this.identity, this.parent, this.sequence, this.timestamp, this.ancestry);
    }
    updatePeer(peerNodeAddr, announce) {
        const key = nodeAddrToHex(peerNodeAddr);
        const existing = this.peers.get(key);
        if (existing && announce.sequence <= existing.sequence)
            return false;
        this.peers.set(key, {
            sequence: announce.sequence,
            parent: announce.parent,
            ancestry: announce.ancestry,
        });
        return this.evaluateParent();
    }
    removePeer(peerNodeAddr) {
        const removed = this.peers.delete(nodeAddrToHex(peerNodeAddr));
        return removed ? this.evaluateParent() : false;
    }
    isTreePeer(peerNodeAddr) {
        if (!bytesEqual(this.parent, this.identity.nodeAddr) && bytesEqual(this.parent, peerNodeAddr)) {
            return true;
        }
        return this.peers.get(nodeAddrToHex(peerNodeAddr))?.parent
            ? bytesEqual(this.peers.get(nodeAddrToHex(peerNodeAddr)).parent, this.identity.nodeAddr)
            : false;
    }
    nextHop(destCoords, eligible) {
        if (destCoords.length === 0 || !bytesEqual(this.root, destCoords.at(-1)))
            return undefined;
        const myDistance = treeDistance(this.coords, destCoords);
        let best;
        for (const [nodeHex, peer] of this.peers) {
            if (!eligible(nodeHex))
                continue;
            const distance = treeDistance(peer.ancestry.map((entry) => entry.nodeAddr), destCoords);
            if (distance >= myDistance)
                continue;
            if (!best || distance < best.distance || (distance === best.distance && nodeHex < best.nodeHex)) {
                best = { nodeHex, distance };
            }
        }
        return best?.nodeHex;
    }
    evaluateParent() {
        const candidates = [...this.peers.entries()]
            .filter(([, peer]) => !peer.ancestry.some((entry) => bytesEqual(entry.nodeAddr, this.identity.nodeAddr)))
            .sort(([hexA, a], [hexB, b]) => {
            const rootOrder = compareNodeAddr(a.ancestry.at(-1).nodeAddr, b.ancestry.at(-1).nodeAddr);
            if (rootOrder !== 0)
                return rootOrder;
            const depthOrder = a.ancestry.length - b.ancestry.length;
            return depthOrder !== 0 ? depthOrder : hexA.localeCompare(hexB);
        });
        const best = candidates[0];
        const shouldRoot = !best || compareNodeAddr(this.identity.nodeAddr, best[1].ancestry.at(-1).nodeAddr) <= 0;
        const nextParent = shouldRoot ? this.identity.nodeAddr : best[1].ancestry[0].nodeAddr;
        const nextAncestry = shouldRoot
            ? [this.selfEntry()]
            : [this.selfEntry(), ...best[1].ancestry];
        if (bytesEqual(this.parent, nextParent) && sameCoords(this.ancestry, nextAncestry))
            return false;
        this.sequence += 1n;
        this.timestamp = nowSeconds();
        this.parent = nextParent;
        this.ancestry = nextAncestry;
        this.ancestry[0] = this.selfEntry();
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