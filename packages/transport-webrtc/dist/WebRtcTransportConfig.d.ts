import type { Logger } from "@fips/core";
import type { NostrRelayClient } from "./NostrRelayClient.js";
export interface WebRtcTransportConfig {
    /** Optional Nostr relays for bounded signed WebRTC peer announcements. */
    relays?: string[];
    relayClients?: NostrRelayClient[];
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