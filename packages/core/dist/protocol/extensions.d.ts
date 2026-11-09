export declare const EXTENSION_LINK_MESSAGE_TYPE = 224;
export declare const FSP_EXTENSION_DIRECT = 1;
export declare const FMP_EXTENSION_CLIENT_ROLE = 2;
export interface ExtensionCapabilities {
    kind: 1 | 2;
    capabilities: number;
}
export type LinkExtensionMessage = ExtensionCapabilities | {
    kind: 3;
    sequence: bigint;
};
export declare function hasExtensionMagic(payload: Uint8Array): boolean;
export declare function encodeExtensionCapabilities(kind: 1 | 2, capabilities: number): Uint8Array;
export declare function decodeExtensionCapabilities(payload: Uint8Array): ExtensionCapabilities | undefined;
export declare function encodeExtensionClientOnly(sequence: bigint): Uint8Array;
export declare function decodeLinkExtension(payload: Uint8Array): LinkExtensionMessage | undefined;
//# sourceMappingURL=extensions.d.ts.map