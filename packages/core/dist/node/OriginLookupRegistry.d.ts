export interface PendingOriginLookup {
    requestId: bigint;
    targetHex: string;
    targetPubkey?: Uint8Array;
    promise: Promise<void>;
}
export declare class OriginLookupRegistry {
    private readonly maximum;
    private readonly byTarget;
    private readonly byRequest;
    constructor(maximum: number);
    get(targetHex: string): PendingOriginLookup | undefined;
    findRequest(requestId: bigint): PendingOriginLookup | undefined;
    create(args: {
        targetHex: string;
        targetPubkey?: Uint8Array;
        randomBytes: () => Uint8Array;
        timeoutMs: number;
    }): PendingOriginLookup;
    complete(pending: PendingOriginLookup): void;
    fail(pending: PendingOriginLookup, error: Error): void;
    stop(): void;
    private nextRequestId;
    private remove;
}
//# sourceMappingURL=OriginLookupRegistry.d.ts.map