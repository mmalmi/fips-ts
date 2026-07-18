import {
  decodeFmpEstablished,
  decodeFmpMsg1,
  decodeFmpMsg2,
  decodeFspEstablished,
  isDirectFspEstablished,
  isDirectFspTransportFragment,
  noopLogger,
  peekFmpPhase,
  toHex,
  type DiscoveredPeer,
  type Logger,
  type Transport,
  type TransportAddress,
  type TransportContext,
} from "@fips/core";

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

export type LocalKeyHint =
  | { kind: "request"; nonce: bigint }
  | { kind: "response"; nonce: bigint; pubkey: Uint8Array };

export interface WebSocketTransportConfig {
  /** Explicit first-adjacency URLs. Remote URLs must use WSS; loopback may use WS for tests. */
  seedUrls: readonly string[];
  mtu?: number;
  maxFrameBytes?: number;
  maxSendQueue?: number;
  /** Browser WebSocket bufferedAmount ceiling before records wait in the bounded send queue. */
  maxBufferedBytes?: number;
  connectTimeoutMs?: number;
  keyHintTimeoutMs?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  sendPollMs?: number;
  webSocket?: typeof WebSocket;
  logger?: Logger;
  /** Deterministic test hook. Production uses crypto.getRandomValues. */
  randomNonce?: () => bigint;
}

export interface WebSocketTransportStats {
  connectionAttempts: number;
  connectionsOpened: number;
  connectionsClosed: number;
  reconnectsScheduled: number;
  framesSent: number;
  framesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  invalidFrames: number;
  sendQueueFull: number;
}

interface PendingSend {
  data: Uint8Array;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface SeedState {
  readonly url: string;
  socket?: WebSocket;
  generation: number;
  nonce?: bigint;
  remoteXOnly?: Uint8Array;
  readyWaiters: Set<Deferred>;
  queue: PendingSend[];
  receiveChain: Promise<void>;
  reconnectDelayMs: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  connectTimer?: ReturnType<typeof setTimeout>;
  keyHintTimer?: ReturnType<typeof setTimeout>;
  sendTimer?: ReturnType<typeof setTimeout>;
}

interface Deferred {
  resolve: () => void;
  reject: (error: Error) => void;
}

export class WebSocketTransport implements Transport {
  readonly type = "websocket";
  readonly mtu: number;

