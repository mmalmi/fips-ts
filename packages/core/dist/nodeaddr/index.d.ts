export declare const NODE_ADDR_LENGTH = 16;
export declare const X_ONLY_PUBKEY_LENGTH = 32;
export declare const COMPRESSED_PUBKEY_LENGTH = 33;
export type NodeAddr = Uint8Array;
/**
 * Derive a 16-byte FIPS NodeAddr from a secp256k1 public key.
 *
 * Compatible with Rust: SHA-256 of the 32-byte x-only public key,
 * truncated to 16 bytes.
 *
 * Accepts both compressed (33-byte, 0x02/0x03 prefix) and x-only (32-byte)
 * representations.
 */
export declare function deriveNodeAddr(pubkey: Uint8Array): NodeAddr;
export declare function nodeAddrToHex(addr: NodeAddr): string;
export declare function nodeAddrFromHex(hex: string): NodeAddr;
/**
 * Construct a NodeAddr from a raw 16-byte slice (mirrors Rust
 * NodeAddr::from_slice). Throws on wrong length.
 */
export declare function nodeAddrFromSlice(slice: Uint8Array): NodeAddr;
/**
 * Lexicographic comparison of two NodeAddrs. Returns -1, 0, or 1 — matches
 * Rust's `Ord` impl (NodeAddrs are byte arrays). Used by routing tables and
 * root-election tiebreakers.
 */
export declare function compareNodeAddr(a: NodeAddr, b: NodeAddr): -1 | 0 | 1;
//# sourceMappingURL=index.d.ts.map