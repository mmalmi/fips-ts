import { type LinkNegotiationMessage } from "../linkNegotiation.js";
import type { FipsIdentity } from "../identity/index.js";
import { type NodeAddr } from "../nodeaddr/index.js";
import type { Logger } from "../transport/types.js";
import type { DatagramEvent, EndpointDataEvent, FipsServiceHandler, RandomSource, SessionEvent } from "./types.js";
import type { FipsRouting } from "./FipsRouting.js";
import type { AdjacentPeer } from "./PeerState.js";
interface FspSessionManagerConfig {
    identity: FipsIdentity;
    random: RandomSource;
    localEpoch: Uint8Array;
    logger: Logger;
    routing: FipsRouting;
    getPeerByNodeAddr: (nodeAddrHex: string) => AdjacentPeer | undefined;
    emitDatagram: (event: DatagramEvent) => void;
    emitEndpointData: (event: EndpointDataEvent) => void;
    handleLinkNegotiation: (remotePubkeyHex: string, message: LinkNegotiationMessage) => Promise<void>;
    emitSession: (event: SessionEvent) => void;
}
export declare class FspSessionManager {
    private readonly cfg;
    private readonly services;
    private readonly sessions;
    private readonly localEpoch;
    constructor(cfg: FspSessionManagerConfig);
    registerService(port: number, handler: FipsServiceHandler): () => void;
    stop(): void;
    closePeerSessions(remotePubkeyHex: string): void;
    sendDatagram(args: {
        dst: string;
        srcPort?: number;
        dstPort: number;
        payload: Uint8Array;
    }): Promise<void>;
    sendEndpointData(args: {
        dst: string;
        payload: Uint8Array;
    }): Promise<void>;
    sendLinkNegotiation(remotePubkeyHex: string, message: LinkNegotiationMessage): Promise<void>;
    handleFromPeer(peer: AdjacentPeer, srcNodeAddr: NodeAddr, fspFrame: Uint8Array): Promise<void>;
    private handleEstablished;
    private promotePendingSession;
    private deliverDatagram;
    private handleSessionSetup;
    private handleSessionMsg3;
    private queueEarlyEstablishedRecord;
    private drainEarlyEstablishedRecords;
    private replaceRestartedSession;
    private ensureSession;
    private waitForSessionSetup;
    private resolveSessionSetup;
    private rejectSessionSetup;
    private prunePreviousFsp;
    private directPeerForSession;
    private sendDirectFsp;
}
export {};
//# sourceMappingURL=FspSessionManager.d.ts.map