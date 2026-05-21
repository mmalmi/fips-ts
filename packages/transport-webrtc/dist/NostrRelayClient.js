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
export class NostrRelayClient {
    url;
    ws;
    readyPromise;
    subs = new Map();
    WS;
    closed = false;
    subCounter = 0;
    logger;
    constructor(opts) {
        this.url = opts.url;
        this.WS = opts.webSocket ?? globalThis.WebSocket;
        if (!this.WS)
            throw new Error("no WebSocket constructor available");
        this.logger = opts.logger;
    }
    connect() {
        if (this.readyPromise)
            return this.readyPromise;
        this.readyPromise = new Promise((resolve, reject) => {
            const ws = new this.WS(this.url);
            this.ws = ws;
            ws.binaryType = "arraybuffer";
            ws.addEventListener("open", () => {
                this.logger?.debug("relay open", this.url);
                resolve();
            });
            ws.addEventListener("error", (e) => {
                this.logger?.warn("relay error", this.url, e);
                if (!this.closed)
                    reject(new Error("relay connect error"));
            });
            ws.addEventListener("close", () => {
                this.closed = true;
                this.logger?.debug("relay closed", this.url);
            });
            ws.addEventListener("message", (m) => this.onMessage(m));
        });
        return this.readyPromise;
    }
    async publish(event) {
        await this.connect();
        this.ws.send(JSON.stringify(["EVENT", event]));
    }
    async subscribe(filter, cb) {
        await this.connect();
        const subId = `s${++this.subCounter}`;
        this.subs.set(subId, cb);
        this.ws.send(JSON.stringify(["REQ", subId, filter]));
        return () => {
            this.subs.delete(subId);
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
        else if (tag === "OK") {
            /* fine */
        }
        else if (tag === "NOTICE") {
            this.logger?.warn("relay notice", arr[1]);
        }
    }
}
//# sourceMappingURL=NostrRelayClient.js.map