import { ReceiverReports } from "../mmp/receiverReports.js";
/** Link reports add one reserved byte to the otherwise identical FSP body. */
export class FmpReceiverReports extends ReceiverReports {
    lastReportAt;
    forSenderReport(payload, nowMs) {
        // Native SenderReport::decode requires 47 bytes after the message type.
        // Report our own observations, never the sender's claimed counters.
        if (payload.length < 47)
            return undefined;
        // Match native's cold-start floor. Responses become less frequent when
        // the sender learns RTT and raises its own report interval to >= 1s.
        if (this.lastReportAt !== undefined && nowMs - this.lastReportAt < 200)
            return undefined;
        const sessionBody = this.build(nowMs);
        if (!sessionBody)
            return undefined;
        this.lastReportAt = nowMs;
        const body = new Uint8Array(67);
        body.set(sessionBody, 1);
        return body;
    }
}
//# sourceMappingURL=receiverReports.js.map