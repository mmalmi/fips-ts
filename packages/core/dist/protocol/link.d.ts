/**
 * FMP link-layer message-type registry + small wire codecs.
 *
 * Mirrors Rust ~/src/fips/crates/fips-core/src/protocol/link.rs. This is the
 * msg_type byte that appears at the head of the FMP inner-plaintext payload
 * (after AEAD decrypt), distinguishing forwarded session datagrams from
 * link-control messages.
 */
export declare const HandshakeMessageType: {
    readonly NoiseIKMsg1: 1;
    readonly NoiseIKMsg2: 2;
};
export declare function handshakeMessageTypeFromByte(b: number): number | undefined;
export declare function isHandshakeMessageType(b: number): boolean;
export declare const LinkMessageType: {
    readonly SessionDatagram: 0;
    readonly SenderReport: 1;
    readonly ReceiverReport: 2;
    readonly TreeAnnounce: 16;
    readonly FilterAnnounce: 32;
    readonly LookupRequest: 48;
    readonly LookupResponse: 49;
    readonly Disconnect: 80;
    readonly Heartbeat: 81;
};
export declare function linkMessageTypeFromByte(b: number): number | undefined;
export declare const DisconnectReason: {
    readonly Shutdown: 0;
    readonly Restart: 1;
    readonly ProtocolError: 2;
    readonly TransportFailure: 3;
    readonly ResourceExhaustion: 4;
    readonly SecurityViolation: 5;
    readonly Other: 255;
};
/** Returns a known reason byte or `Other` (0xff) for unknown bytes — matches Rust. */
export declare function disconnectReasonFromByte(b: number): number;
export interface Disconnect {
    reason: number;
}
/** Encode a Disconnect message as the 2-byte link payload `[type=0x50][reason]`. */
export declare function encodeDisconnect(d: Disconnect): Uint8Array;
/**
 * Decode the *payload after the msg_type byte* (matching Rust's
 * `Disconnect::decode`).
 */
export declare function decodeDisconnect(payload: Uint8Array): Disconnect;
/**
 * SessionDatagram — link-layer forwarding envelope.
 *
 * Wire format (36-byte fixed header + payload):
 *   [msg_type:1=0x00][ttl:1][path_mtu:2 LE][src_addr:16][dest_addr:16][payload:..]
 */
export interface SessionDatagram {
    ttl: number;
    pathMtu: number;
    srcAddr: Uint8Array;
    destAddr: Uint8Array;
    payload: Uint8Array;
}
export declare const SESSION_DATAGRAM_HEADER_SIZE = 36;
export declare function encodeSessionDatagram(d: SessionDatagram): Uint8Array;
/** Decode from a buffer that includes the leading msg_type byte. */
export declare function decodeSessionDatagram(buf: Uint8Array): SessionDatagram;
/** Decrement TTL; returns false if it can no longer be forwarded. */
export declare function decrementTtl(d: SessionDatagram): boolean;
//# sourceMappingURL=link.d.ts.map