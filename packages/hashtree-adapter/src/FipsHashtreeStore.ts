import { sha256 } from "@noble/hashes/sha256";

import { bytesEqual, FipsNode, toHex } from "@fips/core";

import {
  encodeDataRequest,
  encodeDataResponse,
  HASHTREE_FIPS_PORT,
  parseMessage,
  MSG_TYPE_REQUEST,
  MSG_TYPE_RESPONSE,
  type DataRequest,
  type DataResponse,
} from "./protocol.js";

/**
 * Minimal hashtree-shaped store API. Compatible with `@hashtree/core` Store
 * (get/put/has/delete return Promise; the local store passed in by the caller
 * should implement that interface — we treat it structurally).
 */
export interface LocalLikeStore {
  get(hash: Uint8Array): Promise<Uint8Array | null>;
  put(hash: Uint8Array, data: Uint8Array): Promise<boolean | void>;
  has?(hash: Uint8Array): Promise<boolean>;
  delete?(hash: Uint8Array): Promise<boolean | void>;
}

export interface FipsHashtreeStoreOptions {
  node: FipsNode;
  localStore: LocalLikeStore;
  peers: string[]; // remote pubkey hex (33-byte compressed)
  port?: number;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  hashHex: string;
  resolve: (data: Uint8Array | null) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * FipsHashtreeStore reads from a local Store first; if missing, it asks
 * configured FIPS peers over service-port 7001 using @hashtree/mesh-shaped
 * MessagePack frames. Writes are local-only (peers receive blobs via
 * responses to their own requests).
 */
export class FipsHashtreeStore implements LocalLikeStore {
  private readonly node: FipsNode;
  private readonly localStore: LocalLikeStore;
  private readonly peers: string[];
  private readonly port: number;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest[]>();
  private unregister?: () => void;

  constructor(opts: FipsHashtreeStoreOptions) {
    this.node = opts.node;
    this.localStore = opts.localStore;
    this.peers = opts.peers;
    this.port = opts.port ?? HASHTREE_FIPS_PORT;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.unregister = this.node.registerService(this.port, async (ctx) => {
      await this.onServiceDatagram(ctx);
    });
  }

  stop(): void {
    this.unregister?.();
    this.unregister = undefined;
    for (const arr of this.pending.values()) {
      for (const r of arr) {
        clearTimeout(r.timer);
        r.reject(new Error("store stopped"));
      }
    }
    this.pending.clear();
  }

  async get(hash: Uint8Array): Promise<Uint8Array | null> {
    const local = await this.localStore.get(hash);
    if (local) return local;
    if (this.peers.length === 0) return null;
    return this.requestFromPeers(hash);
  }

  async put(hash: Uint8Array, data: Uint8Array): Promise<boolean | void> {
    if (!bytesEqual(sha256(data), hash)) {
      throw new Error("hashtree put: hash does not match data");
    }
    return this.localStore.put(hash, data);
  }

  has(hash: Uint8Array): Promise<boolean> {
    if (this.localStore.has) return this.localStore.has(hash);
    return this.localStore.get(hash).then((b) => b !== null);
  }

  delete(hash: Uint8Array): Promise<boolean | void> {
    return this.localStore.delete ? this.localStore.delete(hash) : Promise.resolve(false);
  }

  private async onServiceDatagram(ctx: {
    src: string;
    srcPort: number;
    dstPort: number;
    payload: Uint8Array;
    reply: (data: Uint8Array, replyDstPort?: number) => Promise<void>;
  }): Promise<void> {
    const msg = parseMessage(ctx.payload);
    if (msg.type === MSG_TYPE_REQUEST) {
      await this.handleRequest(msg.body, ctx);
    } else if (msg.type === MSG_TYPE_RESPONSE) {
      this.handleResponse(msg.body);
    }
  }

  private async handleRequest(
    req: DataRequest,
    ctx: { reply: (data: Uint8Array, replyDstPort?: number) => Promise<void>; srcPort: number },
  ): Promise<void> {
    const local = await this.localStore.get(req.h);
    if (!local) return;
    if (!bytesEqual(sha256(local), req.h)) {
      throw new Error("local data corrupted");
    }
    const resp: DataResponse = { h: req.h, d: local };
    await ctx.reply(encodeDataResponse(resp), this.port);
    void ctx.srcPort;
  }

  private handleResponse(resp: DataResponse): void {
    if (!bytesEqual(sha256(resp.d), resp.h)) return; // poisoned
    const hashHex = toHex(resp.h);
    const pending = this.pending.get(hashHex);
    if (!pending) return;
    for (const p of pending) {
      clearTimeout(p.timer);
      p.resolve(resp.d);
    }
    this.pending.delete(hashHex);
    // Cache locally for future reads.
    void this.localStore.put(resp.h, resp.d);
  }

  private async requestFromPeers(hash: Uint8Array): Promise<Uint8Array | null> {
    const hashHex = toHex(hash);
    const result = new Promise<Uint8Array | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = this.pending.get(hashHex);
        if (arr) {
          this.pending.set(
            hashHex,
            arr.filter((r) => r.resolve !== resolve),
          );
        }
        resolve(null);
      }, this.requestTimeoutMs);
      const arr = this.pending.get(hashHex) ?? [];
      arr.push({ hashHex, resolve, reject, timer });
      this.pending.set(hashHex, arr);
    });
    const req = encodeDataRequest({ h: hash });
    await Promise.allSettled(
      this.peers.map((peerHex) =>
        this.node.sendDatagram({
          dst: peerHex,
          srcPort: this.port,
          dstPort: this.port,
          payload: req,
        }),
      ),
    );
    return result;
  }
}
