import { bytesEqual } from "../codec/hex.js";
import { type FipsIdentity } from "../identity/index.js";
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
}

export class TreeState {
  private sequence = 1n;
  private timestamp = nowSeconds();
  private parent: NodeAddr;
  private ancestry: TreeCoordEntry[];
  private readonly peers = new Map<string, PeerTreeState>();

  constructor(private readonly identity: FipsIdentity) {
    this.parent = identity.nodeAddr;
    this.ancestry = [this.selfEntry()];
  }

  get coords(): NodeAddr[] {
    return this.ancestry.map((entry) => entry.nodeAddr);
  }

  get root(): NodeAddr {
    return this.ancestry.at(-1)!.nodeAddr;
  }

  get parentNodeAddr(): NodeAddr {
    return this.parent;
  }

  announce(): TreeAnnounce {
    return buildTreeAnnounce(
      this.identity,
      this.parent,
      this.sequence,
      this.timestamp,
      this.ancestry,
    );
  }

  updatePeer(peerNodeAddr: NodeAddr, announce: TreeAnnounce): boolean {
    const key = nodeAddrToHex(peerNodeAddr);
    const existing = this.peers.get(key);
    if (existing && announce.sequence <= existing.sequence) return false;
    this.peers.set(key, {
      sequence: announce.sequence,
      parent: announce.parent,
      ancestry: announce.ancestry,
    });
    return this.evaluateParent();
  }

  removePeer(peerNodeAddr: NodeAddr): boolean {
    const removed = this.peers.delete(nodeAddrToHex(peerNodeAddr));
    return removed ? this.evaluateParent() : false;
  }

  isTreePeer(peerNodeAddr: NodeAddr): boolean {
    if (!bytesEqual(this.parent, this.identity.nodeAddr) && bytesEqual(this.parent, peerNodeAddr)) {
      return true;
    }
    return this.peers.get(nodeAddrToHex(peerNodeAddr))?.parent
      ? bytesEqual(this.peers.get(nodeAddrToHex(peerNodeAddr))!.parent, this.identity.nodeAddr)
      : false;
  }

  nextHop(destCoords: NodeAddr[], eligible: (nodeHex: string) => boolean): string | undefined {
    if (destCoords.length === 0 || !bytesEqual(this.root, destCoords.at(-1)!)) return undefined;
    const myDistance = treeDistance(this.coords, destCoords);
    let best: { nodeHex: string; distance: number } | undefined;
    for (const [nodeHex, peer] of this.peers) {
      if (!eligible(nodeHex)) continue;
      const distance = treeDistance(peer.ancestry.map((entry) => entry.nodeAddr), destCoords);
      if (distance >= myDistance) continue;
      if (!best || distance < best.distance || (distance === best.distance && nodeHex < best.nodeHex)) {
        best = { nodeHex, distance };
      }
    }
    return best?.nodeHex;
  }

  private evaluateParent(): boolean {
    const candidates = [...this.peers.entries()]
      .filter(([, peer]) => !peer.ancestry.some((entry) => bytesEqual(entry.nodeAddr, this.identity.nodeAddr)))
      .sort(([hexA, a], [hexB, b]) => {
        const rootOrder = compareNodeAddr(a.ancestry.at(-1)!.nodeAddr, b.ancestry.at(-1)!.nodeAddr);
        if (rootOrder !== 0) return rootOrder;
        const depthOrder = a.ancestry.length - b.ancestry.length;
        return depthOrder !== 0 ? depthOrder : hexA.localeCompare(hexB);
      });
    const best = candidates[0];
    const shouldRoot = !best || compareNodeAddr(this.identity.nodeAddr, best[1].ancestry.at(-1)!.nodeAddr) <= 0;
    const nextParent = shouldRoot ? this.identity.nodeAddr : best[1].ancestry[0]!.nodeAddr;
    const nextAncestry = shouldRoot
      ? [this.selfEntry()]
      : [this.selfEntry(), ...best[1].ancestry];
    if (bytesEqual(this.parent, nextParent) && sameCoords(this.ancestry, nextAncestry)) return false;
    this.sequence += 1n;
    this.timestamp = nowSeconds();
    this.parent = nextParent;
    this.ancestry = nextAncestry;
    this.ancestry[0] = this.selfEntry();
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
