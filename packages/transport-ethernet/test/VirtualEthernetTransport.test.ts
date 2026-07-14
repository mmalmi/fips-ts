import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FipsNode,
  FmpLink,
  FMP_PHASE_MSG1,
  fromHex,
  identityFromSecretKey,
  peekFmpPhase,
  toHex,
  type ReceivedTransportPacket,
  type TransportContext,
} from "@fips/core";

import {
  VirtualEthernetTransport,
  parseMac,
  type EthernetFramePort,
} from "../src/index.js";

const FIXTURE_PATH = resolve(
  __dirname,
  "../../../fixtures/rust-vectors/ethernet-frames.json",
);

interface EthernetVectors {
  dataFrame: {
    destinationMac: string;
    sourceMac: string;
    fmpHex: string;
    frameHex: string;
  };
  scopedBeacon: {
    destinationMac: string;
    sourceMac: string;
    xOnlyPubkeyHex: string;
    scope: string;
    frameHex: string;
  };
}

const vectors = JSON.parse(
  readFileSync(FIXTURE_PATH, "utf8"),
) as EthernetVectors;

class FakeFramePort implements EthernetFramePort {
  readonly sent: Uint8Array[] = [];
  onSend?: (frame: Uint8Array) => void;
  private listener?: (frame: Uint8Array) => void;

