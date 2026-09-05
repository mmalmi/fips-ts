/** Receiver-side FSP MMP counters and the existing 66-byte report body. */
export declare class FspReceiverReports {
    private packets;
    private bytes;
    private highest;
    private expected?;
    private intervalPackets;
    private intervalBytes;
    private reordered;
    private timestamp;
    private receivedAt?;
    private jitterUs;
    private burst;
    private bursts;
    private maxBurst;
    private totalBurst;
    private transitSamples;
    resetEpoch(): void;
    record(received: {
        counter: bigint;
        timestamp: number;
        bytes: number;
    }, nowMs: number, currentEpoch?: boolean): void;
    build(nowMs: number): Uint8Array | undefined;
    private finishBurst;
    private transitTrend;
}
//# sourceMappingURL=receiverReports.d.ts.map