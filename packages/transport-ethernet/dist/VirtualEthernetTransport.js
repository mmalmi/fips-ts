import { bytesEqual, compressedPubkeyFromXOnly, noopLogger, toHex, } from "@fips/core";
export const FIPS_ETHERTYPE = 0x2121;
export const ETHERNET_HEADER_LENGTH = 14;
export const FIPS_ETHERNET_DATA_HEADER_LENGTH = 3;
export const ETHERNET_BROADCAST = "ff:ff:ff:ff:ff:ff";
const FRAME_TYPE_DATA = 0x00;
const FRAME_TYPE_BEACON = 0x01;
const DISCOVERY_VERSION = 0x01;
const BASE_BEACON_LENGTH = 34;
const DEFAULT_INTERFACE_MTU = 1500;
const DEFAULT_BEACON_INTERVAL_MS = 30_000;
const MIN_BEACON_INTERVAL_MS = 10_000;
const BROADCAST_BYTES = new Uint8Array(6).fill(0xff);
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();
export class VirtualEthernetTransport {
    type = "ethernet";
    mtu;
    identityMayChangeAtAddress = true;
    port;
    localMac;
    interfaceMtu;
    discoveryEnabled;
    announce;
    discoveryScope;
    beaconIntervalMs;
    macByPubkey = new Map();
    pubkeyByMac = new Map();
    connected = new Map();
    ctx;
    logger = noopLogger;
    unsubscribe;
    beaconTimer;
    discoveryStream;
    constructor(config) {
        this.port = config.port;
        this.localMac = parseMac(config.localMac);
        if (isZeroMac(this.localMac) || bytesEqual(this.localMac, BROADCAST_BYTES)) {
            throw new Error("local MAC must be a nonzero unicast address");
        }
        if ((this.localMac[0] & 0x01) !== 0) {
            throw new Error("local MAC must be unicast");
        }
        this.interfaceMtu = integerInRange(config.interfaceMtu ?? DEFAULT_INTERFACE_MTU, FIPS_ETHERNET_DATA_HEADER_LENGTH + 1, 0xffff + FIPS_ETHERNET_DATA_HEADER_LENGTH, "interfaceMtu");
        const maximumMtu = Math.min(this.interfaceMtu - FIPS_ETHERNET_DATA_HEADER_LENGTH, 0xffff);
        const requestedMtu = config.mtu === undefined
            ? maximumMtu
            : integerInRange(config.mtu, 1, 0xffff, "mtu");
        this.mtu = Math.min(requestedMtu, maximumMtu);
        this.discoveryEnabled = config.discovery ?? true;
        this.announce = config.announce ?? true;
        this.discoveryScope = config.discoveryScope || undefined;
        this.beaconIntervalMs = Math.max(config.beaconIntervalMs ?? DEFAULT_BEACON_INTERVAL_MS, MIN_BEACON_INTERVAL_MS);
    }
    async start(ctx) {
        if (this.ctx)
            return;
        this.ctx = ctx;
        this.logger = ctx.logger ?? noopLogger;
        this.discoveryStream = new AsyncEventStream();
        try {
            this.unsubscribe = this.port.onFrame((frame) => this.receiveFrame(frame));
            if (this.announce) {
                await this.sendBeacon();
                this.beaconTimer = setInterval(() => {
                    void this.sendBeacon().catch((err) => {
                        this.logger.warn("virtual Ethernet beacon send failed", err);
                    });
                }, this.beaconIntervalMs);
            }
        }
        catch (err) {
            this.unsubscribe?.();
            this.unsubscribe = undefined;
            this.discoveryStream.close();
            this.discoveryStream = undefined;
            this.ctx = undefined;
            this.logger = noopLogger;
            throw err;
        }
    }
    async stop() {
        if (!this.ctx)
            return;
        if (this.beaconTimer)
            clearInterval(this.beaconTimer);
        this.beaconTimer = undefined;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        for (const remoteAddr of this.connected.values()) {
            this.ctx.onConnectionState?.({ remoteAddr, state: "disconnected" });
        }
        this.connected.clear();
        this.macByPubkey.clear();
        this.pubkeyByMac.clear();
        this.discoveryStream?.close();
        this.discoveryStream = undefined;
        this.ctx = undefined;
        this.logger = noopLogger;
    }
    async connect(addr) {
        this.requireStarted();
        if (addr.transport !== this.type)
            throw new Error("wrong transport");
        const mac = formatMac(parseMac(addr.addr));
        if (mac === "00:00:00:00:00:00")
            throw new Error("destination MAC is all zeros");
        this.connected.set(mac, addr);
        this.ctx.onConnectionState?.({ remoteAddr: addr, state: "connected" });
    }
    async send(addr, packet) {
        this.requireStarted();
        if (addr.transport !== this.type)
            throw new Error("wrong transport");
        if (packet.length > this.mtu) {
            throw new Error(`packet ${packet.length} exceeds MTU ${this.mtu}`);
        }
        const destination = parseMac(addr.addr);
        if (isZeroMac(destination))
            throw new Error("destination MAC is all zeros");
        const payload = new Uint8Array(FIPS_ETHERNET_DATA_HEADER_LENGTH + packet.length);
        payload[0] = FRAME_TYPE_DATA;
        payload[1] = packet.length & 0xff;
        payload[2] = packet.length >>> 8;
        payload.set(packet, FIPS_ETHERNET_DATA_HEADER_LENGTH);
        await this.port.sendFrame(buildEthernetFrame(destination, this.localMac, payload));
    }
    async close(addr) {
        const mac = formatMac(parseMac(addr.addr));
        if (!this.connected.delete(mac))
            return;
        this.ctx?.onConnectionState?.({ remoteAddr: addr, state: "disconnected" });
    }
    discover() {
        return this.discoveryStream ?? emptyAsyncIterable();
    }
    macForPubkey(pubkey) {
        return this.macByPubkey.get(xOnlyKey(pubkey));
    }
    pubkeyForMac(mac) {
        return this.pubkeyByMac.get(formatMac(parseMac(mac)));
    }
    receiveFrame(frame) {
        if (!this.ctx || frame.length < ETHERNET_HEADER_LENGTH + 1)
            return;
        if (frame.length > ETHERNET_HEADER_LENGTH + this.interfaceMtu)
            return;
        const destination = frame.subarray(0, 6);
        const source = frame.subarray(6, 12);
        if (bytesEqual(source, this.localMac))
            return;
        if (!bytesEqual(destination, this.localMac) && !bytesEqual(destination, BROADCAST_BYTES)) {
            return;
        }
        const ethertype = (frame[12] << 8) | frame[13];
        if (ethertype !== FIPS_ETHERTYPE)
            return;
        const payload = frame.subarray(ETHERNET_HEADER_LENGTH);
        if (payload[0] === FRAME_TYPE_DATA) {
            this.receiveData(source, payload);
        }
        else if (payload[0] === FRAME_TYPE_BEACON) {
            this.receiveBeacon(source, payload);
        }
    }
    receiveData(source, payload) {
        if (payload.length < FIPS_ETHERNET_DATA_HEADER_LENGTH)
            return;
        const payloadLength = payload[1] | (payload[2] << 8);
        if (payloadLength > this.mtu || payloadLength > payload.length - FIPS_ETHERNET_DATA_HEADER_LENGTH) {
            return;
        }
        const remoteAddr = {
            transport: this.type,
            addr: formatMac(source),
        };
        this.ctx.onPacket({
            transportType: this.type,
            remoteAddr,
            data: payload.slice(FIPS_ETHERNET_DATA_HEADER_LENGTH, FIPS_ETHERNET_DATA_HEADER_LENGTH + payloadLength),
            receivedAtMs: Date.now(),
        });
    }
    receiveBeacon(source, payload) {
        if (!this.discoveryEnabled || payload.length < BASE_BEACON_LENGTH)
            return;
        if (payload[1] !== DISCOVERY_VERSION)
            return;
        let scope;
        if (payload.length > BASE_BEACON_LENGTH) {
            const scopeLength = payload[BASE_BEACON_LENGTH];
            const scopeEnd = BASE_BEACON_LENGTH + 1 + scopeLength;
            if (scopeEnd > payload.length)
                return;
            try {
                scope = textDecoder.decode(payload.subarray(BASE_BEACON_LENGTH + 1, scopeEnd)) || undefined;
            }
            catch {
                return;
            }
        }
        if (this.discoveryScope && scope !== this.discoveryScope)
            return;
        let publicKey;
        try {
            publicKey = compressedPubkeyFromXOnly(payload.subarray(2, 34));
        }
        catch {
            return;
        }
        if (bytesEqual(publicKey.subarray(1), this.ctx.localIdentity.xOnlyPubkey))
            return;
        const mac = formatMac(source);
        const pubkeyHex = toHex(publicKey);
        const key = toHex(publicKey.subarray(1));
        this.macByPubkey.set(key, mac);
        this.pubkeyByMac.set(mac, pubkeyHex);
        this.discoveryStream?.push({
            remoteAddr: { transport: this.type, addr: mac },
            publicKey,
            meta: scope ? { scope } : undefined,
        });
    }
    async sendBeacon() {
        if (!this.ctx)
            return;
        const scopeBytes = this.discoveryScope
            ? textEncoder.encode(this.discoveryScope).subarray(0, 0xff)
            : undefined;
        const payload = new Uint8Array(BASE_BEACON_LENGTH + (scopeBytes && scopeBytes.length > 0 ? 1 + scopeBytes.length : 0));
        payload[0] = FRAME_TYPE_BEACON;
        payload[1] = DISCOVERY_VERSION;
        payload.set(this.ctx.localIdentity.xOnlyPubkey, 2);
        if (scopeBytes && scopeBytes.length > 0) {
            payload[BASE_BEACON_LENGTH] = scopeBytes.length;
            payload.set(scopeBytes, BASE_BEACON_LENGTH + 1);
        }
        await this.port.sendFrame(buildEthernetFrame(BROADCAST_BYTES, this.localMac, payload));
    }
    requireStarted() {
        if (!this.ctx)
            throw new Error("virtual Ethernet transport not started");
    }
}
function buildEthernetFrame(destination, source, payload) {
    const frame = new Uint8Array(ETHERNET_HEADER_LENGTH + payload.length);
    frame.set(destination, 0);
    frame.set(source, 6);
    frame[12] = FIPS_ETHERTYPE >>> 8;
    frame[13] = FIPS_ETHERTYPE & 0xff;
    frame.set(payload, ETHERNET_HEADER_LENGTH);
    return frame;
}
export function parseMac(value) {
    if (value instanceof Uint8Array) {
        if (value.length !== 6)
            throw new Error("MAC address must be 6 bytes");
        return new Uint8Array(value);
    }
    if (!/^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}$/.test(value)) {
        throw new Error(`invalid MAC address: ${value}`);
    }
    return Uint8Array.from(value.split(":"), (part) => Number.parseInt(part, 16));
}
export function formatMac(mac) {
    if (mac.length !== 6)
        throw new Error("MAC address must be 6 bytes");
    return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join(":");
}
function isZeroMac(mac) {
    return mac.every((byte) => byte === 0);
}
function xOnlyKey(pubkey) {
    const hex = typeof pubkey === "string" ? pubkey.toLowerCase() : toHex(pubkey);
    if (/^[0-9a-f]{64}$/.test(hex))
        return hex;
    if (/^(02|03)[0-9a-f]{64}$/.test(hex))
        return hex.slice(2);
    throw new Error("pubkey must be 32-byte x-only or 33-byte compressed hex");
}
function integerInRange(value, min, max, name) {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer from ${min} to ${max}`);
    }
    return value;
}
class AsyncEventStream {
    values = [];
    waiters = [];
    closed = false;
    push(value) {
        if (this.closed)
            return;
        const waiter = this.waiters.shift();
        if (waiter)
            waiter({ done: false, value });
        else
            this.values.push(value);
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.values.length = 0;
        for (const waiter of this.waiters.splice(0)) {
            waiter({ done: true, value: undefined });
        }
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => {
                const value = this.values.shift();
                if (value !== undefined)
                    return Promise.resolve({ done: false, value });
                if (this.closed)
                    return Promise.resolve({ done: true, value: undefined });
                return new Promise((resolve) => {
                    this.waiters.push(resolve);
                });
            },
        };
    }
}
async function* emptyAsyncIterable() {
    return;
}
//# sourceMappingURL=VirtualEthernetTransport.js.map