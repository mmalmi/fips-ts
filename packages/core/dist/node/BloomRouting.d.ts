import type { FipsIdentity } from "../identity/index.js";
import type { NodeAddr } from "../nodeaddr/index.js";
import { type Logger } from "../transport/types.js";
import { type AdjacentPeer } from "./PeerState.js";
interface BloomRoutingConfig {
    identity: FipsIdentity;
    forwarding: boolean;
    strictClient?: boolean;
    logger: Logger;
    getPeers: () => Iterable<AdjacentPeer>;
    isTreePeer: (nodeAddr: NodeAddr, nodeHex?: string) => boolean;
    sendLinkMessage: (peer: AdjacentPeer, msgType: number, payload: Uint8Array) => Promise<void>;
    emitError: (error: Error, where: string) => void;
}
export declare class BloomRouting {
    private readonly cfg;
    private sequence;
    private readonly debugEnabled;
    private readonly selfFilter;
    private pendingBroadcast?;
    private peerDebounce;
    private readonly deferredPeers;
    private flushTimer?;
    private flushDueMs;
    constructor(cfg: BloomRoutingConfig);
    stop(): void;
    schedule(peer: AdjacentPeer): void;
    sendAll(excludedPeer?: AdjacentPeer): Promise<void>;
    handle(peer: AdjacentPeer, payload: Uint8Array): Promise<void>;
    private shouldAnnounceTo;
    private dispatchPeers;
    private nextAllowedMs;
    private recordSend;
    private scheduleFlush;
    private flushDeferred;
    private send;
    private collectFilterSources;
    private buildFilter;
}
export {};
//# sourceMappingURL=BloomRouting.d.ts.map