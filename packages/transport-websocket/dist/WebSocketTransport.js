import { FMP_ESTABLISHED_HEADER_LEN, FMP_MSG1_TOTAL_LEN, FMP_MSG2_TOTAL_LEN, FSP_ESTABLISHED_HEADER_LEN, FSP_FLAG_CP, FSP_FLAG_U, NOISE_IK_MSG1_LEN, NOISE_IK_MSG2_LEN, isDirectFspEstablished, isDirectFspTransportFragment, noopLogger, peekFmpPhase, toHex, } from "@fips/core";
export const LOCAL_KEY_HINT_VERSION = 1;
export const LOCAL_KEY_HINT_REQUEST_BYTES = 9;
export const LOCAL_KEY_HINT_RESPONSE_BYTES = 41;
const DEFAULT_MTU = 1400;
const DEFAULT_MAX_FRAME_BYTES = 66 * 1024;
const DEFAULT_MAX_SEND_QUEUE = 256;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_KEY_HINT_TIMEOUT_MS = 3_000;
const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_SEND_POLL_MS = 10;
const MAX_SEEDS = 256;
const AEAD_TAG_LEN = 16;
export class WebSocketTransport {
    type = "websocket";
    mtu;
    WS;
    logger;
    maxFrameBytes;
    maxSendQueue;
    maxBufferedBytes;
    connectTimeoutMs;
    keyHintTimeoutMs;
    reconnectInitialMs;
    reconnectMaxMs;
    sendPollMs;
    randomNonce;
    seeds;
    counters = {
        connectionAttempts: 0,
        connectionsOpened: 0,
        connectionsClosed: 0,
        reconnectsScheduled: 0,
        framesSent: 0,
        framesReceived: 0,
        bytesSent: 0,
        bytesReceived: 0,
        invalidFrames: 0,
        sendQueueFull: 0,
    };
    ctx;
    localXOnlyHex = "";
    discoveries;
    stopping = true;
    constructor(config) {
        this.WS = config.webSocket
            ?? globalThis.WebSocket;
        if (!this.WS)
            throw new Error("no WebSocket constructor available");
        this.mtu = integerInRange(config.mtu ?? DEFAULT_MTU, 1, 0xffff, "mtu");
        this.maxFrameBytes = integerInRange(config.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES, this.mtu + 64, 1024 * 1024, "maxFrameBytes");
        this.maxSendQueue = integerInRange(config.maxSendQueue ?? DEFAULT_MAX_SEND_QUEUE, 1, 4096, "maxSendQueue");
        this.maxBufferedBytes = integerInRange(config.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES, 1, 64 * 1024 * 1024, "maxBufferedBytes");
        this.connectTimeoutMs = positiveInteger(config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, "connectTimeoutMs");
        this.keyHintTimeoutMs = positiveInteger(config.keyHintTimeoutMs ?? DEFAULT_KEY_HINT_TIMEOUT_MS, "keyHintTimeoutMs");
        this.reconnectInitialMs = positiveInteger(config.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS, "reconnectInitialMs");
        this.reconnectMaxMs = integerInRange(config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS, this.reconnectInitialMs, 60 * 60 * 1000, "reconnectMaxMs");
        this.sendPollMs = integerInRange(config.sendPollMs ?? DEFAULT_SEND_POLL_MS, 1, 1000, "sendPollMs");
        this.logger = config.logger ?? noopLogger;
        this.randomNonce = config.randomNonce ?? secureRandomNonce;
        if (config.seedUrls.length === 0)
            throw new Error("at least one WebSocket seed URL is required");
        if (config.seedUrls.length > MAX_SEEDS) {
            throw new Error(`seedUrls must not exceed ${MAX_SEEDS}`);
        }
        const normalized = config.seedUrls.map(normalizeSeedUrl);
        if (new Set(normalized).size !== normalized.length) {
            throw new Error("duplicate seed URL");
        }
        this.seeds = new Map(normalized.map((url) => [url, {
                url,
                addr: { transport: this.type, addr: url },
                generation: 0,
                readyWaiters: new Set(),
                queue: [],
                queueHead: 0,
                reconnectDelayMs: this.reconnectInitialMs,
            }]));
    }
    async start(ctx) {
        if (!this.stopping)
            return;
        this.stopping = false;
        this.ctx = ctx;
        this.localXOnlyHex = toHex(ctx.localIdentity.xOnlyPubkey);
        this.discoveries = new AsyncEventStream(this.seeds.size * 2);
        for (const state of this.seeds.values())
            this.dial(state);
    }
    async stop() {
        if (this.stopping)
            return;
        this.stopping = true;
        for (const state of this.seeds.values()) {
            this.clearTimers(state);
            this.rejectReadyWaiters(state, new Error("WebSocket transport stopped"));
            this.rejectQueue(state, new Error("WebSocket transport stopped"));
            const socket = state.socket;
            state.socket = undefined;
            state.remoteXOnly = undefined;
            state.nonce = undefined;
            try {
                socket?.close(1000, "transport stopped");
            }
            catch {
                // Best effort during shutdown.
            }
        }
        this.discoveries?.close();
        this.discoveries = undefined;
        this.ctx = undefined;
        this.localXOnlyHex = "";
    }
    discover() {
        return this.discoveries ?? emptyAsyncIterable();
    }
    async connect(addr) {
        if (this.stopping)
            throw new Error("WebSocket transport is not started");
        const state = this.stateFor(addr);
        if (this.isReady(state))
            return;
        await new Promise((resolve, reject) => {
            state.readyWaiters.add({ resolve, reject });
            if (!state.socket && !state.reconnectTimer)
                this.dial(state);
        });
    }
    async send(addr, packet) {
        const state = this.stateFor(addr);
        validateFipsRecord(packet, this.maxFrameBytes);
        if (packet.length > this.maxBufferedBytes)
            throw new Error("WebSocket record exceeds send buffer budget");
        if (!this.isReady(state))
            throw new Error("WebSocket seed is not connected");
        const queued = state.queue.length - state.queueHead;
        if (queued === 0 && !state.sendTimer && state.socket.bufferedAmount + packet.length <= this.maxBufferedBytes) {
            if (state.remoteXOnly && this.ctx?.allowPeer?.(state.remoteXOnly) === false) {
                throw new Error("FIPS peer is blocked");
            }
            try {
                state.socket.send(packet);
                this.counters.framesSent++;
                this.counters.bytesSent += packet.length;
                return;
            }
            catch (error) {
                const err = asError(error);
                this.failSocket(state, state.generation, err);
                throw err;
            }
        }
        if (queued >= this.maxSendQueue) {
            this.counters.sendQueueFull++;
            throw new Error("WebSocket send queue full");
        }
        const copy = new Uint8Array(packet);
        await new Promise((resolve, reject) => {
            state.queue.push({ data: copy, resolve, reject });
            this.pump(state);
        });
    }
    stats() {
        return { ...this.counters };
    }
    stateFor(addr) {
        if (addr.transport !== this.type)
            throw new Error("wrong transport");
        const direct = this.seeds.get(addr.addr);
        if (direct)
            return direct;
        const normalized = normalizeSeedUrl(addr.addr);
        const state = this.seeds.get(normalized);
        if (!state)
            throw new Error(`unconfigured WebSocket seed URL ${normalized}`);
        return state;
    }
    dial(state) {
        if (this.stopping || state.socket || state.reconnectTimer)
            return;
        const generation = ++state.generation;
        this.counters.connectionAttempts++;
        this.logger.debug("WebSocket seed connect", state.url);
        this.ctx?.onConnectionState?.({
            remoteAddr: state.addr,
            state: "connecting",
        });
        let socket;
        try {
            socket = new this.WS(state.url);
        }
        catch (error) {
            this.connectionEnded(state, generation, asError(error));
            return;
        }
        state.socket = socket;
        socket.binaryType = "arraybuffer";
        state.connectTimer = setTimeout(() => {
            this.failSocket(state, generation, new Error("WebSocket connect timeout"));
        }, this.connectTimeoutMs);
        let pendingAsync = 0;
        let receiveChain = Promise.resolve();
        socket.addEventListener("open", () => {
            if (!this.isCurrent(state, socket, generation))
                return;
            if (state.connectTimer)
                clearTimeout(state.connectTimer);
            state.connectTimer = undefined;
            this.counters.connectionsOpened++;
            state.nonce = checkedNonce(this.randomNonce());
            try {
                socket.send(encodeLocalKeyHintRequest(state.nonce));
            }
            catch (error) {
                this.failSocket(state, generation, asError(error));
                return;
            }
            state.keyHintTimer = setTimeout(() => {
                this.failSocket(state, generation, new Error("WebSocket key hint timeout"));
            }, this.keyHintTimeoutMs);
        });
        socket.addEventListener("message", (event) => {
            if (!this.isCurrent(state, socket, generation))
                return;
            const data = event.data;
            if (pendingAsync === 0 && !(typeof Blob !== "undefined" && data instanceof Blob)) {
                try {
                    const { wire, owned } = syncBinaryMessage(data);
                    this.processMessage(state, socket, wire, owned);
                }
                catch (error) {
                    this.failSocket(state, generation, asError(error));
                }
                return;
            }
            pendingAsync++;
            receiveChain = receiveChain
                .then(() => this.receiveAsync(state, socket, generation, data))
                .catch((error) => this.failSocket(state, generation, asError(error)))
                .finally(() => { pendingAsync--; });
        });
        socket.addEventListener("error", () => {
            if (!this.isCurrent(state, socket, generation))
                return;
            this.failSocket(state, generation, new Error("WebSocket connection error"));
        });
        socket.addEventListener("close", (event) => {
            if (!this.isCurrent(state, socket, generation))
                return;
            const close = event;
            const reason = close.reason
                ? `WebSocket closed: ${close.reason}`
                : `WebSocket closed (${close.code})`;
            this.connectionEnded(state, generation, new Error(reason));
        });
    }
    async receiveAsync(state, socket, generation, data) {
        if (!this.isCurrent(state, socket, generation))
            return;
        const { wire, owned } = typeof Blob !== "undefined" && data instanceof Blob
            ? { wire: new Uint8Array(await data.arrayBuffer()), owned: true }
            : syncBinaryMessage(data);
        if (!this.isCurrent(state, socket, generation))
            return;
        this.processMessage(state, socket, wire, owned);
    }
    processMessage(state, socket, wire, owned) {
        const hint = decodeLocalKeyHint(wire);
        if (hint?.kind === "request") {
            if (!this.ctx)
                throw new Error("WebSocket transport is not started");
            socket.send(encodeLocalKeyHintResponse(hint.nonce, this.ctx.localIdentity.xOnlyPubkey));
            return;
        }
        if (hint?.kind === "response") {
            if (hint.nonce !== state.nonce || state.remoteXOnly)
                return;
            if (toHex(hint.pubkey) === this.localXOnlyHex) {
                throw new Error("WebSocket seed returned the local FIPS identity");
            }
            if (this.ctx?.allowPeer?.(hint.pubkey) === false)
                throw new Error("FIPS peer is blocked");
            if (state.keyHintTimer)
                clearTimeout(state.keyHintTimer);
            state.keyHintTimer = undefined;
            state.remoteXOnly = new Uint8Array(hint.pubkey);
            state.reconnectDelayMs = this.reconnectInitialMs;
            this.resolveReadyWaiters(state);
            this.ctx?.onConnectionState?.({ remoteAddr: state.addr, state: "connected" });
            this.discoveries?.push({
                remoteAddr: state.addr,
                publicKey: new Uint8Array(hint.pubkey),
                meta: { source: "websocket-seed" },
            });
            this.pump(state);
            return;
        }
        if (!state.remoteXOnly)
            throw new Error("FIPS record arrived before WebSocket key hint");
        try {
            validateFipsRecord(wire, this.maxFrameBytes);
        }
        catch (error) {
            this.counters.invalidFrames++;
            throw error;
        }
        this.counters.framesReceived++;
        this.counters.bytesReceived += wire.length;
        this.ctx?.onPacket({
            transportType: this.type,
            remoteAddr: state.addr,
            data: owned ? wire : new Uint8Array(wire),
            receivedAtMs: Date.now(),
        });
    }
    pump(state) {
        if (state.sendTimer || !this.isReady(state))
            return;
        const socket = state.socket;
        while (state.queueHead < state.queue.length) {
            if (state.remoteXOnly && this.ctx?.allowPeer?.(state.remoteXOnly) === false) {
                this.rejectQueue(state, new Error("FIPS peer is blocked"));
                return;
            }
            const next = state.queue[state.queueHead];
            if (socket.bufferedAmount + next.data.length > this.maxBufferedBytes) {
                state.sendTimer = setTimeout(() => {
                    state.sendTimer = undefined;
                    this.pump(state);
                }, this.sendPollMs);
                return;
            }
            state.queueHead++;
            if (state.queueHead === state.queue.length) {
                state.queue.length = 0;
                state.queueHead = 0;
            }
            else if (state.queueHead >= 64) {
                state.queue.splice(0, state.queueHead);
                state.queueHead = 0;
            }
            try {
                socket.send(next.data);
                this.counters.framesSent++;
                this.counters.bytesSent += next.data.length;
                next.resolve();
            }
            catch (error) {
                const err = asError(error);
                next.reject(err);
                this.failSocket(state, state.generation, err);
                return;
            }
        }
    }
    failSocket(state, generation, error) {
        if (generation !== state.generation)
            return;
        try {
            state.socket?.close(1002, error.message.slice(0, 120));
        }
        catch {
            // connectionEnded below owns cleanup.
        }
        this.connectionEnded(state, generation, error);
    }
    connectionEnded(state, generation, error) {
        if (generation !== state.generation)
            return;
        const wasOpen = state.socket !== undefined;
        this.clearConnectionTimers(state);
        state.socket = undefined;
        state.nonce = undefined;
        state.remoteXOnly = undefined;
        this.rejectReadyWaiters(state, error);
        this.rejectQueue(state, error);
        if (wasOpen)
            this.counters.connectionsClosed++;
        this.ctx?.onConnectionState?.({
            remoteAddr: state.addr,
            state: "disconnected",
            reason: error.message,
        });
        this.logger.warn("WebSocket seed disconnected", state.url, error);
        if (this.stopping || state.reconnectTimer)
            return;
        const delay = state.reconnectDelayMs;
        state.reconnectDelayMs = Math.min(delay * 2, this.reconnectMaxMs);
        this.counters.reconnectsScheduled++;
        state.reconnectTimer = setTimeout(() => {
            state.reconnectTimer = undefined;
            this.dial(state);
        }, delay);
    }
    isReady(state) {
        return state.socket?.readyState === this.WS.OPEN && state.remoteXOnly !== undefined;
    }
    isCurrent(state, socket, generation) {
        return state.socket === socket && state.generation === generation;
    }
    resolveReadyWaiters(state) {
        for (const waiter of state.readyWaiters)
            waiter.resolve();
        state.readyWaiters.clear();
    }
    rejectReadyWaiters(state, error) {
        for (const waiter of state.readyWaiters)
            waiter.reject(error);
        state.readyWaiters.clear();
    }
    rejectQueue(state, error) {
        const items = state.queue.slice(state.queueHead);
        state.queue.length = 0;
        state.queueHead = 0;
        for (const pending of items)
            pending.reject(error);
    }
    clearConnectionTimers(state) {
        if (state.connectTimer)
            clearTimeout(state.connectTimer);
        if (state.keyHintTimer)
            clearTimeout(state.keyHintTimer);
        if (state.sendTimer)
            clearTimeout(state.sendTimer);
        state.connectTimer = undefined;
        state.keyHintTimer = undefined;
        state.sendTimer = undefined;
    }
    clearTimers(state) {
        this.clearConnectionTimers(state);
        if (state.reconnectTimer)
            clearTimeout(state.reconnectTimer);
        state.reconnectTimer = undefined;
    }
}
export function encodeLocalKeyHintRequest(nonce) {
    const wire = new Uint8Array(LOCAL_KEY_HINT_REQUEST_BYTES);
    wire[0] = LOCAL_KEY_HINT_VERSION;
    new DataView(wire.buffer).setBigUint64(1, checkedNonce(nonce), false);
    return wire;
}
export function encodeLocalKeyHintResponse(nonce, pubkey) {
    if (pubkey.length !== 32)
        throw new Error("key-hint pubkey must be 32 bytes");
    const wire = new Uint8Array(LOCAL_KEY_HINT_RESPONSE_BYTES);
    wire.set(encodeLocalKeyHintRequest(nonce));
    wire.set(pubkey, LOCAL_KEY_HINT_REQUEST_BYTES);
    return wire;
}
export function decodeLocalKeyHint(wire) {
    if (wire[0] !== LOCAL_KEY_HINT_VERSION)
        return undefined;
    if (wire.length !== LOCAL_KEY_HINT_REQUEST_BYTES
        && wire.length !== LOCAL_KEY_HINT_RESPONSE_BYTES)
        return undefined;
    const nonce = new DataView(wire.buffer, wire.byteOffset + 1, 8).getBigUint64(0, false);
    if (wire.length === LOCAL_KEY_HINT_REQUEST_BYTES)
        return { kind: "request", nonce };
    return {
        kind: "response",
        nonce,
        pubkey: new Uint8Array(wire.subarray(LOCAL_KEY_HINT_REQUEST_BYTES)),
    };
}
export function validateFipsWebSocketRecord(wire, maxBytes = DEFAULT_MAX_FRAME_BYTES) {
    validateFipsRecord(wire, maxBytes);
}
function validateFipsRecord(wire, maxBytes) {
    if (wire.length === 0 || wire.length > maxBytes) {
        throw new Error(`WebSocket FIPS record exceeds ${maxBytes} bytes`);
    }
    if (isDirectFspEstablished(wire)) {
        validateDirectFspEstablished(wire);
        return;
    }
    if (isDirectFspTransportFragment(wire)) {
        validateDirectFspFragment(wire);
        return;
    }
    if ((wire[0] >>> 4) !== 0)
        throw new Error("bad FMP version");
    const phase = peekFmpPhase(wire);
    const payloadLen = wire.length >= 4 ? (wire[2] | (wire[3] << 8)) : -1;
    if (phase === 0) {
        if (wire.length < FMP_ESTABLISHED_HEADER_LEN + AEAD_TAG_LEN
            || wire.length - FMP_ESTABLISHED_HEADER_LEN !== payloadLen + AEAD_TAG_LEN) {
            throw new Error("invalid FMP Established record");
        }
    }
    else if (phase === 1) {
        if (wire.length !== FMP_MSG1_TOTAL_LEN || wire[1] !== 0 || payloadLen !== 4 + NOISE_IK_MSG1_LEN) {
            throw new Error("invalid FMP Msg1 record");
        }
    }
    else if (phase === 2) {
        if (wire.length !== FMP_MSG2_TOTAL_LEN || wire[1] !== 0 || payloadLen !== 8 + NOISE_IK_MSG2_LEN) {
            throw new Error("invalid FMP Msg2 record");
        }
    }
    else {
        throw new Error(`unknown FIPS physical record phase ${phase}`);
    }
}
function validateDirectFspEstablished(wire) {
    if (wire.length < FSP_ESTABLISHED_HEADER_LEN + AEAD_TAG_LEN) {
        throw new Error("FSP Established too short");
    }
    const flags = wire[1];
    if ((flags & FSP_FLAG_U) !== 0) {
        throw new Error("plaintext FSP error frames are not supported here");
    }
    const payloadLen = wire[2] | (wire[3] << 8);
    let off = FSP_ESTABLISHED_HEADER_LEN;
    if ((flags & FSP_FLAG_CP) !== 0) {
        for (let i = 0; i < 2; i++) {
            if (off + 2 > wire.length)
                throw new Error("FSP coordinate field too short");
            const count = wire[off] | (wire[off + 1] << 8);
            off += 2 + count * 16;
            if (off > wire.length)
                throw new Error("FSP coordinate entries truncated");
        }
    }
    if (wire.length - off !== payloadLen + AEAD_TAG_LEN) {
        throw new Error("FSP payload_len mismatch");
    }
}
function validateDirectFspFragment(wire) {
    if (wire.length <= 20)
        throw new Error("direct-FSP fragment has no payload");
    const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
    const totalLength = view.getUint32(12, true);
    const fragmentIndex = view.getUint16(16, true);
    const fragmentCount = view.getUint16(18, true);
    if (totalLength === 0
        || totalLength > 72 * 1024
        || fragmentCount <= 1
        || fragmentCount > 128
        || fragmentCount > totalLength
        || fragmentIndex >= fragmentCount
        || wire.length - 20 > totalLength) {
        throw new Error("invalid direct-FSP fragment header");
    }
}
function syncBinaryMessage(data) {
    if (typeof data === "string")
        throw new Error("WebSocket transport accepts binary messages only");
    if (data instanceof ArrayBuffer)
        return { wire: new Uint8Array(data), owned: true };
    if (ArrayBuffer.isView(data)) {
        return { wire: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), owned: false };
    }
    throw new Error("unsupported WebSocket binary message");
}
function normalizeSeedUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new Error(`invalid WebSocket seed URL ${JSON.stringify(raw)}`);
    }
    if (url.username || url.password || url.hash) {
        throw new Error("WebSocket seed URL must not contain credentials or a fragment");
    }
    if (url.protocol === "wss:")
        return url.toString();
    if (url.protocol === "ws:" && isLoopbackHost(url.hostname))
        return url.toString();
    if (url.protocol === "ws:") {
        throw new Error("plaintext WebSocket seed URL is allowed only for loopback");
    }
    throw new Error("WebSocket seed URL must use wss://");
}
function isLoopbackHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1")
        return true;
    const octets = host.split(".");
    return octets.length === 4
        && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
        && Number(octets[0]) === 127;
}
function secureRandomNonce() {
    const bytes = new Uint8Array(8);
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.getRandomValues)
        throw new Error("crypto.getRandomValues is unavailable");
    cryptoApi.getRandomValues(bytes);
    return new DataView(bytes.buffer).getBigUint64(0, false);
}
function checkedNonce(nonce) {
    if (nonce < 0n || nonce > 0xffffffffffffffffn) {
        throw new Error("key-hint nonce must be an unsigned 64-bit integer");
    }
    return nonce;
}
function integerInRange(value, min, max, name) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}
function positiveInteger(value, name) {
    return integerInRange(value, 1, 60 * 60 * 1000, name);
}
function asError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
class AsyncEventStream {
    maxValues;
    values = [];
    waiters = [];
    closed = false;
    constructor(maxValues) {
        this.maxValues = maxValues;
    }
    push(value) {
        if (this.closed)
            return;
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter({ done: false, value });
        }
        else {
            if (this.values.length >= this.maxValues) {
                this.values.shift();
            }
            this.values.push(value);
        }
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
//# sourceMappingURL=WebSocketTransport.js.map