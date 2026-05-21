/**
 * Minimal Nostr relay WebSocket client — only what the FIPS WebRTC signaling
 * path needs:
 *   - publish an EVENT
 *   - REQ a single filter with a callback for matched events
 *   - close subscriptions / disconnect
 *
 * Avoids any framework. Works in browser and Node (where the consumer
 * supplies a WebSocket-like constructor).
 */

export type WebSocketCtor = typeof WebSocket;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrFilter {
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  "#p"?: string[];
  "#d"?: string[];
  [key: string]: unknown;
}

export interface NostrRelayClientOptions {
  url: string;
  webSocket?: WebSocketCtor;
  connectTimeoutMs?: number;
  onClose?: () => void;
  logger?: { debug: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}

type SubCallbacks = {
  onEvent: (ev: NostrEvent) => void;
  onEose?: () => void;
};

export class NostrRelayClient {
  readonly url: string;
  private ws?: WebSocket;
  private readyPromise?: Promise<void>;
  private readonly subs = new Map<string, SubCallbacks>();
  private readonly WS: WebSocketCtor;
  private readonly connectTimeoutMs: number;
  private closed = false;
  private subCounter = 0;
  private readonly logger: NostrRelayClientOptions["logger"];

  constructor(opts: NostrRelayClientOptions) {
    this.url = opts.url;
    this.WS = opts.webSocket ?? (globalThis as { WebSocket: WebSocketCtor }).WebSocket;
    if (!this.WS) throw new Error("no WebSocket constructor available");
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 8_000;
    this.logger = opts.logger;
  }

  isConnected(): boolean {
    return this.ws?.readyState === this.WS.OPEN;
  }

  connect(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const fail = (message: string): void => {
        finish(() => {
          try {
            this.ws?.close();
          } catch {
            /* ignore */
          }
          reject(new Error(message));
        });
      };
      const timer = setTimeout(() => {
        this.logger?.warn("relay connect timeout", this.url);
        fail("relay connect timeout");
      }, this.connectTimeoutMs);
      try {
        const ws = new this.WS(this.url);
        this.ws = ws;
        ws.binaryType = "arraybuffer";
        ws.addEventListener("open", () => {
          this.logger?.debug("relay open", this.url);
          finish(resolve);
        });
        ws.addEventListener("error", (e) => {
          this.logger?.warn("relay error", this.url, e);
          if (!this.closed) fail("relay connect error");
        });
        ws.addEventListener("close", () => {
          const wasConnecting = !settled;
          this.closed = true;
          this.logger?.debug("relay closed", this.url);
          if (wasConnecting) fail("relay closed before open");
        });
        ws.addEventListener("message", (m) => this.onMessage(m));
      } catch (err) {
        this.logger?.warn("relay constructor failed", this.url, err);
        fail("relay connect error");
      }
    });
    return this.readyPromise;
  }

  async publish(event: NostrEvent): Promise<void> {
    await this.connect();
    this.ws!.send(JSON.stringify(["EVENT", event]));
  }

  async subscribe(
    filter: NostrFilter,
    cb: SubCallbacks,
  ): Promise<() => void> {
    await this.connect();
    const subId = `s${++this.subCounter}`;
    this.subs.set(subId, cb);
    this.ws!.send(JSON.stringify(["REQ", subId, filter]));
    return () => {
      this.subs.delete(subId);
      try {
        this.ws?.send(JSON.stringify(["CLOSE", subId]));
      } catch {
        /* ignore */
      }
    };
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  private onMessage(m: MessageEvent): void {
    let arr: unknown;
    try {
      arr = JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data as ArrayBuffer));
    } catch {
      return;
    }
    if (!Array.isArray(arr) || arr.length < 2) return;
    const tag = arr[0];
    if (tag === "EVENT" && typeof arr[1] === "string") {
      const sub = this.subs.get(arr[1] as string);
      if (sub) sub.onEvent(arr[2] as NostrEvent);
    } else if (tag === "EOSE" && typeof arr[1] === "string") {
      const sub = this.subs.get(arr[1] as string);
      sub?.onEose?.();
    } else if (tag === "OK") {
      /* fine */
    } else if (tag === "NOTICE") {
      this.logger?.warn("relay notice", arr[1]);
    }
  }
}
