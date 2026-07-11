export function waitForIceGatheringComplete(pc, timeoutMs) {
    if (pc.iceGatheringState === "complete")
        return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pc.removeEventListener("icegatheringstatechange", onChange);
            resolve();
        }, timeoutMs);
        function onChange() {
            if (pc.iceGatheringState === "complete") {
                clearTimeout(timer);
                pc.removeEventListener("icegatheringstatechange", onChange);
                resolve();
            }
        }
        pc.addEventListener("icegatheringstatechange", onChange);
    });
}
export class AsyncEventStream {
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
export async function* emptyAsyncIterable() {
    return;
}
export function normalizeSignalRelays(value) {
    if (!Array.isArray(value))
        return [];
    const relays = [];
    for (const candidate of value.slice(0, 8)) {
        if (typeof candidate !== "string")
            continue;
        try {
            const parsed = new URL(candidate);
            if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
                continue;
            const normalized = parsed.toString();
            if (!relays.includes(normalized))
                relays.push(normalized);
        }
        catch {
            /* Invalid advertised relay URL. */
        }
    }
    return relays;
}
export function cloneDiscoveredPeer(peer) {
    return {
        remoteAddr: { ...peer.remoteAddr },
        publicKey: peer.publicKey ? new Uint8Array(peer.publicKey) : undefined,
        meta: peer.meta
            ? Object.fromEntries(Object.entries(peer.meta).map(([key, value]) => [
                key,
                Array.isArray(value) ? [...value] : value,
            ]))
            : undefined,
    };
}
export function advertExpiryMs(event, ttlMs, nowMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0)
        return undefined;
    const createdAtMs = event.created_at * 1_000;
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0)
        return undefined;
    const localExpiryMs = Math.min(createdAtMs + ttlMs, nowMs + ttlMs);
    const expiration = event.tags.find((tag) => tag[0] === "expiration")?.[1];
    if (expiration === undefined)
        return localExpiryMs;
    if (!/^\d+$/.test(expiration))
        return undefined;
    const advertisedExpiryMs = Number(expiration) * 1_000;
    if (!Number.isSafeInteger(advertisedExpiryMs))
        return undefined;
    return Math.min(localExpiryMs, advertisedExpiryMs);
}
//# sourceMappingURL=WebRtcTransportSupport.js.map