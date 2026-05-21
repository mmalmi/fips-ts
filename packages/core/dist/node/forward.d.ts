/**
 * FORWARD envelope. This is an inner-FMP payload — encrypted at each hop's
 * FMP link layer — that asks the forwarder to relay an FSP frame to a target
 * identity it has a direct (or further-forwarded) FMP link to.
 *
 *   byte 0:        version (= 1)
 *   byte 1:        ttl     (decremented at each hop; 0 = drop)
 *   bytes 2-34:    src_pubkey (33 compressed)
 *   bytes 35-67:   dst_pubkey (33 compressed)
 *   bytes 68-..:   FSP frame
 *
 * Distinct from FMP DATA (msgType 0x01) only by the first-byte version tag;
 * forwarders look only at the inner-FMP payload, never decrypt the FSP frame.
 */
export declare const FORWARD_VERSION = 240;
export interface ForwardEnvelope {
    version: number;
    ttl: number;
    srcPubkey: Uint8Array;
    dstPubkey: Uint8Array;
    fspFrame: Uint8Array;
}
export declare function encodeForwardEnvelope(e: ForwardEnvelope): Uint8Array;
export declare function decodeForwardEnvelope(buf: Uint8Array): ForwardEnvelope;
//# sourceMappingURL=forward.d.ts.map