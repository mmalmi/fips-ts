/**
 * Discovery lookup rate limits.
 *
 * Mirrors Rust `fips-core/src/proto/lookup_limits.rs`:
 * - `LookupBackoff` (origin): after a lookup for a target times out, fresh
 *   lookups for it are suppressed for 30 s, doubling per consecutive failure
 *   up to 300 s. Cleared by a successful lookup or session and on topology
 *   changes (new authenticated peer, changed tree coordinates).
 * - `LookupForwardLimiter` (transit): forwards at most one lookup per target
 *   every 2 s, plus a per-ingress token bucket, so fresh request IDs for an
 *   offline target cannot flood every forwarding node. `LookupForwardDeferrals`
 *   holds one limited request per target for the next slot.
 */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 300_000;
const MAX_BACKOFF_ENTRIES = 4_096;
export class LookupBackoff {
    entries = new Map();
    isSuppressed(targetHex, nowMs) {
        const entry = this.entries.get(targetHex);
        return entry !== undefined && nowMs < entry.suppressUntilMs;
    }
    recordFailure(targetHex, nowMs, retryWhenReachable = false) {
        const failures = (this.entries.get(targetHex)?.failures ?? 0) + 1;
        const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 16), BACKOFF_MAX_MS);
        this.entries.delete(targetHex);
        if (this.entries.size >= MAX_BACKOFF_ENTRIES) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined)
                this.entries.delete(oldest);
        }
        this.entries.set(targetHex, { suppressUntilMs: nowMs + backoffMs, failures, retryWhenReachable });
    }
    /**
     * Spend the one retry earned by a failure that had no peer to ask. A usable
     * peer is only a hint, so the failure count and deadline remain.
     */
    retryDelayedWithRoute(targetHex) {
        const entry = this.entries.get(targetHex);
        if (!entry?.retryWhenReachable)
            return false;
        entry.retryWhenReachable = false;
        return true;
    }
    recordSuccess(targetHex) {
        this.entries.delete(targetHex);
    }
    resetAll() {
        this.entries.clear();
    }
    failureCount(targetHex) {
        return this.entries.get(targetHex)?.failures ?? 0;
    }
}
const FORWARD_MIN_INTERVAL_MS = 2_000;
const FORWARD_MAX_AGE_MS = 60_000;
const FORWARD_CLEANUP_INTERVAL_MS = 5_000;
const FORWARD_MAX_TARGETS = 4_096;
const FORWARD_MAX_INGRESS_PEERS = 4_096;
// A transit peer may aggregate lookups for a whole subtree: keep a generous
// burst while bounding sustained target churn from that peer.
const FORWARD_INGRESS_BURST = 256;
const FORWARD_INGRESS_RATE_PER_MS = 32 / 1_000;
const FORWARD_INGRESS_MAX_AGE_MS = 300_000;
export class LookupForwardLimiter {
    lastForwarded = new Map();
    ingress = new Map();
    lastCleanupMs = 0;
    /** Admit and record one forward from this authenticated ingress for this target. */
    admit(ingressHex, targetHex, nowMs) {
        this.cleanup(nowMs);
        const last = this.lastForwarded.get(targetHex);
        if (last !== undefined && nowMs - last < FORWARD_MIN_INTERVAL_MS)
            return false;
        if (last === undefined && this.lastForwarded.size >= FORWARD_MAX_TARGETS)
            return false;
        const bucket = this.bucket(ingressHex, nowMs);
        if (!bucket || bucket.tokens < 1)
            return false;
        bucket.tokens -= 1;
        this.lastForwarded.set(targetHex, nowMs);
        return true;
    }
    /** When a rate-limited request may take the target's next slot, if its ingress has budget. */
    nextSlotMs(ingressHex, targetHex, nowMs) {
        const last = this.lastForwarded.get(targetHex);
        if (last === undefined)
            return undefined;
        const due = last + FORWARD_MIN_INTERVAL_MS;
        if (nowMs >= due)
            return undefined;
        const bucket = this.bucket(ingressHex, nowMs);
        return bucket && bucket.tokens >= 1 ? due : undefined;
    }
    bucket(ingressHex, nowMs) {
        let bucket = this.ingress.get(ingressHex);
        if (!bucket) {
            if (this.ingress.size >= FORWARD_MAX_INGRESS_PEERS)
                return undefined;
            bucket = { tokens: FORWARD_INGRESS_BURST, updatedMs: nowMs };
            this.ingress.set(ingressHex, bucket);
            return bucket;
        }
        const elapsed = Math.max(0, nowMs - bucket.updatedMs);
        bucket.tokens = Math.min(FORWARD_INGRESS_BURST, bucket.tokens + elapsed * FORWARD_INGRESS_RATE_PER_MS);
        bucket.updatedMs = nowMs;
        return bucket;
    }
    cleanup(nowMs) {
        if (nowMs - this.lastCleanupMs < FORWARD_CLEANUP_INTERVAL_MS)
            return;
        this.lastCleanupMs = nowMs;
        for (const [target, last] of this.lastForwarded) {
            if (nowMs - last >= FORWARD_MAX_AGE_MS)
                this.lastForwarded.delete(target);
        }
        for (const [ingress, bucket] of this.ingress) {
            if (nowMs - bucket.updatedMs >= FORWARD_INGRESS_MAX_AGE_MS)
                this.ingress.delete(ingress);
        }
    }
}
// Rust bounds requests waiting for a target's next forwarding slot.
const MAX_DEFERRED_FORWARDS = 256;
const MAX_DEFERRED_FORWARDS_PER_INGRESS = 64;
/** At most one waiting forward per target, bounded in total and per ingress. */
export class LookupForwardDeferrals {
    waiting = new Map();
    defer(targetHex, ingressHex, delayMs, run) {
        if (this.waiting.has(targetHex) || this.waiting.size >= MAX_DEFERRED_FORWARDS)
            return false;
        let fromIngress = 0;
        for (const entry of this.waiting.values()) {
            if (entry.ingressHex === ingressHex)
                fromIngress += 1;
        }
        if (fromIngress >= MAX_DEFERRED_FORWARDS_PER_INGRESS)
            return false;
        const timer = setTimeout(() => {
            if (this.waiting.get(targetHex)?.timer !== timer)
                return;
            this.waiting.delete(targetHex);
            run();
        }, delayMs);
        this.waiting.set(targetHex, { timer, ingressHex });
        return true;
    }
    clear() {
        for (const entry of this.waiting.values())
            clearTimeout(entry.timer);
        this.waiting.clear();
    }
}
//# sourceMappingURL=LookupLimits.js.map