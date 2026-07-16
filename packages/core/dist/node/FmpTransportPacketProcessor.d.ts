import type { FipsIdentity } from "../identity/index.js";
import { type Logger, type ReceivedTransportPacket, type Transport } from "../transport/types.js";
import type { FipsRouting } from "./FipsRouting.js";
import type { FspSessionManager } from "./FspSessionManager.js";
import type { AdjacentPeer } from "./PeerState.js";
import type { PeerEvent } from "./types.js";
interface FmpTransportPacketProcessorConfig {
    identity: FipsIdentity;
    startupEpoch: Uint8Array;
    nextSessionIdx: () => number;
    randomBytes: (length: number) => Uint8Array;
    logger: Logger;
    peers: Map<string, AdjacentPeer>;
    peersByPubkey: Map<string, AdjacentPeer>;
    peersByNodeAddr: Map<string, AdjacentPeer>;
    routing: FipsRouting;
    sessionManager: FspSessionManager;
    emitError: (error: Error, where: string) => void;
    emitPeer: (event: PeerEvent) => void;
    handlePeerRestart: (remotePubkeyHex: string, preserveTransport: Transport) => void;
}
export declare class FmpTransportPacketProcessor {
    private readonly cfg;
    private readonly reassembler;
    private readonly remoteEpochHistory;
    constructor(cfg: FmpTransportPacketProcessorConfig);
    clear(): void;
    process(transport: Transport, received: ReceivedTransportPacket): void;
    private handleMsg1;
    private prepareMsg1Peer;
    private rejectRetiredEpoch;
    private handleMsg2;
    private matchMsg2Peer;
    private retireDisplacedMsg2Peer;
    private drainAuthenticatedLink;
    private handleEstablished;
    private matchEstablishedLink;
    private newResponderLink;
    private rememberPeer;
    private rememberRemoteEpoch;
    private isRetiredRemoteEpoch;
    private rejectRetiredMsg2Peer;
    private findXOnlyTransportPeer;
    private establishedRemoteEpoch;
    private removeRestartedPeerPaths;
    private stageResponderReplacement;
    private pruneDrainingResponderLinks;
}
export {};
//# sourceMappingURL=FmpTransportPacketProcessor.d.ts.map