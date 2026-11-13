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
export declare class LookupBackoff {
    private readonly entries;
    isSuppressed(targetHex: string, nowMs: number): boolean;
    recordFailure(targetHex: string, nowMs: number, retryWhenReachable?: boolean): void;
    /**
     * Spend the one retry earned by a failure that had no peer to ask. A usable
     * peer is only a hint, so the failure count and deadline remain.
     */
    retryDelayedWithRoute(targetHex: string): boolean;
    recordSuccess(targetHex: string): void;
    resetAll(): void;
    failureCount(targetHex: string): number;
}
export declare class LookupForwardLimiter {
    private readonly lastForwarded;
    private readonly ingress;
    private lastCleanupMs;
    /** Admit and record one forward from this authenticated ingress for this target. */
    admit(ingressHex: string, targetHex: string, nowMs: number): boolean;
    /** When a rate-limited request may take the target's next slot, if its ingress has budget. */
    nextSlotMs(ingressHex: string, targetHex: string, nowMs: number): number | undefined;
    private bucket;
    private cleanup;
}
/** At most one waiting forward per target, bounded in total and per ingress. */
export declare class LookupForwardDeferrals {
    private readonly waiting;
    defer(targetHex: string, ingressHex: string, delayMs: number, run: () => void): boolean;
    clear(): void;
}
//# sourceMappingURL=LookupLimits.d.ts.map