type SendExtension = (payload: Uint8Array) => Promise<void>;
type ExtensionDatagram = {
    srcPort: number;
    dstPort: number;
    payload: Uint8Array;
};
/** Exact capabilities are control traffic, even when they contain unknown bits. */
export declare function decodeFspExtensionCapabilities(data: ExtensionDatagram): import("../protocol/extensions.js").ExtensionCapabilities | undefined;
/** Capabilities belong to the authenticated process, not a single Noise key epoch. */
export declare class FspExtensions {
    private requested;
    private capabilities;
    private responded;
    private responseRequired;
    get supportsDirect(): boolean;
    rememberDirectSupport(): void;
    request(send: SendExtension): Promise<void>;
    receive(data: ExtensionDatagram, send: SendExtension): Promise<boolean>;
}
export {};
//# sourceMappingURL=extensions.d.ts.map