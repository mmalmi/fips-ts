import type { AddressInfo } from "node:net";

import {
  FipsNode,
  generateIdentity,
  type Transport,
  type TransportAddress,
  type TransportContext,
} from "@fips/core";
import {
  decodeLocalKeyHint,
  encodeLocalKeyHintResponse,
  validateFipsWebSocketRecord,
} from "@fips/transport-websocket";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";

const MAX_FRAME_BYTES = 66 * 1024;
const MAX_CONNECTIONS = 64;

export interface LocalFipsWebSocketSeed {
  url: string;
  connectionCount(): number;
  close(): Promise<void>;
}

class InboundWebSocketTransport implements Transport {
  readonly type = "websocket";
  readonly mtu = 1400;

  private ctx?: TransportContext;
  private server?: WebSocketServer;
  private readonly sockets = new Map<string, WsSocket>();
  private nextConnection = 0;
  private boundUrl?: string;

  get url(): string {
    if (!this.boundUrl) throw new Error("WebSocket seed has not started");
    return this.boundUrl;
  }

  connectionCount(): number {
    return this.sockets.size;
  }

  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path: "/fips",
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;
    this.boundUrl = `ws://127.0.0.1:${port}/fips`;
    server.on("connection", (socket) => this.accept(socket));
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.boundUrl = undefined;
    for (const socket of this.sockets.values()) socket.terminate();
    this.sockets.clear();
    this.ctx = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  async connect(addr: TransportAddress): Promise<void> {
    if (addr.transport !== this.type || !this.sockets.has(addr.addr)) {
      throw new Error("unknown WebSocket client");
    }
  }

  async send(addr: TransportAddress, packet: Uint8Array): Promise<void> {
    validateFipsWebSocketRecord(packet, MAX_FRAME_BYTES);
    const socket = this.sockets.get(addr.addr);
    if (!socket || socket.readyState !== socket.OPEN) throw new Error("WebSocket client closed");
    if (socket.bufferedAmount + packet.length > MAX_FRAME_BYTES * 16) {
      throw new Error("WebSocket seed backpressure limit");
    }
    socket.send(packet);
  }

  private accept(socket: WsSocket): void {
    if (!this.ctx || this.sockets.size >= MAX_CONNECTIONS) {
      socket.close(1013, "connection limit");
      return;
    }
    const addr: TransportAddress = {
      transport: this.type,
      addr: `ws-peer://${++this.nextConnection}`,
    };
    this.sockets.set(addr.addr, socket);
    socket.on("message", (raw, isBinary) => {
      if (!isBinary || !this.ctx) {
        socket.close(1003, "binary FIPS records only");
        return;
      }
      const wire = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const hint = decodeLocalKeyHint(wire);
      if (hint?.kind === "request") {
        socket.send(encodeLocalKeyHintResponse(
          hint.nonce,
          this.ctx.localIdentity.xOnlyPubkey,
        ));
        return;
      }
      if (hint) return;
      try {
        validateFipsWebSocketRecord(wire, MAX_FRAME_BYTES);
      } catch {
        socket.close(1002, "invalid FIPS record");
        return;
      }
      this.ctx.onPacket({
        transportType: this.type,
        remoteAddr: addr,
        data: new Uint8Array(wire),
        receivedAtMs: Date.now(),
      });
    });
    socket.on("close", () => {
      if (!this.sockets.delete(addr.addr)) return;
      this.ctx?.onConnectionState?.({ remoteAddr: addr, state: "disconnected" });
    });
  }
}

export async function startLocalFipsWebSocketSeed(): Promise<LocalFipsWebSocketSeed> {
  const identity = await generateIdentity();
  const transport = new InboundWebSocketTransport();
  const node = new FipsNode({
    identity,
    transports: [transport],
    forwarding: true,
    routingMode: "reply_learned",
  });
  await node.start();
  return {
    url: transport.url,
    connectionCount: () => transport.connectionCount(),
    close: () => node.stop(),
  };
}
