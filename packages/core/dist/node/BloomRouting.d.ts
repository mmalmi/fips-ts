import type { FipsIdentity } from "../identity/index.js";
import { type NodeAddr } from "../nodeaddr/index.js";
import type { Logger } from "../transport/types.js";
import type { AdjacentPeer } from "./PeerState.js";
interface BloomRoutingConfig {
    identity: FipsIdentity;
    logger: Logger;
    getPeers: () => Iterable<AdjacentPeer>;
    isTreePeer: (nodeAddr: NodeAddr) => boolean;
    sendLinkMessage: (peer: AdjacentPeer, msgType: number, payload: Uint8Array) => Promise<void>;
    emitError: (error: Error, where: string) => void;
}
export declare class BloomRouting {
    private readonly cfg;
    private sequence;
    constructor(cfg: BloomRoutingConfig);
    schedule(peer: AdjacentPeer): void;
    sendAll(excludedPeer?: AdjacentPeer): Promise<void>;
    handle(peer: AdjacentPeer, payload: Uint8Array): Promise<void>;
    private send;
    private outgoingFilterFor;
}
export {};
//# sourceMappingURL=BloomRouting.d.ts.map