  onFrame(listener: (frame: Uint8Array) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  async sendFrame(frame: Uint8Array): Promise<void> {
    const copy = new Uint8Array(frame);
    this.sent.push(copy);
    this.onSend?.(copy);
  }

  receive(frame: Uint8Array): void {
    this.listener?.(new Uint8Array(frame));
  }

  get subscribed(): boolean {
    return this.listener !== undefined;
  }
}

async function startedTransport(options: {
  scope?: string;
  mtu?: number;
  localMac?: string;
} = {}): Promise<{
  port: FakeFramePort;
  packets: ReceivedTransportPacket[];
  transport: VirtualEthernetTransport;
  context: TransportContext;
}> {
  const port = new FakeFramePort();
  const packets: ReceivedTransportPacket[] = [];
  const identity = await identityFromSecretKey(new Uint8Array(32).fill(0x22));
  const transport = new VirtualEthernetTransport({
    port,
    localMac: options.localMac ?? vectors.dataFrame.sourceMac,
    announce: false,
    discoveryScope: options.scope,
    mtu: options.mtu,
  });
  const context: TransportContext = {
    localIdentity: identity,
    onPacket: (packet) => packets.push(packet),
  };
  await transport.start(context);
  return { port, packets, transport, context };
}

describe("VirtualEthernetTransport Rust frame compatibility", () => {
  it("emits and accepts exact Rust FIPS data-frame bytes, trimming Ethernet padding", async () => {
    const { packets, port, transport } = await startedTransport();
    try {
      const remote = {
        transport: "ethernet",
        addr: vectors.dataFrame.destinationMac,
      };
      await transport.connect(remote);
      await transport.send(remote, fromHex(vectors.dataFrame.fmpHex));

      expect(toHex(port.sent[0])).toBe(vectors.dataFrame.frameHex);

      const inbound = fromHex(vectors.dataFrame.frameHex);
      inbound.set(fromHex("020000000001"), 0);
      inbound.set(fromHex("aabbccddeeff"), 6);
      const padded = new Uint8Array(60);
      padded.set(inbound);
      port.receive(padded);

      expect(packets).toHaveLength(1);
      expect(toHex(packets[0].data)).toBe(vectors.dataFrame.fmpHex);
      expect(packets[0].remoteAddr).toEqual({
        transport: "ethernet",
        addr: vectors.dataFrame.destinationMac,
      });
    } finally {
      await transport.stop();
    }
  });

  it("parses scoped Rust beacons and records the pubkey-to-MAC mapping", async () => {
    const { port, transport } = await startedTransport({
      scope: vectors.scopedBeacon.scope,
      localMac: "02:00:00:00:00:02",
    });
    const iterator = transport.discover!()[Symbol.asyncIterator]();
    try {
      const discovered = iterator.next();
      port.receive(fromHex(vectors.scopedBeacon.frameHex));

      await expect(discovered).resolves.toMatchObject({
        done: false,
        value: {
          remoteAddr: {
            transport: "ethernet",
            addr: vectors.scopedBeacon.sourceMac,
          },
          publicKey: fromHex(`02${vectors.scopedBeacon.xOnlyPubkeyHex}`),
          meta: { scope: vectors.scopedBeacon.scope },
        },
      });
      expect(
        transport.macForPubkey(`02${vectors.scopedBeacon.xOnlyPubkeyHex}`),
      ).toBe(vectors.scopedBeacon.sourceMac);
    } finally {
      await transport.stop();
    }
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("connects a TS FipsNode to a Rust-format virtual Ethernet peer", async () => {
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x22));
    const remoteSecret = new Uint8Array(32);
    remoteSecret[31] = 1;
    const remote = await identityFromSecretKey(remoteSecret);
    expect(toHex(remote.xOnlyPubkey)).toBe(vectors.scopedBeacon.xOnlyPubkeyHex);

    const port = new FakeFramePort();
    const localMac = "02:00:00:00:00:02";
    const remoteMac = vectors.scopedBeacon.sourceMac;
    const responder = new FmpLink({
      identity: remote,
      role: "responder",
      sessionIdx: 77,
      localEpoch: new Uint8Array(8).fill(0x77),
    });
    const transport = new VirtualEthernetTransport({
      port,
      localMac,
      announce: false,
      discoveryScope: vectors.scopedBeacon.scope,
    });
    const node = new FipsNode({ identity: local, transports: [transport] });
    const connected = new Promise<void>((resolve) => {
      node.on("peer", (event) => {
        const peer = event as { remotePubkey: string; state: string };
        if (peer.remotePubkey === toHex(remote.publicKey) && peer.state === "connected") {
          resolve();
        }
      });
    });

    port.onSend = (frame) => {
      const record = frame.subarray(14);
      if (record[0] !== 0x00) return;
      const fmpLength = record[1] | (record[2] << 8);
      const fmp = record.slice(3, 3 + fmpLength);
      expect(toHex(frame.subarray(0, 6))).toBe(toHex(parseMac(remoteMac)));
      expect(toHex(frame.subarray(6, 12))).toBe(toHex(parseMac(localMac)));
      expect(toHex(frame.subarray(12, 14))).toBe("2121");
      expect(fmpLength).toBe(fmp.length);
      if (peekFmpPhase(fmp) !== FMP_PHASE_MSG1) return;

      const reply = responder.handleMsg1(fmp, () => new Uint8Array(32)).reply!;
      const replyRecord = new Uint8Array(3 + reply.length);
      replyRecord[0] = 0x00;
      replyRecord[1] = reply.length & 0xff;
      replyRecord[2] = reply.length >>> 8;
      replyRecord.set(reply, 3);
      const inbound = new Uint8Array(14 + replyRecord.length);
      inbound.set(parseMac(localMac), 0);
      inbound.set(parseMac(remoteMac), 6);
      inbound.set(fromHex("2121"), 12);
      inbound.set(replyRecord, 14);
      queueMicrotask(() => port.receive(inbound));
    };

    await node.start();
    try {
      port.receive(fromHex(vectors.scopedBeacon.frameHex));
      await connected;
      expect(transport.macForPubkey(remote.publicKey)).toBe(remoteMac);
      expect(port.sent.length).toBeGreaterThanOrEqual(1);
    } finally {
      await node.stop();
    }
  });

  it("rejects self frames, wrong scopes, malformed lengths, and MTU overflow", async () => {
    const { packets, port, transport } = await startedTransport({ scope: "other", mtu: 4 });
    const iterator = transport.discover!()[Symbol.asyncIterator]();
    try {
      port.receive(fromHex(vectors.scopedBeacon.frameHex));

      const selfFrame = fromHex(vectors.dataFrame.frameHex);
      selfFrame.set(fromHex("020000000001"), 6);
      port.receive(selfFrame);

      const malformed = fromHex(vectors.dataFrame.frameHex);
      malformed.set(fromHex("020000000001"), 0);
      malformed.set(fromHex("aabbccddeeff"), 6);
      malformed[15] = 5;
      port.receive(malformed);

      expect(packets).toEqual([]);
      await expect(
        transport.send(
          { transport: "ethernet", addr: vectors.dataFrame.destinationMac },
          new Uint8Array(5),
        ),
      ).rejects.toThrow("exceeds MTU 4");
    } finally {
      await transport.stop();
    }
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("unsubscribes and can restart with a fresh discovery stream", async () => {
    const { context, port, transport } = await startedTransport({
      localMac: "02:00:00:00:00:02",
    });
    const first = transport.discover!()[Symbol.asyncIterator]();
    expect(port.subscribed).toBe(true);
    await transport.stop();
    expect(port.subscribed).toBe(false);
    await expect(first.next()).resolves.toEqual({ done: true, value: undefined });

    await transport.start(context);
    const second = transport.discover!()[Symbol.asyncIterator]();
    port.receive(fromHex(vectors.scopedBeacon.frameHex));
    await expect(second.next()).resolves.toMatchObject({ done: false });
    await transport.stop();
  });

  it("rolls back a failed initial beacon send and remains restartable", async () => {
    const port = new FakeFramePort();
    const identity = await identityFromSecretKey(new Uint8Array(32).fill(0x22));
    const context: TransportContext = {
      localIdentity: identity,
      onPacket: () => undefined,
    };
    const transport = new VirtualEthernetTransport({
      port,
      localMac: "02:00:00:00:00:02",
    });
    port.onSend = () => {
      throw new Error("port send failed");
    };

    await expect(transport.start(context)).rejects.toThrow("port send failed");
    expect(port.subscribed).toBe(false);

    port.onSend = undefined;
    await transport.start(context);
    expect(port.subscribed).toBe(true);
    await transport.stop();
  });
});
