/**
 * Minimal Nostr relay WebSocket client for FIPS peerfinding and datagrams:
 *   - publish an EVENT
 *   - REQ a single filter with a callback for matched events
 *   - close subscriptions / disconnect
 *
 * Avoids any framework. Works in browser and Node (where the consumer
 * supplies a WebSocket-like constructor).
 */
export class NostrRelayClient {
    url;
    ws;
    readyPromise;
    subs = new Map();
    pendingPublishes = new Map();
    WS;
    connectTimeoutMs;
    publishAckTimeoutMs;
    closed = false;
    subCounter = 0;
    logger;
    constructor(opts) {
        this.url = opts.url;
        this.WS = opts.webSocket ?? globalThis.WebSocket;
        if (!this.WS)
            throw new Error("no WebSocket constructor available");
        this.connectTimeoutMs = opts.connectTimeoutMs ?? 8_000;
        this.publishAckTimeoutMs = opts.publishAckTimeoutMs ?? 2_500;
        this.logger = opts.logger;
    }
    isConnected() {
        return this.ws?.readyState === this.WS.OPEN;
    }
    connect() {
        if (this.ws?.readyState === this.WS.OPEN) {
            return Promise.resolve();
        }
        if (this.readyPromise)
            return this.readyPromise;
        this.closed = false;
        this.readyPromise = new Promise((resolve, reject) => {
            let settled = false;
            let ws = null;
            const finish = (fn) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                fn();
            };
            const fail = (message) => {
                finish(() => {
                    try {
                        ws?.close();
                    }
                    catch {
                        /* ignore */
                    }
                    if (this.ws === ws) {
                        this.ws = undefined;
                    }
                    this.readyPromise = undefined;
                    reject(new Error(message));
                });
            };
            const timer = setTimeout(() => {
                this.logger?.warn("relay connect timeout", this.url);
                fail("relay connect timeout");
            }, this.connectTimeoutMs);
            try {
                ws = new this.WS(this.url);
                this.ws = ws;
                ws.binaryType = "arraybuffer";
                ws.addEventListener("open", () => {
                    this.logger?.debug("relay open", this.url);
                    try {
                        for (const sub of this.subs.values()) {
                            ws.send(sub.request);
                        }
                    }
                    catch (err) {
                        this.logger?.warn("relay subscription replay failed", this.url, err);
                        fail("relay subscription replay failed");
                        return;
                    }
                    finish(resolve);
                });
                ws.addEventListener("error", (e) => {
                    this.logger?.warn("relay error", this.url, e);
                    if (!this.closed)
                        fail("relay connect error");
                });
                ws.addEventListener("close", () => {
                    const wasConnecting = !settled;
                    if (this.ws === ws) {
                        this.ws = undefined;
                    }
                    this.readyPromise = undefined;
                    this.logger?.debug("relay closed", this.url);
                    this.rejectPendingPublishes(new Error("relay closed before publish OK"));
                    if (wasConnecting)
                        fail("relay closed before open");
                });
                ws.addEventListener("message", (m) => {
                    if (this.ws === ws)
                        this.onMessage(m);
                });
            }
            catch (err) {
                this.logger?.warn("relay constructor failed", this.url, err);
                fail("relay connect error");
            }
        });
        return this.readyPromise;
    }
    async publish(event) {
        await this.connect();
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingPublishes.delete(event.id);
                reject(new Error("relay publish OK timeout"));
            }, this.publishAckTimeoutMs);
            this.pendingPublishes.set(event.id, { resolve, reject, timer });
            try {
                this.ws.send(JSON.stringify(["EVENT", event]));
            }
            catch (error) {
                this.clearPendingPublish(event.id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    async subscribe(filter, cb) {
        const subId = `s${++this.subCounter}`;
        const request = JSON.stringify(["REQ", subId, filter]);
        const wasConnected = this.isConnected();
        this.subs.set(subId, { ...cb, request });
        await this.connect();
        if (wasConnected)
            this.ws.send(request);
        return () => {
            if (!this.subs.delete(subId))
                return;
            try {
                this.ws?.send(JSON.stringify(["CLOSE", subId]));
            }
            catch {
                /* ignore */
            }
        };
    }
    close() {
        this.closed = true;
        this.subs.clear();
        this.rejectPendingPublishes(new Error("relay closed"));
        try {
            this.ws?.close();
        }
        catch {
            /* ignore */
        }
    }
    onMessage(m) {
        let arr;
        try {
            arr = JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data));
        }
        catch {
            return;
        }
        if (!Array.isArray(arr) || arr.length < 2)
            return;
        const tag = arr[0];
        if (tag === "EVENT" && typeof arr[1] === "string") {
            const sub = this.subs.get(arr[1]);
            if (sub)
                sub.onEvent(arr[2]);
        }
        else if (tag === "EOSE" && typeof arr[1] === "string") {
            const sub = this.subs.get(arr[1]);
            sub?.onEose?.();
        }
        else if (tag === "CLOSED" && typeof arr[1] === "string") {
            this.subs.delete(arr[1]);
        }
        else if (tag === "OK") {
            this.onPublishOk(arr);
        }
        else if (tag === "NOTICE") {
            this.logger?.warn("relay notice", arr[1]);
        }
    }
    onPublishOk(arr) {
        const eventId = arr[1];
        if (typeof eventId !== "string")
            return;
        const pending = this.pendingPublishes.get(eventId);
        if (!pending)
            return;
        this.pendingPublishes.delete(eventId);
        clearTimeout(pending.timer);
        const accepted = arr[2] === true;
        if (accepted) {
            pending.resolve();
            return;
        }
        const message = typeof arr[3] === "string" && arr[3].trim()
            ? arr[3]
            : "relay rejected event";
        pending.reject(new Error(message));
    }
    clearPendingPublish(eventId) {
        const pending = this.pendingPublishes.get(eventId);
        if (!pending)
            return;
        this.pendingPublishes.delete(eventId);
        clearTimeout(pending.timer);
    }
    rejectPendingPublishes(error) {
        for (const [eventId, pending] of this.pendingPublishes) {
            this.pendingPublishes.delete(eventId);
            clearTimeout(pending.timer);
            pending.reject(error);
        }
    }
}
//# sourceMappingURL=NostrRelayClient.js.map