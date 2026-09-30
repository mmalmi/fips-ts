import { ReceiverReports } from "../mmp/receiverReports.js";
/** Link reports add one reserved byte to the otherwise identical FSP body. */
export declare class FmpReceiverReports extends ReceiverReports {
    private lastReportAt?;
    forSenderReport(payload: Uint8Array, nowMs: number): Uint8Array | undefined;
}
//# sourceMappingURL=receiverReports.d.ts.map