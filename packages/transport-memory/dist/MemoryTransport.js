import { toHex, transportAddressKey, } from "@fips/core";
/**
 * In-process hub that wires MemoryTransports together. All transports
 * sharing the same hub can reach each other by pubkey hex.
 */
export class MemoryHub {
    byPubkey = new Map();
    register(pubkeyHex, t) {
        this.byPubkey.set(pubkeyHex, t);
    }
    unregister(pubkeyHex) {
        this.byPubkey.delete(pubkeyHex);
    }
    resolve(pubkeyHex) {
        return this.byPubkey.get(pubkeyHex);
    }
}
export class MemoryTransport {
    type = "memory";
    mtu;
    ctx;
    pubkeyHex = "";
    hub;
    loss;
    rand;
    connected = new Set();
    constructor(cfg) {
        this.hub = cfg.hub;
        this.mtu = cfg.mtu ?? 65535;
        this.loss = cfg.lossProbability ?? 0;
        this.rand = cfg.random ?? Math.random;
    }
    async start(ctx) {
        this.ctx = ctx;
        this.pubkeyHex = toHex(ctx.localIdentity.publicKey);
        this.hub.register(this.pubkeyHex, this);
    }
    async stop() {
        if (this.ctx)
            this.hub.unregister(this.pubkeyHex);
        for (const key of [...this.connected]) {
            this.ctx?.onConnectionState?.({
                remoteAddr: parseKey(key),
                state: "disconnected",
            });
        }
        this.connected.clear();
        this.ctx = undefined;
    }
    async connect(addr) {
        const remote = this.hub.resolve(addr.addr);
        if (!remote)
            throw new Error(`no memory peer for ${addr.addr}`);
        const key = transportAddressKey(addr);
        this.connected.add(key);
        this.ctx?.onConnectionState?.({ remoteAddr: addr, state: "connected" });
        // Tell the remote we're now reachable too — so it can route packets back.
        const ourAddr = { transport: "memory", addr: this.pubkeyHex };
        remote.connected.add(transportAddressKey(ourAddr));
        remote.ctx?.onConnectionState?.({ remoteAddr: ourAddr, state: "connected" });
    }
    async send(addr, packet) {
        if (this.loss > 0 && this.rand() < this.loss)
            return;
        const remote = this.hub.resolve(addr.addr);
        if (!remote || !remote.ctx)
            throw new Error(`memory peer offline: ${addr.addr}`);
        const fromAddr = { transport: "memory", addr: this.pubkeyHex };
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
    async close(addr) {
        const key = transportAddressKey(addr);
        if (this.connected.delete(key)) {
            this.ctx?.onConnectionState?.({ remoteAddr: addr, state: "disconnected" });
        }
    }
}
function parseKey(key) {
    const i = key.indexOf(":");
    return { transport: key.slice(0, i), addr: key.slice(i + 1) };
}
//# sourceMappingURL=MemoryTransport.js.map