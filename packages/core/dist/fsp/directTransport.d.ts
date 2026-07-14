export declare const DIRECT_FSP_TRANSPORT_FRAGMENT_HEADER_LEN = 20;
export declare const DIRECT_FSP_TRANSPORT_MAX_REASSEMBLED_LEN: number;
export declare const DIRECT_FSP_TRANSPORT_MAX_FRAGMENTS = 128;
export declare function isDirectFspTransportFragment(data: Uint8Array): boolean;
export declare function segmentDirectFspTransportRecord(record: Uint8Array, pathMtu: number): Uint8Array[];
export declare class DirectFspTransportReassembler {
    private readonly entries;
    ingest(source: string, fragment: Uint8Array, nowMs: number): Uint8Array | undefined;
    clear(): void;
    private prune;
    private reserveEntry;
}
//# sourceMappingURL=directTransport.d.ts.map