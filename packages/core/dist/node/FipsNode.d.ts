import { type FipsIdentity } from "../identity/index.js";
import { type TransportAddress } from "../transport/types.js";
import type { FipsEventName, FipsNodeConfig, FipsServiceHandler } from "./types.js";
export declare class FipsNode {
    readonly identity: FipsIdentity;
    readonly forwarding: boolean;
    private readonly transports;
    private readonly random;
    private readonly logger;
    private readonly defaultRoute?;
    private services;
    private peers;
    private peersByPubkey;
    private peersByNodeAddr;
    private pendingPeerConnects;
    private pendingRouteResolutions;
    private lookupReversePaths;
    private sessions;
    private listeners;
    private discoveryTasks;
    private discoveryConnectTasks;
    private discoveryGeneration;
    private heartbeatTimer?;
    private readonly directFspReassembler;
    private started;
    constructor(cfg: FipsNodeConfig);
    start(): Promise<void>;
    stop(): Promise<void>;
    private consumeDiscovery;
    private connectDiscoveredPeer;
    registerService(port: number, handler: FipsServiceHandler): () => void;
    /**
     * Connect to an adjacent peer over a chosen transport. The address's `addr`
     * must be the remote node's 33-byte compressed pubkey in hex.
     */
    connect(addr: TransportAddress): Promise<void>;
    private connectKnownPeer;
    private connectAdjacentPeer;
    /** Send a service datagram to a target identity (adjacent or routable). */
    sendDatagram(args: {
        dst: string;
        srcPort?: number;
        dstPort: number;
        payload: Uint8Array;
    }): Promise<void>;
    /** Send app-owned endpoint bytes to a target identity without service ports. */
    sendEndpointData(args: {
        dst: string;
        payload: Uint8Array;
    }): Promise<void>;
    on(event: FipsEventName, cb: (data: unknown) => void): () => void;
    private emit;
    private onTransportConn;
    private rememberPeer;
    private onTransportPacket;
    private routeIncomingLinkMessage;
    private forwardLookupRequest;
    private forwardLookupResponse;
    private sendLinkMessage;
    private pruneLookupReversePaths;
    private reserveLookupReversePath;
    private sendHeartbeats;
    private handleFspFromPeer;
    private ensureSession;
    /**
     * Wrap an FSP frame in a SessionDatagram and send it toward a remote NodeAddr.
     */
    private sendFspToward;
    private directPeerForSession;
    private sendDirectFsp;
    private sendSessionDatagram;
    private nextHopFor;
    private resolveRoute;
    private resolveAndConnectRoute;
}
//# sourceMappingURL=FipsNode.d.ts.map