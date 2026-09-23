import type { Logger } from "@fips/core";
import type { NostrRelayClient } from "./NostrRelayClient.js";
export declare const DEFAULT_STUN_SERVERS: readonly string[];
export declare const DEFAULT_ICE_GATHER_TIMEOUT_MS = 2000;
export interface WebRtcTransportConfig {
    /** Optional Nostr relays for bounded signed WebRTC peer announcements. */
    relays?: string[];
    relayClients?: NostrRelayClient[];
    /** Defaults to DEFAULT_STUN_SERVERS; [] gathers host candidates only. */
    stunServers?: string[];
    advertiseOnNostr?: boolean;
    acceptConnections?: boolean;
    /** Optional application/WoT admission check for unsolicited inbound offers. */
    allowIncomingPeer?: (remotePubkeyHex: string) => boolean | Promise<boolean>;
    autoConnect?: boolean;
    discoveryApp?: string;
    advertTtlMs?: number;
    mtu?: number;
    maxConnections?: number;
    maxAutoConnections?: number;
    preferredAutoConnectPeers?: string[];
    connectTimeoutMs?: number;
    relayConnectTimeoutMs?: number;
    /** Maximum gathering wait; defaults to DEFAULT_ICE_GATHER_TIMEOUT_MS (2s). */
    iceGatherTimeoutMs?: number;
    dataChannelLabel?: string;
    ordered?: boolean;
    maxRetransmits?: number | null;
    webSocket?: typeof WebSocket;
    rtcPeerConnection?: typeof RTCPeerConnection;
    debug?: boolean;
    logger?: Logger;
}
//# sourceMappingURL=WebRtcTransportConfig.d.ts.map