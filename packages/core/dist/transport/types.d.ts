import type { FipsIdentity } from "../identity/index.js";
import type { NodeAddr } from "../nodeaddr/index.js";
/**
 * Transport address — identifies an adjacent peer at the transport layer.
 *
 * For WebRTC, `addr` is the remote pubkey hex (NOT a session id or relay
 * URL). For memory transport it's also a pubkey hex.
 */
export interface TransportAddress {
    transport: string;
    addr: string;
}
export declare function transportAddressKey(a: TransportAddress): string;
export interface ReceivedTransportPacket {
    transportType: string;
    remoteAddr: TransportAddress;
    data: Uint8Array;
    receivedAtMs: number;
}
export interface TransportConnectionStateEvent {
    remoteAddr: TransportAddress;
    state: "connecting" | "connected" | "disconnected" | "failed";
    reason?: string;
}
export interface DiscoveredPeer {
    remoteAddr: TransportAddress;
    /** Remote FIPS identity hint. Ethernet beacons may provide the 32-byte x-only form. */
    publicKey?: Uint8Array;
    meta?: Record<string, unknown>;
}
export interface TransportContext {
    localIdentity: FipsIdentity;
    onPacket(packet: ReceivedTransportPacket): void;
    onConnectionState?: (event: TransportConnectionStateEvent) => void;
    logger?: Logger;
}
export interface Transport {
    readonly type: string;
    readonly mtu: number;
    start(ctx: TransportContext): Promise<void>;
    stop(): Promise<void>;
    connect(addr: TransportAddress): Promise<void>;
    send(addr: TransportAddress, packet: Uint8Array): Promise<void>;
    close?(addr: TransportAddress): Promise<void>;
    discover?(): AsyncIterable<DiscoveredPeer>;
    /** Resolve a FIPS NodeAddr to an authenticated transport identity hint. */
    resolve?(nodeAddr: NodeAddr, signal?: AbortSignal): Promise<DiscoveredPeer | undefined>;
}
export interface Logger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
export declare const noopLogger: Logger;
//# sourceMappingURL=types.d.ts.map