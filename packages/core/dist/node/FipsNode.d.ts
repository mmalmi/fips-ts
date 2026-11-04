import type { FipsIdentity } from "../identity/index.js";
import { type TransportAddress } from "../transport/types.js";
import type { FipsEventName, FipsNodeConfig, FipsServiceHandler } from "./types.js";
export declare class FipsNode {
    readonly identity: FipsIdentity;
    readonly forwarding: boolean;
    private readonly routingMode;
    private readonly transports;
    private readonly random;
    private readonly startupEpoch;
    private nextFmpSessionIdx;
    private readonly logger;
    private readonly defaultRoute?;
    private readonly heartbeatIntervalMs;
    private peers;
    private peersByPubkey;
    private peersByNodeAddr;
    private pendingPeerConnects;
    private listeners;
    private discoveryTasks;
    private discoveryConnectTasks;
    private discoveryGeneration;
    private heartbeatTimer?;
    private readonly routing;
    private readonly sessionManager;
    private readonly packetProcessor;
    private started;
    private desiredRunning;
    private hasStarted;
    private needsTransportCleanup;
    private admission;
    private admissionUpdating;
    private admissionUpdate;
    private startTask?;
    private stopTask?;
    private readonly pendingSends;
    constructor(cfg: FipsNodeConfig);
    start(): Promise<void>;
    private startNode;
    private startTransports;
    stop(): Promise<void>;
    private stopNode;
    private stopTransports;
    /**
     * Revoke immediately, then drain/reset the reader's connections before acknowledging.
     * Service registrations/listeners survive; identical sets do not reset anything.
     * stop() during the reset prevents restart. A failed closure rejects the barrier.
     */
    setBlockedPeerPubkeys(keys: readonly string[]): Promise<void>;
    private trackSend;
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
    private allocateFmpSessionIdx;
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
    private removePeerPath;
    private sendLinkMessage;
    private sendHeartbeats;
}
//# sourceMappingURL=FipsNode.d.ts.map