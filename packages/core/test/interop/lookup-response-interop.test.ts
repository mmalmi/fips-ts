import { describe, expect, it, vi } from "vitest";

import {
  FipsNode,
  LinkMessageType,
  identityFromSecretKey,
} from "../../src/index.js";
import { bridgeAvailable, spawnBridge } from "./bridge.js";

const itIfBridge = bridgeAvailable() ? it : it.skip;
const RUST_ORIGIN_SK_HEX = "5656565656565656565656565656565656565656565656565656565656565656";

describe("LookupResponse interop: Rust origin -> TypeScript target", () => {
  itIfBridge("verifies the TypeScript self-lookup response in Rust", async () => {
    const identity = await identityFromSecretKey(new Uint8Array(32).fill(0x45));
    const node = new FipsNode({ identity, transports: [], forwarding: true });
    const sourcePeer = { transport: { mtu: 1_200 } };
    const bridge = spawnBridge("lookup-self", RUST_ORIGIN_SK_HEX);
    try {
      await bridge.writeFrame(identity.publicKey);
      const requestPayload = await bridge.readFrame();
      const sendLinkMessage = vi.fn(async (
        _peer: unknown,
        messageType: number,
        responsePayload: Uint8Array,
      ) => {
        expect(messageType).toBe(LinkMessageType.LookupResponse);
        await bridge.writeFrame(responsePayload);
      });
      const internal = node as unknown as {
        routeIncomingLinkMessage(
          peer: unknown,
          messageType: number,
          payload: Uint8Array,
        ): Promise<void>;
        sendLinkMessage: typeof sendLinkMessage;
      };
      internal.sendLinkMessage = sendLinkMessage;

      await internal.routeIncomingLinkMessage(
        sourcePeer,
        LinkMessageType.LookupRequest,
        requestPayload,
      );

      expect(new TextDecoder().decode(await bridge.readFrame())).toBe("verified");
      expect(sendLinkMessage).toHaveBeenCalledOnce();
      expect(await bridge.close()).toBe(0);
    } finally {
      await bridge.close();
    }
  });
});
