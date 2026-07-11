import { sha256 } from "@noble/hashes/sha256";

import { BinaryReader, BinaryWriter } from "../codec/binary.js";
import { bytesEqual } from "../codec/hex.js";
import { signSchnorr, verifySchnorr, type FipsIdentity } from "../identity/index.js";
import { compareNodeAddr, type NodeAddr } from "../nodeaddr/index.js";

import { LinkMessageType } from "./link.js";

export const TREE_ANNOUNCE_VERSION = 1;
export const TREE_COORD_ENTRY_SIZE = 32;
export const TREE_ANNOUNCE_MIN_PAYLOAD_SIZE = 99;

export interface TreeCoordEntry {
  nodeAddr: NodeAddr;
  sequence: bigint;
  timestamp: bigint;
}

export interface TreeAnnounce {
  sequence: bigint;
  timestamp: bigint;
  parent: NodeAddr;
  ancestry: TreeCoordEntry[];
  signature: Uint8Array;
}

export function treeDeclarationBytes(
  nodeAddr: NodeAddr,
  parent: NodeAddr,
  sequence: bigint,
  timestamp: bigint,
): Uint8Array {
  const writer = new BinaryWriter();
  writer.bytes(nodeAddr);
  writer.bytes(parent);
  writer.u64le(sequence);
  writer.u64le(timestamp);
  return writer.toBytes();
}

export function buildTreeAnnounce(
  identity: FipsIdentity,
  parent: NodeAddr,
  sequence: bigint,
  timestamp: bigint,
  ancestry: TreeCoordEntry[],
): TreeAnnounce {
  const signature = signSchnorr(
    identity,
    sha256(treeDeclarationBytes(identity.nodeAddr, parent, sequence, timestamp)),
  );
  return { sequence, timestamp, parent, ancestry, signature };
}

export function encodeTreeAnnounce(announce: TreeAnnounce): Uint8Array {
  validateTreeAnnounceSemantics(announce);
  if (announce.signature.length !== 64) throw new Error("TreeAnnounce signature must be 64 bytes");
  const writer = new BinaryWriter();
  writer.u8(LinkMessageType.TreeAnnounce);
  writer.u8(TREE_ANNOUNCE_VERSION);
  writer.u64le(announce.sequence);
  writer.u64le(announce.timestamp);
  writer.bytes(announce.parent);
  writer.u16le(announce.ancestry.length);
  for (const entry of announce.ancestry) {
    writer.bytes(entry.nodeAddr);
    writer.u64le(entry.sequence);
    writer.u64le(entry.timestamp);
  }
  writer.bytes(announce.signature);
  return writer.toBytes();
}

export function decodeTreeAnnounce(buf: Uint8Array): TreeAnnounce {
  if (buf.length < 1 + TREE_ANNOUNCE_MIN_PAYLOAD_SIZE) {
    throw new Error("TreeAnnounce too short");
  }
  const reader = new BinaryReader(buf);
  if (reader.u8() !== LinkMessageType.TreeAnnounce) throw new Error("not a TreeAnnounce");
  if (reader.u8() !== TREE_ANNOUNCE_VERSION) throw new Error("unsupported TreeAnnounce version");
  const sequence = reader.u64le();
  const timestamp = reader.u64le();
  const parent = reader.bytes(16);
  const count = reader.u16le();
  if (count === 0 || reader.remaining !== count * TREE_COORD_ENTRY_SIZE + 64) {
    throw new Error("invalid TreeAnnounce ancestry length");
  }
  const ancestry: TreeCoordEntry[] = [];
  for (let i = 0; i < count; i++) {
    ancestry.push({
      nodeAddr: reader.bytes(16),
      sequence: reader.u64le(),
      timestamp: reader.u64le(),
    });
  }
  const announce = { sequence, timestamp, parent, ancestry, signature: reader.bytes(64) };
  validateTreeAnnounceSemantics(announce);
  return announce;
}

export function decodeTreeAnnouncePayload(payload: Uint8Array): TreeAnnounce {
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = LinkMessageType.TreeAnnounce;
  frame.set(payload, 1);
  return decodeTreeAnnounce(frame);
}

export function verifyTreeAnnounce(announce: TreeAnnounce, peerPubkey: Uint8Array): boolean {
  const nodeAddr = announce.ancestry[0]!.nodeAddr;
  return verifySchnorr(
    announce.signature,
    sha256(treeDeclarationBytes(nodeAddr, announce.parent, announce.sequence, announce.timestamp)),
    peerPubkey.subarray(1),
  );
}

export function validateTreeAnnounceSemantics(announce: TreeAnnounce): void {
  const first = announce.ancestry[0];
  if (!first) throw new Error("TreeAnnounce ancestry cannot be empty");
  const isRoot = bytesEqual(first.nodeAddr, announce.parent);
  if (isRoot && announce.ancestry.length !== 1) throw new Error("invalid root ancestry");
  if (!isRoot && !bytesEqual(announce.ancestry[1]?.nodeAddr ?? new Uint8Array(), announce.parent)) {
    throw new Error("TreeAnnounce parent does not match ancestry");
  }
  const root = announce.ancestry.at(-1)!.nodeAddr;
  for (const entry of announce.ancestry) {
    if (compareNodeAddr(entry.nodeAddr, root) < 0) {
      throw new Error("TreeAnnounce root is not the minimum ancestry address");
    }
  }
}
