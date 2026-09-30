/** Receiver-side MMP measurements shared by FMP links and FSP sessions. */
export declare class ReceiverReports {
    private packets;
    private bytes;
    private highest;
    private expected?;
    private intervalPackets;
    private intervalBytes;
    private reordered;
    private ecnCe;
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
        ceFlag?: boolean;
    }, nowMs: number, currentEpoch?: boolean): void;
    build(nowMs: number): Uint8Array | undefined;
    private finishBurst;
    private transitTrend;
}
//# sourceMappingURL=receiverReports.d.ts.map