import { type Transport, type TransportAddress, type TransportContext } from "@fips/core";
/**
 * In-process hub that wires MemoryTransports together. All transports
 * sharing the same hub can reach each other by pubkey hex.
 */
export declare class MemoryHub {
    private byPubkey;
    register(pubkeyHex: string, t: MemoryTransport): void;
    unregister(pubkeyHex: string): void;
    resolve(pubkeyHex: string): MemoryTransport | undefined;
}
export interface MemoryTransportConfig {
    hub: MemoryHub;
    mtu?: number;
    /** Drop/loss probability for chaos tests. */
    lossProbability?: number;
    random?: () => number;
}
export declare class MemoryTransport implements Transport {
    readonly type = "memory";
    readonly mtu: number;
    private ctx?;
    private pubkeyHex;
    private readonly hub;
    private readonly loss;
    private readonly rand;
    private connected;
    constructor(cfg: MemoryTransportConfig);
    start(ctx: TransportContext): Promise<void>;
    stop(): Promise<void>;
    connect(addr: TransportAddress): Promise<void>;
    send(addr: TransportAddress, packet: Uint8Array): Promise<void>;
    close(addr: TransportAddress): Promise<void>;
}
//# sourceMappingURL=MemoryTransport.d.ts.map