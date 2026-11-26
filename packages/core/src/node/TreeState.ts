import { bytesEqual } from "../codec/hex.js";
import type { FipsIdentity } from "../identity/index.js";
import { compareNodeAddr, nodeAddrToHex, type NodeAddr } from "../nodeaddr/index.js";
import {
  buildTreeAnnounce,
  type TreeAnnounce,
  type TreeCoordEntry,
} from "../protocol/tree.js";

interface PeerTreeState {
  sequence: bigint;
  parent: NodeAddr;
  ancestry: TreeCoordEntry[];
  coords: NodeAddr[];
}

export class TreeState {
  private sequence = 1n;
  private timestamp = nowSeconds();
  private parent: NodeAddr;
  private ancestry: TreeCoordEntry[];
  private cachedCoords: NodeAddr[];
  private cachedAnnounce?: TreeAnnounce;
  private readonly peers = new Map<string, PeerTreeState>();

  constructor(private readonly identity: FipsIdentity) {
    this.parent = identity.nodeAddr;
    this.ancestry = [this.selfEntry()];
    this.cachedCoords = [identity.nodeAddr];
  }

  get coords(): NodeAddr[] {
    return this.cachedCoords;
  }

  get root(): NodeAddr {
    return this.ancestry.at(-1)!.nodeAddr;
  }

  get parentNodeAddr(): NodeAddr {
    return this.parent;
  }

  announce(): TreeAnnounce {
    return (this.cachedAnnounce ??= buildTreeAnnounce(
      this.identity,
      this.parent,
      this.sequence,
      this.timestamp,
      this.ancestry,
    ));
  }

  updatePeer(peerNodeAddr: NodeAddr, announce: TreeAnnounce, peerNodeHex = nodeAddrToHex(peerNodeAddr)): boolean {
    const existing = this.peers.get(peerNodeHex);
    if (existing && announce.sequence <= existing.sequence) return false;
    this.peers.set(peerNodeHex, {
      sequence: announce.sequence,
      parent: announce.parent,
      ancestry: announce.ancestry,
      coords: announce.ancestry.map((entry) => entry.nodeAddr),
    });
    return this.evaluateParent();
  }

  removePeer(peerNodeAddr: NodeAddr, peerNodeHex = nodeAddrToHex(peerNodeAddr)): boolean {
    const removed = this.peers.delete(peerNodeHex);
    return removed ? this.evaluateParent() : false;
  }

  reset(): void {
    this.peers.clear();
    this.evaluateParent();
  }

  isTreePeer(peerNodeAddr: NodeAddr, peerNodeHex = nodeAddrToHex(peerNodeAddr)): boolean {
    if (!bytesEqual(this.parent, this.identity.nodeAddr) && bytesEqual(this.parent, peerNodeAddr)) {
      return true;
    }
    const peerParent = this.peers.get(peerNodeHex)?.parent;
    return peerParent ? bytesEqual(peerParent, this.identity.nodeAddr) : false;
  }

  nextHop(destCoords: NodeAddr[], eligible: (nodeHex: string) => boolean): string | undefined {
    if (destCoords.length === 0 || !bytesEqual(this.root, destCoords.at(-1)!)) return undefined;
    const myDistance = treeDistance(this.cachedCoords, destCoords);
    let bestHex: string | undefined;
    let bestDistance = myDistance;
    for (const [nodeHex, peer] of this.peers) {
      const distance = treeDistance(peer.coords, destCoords);
      if (distance > bestDistance || (distance === bestDistance && (bestHex === undefined || nodeHex >= bestHex))) {
        continue;
      }
      if (!eligible(nodeHex)) continue;
      bestHex = nodeHex;
      bestDistance = distance;
    }
    return bestHex;
  }

  private evaluateParent(): boolean {
    let bestHex: string | undefined;
    let bestPeer: PeerTreeState | undefined;
    for (const [hex, peer] of this.peers) {
      if (peer.coords.some((addr) => bytesEqual(addr, this.identity.nodeAddr))) continue;
      if (bestPeer) {
        const rootOrder = compareNodeAddr(peer.coords.at(-1)!, bestPeer.coords.at(-1)!);
        if (rootOrder > 0) continue;
        if (rootOrder === 0) {
          const depthOrder = peer.ancestry.length - bestPeer.ancestry.length;
          if (depthOrder > 0 || (depthOrder === 0 && hex >= bestHex!)) continue;
        }
      }
      bestHex = hex;
      bestPeer = peer;
    }
    const shouldRoot = !bestPeer || compareNodeAddr(this.identity.nodeAddr, bestPeer.coords.at(-1)!) <= 0;
    const nextParent = shouldRoot ? this.identity.nodeAddr : bestPeer!.coords[0]!;
    const nextAncestry = shouldRoot
      ? [this.selfEntry()]
      : [this.selfEntry(), ...bestPeer!.ancestry];
    if (bytesEqual(this.parent, nextParent) && sameCoords(this.ancestry, nextAncestry)) return false;
    this.sequence += 1n;
    this.timestamp = nowSeconds();
    this.parent = nextParent;
    this.ancestry = nextAncestry;
    this.ancestry[0] = this.selfEntry();
    this.cachedCoords = this.ancestry.map((entry) => entry.nodeAddr);
    this.cachedAnnounce = undefined;
    return true;
  }

  private selfEntry(): TreeCoordEntry {
    return { nodeAddr: this.identity.nodeAddr, sequence: this.sequence, timestamp: this.timestamp };
  }
}

export function treeDistance(a: NodeAddr[], b: NodeAddr[]): number {
  if (a.length === 0 || b.length === 0 || !bytesEqual(a.at(-1)!, b.at(-1)!)) return Infinity;
  let common = 0;
  while (common < a.length && common < b.length) {
    if (!bytesEqual(a[a.length - 1 - common]!, b[b.length - 1 - common]!)) break;
    common += 1;
  }
  return a.length + b.length - 2 * common;
}

function sameCoords(a: TreeCoordEntry[], b: TreeCoordEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => bytesEqual(entry.nodeAddr, b[index]!.nodeAddr));
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}
