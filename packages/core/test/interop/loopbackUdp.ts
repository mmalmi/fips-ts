import { createSocket, type Socket } from "node:dgram";
import { once } from "node:events";
import type { Transport, TransportAddress, TransportContext } from "../../src/index.js";

/** Test carrier: accepts packets only from the specified loopback native peer. */
export class LoopbackUdp implements Transport {
  readonly type = "udp-fixture";
  readonly mtu = 1400;
  readonly packets = { sent: 0, received: 0, ignored: 0 };
  private socket?: Socket;
  constructor(readonly key: string, readonly port: number) {}
  async start(context: TransportContext) {
    const socket = createSocket("udp4");
    this.socket = socket;
    socket.on("message", (data, remote) => {
      if (this.socket !== socket || remote.address !== "127.0.0.1" || remote.port !== this.port) { this.packets.ignored++; return; }
      this.packets.received++;
      context.onPacket({ transportType: this.type, remoteAddr: { transport: this.type, addr: this.key },
        data: new Uint8Array(data), receivedAtMs: Date.now() });
    });
    socket.bind(0, "127.0.0.1");
    await once(socket, "listening");
  }
  async stop() {
    const socket = this.socket;
    this.socket = undefined;
    if (socket) await new Promise<void>(resolve => socket.close(() => resolve()));
  }
  async connect(address: TransportAddress) {
    if (address.addr !== this.key || !this.socket) throw new Error("unknown fixture peer");
  }
  async send(address: TransportAddress, packet: Uint8Array) {
    await this.connect(address);
    this.packets.sent++;
    await new Promise<void>((resolve, reject) => this.socket!.send(packet, this.port, "127.0.0.1",
      error => error ? reject(error) : resolve()));
  }
}
