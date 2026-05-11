import {
  toHex,
  transportAddressKey,
  type Transport,
  type TransportAddress,
  type TransportContext,
} from "@fips/core";

/**
 * In-process hub that wires MemoryTransports together. All transports
 * sharing the same hub can reach each other by pubkey hex.
 */
export class MemoryHub {
  private byPubkey = new Map<string, MemoryTransport>();

  register(pubkeyHex: string, t: MemoryTransport): void {
    this.byPubkey.set(pubkeyHex, t);
  }

  unregister(pubkeyHex: string): void {
    this.byPubkey.delete(pubkeyHex);
  }

  resolve(pubkeyHex: string): MemoryTransport | undefined {
    return this.byPubkey.get(pubkeyHex);
  }
}

export interface MemoryTransportConfig {
  hub: MemoryHub;
  mtu?: number;
  /** Drop/loss probability for chaos tests. */
  lossProbability?: number;
  random?: () => number;
}

export class MemoryTransport implements Transport {
  readonly type = "memory";
  readonly mtu: number;
  private ctx?: TransportContext;
  private pubkeyHex = "";
  private readonly hub: MemoryHub;
  private readonly loss: number;
  private readonly rand: () => number;
  private connected = new Set<string>();

  constructor(cfg: MemoryTransportConfig) {
    this.hub = cfg.hub;
    this.mtu = cfg.mtu ?? 65535;
    this.loss = cfg.lossProbability ?? 0;
    this.rand = cfg.random ?? Math.random;
  }

  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
    this.pubkeyHex = toHex(ctx.localIdentity.publicKey);
    this.hub.register(this.pubkeyHex, this);
  }

  async stop(): Promise<void> {
    if (this.ctx) this.hub.unregister(this.pubkeyHex);
    for (const key of [...this.connected]) {
      this.ctx?.onConnectionState?.({
        remoteAddr: parseKey(key),
        state: "disconnected",
      });
    }
    this.connected.clear();
    this.ctx = undefined;
  }

  async connect(addr: TransportAddress): Promise<void> {
    const remote = this.hub.resolve(addr.addr);
    if (!remote) throw new Error(`no memory peer for ${addr.addr}`);
    const key = transportAddressKey(addr);
    this.connected.add(key);
    this.ctx?.onConnectionState?.({ remoteAddr: addr, state: "connected" });
    // Tell the remote we're now reachable too — so it can route packets back.
    const ourAddr: TransportAddress = { transport: "memory", addr: this.pubkeyHex };
    remote.connected.add(transportAddressKey(ourAddr));
    remote.ctx?.onConnectionState?.({ remoteAddr: ourAddr, state: "connected" });
  }

  async send(addr: TransportAddress, packet: Uint8Array): Promise<void> {
    if (this.loss > 0 && this.rand() < this.loss) return;
    const remote = this.hub.resolve(addr.addr);
    if (!remote || !remote.ctx) throw new Error(`memory peer offline: ${addr.addr}`);
    const fromAddr: TransportAddress = { transport: "memory", addr: this.pubkeyHex };
    // Deliver asynchronously so callers don't see synchronous reentrancy.
    queueMicrotask(() => {
      remote.ctx?.onPacket({
        transportType: "memory",
        remoteAddr: fromAddr,
        data: new Uint8Array(packet),
        receivedAtMs: Date.now(),
      });
    });
  }

  async close(addr: TransportAddress): Promise<void> {
    const key = transportAddressKey(addr);
    if (this.connected.delete(key)) {
      this.ctx?.onConnectionState?.({ remoteAddr: addr, state: "disconnected" });
    }
  }
}

function parseKey(key: string): TransportAddress {
  const i = key.indexOf(":");
  return { transport: key.slice(0, i), addr: key.slice(i + 1) };
}
