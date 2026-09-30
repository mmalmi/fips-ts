import { expect, it, vi } from "vitest";

import { FmpLink, identityFromSecretKey } from "../../src/index.js";
import { LinkMessageType } from "../../src/protocol/link.js";
import { bridgeAvailable, spawnBridge } from "./bridge.js";

const itIfBridge = bridgeAvailable() ? it : it.skip;

itIfBridge("native FMP metrics accepts TS receiver measurements and leaves cold-start cadence", async () => {
  const identity = await identityFromSecretKey(new Uint8Array(32).fill(0x41));
  const seedIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x42));
  const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
  const browser = new FmpLink({
    identity, remotePubkey: seedIdentity.publicKey, role: "initiator",
    sessionIdx: 1, localEpoch: new Uint8Array(8),
  });
  const seed = new FmpLink({
    identity: seedIdentity, role: "responder", sessionIdx: 2, localEpoch: new Uint8Array(8),
  });
  const msg1 = browser.buildMsg1(() => new Uint8Array(32)).packet;
  browser.handleMsg2(seed.handleMsg1(msg1, () => new Uint8Array(32)).reply!);
  const bridge = spawnBridge("link-reports", "unused");
  try {
    for (let sample = 0; sample < 7; sample++) {
      const sr = await bridge.readFrame();
      expect(sr[0]).toBe(LinkMessageType.SenderReport);
      clock.mockReturnValue(2_000 + sample * 1_000);
      const frame = seed.encryptOutgoing(sr.subarray(1), sr[0]);
      clock.mockReturnValue(2_020 + sample * 1_000);
      const received = browser.decryptIncoming(frame);
      clock.mockReturnValue(2_025 + sample * 1_000);
      const rr = browser.receiverReportFor(received.payload)!;
      expect(rr).toHaveLength(67);
      const reply = seed.decryptIncoming(browser.encryptOutgoing(rr, LinkMessageType.ReceiverReport));
      await bridge.writeFrame(new Uint8Array([reply.msgType, ...reply.payload]));
      const result = await bridge.readFrame();
      const view = new DataView(result.buffer, result.byteOffset);
      expect(view.getUint32(0, true)).toBe(sample < 5 ? 200 : 1_000);
      expect(view.getUint32(4, true)).toBe(sample < 5 ? 200 : 1_000);
      expect(view.getUint32(8, true)).toBe(45);
    }
  } finally {
    clock.mockRestore();
    await bridge.close();
  }
});
