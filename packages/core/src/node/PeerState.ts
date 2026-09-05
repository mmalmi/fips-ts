import type { FmpLink } from "../fmp/link.js";
import type { BloomFilter } from "../bloom/index.js";
import type { Transport, TransportAddress } from "../transport/types.js";

export const FMP_HANDSHAKE_TIMEOUT_MS = 15_000;
export const MAX_PENDING_FMP_RESPONDERS = 64;

export interface AdjacentPeer {
  pubkey: Uint8Array;
  pubkeyHex: string;
  remoteAddr: TransportAddress;
  transport: Transport;
  link: FmpLink;
  pendingResponderLink?: FmpLink;
  drainingResponderLinks?: Map<number, { link: FmpLink; expiresAtMs: number }>;
  abandonedInitiatorSessionIdx?: number;
  treeAnnounced?: boolean;
  filterAnnounced?: boolean;
  inboundFilter?: BloomFilter;
  inboundFilterSequence?: bigint;
  outboundFilter?: BloomFilter;
  outgoingHandshake?: {
    resolve: () => void;
    reject: (err: Error) => void;
    confirmCarrier?: () => void;
  };
}

export function pruneDrainingResponderLinks(peer: AdjacentPeer, nowMs: number): void {
  if (!peer.drainingResponderLinks) return;
  for (const [receiverIdx, draining] of peer.drainingResponderLinks) {
    if (draining.expiresAtMs > nowMs) continue;
    draining.link.close();
    peer.drainingResponderLinks.delete(receiverIdx);
  }
  if (peer.drainingResponderLinks.size === 0) {
    peer.drainingResponderLinks = undefined;
  }
}
