export declare class BinaryWriter {
    private chunks;
    private len;
    u8(n: number): void;
    u16le(n: number): void;
    u32le(n: number): void;
    u64le(n: bigint): void;
    bytes(b: Uint8Array): void;
    get length(): number;
    toBytes(): Uint8Array;
}
export declare class BinaryReader {
    private readonly buf;
    private off;
    constructor(buf: Uint8Array);
    private require;
    u8(): number;
    u16le(): number;
    u32le(): number;
    u64le(): bigint;
    bytes(n: number): Uint8Array;
    rest(): Uint8Array;
    get position(): number;
    get remaining(): number;
}
//# sourceMappingURL=binary.d.ts.map