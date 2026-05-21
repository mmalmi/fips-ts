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
import { BinaryReader, BinaryWriter } from "../codec/binary.js";
export const FORWARD_VERSION = 0xf0;
export function encodeForwardEnvelope(e) {
    if (e.srcPubkey.length !== 33)
        throw new Error("src pubkey must be 33");
    if (e.dstPubkey.length !== 33)
        throw new Error("dst pubkey must be 33");
    if (e.version !== FORWARD_VERSION)
        throw new Error("bad forward version");
    const w = new BinaryWriter();
    w.u8(e.version);
    w.u8(e.ttl & 0xff);
    w.bytes(e.srcPubkey);
    w.bytes(e.dstPubkey);
    w.bytes(e.fspFrame);
    return w.toBytes();
}
export function decodeForwardEnvelope(buf) {
    if (buf.length < 2 + 33 + 33)
        throw new Error("forward envelope too short");
    const r = new BinaryReader(buf);
    const version = r.u8();
    if (version !== FORWARD_VERSION)
        throw new Error("not a FORWARD envelope");
    const ttl = r.u8();
    const srcPubkey = r.bytes(33);
    const dstPubkey = r.bytes(33);
    const fspFrame = r.rest();
    return { version, ttl, srcPubkey, dstPubkey, fspFrame };
}
//# sourceMappingURL=forward.js.map