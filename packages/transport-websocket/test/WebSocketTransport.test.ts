import { describe, expect, it, vi } from "vitest";

import {
  FSP_FLAG_DIRECT_TRANSPORT,
  encodeFspEstablished,
  identityFromSecretKey,
  toHex,
  type DiscoveredPeer,
  type ReceivedTransportPacket,
  type TransportContext,
} from "@fips/core";

import {
  LOCAL_KEY_HINT_REQUEST_BYTES,
  LOCAL_KEY_HINT_RESPONSE_BYTES,
  WebSocketTransport,
  decodeLocalKeyHint,
  encodeLocalKeyHintRequest,
  encodeLocalKeyHintResponse,
  validateFipsWebSocketRecord,
} from "../src/index.js";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  readyState = FakeWebSocket.CONNECTING;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(data: string | ArrayBuffer | Blob): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("not open");
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
}

function bytes(value: string | ArrayBufferLike | Blob | ArrayBufferView): Uint8Array {
  if (typeof value === "string" || value instanceof Blob) throw new Error("expected bytes");
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}

async function setup(config: Partial<ConstructorParameters<typeof WebSocketTransport>[0]> = {}) {
  FakeWebSocket.instances.length = 0;
  const local = await identityFromSecretKey(new Uint8Array(32).fill(0x22));
  const packets: ReceivedTransportPacket[] = [];
  const states: Array<{ state: string; reason?: string }> = [];
  const transport = new WebSocketTransport({
    seedUrls: ["wss://seed.example/fips"],
    webSocket: FakeWebSocket as unknown as typeof WebSocket,
    reconnectInitialMs: 10,
    reconnectMaxMs: 20,
    ...config,
  });
  const context: TransportContext = {
    localIdentity: local,
    onPacket: (packet) => packets.push(packet),
    onConnectionState: (event) => states.push({
      state: event.state,
      reason: event.reason,
    }),
  };
  await transport.start(context);
  return { context, local, packets, states, transport };
}

describe("local WebSocket key hint codec", () => {
  it("matches the native 9-byte request and 41-byte response wire", () => {
    const nonce = 0x0102030405060708n;
    const pubkey = new Uint8Array(32).map((_, index) => index);
    const request = encodeLocalKeyHintRequest(nonce);
    const response = encodeLocalKeyHintResponse(nonce, pubkey);

    expect(request).toHaveLength(LOCAL_KEY_HINT_REQUEST_BYTES);
    expect(toHex(request)).toBe("010102030405060708");
    expect(response).toHaveLength(LOCAL_KEY_HINT_RESPONSE_BYTES);
    expect(toHex(response)).toBe(`010102030405060708${toHex(pubkey)}`);
    expect(decodeLocalKeyHint(request)).toEqual({ kind: "request", nonce });
    expect(decodeLocalKeyHint(response)).toEqual({ kind: "response", nonce, pubkey });
    expect(decodeLocalKeyHint(response.subarray(0, 40))).toBeUndefined();
  });
});

describe("WebSocket physical record validation", () => {
  it("accepts adjacent direct-FSP records after FMP authenticates the link", () => {
    const record = encodeFspEstablished({
      flags: FSP_FLAG_DIRECT_TRANSPORT,
      counter: 0n,
      payloadLen: 1,
      ciphertext: new Uint8Array(17),
    });
    expect(() => validateFipsWebSocketRecord(record)).not.toThrow();
  });

  it("accepts bounded direct-FSP physical fragments", () => {
    const fragment = new Uint8Array(24);
    fragment.set(new TextEncoder().encode("DFP1"));
    const view = new DataView(fragment.buffer);
    view.setBigUint64(4, 7n, true);
    view.setUint32(12, 100, true);
    view.setUint16(16, 0, true);
    view.setUint16(18, 2, true);
    expect(() => validateFipsWebSocketRecord(fragment)).not.toThrow();
    view.setUint16(18, 1, true);
    expect(() => validateFipsWebSocketRecord(fragment)).toThrow("fragment header");
  });
});