  private readonly WS: typeof WebSocket;
  private readonly logger: Logger;
  private readonly maxFrameBytes: number;
  private readonly maxSendQueue: number;
  private readonly maxBufferedBytes: number;
  private readonly connectTimeoutMs: number;
  private readonly keyHintTimeoutMs: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly sendPollMs: number;
  private readonly randomNonce: () => bigint;
  private readonly seeds: Map<string, SeedState>;
  private readonly counters: WebSocketTransportStats = {
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

  private ctx?: TransportContext;
  private discoveries?: AsyncEventStream<DiscoveredPeer>;
  private stopping = true;

  constructor(config: WebSocketTransportConfig) {
    this.WS = config.webSocket
      ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket!;
    if (!this.WS) throw new Error("no WebSocket constructor available");
    this.mtu = integerInRange(config.mtu ?? DEFAULT_MTU, 1, 0xffff, "mtu");
    this.maxFrameBytes = integerInRange(
      config.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      this.mtu + 64,
      1024 * 1024,
      "maxFrameBytes",
    );
    this.maxSendQueue = integerInRange(
      config.maxSendQueue ?? DEFAULT_MAX_SEND_QUEUE,
      1,
      4096,
      "maxSendQueue",
    );
    this.maxBufferedBytes = integerInRange(
      config.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      1,
      64 * 1024 * 1024,
      "maxBufferedBytes",
    );
    this.connectTimeoutMs = positiveInteger(
      config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      "connectTimeoutMs",
    );
    this.keyHintTimeoutMs = positiveInteger(
      config.keyHintTimeoutMs ?? DEFAULT_KEY_HINT_TIMEOUT_MS,
      "keyHintTimeoutMs",
    );
    this.reconnectInitialMs = positiveInteger(
      config.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS,
      "reconnectInitialMs",
    );
    this.reconnectMaxMs = integerInRange(
      config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
      this.reconnectInitialMs,
      60 * 60 * 1000,
      "reconnectMaxMs",
    );
    this.sendPollMs = integerInRange(
      config.sendPollMs ?? DEFAULT_SEND_POLL_MS,
      1,
      1000,
      "sendPollMs",
    );
    this.logger = config.logger ?? noopLogger;
    this.randomNonce = config.randomNonce ?? secureRandomNonce;

    if (config.seedUrls.length === 0) throw new Error("at least one WebSocket seed URL is required");
    if (config.seedUrls.length > MAX_SEEDS) {
      throw new Error(`seedUrls must not exceed ${MAX_SEEDS}`);
    }
    const normalized = config.seedUrls.map(normalizeSeedUrl);
    if (new Set(normalized).size !== normalized.length) {
      throw new Error("duplicate seed URL");
    }
    this.seeds = new Map(normalized.map((url) => [url, {
      url,
      generation: 0,
      readyWaiters: new Set<Deferred>(),
      queue: [],
      receiveChain: Promise.resolve(),
      reconnectDelayMs: this.reconnectInitialMs,
    }]));
  }

  async start(ctx: TransportContext): Promise<void> {
    if (!this.stopping) return;
    this.stopping = false;
    this.ctx = ctx;
    this.discoveries = new AsyncEventStream<DiscoveredPeer>(this.seeds.size * 2);
    for (const state of this.seeds.values()) this.dial(state);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
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
      } catch {
        // Best effort during shutdown.
      }
    }
    this.discoveries?.close();
    this.discoveries = undefined;
    this.ctx = undefined;
  }

  discover(): AsyncIterable<DiscoveredPeer> {
    return this.discoveries ?? emptyAsyncIterable();
  }

  async connect(addr: TransportAddress): Promise<void> {
    const state = this.stateFor(addr);
    if (this.isReady(state)) return;
    if (!state.socket && !state.reconnectTimer) this.dial(state);
    await new Promise<void>((resolve, reject) => {
      state.readyWaiters.add({ resolve, reject });
    });
  }

  async send(addr: TransportAddress, packet: Uint8Array): Promise<void> {
    const state = this.stateFor(addr);
    validateFipsRecord(packet, this.maxFrameBytes);
    if (!this.isReady(state)) throw new Error("WebSocket seed is not connected");
    if (state.queue.length >= this.maxSendQueue) {
      this.counters.sendQueueFull++;
      throw new Error("WebSocket send queue full");
    }
    const copy = new Uint8Array(packet);
    await new Promise<void>((resolve, reject) => {
      state.queue.push({ data: copy, resolve, reject });
      this.pump(state);
    });
  }

  stats(): WebSocketTransportStats {
    return { ...this.counters };
  }

  private stateFor(addr: TransportAddress): SeedState {
    if (addr.transport !== this.type) throw new Error("wrong transport");
    const normalized = normalizeSeedUrl(addr.addr);
    const state = this.seeds.get(normalized);
    if (!state) throw new Error(`unconfigured WebSocket seed URL ${normalized}`);
    return state;
  }

