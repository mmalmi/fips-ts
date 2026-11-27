import { peerIdFromPubkey } from "../identity/index.js";
import { deriveNodeAddr, nodeAddrToHex, type NodeAddr } from "../nodeaddr/index.js";
import type { PeerEvent } from "./types.js";
import type { FmpLink } from "../fmp/link.js";
import type { BloomFilter } from "../bloom/index.js";
import type { Transport, TransportAddress } from "../transport/types.js";
import { bytesEqual } from "../codec/hex.js";

export const FMP_HANDSHAKE_TIMEOUT_MS = 15_000;
export const MAX_PENDING_FMP_RESPONDERS = 64;

/** FIPS identity uses all x-only bytes; Noise retains the actual key parity. */
export function sameCompressedIdentity(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === 33 && b.length === 33
    && (a[0] === 2 || a[0] === 3) && (b[0] === 2 || b[0] === 3)
    && bytesEqual(a.subarray(1), b.subarray(1));
}

export interface AdjacentPeer {
  pubkey: Uint8Array;
  pubkeyHex: string;
  cachedNodeAddrPubkey?: Uint8Array;
  cachedNodeAddr?: NodeAddr;
  cachedNodeAddrHex?: string;
  remoteAddr: TransportAddress;
  transport: Transport;
  link: FmpLink;
  pendingResponderLink?: FmpLink;
  drainingResponderLinks?: Map<number, { link: FmpLink; expiresAtMs: number }>;
  abandonedInitiatorSessionIdx?: number;
  treeAnnounced?: boolean;
  filterAnnounced?: boolean;
  clientSupported?: boolean;
  clientOnly?: boolean;
  routingRoleSequence?: bigint;
  extensionNamespace?: "legacy" | "namespaced";
  extensionCapabilities?: number;
  extensionRequestSent?: boolean;
  legacySupportProbes?: number;
  inboundFilter?: BloomFilter;
  inboundFilterSequence?: bigint;
  outboundFilter?: BloomFilter;
  outgoingHandshake?: {
    resolve: () => void;
    reject: (err: Error) => void;
    confirmCarrier?: () => void;
  };
  /** Last authenticated packet received over this link. The heartbeat sweep
   *  reads this stamp; `undefined` on a peer that has never authenticated. */
  lastAuthActivityMs?: number;
}

/** Return the peer's 16-byte NodeAddr, deriving and caching it once per pubkey. */
export function peerNodeAddr(peer: AdjacentPeer): NodeAddr {
  if (peer.cachedNodeAddrPubkey !== peer.pubkey || !peer.cachedNodeAddr) {
    peer.cachedNodeAddr = deriveNodeAddr(peer.pubkey);
    peer.cachedNodeAddrHex = nodeAddrToHex(peer.cachedNodeAddr);
    peer.cachedNodeAddrPubkey = peer.pubkey;
  }
  return peer.cachedNodeAddr;
}

/** Return the peer's 32-char lowercase NodeAddr hex, cached per pubkey. */
export function peerNodeKey(peer: AdjacentPeer): string {
  if (peer.cachedNodeAddrPubkey !== peer.pubkey || !peer.cachedNodeAddrHex) {
    peerNodeAddr(peer);
  }
  return peer.cachedNodeAddrHex!;
}

export function peerEvent(peer: AdjacentPeer, state: PeerEvent["state"]): PeerEvent {
  return {
    peerId: peerIdFromPubkey(peer.pubkeyHex),
    remotePubkey: peer.pubkeyHex,
    remoteAddr: peer.remoteAddr,
    state,
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
