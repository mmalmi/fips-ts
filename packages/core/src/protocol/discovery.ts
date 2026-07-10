import { BinaryReader, BinaryWriter } from "../codec/binary.js";
import { nodeAddrFromSlice, type NodeAddr } from "../nodeaddr/index.js";

export interface LookupRequest {
  requestId: bigint;
  target: NodeAddr;
  origin: NodeAddr;
  ttl: number;
  minMtu: number;
  originCoords: NodeAddr[];
}

export interface LookupResponse {
  requestId: bigint;
  target: NodeAddr;
  pathMtu: number;
  targetCoords: NodeAddr[];
  proof: Uint8Array;
}

export function decodeLookupRequest(payload: Uint8Array): LookupRequest {
  const reader = new BinaryReader(payload);
  const request: LookupRequest = {
    requestId: reader.u64le(),
    target: nodeAddrFromSlice(reader.bytes(16)),
    origin: nodeAddrFromSlice(reader.bytes(16)),
    ttl: reader.u8(),
    minMtu: reader.u16le(),
    originCoords: decodeCoords(reader),
  };
  if (reader.remaining !== 0) throw new Error("trailing LookupRequest bytes");
  return request;
}

export function encodeLookupRequestPayload(request: LookupRequest): Uint8Array {
  const writer = new BinaryWriter();
  writer.u64le(request.requestId);
  writer.bytes(request.target);
  writer.bytes(request.origin);
  writer.u8(request.ttl);
  writer.u16le(request.minMtu);
  encodeCoords(writer, request.originCoords);
  return writer.toBytes();
}

export function decodeLookupResponse(payload: Uint8Array): LookupResponse {
  const reader = new BinaryReader(payload);
  const response: LookupResponse = {
    requestId: reader.u64le(),
    target: nodeAddrFromSlice(reader.bytes(16)),
    pathMtu: reader.u16le(),
    targetCoords: decodeCoords(reader),
    proof: reader.bytes(64),
  };
  if (reader.remaining !== 0) throw new Error("trailing LookupResponse bytes");
  return response;
}

export function encodeLookupResponsePayload(response: LookupResponse): Uint8Array {
  if (response.proof.length !== 64) throw new Error("LookupResponse proof must be 64 bytes");
  const writer = new BinaryWriter();
  writer.u64le(response.requestId);
  writer.bytes(response.target);
  writer.u16le(response.pathMtu);
  encodeCoords(writer, response.targetCoords);
  writer.bytes(response.proof);
  return writer.toBytes();
}

/** Bytes signed by a lookup target, matching Rust LookupResponse::proof_bytes. */
export function lookupResponseProofBytes(
  requestId: bigint,
  target: NodeAddr,
  targetCoords: NodeAddr[],
): Uint8Array {
  const writer = new BinaryWriter();
  writer.u64le(requestId);
  writer.bytes(target);
  encodeCoords(writer, targetCoords);
  return writer.toBytes();
}

function decodeCoords(reader: BinaryReader): NodeAddr[] {
  const count = reader.u16le();
  if (count === 0) throw new Error("lookup coordinates must not be empty");
  const coords: NodeAddr[] = [];
  for (let index = 0; index < count; index += 1) {
    coords.push(nodeAddrFromSlice(reader.bytes(16)));
  }
  return coords;
}

function encodeCoords(writer: BinaryWriter, coords: NodeAddr[]): void {
  if (coords.length === 0 || coords.length > 0xffff) {
    throw new Error("lookup coordinates count is out of range");
  }
  writer.u16le(coords.length);
  for (const coord of coords) {
    if (coord.length !== 16) throw new Error("lookup coordinate must be 16 bytes");
    writer.bytes(coord);
  }
}
