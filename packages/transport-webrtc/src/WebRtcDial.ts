import type { Logger } from "@fips/core";
import { createWebRtcSignal, type WebRtcSignal } from "./WebRtcSignal.js";

export interface PendingDial {
  sessionId: string;
  remotePubkeyHex: string;
  phase: string;
  rejectedOfferId?: string;
  retryOfferAfterRestart?: boolean;
  pc: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type SendSignal = (remote: string, signal: WebRtcSignal) => Promise<void>;

export function isRetryOfRejectedOffer(dial: PendingDial, negotiationId: string): boolean {
  return dial.rejectedOfferId !== undefined && dial.rejectedOfferId !== negotiationId
    && dial.phase === "awaiting-answer";
}

export async function sendPendingOffer(
  dial: PendingDial, pending: ReadonlyMap<string, PendingDial>, send: SendSignal, logger: Logger,
): Promise<void> {
  const signal = createWebRtcSignal(dial.sessionId, "offer", { sdp: dial.pc.localDescription!.sdp });
  dial.phase = "sending-offer";
  do {
    dial.retryOfferAfterRestart = false;
    await send(dial.remotePubkeyHex, signal);
    if (pending.get(dial.sessionId) !== dial) return;
  } while (dial.retryOfferAfterRestart && dial.phase === "sending-offer");
  // A fast answer can arrive before the signaling write has settled.
  if (dial.phase === "sending-offer") dial.phase = "awaiting-answer";
  logger.debug("webrtc offer sent", dial.remotePubkeyHex, dial.sessionId);
}

export function retryOffersAfterRestart(
  remote: string, pending: ReadonlyMap<string, PendingDial>, send: SendSignal, logger: Logger,
): void {
  // The old offer used keys the restarted process no longer had. Its new
  // authenticated epoch proves that retrying this pending offer is safe.
  for (const dial of pending.values()) {
    if (dial.remotePubkeyHex !== remote) continue;
    if (dial.phase === "sending-offer") {
      dial.retryOfferAfterRestart = true;
    } else if (dial.phase === "awaiting-answer") {
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