describe("WebSocketTransport", () => {
  it("discovers a URL-only native seed and exchanges binary FIPS records", async () => {
    const nonce = 0x0102030405060708n;
    const remoteXOnly = new Uint8Array(32).fill(0x33);
    const { packets, transport } = await setup({ randomNonce: () => nonce });
    const iterator = transport.discover!()[Symbol.asyncIterator]();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    expect(bytes(socket.sent[0]!)).toEqual(encodeLocalKeyHintRequest(nonce));
    socket.receive(encodeLocalKeyHintResponse(nonce, remoteXOnly).buffer);

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        remoteAddr: { transport: "websocket", addr: "wss://seed.example/fips" },
        publicKey: remoteXOnly,
        meta: { source: "websocket-seed" },
      } satisfies DiscoveredPeer,
    });

    const addr = { transport: "websocket", addr: "wss://seed.example/fips" };
    await transport.connect(addr);
    const msg1 = new Uint8Array(114);
    msg1[0] = 0x01;
    msg1[2] = 110;
    await transport.send(addr, msg1);
    expect(bytes(socket.sent[1]!)).toEqual(msg1);

    const msg2 = new Uint8Array(69);
    msg2[0] = 0x02;
    msg2[2] = 65;
    socket.receive(msg2.buffer);
    await vi.waitFor(() => expect(packets).toHaveLength(1));
    expect(packets[0]).toMatchObject({
      transportType: "websocket",
      remoteAddr: addr,
      data: msg2,
    });
    await transport.stop();
  });

  it("responds to a native key-hint request without treating it as FIPS data", async () => {
    const { local, packets, transport } = await setup({ randomNonce: () => 7n });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive(encodeLocalKeyHintRequest(9n).buffer);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(bytes(socket.sent[1]!)).toEqual(
      encodeLocalKeyHintResponse(9n, local.xOnlyPubkey),
    );
    expect(packets).toEqual([]);
    await transport.stop();
  });

  it("bounds the outbound queue and advances it once browser backpressure clears", async () => {
    vi.useFakeTimers();
    const { transport } = await setup({
      randomNonce: () => 11n,
      maxSendQueue: 2,
      maxBufferedBytes: 128,
      sendPollMs: 5,
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive(encodeLocalKeyHintResponse(11n, new Uint8Array(32).fill(0x44)).buffer);
    const addr = { transport: "websocket", addr: socket.url };
    await transport.connect(addr);
    socket.bufferedAmount = 129;
    const record = new Uint8Array(69);
    record[0] = 0x02;
    record[2] = 65;
    const first = transport.send(addr, record);
    const second = transport.send(addr, record);
    await expect(transport.send(addr, record)).rejects.toThrow("send queue full");
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(5);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(socket.sent).toHaveLength(3);
    await transport.stop();
    vi.useRealTimers();
  });

  it("reconnects configured seeds after a closed connection", async () => {
    vi.useFakeTimers();
    const { transport } = await setup({ randomNonce: () => 12n });
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.receive(encodeLocalKeyHintResponse(12n, new Uint8Array(32).fill(0x55)).buffer);
    first.close(1006, "lost");
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await transport.stop();
    vi.useRealTimers();
  });

  it("rejects duplicate, insecure remote, and unbounded configurations", () => {
    const fake = FakeWebSocket as unknown as typeof WebSocket;
    expect(() => new WebSocketTransport({
      seedUrls: ["wss://seed.example/fips", "wss://seed.example/fips"],
      webSocket: fake,
    })).toThrow("duplicate seed URL");
    expect(() => new WebSocketTransport({
      seedUrls: ["ws://seed.example/fips"],
      webSocket: fake,
    })).toThrow("plaintext WebSocket");
    expect(() => new WebSocketTransport({
      seedUrls: ["wss://seed.example/fips"],
      maxSendQueue: 4097,
      webSocket: fake,
    })).toThrow("maxSendQueue");
  });
});