  private dial(state: SeedState): void {
    if (this.stopping || state.socket || state.reconnectTimer) return;
    const generation = ++state.generation;
    this.counters.connectionAttempts++;
    this.logger.debug("WebSocket seed connect", state.url);
    this.ctx?.onConnectionState?.({
      remoteAddr: this.addr(state),
      state: "connecting",
    });
    let socket: WebSocket;
    try {
      socket = new this.WS(state.url);
    } catch (error) {
      this.connectionEnded(state, generation, asError(error));
      return;
    }
    state.socket = socket;
    socket.binaryType = "arraybuffer";
    state.connectTimer = setTimeout(() => {
      this.failSocket(state, generation, new Error("WebSocket connect timeout"));
    }, this.connectTimeoutMs);

    socket.addEventListener("open", () => {
      if (!this.isCurrent(state, socket, generation)) return;
      if (state.connectTimer) clearTimeout(state.connectTimer);
      state.connectTimer = undefined;
      this.counters.connectionsOpened++;
      state.nonce = checkedNonce(this.randomNonce());
      try {
        socket.send(encodeLocalKeyHintRequest(state.nonce));
      } catch (error) {
        this.failSocket(state, generation, asError(error));
        return;
      }
      state.keyHintTimer = setTimeout(() => {
        this.failSocket(state, generation, new Error("WebSocket key hint timeout"));
      }, this.keyHintTimeoutMs);
    });
    socket.addEventListener("message", (event) => {
      if (!this.isCurrent(state, socket, generation)) return;
      state.receiveChain = state.receiveChain
        .then(() => this.receive(state, socket, generation, (event as MessageEvent).data))
        .catch((error) => this.failSocket(state, generation, asError(error)));
    });
    socket.addEventListener("error", () => {
      if (!this.isCurrent(state, socket, generation)) return;
      this.failSocket(state, generation, new Error("WebSocket connection error"));
    });
    socket.addEventListener("close", (event) => {
      if (!this.isCurrent(state, socket, generation)) return;
      const close = event as CloseEvent;
      const reason = close.reason
        ? `WebSocket closed: ${close.reason}`
        : `WebSocket closed (${close.code})`;
      this.connectionEnded(state, generation, new Error(reason));
    });
  }

  private async receive(
    state: SeedState,
    socket: WebSocket,
    generation: number,
    data: unknown,
  ): Promise<void> {
    if (!this.isCurrent(state, socket, generation)) return;
    const wire = await binaryMessage(data);
    const hint = decodeLocalKeyHint(wire);
    if (hint?.kind === "request") {
      if (!this.ctx) throw new Error("WebSocket transport is not started");
      socket.send(encodeLocalKeyHintResponse(hint.nonce, this.ctx.localIdentity.xOnlyPubkey));
      return;
    }
    if (hint?.kind === "response") {
      if (hint.nonce !== state.nonce || state.remoteXOnly) return;
      if (toHex(hint.pubkey) === toHex(this.ctx!.localIdentity.xOnlyPubkey)) {
        throw new Error("WebSocket seed returned the local FIPS identity");
      }
      if (state.keyHintTimer) clearTimeout(state.keyHintTimer);
      state.keyHintTimer = undefined;
      state.remoteXOnly = new Uint8Array(hint.pubkey);
      state.reconnectDelayMs = this.reconnectInitialMs;
      this.resolveReadyWaiters(state);
      this.ctx?.onConnectionState?.({ remoteAddr: this.addr(state), state: "connected" });
      this.discoveries?.push({
        remoteAddr: this.addr(state),
        publicKey: new Uint8Array(hint.pubkey),
        meta: { source: "websocket-seed" },
      });
      this.pump(state);
      return;
    }
    if (!state.remoteXOnly) throw new Error("FIPS record arrived before WebSocket key hint");
    try {
      validateFipsRecord(wire, this.maxFrameBytes);
    } catch (error) {
      this.counters.invalidFrames++;
      throw error;
    }
    this.counters.framesReceived++;
    this.counters.bytesReceived += wire.length;
    this.ctx?.onPacket({
      transportType: this.type,
      remoteAddr: this.addr(state),
      data: new Uint8Array(wire),
      receivedAtMs: Date.now(),
    });
  }

  private pump(state: SeedState): void {
    if (state.sendTimer || !this.isReady(state)) return;
    const socket = state.socket!;
    while (state.queue.length > 0) {
      const next = state.queue[0]!;
      if (socket.bufferedAmount + next.data.length > this.maxBufferedBytes) {
        state.sendTimer = setTimeout(() => {
          state.sendTimer = undefined;
          this.pump(state);
        }, this.sendPollMs);
        return;
      }
      state.queue.shift();
      try {
        socket.send(next.data);
        this.counters.framesSent++;
        this.counters.bytesSent += next.data.length;
        next.resolve();
      } catch (error) {
        next.reject(asError(error));
        this.failSocket(state, state.generation, asError(error));
        return;
      }
    }
  }

