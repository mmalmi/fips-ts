import { createWebRtcSignal } from "./WebRtcSignal.js";
export function isRetryOfRejectedOffer(dial, negotiationId) {
    return dial.rejectedOfferId !== undefined && dial.rejectedOfferId !== negotiationId
        && dial.phase === "awaiting-answer";
}
export async function sendPendingOffer(dial, pending, send, logger) {
    const signal = createWebRtcSignal(dial.sessionId, "offer", { sdp: dial.pc.localDescription.sdp });
    dial.phase = "sending-offer";
    do {
        dial.retryOfferAfterRestart = false;
        await send(dial.remotePubkeyHex, signal);
        if (pending.get(dial.sessionId) !== dial)
            return;
    } while (dial.retryOfferAfterRestart && dial.phase === "sending-offer");
    // A fast answer can arrive before the signaling write has settled.
    if (dial.phase === "sending-offer")
        dial.phase = "awaiting-answer";
    logger.debug("webrtc offer sent", dial.remotePubkeyHex, dial.sessionId);
}
export function retryOffersAfterRestart(remote, pending, send, logger) {
    // The old offer used keys the restarted process no longer had. Its new
    // authenticated epoch proves that retrying this pending offer is safe.
    for (const dial of pending.values()) {
        if (dial.remotePubkeyHex !== remote)
            continue;
        if (dial.phase === "sending-offer") {
            dial.retryOfferAfterRestart = true;
        }
        else if (dial.phase === "awaiting-answer") {
            void sendPendingOffer(dial, pending, send, logger).catch(error => {
                // No send remains in flight after failure. A subsequent authenticated
                // recovery must retry directly instead of only setting an unused flag.
                if (pending.get(dial.sessionId) === dial && dial.phase === "sending-offer") {
                    dial.phase = "awaiting-answer";
                }
                logger.debug("recovered WebRTC offer failed", error);
            });
        }
    }
}
//# sourceMappingURL=WebRtcDial.js.map