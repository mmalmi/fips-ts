export const FMP_HANDSHAKE_TIMEOUT_MS = 15_000;
export const MAX_PENDING_FMP_RESPONDERS = 64;
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