  private failSocket(state: SeedState, generation: number, error: Error): void {
    if (generation !== state.generation) return;
    try {
      state.socket?.close(1002, error.message.slice(0, 120));
    } catch {
      // connectionEnded below owns cleanup.
    }
    this.connectionEnded(state, generation, error);
  }

  private connectionEnded(state: SeedState, generation: number, error: Error): void {
    if (generation !== state.generation) return;
    const wasOpen = state.socket !== undefined;
    this.clearConnectionTimers(state);
    state.socket = undefined;
    state.nonce = undefined;
    state.remoteXOnly = undefined;
    this.rejectReadyWaiters(state, error);
    this.rejectQueue(state, error);
    if (wasOpen) this.counters.connectionsClosed++;
    this.ctx?.onConnectionState?.({
      remoteAddr: this.addr(state),
      state: "disconnected",
      reason: error.message,
    });
    this.logger.warn("WebSocket seed disconnected", state.url, error);
    if (this.stopping || state.reconnectTimer) return;
    const delay = state.reconnectDelayMs;
    state.reconnectDelayMs = Math.min(delay * 2, this.reconnectMaxMs);
    this.counters.reconnectsScheduled++;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      this.dial(state);
    }, delay);
  }

  private isReady(state: SeedState): boolean {
    return state.socket?.readyState === this.WS.OPEN && state.remoteXOnly !== undefined;
  }

  private isCurrent(state: SeedState, socket: WebSocket, generation: number): boolean {
    return state.socket === socket && state.generation === generation;
  }

  private addr(state: SeedState): TransportAddress {
    return { transport: this.type, addr: state.url };
  }

  private resolveReadyWaiters(state: SeedState): void {
    for (const waiter of state.readyWaiters) waiter.resolve();
    state.readyWaiters.clear();
  }

  private rejectReadyWaiters(state: SeedState, error: Error): void {
    for (const waiter of state.readyWaiters) waiter.reject(error);
    state.readyWaiters.clear();
  }

  private rejectQueue(state: SeedState, error: Error): void {
    for (const pending of state.queue.splice(0)) pending.reject(error);
  }

  private clearConnectionTimers(state: SeedState): void {
    if (state.connectTimer) clearTimeout(state.connectTimer);
    if (state.keyHintTimer) clearTimeout(state.keyHintTimer);
    if (state.sendTimer) clearTimeout(state.sendTimer);
    state.connectTimer = undefined;
    state.keyHintTimer = undefined;
    state.sendTimer = undefined;
  }

  private clearTimers(state: SeedState): void {
    this.clearConnectionTimers(state);
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = undefined;
  }
}

export function encodeLocalKeyHintRequest(nonce: bigint): Uint8Array {
  const wire = new Uint8Array(LOCAL_KEY_HINT_REQUEST_BYTES);
  wire[0] = LOCAL_KEY_HINT_VERSION;
  new DataView(wire.buffer).setBigUint64(1, checkedNonce(nonce), false);
  return wire;
}

export function encodeLocalKeyHintResponse(nonce: bigint, pubkey: Uint8Array): Uint8Array {
  if (pubkey.length !== 32) throw new Error("key-hint pubkey must be 32 bytes");
  const wire = new Uint8Array(LOCAL_KEY_HINT_RESPONSE_BYTES);
  wire.set(encodeLocalKeyHintRequest(nonce));
  wire.set(pubkey, LOCAL_KEY_HINT_REQUEST_BYTES);
  return wire;
}

