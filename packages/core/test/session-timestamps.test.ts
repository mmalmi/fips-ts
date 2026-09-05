import { afterEach, describe, expect, it, vi } from "vitest";

import { aeadOpen } from "../src/crypto/aead.js";
import { FmpLink } from "../src/fmp/link.js";
import { decodeFmpEstablished, decodeFmpInner } from "../src/fmp/wire.js";
import { FspSession } from "../src/fsp/session.js";
import { identityFromSecretKey } from "../src/identity/index.js";
import type { CipherState } from "../src/noise/cipherState.js";

afterEach(() => vi.restoreAllMocks());

describe.each(["FMP", "FSP"] as const)("%s sender timestamps", (protocol) => {
  it("uses elapsed milliseconds, ignores wall-clock jumps, wraps u32, and resets for fresh keys", async () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const identity = await identityFromSecretKey(new Uint8Array(32).fill(0x31));
    const remote = await identityFromSecretKey(new Uint8Array(32).fill(0x72));
    const random = () => new Uint8Array(32);

    function establish(): () => number {
      if (protocol === "FMP") {
        const sender = new FmpLink({
          identity, remotePubkey: remote.publicKey, role: "initiator",
          sessionIdx: 1, localEpoch: new Uint8Array(8),
        });
        const receiver = new FmpLink({
          identity: remote, role: "responder", sessionIdx: 2, localEpoch: new Uint8Array(8),
        });
        now += 500; // Construction and handshake time are not session age.
        sender.handleMsg2(receiver.handleMsg1(sender.buildMsg1(random).packet, random).reply!);
        return () => {
          const packet = sender.encryptOutgoing(new Uint8Array([7]));
          const frame = decodeFmpEstablished(packet);
          const rx = Reflect.get(receiver, "rx") as CipherState;
          const plaintext = aeadOpen(rx.getKey(), frame.counter, frame.ciphertext, packet.subarray(0, 16));
          expect(receiver.decryptIncoming(packet).payload).toEqual(new Uint8Array([7]));
          return decodeFmpInner(plaintext).timestamp;
        };
      }
      const sender = new FspSession({ identity, remotePubkey: remote.publicKey, role: "initiator" });
      const receiver = new FspSession({ identity: remote, role: "responder" });
      now += 500;
      receiver.handleMsg3(sender.handleMsg2(receiver.handleMsg1(sender.buildMsg1(random), random), random));
      return () => {
        let timestamp = -1;
        const received = receiver.decryptIncoming(sender.encryptEndpointData(new Uint8Array([7])), (record) => {
          timestamp = record.timestamp;
        });
        expect(received.endpointData).toEqual(new Uint8Array([7]));
        return timestamp;
      };
    }

    const timestamp = establish();
    const started = now;
    expect(timestamp()).toBe(0);
    now += 1_234.875;
    expect(timestamp()).toBe(1_234);
    wallClock.mockReturnValue(1_700_000_000_000);
    expect(timestamp()).toBe(1_234);
    now = started + 2 ** 32 + 17;
    expect(timestamp()).toBe(17);
    const nextEpochTimestamp = establish();
    expect(nextEpochTimestamp()).toBe(0);
    now += 321;
    expect(nextEpochTimestamp()).toBe(321);
  });
});
