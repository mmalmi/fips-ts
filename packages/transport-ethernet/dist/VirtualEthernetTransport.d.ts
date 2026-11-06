import { type DiscoveredPeer, type Transport, type TransportAddress, type TransportContext } from "@fips/core";
export declare const FIPS_ETHERTYPE = 8481;
export declare const ETHERNET_HEADER_LENGTH = 14;
export declare const FIPS_ETHERNET_DATA_HEADER_LENGTH = 3;
export declare const ETHERNET_BROADCAST = "ff:ff:ff:ff:ff:ff";
/** Generic full-Ethernet-frame boundary supplied by a browser VM or virtual NIC. */
export interface EthernetFramePort {
    onFrame(listener: (frame: Uint8Array) => void): () => void;
    sendFrame(frame: Uint8Array): Promise<void> | void;
}
export interface VirtualEthernetTransportConfig {
    port: EthernetFramePort;
    localMac: string | Uint8Array;
    /** Ethernet payload MTU before the 3-byte FIPS data record header. */
    interfaceMtu?: number;
    /** FMP payload MTU. Capped to interfaceMtu - 3 and the u16 length field. */
    mtu?: number;
    discovery?: boolean;
    announce?: boolean;
    discoveryScope?: string;
    beaconIntervalMs?: number;
}
export declare class VirtualEthernetTransport implements Transport {
    readonly type = "ethernet";
    readonly mtu: number;
    readonly identityMayChangeAtAddress = true;
    private readonly port;
    private readonly localMac;
    private readonly interfaceMtu;
    private readonly discoveryEnabled;
    private readonly announce;
    private readonly discoveryScope?;
    private readonly beaconIntervalMs;
    private readonly macByPubkey;
    private readonly pubkeyByMac;
    private readonly connected;
    private ctx?;
    private logger;
    private unsubscribe?;
    private beaconTimer?;
    private discoveryStream?;
    constructor(config: VirtualEthernetTransportConfig);
    start(ctx: TransportContext): Promise<void>;
    stop(): Promise<void>;
    connect(addr: TransportAddress): Promise<void>;
    send(addr: TransportAddress, packet: Uint8Array): Promise<void>;
    close(addr: TransportAddress): Promise<void>;
    discover(): AsyncIterable<DiscoveredPeer>;
    macForPubkey(pubkey: string | Uint8Array): string | undefined;
    pubkeyForMac(mac: string | Uint8Array): string | undefined;
    private receiveFrame;
    private receiveData;
    private receiveBeacon;
    private sendBeacon;
    private requireStarted;
}
export declare function parseMac(value: string | Uint8Array): Uint8Array;
export declare function formatMac(mac: Uint8Array): string;
//# sourceMappingURL=VirtualEthernetTransport.d.ts.map