export function decodeLocalKeyHint(wire: Uint8Array): LocalKeyHint | undefined {
  if (wire[0] !== LOCAL_KEY_HINT_VERSION) return undefined;
  if (wire.length !== LOCAL_KEY_HINT_REQUEST_BYTES
    && wire.length !== LOCAL_KEY_HINT_RESPONSE_BYTES) return undefined;
  const nonce = new DataView(
    wire.buffer,
    wire.byteOffset + 1,
    8,
  ).getBigUint64(0, false);
  if (wire.length === LOCAL_KEY_HINT_REQUEST_BYTES) return { kind: "request", nonce };
  return {
    kind: "response",
    nonce,
    pubkey: new Uint8Array(wire.subarray(LOCAL_KEY_HINT_REQUEST_BYTES)),
  };
}

export function validateFipsWebSocketRecord(wire: Uint8Array, maxBytes = DEFAULT_MAX_FRAME_BYTES): void {
  validateFipsRecord(wire, maxBytes);
}

function validateFipsRecord(wire: Uint8Array, maxBytes: number): void {
  if (wire.length === 0 || wire.length > maxBytes) {
    throw new Error(`WebSocket FIPS record exceeds ${maxBytes} bytes`);
  }
  if (isDirectFspEstablished(wire)) {
    decodeFspEstablished(wire);
    return;
  }
  if (isDirectFspTransportFragment(wire)) {
    validateDirectFspFragment(wire);
    return;
  }
  const phase = peekFmpPhase(wire);
  if (phase === 0) decodeFmpEstablished(wire);
  else if (phase === 1) decodeFmpMsg1(wire);
  else if (phase === 2) decodeFmpMsg2(wire);
  else throw new Error(`unknown FIPS physical record phase ${phase}`);
}

function validateDirectFspFragment(wire: Uint8Array): void {
  if (wire.length <= 20) throw new Error("direct-FSP fragment has no payload");
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
  const totalLength = view.getUint32(12, true);
  const fragmentIndex = view.getUint16(16, true);
  const fragmentCount = view.getUint16(18, true);
  if (
    totalLength === 0
    || totalLength > 72 * 1024
    || fragmentCount <= 1
    || fragmentCount > 128
    || fragmentCount > totalLength
    || fragmentIndex >= fragmentCount
    || wire.length - 20 > totalLength
  ) {
    throw new Error("invalid direct-FSP fragment header");
  }
}

async function binaryMessage(data: unknown): Promise<Uint8Array> {
  if (typeof data === "string") throw new Error("WebSocket transport accepts binary messages only");
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new Error("unsupported WebSocket binary message");
}

function normalizeSeedUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid WebSocket seed URL ${JSON.stringify(raw)}`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error("WebSocket seed URL must not contain credentials or a fragment");
  }
  if (url.protocol === "wss:") return url.toString();
  if (url.protocol === "ws:" && isLoopbackHost(url.hostname)) return url.toString();
  if (url.protocol === "ws:") {
    throw new Error("plaintext WebSocket seed URL is allowed only for loopback");
  }
  throw new Error("WebSocket seed URL must use wss://");
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4
    && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(octets[0]) === 127;
}

function secureRandomNonce(): bigint {
  const bytes = new Uint8Array(8);
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) throw new Error("crypto.getRandomValues is unavailable");
  cryptoApi.getRandomValues(bytes);
  return new DataView(bytes.buffer).getBigUint64(0, false);
}

function checkedNonce(nonce: bigint): bigint {
  if (nonce < 0n || nonce > 0xffff_ffff_ffff_ffffn) {
    throw new Error("key-hint nonce must be an unsigned 64-bit integer");
  }
  return nonce;
}

function integerInRange(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  return integerInRange(value, 1, 60 * 60 * 1000, name);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class AsyncEventStream<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  constructor(private readonly maxValues: number) {}

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
    } else {
      if (this.values.length >= this.maxValues) {
        this.values.shift();
      }
      this.values.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.values.length = 0;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

async function* emptyAsyncIterable<T>(): AsyncIterable<T> {
  return;
}
