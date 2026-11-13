import { type FipsIdentity } from "../identity/index.js";
import { type NodeAddr } from "../nodeaddr/index.js";
import { type SessionDatagram } from "../protocol/link.js";
import type { Logger, Transport, TransportAddress } from "../transport/types.js";
import type { AdjacentPeer } from "./PeerState.js";
type OutboundSessionDatagram = Omit<SessionDatagram, "payload"> & {
    payload: Uint8Array | ((nextHop: AdjacentPeer) => Uint8Array[]);
};
interface FipsRoutingConfig {
    identity: FipsIdentity;
    forwarding: boolean;
    strictClient?: boolean;
    assertNodeAllowed?: (nodeAddr: NodeAddr) => void;
    routingMode: "tree" | "reply_learned";
    defaultRoute?: string;
    transports: Transport[];
    logger: Logger;
    randomBytes: (length: number) => Uint8Array;
    getPeers: () => Iterable<AdjacentPeer>;
    getPeerByPubkey: (pubkeyHex: string) => AdjacentPeer | undefined;
    getPeerByNodeAddr: (nodeAddrHex: string) => AdjacentPeer | undefined;
    sendLinkMessage: (peer: AdjacentPeer, msgType: number, payload: Uint8Array) => Promise<void>;
    connectKnownPeer: (transport: Transport, remoteAddr: TransportAddress, remotePubkey: Uint8Array) => Promise<void>;
    handleLocalSession: (peer: AdjacentPeer, srcNodeAddr: NodeAddr, payload: Uint8Array) => Promise<void>;
    emitError: (error: Error, where: string) => void;
    isStarted: () => boolean;
}
export declare class FipsRouting {
    private readonly cfg;
    private readonly treeState;
    private readonly pendingRouteResolutions;
    private readonly lookupReversePaths;
    private readonly originLookups;
    private readonly learnedRoutes;
    private readonly coordCache;
    private readonly lookupBackoff;
    private readonly lookupForwardLimiter;
    private readonly deferredLookupForwards;
    private readonly bloomRouting;
    private clientSequence;
    constructor(cfg: FipsRoutingConfig);
    get coords(): NodeAddr[];
    coordinatesFor(nodeAddrHex: string): NodeAddr[] | undefined;
    /** Whether a currently usable carrier can still route to this identity. */
    hasUsableRoute(nodeAddrHex: string): boolean;
    stop(): void;
    removePeer(peerNodeAddr: NodeAddr): void;
    handleLinkMessage(peer: AdjacentPeer, msgType: number, payload: Uint8Array): Promise<void>;
    sendTreeAnnounce(peer: AdjacentPeer, allowLegacyProbe?: boolean): Promise<void>;
    private handleClientRole;
    scheduleTreeAnnounce(peer: AdjacentPeer): void;
    /** Topology changed (new authenticated peer or tree coordinates): unreachable targets may now resolve. */
    resetLookupBackoff(): void;
    /** An authenticated session proves this node reachable; drop its lookup backoff. */
    noteSessionEstablished(nodeAddrHex: string): void;
    /** Reuse the authenticated heartbeat cadence for bounded capability retries. */
    refreshClientRole(): Promise<void>;
    replayPendingLookupsFor(peer: AdjacentPeer): Promise<void>;
    ensureFirstContactRoute(target: NodeAddr, targetHex: string, targetPubkey: Uint8Array): Promise<void>;
    /** Post-failure suppression keeps an offline target from triggering a fresh network-wide lookup. */
    private assertLookupAllowed;
    private refreshTransitRoute;
    sendFspToward(remoteNodeAddr: NodeAddr, fspFrame: OutboundSessionDatagram["payload"]): Promise<void>;
    sendFspReplyToward(remoteNodeAddr: NodeAddr, fspFrame: Uint8Array, previousHop: AdjacentPeer): Promise<void>;
    private sendSessionDatagramVia;
    learnReverseRoute(destinationNodeHex: string, nextHop: AdjacentPeer, pathMtu?: number): void;
    private sendTreeAnnounceToAll;
    private handleTreeAnnounce;
    private cacheSessionCoordinates;
    private cacheCoordinates;
    private handleLookupRequest;
    private sendLookupToNextHops;
    private lookupFallbackPeers;
    /** Hold one rate-limited request per target until that target's next forwarding slot. */
    private deferLookupForward;
    private resolveAndForwardLookup;
    private canResolveLookupDirectly;
    private forwardLookupResponse;
    private handleOriginLookupResponse;
    private originLookupPeers;
    private retryOriginLookup;
    private sendSessionDatagram;
    private pathMtuFor;
    private nextHopFor;
    private pruneLookupReversePaths;
    private reserveLookupReversePath;
    private resolveRoute;
    private resolveAndConnectRoute;
    /** Resolve only the identity: FSP signaling can be needed before its carrier exists. */
    resolveIdentity(nodeAddr: NodeAddr, abort: AbortController): Promise<Uint8Array>;
}
export {};
//# sourceMappingURL=FipsRouting.d.ts.map