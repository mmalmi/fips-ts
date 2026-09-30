import { describe, expect, it, vi } from "vitest";

import { WebRtcConnection } from "../src/WebRtcConnection.js";

const READY_FRAME = new Uint8Array([0xff, 0x46, 0x57, 0x52, 0x31]);

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "connecting";
  iceConnectionState: RTCIceConnectionState = "new";

  setIceState(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.dispatchEvent(new Event("iceconnectionstatechange"));
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.dispatchEvent(new Event("connectionstatechange"));
  }

  close(): void {
    this.connectionState = "closed";
    this.iceConnectionState = "closed";
  }
}

class FakeDataChannel extends EventTarget {
  binaryType: BinaryType = "arraybuffer";
  readyState: RTCDataChannelState = "connecting";
  sent: Uint8Array[] = [];

  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  receive(data: Uint8Array): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  send(data: BufferSource | string): void {
    if (data instanceof Uint8Array) {
      this.sent.push(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
    }
  }

  close(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

describe("WebRtcConnection", () => {
  it("starts the ready handshake when attached to an already-open channel", async () => {
    vi.useFakeTimers();
    const pc = new FakePeerConnection();
    pc.connectionState = "connected";
    const dataChannel = new FakeDataChannel();
    dataChannel.readyState = "open";
    const states: string[] = [];
    const conn = new WebRtcConnection({
      remotePubkeyHex: "02" + "11".repeat(32),
      remoteAddr: { transport: "webrtc", addr: "02" + "11".repeat(32) },
      pc: pc as unknown as RTCPeerConnection,
      dataChannel: dataChannel as unknown as RTCDataChannel,
      onPacket: () => undefined,
      onState: (state) => states.push(state),
    });
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(dataChannel.sent).toEqual([READY_FRAME]);
      expect(states).toEqual(["connected"]);
    } finally { conn.close(); vi.useRealTimers(); }
  });

  it("reports connected when ICE is connected and the data channel is ready", () => {
    const pc = new FakePeerConnection();
    const dataChannel = new FakeDataChannel();
    const states: string[] = [];

    new WebRtcConnection({
      remotePubkeyHex: "02" + "11".repeat(32),
      remoteAddr: { transport: "webrtc", addr: "02" + "11".repeat(32) },
      pc: pc as unknown as RTCPeerConnection,
      dataChannel: dataChannel as unknown as RTCDataChannel,
      onPacket: () => undefined,
      onState: (state) => states.push(state),
      readyFallbackMs: 0,
    });

    pc.setIceState("connected");
    dataChannel.open();
    dataChannel.receive(READY_FRAME);

    expect(states).toContain("connected");
    expect(dataChannel.sent.some((packet) => packet.length === READY_FRAME.length)).toBe(true);
  });
});
