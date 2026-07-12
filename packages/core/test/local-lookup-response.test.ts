import { sha256 } from "@noble/hashes/sha256";
import { describe, expect, it, vi } from "vitest";

import {
  FipsNode,
  LinkMessageType,
  decodeLookupResponse,
  encodeLookupRequestPayload,
  identityFromSecretKey,
  lookupResponseProofBytes,
  verifySchnorr,
} from "../src/index.js";

describe("FipsNode local lookup response", () => {
  it("answers a self-targeted lookup with a Rust-compatible signed response", async () => {
    const identity = await identityFromSecretKey(new Uint8Array(32).fill(0x45));
    const node = new FipsNode({ identity, transports: [], forwarding: true });
    const sourcePeer = { transport: { mtu: 1_200 } };
    const sendLinkMessage = vi.fn(async () => {});
    const internal = node as unknown as {
      routing: {
        handleLinkMessage(
          peer: unknown,
          messageType: number,
          payload: Uint8Array,
        ): Promise<void>;
      };
      sendLinkMessage: typeof sendLinkMessage;
    };
    internal.sendLinkMessage = sendLinkMessage;

    const request = {
      requestId: 0x0102_0304_0506_0708n,
      target: identity.nodeAddr,
      origin: new Uint8Array(16).fill(0x77),
      ttl: 63,
      minMtu: 0,
      originCoords: [new Uint8Array(16).fill(0x77)],
    };
    await internal.routing.handleLinkMessage(
      sourcePeer,
      LinkMessageType.LookupRequest,
      encodeLookupRequestPayload(request),
    );

    expect(sendLinkMessage).toHaveBeenCalledTimes(1);
    const [peer, messageType, payload] = sendLinkMessage.mock.calls[0];
    expect(peer).toBe(sourcePeer);
    expect(messageType).toBe(LinkMessageType.LookupResponse);
    const response = decodeLookupResponse(payload);
    expect(response.requestId).toBe(request.requestId);
    expect(response.target).toEqual(identity.nodeAddr);
    expect(response.pathMtu).toBe(1_200);
    expect(response.targetCoords).toEqual([identity.nodeAddr]);
    expect(verifySchnorr(
      response.proof,
      sha256(lookupResponseProofBytes(
        response.requestId,
        response.target,
        response.targetCoords,
      )),
      identity.xOnlyPubkey,
    )).toBe(true);
  });
});
