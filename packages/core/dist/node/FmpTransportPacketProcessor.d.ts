import type { FipsIdentity } from "../identity/index.js";
import { type Logger, type ReceivedTransportPacket, type Transport } from "../transport/types.js";
import type { FipsRouting } from "./FipsRouting.js";
import type { FspSessionManager } from "./FspSessionManager.js";
import type { AdjacentPeer } from "./PeerState.js";
import type { PeerEvent } from "./types.js";
export declare function nextSessionIdx(): number;
interface FmpTransportPacketProcessorConfig {
    identity: FipsIdentity;
    startupEpoch: Uint8Array;
    randomBytes: (length: number) => Uint8Array;
    logger: Logger;
    peers: Map<string, AdjacentPeer>;
    peersByPubkey: Map<string, AdjacentPeer>;
    peersByNodeAddr: Map<string, AdjacentPeer>;
    routing: FipsRouting;
    sessionManager: FspSessionManager;
    emitError: (error: Error, where: string) => void;
    emitPeer: (event: PeerEvent) => void;
}
export declare class FmpTransportPacketProcessor {
    private readonly cfg;
    private readonly reassembler;
    constructor(cfg: FmpTransportPacketProcessorConfig);
    clear(): void;
    process(transport: Transport, received: ReceivedTransportPacket): void;
    private handleMsg1;
    private prepareMsg1Peer;
    private handleMsg2;
    private handleEstablished;
    private newResponderLink;
    private rememberPeer;
    private findXOnlyTransportPeer;
    private establishedRemoteEpoch;
    private removeRestartedPeerPaths;
    private stageResponderReplacement;
    private pruneDrainingResponderLinks;
}
export {};
//# sourceMappingURL=FmpTransportPacketProcessor.d.ts.map