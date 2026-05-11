/**
 * Wire protocol for the FIPS hashtree adapter.
 *
 * The payload of a FIPS service-port-7001 datagram is the same as
 * @hashtree/mesh's mesh frame: a 1-byte msg type prefix + MessagePack body.
 *
 *   byte 0:        type (0x00 = DataRequest, 0x01 = DataResponse)
 *   bytes 1..:     MessagePack of the corresponding body
 *
 * Bodies follow @hashtree/mesh:
 *   DataRequest:  { h: Uint8Array (32), htl?: number }
 *   DataResponse: { h: Uint8Array (32), d: Uint8Array, i?: number, n?: number }
 */

import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";

export const HASHTREE_FIPS_PORT = 7001;
export const MSG_TYPE_REQUEST = 0x00;
export const MSG_TYPE_RESPONSE = 0x01;

export interface DataRequest {
  h: Uint8Array;
  htl?: number;
}

export interface DataResponse {
  h: Uint8Array;
  d: Uint8Array;
  i?: number;
  n?: number;
}

function prepend(type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.length);
  out[0] = type;
  out.set(body, 1);
  return out;
}

export function encodeDataRequest(req: DataRequest): Uint8Array {
  return prepend(MSG_TYPE_REQUEST, msgpackEncode(req));
}

export function encodeDataResponse(res: DataResponse): Uint8Array {
  return prepend(MSG_TYPE_RESPONSE, msgpackEncode(res));
}

export type ParsedMessage =
  | { type: typeof MSG_TYPE_REQUEST; body: DataRequest }
  | { type: typeof MSG_TYPE_RESPONSE; body: DataResponse };

export function parseMessage(buf: Uint8Array): ParsedMessage {
  if (buf.length < 1) throw new Error("empty hashtree message");
  const type = buf[0];
  const body = msgpackDecode(buf.subarray(1)) as Record<string, unknown>;
  if (type === MSG_TYPE_REQUEST) {
    if (!(body.h instanceof Uint8Array)) throw new Error("DataRequest.h missing");
    return {
      type: MSG_TYPE_REQUEST,
      body: { h: body.h, htl: typeof body.htl === "number" ? body.htl : undefined },
    };
  }
  if (type === MSG_TYPE_RESPONSE) {
    if (!(body.h instanceof Uint8Array)) throw new Error("DataResponse.h missing");
    if (!(body.d instanceof Uint8Array)) throw new Error("DataResponse.d missing");
    return {
      type: MSG_TYPE_RESPONSE,
      body: {
        h: body.h,
        d: body.d,
        i: typeof body.i === "number" ? body.i : undefined,
        n: typeof body.n === "number" ? body.n : undefined,
      },
    };
  }
  throw new Error(`unknown hashtree msg type ${type}`);
}
