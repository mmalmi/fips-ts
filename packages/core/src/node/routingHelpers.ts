import { sha256 } from "@noble/hashes/sha256";

import { bytesEqual, fromHex } from "../codec/hex.js";
import {
  compressedPubkeyFromXOnly,
} from "../identity/index.js";
import {
  deriveNodeAddr,
  nodeAddrToHex,
  type NodeAddr,
} from "../nodeaddr/index.js";
import { LinkMessageType } from "../protocol/link.js";
import { encodeExtensionClientOnly, FMP_EXTENSION_CLIENT_ROLE } from "../protocol/extensions.js";
import type { Transport, TransportAddress } from "../transport/types.js";

import { peerNodeKey, type AdjacentPeer } from "./PeerState.js";

export { peerNodeKey };

export function frameCapacity(peer: AdjacentPeer): number {
  return Math.min(0xffff, peer.transport.maxFrameBytes ?? peer.transport.mtu);
}

/** Keep a newer narrow link from hiding a usable carrier to the same identity. */
export function selectCarrier(
  preferred: AdjacentPeer | undefined,
  peers: Iterable<AdjacentPeer>,
  excludedPeer: AdjacentPeer | undefined,
  minMtu: number,
): AdjacentPeer | undefined {
  if (!preferred) return undefined;
  const usable = (peer: AdjacentPeer) => peer.link.state === "established"
    && peer.pubkeyHex !== excludedPeer?.pubkeyHex && frameCapacity(peer) >= minMtu;
  if (usable(preferred)) return preferred;
  const nodeHex = peerNodeKey(preferred);
  for (const peer of peers) {
    if (usable(peer) && peerNodeKey(peer) === nodeHex) return peer;
  }
  return undefined;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function discoveryPublicKey(discovered: {
  publicKey?: Uint8Array;
  remoteAddr: TransportAddress;
}): Uint8Array {
  const hinted = discovered.publicKey;
  if (hinted?.length === 32) return compressedPubkeyFromXOnly(hinted);
  if (hinted?.length === 33) {
    if (hinted[0] !== 0x02 && hinted[0] !== 0x03) {
      throw new Error("discovered compressed pubkey has invalid prefix");
    }
    return new Uint8Array(hinted);
  }
  if (!hinted && discovered.remoteAddr.addr.length === 66) {
    return fromHex(discovered.remoteAddr.addr);
  }
  throw new Error("discovered peer did not include a FIPS public key");
}

export function lookupReverseKey(requestId: bigint, target: NodeAddr): string {
  return `${requestId.toString(16)}:${nodeAddrToHex(target)}`;
}

/**
 * Filter candidate lookup peers using their advertised inbound Bloom filters.
 * Computes SHA-256(target) at most once, skips client-only peers unless they
 * are the target, and falls back to all candidates only when requested.
 */
export function filterLookupPeersByBloom(
  peers: AdjacentPeer[],
  target: NodeAddr,
  targetHex: string,
  defaultPeer: AdjacentPeer | undefined,
  allowFallback: boolean,
  treeScope?: { isTreePeer: (peer: AdjacentPeer) => boolean; strictTreeOnly: boolean },
): AdjacentPeer[] {
  const candidates = peers.filter((peer) => !peer.clientOnly || peerNodeKey(peer) === targetHex);
  if (candidates.length === 0) return [];
  let digest: Uint8Array | undefined;
  const matchesBloom = (peer: AdjacentPeer): boolean => {
    if (peerNodeKey(peer) === targetHex || peer === defaultPeer || !peer.inboundFilter) return true;
    digest ??= sha256(target);
    return peer.inboundFilter.containsDigest(digest);
  };
  if (treeScope) {
    const treeMatches = candidates.filter((peer) =>
      (peerNodeKey(peer) === targetHex || peer === defaultPeer || treeScope.isTreePeer(peer)) && matchesBloom(peer),
    );
    if (treeMatches.length > 0 || treeScope.strictTreeOnly) return treeMatches;
  }
  const matched = candidates.filter(matchesBloom);
  return matched.length > 0 || !allowFallback ? matched : candidates;
}

const MAX_LEGACY_SUPPORT_PROBES = 3;

export function nextClientRoleMessage(
  peer: AdjacentPeer,
  allowLegacyProbe: boolean,
  nextSequence: () => bigint,
): { msgType: number; payload: Uint8Array } | undefined {
  if (peer.extensionNamespace === "namespaced") {
    if ((peer.extensionCapabilities ?? 0) & FMP_EXTENSION_CLIENT_ROLE) {
      return { msgType: LinkMessageType.Extension, payload: encodeExtensionClientOnly(nextSequence()) };
    }
    return undefined;
  }
  if (peer.extensionNamespace === "legacy") {
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setBigUint64(0, nextSequence(), true);
    return { msgType: LinkMessageType.ClientOnly, payload };
  }
  if (allowLegacyProbe && (peer.legacySupportProbes ?? 0) < MAX_LEGACY_SUPPORT_PROBES) {
    peer.legacySupportProbes = (peer.legacySupportProbes ?? 0) + 1;
    return { msgType: LinkMessageType.ClientSupport, payload: new Uint8Array() };
  }
  return undefined;
}

export function isKnownUnhandledLinkMessage(msgType: number): boolean {
  return (
    msgType === LinkMessageType.Heartbeat
    || msgType === LinkMessageType.Disconnect
    || msgType === LinkMessageType.SenderReport
    || msgType === LinkMessageType.ReceiverReport
    || msgType === LinkMessageType.TreeAnnounce
    || msgType === LinkMessageType.FilterAnnounce
  );
}


interface ResolvedTransportIdentity {
  transport: Transport;
  remoteAddr: TransportAddress;
  remotePubkey: Uint8Array;
}

/** Resolve signed transport discovery without opening its physical carrier. */
export async function resolveTransportIdentity(
  transports: Transport[], destNodeAddr: NodeAddr, abort: AbortController, isStarted: () => boolean,
): Promise<ResolvedTransportIdentity> {
  const destNodeHex = nodeAddrToHex(destNodeAddr);
  if (abort.signal.aborted || !isStarted()) throw new Error("FIPS node stopped");
  const resolvers = transports.filter(
    (transport): transport is Transport & Required<Pick<Transport, "resolve">> =>
      transport.resolve !== undefined,
  );
  if (resolvers.length === 0) throw new Error(`no route to ${destNodeHex}`);

  const resolutionTasks = resolvers.map(async (transport): Promise<ResolvedTransportIdentity> => {
    const discovered = await transport.resolve(destNodeAddr, abort.signal);
    if (!discovered) throw new Error("transport did not resolve destination");
    if (discovered.remoteAddr.transport !== transport.type) {
      throw new Error("resolved address transport mismatch");
    }
    const remotePubkey = discoveryPublicKey(discovered);
    if (!bytesEqual(deriveNodeAddr(remotePubkey), destNodeAddr)) {
      throw new Error("resolved identity does not match destination NodeAddr");
    }
    return { transport, remoteAddr: discovered.remoteAddr, remotePubkey };
  });
  const noRoute = (): Error => new Error(`no route to ${destNodeHex}`);
  const candidate = Promise.any(resolutionTasks).catch(() => {
    throw noRoute();
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(isStarted() ? noRoute() : new Error("FIPS node stopped"));
    abort.signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => abort.abort(), 5_000);
  });

  let resolved: ResolvedTransportIdentity;
  try {
    resolved = await Promise.race([candidate, boundary]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) abort.signal.removeEventListener("abort", onAbort);
    if (!abort.signal.aborted) abort.abort();
  }
  return resolved;
}
