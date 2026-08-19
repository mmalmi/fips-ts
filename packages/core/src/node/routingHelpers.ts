import {
  compressedPubkeyFromXOnly,
} from "../identity/index.js";
import {
  deriveNodeAddr,
  nodeAddrToHex,
  type NodeAddr,
} from "../nodeaddr/index.js";
import { LinkMessageType } from "../protocol/link.js";
import type { TransportAddress } from "../transport/types.js";

import type { AdjacentPeer } from "./PeerState.js";

export function peerNodeKey(peer: AdjacentPeer): string {
  return nodeAddrToHex(deriveNodeAddr(peer.pubkey));
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
    return hexBytes(discovered.remoteAddr.addr);
  }
  throw new Error("discovered peer did not include a FIPS public key");
}

export function lookupReverseKey(requestId: bigint, target: NodeAddr): string {
  return `${requestId.toString(16)}:${nodeAddrToHex(target)}`;
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

function hexBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
