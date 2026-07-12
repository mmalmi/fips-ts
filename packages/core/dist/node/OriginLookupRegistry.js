export class OriginLookupRegistry {
    maximum;
    byTarget = new Map();
    byRequest = new Map();
    constructor(maximum) {
        this.maximum = maximum;
    }
    get(targetHex) {
        return this.byTarget.get(targetHex);
    }
    findRequest(requestId) {
        return this.byRequest.get(requestId);
    }
    create(args) {
        if (this.byTarget.size >= this.maximum) {
            throw new Error(`lookup capacity exceeded for ${args.targetHex}`);
        }
        const requestId = this.nextRequestId(args.randomBytes);
        let resolve;
        let reject;
        const promise = new Promise((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        const pending = {
            requestId,
            targetHex: args.targetHex,
            targetPubkey: new Uint8Array(args.targetPubkey),
            promise,
            resolve,
            reject,
        };
        pending.timer = setTimeout(() => {
            this.fail(pending, new Error(`no route to ${args.targetHex}`));
        }, args.timeoutMs);
        this.byTarget.set(args.targetHex, pending);
        this.byRequest.set(requestId, pending);
        return pending;
    }
    complete(pending) {
        const state = this.remove(pending);
        state?.resolve();
    }
    fail(pending, error) {
        const state = this.remove(pending);
        state?.reject(error);
    }
    stop() {
        for (const pending of [...this.byTarget.values()]) {
            this.fail(pending, new Error("FIPS node stopped"));
        }
    }
    nextRequestId(randomBytes) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const bytes = randomBytes();
            if (bytes.length !== 8)
                throw new Error("random source returned invalid lookup request id");
            const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
            if (!this.byRequest.has(id))
                return id;
        }
        throw new Error("failed to allocate unique lookup request id");
    }
    remove(pending) {
        const state = this.byTarget.get(pending.targetHex);
        if (state !== pending)
            return undefined;
        if (state.timer)
            clearTimeout(state.timer);
        this.byTarget.delete(state.targetHex);
        this.byRequest.delete(state.requestId);
        return state;
    }
}
//# sourceMappingURL=OriginLookupRegistry.js.map