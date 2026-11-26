export declare function writeU16le(buf: Uint8Array, off: number, n: number): void;
export declare function writeU32le(buf: Uint8Array, off: number, n: number): void;
export declare function writeU64le(buf: Uint8Array, off: number, n: bigint): void;
export declare function readU16le(buf: Uint8Array, off: number): number;
export declare function readU32le(buf: Uint8Array, off: number): number;
export declare function readU64le(buf: Uint8Array, off: number): bigint;
export declare class BinaryWriter {
    private buf;
    private len;
    constructor(initialCapacity?: number);
    private ensure;
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