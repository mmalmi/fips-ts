import { BloomFilter } from "../bloom/index.js";
import { bytesEqual } from "../codec/hex.js";
import type { FipsIdentity } from "../identity/index.js";
import { deriveNodeAddr, nodeAddrToHex, type NodeAddr } from "../nodeaddr/index.js";
import {
  buildFilterAnnounce,
  decodeFilterAnnounce,
  encodeFilterAnnounce,
} from "../protocol/filter.js";
import { LinkMessageType } from "../protocol/link.js";
import type { Logger } from "../transport/types.js";

import type { AdjacentPeer } from "./PeerState.js";

interface BloomRoutingConfig {
  identity: FipsIdentity;
  logger: Logger;
  getPeers: () => Iterable<AdjacentPeer>;
  isTreePeer: (nodeAddr: NodeAddr) => boolean;
  sendLinkMessage: (
    peer: AdjacentPeer,
    msgType: number,
    payload: Uint8Array,
  ) => Promise<void>;
  emitError: (error: Error, where: string) => void;
}

const MAX_INBOUND_FILTER_FPR = 0.05;

export class BloomRouting {
  private sequence = 0n;

  constructor(private readonly cfg: BloomRoutingConfig) {}

  schedule(peer: AdjacentPeer): void {
    setTimeout(() => {
      void this.send(peer).catch((error) => {
        peer.filterAnnounced = false;
        this.cfg.emitError(error as Error, "send FilterAnnounce");
      });
    }, 0);
  }

  async sendAll(excludedPeer?: AdjacentPeer): Promise<void> {
    const peers = [...this.cfg.getPeers()].filter(
      (peer) => peer !== excludedPeer && peer.link.state === "established",
    );
    await Promise.allSettled(peers.map((peer) => this.send(peer)));
  }

  async handle(peer: AdjacentPeer, payload: Uint8Array): Promise<void> {
    const encoded = new Uint8Array(payload.length + 1);
    encoded[0] = LinkMessageType.FilterAnnounce;
    encoded.set(payload, 1);
    const announce = decodeFilterAnnounce(encoded);
    if (announce.sequence <= (peer.inboundFilterSequence ?? 0n)) return;
    const fpr = announce.filter.fillRatio() ** announce.filter.hashCount;
    if (fpr > MAX_INBOUND_FILTER_FPR) {
      this.cfg.logger.warn("filter announce rejected above FPR cap", peerNodeKey(peer));
      return;
    }

    peer.inboundFilter = announce.filter;
    peer.inboundFilterSequence = announce.sequence;
    this.cfg.logger.debug(
      "filter announce accepted",
      peerNodeKey(peer),
      "entries-bits",
      announce.filter.countOnes(),
    );
    if (this.cfg.isTreePeer(deriveNodeAddr(peer.pubkey))) await this.sendAll(peer);
  }

  private async send(peer: AdjacentPeer): Promise<void> {
    if (peer.link.state !== "established") return;
    const filter = this.outgoingFilterFor(peer);
    if (peer.outboundFilter && sameFilter(peer.outboundFilter, filter)) return;

    const previous = peer.outboundFilter;
    peer.outboundFilter = filter;
    this.sequence += 1n;
    const encoded = encodeFilterAnnounce(buildFilterAnnounce(filter, this.sequence));
    try {
      await this.cfg.sendLinkMessage(
        peer,
        LinkMessageType.FilterAnnounce,
        encoded.subarray(1),
      );
    } catch (error) {
      if (peer.outboundFilter === filter) peer.outboundFilter = previous;
      throw error;
    }
    this.cfg.logger.debug(
      "filter announce sent",
      peerNodeKey(peer),
      "entries-bits",
      filter.countOnes(),
    );
  }

  private outgoingFilterFor(excludedPeer: AdjacentPeer): BloomFilter {
    const filter = BloomFilter.empty();
    filter.insertBytes(this.cfg.identity.nodeAddr);
    for (const peer of this.cfg.getPeers()) {
      if (
        peer === excludedPeer
        || peer.link.state !== "established"
        || !peer.inboundFilter
        || !this.cfg.isTreePeer(deriveNodeAddr(peer.pubkey))
      ) continue;
      filter.merge(peer.inboundFilter);
    }
    return filter;
  }
}

function peerNodeKey(peer: AdjacentPeer): string {
  return nodeAddrToHex(deriveNodeAddr(peer.pubkey));
}

function sameFilter(left: BloomFilter, right: BloomFilter): boolean {
  return bytesEqual(left.asBytes(), right.asBytes())
    && left.hashCount === right.hashCount;
}
