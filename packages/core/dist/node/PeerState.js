import { bytesEqual } from "../codec/hex.js";
export const FMP_HANDSHAKE_TIMEOUT_MS = 15_000;
export const MAX_PENDING_FMP_RESPONDERS = 64;
/** FIPS identity uses all x-only bytes; Noise retains the actual key parity. */
export function sameCompressedIdentity(a, b) {
    return a.length === 33 && b.length === 33
        && (a[0] === 2 || a[0] === 3) && (b[0] === 2 || b[0] === 3)
        && bytesEqual(a.subarray(1), b.subarray(1));
}
export function pruneDrainingResponderLinks(peer, nowMs) {
    if (!peer.drainingResponderLinks)
        return;
    for (const [receiverIdx, draining] of peer.drainingResponderLinks) {
        if (draining.expiresAtMs > nowMs)
            continue;
        draining.link.close();
        peer.drainingResponderLinks.delete(receiverIdx);
    }
    if (peer.drainingResponderLinks.size === 0) {
        peer.drainingResponderLinks = undefined;
    }
}
//# sourceMappingURL=PeerState.js.map