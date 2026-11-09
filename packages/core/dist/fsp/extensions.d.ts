type SendExtension = (payload: Uint8Array) => Promise<void>;
/** Capabilities belong to the authenticated process, not a single Noise key epoch. */
export declare class FspExtensions {
    private requested;
    private capabilities;
    private responded;
    private responseRequired;
    get supportsDirect(): boolean;
    rememberDirectSupport(): void;
    request(send: SendExtension): Promise<void>;
    receive(data: {
        srcPort: number;
        dstPort: number;
        payload: Uint8Array;
    }, send: SendExtension): Promise<boolean>;
}
export {};
//# sourceMappingURL=extensions.d.ts.map