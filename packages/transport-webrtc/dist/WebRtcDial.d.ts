import type { Logger } from "@fips/core";
import { type WebRtcSignal } from "./WebRtcSignal.js";
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
export declare function isRetryOfRejectedOffer(dial: PendingDial, negotiationId: string): boolean;
export declare function sendPendingOffer(dial: PendingDial, pending: ReadonlyMap<string, PendingDial>, send: SendSignal, logger: Logger): Promise<void>;
export declare function retryOffersAfterRestart(remote: string, pending: ReadonlyMap<string, PendingDial>, send: SendSignal, logger: Logger): void;
export {};
//# sourceMappingURL=WebRtcDial.d.ts.map